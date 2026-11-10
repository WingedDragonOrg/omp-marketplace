import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ExtensionRuntime, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { registerOctoTools } from "../src/index.ts";
import { z } from "@oh-my-pi/pi-coding-agent";

type UnknownRecord = Record<string, unknown>;
type OctoDocument = {
  id: string;
  type: "doc" | "html";
  text: string;
  version: string | number;
  [key: string]: unknown;
};
type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [key: string]: unknown;
};
type ToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
  readsSkillUris?: boolean;
  customFormat?: { syntax: string; definition: string };
  approvalCacheTargets?: (args: unknown) => string[] | undefined;
  approval?: string | ((args: unknown) => string);
  execute?: (
    toolCallId: string,
    params: UnknownRecord,
    signal?: AbortSignal,
    onUpdate?: (...args: unknown[]) => void,
    context?: UnknownRecord,
  ) => Promise<ToolResult>;
};
type Backend = {
  readDocument(id: string): Promise<OctoDocument>;
  writeDocument(document: OctoDocument, text: string): Promise<OctoDocument>;
};



const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

function makeHarness(backend: Backend) {
  const tools = new Map<string, ToolDefinition>();
  const zod = {
    object: (shape: UnknownRecord) => ({ kind: "object", shape }),
    string: () => ({
      kind: "string",
      optional: () => ({ kind: "optional", inner: { kind: "string" } }),
    }),
    boolean: () => ({
      kind: "boolean",
      optional: () => ({ kind: "optional", inner: { kind: "boolean" } }),
    }),
    enum: (values: string[]) => ({
      kind: "enum",
      values,
      optional: () => ({ kind: "optional", inner: { kind: "enum", values } }),
    }),
    array: (element: unknown) => ({ kind: "array", element }),
    union: (options: unknown[]) => ({ kind: "union", options }),
  };
  const nativeTools = [
    {
      name: "read",
      description: "Native read supports Archives, SQLite, and PDF.",
      parameters: zod.object({ path: zod.string() }),
      sourceInfo: { source: "builtin" },
    },
    {
      name: "write",
      description: "Native write supports xd:// and proc://<id>/kill.",
      parameters: zod.object({
        path: zod.string(),
        content: zod.string().optional(),
      }),
      sourceInfo: { source: "builtin" },
    },
    {
      name: "edit",
      description: "Native edit hashline mode.",
      parameters: zod.object({ input: zod.string() }),
      sourceInfo: { source: "builtin" },
    },
  ];
  const api = {
    zod,
    getAllTools: () => nativeTools,
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
  };

  cleanups.push(registerOctoTools(api as never, backend));
  return tools;
}

test("OMP extension loader registers native-schema wrappers and preserves local delegation", async () => {
  const nativeTools = [
    {
      name: "read",
      description: "Native read description.",
      parameters: z.object({ path: z.string() }),
      sourceInfo: { source: "builtin" },
    },
    {
      name: "write",
      description: "Native write description.",
      parameters: z.object({ path: z.string(), content: z.string() }),
      sourceInfo: { source: "builtin" },
    },
    {
      name: "edit",
      description: "Native hashline edit description.",
      parameters: z.object({ input: z.string() }),
      sourceInfo: { source: "builtin" },
    },
  ];
  const runtime = new ExtensionRuntime();
  runtime.getAllTools = () => nativeTools as never;

  const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const loaded = await loadExtensions([extensionPath], process.cwd(), undefined, runtime);
  expect(loaded.errors).toEqual([]);
  const extension = loaded.extensions[0];
  expect(extension).toBeDefined();
  const sessionStart = extension!.handlers.get("session_start")?.[0];
  expect(sessionStart).toBeDefined();
  await sessionStart!({ type: "session_start" }, { cwd: process.cwd() } as never);

  const read = extension!.tools.get("read")?.definition as unknown as ToolDefinition | undefined;
  expect(read).toBeDefined();
  expect(read?.parameters).toBe(nativeTools[0]!.parameters);
  expect(read?.description).toContain(nativeTools[0]!.description);

  const calls: UnknownRecord[] = [];
  const result = await execute(read, { path: "README.md:2-4" }, {
    invokeTool: async (params: UnknownRecord) => {
      calls.push(params);
      return { content: [{ type: "text", text: "native read completed" }] };
    },
  });
  expect(textOf(result)).toBe("native read completed");
  expect(calls).toEqual([{ path: "README.md:2-4" }]);
});


function textOf(result: ToolResult): string {
  return result.content
    .filter((block): block is { type: string; text: string } => typeof block.text === "string")
    .map(block => block.text)
    .join("\n");
}

function createBackend(initialText = "alpha\nbeta\ngamma\ndelta\n") {
  let current: OctoDocument = {
    id: "d_guide",
    type: "doc",
    text: initialText,
    version: "base-v1",
    title: "Guide",
  };
  const reads: string[] = [];
  const writes: Array<{ id: string; version: string | number; text: string }> = [];
  let writeError: Error | undefined;

  const backend: Backend = {
    async readDocument(id) {
      reads.push(id);
      if (id !== current.id) throw new Error(`unknown fixture document ${id}`);
      return { ...current };
    },
    async writeDocument(document, text) {
      writes.push({ id: document.id, version: document.version, text });
      if (writeError) throw writeError;
      if (document.version !== current.version) {
        throw new Error(`version conflict: expected ${document.version}, current ${current.version}`);
      }
      current = { ...current, text, version: "base-v2" };
      return { ...current };
    },
  };

  return {
    backend,
    reads,
    writes,
    current: () => ({ ...current }),
    setCurrent(document: OctoDocument) {
      current = { ...document };
    },
    failWrites(error: Error) {
      writeError = error;
    },
  };
}

async function execute(
  tool: ToolDefinition | undefined,
  params: UnknownRecord,
  context: UnknownRecord = {},
  signal?: AbortSignal,
  onUpdate?: (...args: unknown[]) => void,
): Promise<ToolResult> {
  expect(typeof tool?.execute, "registered tool must have an executable boundary").toBe("function");
  return tool!.execute!("octo-tool-test", params, signal, onUpdate, context);
}

function approvalOf(tool: ToolDefinition | undefined, args: UnknownRecord): string | undefined {
  if (typeof tool?.approval === "function") return tool.approval(args);
  return tool?.approval;
}

test("read ranges create native hashline snapshots and edit enforces seen-line anchors", async () => {
  const fixture = createBackend();
  const tools = await makeHarness(fixture.backend);
  const read = tools.get("read");
  const edit = tools.get("edit");
  expect(read).toBeDefined();
  expect(read?.readsSkillUris).toBe(true);
  expect(edit?.customFormat).toBeUndefined();

  const ranged = await execute(read, { path: "octo://d_guide:2-3" });
  const displayed = textOf(ranged);
  expect(displayed).toMatch(/(?:^|\n)2:\s*beta(?:\n|$)/);
  expect(displayed).toMatch(/(?:^|\n)3:\s*gamma(?:\n|$)/);
  expect(displayed).not.toMatch(/(?:^|\n)1:\s*alpha(?:\n|$)/);
  expect(displayed).not.toMatch(/(?:^|\n)4:\s*delta(?:\n|$)/);

  const tag = displayed.match(/\[octo:\/\/d_guide#([0-9a-f]{4})\]/i)?.[1];
  expect(tag, "read must expose the snapshot tag used by native hashline edits").toBeDefined();

  const unseen = await execute(edit, {
    input: `*** Begin Patch\n[octo://d_guide#${tag}]\nPUT 1.=1:\n+changed unseen line\n*** End Patch`,
  });
  expect(unseen.isError).toBe(true);
  expect(fixture.writes).toHaveLength(0);

  const seen = await execute(edit, {
    input: `*** Begin Patch\n[octo://d_guide#${tag}]\nPUT 2.=2:\n+BETA\n*** End Patch`,
  });
  expect(seen.isError).not.toBe(true);
  expect(fixture.writes).toEqual([{ id: "d_guide", version: "base-v1", text: "alpha\nBETA\ngamma\ndelta\n" }]);
  expect(fixture.current().text).toBe("alpha\nBETA\ngamma\ndelta\n");
});


test("empty Octo ranges cannot authorize edits to unseen document lines", async () => {
  const fixture = createBackend();
  const tools = await makeHarness(fixture.backend);
  const read = await execute(tools.get("read"), { path: "octo://d_guide:99-100" });
  const tag = textOf(read).match(/\[octo:\/\/d_guide#([0-9a-f]{4})\]/i)?.[1];
  expect(tag).toBeDefined();

  const edit = await execute(tools.get("edit"), {
    input: `*** Begin Patch\n[octo://d_guide#${tag}]\nPUT 1.=1:\n+changed unseen line\n*** End Patch`,
  });
  expect(edit.isError).toBe(true);
  expect(fixture.writes).toHaveLength(0);
});

test("native optional write and configured edit-mode parameters reach the built-ins unchanged", async () => {
  const tools = await makeHarness(createBackend().backend);
  const calls: UnknownRecord[] = [];
  const context = {
    invokeTool: async (params: UnknownRecord) => {
      calls.push(params);
      return { content: [{ type: "text", text: "native tool completed" }] };
    },
  };
  const read = tools.get("read");
  const write = tools.get("write");
  const edit = tools.get("edit");

  const writeParams = { path: "proc://job/kill" };
  const replaceParams = { path: "README.md", old_string: "old", new_string: "new" };
  const patchParams = { path: "README.md", edits: [{ op: "update", diff: "@@ -1 +1 @@\n-old\n+new" }] };
  const applyPatchParams = { input: "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+octo://d_guide\n*** End Patch" };
  const writeResult = await execute(write, writeParams, context);
  const replaceResult = await execute(edit, replaceParams, context);
  const patchResult = await execute(edit, patchParams, context);
  const applyPatchResult = await execute(edit, applyPatchParams, context);

  expect(writeResult.isError).not.toBe(true);
  expect(replaceResult.isError).not.toBe(true);
  expect(patchResult.isError).not.toBe(true);
  expect(applyPatchResult.isError).not.toBe(true);
  expect(calls).toEqual([writeParams, replaceParams, patchParams, applyPatchParams]);
  expect(write?.parameters).toMatchObject({ shape: { content: { kind: "optional" } } });
  expect(edit?.parameters).toMatchObject({ shape: { input: { kind: "string" } } });
  expect(read?.description).toContain("Archives");
  expect(read?.description).toContain("SQLite");
  expect(read?.description).toContain("PDF");
  expect(write?.description).toContain("xd://");
  expect(write?.description).toContain("proc://<id>/kill");
  expect(approvalOf(read, { path: "README.md" })).toBe("exec");
  expect(approvalOf(read, { path: "octo://d_guide" })).toBe("read");
  expect(approvalOf(write, { path: "README.md" })).toBe("exec");
  expect(approvalOf(edit, replaceParams)).toBe("exec");
  expect(approvalOf(edit, { input: "*** Begin Patch\n[octo://d_guide#0000]\nPUT 1.=1:\n+new\n*** End Patch" })).toBe("write");
});

test("Octo edits reject non-hashline native edit modes", async () => {
  const fixture = createBackend();
  const tools = await makeHarness(fixture.backend);
  const calls: UnknownRecord[] = [];
  const context = {
    invokeTool: async (params: UnknownRecord) => {
      calls.push(params);
      return { content: [{ type: "text", text: "native edit completed" }] };
    },
  };

  const replace = await execute(tools.get("edit"), {
    path: "octo://d_guide",
    old_string: "alpha",
    new_string: "changed",
  }, context);
  const applyPatch = await execute(tools.get("edit"), {
    input: "*** Begin Patch\n*** Update File: octo://d_guide\n@@\n-alpha\n+changed\n*** End Patch",
  }, context);

  expect(replace.isError).toBe(true);
  expect(applyPatch.isError).toBe(true);
  expect(textOf(replace)).toContain("hashline mode");
  expect(textOf(applyPatch)).toContain("hashline mode");
  expect(calls).toHaveLength(0);
  expect(fixture.writes).toHaveLength(0);
});

test("both Octo URLs share document identity while write protects whole replacement by version", async () => {
  const fixture = createBackend();
  const tools = await makeHarness(fixture.backend);
  const read = tools.get("read");
  const write = tools.get("write");
  const httpsPath = "https://im.deepminer.com.cn/d/d_guide";

  const httpsRead = await execute(read, { path: httpsPath });
  const octoRead = await execute(read, { path: "octo://d_guide" });
  expect(textOf(httpsRead)).toContain(httpsPath);
  expect(textOf(octoRead)).toContain("octo://d_guide");
  expect(read?.approvalCacheTargets?.({ path: httpsPath })).toEqual(["octo://d_guide"]);
  expect(read?.approvalCacheTargets?.({ path: "octo://d_guide" })).toEqual(["octo://d_guide"]);
  expect(fixture.reads).toEqual(["d_guide", "d_guide"]);

  const result = await execute(write, { path: httpsPath, content: "replacement\n" });
  expect(result.isError).not.toBe(true);
  expect(fixture.writes).toEqual([{ id: "d_guide", version: "base-v1", text: "replacement\n" }]);
  expect(fixture.current().text).toBe("replacement\n");
  expect(typeof read?.approval === "function" ? read.approval({ path: "octo://d_guide" }) : read?.approval).toBe("read");
  expect(typeof write?.approval === "function" ? write.approval({ path: "octo://d_guide", content: "x" }) : write?.approval).toBe("write");
  expect(write?.approvalCacheTargets?.({ path: httpsPath, content: "x" })).toEqual(["octo://d_guide"]);
});

test("native paths delegate unchanged and mixed local/Octo edits report remote conflict", async () => {
  const fixture = createBackend();
  fixture.failWrites(new Error("version conflict: document changed remotely"));
  const tools = await makeHarness(fixture.backend);
  const calls: Array<{ params: UnknownRecord; signal?: AbortSignal; onUpdate?: (...args: unknown[]) => void }> = [];
  const context = {
    invokeTool: async (params: UnknownRecord, options?: { signal?: AbortSignal; onUpdate?: (...args: unknown[]) => void }) => {
      calls.push({ params, signal: options?.signal, onUpdate: options?.onUpdate });
      return { content: [{ type: "text", text: "native local edit completed" }] };
    },
  };
  const signal = new AbortController().signal;
  const onUpdate = () => {};

  const nativeRead = await execute(tools.get("read"), { path: "README.md:4-5" }, context, signal, onUpdate);
  expect(textOf(nativeRead)).toBe("native local edit completed");
  expect(calls[0]).toEqual({ params: { path: "README.md:4-5" }, signal, onUpdate });
  const octoRead = await execute(tools.get("read"), { path: "octo://d_guide" }, context, signal, onUpdate);
  const tag = textOf(octoRead).match(/\[octo:\/\/d_guide#([0-9a-f]{4})\]/i)?.[1];
  expect(tag, "mixed edits must use the actual read snapshot tag").toBeDefined();


  const mixed = await execute(tools.get("edit"), {
    input: `*** Begin Patch\n[octo://d_guide#${tag}]\nPUT 1.=1:\n+remote replacement\n[README.md#C3D4]\nPUT 1.=1:\n+local replacement\n*** End Patch`,
  }, context, signal, onUpdate);
  const report = textOf(mixed);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.params.input).toContain("[README.md#C3D4]");
  expect(calls[1]?.signal).toBe(signal);
  expect(calls[1]?.onUpdate).toBe(onUpdate);
  expect(mixed.isError).toBe(true);
  expect(report).toContain("README.md");
  expect(report).toContain("octo://d_guide");
  expect(report).toContain("version conflict");
  expect(fixture.writes).toHaveLength(1);
});

test("mixed edits reject hashline registers crossing local and Octo documents", async () => {
  const fixture = createBackend();
  const tools = await makeHarness(fixture.backend);
  const octoRead = await execute(tools.get("read"), { path: "octo://d_guide" });
  const tag = textOf(octoRead).match(/\[octo:\/\/d_guide#([0-9a-f]{4})\]/i)?.[1];
  expect(tag).toBeDefined();

  const calls: UnknownRecord[] = [];
  const mixed = await execute(tools.get("edit"), {
    input: `*** Begin Patch\n[README.md#C3D4]\nCUT 1.=1 @shared\n[octo://d_guide#${tag}]\nPUT <1 @shared\n*** End Patch`,
  }, {
    invokeTool: async (params: UnknownRecord) => {
      calls.push(params);
      return { content: [{ type: "text", text: "native edit completed" }] };
    },
  });

  expect(mixed.isError).toBe(true);
  expect(textOf(mixed)).toContain("register");
  expect(calls).toHaveLength(0);
  expect(fixture.writes).toHaveLength(0);
});
