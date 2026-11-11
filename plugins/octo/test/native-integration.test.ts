import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type FixtureDocument = { version: string; blocks: string[] };
type PatchRequest = { id: string; ifMatch: string | null };

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function textOfBlock(value: { type?: string; content?: Array<{ text?: string }> }): string {
  if (value.type !== "paragraph") throw new Error(`Unexpected fixture node: ${String(value.type)}`);
  return (value.content ?? []).map(child => child.text ?? "").join("");
}

function startGateway() {
  const documents = new Map<string, FixtureDocument>([
    ["d_octouri", { version: "v1", blocks: ["A one", "A two", "A three"] }],
    ["d_https", { version: "v1", blocks: ["H one", "H two", "H three"] }],
    ["d_write", { version: "v1", blocks: ["W original", "Keep me"] }],
    ["d_https_write", { version: "v1", blocks: ["Original HTTPS"] }],
    ["d_move", { version: "v1", blocks: ["Remote original"] }],
    ["d_reverse", { version: "v1", blocks: ["Remote moved", "Remote remains"] }],
    ["d_conflict", { version: "v1", blocks: ["C original", "Untouched"] }],
    ["d_cross", { version: "v1", blocks: ["Cross visible", "Cross hidden"] }],
    ["d_unseen", { version: "v1", blocks: ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"] }],
    ["d_cancel", { version: "v1", blocks: ["Cancel original"] }],
    ["d_reset", { version: "v1", blocks: ["Reset original"] }],
    ["d_toggle", { version: "v1", blocks: ["Toggle original"] }],
    ["d_device", { version: "v1", blocks: ["Device original"] }],
    ["d_denied", { version: "v1", blocks: ["Denied"] }],
    ["d_plan_write", { version: "v1", blocks: ["Plan write original"] }],
    ["d_plan_edit", { version: "v1", blocks: ["Plan edit original"] }],
  ]);
  let conflictAdvanced = false;
  const cancellationStarted = Promise.withResolvers<void>();
  const cancellationGate = Promise.withResolvers<void>();
  const resetStarted = Promise.withResolvers<void>();
  const resetGate = Promise.withResolvers<void>();
  const patches: PatchRequest[] = [];
  const unexpected: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__cancel_started") {
        await cancellationStarted.promise;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__cancel_release" && request.method === "POST") {
        cancellationGate.resolve();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__reset_started") {
        await resetStarted.promise;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__reset_release" && request.method === "POST") {
        resetGate.resolve();
        return new Response(null, { status: 204 });
      }
      const metadata = url.pathname.match(/^\/v1\/bot\/docs\/(d_[a-z_]+)$/);
      if (request.method === "GET" && metadata) {
        if (metadata[1] === "d_cancel") {
          cancellationStarted.resolve();
          await cancellationGate.promise;
        }
        if (metadata[1] === "d_reset") {
          resetStarted.resolve();
          await resetGate.promise;
        }
        if (!documents.has(metadata[1])) return Response.json({ error: "unknown fixture document" }, { status: 404 });
        return Response.json({ docId: metadata[1], docType: "doc", title: "Local fixture", role: "writer" });
      }

      const content = url.pathname.match(/^\/v1\/bot\/docs\/(d_[a-z_]+)\/content$/);
      if (content && request.method === "GET") {
        const document = documents.get(content[1]);
        if (!document) return Response.json({ error: "unknown fixture document" }, { status: 404 });
        const response = Response.json({
          docId: content[1],
          doc: { type: "doc", content: document.blocks.map(paragraph) },
          schemaVersion: 1,
          baseVersion: document.version,
        });
        if (content[1] === "d_conflict" && !conflictAdvanced) {
          conflictAdvanced = true;
          document.version = "v2";
          document.blocks = ["Remote changed", "Untouched"];
        }
        return response;
      }
      if (content && request.method === "PATCH") {
        const document = documents.get(content[1]);
        if (!document) return Response.json({ error: "unknown fixture document" }, { status: 404 });
        const ifMatch = request.headers.get("if-match");
        patches.push({ id: content[1], ifMatch });
        if (ifMatch !== document.version) {
          return Response.json({ error: { code: "base_version_stale", message: "stale fixture version" } }, { status: 412 });
        }
        const body = await request.json() as {
          ops?: Array<{
            type: string;
            range?: { from: { path: number[] }; to: { path: number[] } };
            content?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
          }>;
        };
        for (const operation of body.ops ?? []) {
          const from = operation.range?.from.path;
          const to = operation.range?.to.path;
          if ((operation.type !== "replace" && operation.type !== "delete") || !from || !to || from.length !== 1 || to.length !== 1) {
            return Response.json({ error: "unexpected fixture operation" }, { status: 400 });
          }
          document.blocks.splice(from[0], to[0] - from[0] + 1, ...(operation.content ?? []).map(textOfBlock));
        }
        document.version = `v${Number(document.version.slice(1)) + 1}`;
        return Response.json({ docId: content[1], baseVersion: document.version });
      }

      unexpected.push(`${request.method} ${url.pathname}`);
      return new Response("unexpected local gateway request", { status: 404 });
    },
  });
  return { server, documents, patches, unexpected };
}

test("real OMP host keeps native provenance and local/Octo read-write-edit behavior", async () => {
  const gateway = startGateway();
  const cwd = await mkdtemp(join(tmpdir(), "omp-octo-native-"));
  const localFile = join(cwd, "ordinary.md");
  const pluginPath = resolve(import.meta.dir, "../src/index.ts");
  const sdkPath = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/index.ts");
  const runtimeInitPath = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/modes/runtime-init.ts");

  const hostProgram = `
import * as settingRegistry from ${JSON.stringify(resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/config/registry.ts"))};
import * as settingsUi from ${JSON.stringify(resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/config/settings-ui.ts"))};
const sdk = await import(${JSON.stringify(sdkPath)});
const runtime = await import(${JSON.stringify(runtimeInitPath)});
const { AgentRegistry, Settings, SessionManager, createAgentSession } = sdk;
const cwd = process.env.OCTO_NATIVE_CWD;
const gateway = process.env.OCTO_NATIVE_GATEWAY;
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const address = typeof input === "string" || input instanceof URL ? input : input.url;
  const url = new URL(address);
  if (!loopbackHosts.has(url.hostname)) throw new Error("native integration test blocked non-loopback request to " + url.origin);
  return realFetch(input, init);
};
const settings = Settings.isolated({
  "edit.enforceSeenLines": false,
  "tools.approvalMode": "write",
  "tools.xdev": true,
  "edit.mode": "hashline",
  "plan.enabled": true,
});
const created = await createAgentSession({
  cwd,
  agentDir: cwd + "/.agent-native-test",
  sessionManager: SessionManager.inMemory(cwd),
  settings,
  additionalExtensionPaths: [process.env.OCTO_NATIVE_PLUGIN],
  disableExtensionDiscovery: true,
  enableMCP: false,
  enableLsp: false,
  enableIrc: false,
  skipPythonPreflight: true,
  cacheWarming: false,
  deferSkillDescriptionCompression: true,
  bindProcessState: false,
  hasUI: false,
  contextFiles: [],
  skills: [],
  rules: [],
  agentRegistry: new AgentRegistry(),
});
const session = created.session;
const sessions = [session];
async function openAdditionalSession(name, options = {}) {
  const additionalSettings = Settings.isolated({
    "tools.approvalMode": options.approvalMode || "write",
    "tools.approval": options.approval || {},
    "tools.xdev": options.xdev !== false,
    "edit.mode": "hashline",
    "plan.enabled": true,
  });
  const additional = await createAgentSession({
    cwd,
    agentDir: cwd + "/.agent-" + name,
    sessionManager: SessionManager.inMemory(cwd),
    settings: additionalSettings,
    additionalExtensionPaths: [process.env.OCTO_NATIVE_PLUGIN],
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    cacheWarming: false,
    deferSkillDescriptionCompression: true,
    bindProcessState: false,
    hasUI: false,
    contextFiles: [],
    skills: [],
    rules: [],
    toolNames: options.toolNames,
    agentRegistry: new AgentRegistry(),
  }).then(value => value.session);
  sessions.push(additional);
  await runtime.initializeExtensions(additional, {
    mode: "rpc",
    reportSendError: (_action, error) => console.error(error.message),
    reportRuntimeError: error => console.error(error.error),
  });
  await additional.runToolRegistryMutation(async () => {});
  return additional;
}
try {
  await runtime.initializeExtensions(session, {
    mode: "rpc",
    reportSendError: (_action, error) => console.error(error.message),
    reportRuntimeError: error => console.error(error.error),
  });
  await session.runToolRegistryMutation(async () => {});

  function flatten(result) {
    if (!result) return { missing: true, isError: true, text: "tool result missing" };
    return {
      isError: result.isError === true,
      text: (result.content || []).filter(block => typeof block.text === "string").map(block => block.text).join("\\n"),
    };
  }
  async function invoke(name, args, callId, target = session, signal) {
    const tool = target.getToolByName(name);
    if (!tool || typeof tool.execute !== "function") return { missing: true, isError: true, text: name + " is not registered" };
    try {
      return flatten(await tool.execute(callId, args, signal));
    } catch (error) {
      return { isError: true, thrown: true, text: error instanceof Error ? error.message : String(error) };
    }
  }
  function header(text) {
    return text.split(/\\r?\\n/).find(line => /^\\[[^\\]\\r\\n]+#[0-9a-f]{4}\\]$/i.test(line)) || "";
  }
  function patch(headerLine, line, replacement) {
    return "*** Begin Patch\\n" + headerLine + "\\nPUT " + line + ".=" + line + ":\\n+" + replacement + "\\n*** End Patch";
  }
  function tier(name, args, target = session) {
    const tool = target.getToolByName(name);
    if (!tool) return null;
    const decision = typeof tool.approval === "function" ? tool.approval(args) : tool.approval;
    return typeof decision === "string" ? decision : decision && typeof decision.tier === "string" ? decision.tier : null;
  }
  const provenance = {};
  for (const name of ["read", "write", "edit"]) {
    const info = session.getAllToolInfos().find(candidate => candidate.name === name);
    provenance[name] = {
      source: info && info.sourceInfo ? info.sourceInfo.source : null,
      builtIn: session.hasBuiltInTool(name),
    };
  }
  const editTool = session.agent.state.tools.find(candidate => candidate.name === "edit") || session.getToolByName("edit");
  const customFormat = editTool && editTool.customFormat;
  const editFormat = {
    mode: editTool && editTool.mode || null,
    syntax: customFormat && customFormat.syntax || null,
    hasPutGrammar: !!(customFormat && typeof customFormat.definition === "string" && customFormat.definition.includes("PUT")),
  };

  const result = { provenance, editFormat, local: {}, octo: {}, https: {}, xd: {} };
  result.xd.mounted = session.getMountedXdevToolNames();
  result.xd.listing = await invoke("read", { path: "xd://" }, "xd-list");
  result.xd.device = result.xd.mounted[0] || null;
  result.xd.deviceDocs = result.xd.device
    ? await invoke("read", { path: "xd://" + result.xd.device }, "xd-docs")
    : null;

  result.local.write = await invoke("write", { path: cwd + "/ordinary.md", content: "local first\\nlocal second\\nlocal third\\n" }, "local-write");
  result.local.read = await invoke("read", { path: cwd + "/ordinary.md" }, "local-read");
  result.local.edit = await invoke("edit", { input: patch(header(result.local.read.text), 2, "local changed") }, "local-edit");

  result.octo.path = "octo://d_octouri";
  result.octo.read = await invoke("read", { path: result.octo.path }, "octo-read");
  const octoEditInput = patch(header(result.octo.read.text), 3, "A changed");
  result.octo.editApproval = tier("edit", { input: octoEditInput });
  result.octo.edit = await invoke("edit", { input: octoEditInput }, "octo-edit");
  result.octo.writeApproval = tier("write", { path: "octo://d_write", content: "Whole replacement\\n\\nKeep me" });
  result.octo.write = await invoke("write", { path: "octo://d_write", content: "Whole replacement\\n\\nKeep me" }, "octo-write");

  result.https.path = "https://im.deepminer.com.cn/d/d_https";
  result.https.read = await invoke("read", { path: result.https.path }, "https-read");
  const httpsEditInput = patch(header(result.https.read.text), 3, "H changed");
  result.https.readApproval = tier("read", { path: result.https.path });
  result.https.editApproval = tier("edit", { input: httpsEditInput });
  result.https.edit = await invoke("edit", { input: httpsEditInput }, "https-edit");
  result.https.write = await invoke("write", { path: "https://im.deepminer.com.cn/d/d_https_write", content: "Updated HTTPS" }, "https-write");
  result.move = {};
  result.move.path = cwd + "/move.md";
  result.move.write = await invoke("write", { path: result.move.path, content: "Moved line\\nLocal remains\\n" }, "move-write");
  result.move.local = await invoke("read", { path: result.move.path }, "move-read-local");
  result.move.remote = await invoke("read", { path: "octo://d_move" }, "move-read-remote");
  const moveInput = "*** Begin Patch\\n" + header(result.move.local.text) + "\\nCUT 1.=1 @moving\\n" +
    header(result.move.remote.text) + "\\nPUT 1.=1 @moving\\n*** End Patch";
  result.move.edit = await invoke("edit", { input: moveInput }, "move-edit");
  result.reverse = {};
  result.reverse.path = cwd + "/reverse.md";
  result.reverse.write = await invoke("write", { path: result.reverse.path, content: "Local original\\n" }, "reverse-write");
  result.reverse.remote = await invoke("read", { path: "octo://d_reverse" }, "reverse-read-remote");
  result.reverse.local = await invoke("read", { path: result.reverse.path }, "reverse-read-local");
  const reverseInput = "*** Begin Patch\\n" + header(result.reverse.remote.text) + "\\nCUT 1.=1 @reverse\\n" +
    header(result.reverse.local.text) + "\\nPUT 1.=1 @reverse\\n*** End Patch";
  result.reverse.edit = await invoke("edit", { input: reverseInput }, "reverse-edit");
  session.setPlanModeState({ enabled: true, planFilePath: cwd + "/PLAN.md" });
  result.plan = {};
  result.plan.write = await invoke("write", { path: "octo://d_plan_write", content: "Plan write bypass" }, "plan-write");
  result.plan.read = await invoke("read", { path: "octo://d_plan_edit" }, "plan-edit-read");
  result.plan.edit = await invoke("edit", { input: patch(header(result.plan.read.text), 1, "Plan edit bypass") }, "plan-edit");
  session.setPlanModeState(undefined);
  result.conflict = {};
  result.conflict.read = await invoke("read", { path: "octo://d_conflict" }, "conflict-read");
  result.conflict.edit = await invoke("edit", { input: patch(header(result.conflict.read.text), 1, "Client stale") }, "conflict-edit");
  result.unseen = {};
  result.unseen.read = await invoke("read", { path: "octo://d_unseen:1-1" }, "unseen-read");
  result.unseen.edit = await invoke("edit", { input: patch(header(result.unseen.read.text), 13, "Unseen bypass") }, "unseen-edit");
  const cancelController = new AbortController();
  const cancelWrite = invoke("write", { path: "octo://d_cancel", content: "Cancel bypass" }, "cancel-write", session, cancelController.signal);
  await fetch(gateway + "/__cancel_started");
  cancelController.abort();
  await fetch(gateway + "/__cancel_release", { method: "POST" });
  result.cancel = await cancelWrite;

  const second = await openAdditionalSession("second");
  const resetWrite = invoke("write", { path: "octo://d_reset", content: "Reset bypass" }, "reset-write", second);
  await fetch(gateway + "/__reset_started");
  await second.extensionRunner.emit({ type: "session_switch", reason: "new" });
  await fetch(gateway + "/__reset_release", { method: "POST" });
  result.reset = await resetWrite;
  result.crossSession = {};
  result.crossSession.read = await invoke("read", { path: "octo://d_cross:1" }, "cross-session-read");
  result.crossSession.edit = await invoke(
    "edit",
    { input: patch(header(result.crossSession.read.text), 1, "Cross-session write") },
    "cross-session-edit",
    second,
  );

  const denied = await openAdditionalSession("denied", {
    approvalMode: "yolo",
    approval: { write: "deny" },
    xdev: false,
    toolNames: ["read", "write", "edit"],
  });
  result.denied = await invoke("write", { path: "octo://d_denied", content: "Permission bypass" }, "denied-write", denied);

  const deviceOnly = await openAdditionalSession("device-only", { toolNames: ["read"], xdev: true });
  result.deviceOnly = {
    write: await invoke("write", { path: "octo://d_device", content: "Device-only bypass" }, "device-only-write", deviceOnly),
    writeBuiltin: deviceOnly.hasBuiltInTool("write"),
  };
  const octoSetting = settingRegistry.lookup("octo.enabled");
  result.toggle = { entry: settingsUi.createSettingsHost().entries.find(entry => entry.path === "octo.enabled") || null };
  if (octoSetting) {
    result.toggle.before = await invoke("read", { path: "octo://d_toggle" }, "toggle-before");
    octoSetting.set(settings, false);
    result.toggle.readOff = await invoke("read", { path: "octo://d_toggle" }, "toggle-read-off");
    result.toggle.writeOff = await invoke("write", { path: "octo://d_toggle", content: "Disabled bypass" }, "toggle-write-off");
    result.toggle.editOff = await invoke("edit", { input: patch(header(result.toggle.before.text), 1, "Disabled edit bypass") }, "toggle-edit-off");
    result.toggle.localOff = await invoke("read", { path: cwd + "/ordinary.md" }, "toggle-local-off");
    octoSetting.set(settings, true);
    result.toggle.readOn = await invoke("read", { path: "octo://d_toggle" }, "toggle-read-on");
  }



  console.log("OCTO_NATIVE_HOST_RESULT " + JSON.stringify(result));
} finally {
  for (const current of sessions.reverse()) await current.dispose();
}
`;

  try {
    const child = Bun.spawn([process.execPath, "-e", hostProgram], {
      cwd,
      env: {
        ...process.env,
        PI_EDIT_VARIANT: "hashline",
        PI_STRICT_EDIT_MODE: "1",
        OCTO_NATIVE_CWD: cwd,
        OCTO_NATIVE_GATEWAY: `http://127.0.0.1:${gateway.server.port}`,
        OCTO_NATIVE_PLUGIN: pluginPath,
        OCTO_TOKEN: "bf_native_test_fixture",
        OCTO_CREDENTIAL_MODE: "",
        OCTO_API_BASE_URL: `http://127.0.0.1:${gateway.server.port}`,
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
    const resultLine = stdout.split(/\r?\n/).find(line => line.startsWith("OCTO_NATIVE_HOST_RESULT "));
    expect(resultLine, stdout).toBeDefined();
    const result = JSON.parse(resultLine!.slice("OCTO_NATIVE_HOST_RESULT ".length));

    expect(result.provenance).toEqual({
      read: { source: "builtin", builtIn: true },
      write: { source: "builtin", builtIn: true },
      edit: { source: "builtin", builtIn: true },
    });
    expect(result.editFormat).toEqual({ mode: "hashline", syntax: "lark", hasPutGrammar: true });
    expect(result.xd.listing.isError).toBe(false);
    expect(result.xd.listing.text).toContain("xd://" + result.xd.mounted[0]);
    expect(result.xd.deviceDocs.isError).toBe(false);

    expect(result.local.write.isError).toBe(false);
    expect(result.local.read.isError).toBe(false);
    expect(result.local.edit.isError).toBe(false);
    expect(await readFile(localFile, "utf8")).toBe("local first\nlocal changed\nlocal third\n");

    expect(result.octo.read.isError).toBe(false);
    expect(result.octo.read.text).toContain(result.octo.path);
    expect(result.octo.editApproval).toBe("write");
    expect(result.octo.edit.isError).toBe(false);
    expect(result.octo.edit.text).toContain(result.octo.path);
    expect(result.octo.writeApproval).toBe("write");
    expect(result.octo.write.isError).toBe(false);
    expect(result.octo.write.text).toContain("octo://d_write");

    expect(result.https.read.isError).toBe(false);
    expect(result.https.read.text).toContain(result.https.path);
    expect(result.https.readApproval).toBe("read");
    expect(result.https.editApproval).toBe("write");
    expect(result.https.edit.isError).toBe(false);
    expect(result.https.edit.text).toContain(result.https.path);
    expect(result.https.write.isError).toBe(false);
    expect(result.https.write.text).toContain("https://im.deepminer.com.cn/d/d_https_write");
    expect(result.move.edit.isError).toBe(false);
    expect(await readFile(join(cwd, "move.md"), "utf8")).toBe("Local remains\n");
    expect(result.reverse.edit.isError).toBe(false);
    expect(await readFile(join(cwd, "reverse.md"), "utf8")).toBe("Remote moved\n");
    expect(result.plan.write.isError).toBe(true);
    expect(result.plan.write.text).toMatch(/plan mode/i);
    expect(result.plan.edit.isError).toBe(true);
    expect(result.plan.edit.text).toMatch(/plan mode/i);
    expect(result.conflict.edit.isError).toBe(true);
    expect(result.conflict.edit.text).toMatch(/stale|version|base_version/i);
    expect(result.crossSession.edit.isError).toBe(true);
    expect(result.crossSession.edit.text).toMatch(/snapshot|read/i);
    expect(result.cancel.isError).toBe(true);
    expect(gateway.documents.get("d_cancel")?.blocks).toEqual(["Cancel original"]);
    expect(gateway.patches.some(patch => patch.id === "d_cancel")).toBe(false);
    expect(result.reset.isError).toBe(true);
    expect(gateway.documents.get("d_reset")?.blocks).toEqual(["Reset original"]);
    expect(gateway.patches.some(patch => patch.id === "d_reset")).toBe(false);
    expect(result.unseen.read.text).not.toContain("Seven");
    expect(result.unseen.edit.isError).toBe(true);
    expect(result.unseen.edit.text).toMatch(/seen|read/i);
    expect(result.denied.isError).toBe(true);
    expect(result.denied.text).toMatch(/denied|deny|approval/i);
    expect(result.deviceOnly.write.isError).toBe(true);
    expect(result.deviceOnly.writeBuiltin).toBe(true);
    expect(result.toggle.entry).toMatchObject({ type: "boolean", ui: { tab: "tools", group: "Available Tools", label: "Octo" } });
    expect(result.toggle.readOff.isError).toBe(true);
    expect(result.toggle.writeOff.isError).toBe(true);
    expect(result.toggle.editOff.isError).toBe(true);
    expect(result.toggle.localOff.isError).toBe(false);
    expect(result.toggle.readOn.isError).toBe(false);
    expect(gateway.documents.get("d_toggle")?.blocks).toEqual(["Toggle original"]);



    expect(gateway.documents.get("d_octouri")?.blocks).toEqual(["A one", "A changed", "A three"]);
    expect(gateway.documents.get("d_https")?.blocks).toEqual(["H one", "H changed", "H three"]);
    expect(gateway.documents.get("d_write")?.blocks).toEqual(["Whole replacement", "Keep me"]);
    expect(gateway.documents.get("d_https_write")?.blocks).toEqual(["Updated HTTPS"]);
    expect(gateway.documents.get("d_move")?.blocks).toEqual(["Moved line"]);
    expect(gateway.documents.get("d_reverse")?.blocks).toEqual(["Remote remains"]);
    expect(gateway.documents.get("d_plan_write")?.blocks).toEqual(["Plan write original"]);
    expect(gateway.documents.get("d_plan_edit")?.blocks).toEqual(["Plan edit original"]);
    expect(gateway.documents.get("d_conflict")?.blocks).toEqual(["Remote changed", "Untouched"]);
    expect(gateway.documents.get("d_cross")?.blocks).toEqual(["Cross visible", "Cross hidden"]);
    expect(gateway.documents.get("d_unseen")?.blocks).toEqual(["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"]);
    expect(gateway.documents.get("d_device")?.blocks).toEqual(["Device original"]);
    expect(gateway.documents.get("d_denied")?.blocks).toEqual(["Denied"]);
    expect(gateway.patches.some(patch => patch.id === "d_plan_write" || patch.id === "d_plan_edit")).toBe(false);
    expect(gateway.patches.some(patch => patch.id === "d_conflict" && patch.ifMatch === "v1")).toBe(true);
    expect(gateway.patches.some(patch => patch.id === "d_cross")).toBe(false);
    expect(gateway.patches.some(patch => patch.id === "d_device")).toBe(false);
    expect(gateway.patches.some(patch => patch.id === "d_denied")).toBe(false);

    expect(gateway.unexpected).toEqual([]);
  } finally {
    gateway.server.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
