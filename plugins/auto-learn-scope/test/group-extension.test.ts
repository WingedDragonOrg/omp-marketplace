import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createManagedGroupStore } from "../src/managed-groups";
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
type CapturedModelRequest = { path: string; body: string; authorization?: string };
type SummaryServerReply = (
  | { text: string }
  | { judgeProbability: number }
  | { error: string }
) & { release?: Promise<void> };
type SummaryTestRuntime = {
  model?: unknown;
  currentModel?: unknown;
  registryModels: unknown[];
  resolvedRoles: string[];
  credentialSessions: string[];
  notifications: string[];
  notificationWaiters: Array<{ text: string; resolve: (message: string) => void }>;
  apiKey: string;
};

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
  readonly messages: Array<{ customType: string; content: string; display: true; triggerTurn?: boolean }> = [];
  readonly registry = new AgentRegistry();
  sessionSettings: Settings = Settings.isolated();
  activeSkills: unknown[] = [];
  sessionId = "test-session";
  agentDir = "";
  constructor() {
    const pi = this;
    this.registry.register({
      id: "auto-learn-scope-test",
      displayName: "auto-learn-scope-test",
      kind: "main",
      session: {
        get skills() { return pi.activeSkills; },
        get settings() { return pi.sessionSettings; },
        sessionManager: { getSessionId: () => pi.sessionId },
      } as never,
    });
  }

  readonly pi: {
    settings: FakeSettings;
    getAgentDir: () => string;
    AgentRegistry: { global: () => AgentRegistry } | undefined;
  } = {
    settings: new FakeSettings(),
    getAgentDir: () => this.agentDir,
    AgentRegistry: { global: () => this.registry },
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
  sendMessage(
    message: { customType: string; content: string; display: true },
    options?: { triggerTurn?: boolean },
  ): void {
    this.messages.push({ ...message, ...(options?.triggerTurn === undefined ? {} : { triggerTurn: options.triggerTurn }) });
  }
}

function registerProcessGlobalSnapshot(skills: unknown[], sessionId = "test-session"): void {
  AgentRegistry.global().register({
    id: "auto-learn-scope-test",
    displayName: "auto-learn-scope-test",
    kind: "main",
    session: { get skills() { return skills; }, sessionManager: { getSessionId: () => sessionId } } as never,
  });
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
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
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
  summaryRuntime?: SummaryTestRuntime,
): UnknownRecord {
  const context: UnknownRecord = {
    agent: { id: "auto-learn-scope-test", kind: "main", name: "main", depth: 0 },
    cwd,
    mode: "print",
    hasUI: Boolean(summaryRuntime),
    ui: summaryRuntime
      ? {
          notify(message: string, type = "info") {
            const notification = `${type}: ${message}`;
            summaryRuntime.notifications.push(notification);
            const pending = summaryRuntime.notificationWaiters.filter(waiter => notification.includes(waiter.text));
            summaryRuntime.notificationWaiters = summaryRuntime.notificationWaiters.filter(
              waiter => !pending.includes(waiter),
            );
            for (const waiter of pending) waiter.resolve(notification);
          },
        }
      : {},
    getContextUsage: () => undefined,
    getAsyncJobSnapshot: () => null,
    compact: async () => undefined,
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "test-session" },
    modelRegistry: summaryRuntime
      ? {
          getAvailable: () => summaryRuntime.registryModels,
          getApiKey: async (_model: unknown, sessionId: string) => {
            summaryRuntime.credentialSessions.push(sessionId);
            return summaryRuntime.apiKey;
          },
          resolver: (_model: unknown, sessionId: string) => {
            summaryRuntime.credentialSessions.push(sessionId);
            return async () => summaryRuntime.apiKey;
          },
          resolveModelHeaders: async () => undefined,
        }
      : {},
    models: {
      list: () => summaryRuntime?.registryModels ?? [],
      current: () => summaryRuntime?.currentModel,
      resolve: (spec: string) => {
        if (!summaryRuntime) return undefined;
        summaryRuntime.resolvedRoles.push(spec);
        return spec === "@smol" ? summaryRuntime.model : undefined;
      },
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

function summaryRuntime(
  model?: unknown,
  currentModel?: unknown,
  registryModels: unknown[] = model ? [model] : [],
): SummaryTestRuntime {
  return {
    model,
    currentModel,
    registryModels,
    resolvedRoles: [],
    credentialSessions: [],
    notifications: [],
    notificationWaiters: [],
    apiKey: "fixture-model-api-key",
  };
}

function waitForNotification(runtime: SummaryTestRuntime, text: string): Promise<string> {
  const existing = runtime.notifications.find(notification => notification.includes(text));
  if (existing) return Promise.resolve(existing);
  const deferred = Promise.withResolvers<string>();
  const waiter = { text, resolve: deferred.resolve };
  runtime.notificationWaiters.push(waiter);
  const signal = AbortSignal.timeout(10_000);
  const onAbort = () => deferred.reject(new Error(`Timed out waiting for notification containing ${JSON.stringify(text)}.`));
  signal.addEventListener("abort", onAbort, { once: true });
  return deferred.promise.finally(() => {
    signal.removeEventListener("abort", onAbort);
    runtime.notificationWaiters = runtime.notificationWaiters.filter(candidate => candidate !== waiter);
  });
}

function makeSummaryModel(baseUrl: string): UnknownRecord {
  const catalogModel = getBundledModel("openai", "gpt-4o-mini");
  return buildModel({
    ...catalogModel,
    id: "auto-learn-summary-fixture",
    name: "Auto-learn Summary Fixture",
    api: "openai-completions",
    baseUrl,
    reasoning: false,
  }) as unknown as UnknownRecord;
}

function makeJudgeModel(baseUrl: string): UnknownRecord {
  return buildModel({
    ...getBundledModel("typesafe", "jev-1.14.0"),
    baseUrl,
  }) as unknown as UnknownRecord;
}

function configureJudgeRole(pi: FakePi): Settings {
  const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-1.14.0" } });
  const settingsWithPluginValues = settings as unknown as { rawValue: (setting: unknown) => unknown };
  const originalRawValue = settingsWithPluginValues.rawValue.bind(settings);
  settingsWithPluginValues.rawValue = (setting: unknown) => {
    const segments = setting && typeof setting === "object" ? (setting as UnknownRecord).segments : undefined;
    const path = Array.isArray(segments) ? segments.join(".") : "";
    if (path === "autolearn.enabled") return true;
    if (path === "memory.backend") return "local";
    return originalRawValue(setting);
  };
  const piNamespace = pi.pi as unknown as { settings: unknown };
  piNamespace.settings = settings;
  pi.sessionSettings = settings;
  return settings;
}

async function startSummaryServer(replies: readonly SummaryServerReply[]): Promise<{
  rootUrl: string;
  baseUrl: string;
  requests: CapturedModelRequest[];
  untilRequests: (count: number) => Promise<void>;
  close: () => Promise<void>;
}> {
  const requests: CapturedModelRequest[] = [];
  const requestSignals: Array<{ count: number; resolve: () => void }> = [];
  const notifyRequests = (): void => {
    for (const signal of requestSignals) {
      if (requests.length >= signal.count) signal.resolve();
    }
  };
  let replyIndex = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requests.push({
        path: request.url ?? "",
        body,
        ...(typeof request.headers.authorization === "string"
          ? { authorization: request.headers.authorization }
          : {}),
      });
      notifyRequests();
      const reply = replies[Math.min(replyIndex, replies.length - 1)];
      replyIndex += 1;
      if (!reply) throw new Error("summary server requires at least one reply fixture");
      if (reply.release) await reply.release;
      if ("error" in reply) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: { message: reply.error, type: "invalid_request_error", code: "fixture_failure" },
        }));
        return;
      }
      if ("judgeProbability" in reply) {
        const payload = JSON.parse(body) as UnknownRecord;
        const questions = payload.questions;
        const questionName =
          questions !== null && typeof questions === "object" && !Array.isArray(questions)
            ? Object.keys(questions)[0] ?? "covered"
            : "covered";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          model: "jev-1.14.0",
          answers: { [questionName]: { type: "noul", noul: reply.judgeProbability } },
          usage: { input_tokens: 12, output_tokens: 1 },
        }));
        return;
      }
      const chunk = (content: string, finishReason: string | null) => ({
        id: "chatcmpl-auto-learn-summary",
        object: "chat.completion.chunk",
        created: 0,
        model: "auto-learn-summary-fixture",
        choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.end(
        [
          `data: ${JSON.stringify(chunk(reply.text, null))}`,
          "",
          `data: ${JSON.stringify(chunk("", "stop"))}`,
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n"),
      );
    })().catch(error => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("summary fixture server did not bind a TCP port");
  const rootUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  return {
    rootUrl,
    baseUrl: `${rootUrl}/v1`,
    requests,
    untilRequests(count: number): Promise<void> {
      if (requests.length >= count) return Promise.resolve();
      const pending = Promise.withResolvers<void>();
      requestSignals.push({ count, resolve: pending.resolve });
      if (requests.length >= count) pending.resolve();
      return pending.promise;
    },
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(error => error ? closed.reject(error) : closed.resolve());
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

async function waitForFileText(path: string, expected: string): Promise<string> {
  const readCurrent = async () => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  };
  const initial = await readCurrent();
  if (initial?.includes(expected)) return initial;
  const timeoutSignal = AbortSignal.timeout(10_000);
  try {
    for await (const _change of watch(dirname(path), { signal: timeoutSignal })) {
      const current = await readCurrent();
      if (current?.includes(expected)) return current;
    }
  } catch (error) {
    if (!timeoutSignal.aborted) throw error;
  }
  throw new Error(`Timed out waiting for ${path} to contain ${JSON.stringify(expected)}.`);
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
  AgentRegistry.global().unregister("auto-learn-scope-test");
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
    registerProcessGlobalSnapshot([]);
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

  test("learn reports the target skill path when an update group is missing after memory succeeds", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-missing-group-");
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi, managedRoot);
    const result = await executeTool(findTool(pi, "learn"), {
      memory: "Persist this lesson.",
      skill: {
        group: "engineering/database",
        action: "update",
        name: "space-audit",
        description: "Audit database space.",
        body: "Body.",
      },
    }, makeContext(cwd, async () => nativeResult)) as UnknownRecord;
    expect(result.memoryStatus).toBe("written");
    expect(result.skillStatus).toBe("not-written");
    expect(result.skillPath).toEndWith("/engineering/database/space-audit/SKILL.md");
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
    expect(details.skillStatus).toBe(outcome.skillStatus);
    expect(details.skillPath).toBe(outcome.skillPath);
    const indexes = outcome.indexes as UnknownRecord[];
    expect(Array.isArray(indexes)).toBe(true);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.group).toBe("postgresql");
    expect(indexes[0]?.path).toBe(groupIndexFile(managedRoot, "postgresql"));
    expect((["not-written", "written", "unknown"] as unknown[])).toContain(indexes[0]?.status);
    expect(typeof indexes[0]?.needsRebuild).toBe("boolean");
    if (indexes[0]?.status === "not-written") {
      expect((["failed", "not-attempted"] as unknown[])).toContain(indexes[0]?.reason);
    }
    expect(details.indexes).toEqual(indexes);
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

  test("interactive refresh runs the command without forwarding a plugin reload", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "runtime-group", "member-skill"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "runtime-group", "member-skill"),
      skillDocument("member-skill", "Created after session start.", "PRIVATE_MEMBER_BODY."),
      "utf8",
    );
    const pi = new FakePi();
    const server = await startSummaryServer([{ text: "A generated runtime group summary." }]);
    const runtime = summaryRuntime(makeSummaryModel(server.baseUrl));
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    await install(pi, managedRoot);
    try {
      const inputHandler = pi.handlers.get("input")?.[0];
      const inputResult = inputHandler
        ? await inputHandler({ type: "input", text: "/refresh-managed-skills" }, ctx)
        : undefined;
      expect(inputResult).toBeUndefined();

      const command = pi.commands.get("refresh-managed-skills");
      if (!command) throw new Error("extension must register /refresh-managed-skills");
      await command("--force", ctx);

      const indexText = await waitForFileText(groupIndexFile(managedRoot, "runtime-group"), "A generated runtime group summary.");
      expect(frontmatter(indexText).name).toBe("runtime-group");
      expect(indexText).toContain("skill://runtime-group/member-skill/SKILL.md");
      expect(runtime.notifications.join("\n")).toContain("runtime-group");
      expect(JSON.stringify(inputResult ?? "")).not.toContain("/reload-plugins");
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.path).toBe("/v1/chat/completions");
      expect(server.requests[0]?.body).not.toContain("PRIVATE_MEMBER_BODY.");
      expect(await readFile(childSkillFile(managedRoot, "runtime-group", "member-skill"), "utf8")).toContain(
        "PRIVATE_MEMBER_BODY.",
      );
    } finally {
      await server.close();
    }
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

  test("global tools accept nested groups and expose index results from the target group to the root", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const { cwd } = await makeRepository();
    const pi = new FakePi();
    await install(pi, managedRoot);
    const calls: UnknownRecord[] = [];
    const invokeTool: NativeInvoker = async params => {
      calls.push({ ...params });
      return nativeResult;
    };
    const expectedIndexes = (group: string): UnknownRecord[] => {
      const segments = group.split("/");
      return segments.map((_segment, index) => {
        const indexedGroup = segments.slice(0, segments.length - index).join("/");
        return {
          group: indexedGroup,
          path: groupIndexFile(managedRoot, indexedGroup),
          status: "written",
          needsRebuild: false,
        };
      });
    };
    const managedGroup = "engineering/database/postgresql";
    const managedSkillPath = childSkillFile(managedRoot, managedGroup, "space-audit");
    const managedResult = await executeTool(
      findTool(pi, "manage_skill"),
      {
        scope: "global",
        group: managedGroup,
        action: "create",
        name: "space-audit",
        description: "Audit PostgreSQL disk usage.",
        body: "Managed skill body.",
      },
      makeContext(cwd, invokeTool),
    ) as UnknownRecord;
    const managedDetails = managedResult.details as UnknownRecord;

    expect(await readFile(managedSkillPath, "utf8")).toBe(
      skillDocument("space-audit", "Audit PostgreSQL disk usage.", "Managed skill body."),
    );
    expect(managedResult.path).toBe(managedSkillPath);
    expect(managedResult.indexes).toEqual(expectedIndexes(managedGroup));
    expect(managedDetails.indexes).toEqual(expectedIndexes(managedGroup));

    const learnedGroup = "engineering/database/warehouse";
    const learnedSkillPath = childSkillFile(managedRoot, learnedGroup, "rotation-check");
    const learnedResult = await executeTool(
      findTool(pi, "learn"),
      {
        scope: "global",
        memory: "Remember the warehouse rotation check.",
        skill: {
          group: learnedGroup,
          action: "create",
          name: "rotation-check",
          description: "Check warehouse rotation.",
          body: "Learned skill body.",
        },
      },
      makeContext(cwd, invokeTool),
    ) as UnknownRecord;
    const learnedDetails = learnedResult.details as UnknownRecord;

    expect(await readFile(learnedSkillPath, "utf8")).toBe(
      skillDocument("rotation-check", "Check warehouse rotation.", "Learned skill body."),
    );
    expect(learnedResult.path).toBe(learnedSkillPath);
    expect(learnedResult.indexes).toEqual(expectedIndexes(learnedGroup));
    expect(learnedDetails.indexes).toEqual(expectedIndexes(learnedGroup));
    expect(calls).toEqual([{ memory: "Remember the warehouse rotation check." }]);
    expect(await readFile(groupIndexFile(managedRoot, "engineering"), "utf8")).toContain(
      "skill://engineering/database/SKILL.md",
    );
    const databaseIndex = await readFile(groupIndexFile(managedRoot, "engineering/database"), "utf8");
    expect(databaseIndex).toContain("skill://engineering/database/postgresql/SKILL.md");
    expect(databaseIndex).toContain("skill://engineering/database/warehouse/SKILL.md");

    await executeTool(findTool(pi, "manage_skill"), {
      group: managedGroup, action: "update", name: "space-audit",
      description: "Updated database audit.", body: "Updated manage body.",
    }, makeContext(cwd, invokeTool));
    expect(await readFile(managedSkillPath, "utf8")).toContain("Updated manage body.");

    await executeTool(findTool(pi, "learn"), {
      memory: "Remember the updated audit.",
      skill: {
        group: managedGroup, action: "update", name: "space-audit",
        description: "Learned database audit.", body: "Updated learn body.",
      },
    }, makeContext(cwd, invokeTool));
    expect(await readFile(managedSkillPath, "utf8")).toContain("Updated learn body.");
    expect(await readFile(groupIndexFile(managedRoot, managedGroup), "utf8")).toContain("Learned database audit.");

    await executeTool(findTool(pi, "manage_skill"), {
      group: managedGroup, action: "delete", name: "space-audit",
    }, makeContext(cwd, invokeTool));
    expect(await pathExists(managedSkillPath)).toBe(false);
    expect(await readFile(groupIndexFile(managedRoot, managedGroup), "utf8")).not.toContain("space-audit");
  });

  test("global tools reject traversal in a nested group before writing or saving memory", async () => {
    const root = await makeRoot("auto-learn-scope-traversal-");
    const managedRoot = join(root, "managed");
    await mkdir(managedRoot, { recursive: true });
    const { cwd } = await makeRepository();
    const escapedSkillPath = join(root, "outside", "escaped-skill", "SKILL.md");

    for (const toolName of ["manage_skill", "learn"] as const) {
      const pi = new FakePi();
      await install(pi, managedRoot);
      const calls: UnknownRecord[] = [];
      const invokeTool: NativeInvoker = async params => {
        calls.push({ ...params });
        return nativeResult;
      };
      const params =
        toolName === "manage_skill"
          ? {
              scope: "global",
              group: "branch/../../outside",
              action: "create",
              name: "escaped-skill",
              description: "Must stay inside managed-skills.",
              body: "Body.",
            }
          : {
              scope: "global",
              memory: "Invalid groups must not save memory first.",
              skill: {
                group: "branch/../../outside",
                action: "create",
                name: "escaped-skill",
                description: "Must stay inside managed-skills.",
                body: "Body.",
              },
            };

      await expect(
        executeTool(findTool(pi, toolName), params, makeContext(cwd, invokeTool)),
      ).rejects.toThrow(/group|invalid|path/i);

      expect(calls).toHaveLength(0);
      expect(await pathExists(escapedSkillPath)).toBe(false);
      expect(await pathExists(join(managedRoot, "branch"))).toBe(false);
    }
  });

  test("reading a nested group or member refreshes its index and every ancestor", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const group = "engineering/database/postgresql";
    const memberPath = childSkillFile(managedRoot, group, "deep-audit");
    await mkdir(join(managedRoot, group, "deep-audit"), { recursive: true });
    await writeFile(memberPath, skillDocument("deep-audit", "Original deep audit.", "Stable body."), "utf8");
    const pi = new FakePi();
    pi.activeSkills = [{ name: "engineering", filePath: groupIndexFile(managedRoot, "engineering") }];
    await install(pi, managedRoot);
    const topIndex = groupIndexFile(managedRoot, "engineering");
    const databaseIndex = groupIndexFile(managedRoot, "engineering/database");
    const postgresqlIndex = groupIndexFile(managedRoot, group);
    const initialTopIndex = await readFile(topIndex, "utf8");
    const initialDatabaseIndex = await readFile(databaseIndex, "utf8");
    const handler = pi.handlers.get("tool_call")?.find(candidate => candidate.length >= 1);
    if (!handler) throw new Error("extension must register a tool_call handler that refreshes nested group reads");

    await writeFile(
      memberPath,
      skillDocument("deep-audit", "Changed by nested group read.", "Stable body."),
      "utf8",
    );
    const groupDecision = await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://engineering/database/SKILL.md" },
      },
      makeContext(process.cwd()),
    );

    const refreshedTopIndex = await readFile(topIndex, "utf8");
    const refreshedDatabaseIndex = await readFile(databaseIndex, "utf8");
    expect(groupDecision).toBeUndefined();
    expect(refreshedDatabaseIndex).not.toBe(initialDatabaseIndex);
    expect(refreshedDatabaseIndex).toContain("Changed by nested group read.");
    expect(refreshedTopIndex).not.toBe(initialTopIndex);
    expect(refreshedTopIndex).toContain("Changed by nested group read.");

    const beforeMemberRead = refreshedTopIndex;
    await writeFile(
      memberPath,
      skillDocument("deep-audit", "Changed by nested member read.", "Stable body."),
      "utf8",
    );
    const memberDecision = await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://engineering/database/postgresql/deep-audit/SKILL.md" },
      },
      makeContext(process.cwd()),
    );

    expect(memberDecision).toBeUndefined();
    expect(await readFile(postgresqlIndex, "utf8")).toContain("Changed by nested member read.");
    expect(await readFile(databaseIndex, "utf8")).toContain("Changed by nested member read.");
    expect(await readFile(topIndex, "utf8")).not.toBe(beforeMemberRead);
    expect(await readFile(topIndex, "utf8")).toContain("Changed by nested member read.");
    expect(await readFile(memberPath, "utf8")).toContain("Stable body.");

    const addedPath = childSkillFile(managedRoot, group, "new-runbook");
    await mkdir(join(managedRoot, group, "new-runbook"), { recursive: true });
    await writeFile(addedPath, skillDocument("new-runbook", "New deep procedure.", "New body."));
    await rm(memberPath);
    await handler(
      { type: "tool_call", toolName: "read", input: { path: "skill://engineering/database/postgresql/SKILL.md" } },
      makeContext(process.cwd()),
    );
    const finalIndex = await readFile(postgresqlIndex, "utf8");
    expect(finalIndex).toContain("new-runbook");
    expect(finalIndex).not.toContain("deep-audit");
    expect(await readFile(topIndex, "utf8")).toContain("New deep procedure.");
  });

  test("ranged and multi-path reads refresh every referenced managed group", async () => {
    const root = await makeRoot("auto-learn-scope-selectors-");
    const pi = new FakePi();
    for (const group of ["alpha", "beta"]) {
      await mkdir(join(root, group, "child"), { recursive: true });
      await writeFile(childSkillFile(root, group, "child"), skillDocument("child", "Before edit.", "Body."));
    }
    pi.activeSkills = ["alpha", "beta"].map(name => ({ name, filePath: groupIndexFile(root, name) }));
    await install(pi, root);
    const handler = pi.handlers.get("tool_call")?.[0];
    if (!handler) throw new Error("missing read interception");
    for (const group of ["alpha", "beta"]) {
      await writeFile(childSkillFile(root, group, "child"), skillDocument("child", `Changed ${group}.`, "Body."));
    }
    await handler(
      { type: "tool_call", toolName: "read", input: { path: "skill://alpha/SKILL.md:raw;skill://beta/SKILL.md:1-20" } },
      makeContext(process.cwd()),
    );
    expect(await readFile(groupIndexFile(root, "alpha"), "utf8")).toContain("Changed alpha.");
    expect(await readFile(groupIndexFile(root, "beta"), "utf8")).toContain("Changed beta.");
  });

  test("read refresh uses the calling session skill snapshot rather than the process-global list", async () => {
    const root = await makeRoot("auto-learn-scope-session-");
    const member = childSkillFile(root, "alpha", "child");
    await mkdir(join(root, "alpha", "child"), { recursive: true });
    await writeFile(member, skillDocument("child", "Before edit.", "Body."));
    const pi = new FakePi();
    pi.activeSkills = [{ name: "alpha", filePath: groupIndexFile(root, "alpha") }];
    await install(pi, root);
    registerProcessGlobalSnapshot([]);
    await writeFile(member, skillDocument("child", "Changed in this session.", "Body."));
    const handler = pi.handlers.get("tool_call")?.[0];
    if (!handler) throw new Error("missing read interception");
    const result = await handler(
      { type: "tool_call", toolName: "read", input: { path: "skill://alpha" } },
      makeContext(process.cwd()),
    );
    expect(result).toBeUndefined();
    expect(await readFile(groupIndexFile(root, "alpha"), "utf8")).toContain("Changed in this session.");
  });

  test("managed reads and global creates fail closed without a matching host session registry", async () => {
    const root = await makeRoot("auto-learn-scope-session-guard-");
    await mkdir(join(root, "alpha", "child"), { recursive: true });
    await writeFile(childSkillFile(root, "alpha", "child"), skillDocument("child", "Existing skill.", "Body."));
    const pi = new FakePi();
    pi.activeSkills = [{ name: "alpha", filePath: groupIndexFile(root, "alpha") }];
    await install(pi, root);
    registerProcessGlobalSnapshot([]);
    const handler = pi.handlers.get("tool_call")?.[0];
    if (!handler) throw new Error("missing read interception");
    const readEvent = { type: "tool_call", toolName: "read", input: { path: "skill://alpha" } };
    const createTool = findTool(pi, "manage_skill");
    const createParams = {
      scope: "global",
      group: "alpha",
      action: "create",
      name: "new-skill",
      description: "A new skill.",
      body: "Body.",
    };

    for (const sessionState of ["missing-registry", "mismatched-session", "mismatched-agent"] as const) {
      if (sessionState === "missing-registry") {
        pi.pi.AgentRegistry = undefined;
      } else {
        pi.pi.AgentRegistry = { global: () => pi.registry };
        pi.sessionId = sessionState === "mismatched-session" ? "different-session" : "test-session";
      }
      const context = makeContext(process.cwd());
      if (sessionState === "mismatched-agent") {
        context.agent = { id: "different-agent" };
      }
      const readResult = await handler(readEvent, context);
      expect(readResult).toMatchObject({
        block: true,
        reason: expect.stringMatching(/current-session skills are unavailable/i),
      });
      await expect(executeTool(createTool, createParams, context)).rejects.toThrow(
        /current-session skills are unavailable/i,
      );
    }
  });

  test("a group index blocked by an active child namespace leaves direct namespace reads available", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const namespaceRoot = await makeRoot("auto-learn-scope-namespace-");
    const namespaceSkillPath = join(namespaceRoot, "SKILL.md");
    await mkdir(join(managedRoot, "engineering", "database", "schema-audit"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "engineering/database", "schema-audit"),
      skillDocument("schema-audit", "Inspect schema changes.", "Group member body."),
      "utf8",
    );
    const namespaceSkillText = skillDocument("database", "A namespaced ordinary skill.", "Namespace body.");
    await writeFile(namespaceSkillPath, namespaceSkillText, "utf8");
    const topIndex = groupIndexFile(managedRoot, "engineering");
    const pi = new FakePi();
    pi.activeSkills = [
      { name: "engineering", filePath: topIndex },
      { name: "engineering/database", filePath: namespaceSkillPath },
    ];
    await install(pi, managedRoot);
    const handler = pi.handlers.get("tool_call")?.find(candidate => candidate.length >= 1);
    if (!handler) throw new Error("extension must register a tool_call handler for namespace shadow checks");

    const blocked = await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://engineering/SKILL.md" },
      },
      makeContext(process.cwd()),
    ) as UnknownRecord;

    expect(blocked.block).toBe(true);
    expect(blocked.reason).toMatch(/engineering\/database|namespace|shadow|conflict/i);
    for (const path of [
      "skill://engineering:raw",
      "skill://engineering/SKILL.md:1-20",
      "skill://engineering/SKILL.md#section",
      "ordinary.txt;skill://engineering/SKILL.md:raw",
    ]) {
      const decision = await handler(
        { type: "tool_call", toolName: "read", input: { path } },
        makeContext(process.cwd()),
      ) as UnknownRecord;
      expect(decision.block).toBe(true);
    }
    expect(await readFile(namespaceSkillPath, "utf8")).toBe(namespaceSkillText);

    const directNamespaceRead = await handler(
      {
        type: "tool_call",
        toolName: "read",
        input: { path: "skill://engineering/database/SKILL.md" },
      },
      makeContext(process.cwd()),
    );

    expect(directNamespaceRead).toBeUndefined();
    expect(await readFile(namespaceSkillPath, "utf8")).toBe(namespaceSkillText);
  });


  test("automatic summaries follow description changes but not body-only updates or deletion", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const pi = new FakePi();
    const server = await startSummaryServer([
      { text: "Create-trigger summary: incident response, ownership, and escalation." },
      { text: "Updated summary: database recovery and operational escalation." },
    ]);
    const runtime = summaryRuntime(makeSummaryModel(server.baseUrl));
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    await install(pi, managedRoot);
    try {
      const createResult = await executeTool(findTool(pi, "manage_skill"), {
        scope: "global",
        group: "operations",
        action: "create",
        name: "incident-triage",
        description: "CREATE_TRIGGER_DESCRIPTION",
        body: "PRIVATE_CREATE_MEMBER_BODY.",
      }, ctx);
      const indexPath = groupIndexFile(managedRoot, "operations");
      const generatedIndex = await waitForFileText(
        indexPath,
        "Create-trigger summary: incident response, ownership, and escalation.",
      );
      expect(frontmatter(generatedIndex).description).toBe(
        "Create-trigger summary: incident response, ownership, and escalation.",
      );
      expect(outcomeText(createResult)).toMatch(/summary|queued|pending/i);
      expect(server.requests[0]?.path).toBe("/v1/chat/completions");
      expect(server.requests[0]?.body).toContain("CREATE_TRIGGER_DESCRIPTION");
      expect(server.requests[0]?.body).not.toContain("PRIVATE_CREATE_MEMBER_BODY.");

      const requestCountAfterCreate = server.requests.length;
      const roleCountAfterCreate = runtime.resolvedRoles.length;
      await executeTool(findTool(pi, "manage_skill"), {
        group: "operations",
        action: "update",
        name: "incident-triage",
        description: "CREATE_TRIGGER_DESCRIPTION",
        body: "PRIVATE_UPDATED_MEMBER_BODY.",
      }, ctx);
      expect(server.requests).toHaveLength(requestCountAfterCreate);
      expect(runtime.resolvedRoles).toHaveLength(roleCountAfterCreate);
      await executeTool(findTool(pi, "manage_skill"), {
        group: "operations",
        action: "update",
        name: "incident-triage",
        description: "UPDATED_TRIGGER_DESCRIPTION",
        body: "PRIVATE_UPDATED_MEMBER_BODY.",
      }, ctx);
      const updatedIndex = await waitForFileText(
        indexPath,
        "Updated summary: database recovery and operational escalation.",
      );
      expect(frontmatter(updatedIndex).description).toBe(
        "Updated summary: database recovery and operational escalation.",
      );
      const requestCountAfterUpdate = server.requests.length;
      await executeTool(findTool(pi, "manage_skill"), {
        group: "operations",
        action: "delete",
        name: "incident-triage",
      }, ctx);

      expect(server.requests).toHaveLength(requestCountAfterUpdate);
      expect(server.requests.every(request => !request.body.includes("PRIVATE_UPDATED_MEMBER_BODY."))).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("a same-session create during an in-flight summary is generated without another session", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const pi = new FakePi();
    const releaseFirst = Promise.withResolvers<void>();
    const server = await startSummaryServer([
      {
        text: "First summary: incident ownership, escalation, and recovery.",
        release: releaseFirst.promise,
      },
      { text: "Second summary: change review, rollout safety, and rollback." },
    ]);
    const runtime = summaryRuntime(makeSummaryModel(server.baseUrl));
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    await install(pi, managedRoot);
    try {
      const firstCreate = executeTool(findTool(pi, "manage_skill"), {
        scope: "global",
        group: "operations",
        action: "create",
        name: "incident-triage",
        description: "FIRST_CONCURRENT_DESCRIPTION",
        body: "PRIVATE_FIRST_CONCURRENT_BODY.",
      }, ctx);
      await server.untilRequests(1);
      const secondCreate = await executeTool(findTool(pi, "manage_skill"), {
        scope: "global",
        group: "operations",
        action: "create",
        name: "change-review",
        description: "SECOND_CONCURRENT_DESCRIPTION",
        body: "PRIVATE_SECOND_CONCURRENT_BODY.",
      }, ctx);
      releaseFirst.resolve();
      await firstCreate;

      const indexText = await waitForFileText(
        groupIndexFile(managedRoot, "operations"),
        "Second summary: change review, rollout safety, and rollback.",
      );
      expect(frontmatter(indexText).description).toBe(
        "Second summary: change review, rollout safety, and rollback.",
      );
      expect(outcomeText(secondCreate)).toMatch(/summary|queued|pending/i);
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
      ]);
      expect(server.requests[0]?.body).toContain("FIRST_CONCURRENT_DESCRIPTION");
      expect(server.requests[1]?.body).toContain("SECOND_CONCURRENT_DESCRIPTION");
      expect(server.requests.every(request => !request.body.includes("PRIVATE_FIRST_CONCURRENT_BODY."))).toBe(true);
      expect(server.requests.every(request => !request.body.includes("PRIVATE_SECOND_CONCURRENT_BODY."))).toBe(true);
    } finally {
      releaseFirst.resolve();
      await server.close();
    }
  });

  test("manual refresh judges and regenerates every nested group bottom-up without reloading plugins", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const fixtures = [
      {
        group: "company",
        skill: "overview",
        description: "COMPANY_TRIGGER_DESCRIPTION",
        body: "PRIVATE_COMPANY_MEMBER_BODY.",
        seed: "Seed company summary: system ownership, customer workflows, and priorities.",
        summary: "Company summary: system ownership, customer workflows, and operational priorities.",
      },
      {
        group: "company/platform",
        skill: "runtime",
        description: "PLATFORM_TRIGGER_DESCRIPTION",
        body: "PRIVATE_PLATFORM_MEMBER_BODY.",
        seed: "Seed platform summary: deployments, runtime configuration, and database integration.",
        summary: "Platform summary: deployments, runtime configuration, and database integration.",
      },
      {
        group: "company/platform/database",
        skill: "schema-safety",
        description: "DATABASE_TRIGGER_DESCRIPTION",
        body: "PRIVATE_DATABASE_MEMBER_BODY.",
        seed: "Seed database summary: migrations, index safety, and rollback behavior.",
        summary: "Database summary: schema migrations, index safety, and rollback behavior.",
      },
    ] as const;
    for (const fixture of fixtures) {
      await mkdir(join(managedRoot, fixture.group, fixture.skill), { recursive: true });
      await writeFile(
        childSkillFile(managedRoot, fixture.group, fixture.skill),
        skillDocument(fixture.skill, fixture.description, fixture.body),
        "utf8",
      );
    }
    const pi = new FakePi();
    const server = await startSummaryServer([
      { text: fixtures[2].seed },
      { text: fixtures[1].seed },
      { text: fixtures[0].seed },
      { judgeProbability: 0.5 },
      { text: fixtures[2].summary },
      { judgeProbability: 0.5 },
      { text: fixtures[1].summary },
      { judgeProbability: 0.5 },
      { text: fixtures[0].summary },
    ]);
    const summaryModel = makeSummaryModel(server.baseUrl);
    const judgeModel = makeJudgeModel(server.rootUrl);
    const runtime = summaryRuntime(summaryModel, undefined, [judgeModel, summaryModel]);
    const judgeSettings = configureJudgeRole(pi);
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    await install(pi, managedRoot);
    try {
      const inputHandler = pi.handlers.get("input")?.[0];
      const inputResult = inputHandler
        ? await inputHandler({ type: "input", text: "/refresh-managed-skills" }, ctx)
        : undefined;
      expect(inputResult).toBeUndefined();

      const command = pi.commands.get("refresh-managed-skills");
      if (!command) throw new Error("extension must register /refresh-managed-skills");
      await command("--force", ctx);
      for (const fixture of fixtures) {
        const seedIndex = await waitForFileText(groupIndexFile(managedRoot, fixture.group), fixture.seed);
        expect(frontmatter(seedIndex).description).toBe(fixture.seed);
      }
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
        "/v1/chat/completions",
      ]);

      const messageStart = pi.messages.length;
      await withActiveSettings(judgeSettings, () => command("", ctx));
      const visibleResults = runtime.notifications.join("\n");
      const visibleMessages = pi.messages.slice(messageStart);
      for (const fixture of fixtures) {
        const indexText = await waitForFileText(groupIndexFile(managedRoot, fixture.group), fixture.summary);
        expect(frontmatter(indexText).description).toBe(fixture.summary);
        expect(fixture.summary.length).toBeLessThanOrEqual(200);
        const groupResult = visibleResults.split(/\r?\n/).find(line => line.includes(fixture.group));
        expect(groupResult).toBeDefined();
        expect(groupResult).toMatch(/generated|success|written|complete/i);
        const messageResult = visibleMessages.find(message => message.content.includes(fixture.group));
        expect(messageResult?.content).toMatch(/summary generated/i);
        expect(messageResult).toMatchObject({
          customType: "auto-learn-scope:managed-skill-summary",
          display: true,
          triggerTurn: false,
        });
      }
      expect(inputResult).toBeUndefined();
      expect(JSON.stringify(inputResult ?? "")).not.toContain("/reload-plugins");
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
        "/v1/chat/completions",
        "/v1/systemone",
        "/v1/chat/completions",
        "/v1/systemone",
        "/v1/chat/completions",
        "/v1/systemone",
        "/v1/chat/completions",
      ]);
      expect(server.requests[0]?.body).toContain("DATABASE_TRIGGER_DESCRIPTION");
      expect(server.requests[4]?.body).toContain("DATABASE_TRIGGER_DESCRIPTION");
      expect(server.requests[6]?.body).toContain("PLATFORM_TRIGGER_DESCRIPTION");
      expect(server.requests[6]?.body).toContain(fixtures[2].summary);
      expect(server.requests[8]?.body).toContain("COMPANY_TRIGGER_DESCRIPTION");
      expect(server.requests[8]?.body).toContain(fixtures[1].summary);
      expect(server.requests.flatMap(request => request.body).join("\n")).not.toMatch(
        /PRIVATE_(?:COMPANY|PLATFORM|DATABASE)_MEMBER_BODY\./,
      );
      expect(runtime.resolvedRoles).toEqual(["@smol", "@smol", "@smol", "@smol", "@smol", "@smol"]);
      expect(runtime.credentialSessions).toContain("test-session");
    } finally {
      await server.close();
    }
  });

  test("manual refresh and invalid arguments report visible results without a UI", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "release-engineering", "rollback-guide"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "release-engineering", "rollback-guide"),
      skillDocument("rollback-guide", "ROLLBACK_TRIGGER_DESCRIPTION", "PRIVATE_ROLLBACK_MEMBER_BODY."),
      "utf8",
    );
    const pi = new FakePi();
    const server = await startSummaryServer([
      { text: "Rollback summary: deployment verification, safe reversions, and recovery ownership." },
    ]);
    const runtime = summaryRuntime(makeSummaryModel(server.baseUrl));
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    ctx.hasUI = false;
    ctx.ui = {};
    await install(pi, managedRoot);
    const command = pi.commands.get("refresh-managed-skills");
    if (!command) throw new Error("extension must register /refresh-managed-skills");
    try {
      const invalidResult = await command("unexpected", ctx);
      expect(invalidResult).toBeUndefined();
      expect(pi.messages.map(message => message.content).join("\n")).toContain(
        "Usage: /refresh-managed-skills [--force]",
      );

      const refreshResult = await command("--force", ctx);
      const indexText = await waitForFileText(
        groupIndexFile(managedRoot, "release-engineering"),
        "Rollback summary: deployment verification, safe reversions, and recovery ownership.",
      );
      expect(refreshResult).toBeUndefined();
      expect(frontmatter(indexText).description).toBe(
        "Rollback summary: deployment verification, safe reversions, and recovery ownership.",
      );
      const summaryMessage = pi.messages.find(message => message.content.includes("release-engineering"));
      expect(summaryMessage?.content).toMatch(/summary generated/i);
      expect(summaryMessage).toMatchObject({
        customType: "auto-learn-scope:managed-skill-summary",
        display: true,
        triggerTurn: false,
      });
      expect(runtime.notifications).toHaveLength(0);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.body).not.toContain("PRIVATE_ROLLBACK_MEMBER_BODY.");
    } finally {
      await server.close();
    }
  });


  test("manual generation failure keeps the last summary and reports the failing group", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "reliability", "recovery"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "reliability", "recovery"),
      skillDocument("recovery", "RECOVERY_TRIGGER_DESCRIPTION", "PRIVATE_RECOVERY_MEMBER_BODY."),
      "utf8",
    );
    const pi = new FakePi();
    const server = await startSummaryServer([
      { text: "Stable recovery summary: restoration, verification, and service continuity." },
      { error: "fixture generation provider unavailable" },
    ]);
    const runtime = summaryRuntime(makeSummaryModel(server.baseUrl));
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    await install(pi, managedRoot);
    try {
      const command = pi.commands.get("refresh-managed-skills");
      if (!command) throw new Error("extension must register /refresh-managed-skills");
      await command("--force", ctx);
      const indexPath = groupIndexFile(managedRoot, "reliability");
      await waitForFileText(indexPath, "Stable recovery summary: restoration, verification, and service continuity.");

      await command("--force", ctx);
      const visibleResults = runtime.notifications.join("\n");
      const currentIndex = await readFile(indexPath, "utf8");
      expect(frontmatter(currentIndex).description).toBe(
        "Stable recovery summary: restoration, verification, and service continuity.",
      );
      expect(visibleResults).toMatch(/reliability/i);
      expect(visibleResults).toMatch(/failed|unavailable|error/i);
      expect(visibleResults).toContain("fixture generation provider unavailable");
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
      ]);
      expect(server.requests.every(request => !request.body.includes("PRIVATE_RECOVERY_MEMBER_BODY."))).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("judge skips only high-confidence coverage and force bypasses the host judge", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "judge-group", "connection-guide"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "judge-group", "connection-guide"),
      skillDocument("connection-guide", "JUDGE_INPUT_DESCRIPTION", "PRIVATE_JUDGE_MEMBER_BODY."),
      "utf8",
    );
    const pi = new FakePi();
    const server = await startSummaryServer([
      { text: "Seed summary: migrations, connection recovery, and rollback checks." },
      { judgeProbability: 0.97 },
      { text: "Forced summary: throughput, migration safety, and connection recovery." },
    ]);
    const summaryModel = makeSummaryModel(server.baseUrl);
    const judgeModel = makeJudgeModel(server.rootUrl);
    const runtime = summaryRuntime(summaryModel, undefined, [judgeModel, summaryModel]);
    const judgeSettings = configureJudgeRole(pi);
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    await install(pi, managedRoot);
    try {
      const command = pi.commands.get("refresh-managed-skills");
      if (!command) throw new Error("extension must register /refresh-managed-skills");
      await command("--force", ctx);
      const indexPath = groupIndexFile(managedRoot, "judge-group");
      await waitForFileText(indexPath, "Seed summary: migrations, connection recovery, and rollback checks.");

      await withActiveSettings(judgeSettings, () => command("", ctx));
      const afterJudge = await readFile(indexPath, "utf8");
      const visibleSkip = runtime.notifications.join("\n");
      expect(frontmatter(afterJudge).description).toBe(
        "Seed summary: migrations, connection recovery, and rollback checks.",
      );
      expect(visibleSkip).toMatch(/judge-group/i);
      expect(visibleSkip).toMatch(/skip|covered|覆盖/i);
      expect(visibleSkip).toContain("typesafe");
      expect(visibleSkip).toContain("jev-1.14.0");
      expect(visibleSkip).toContain("0.970");
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/systemone",
      ]);
      const judgeRequest = server.requests[1];
      if (!judgeRequest) throw new Error("manual non-force refresh must call the host judge");
      expect(judgeRequest.authorization).toBe("Bearer fixture-model-api-key");
      expect(judgeRequest.body).toContain("judge-group");
      expect(judgeRequest.body).toContain("Seed summary: migrations, connection recovery, and rollback checks.");
      expect(judgeRequest.body).toContain("connection-guide");
      expect(judgeRequest.body).toContain("JUDGE_INPUT_DESCRIPTION");
      expect(judgeRequest.body).not.toContain("PRIVATE_JUDGE_MEMBER_BODY.");

      await command("--force", ctx);
      const afterForce = await waitForFileText(indexPath, "Forced summary: throughput, migration safety, and connection recovery.");
      expect(frontmatter(afterForce).description).toBe(
        "Forced summary: throughput, migration safety, and connection recovery.",
      );
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/systemone",
        "/v1/chat/completions",
      ]);
      expect(runtime.resolvedRoles).toEqual(["@smol", "@smol"]);
      expect(runtime.credentialSessions).toContain("test-session");
    } finally {
      await server.close();
    }
  });

  test("online judge yes is not calibrated coverage and active session settings select the judge", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "operations", "incident-guide"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "operations", "incident-guide"),
      skillDocument("incident-guide", "INCIDENT_TRIGGER_DESCRIPTION", "PRIVATE_INCIDENT_MEMBER_BODY."),
      "utf8",
    );
    const pi = new FakePi();
    const server = await startSummaryServer([
      { text: "Seed summary: incident escalation, ownership, and containment." },
      { text: "yes" },
      { text: "Refreshed summary: incident escalation, ownership, and service recovery." },
    ]);
    const summaryModel = makeSummaryModel(server.baseUrl);
    const judgeModel = makeJudgeModel(server.rootUrl);
    const runtime = summaryRuntime(summaryModel, undefined, [judgeModel, summaryModel]);
    const staleSettings = configureJudgeRole(pi);
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    await install(pi, managedRoot);
    try {
      const command = pi.commands.get("refresh-managed-skills");
      if (!command) throw new Error("extension must register /refresh-managed-skills");
      await command("--force", ctx);
      const indexPath = groupIndexFile(managedRoot, "operations");
      await waitForFileText(indexPath, "Seed summary: incident escalation, ownership, and containment.");

      const notificationStart = runtime.notifications.length;
      const sessionSettings = Settings.isolated({
        modelRoles: { judge: "openai/auto-learn-summary-fixture" },
      });
      pi.sessionSettings = sessionSettings;
      await withActiveSettings(staleSettings, () => command("", ctx));

      const refreshed = await waitForFileText(
        indexPath,
        "Refreshed summary: incident escalation, ownership, and service recovery.",
      );
      expect(frontmatter(refreshed).description).toBe(
        "Refreshed summary: incident escalation, ownership, and service recovery.",
      );
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
        "/v1/chat/completions",
      ]);
      const report = runtime.notifications.slice(notificationStart).join("\n");
      expect(report).toContain("openai/auto-learn-summary-fixture");
      expect(report).toContain("noul=1.000");
      expect(report).toMatch(/non-native|binary verdict|not a calibrated probability/i);
      expect(report).toMatch(/generating|generated/i);
      expect(server.requests[1]?.body).toContain("INCIDENT_TRIGGER_DESCRIPTION");
      expect(server.requests[1]?.body).not.toContain("PRIVATE_INCIDENT_MEMBER_BODY.");
    } finally {
      await server.close();
    }
  });

  test("a bounded judge request timeout reports the failure and continues generation", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "reliability", "timeout-guide"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "reliability", "timeout-guide"),
      skillDocument("timeout-guide", "TIMEOUT_TRIGGER_DESCRIPTION", "PRIVATE_TIMEOUT_MEMBER_BODY."),
      "utf8",
    );
    const releaseJudge = Promise.withResolvers<void>();
    const delayedRelease = setTimeout(() => releaseJudge.resolve(), 1_000);
    const pi = new FakePi();
    const server = await startSummaryServer([
      { text: "Seed summary: recovery verification, service restoration, and ownership." },
      { text: "yes", release: releaseJudge.promise },
      { text: "Recovered summary: recovery verification, restoration, and escalation ownership." },
    ]);
    const summaryModel = makeSummaryModel(server.baseUrl);
    const judgeModel = makeJudgeModel(server.rootUrl);
    const runtime = summaryRuntime(summaryModel, undefined, [judgeModel, summaryModel]);
    configureJudgeRole(pi);
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    await install(pi, managedRoot);
    try {
      const command = pi.commands.get("refresh-managed-skills");
      if (!command) throw new Error("extension must register /refresh-managed-skills");
      await command("--force", ctx);
      const indexPath = groupIndexFile(managedRoot, "reliability");
      await waitForFileText(indexPath, "Seed summary: recovery verification, service restoration, and ownership.");

      const notificationStart = runtime.notifications.length;
      const sessionSettings = Settings.isolated({
        modelRoles: { judge: "openai/auto-learn-summary-fixture" },
        "judgment.attemptTimeoutMs": 300,
      });
      pi.sessionSettings = sessionSettings;
      await command("", ctx);
      releaseJudge.resolve();

      const refreshed = await waitForFileText(
        indexPath,
        "Recovered summary: recovery verification, restoration, and escalation ownership.",
      );
      expect(frontmatter(refreshed).description).toBe(
        "Recovered summary: recovery verification, restoration, and escalation ownership.",
      );
      const report = runtime.notifications.slice(notificationStart).join("\n");
      expect(report).toMatch(/judge unavailable or failed/i);
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
        "/v1/chat/completions",
      ]);
      expect(server.requests.every(request => !request.body.includes("PRIVATE_TIMEOUT_MEMBER_BODY."))).toBe(true);
    } finally {
      clearTimeout(delayedRelease);
      releaseJudge.resolve();
      await server.close();
    }
  });

  test("low-confidence and failed judge results report and continue with generation", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    await mkdir(join(managedRoot, "coverage-group", "retention"), { recursive: true });
    await writeFile(
      childSkillFile(managedRoot, "coverage-group", "retention"),
      skillDocument("retention", "JUDGE_FALLBACK_DESCRIPTION", "PRIVATE_JUDGE_FALLBACK_BODY."),
      "utf8",
    );
    const pi = new FakePi();
    const server = await startSummaryServer([
      { text: "Seed coverage summary: archival policy and recovery windows." },
      { judgeProbability: 0.94 },
      { text: "Low-confidence refresh: archival policy, deletion holds, and restoration windows." },
      { error: "fixture judge provider unavailable" },
      { text: "Judge-failure refresh: archival policy, deletion holds, and recovery." },
    ]);
    const summaryModel = makeSummaryModel(server.baseUrl);
    const judgeModel = makeJudgeModel(server.rootUrl);
    const runtime = summaryRuntime(summaryModel, undefined, [judgeModel, summaryModel]);
    const judgeSettings = configureJudgeRole(pi);
    const ctx = makeContext(process.cwd(), undefined, undefined, runtime);
    await install(pi, managedRoot);
    try {
      const command = pi.commands.get("refresh-managed-skills");
      if (!command) throw new Error("extension must register /refresh-managed-skills");
      await command("--force", ctx);
      const indexPath = groupIndexFile(managedRoot, "coverage-group");
      await waitForFileText(indexPath, "Seed coverage summary: archival policy and recovery windows.");

      await withActiveSettings(judgeSettings, () => command("", ctx));
      const afterLowConfidence = await waitForFileText(
        indexPath,
        "Low-confidence refresh: archival policy, deletion holds, and restoration windows.",
      );
      expect(frontmatter(afterLowConfidence).description).toBe(
        "Low-confidence refresh: archival policy, deletion holds, and restoration windows.",
      );
      const visibleLowConfidence = runtime.notifications.join("\n");
      expect(visibleLowConfidence).toMatch(/0\.94|confidence|uncertain/i);

      const judgeFailureStart = runtime.notifications.length;
      await withActiveSettings(judgeSettings, () => command("", ctx));
      const afterJudgeFailure = await waitForFileText(
        indexPath,
        "Judge-failure refresh: archival policy, deletion holds, and recovery.",
      );
      expect(frontmatter(afterJudgeFailure).description).toBe(
        "Judge-failure refresh: archival policy, deletion holds, and recovery.",
      );
      const visibleJudgeFailure = runtime.notifications.slice(judgeFailureStart).join("\n");
      expect(visibleJudgeFailure).toContain("fixture judge provider unavailable");
      expect(visibleJudgeFailure).toMatch(/judge|failed|unavailable/i);
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/systemone",
        "/v1/chat/completions",
        "/v1/systemone",
        "/v1/chat/completions",
      ]);
      expect(server.requests.every(request => !request.body.includes("PRIVATE_JUDGE_FALLBACK_BODY."))).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("failed automatic summary work is recovered on the next session start", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-group-");
    const firstPi = new FakePi();
    const server = await startSummaryServer([
      { error: "fixture automatic summary failure" },
      { text: "Recovered summary: escalation ownership, diagnostics, and remediation." },
    ]);
    const model = makeSummaryModel(server.baseUrl);
    const runtime = summaryRuntime(model);
    await install(firstPi, managedRoot);
    try {
      const createResult = await executeTool(findTool(firstPi, "manage_skill"), {
        scope: "global",
        group: "service-operations",
        action: "create",
        name: "diagnostics",
        description: "RECOVERY_TRIGGER_DESCRIPTION",
        body: "PRIVATE_RECOVERY_PENDING_BODY.",
      }, makeContext(process.cwd(), undefined, undefined, runtime));
      const failureNotice = await waitForNotification(runtime, "fixture automatic summary failure");
      expect(failureNotice).toContain("service-operations");
      expect(outcomeText(createResult)).toMatch(/summary|queued|pending/i);

      const nextPi = new FakePi();
      await install(nextPi, managedRoot);
      const sessionStart = nextPi.handlers.get("session_start")?.[0];
      if (!sessionStart) throw new Error("extension must recover durable automatic summary work at session_start");
      await sessionStart(
        { type: "session_start" },
        makeContext(process.cwd(), undefined, undefined, runtime),
      );

      const recoveredIndex = await waitForFileText(
        groupIndexFile(managedRoot, "service-operations"),
        "Recovered summary: escalation ownership, diagnostics, and remediation.",
      );
      expect(frontmatter(recoveredIndex).description).toBe(
        "Recovered summary: escalation ownership, diagnostics, and remediation.",
      );
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
      ]);
      expect(server.requests.every(request => !request.body.includes("PRIVATE_RECOVERY_PENDING_BODY."))).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("a session switch recovers failed manual work in the same extension instance", async () => {
    const managedRoot = await makeRoot("auto-learn-scope-session-switch-");
    const store = createManagedGroupStore(managedRoot);
    store.mutate({
      group: "session-recovery",
      action: "create",
      name: "diagnostics",
      description: "SESSION_RECOVERY_TRIGGER_DESCRIPTION",
      body: "PRIVATE_SESSION_RECOVERY_BODY.",
    });

    const pi = new FakePi();
    const server = await startSummaryServer([
      { error: "fixture manual summary failure" },
      { text: "Recovered summary: operational diagnostics, escalation ownership, and remediation." },
    ]);
    const runtime = summaryRuntime(makeSummaryModel(server.baseUrl));
    await install(pi, managedRoot);
    try {
      const command = pi.commands.get("refresh-managed-skills");
      if (!command) throw new Error("extension must register /refresh-managed-skills");
      await command("--force", makeContext(process.cwd(), undefined, undefined, runtime));
      expect(pi.messages.some(message => message.content.includes("fixture manual summary failure"))).toBe(true);

      const sessionSwitch = pi.handlers.get("session_switch")?.[0];
      if (!sessionSwitch) throw new Error("extension must recover failed manual work after session_switch");
      await sessionSwitch(
        { type: "session_switch", reason: "new", previousSessionFile: "/tmp/previous-session.jsonl" },
        makeContext(process.cwd(), undefined, undefined, runtime),
      );

      const recoveredIndex = await waitForFileText(
        groupIndexFile(managedRoot, "session-recovery"),
        "Recovered summary: operational diagnostics, escalation ownership, and remediation.",
      );
      expect(frontmatter(recoveredIndex).description).toBe(
        "Recovered summary: operational diagnostics, escalation ownership, and remediation.",
      );
      expect(server.requests.map(request => request.path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
      ]);
      expect(server.requests.every(request => !request.body.includes("PRIVATE_SESSION_RECOVERY_BODY."))).toBe(true);
    } finally {
      await server.close();
    }
  });

});
