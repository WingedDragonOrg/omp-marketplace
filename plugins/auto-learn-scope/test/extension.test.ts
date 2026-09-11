import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type UnknownRecord = Record<string, unknown>;
type ToolHandler = (event: UnknownRecord, ctx: UnknownRecord) => unknown | Promise<unknown>;
type ToolDefinition = UnknownRecord & {
  name: string;
  parameters?: SchemaNode;
  execute?: (...args: readonly unknown[]) => Promise<unknown>;
};
type SchemaNode = UnknownRecord & {
  kind: string;
  inner?: SchemaNode;
  values?: readonly string[];
  shape?: UnknownRecord;
  optional?: () => SchemaNode;
  describe?: (text: string) => SchemaNode;
};
type NativeInvoker = (
  params: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown>;
type RepositoryFixture = {
  root: string;
  cwd: string;
};

type ExtensionModule = UnknownRecord & {
  default?: (pi: UnknownRecord) => void | Promise<void>;
  installAutoLearnScope?: (pi: UnknownRecord) => void | Promise<void>;
};

const modulePromise: Promise<ExtensionModule> = import("../src/index")
  .then(module => module as ExtensionModule)
  .catch(() => ({}));
const temporaryRoots: string[] = [];

function schemaNode(kind: string, fields: UnknownRecord = {}): SchemaNode {
  const node: SchemaNode = {
    kind,
    ...fields,
    optional: () => schemaNode("optional", { inner: node }),
    describe: () => node,
  };
  return node;
}

const zod = {
  object(shape: UnknownRecord): SchemaNode {
    return schemaNode("object", { shape });
  },
  enum(values: readonly string[]): SchemaNode {
    return schemaNode("enum", { values });
  },
  string(): SchemaNode {
    return schemaNode("string");
  },
  optional(inner: SchemaNode): SchemaNode {
    return schemaNode("optional", { inner });
  },
};

class FakePi {
  readonly zod = zod;
  readonly tools: ToolDefinition[] = [];
  readonly handlers = new Map<string, ToolHandler[]>();

  registerTool(definition: ToolDefinition): void {
    this.tools.push(definition);
  }

  on(event: string, handler: ToolHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function makeRepository(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "auto-learn-scope-extension-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
  const cwd = join(root, "workspace", "app");
  await mkdir(cwd, { recursive: true });
  return { root, cwd };
}

async function extensionModule(): Promise<ExtensionModule> {
  return modulePromise;
}

async function install(pi: FakePi): Promise<void> {
  const module = await extensionModule();
  if (typeof module.installAutoLearnScope !== "function") {
    throw new Error("src/index.ts must export installAutoLearnScope()");
  }
  await module.installAutoLearnScope(pi);
}

async function installDefault(pi: FakePi): Promise<void> {
  const module = await extensionModule();
  if (typeof module.default !== "function") {
    throw new Error("src/index.ts must export a default extension factory");
  }
  await module.default(pi);
}

function findTool(pi: FakePi, name: string): ToolDefinition {
  const matches = pi.tools.filter(tool => tool.name === name);
  expect(matches, `extension must register exactly one ${name} wrapper`).toHaveLength(1);
  const tool = matches[0];
  if (!tool) throw new Error(`missing ${name} tool`);
  return tool;
}

function executeTool(tool: ToolDefinition, params: Record<string, unknown>, ctx: UnknownRecord): Promise<unknown> {
  if (typeof tool.execute !== "function") {
    throw new Error(`${tool.name} wrapper must expose execute()`);
  }
  return tool.execute("test-call", params, undefined, undefined, ctx);
}

function makeContext(cwd: string, invokeTool?: NativeInvoker): UnknownRecord {
  const context: UnknownRecord = {
    cwd,
    mode: "print",
    hasUI: false,
    ui: {},
    getContextUsage: () => undefined,
    getAsyncJobSnapshot: () => null,
    compact: async () => undefined,
    sessionManager: {},
    modelRegistry: {},
    models: {
      list: () => [],
      current: () => undefined,
      resolve: () => undefined,
      family: () => "",
    },
    isIdle: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getSystemPrompt: () => [],
    isProjectTrusted: () => true,
  };
  if (invokeTool) context.invokeTool = invokeTool;
  return context;
}

function projectSkillFile(root: string, name: string): string {
  return join(root, ".omp", "skills", name, "SKILL.md");
}

function standardSkillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

const nativeResult = {
  content: [{ type: "text", text: "native memory stored" }],
  details: { source: "native" },
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("auto-learn-scope extension registration", () => {
  test("default factory registers the two same-name auto-learn tools and before_agent_start handler", async () => {
    const pi = new FakePi();
    await installDefault(pi);

    expect(pi.tools.map(tool => tool.name).sort()).toEqual(["learn", "manage_skill"]);
    expect(pi.handlers.get("before_agent_start")).toHaveLength(1);
  });

  test("wrappers retain essential strict write metadata and expose an optional global-or-project scope", async () => {
    const pi = new FakePi();
    await install(pi);

    for (const name of ["learn", "manage_skill"]) {
      const tool = findTool(pi, name);
      expect(tool.defaultInactive, `${name} must be default-inactive`).toBe(true);
      expect(tool.approval, `${name} must require write approval`).toBe("write");
      expect(tool.loadMode, `${name} must remain essential`).toBe("essential");
      expect(tool.strict, `${name} must retain strict structured output`).toBe(true);
      const scope = tool.parameters?.shape?.scope;
      expect(scope, `${name} schema must include optional scope`).toMatchObject({ kind: "optional" });
      expect(scope?.inner).toMatchObject({ kind: "enum", values: ["global", "project"] });
    }
  });

  test("extension registration and factory load through only the public host boundary", async () => {
    const pi = new FakePi();
    await install(pi);

    expect(pi.tools.every(tool => tool.name === "learn" || tool.name === "manage_skill")).toBe(true);
    expect(pi.handlers.has("before_agent_start")).toBe(true);
  });
});

describe("same-name wrapper delegation", () => {
  test("learn with omitted scope delegates native learn once and removes the wrapper-only scope field", async () => {
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };
    const input = { memory: "Remember the repository convention.", context: "test context" };

    const result = await executeTool(findTool(pi, "learn"), input, makeContext(cwd, invokeTool));

    expect(calls).toEqual([input]);
    expect(result).toEqual(nativeResult);
  });

  test("learn with global scope delegates native learn once, preserves native result, and removes scope", async () => {
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };
    const input = { scope: "global", memory: "Remember the global convention.", context: "test context" };

    const result = await executeTool(findTool(pi, "learn"), input, makeContext(cwd, invokeTool));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ memory: input.memory, context: input.context });
    expect(result).toEqual(nativeResult);
    expect(input.scope).toBe("global");
  });

  test("manage_skill with omitted scope delegates native manage_skill once and removes the wrapper-only scope field", async () => {
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };
    const input = { action: "create", name: "global-skill", description: "Global procedure.", body: "Body." };

    const result = await executeTool(findTool(pi, "manage_skill"), input, makeContext(cwd, invokeTool));

    expect(calls).toEqual([input]);
    expect(result).toEqual(nativeResult);
  });

  test("manage_skill with global scope delegates native manage_skill once and strips scope", async () => {
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };
    const input = {
      scope: "global",
      action: "update",
      name: "global-skill",
      description: "Global procedure.",
      body: "Updated body.",
    };

    const result = await executeTool(findTool(pi, "manage_skill"), input, makeContext(cwd, invokeTool));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      action: input.action,
      name: input.name,
      description: input.description,
      body: input.body,
    });
    expect(result).toEqual(nativeResult);
  });

  test("an unsupported scope is rejected before either native tool is invoked", async () => {
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };

    await expect(
      executeTool(findTool(pi, "learn"), { scope: "workspace", memory: "Never call this." }, makeContext(cwd, invokeTool)),
    ).rejects.toThrow(/scope|global|project|invalid/i);
    expect(calls).toHaveLength(0);
  });
});

describe("project-scope wrapper behavior", () => {
  test("manage_skill project create writes a standard project skill and never writes the global managed path", async () => {
    const { root, cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };

    await executeTool(
      findTool(pi, "manage_skill"),
      {
        scope: "project",
        action: "create",
        name: " Project-Procedure ",
        description: "A project procedure.",
        body: "# Procedure\n\n1. Run it.",
      },
      makeContext(cwd, invokeTool),
    );

    expect(await readFile(projectSkillFile(root, "project-procedure"), "utf8")).toBe(
      standardSkillText("project-procedure", "A project procedure.", "# Procedure\n\n1. Run it."),
    );
    expect(await pathExists(join(root, ".omp", "managed-skills"))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("learn project saves memory once before writing its optional project skill", async () => {
    const { root, cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const calls: UnknownRecord[] = [];
    let releaseMemory!: (result: unknown) => void;
    const pendingMemory = new Promise<unknown>(resolve => {
      releaseMemory = resolve;
    });
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return pendingMemory;
    };
    const operation = executeTool(
      findTool(pi, "learn"),
      {
        scope: "project",
        memory: "Remember this project procedure.",
        context: "project test",
        skill: {
          action: "create",
          name: "project-lesson",
          description: "When this project procedure applies.",
          body: "# Project Lesson\n\n1. Apply it.",
        },
      },
      makeContext(cwd, invokeTool),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ memory: "Remember this project procedure.", context: "project test" });
    expect(await pathExists(projectSkillFile(root, "project-lesson"))).toBe(false);

    releaseMemory(nativeResult);
    await operation;

    expect(await readFile(projectSkillFile(root, "project-lesson"), "utf8")).toBe(
      standardSkillText(
        "project-lesson",
        "When this project procedure applies.",
        "# Project Lesson\n\n1. Apply it.",
      ),
    );
  });

  test("learn project without a skill stores memory once and does not create a project skill", async () => {
    const { root, cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };

    await executeTool(
      findTool(pi, "learn"),
      { scope: "project", memory: "Remember a fact only." },
      makeContext(cwd, invokeTool),
    );

    expect(calls).toEqual([{ memory: "Remember a fact only." }]);
    expect(await pathExists(join(root, ".omp", "skills"))).toBe(false);
  });

  test("native memory failure prevents a project learn skill from appearing", async () => {
    const { root, cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const invokeTool: NativeInvoker = async () => {
      throw new Error("native memory failed");
    };

    await expect(
      executeTool(
        findTool(pi, "learn"),
        {
          scope: "project",
          memory: "This must not mint a skill.",
          skill: {
            action: "create",
            name: "no-memory",
            description: "Should not be written.",
            body: "Body.",
          },
        },
        makeContext(cwd, invokeTool),
      ),
    ).rejects.toThrow(/native memory failed|memory/i);
    expect(await pathExists(projectSkillFile(root, "no-memory"))).toBe(false);
  });

  test("memory success with a failed project skill write returns an explicit partial or error outcome", async () => {
    const { root, cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const target = projectSkillFile(root, "partial-skill");
    await mkdir(join(root, ".omp", "skills", "partial-skill"), { recursive: true });
    await writeFile(target, "existing project skill", "utf8");
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };

    let outcome: unknown;
    try {
      outcome = await executeTool(
        findTool(pi, "learn"),
        {
          scope: "project",
          memory: "The memory was saved before the conflict.",
          skill: {
            action: "create",
            name: "partial-skill",
            description: "This create must conflict.",
            body: "Replacement body.",
          },
        },
        makeContext(cwd, invokeTool),
      );
    } catch (error) {
      outcome = error;
    }

    const serialized = outcome instanceof Error ? outcome.message : JSON.stringify(outcome);
    expect(calls).toHaveLength(1);
    expect(serialized).toMatch(/partial|error|failed|could not|exist/i);
    expect(serialized).toContain("partial-skill");
    expect(await readFile(target, "utf8")).toBe("existing project skill");
    if (outcome && typeof outcome === "object" && "isError" in outcome) {
      expect((outcome as UnknownRecord).isError).toBe(true);
    }
  });
});

describe("native capability gate", () => {
  test("manage_skill project and global calls fail closed when native manage_skill is unavailable", async () => {
    const { root, cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const tool = findTool(pi, "manage_skill");

    await expect(
      executeTool(
        tool,
        {
          scope: "project",
          action: "create",
          name: "native-gate",
          description: "Must not write without native capability.",
          body: "Body.",
        },
        makeContext(cwd),
      ),
    ).rejects.toThrow(/native|unavailable|manage_skill|capability/i);
    await expect(
      executeTool(
        tool,
        {
          scope: "global",
          action: "create",
          name: "native-global-gate",
          description: "Must not delegate without native capability.",
          body: "Body.",
        },
        makeContext(cwd),
      ),
    ).rejects.toThrow(/native|unavailable|manage_skill|capability/i);
    expect(await pathExists(projectSkillFile(root, "native-gate"))).toBe(false);
    expect(await pathExists(projectSkillFile(root, "native-global-gate"))).toBe(false);
  });

  test("learn project and global calls fail closed when native learn is unavailable", async () => {
    const { root, cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi);
    const tool = findTool(pi, "learn");

    await expect(
      executeTool(
        tool,
        {
          scope: "project",
          memory: "Must not bypass native memory.",
          skill: {
            action: "create",
            name: "native-learn-gate",
            description: "Must not write without native memory.",
            body: "Body.",
          },
        },
        makeContext(cwd),
      ),
    ).rejects.toThrow(/native|unavailable|learn|memory|capability/i);
    await expect(
      executeTool(
        tool,
        {
          scope: "global",
          memory: "Must not bypass native memory globally.",
        },
        makeContext(cwd),
      ),
    ).rejects.toThrow(/native|unavailable|learn|memory|capability/i);
    expect(await pathExists(projectSkillFile(root, "native-learn-gate"))).toBe(false);
  });

});

describe("auto-learn prompt guidance", () => {
  test("before_agent_start adds global, memory/fact, procedure/skill, project, and secret guidance without prompt-history replay", async () => {
    const pi = new FakePi();
    await install(pi);
    const handler = pi.handlers.get("before_agent_start")?.[0];
    if (!handler) throw new Error("before_agent_start handler was not registered");

    const result = await handler(
      {
        type: "before_agent_start",
        prompt: "A fresh request with no historical skill inventory.",
        systemPrompt: ["base system prompt"],
      },
      makeContext(process.cwd()),
    );

    expect(result).toBeDefined();
    const resultRecord = result as UnknownRecord;
    expect(resultRecord.systemPrompt).toBeInstanceOf(Array);
    const guidance = (resultRecord.systemPrompt as unknown[]).join("\n");
    expect(guidance).toContain("base system prompt");
    expect(guidance).toMatch(/global/i);
    expect(guidance).toMatch(/fact|memory/i);
    expect(guidance).toMatch(/procedure|skill/i);
    expect(guidance).toMatch(/project/i);
    expect(guidance).toMatch(/secret|token/i);
    expect(guidance).toMatch(/existing|already/i);
  });
});
