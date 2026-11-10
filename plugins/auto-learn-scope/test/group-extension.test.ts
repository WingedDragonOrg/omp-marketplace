import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ExtensionExports from "../src/index";

type UnknownRecord = Record<string, unknown>;
type ToolHandler = (event: UnknownRecord, ctx: UnknownRecord) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: UnknownRecord) => unknown | Promise<unknown>;
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
  refine?: (check: (value: unknown) => boolean, message?: string) => SchemaNode;
};
type NativeInvoker = (
  params: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown>;

type ExtensionModule = typeof ExtensionExports;
type ExtensionHost = Parameters<ExtensionModule["installAutoLearnScope"]>[0];

const modulePromise: Promise<ExtensionModule> = import("../src/index");
const temporaryRoots: string[] = [];

function schemaNode(kind: string, fields: UnknownRecord = {}): SchemaNode {
  const node: SchemaNode = {
    kind,
    ...fields,
    optional: () => schemaNode("optional", { inner: node }),
    describe: text => {
      node.description = text;
      return node;
    },
    refine: () => node,
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

class FakeSettings {
  rawValue(setting: unknown): unknown {
    if (setting === null || typeof setting !== "object") return undefined;
    const segments = (setting as UnknownRecord).segments;
    const key = Array.isArray(segments) ? segments.join(".") : "";
    return key === "autolearn.enabled" ? true : key === "memory.backend" ? "local" : undefined;
  }
}

class FakePi {
  readonly zod = zod;
  readonly tools: ToolDefinition[] = [];
  readonly handlers = new Map<string, ToolHandler[]>();
  readonly commands = new Map<string, CommandHandler>();
  activeSkills: unknown[] = [];
  agentDir = "";
  readonly pi = {
    settings: new FakeSettings(),
    getAgentDir: () => this.agentDir,
    getActiveSkills: () => this.activeSkills,
  };

  registerTool(definition: ToolDefinition): void {
    this.tools.push(definition);
  }

  on(event: string, handler: ToolHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, definition: { handler?: CommandHandler }): void {
    if (typeof definition.handler === "function") this.commands.set(name, definition.handler);
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

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function makeRepository(): Promise<{ root: string; cwd: string }> {
  const root = await makeRoot("auto-learn-scope-group-repo-");
  execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
  const cwd = join(root, "workspace", "app");
  await mkdir(cwd, { recursive: true });
  return { root, cwd };
}

async function extensionModule(): Promise<ExtensionModule> {
  return modulePromise;
}

async function install(pi: FakePi, managedRoot: string): Promise<void> {
  const module = await extensionModule();
  await module.installAutoLearnScope(pi as unknown as ExtensionHost, { managedRoot });
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

function makeContext(
  cwd: string,
  invokeTool?: NativeInvoker,
  sessionFile: string | undefined = "/tmp/omp-session.jsonl",
): UnknownRecord {
  const context: UnknownRecord = {
    cwd,
    mode: "print",
    hasUI: false,
    ui: {},
    getContextUsage: () => undefined,
    getAsyncJobSnapshot: () => null,
    compact: async () => undefined,
    sessionManager: { getSessionFile: () => sessionFile },
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

function childSkillFile(managedRoot: string, group: string, directory: string): string {
  return join(managedRoot, group, directory, "SKILL.md");
}

function groupIndexFile(managedRoot: string, group: string): string {
  return join(managedRoot, group, "SKILL.md");
}

function skillDocument(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

function frontmatter(text: string): { name?: string; description?: string; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { body: text };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^"|"$/g, "");
  }
  return { name: fields.name, description: fields.description, body: (match[2] ?? "").trim() };
}

function outcomeText(outcome: unknown): string {
  if (outcome instanceof Error) return outcome.message;
  return JSON.stringify(outcome);
}

const nativeResult = {
  content: [{ type: "text", text: "native memory stored" }],
  details: { source: "native" },
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("managed skill group extension behavior", () => {
  test("global manage_skill creates a missing group and writes the child plus generated index", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const hostAgentDir = await makeRoot("auto-learn-scope-host-agent-");
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    pi.agentDir = hostAgentDir;
    await install(pi, managedRoot);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };

    const result = await executeTool(
      findTool(pi, "manage_skill"),
      {
        scope: "global",
        group: "postgresql",
        action: "create",
        name: "space-audit",
        description: "Audit PostgreSQL disk usage.",
        body: "# Space Audit\n\n1. Measure live data.",
      },
      makeContext(cwd, invokeTool),
    );

    const child = childSkillFile(managedRoot, "postgresql", "space-audit");
    const index = groupIndexFile(managedRoot, "postgresql");
    expect(await readFile(child, "utf8")).toBe(
      skillDocument("space-audit", "Audit PostgreSQL disk usage.", "# Space Audit\n\n1. Measure live data."),
    );
    const indexText = await readFile(index, "utf8");
    const parsed = frontmatter(indexText);
    expect(parsed.name).toBe("postgresql");
    expect(parsed.description).toContain("Audit PostgreSQL disk usage.");
    expect(indexText).toContain("space-audit");
    expect(indexText).toContain("skill://postgresql/space-audit/SKILL.md");
    expect(outcomeText(result)).toContain(child);
    expect(calls).toHaveLength(0);
    expect(await pathExists(join(managedRoot, "space-audit", "SKILL.md"))).toBe(false);
    expect(await pathExists(join(hostAgentDir, "managed-skills", "postgresql"))).toBe(false);
  });

  test("default root comes from the host agent directory and appends managed-skills", async () => {
    const agentDir = await makeRoot("auto-learn-scope-agent-");
    const managedRoot = join(agentDir, "managed-skills");
    await mkdir(join(managedRoot, "runtime-group", "member-skill"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "runtime-group", "member-skill"),
      skillDocument("member-skill", "Created under the host agent directory.", "Body stays untouched."),
      "utf8",
    );
    const pi = new FakePi();
    pi.agentDir = agentDir;
    const module = await extensionModule();
    if (typeof module.installAutoLearnScope !== "function") {
      throw new Error("src/index.ts must export installAutoLearnScope(pi, options)");
    }

    await module.installAutoLearnScope(pi as unknown as ExtensionHost);

    const index = await readFile(groupIndexFile(managedRoot, "runtime-group"), "utf8");
    expect(frontmatter(index).name).toBe("runtime-group");
    expect(index).toContain("Created under the host agent directory.");
  });

  test("global manage_skill without group fails and does not create a flat managed skill", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi, managedRoot);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };

    await expect(
      executeTool(
        findTool(pi, "manage_skill"),
        {
          scope: "global",
          action: "create",
          name: "ungrouped",
          description: "Must not be written flat.",
          body: "Body.",
        },
        makeContext(cwd, invokeTool),
      ),
    ).rejects.toThrow(/group/i);

    expect(calls).toHaveLength(0);
    expect(await pathExists(join(managedRoot, "ungrouped"))).toBe(false);
  });

  test("global create rejects groups shadowed by an active same-named skill", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const shadowedRoot = await makeRoot("auto-learn-scope-shadowed-");
    const shadowedSkill = join(shadowedRoot, "shadowed-group", "SKILL.md");
    await mkdir(join(shadowedRoot, "shadowed-group"), { recursive: true });
    await writeFile(
      shadowedSkill,
      skillDocument("shadowed-group", "A higher-priority authored skill.", "Keep this skill active."),
      "utf8",
    );
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    pi.activeSkills = [{ name: "shadowed-group", filePath: shadowedSkill }];
    await install(pi, managedRoot);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };

    await expect(
      executeTool(
        findTool(pi, "manage_skill"),
        {
          scope: "global",
          group: "shadowed-group",
          action: "create",
          name: "hidden-procedure",
          description: "Must not create an undiscoverable group.",
          body: "Body.",
        },
        makeContext(cwd, invokeTool),
      ),
    ).rejects.toThrow(/same name|same-named/i);
    await expect(
      executeTool(
        findTool(pi, "learn"),
        {
          scope: "global",
          memory: "A hidden skill creation must not save memory first.",
          skill: {
            group: "shadowed-group",
            action: "create",
            name: "hidden-procedure",
            description: "Must not create an undiscoverable group.",
            body: "Body.",
          },
        },
        makeContext(cwd, invokeTool),
      ),
    ).rejects.toThrow(/same name|same-named/i);

    expect(calls).toHaveLength(0);
    expect(await pathExists(join(managedRoot, "shadowed-group"))).toBe(false);
  });

  test("global learn rejects an unmarked active skill at the prospective group index before memory", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const { cwd } = await makeRepository();
    const index = groupIndexFile(managedRoot, "occupied-group");
    const original = skillDocument("occupied-group", "An ordinary skill.", "Preserve this content.");
    await mkdir(join(managedRoot, "occupied-group"), { recursive: true });
    await writeFile(index, original, "utf8");
    const pi = new FakePi();
    pi.activeSkills = [{ name: "occupied-group", filePath: index }];
    await install(pi, managedRoot);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };

    await expect(
      executeTool(
        findTool(pi, "learn"),
        {
          scope: "global",
          memory: "A conflicting ordinary skill must not be shadowed.",
          skill: {
            group: "occupied-group",
            action: "create",
            name: "new-procedure",
            description: "A new procedure.",
            body: "Body.",
          },
        },
        makeContext(cwd, invokeTool),
      ),
    ).rejects.toThrow(/same name|same-named/i);

    expect(calls).toHaveLength(0);
    expect(await readFile(index, "utf8")).toBe(original);
  });

  test("global learn stores native memory before writing the grouped skill", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi, managedRoot);
    const child = childSkillFile(managedRoot, "postgresql", "space-audit");
    const calls: UnknownRecord[] = [];
    let memoryStarted = false;
    let releaseMemory!: (result: unknown) => void;
    const pendingMemory = new Promise<unknown>(resolve => {
      releaseMemory = result => {
        memoryStarted = true;
        resolve(result);
      };
    });
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      if (await pathExists(child)) throw new Error("grouped skill was written before native memory resolved");
      return pendingMemory;
    };

    const operation = executeTool(
      findTool(pi, "learn"),
      {
        scope: "global",
        memory: "Remember the PostgreSQL audit procedure.",
        context: "group test",
        skill: {
          group: "postgresql",
          action: "create",
          name: "space-audit",
          description: "Audit PostgreSQL disk usage.",
          body: "# Space Audit\n\n1. Measure live data.",
        },
      },
      makeContext(cwd, invokeTool),
    );

    expect(calls).toEqual([
      { memory: "Remember the PostgreSQL audit procedure.", context: "group test" },
    ]);
    expect(memoryStarted).toBe(false);

    releaseMemory(nativeResult);
    const result = await operation;

    expect(await readFile(child, "utf8")).toBe(
      skillDocument("space-audit", "Audit PostgreSQL disk usage.", "# Space Audit\n\n1. Measure live data."),
    );
    const indexText = await readFile(groupIndexFile(managedRoot, "postgresql"), "utf8");
    expect(indexText).toContain("skill://postgresql/space-audit/SKILL.md");
    expect(outcomeText(result)).toContain("native memory stored");
    expect(outcomeText(result)).toContain(child);
  });

  test("global learn validates its group before calling native memory", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi, managedRoot);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };

    await expect(
      executeTool(
        findTool(pi, "learn"),
        {
          scope: "global",
          memory: "Invalid groups must not save memory first.",
          skill: {
            group: "../escape",
            action: "create",
            name: "unsafe-group-skill",
            description: "Must not be written.",
            body: "Body.",
          },
        },
        makeContext(cwd, invokeTool),
      ),
    ).rejects.toThrow(/group|invalid/i);

    expect(calls).toHaveLength(0);
    expect(await pathExists(join(managedRoot, "escape"))).toBe(false);
  });

  test("native returned memory failure prevents a global grouped skill write", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi, managedRoot);
    const failureResult = {
      isError: true,
      content: [{ type: "text", text: "native memory rejected the lesson" }],
    };
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return failureResult;
    };

    const result = await executeTool(
      findTool(pi, "learn"),
      {
        scope: "global",
        memory: "Do not create a skill when native memory reports failure.",
        skill: {
          group: "postgresql",
          action: "create",
          name: "no-memory-skill",
          description: "Must not be written.",
          body: "Body.",
        },
      },
      makeContext(cwd, invokeTool),
    );

    expect(calls).toEqual([
      { memory: "Do not create a skill when native memory reports failure." },
    ]);
    expect(result).toBe(failureResult);
    expect(await pathExists(childSkillFile(managedRoot, "postgresql", "no-memory-skill"))).toBe(false);
  });

  test("global learn exposes native-memory partial success and store failure statuses", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const { cwd } = await makeRepository();
    await mkdir(join(managedRoot, "postgresql"), { recursive: true });
    await writeFile(
      groupIndexFile(managedRoot, "postgresql"),
      skillDocument("postgresql", "An ordinary user skill, not a group index.", "Do not overwrite."),
      "utf8",
    );
    const pi = new FakePi();
    await install(pi, managedRoot);
    const result = await executeTool(
      findTool(pi, "learn"),
      {
        scope: "global",
        memory: "Memory is saved even if the managed group conflicts.",
        skill: {
          group: "postgresql",
          action: "create",
          name: "space-audit",
          description: "Audit PostgreSQL disk usage.",
          body: "Body.",
        },
      },
      makeContext(cwd, async () => nativeResult),
    );
    const outcome = result as UnknownRecord;
    const details = outcome.details as UnknownRecord;

    expect(outcome.isError).toBe(true);
    expect(outcome.memoryStatus).toBe("written");
    const acceptableStatuses: unknown[] = ["not-written", "written", "unknown"];
    expect(acceptableStatuses).toContain(outcome.skillStatus);
    expect(acceptableStatuses).toContain(outcome.indexStatus);
    expect(details.memoryStatus).toBe("written");
    expect(typeof details.path).toBe("string");
    expect(details.indexPath).toBe(groupIndexFile(managedRoot, "postgresql"));
    expect(details.partial).toBe(true);
    expect(await readFile(groupIndexFile(managedRoot, "postgresql"), "utf8")).toContain("Do not overwrite.");
    expect(await pathExists(childSkillFile(managedRoot, "postgresql", "space-audit"))).toBe(false);
  });

  test("native memory failure prevents a global grouped skill from being written", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi, managedRoot);
    const invokeTool: NativeInvoker = async () => {
      throw new Error("native memory failed");
    };

    await expect(
      executeTool(
        findTool(pi, "learn"),
        {
          scope: "global",
          memory: "This must not mint a grouped skill.",
          skill: {
            group: "postgresql",
            action: "create",
            name: "space-audit",
            description: "Must not be written.",
            body: "Body.",
          },
        },
        makeContext(cwd, invokeTool),
      ),
    ).rejects.toThrow(/native memory failed|memory/i);

    expect(await pathExists(childSkillFile(managedRoot, "postgresql", "space-audit"))).toBe(false);
    expect(await pathExists(groupIndexFile(managedRoot, "postgresql"))).toBe(false);
  });

  test("project manage_skill keeps the repository skill path and leaves the managed root unchanged", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const { root, cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi, managedRoot);
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
        name: "project-procedure",
        description: "A project procedure.",
        body: "# Procedure\n\n1. Run it.",
      },
      makeContext(cwd, invokeTool),
    );

    expect(await readFile(projectSkillFile(root, "project-procedure"), "utf8")).toBe(
      skillDocument("project-procedure", "A project procedure.", "# Procedure\n\n1. Run it."),
    );
    expect(calls).toHaveLength(0);
    expect(await pathExists(join(managedRoot, "project-procedure"))).toBe(false);
    expect(await pathExists(join(managedRoot, "postgresql"))).toBe(false);

  });

  test("factory scan creates an index for a handmade group before any tool call", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "postgresql", "zeta-audit"), { recursive: true });
    await mkdir(join(managedRoot, "postgresql", "alpha-audit"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "postgresql", "zeta-audit"),
      skillDocument("zeta-audit", "Later alphabetical audit.", "Zeta body stays untouched."),
      "utf8",
    );
    await writeFile(
      childSkillFile(managedRoot, "postgresql", "alpha-audit"),
      skillDocument("alpha-audit", "Earlier alphabetical audit.", "Alpha body stays untouched."),
      "utf8",
    );
    await writeFile(join(managedRoot, "postgresql", "notes.txt"), "not a skill", "utf8");
    const pi = new FakePi();

    await install(pi, managedRoot);

    const indexText = await readFile(groupIndexFile(managedRoot, "postgresql"), "utf8");
    const parsed = frontmatter(indexText);
    expect(parsed.name).toBe("postgresql");
    expect(parsed.description?.length ?? 0).toBeLessThanOrEqual(200);
    expect(parsed.description).toContain("Earlier alphabetical audit.");
    const alpha = indexText.indexOf("alpha-audit");
    const zeta = indexText.indexOf("zeta-audit");
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(zeta).toBeGreaterThan(alpha);
    expect(indexText).toContain("skill://postgresql/alpha-audit/SKILL.md");
    expect(indexText).toContain("skill://postgresql/zeta-audit/SKILL.md");
    expect(indexText).not.toContain("notes.txt");
    expect(await readFile(childSkillFile(managedRoot, "postgresql", "zeta-audit"), "utf8")).toContain(
      "Zeta body stays untouched.",
    );
  });

  test("interactive refresh input scans group indexes before routing to OMP plugin reload", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const pi = new FakePi();
    await install(pi, managedRoot);
    await mkdir(join(managedRoot, "runtime-group", "member-skill"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "runtime-group", "member-skill"),
      skillDocument("member-skill", "Created after session start.", "Member body stays untouched."),
      "utf8",
    );
    const handler = pi.handlers.get("input")?.[0];
    if (!handler) throw new Error("extension must register an input handler for managed skill refresh");

    for (const text of ["/refresh-managed-skills", "/refresh-managed-skills refresh"]) {
      const result = await handler({ type: "input", text }, makeContext(process.cwd()));
      expect(result).toEqual({ text: "/reload-plugins" });
      const indexText = await readFile(groupIndexFile(managedRoot, "runtime-group"), "utf8");
      expect(frontmatter(indexText).name).toBe("runtime-group");
      expect(indexText).toContain("Created after session start.");
      expect(indexText).toContain("skill://runtime-group/member-skill/SKILL.md");
    }
    expect(await readFile(childSkillFile(managedRoot, "runtime-group", "member-skill"), "utf8")).toContain(
      "Member body stays untouched.",
    );
  });

  test("input handler leaves unrelated text and extra refresh arguments to normal command handling", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const pi = new FakePi();
    await install(pi, managedRoot);
    await mkdir(join(managedRoot, "runtime-group", "member-skill"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "runtime-group", "member-skill"),
      skillDocument("member-skill", "Created after session start.", "Body."),
      "utf8",
    );
    const handler = pi.handlers.get("input")?.[0];
    if (!handler) throw new Error("extension must register an input handler");

    expect(await handler({ type: "input", text: "ordinary user prompt" }, makeContext(process.cwd()))).toBeUndefined();
    expect(
      await handler(
        { type: "input", text: "/refresh-managed-skills refresh now" },
        makeContext(process.cwd()),
      ),
    ).toBeUndefined();
    expect(await pathExists(groupIndexFile(managedRoot, "runtime-group"))).toBe(false);
  });

  test("input refresh errors do not route to OMP plugin reload", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const outsideRoot = await makeRoot("auto-learn-scope-outside-");
    const pi = new FakePi();
    await install(pi, managedRoot);
    await rm(managedRoot, { recursive: true });
    await symlink(outsideRoot, managedRoot);
    const handler = pi.handlers.get("input")?.[0];
    if (!handler) throw new Error("extension must register an input handler");

    expect(() =>
      handler({ type: "input", text: "/refresh-managed-skills" }, makeContext(process.cwd())),
    ).toThrow(/managed-skills root.*safe directory/i);
  });

  test("direct print-mode command scans groups but explains that skill discovery was not refreshed", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const pi = new FakePi();
    await install(pi, managedRoot);
    await mkdir(join(managedRoot, "runtime-group", "member-skill"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "runtime-group", "member-skill"),
      skillDocument("member-skill", "Created after session start.", "Member body stays untouched."),
      "utf8",
    );
    const command = [...pi.commands.values()].find(candidate => candidate.length >= 2);
    if (!command) throw new Error("extension must register a refresh command");

    expect(() => command("refresh", makeContext(process.cwd()))).toThrow(/new session/i);

    expect(await readFile(groupIndexFile(managedRoot, "runtime-group"), "utf8")).toContain(
      "Created after session start.",
    );
    expect(await readFile(childSkillFile(managedRoot, "runtime-group", "member-skill"), "utf8")).toContain(
      "Member body stays untouched.",
    );
  });


  test("a read tool_call for a grouped skill refreshes the group index before the read proceeds", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "postgresql", "space-audit"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "postgresql", "space-audit"),
      skillDocument("space-audit", "Original audit.", "Original body."),
      "utf8",
    );
    const pi = new FakePi();
    await install(pi, managedRoot);
    pi.activeSkills = [
      { name: "postgresql", filePath: groupIndexFile(managedRoot, "postgresql") },
    ];
    const index = groupIndexFile(managedRoot, "postgresql");
    const stale = await readFile(index, "utf8");
    await writeFile(
      childSkillFile(managedRoot, "postgresql", "space-audit"),
      skillDocument("space-audit", "Refreshed audit description.", "Original body."),
      "utf8",
    );
    const handler = pi.handlers.get("tool_call")?.find(candidate => candidate.length >= 1);
    if (!handler) throw new Error("extension must register a tool_call handler that refreshes grouped reads");

    const decision = await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://postgresql/space-audit/SKILL.md" },
      },
      makeContext(process.cwd()),
    );

    const refreshed = await readFile(index, "utf8");
    expect(refreshed).not.toBe(stale);
    expect(refreshed).toContain("Refreshed audit description.");
    expect(refreshed).toContain("skill://postgresql/space-audit/SKILL.md");
    expect(decision === undefined || (decision !== null && typeof decision === "object" && !("block" in decision))).toBe(true);
    expect(await readFile(childSkillFile(managedRoot, "postgresql", "space-audit"), "utf8")).toContain("Original body.");
  });
  
  test("read interception honors active-skill path and namespace precedence", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "postgresql", "space-audit"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "postgresql", "space-audit"),
      skillDocument("space-audit", "Original audit.", "Original body."),
      "utf8",
    );
    const flatOrdinaryPath = join(managedRoot, "flat-ordinary", "SKILL.md");
    const flatOrdinaryText = skillDocument("flat-ordinary", "A flat managed skill.", "Do not rewrite.");
    await mkdir(join(managedRoot, "flat-ordinary"), { recursive: true });
    await writeFile(flatOrdinaryPath, flatOrdinaryText, "utf8");
    const outsideRoot = await makeRoot("auto-learn-scope-higher-priority-");
    const ordinarySkill = join(outsideRoot, "ordinary-skill", "SKILL.md");
    const higherPriorityGroup = join(outsideRoot, "postgresql", "SKILL.md");
    const higherPriorityNamespace = join(outsideRoot, "postgresql-space-audit", "SKILL.md");
    await Promise.all([
      mkdir(join(outsideRoot, "ordinary-skill"), { recursive: true }),
      mkdir(join(outsideRoot, "postgresql"), { recursive: true }),
      mkdir(join(outsideRoot, "postgresql-space-audit"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(ordinarySkill, skillDocument("ordinary-skill", "An ordinary skill.", "Body."), "utf8"),
      writeFile(higherPriorityGroup, skillDocument("postgresql", "A higher-priority ordinary skill.", "Body."), "utf8"),
      writeFile(
        higherPriorityNamespace,
        skillDocument("space-audit", "A higher-priority namespaced skill.", "Body."),
        "utf8",
      ),
    ]);
    const pi = new FakePi();
    await install(pi, managedRoot);
    const index = groupIndexFile(managedRoot, "postgresql");
    const stale = await readFile(index, "utf8");
    await writeFile(
      childSkillFile(managedRoot, "postgresql", "space-audit"),
      skillDocument("space-audit", "Changed group member.", "Original body."),
      "utf8",
    );
    const handler = pi.handlers.get("tool_call")?.find(candidate => candidate.length >= 1);
    if (!handler) throw new Error("extension must register a tool_call handler that refreshes grouped reads");

    pi.activeSkills = [{ name: "flat-ordinary", filePath: flatOrdinaryPath }];
    const ordinaryResult = await handler(
      { type: "tool_call", toolName: "read", input: { path: "skill://flat-ordinary/SKILL.md" } },
      makeContext(process.cwd()),
    );
    expect(ordinaryResult).toBeUndefined();
    expect(await readFile(flatOrdinaryPath, "utf8")).toBe(flatOrdinaryText);
    expect(await readFile(index, "utf8")).toBe(stale);

    pi.activeSkills = [{ name: "ordinary-skill", filePath: ordinarySkill }];
    await handler(
      { type: "tool_call", toolName: "read", input: { path: "skill://ordinary-skill/SKILL.md" } },
      makeContext(process.cwd()),
    );
    expect(await readFile(index, "utf8")).toBe(stale);

    pi.activeSkills = [{ name: "postgresql", filePath: higherPriorityGroup }];
    await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://postgresql/space-audit/SKILL.md" },
      },
      makeContext(process.cwd()),
    );
    expect(await readFile(index, "utf8")).toBe(stale);

    pi.activeSkills = [
      { name: "postgresql", filePath: index },
      { name: "postgresql/space-audit", filePath: higherPriorityNamespace },
    ];
    await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://postgresql/space-audit/SKILL.md" },
      },
      makeContext(process.cwd()),
    );
    expect(await readFile(index, "utf8")).toBe(stale);
  });

  test("unmarked ordinary skills with nested skills are not refreshed as groups", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const ordinaryIndex = join(managedRoot, "legacy-skill", "SKILL.md");
    const childPath = join(managedRoot, "legacy-skill", "nested-skill", "SKILL.md");
    const ordinaryText = skillDocument("legacy-skill", "An ordinary skill.", "Do not rewrite.");
    const childText = skillDocument("nested-skill", "A nested ordinary skill.", "Keep unchanged.");
    await mkdir(join(managedRoot, "legacy-skill", "nested-skill"), { recursive: true });
    await Promise.all([writeFile(ordinaryIndex, ordinaryText, "utf8"), writeFile(childPath, childText, "utf8")]);
    const pi = new FakePi();
    await install(pi, managedRoot);
    pi.activeSkills = [{ name: "legacy-skill", filePath: ordinaryIndex }];
    const handler = pi.handlers.get("tool_call")?.find(candidate => candidate.length >= 1);
    if (!handler) throw new Error("extension must register a tool_call handler for skill reads");

    const result = await handler(
      { type: "tool_call", toolName: "read", input: { path: "skill://legacy-skill/SKILL.md" } },
      makeContext(process.cwd()),
    );

    expect(result).toBeUndefined();
    expect(await readFile(ordinaryIndex, "utf8")).toBe(ordinaryText);
    expect(await readFile(childPath, "utf8")).toBe(childText);
  });

  test("read interception refreshes the parent group for an active managed namespace skill", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "postgresql", "space-audit"), { recursive: true });
    const memberPath = childSkillFile(managedRoot, "postgresql", "space-audit");
    await writeFile(memberPath, skillDocument("space-audit", "Original audit.", "Body."), "utf8");
    const pi = new FakePi();
    await install(pi, managedRoot);
    const index = groupIndexFile(managedRoot, "postgresql");
    const stale = await readFile(index, "utf8");
    await writeFile(memberPath, skillDocument("space-audit", "Changed namespace member.", "Body."), "utf8");
    pi.activeSkills = [{ name: "postgresql/space-audit", filePath: memberPath }];
    const handler = pi.handlers.get("tool_call")?.find(candidate => candidate.length >= 1);
    if (!handler) throw new Error("extension must register a tool_call handler that refreshes grouped reads");

    await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://postgresql/space-audit/SKILL.md" },
      },
      makeContext(process.cwd()),
    );

    const refreshed = await readFile(index, "utf8");
    expect(refreshed).not.toBe(stale);
    expect(refreshed).toContain("Changed namespace member.");
  });

  test("read interception blocks the host read when group index refresh fails", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "postgresql", "space-audit"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "postgresql", "space-audit"),
      skillDocument("space-audit", "An audit.", "Body."),
      "utf8",
    );
    const pi = new FakePi();
    await install(pi, managedRoot);
    const index = groupIndexFile(managedRoot, "postgresql");
    const indexContents = await readFile(index, "utf8");
    const marker = indexContents.split("\n").find(line => line.includes("managed skill group index"));
    if (!marker) throw new Error("managed group index must have its identifying marker");
    const invalidIndex = `${marker}\n`;
    await writeFile(index, invalidIndex, "utf8");
    pi.activeSkills = [{ name: "postgresql", filePath: index }];
    const handler = pi.handlers.get("tool_call")?.find(candidate => candidate.length >= 1);
    if (!handler) throw new Error("extension must register a tool_call handler that blocks failed grouped reads");

    const decision = await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://postgresql/space-audit/SKILL.md" },
      },
      makeContext(process.cwd()),
    ) as UnknownRecord;

    expect(decision.block).toBe(true);
    expect(typeof decision.reason).toBe("string");
    expect(await readFile(index, "utf8")).toBe(invalidIndex);
  });

  test("read interception blocks when a known group index becomes a symlink", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "postgresql", "space-audit"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "postgresql", "space-audit"),
      skillDocument("space-audit", "An audit.", "Body."),
      "utf8",
    );
    const pi = new FakePi();
    await install(pi, managedRoot);
    const index = groupIndexFile(managedRoot, "postgresql");
    const outsideRoot = await makeRoot("auto-learn-scope-index-target-");
    const outsideIndex = join(outsideRoot, "SKILL.md");
    const outsideContents = skillDocument("postgresql", "An external target.", "Do not follow this link.");
    await writeFile(outsideIndex, outsideContents, "utf8");
    await rm(index);
    await symlink(outsideIndex, index);
    pi.activeSkills = [{ name: "postgresql", filePath: index }];
    const handler = pi.handlers.get("tool_call")?.find(candidate => candidate.length >= 1);
    if (!handler) throw new Error("extension must register a tool_call handler for grouped reads");

    const decision = await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://postgresql/space-audit/SKILL.md" },
      },
      makeContext(process.cwd()),
    ) as UnknownRecord;

    expect(decision.block).toBe(true);
    expect(typeof decision.reason).toBe("string");
    expect(await readFile(outsideIndex, "utf8")).toBe(outsideContents);
  });

  test("read interception blocks when a known group index is missing or unmarked", async () => {
    for (const state of ["missing", "unmarked"] as const) {
      const managedRoot = await makeRoot("auto-learn-scope-group-");
      await mkdir(join(managedRoot, "postgresql", "space-audit"), { recursive: true });
      await writeFile(
        childSkillFile(managedRoot, "postgresql", "space-audit"),
        skillDocument("space-audit", "An audit.", "Body."),
        "utf8",
      );
      const pi = new FakePi();
      await install(pi, managedRoot);
      const index = groupIndexFile(managedRoot, "postgresql");
      if (state === "missing") {
        await rm(index);
      } else {
        await writeFile(index, skillDocument("postgresql", "An ordinary skill.", "No group marker."), "utf8");
      }
      pi.activeSkills = [{ name: "postgresql", filePath: index }];
      const handler = pi.handlers.get("tool_call")?.find(candidate => candidate.length >= 1);
      if (!handler) throw new Error("extension must register a tool_call handler for grouped reads");

      const decision = await handler(
        {
          type: "tool_call",
          toolName: "read",
          input: { path: "skill://postgresql/space-audit/SKILL.md" },
        },
        makeContext(process.cwd()),
      ) as UnknownRecord;

      expect(decision.block).toBe(true);
      expect(typeof decision.reason).toBe("string");
    }
  });

});
