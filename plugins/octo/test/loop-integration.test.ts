import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TASK_ID = "22222222-2222-4222-8222-222222222223";
const UNKNOWN_TASK_ID = "22222222-2222-4222-8222-222222222224";
const TARGET_COMMENT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_COMMENT_ID = "33333333-3333-4333-8333-333333333334";
const PARENT_COMMENT_ID = "33333333-3333-4333-8333-333333333335";
const ATTACHMENT_ID = "44444444-4444-4444-8444-444444444444";
const EXPERT_ID = "99999999-9999-4999-8999-999999999999";
const SUPPRESS_EXPERT_ID = "88888888-8888-4888-8888-888888888888";
const CONCURRENT_EXPERT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONCURRENT_EXPERT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INJECTION_CONTENT = `Quoted 'body'; --workspace-id ${OTHER_TASK_ID}; $(printf expanded)`;

type GatewayRequest = {
  method: string;
  path: string;
  query: string;
  workspaceId: string | null;
  body?: unknown;
  credential: string | null;
};
type ApprovalPrompt = { full: string };

function startGateway() {
  let commentBody = "Comment A line 1\nComment A line 2";
  let holdNextCommentPage = false;
  let commentReadGate = {
    started: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  let failCommentPageTwo = false;
  let holdNextCommentCreateResponse = false;
  let commentCreateGate = {
    started: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  let approvalAGate = {
    started: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  let emptyFinalPageResource: "workspaces" | "tasks" | "comments" | null = null;
  const emptyFinalPageRequests: Array<{ resource: string; page: number; pageSize: number; total: number; dataLength: number }> = [];
  const requests: GatewayRequest[] = [];
  const commentPages: Array<{ taskId: string; page: number; pageSize: number }> = [];
  const previewRequests: GatewayRequest[] = [];
  const commentUpdates: GatewayRequest[] = [];
  const commentCreates: GatewayRequest[] = [];
  let failedCommentPageTwoRequests = 0;
  const committedCommentContents: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/__hold_next_comment_page" && request.method === "POST") {
        holdNextCommentPage = true;
        commentReadGate = {
          started: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
        };
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__wait_comment_page_started" && request.method === "GET") {
        await commentReadGate.started.promise;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__release_comment_page" && request.method === "POST") {
        holdNextCommentPage = false;
        commentReadGate.release.resolve();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__set_comment" && request.method === "POST") {
        const body = await request.json() as { content: string };
        commentBody = body.content;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__fail_comment_page_two" && request.method === "POST") {
        failCommentPageTwo = true;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__allow_comment_page_two" && request.method === "POST") {
        failCommentPageTwo = false;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__set_empty_final_page" && request.method === "POST") {
        const body = await request.json() as { resource: "workspaces" | "tasks" | "comments" };
        emptyFinalPageResource = body.resource;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__clear_empty_final_page" && request.method === "POST") {
        emptyFinalPageResource = null;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__hold_next_comment_create_response" && request.method === "POST") {
        holdNextCommentCreateResponse = true;
        commentCreateGate = {
          started: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
        };
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__wait_comment_create_started" && request.method === "GET") {
        await commentCreateGate.started.promise;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__release_comment_create_response" && request.method === "POST") {
        holdNextCommentCreateResponse = false;
        commentCreateGate.release.resolve();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__hold_approval_a" && request.method === "POST") {
        const gate = approvalAGate;
        gate.started.resolve();
        await gate.release.promise;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__wait_approval_a_started" && request.method === "GET") {
        await approvalAGate.started.promise;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__release_approval_a" && request.method === "POST") {
        approvalAGate.release.resolve();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__reset_approval_a" && request.method === "POST") {
        approvalAGate = {
          started: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
        };
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/__stats" && request.method === "GET") {
        return Response.json({
          commentPageRequests: commentPages.length,
          failedCommentPageTwoRequests,
          previewRequests: previewRequests.length,
          commentCreateRequests: commentCreates.length,
          commentUpdateRequests: commentUpdates.length,
        });
      }

      let body: unknown;
      if (request.method !== "GET" && request.method !== "HEAD") {
        try {
          body = await request.clone().json();
        } catch {
          body = undefined;
        }
      }
      const entry: GatewayRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams.toString(),
        workspaceId: request.headers.get("x-workspace-id"),
        credential: request.headers.get("authorization"),
        body,
      };
      requests.push(entry);
      const workspaceMatches = entry.workspaceId?.toLowerCase() === WORKSPACE_ID;

      if (request.method === "GET" && url.pathname === "/fleet/api/v1/workspaces") {
        if (emptyFinalPageResource === "workspaces") {
          const page = Number(url.searchParams.get("page") ?? 1);
          const data = page === 1 ? Array.from({ length: 20 }, (_, index) => ({
            workspace_id: `eeeeeeee-eeee-4eee-8eee-${String(index + 1).padStart(12, "0")}`,
            name: `Empty page workspace ${index + 1}`,
            slug: `empty-page-${index + 1}`,
            description: "Pagination incomplete fixture",
            context: null,
            settings: {},
            repos: [],
            issue_prefix: "EMPTY",
            avatar_url: null,
            created_at: "2026-11-11T00:00:00Z",
            updated_at: "2026-11-11T00:00:00Z",
          })) : [];
          emptyFinalPageRequests.push({ resource: "workspaces", page, pageSize: 20, total: 21, dataLength: data.length });
          return Response.json({ data, pagination: { page, page_size: 20, total: 21 } });
        }
        return Response.json({
          data: [{
            workspace_id: WORKSPACE_ID,
            name: "Loop fixture workspace",
            slug: "loop-fixture",
            description: "Loop fixture",
            context: null,
            settings: {},
            repos: [],
            issue_prefix: "LOOP",
            avatar_url: null,
            created_at: "2026-11-11T00:00:00Z",
            updated_at: "2026-11-11T00:00:00Z",
          }],
          pagination: { page: 1, page_size: 20, total: 1 },
        });
      }

      if (request.method === "GET" && url.pathname === "/fleet/api/v1/tasks") {
        if (!workspaceMatches) {
          return Response.json({ error: "wrong workspace scope" }, { status: 403 });
        }
        if (emptyFinalPageResource === "tasks") {
          const page = Number(url.searchParams.get("page") ?? 1);
          const data = page === 1 ? Array.from({ length: 20 }, (_, index) => ({
            task_id: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`,
            title: `Empty page task ${index + 1}`,
            status: "in_progress",
          })) : [];
          emptyFinalPageRequests.push({ resource: "tasks", page, pageSize: 20, total: 21, dataLength: data.length });
          return Response.json({ data, pagination: { page, page_size: 20, total: 21 } });
        }
        return Response.json({
          data: [{ task_id: TASK_ID, title: "Loop fixture task", status: "in_progress" }],
          pagination: { page: 1, page_size: 20, total: 1 },
        });
      }

      const taskDetail = url.pathname.match(/^\/fleet\/api\/v1\/tasks\/([^/]+)$/);
      if (request.method === "GET" && taskDetail) {
        if (!workspaceMatches || taskDetail[1]?.toLowerCase() !== TASK_ID) {
          return Response.json({ error: "task not found in workspace" }, { status: 404 });
        }
        return Response.json({ data: { task_id: TASK_ID, title: "Loop fixture task", description: "Task detail" } });
      }

      const preview = url.pathname.match(/^\/fleet\/api\/v1\/tasks\/([^/]+)\/comments\/_trigger_preview$/);
      if (request.method === "POST" && preview) {
        previewRequests.push(entry);
        if (!workspaceMatches || preview[1]?.toLowerCase() !== TASK_ID) {
          return Response.json({ error: "task not found in workspace" }, { status: 404 });
        }
        const content = (body as { content?: string } | undefined)?.content;
        if (content === "Preview transport failure") {
          return Response.json({ error: "fixture preview unavailable" }, { status: 503 });
        }
        if (content === "Preview missing authority") return Response.json({ data: {} });
        if (content === "Yolo still requires approval" || content === "Approved original parameters") {
          return Response.json({ data: { experts: [{
            expert_id: EXPERT_ID,
            name: "Fixture expert",
            source: "mention",
            reason: "explicit mention",
          }] } });
        }
        if (content === "Concurrent preview A" || content === "Concurrent preview B") {
          const isA = content.endsWith("A");
          return Response.json({
            data: {
              experts: [{
                expert_id: isA ? CONCURRENT_EXPERT_A_ID : CONCURRENT_EXPERT_B_ID,
                name: isA ? "Concurrent expert A" : "Concurrent expert B",
                source: "mention",
                reason: isA ? "preview A reason" : "preview B reason",
              }],
            },
          });
        }
        return Response.json({ data: { experts: [] } });
      }
      const commentUpdate = url.pathname.match(/^\/fleet\/api\/v1\/comments\/([^/]+)$/);
      if (request.method === "PATCH" && commentUpdate) {
        commentUpdates.push(entry);
        if (!workspaceMatches || commentUpdate[1]?.toLowerCase() !== TARGET_COMMENT_ID) {
          return Response.json({ error: "comment not found in workspace" }, { status: 404 });
        }
        const content = (body as { content?: unknown } | undefined)?.content;
        if (typeof content !== "string") return Response.json({ error: "content is required" }, { status: 400 });
        commentBody = content;
        if (content === "Update outcome unknown") {
          return Response.json({ error: "fixture update response unavailable" }, { status: 503 });
        }
        return Response.json({
          data: {
            comment_id: TARGET_COMMENT_ID,
            task_id: TASK_ID,
            content,
            parent_id: PARENT_COMMENT_ID,
            attachments: [{ id: ATTACHMENT_ID }],
          },
        });
      }

      const commentCollection = url.pathname.match(/^\/fleet\/api\/v1\/tasks\/([^/]+)\/comments$/);
      if (commentCollection && request.method === "GET") {
        if (!workspaceMatches) {
          return Response.json({ error: "wrong workspace scope" }, { status: 403 });
        }
        const taskId = commentCollection[1]!.toLowerCase();
        const page = Number(url.searchParams.get("page") ?? 1);
        const pageSize = Number(url.searchParams.get("page_size") ?? 20);
        commentPages.push({ taskId, page, pageSize });
        if (emptyFinalPageResource === "comments" && taskId === TASK_ID) {
          const data = page === 1 ? Array.from({ length: 20 }, (_, index) => ({
            comment_id: `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, "0")}`,
            task_id: TASK_ID,
            content: `Empty page comment ${index + 1}`,
            parent_id: null,
            attachments: [],
          })) : [];
          emptyFinalPageRequests.push({ resource: "comments", page, pageSize: 20, total: 21, dataLength: data.length });
          return Response.json({ data, pagination: { page, page_size: 20, total: 21 } });
        }
        if (taskId !== TASK_ID && taskId !== OTHER_TASK_ID) {
          return Response.json({ error: "task not found in workspace" }, { status: 404 });
        }
        if (holdNextCommentPage && taskId === TASK_ID && page === 1) {
          holdNextCommentPage = false;
          const gate = commentReadGate;
          gate.started.resolve();
          await gate.release.promise;
        }
        if (failCommentPageTwo && taskId === TASK_ID && page === 2) {
          failedCommentPageTwoRequests++;
          return Response.json({ error: "fixture comment page failed" }, { status: 502 });
        }

        const comments = taskId === TASK_ID
          ? [
              ...Array.from({ length: pageSize }, (_, index) => ({
                comment_id: `66666666-6666-4666-8666-${String(index + 1).padStart(12, "0")}`,
                task_id: TASK_ID,
                content: `Earlier comment ${index + 1}`,
                parent_id: null,
                attachments: [],
              })),
              {
                comment_id: PARENT_COMMENT_ID,
                task_id: TASK_ID,
                content: "Parent comment",
                parent_id: null,
                attachments: [],
              },
              {
                comment_id: TARGET_COMMENT_ID,
                task_id: TASK_ID,
                content: commentBody,
                parent_id: PARENT_COMMENT_ID,
                attachments: [{ id: ATTACHMENT_ID }],
              },
            ]
          : [{ comment_id: OTHER_COMMENT_ID, task_id: OTHER_TASK_ID, content: "Other task comment", parent_id: null, attachments: [] }];
        const offset = (page - 1) * pageSize;
        return Response.json({
          data: comments.slice(offset, offset + pageSize),
          pagination: { page, page_size: pageSize, total: comments.length },
        });
      }

      const commentCreate = url.pathname.match(/^\/fleet\/api\/v1\/tasks\/([^/]+)\/comments$/);
      if (request.method === "POST" && commentCreate) {
        const createEntry = { ...entry, path: url.pathname };
        commentCreates.push(createEntry);
        if (!workspaceMatches || commentCreate[1]?.toLowerCase() !== TASK_ID) {
          return Response.json({ error: "task not found in workspace" }, { status: 404 });
        }
        const createBody = body as { content?: string; parent_comment_id?: string; attachment_ids?: string[] } | undefined;
        if (createBody?.content === "Create outcome unknown") {
          return Response.json({ error: "fixture create response unavailable" }, { status: 503 });
        }
        if (createBody?.content === "Create committed before session switch") {
          committedCommentContents.push(createBody.content);
          if (holdNextCommentCreateResponse) {
            holdNextCommentCreateResponse = false;
            const gate = commentCreateGate;
            gate.started.resolve();
            await gate.release.promise;
          }
        }
        return Response.json({
          data: {
            comment_id: "77777777-7777-4777-8777-777777777777",
            task_id: TASK_ID,
            content: createBody?.content,
            parent_id: createBody?.parent_comment_id ?? null,
            attachments: (createBody?.attachment_ids ?? []).map(id => ({ id })),
          },
        }, { status: 201 });
      }

      return Response.json({ error: `unexpected fixture request: ${request.method} ${url.pathname}` }, { status: 404 });
    },
  });

  return { server, requests, commentPages, previewRequests, commentCreates, commentUpdates, emptyFinalPageRequests, committedCommentContents, get failedCommentPageTwoRequests() { return failedCommentPageTwoRequests; } };
}

test("real OMP reads the Loop workspaces URI through octo-cli", async () => {
  const gateway = startGateway();
  const cwd = await mkdtemp(join(tmpdir(), "omp-octo-loop-read-"));
  const pluginPath = resolve(import.meta.dir, "../src/index.ts");
  const sdkPath = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/index.ts");
  const runtimeInitPath = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/modes/runtime-init.ts");
  const hostProgram = `
import * as sdk from ${JSON.stringify(sdkPath)};
import * as runtime from ${JSON.stringify(runtimeInitPath)};
const { AgentRegistry, Settings, SessionManager, createAgentSession } = sdk;
const cwd = process.env.OCTO_LOOP_CWD;
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const address = typeof input === "string" || input instanceof URL ? input : input.url;
  const url = new URL(address);
  if (!loopbackHosts.has(url.hostname)) throw new Error("Loop integration test blocked non-loopback request to " + url.origin);
  return realFetch(input, init);
};
const settings = Settings.isolated({
  "tools.approvalMode": "write",
  "tools.xdev": true,
  "edit.mode": "hashline",
  "plan.enabled": true,
});
const created = await createAgentSession({
  cwd,
  agentDir: cwd + "/.agent-loop-read-test",
  sessionManager: SessionManager.inMemory(cwd),
  settings,
  additionalExtensionPaths: [process.env.OCTO_LOOP_PLUGIN],
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
try {
  await runtime.initializeExtensions(session, {
    mode: "rpc",
    reportSendError: (_action, error) => console.error(error.message),
    reportRuntimeError: error => console.error(error.error),
  });
  await session.runToolRegistryMutation(async () => {});
  const tool = session.getToolByName("read");
  const result = tool
    ? await tool.execute("loop-workspaces-read", { path: "octo://loop/workspaces" })
    : { isError: true, content: [{ text: "builtin read tool missing" }] };
  console.log("OCTO_LOOP_READ_HOST_RESULT " + JSON.stringify({
    isError: result.isError === true,
    text: (result.content || []).filter(block => typeof block.text === "string").map(block => block.text).join("\\\\n"),
  }));
} finally {
  await session.dispose();
}
`;
  try {
    const child = Bun.spawn([process.execPath, "-e", hostProgram], {
      cwd,
      env: {
        ...process.env,
        OCTO_LOOP_CWD: cwd,
        OCTO_LOOP_PLUGIN: pluginPath,
        OCTO_CONFIG_DIR: join(cwd, ".octo-config"),
        OCTO_TOKEN: "bf_loop_test_fixture",
        OCTO_BOT_ID: "",
        OCTO_BOT_TOKEN: "",
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
    const resultLine = stdout.split(/\\r?\\n/).find(line => line.startsWith("OCTO_LOOP_READ_HOST_RESULT "));
    expect(resultLine, stdout).toBeDefined();
    const result = JSON.parse(resultLine!.slice("OCTO_LOOP_READ_HOST_RESULT ".length));
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Loop fixture workspace");
    expect(gateway.requests.some(request => request.path === "/fleet/api/v1/workspaces" && request.method === "GET")).toBe(true);
  } finally {
    gateway.server.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("real OMP routes Loop workspace, tasks, comments and guarded writes through octo-cli", async () => {
  const gateway = startGateway();
  const cwd = await mkdtemp(join(tmpdir(), "omp-octo-loop-"));
  const profileHome = await mkdtemp(join(tmpdir(), "omp-octo-loop-profile-"));
  const approvalHookPath = join(cwd, "loop-approval-race-hook.ts");
  await writeFile(approvalHookPath, `
export default function (pi) {
  pi.on("tool_approval_requested", async event => {
    if (event.toolCallId !== "concurrent-loop-A" && event.toolCallId !== "loop-before-local-B") return;
    const response = await fetch(process.env.OCTO_LOOP_GATEWAY + "/__hold_approval_a", { method: "POST" });
    if (!response.ok) throw new Error("Loop approval race gate failed: " + response.status);
  });
}
`);
  const pluginPath = resolve(import.meta.dir, "../src/index.ts");
  const sdkPath = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/index.ts");
  const runtimeInitPath = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/modes/runtime-init.ts");

  const hostProgram = `
import * as sdk from ${JSON.stringify(sdkPath)};
import * as runtime from ${JSON.stringify(runtimeInitPath)};
const { AgentRegistry, Settings, SessionManager, createAgentSession } = sdk;
const cwd = process.env.OCTO_LOOP_CWD;
const gateway = process.env.OCTO_LOOP_GATEWAY;
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const address = typeof input === "string" || input instanceof URL ? input : input.url;
  const url = new URL(address);
  if (!loopbackHosts.has(url.hostname)) throw new Error("Loop integration test blocked non-loopback request to " + url.origin);
  return realFetch(input, init);
};
const sessions = [];
async function openSession(name, options = {}) {
  const settings = Settings.isolated({
    "edit.enforceSeenLines": false,
    "tools.approvalMode": options.approvalMode || "write",
    "tools.approval": options.approval || {},
    "tools.xdev": true,
    "edit.mode": "hashline",
    "plan.enabled": true,
  });
  const created = await createAgentSession({
    cwd,
    agentDir: cwd + "/.agent-" + name,
    sessionManager: SessionManager.inMemory(cwd),
    settings,
    additionalExtensionPaths: [process.env.OCTO_LOOP_PLUGIN, ...(options.extensionPaths || [])],
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
  });
  const session = created.session;
  sessions.push(session);
  const approvalCapture = options.approvalCapture;
  const uiContext = approvalCapture ? {
    select: async () => undefined,
    approve: async prompt => {
      const captured = { full: prompt.full, compact: prompt.compact };
      if (approvalCapture.beforeAnswer) await approvalCapture.beforeAnswer(captured);
      approvalCapture.prompts.push(captured);
      if (approvalCapture.gate) {
        approvalCapture.gate.started.resolve(captured);
        await approvalCapture.gate.release.promise;
      }
      return approvalCapture.answer || "once";
    },
  } : undefined;
  await runtime.initializeExtensions(session, {
    mode: "rpc",
    uiContext,
    reportSendError: (_action, error) => console.error(error.message),
    reportRuntimeError: error => console.error(error.error),
  });
  await session.runToolRegistryMutation(async () => {});
  return session;
}
function flatten(result) {
  if (!result) return { missing: true, isError: true, text: "tool result missing" };
  return {
    isError: result.isError === true,
    text: (result.content || []).filter(block => typeof block.text === "string").map(block => block.text).join("\\n"),
  };
}
async function invoke(name, args, callId, target, invocation = {}) {
  const session = target || primary;
  const tool = session.getToolByName(name);
  if (!tool || typeof tool.execute !== "function") return { missing: true, isError: true, text: name + " is not registered" };
  try {
    return flatten(await tool.execute(callId, args, invocation.signal, undefined, invocation.context));
  } catch (error) {
    return { isError: true, thrown: true, text: error instanceof Error ? error.message : String(error) };
  }
}
async function control(path, body) {
  return fetch(gateway + path, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function loginDefaultProfile(botId, token) {
  const env = {
    ...process.env,
    HOME: process.env.OCTO_LOOP_PROFILE_HOME,
    XDG_CONFIG_HOME: process.env.OCTO_LOOP_PROFILE_HOME + "/config",
    XDG_DATA_HOME: process.env.OCTO_LOOP_PROFILE_HOME + "/data",
  };
  for (const key of ["OCTO_TOKEN", "OCTO_BOT_TOKEN", "OCTO_BOT_ID", "OCTO_TASK_TOKEN", "OCTO_CREDENTIAL_MODE"]) delete env[key];
  const login = Bun.spawn(["octo-cli", "auth", "login", "--profile", "default", "--bot-id", botId, "--with-token"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  login.stdin.write(token + "\\n");
  login.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(login.stdout).text(),
    new Response(login.stderr).text(),
    login.exited,
  ]);
  if (exitCode !== 0) throw new Error("Temporary Loop profile login failed: " + stdout + stderr);
}
function header(text) {
  return text.split(/\\r?\\n/).find(line => /^\\[[^\\]\\r\\n]+#[0-9a-f]{4}\\]$/i.test(line)) || "";
}
function patch(headerLine, line, replacement) {
  return "*** Begin Patch\\n" + headerLine + "\\nPUT " + line + ".=" + line + ":\\n+" + replacement + "\\n*** End Patch";
}
async function waitForCommentPage(pending) {
  const controller = new AbortController();
  const waiting = fetch(gateway + "/__wait_comment_page_started", { signal: controller.signal })
    .then(response => response.status === 204)
    .catch(() => false);
  const started = await Promise.race([waiting, pending.then(() => false)]);
  if (!started) controller.abort();
  return started;
}
async function waitForCommentCreate(pending) {
  const controller = new AbortController();
  const waiting = fetch(gateway + "/__wait_comment_create_started", { signal: controller.signal })
    .then(response => response.status === 204)
    .catch(() => false);
  const started = await Promise.race([waiting, pending.then(() => false)]);
  if (!started) controller.abort();
  return started;
}
async function waitForApprovalAGate(pending) {
  const controller = new AbortController();
  const waiting = fetch(gateway + "/__wait_approval_a_started", { signal: controller.signal })
    .then(response => response.status === 204)
    .catch(() => false);
  const started = await Promise.race([waiting, pending.then(() => false)]);
  if (!started) controller.abort();
  return started;
}
const primaryApproval = { prompts: [], answer: "once" };
const primary = await openSession("primary", { approvalCapture: primaryApproval });
const root = "octo://loop/workspaces/${WORKSPACE_ID}";
const tasksPath = root + "/tasks";
const taskPath = tasksPath + "/${TASK_ID}";
const unknownTaskPath = tasksPath + "/${UNKNOWN_TASK_ID}";
const commentsPath = taskPath + "/comments";
const unknownTaskCommentsPath = unknownTaskPath + "/comments";
const targetCommentPath = commentsPath + "/${TARGET_COMMENT_ID}";
const foreignCommentPath = commentsPath + "/${OTHER_COMMENT_ID}";
const newCommentPath = commentsPath + "/new";
const unknownTaskCommentPath = unknownTaskCommentsPath + "/new";
const replyPath = commentsPath + "/${PARENT_COMMENT_ID}/replies/new";
const result = { reads: {}, snapshots: {}, identity: {}, writes: {}, plan: {}, approval: {}, failures: {} };
try {
  result.reads.workspaces = await invoke("read", { path: "octo://loop/workspaces" }, "workspace-list");
  result.reads.tasks = await invoke("read", { path: tasksPath }, "task-list");
  result.reads.task = await invoke("read", { path: taskPath }, "task-detail");
  result.reads.comments = await invoke("read", { path: commentsPath }, "comment-list");
  result.reads.comment = await invoke("read", { path: targetCommentPath }, "comment-body");
  result.reads.uppercaseComment = await invoke("read", {
    path: "octo://loop/workspaces/${WORKSPACE_ID.toUpperCase()}/tasks/${TASK_ID.toUpperCase()}/comments/${TARGET_COMMENT_ID.toUpperCase()}",
  }, "uppercase-comment-id");
  result.reads.foreignComment = await invoke("read", { path: "octo://loop/workspaces/${WORKSPACE_ID}/tasks/${OTHER_TASK_ID}/comments/${OTHER_COMMENT_ID}" }, "other-task-comment");
  result.reads.wrongTaskComment = await invoke("read", { path: foreignCommentPath }, "wrong-task-comment");
  result.reads.unknownTask = await invoke("read", { path: unknownTaskPath }, "unknown-task-detail");
  result.reads.unknownTaskComments = await invoke("read", { path: unknownTaskCommentsPath }, "unknown-task-comments");

  const switchBefore = await (await fetch(gateway + "/__stats")).json();
  await primary.extensionRunner.emit({ type: "session_switch", reason: "new" });
  result.snapshots.sessionSwitchWrite = await invoke("write", { path: targetCommentPath, content: "Session switched overwrite" }, "session-switch-write");
  const switchAfter = await (await fetch(gateway + "/__stats")).json();
  result.snapshots.sessionSwitchCommentPageReads = switchAfter.commentPageRequests - switchBefore.commentPageRequests;
  result.reads.afterSessionSwitch = await invoke("read", { path: targetCommentPath }, "read-after-session-switch");

  const identitySession = await openSession("identity-b", { toolNames: ["read", "write", "edit"] });
  const originalToken = process.env.OCTO_TOKEN;
  try {
    process.env.OCTO_TOKEN = "bf_loop_identity_b";
    result.identity.otherIdentityRead = await invoke("read", { path: targetCommentPath }, "other-identity-read", identitySession);
    result.identity.changedIdentityWrite = await invoke("write", { path: targetCommentPath, content: "Cross-identity overwrite" }, "changed-identity-write");
  } finally {
    process.env.OCTO_TOKEN = originalToken;
  }
  result.writes.unknownTaskCreate = await invoke("write", {
    path: unknownTaskCommentPath,
    content: JSON.stringify({ content: "Unknown task comment", attachment_ids: [], suppress_expert_ids: [] }),
  }, "unknown-task-create");
  result.reads.wrongTaskWrite = await invoke("write", { path: foreignCommentPath, content: "Cross-task overwrite" }, "wrong-task-write");

  const unread = await openSession("unread-write", { toolNames: ["read", "write", "edit"] });
  const beforeUnread = await (await fetch(gateway + "/__stats")).json();
  result.snapshots.unreadWrite = await invoke("write", { path: targetCommentPath, content: "Must be rejected before update" }, "unread-write", unread);
  const afterUnread = await (await fetch(gateway + "/__stats")).json();
  result.snapshots.unreadCommentPageReads = afterUnread.commentPageRequests - beforeUnread.commentPageRequests;

  result.snapshots.baselineBeforeWriteRace = await invoke("read", { path: targetCommentPath }, "baseline-before-write-race");
  await control("/__hold_next_comment_page");
  const pendingWrite = invoke("write", { path: targetCommentPath, content: "Client replacement based on A" }, "write-race-A");
  result.snapshots.writeRecheckStarted = await waitForCommentPage(pendingWrite);
  await control("/__set_comment", { content: "Remote B line 1\\nRemote B line 2" });
  result.snapshots.concurrentReadB = await invoke("read", { path: targetCommentPath }, "concurrent-read-B");
  await control("/__release_comment_page");
  result.snapshots.writeRace = await pendingWrite;

  await control("/__hold_next_comment_page");
  const pendingEdit = invoke("edit", { input: patch(header(result.snapshots.concurrentReadB.text), 1, "Client edit based on B") }, "edit-race-B");
  result.snapshots.editRecheckStarted = await waitForCommentPage(pendingEdit);
  await control("/__set_comment", { content: "Remote C line 1\\nRemote C line 2" });
  result.snapshots.concurrentReadC = await invoke("read", { path: targetCommentPath }, "concurrent-read-C");
  await control("/__release_comment_page");
  result.snapshots.editRace = await pendingEdit;

  result.writes.replace = await invoke("write", { path: targetCommentPath, content: "Whole replacement verified" }, "comment-update-write");
  result.reads.afterReplace = await invoke("read", { path: targetCommentPath }, "comment-after-replace");
  result.writes.hashlineEdit = await invoke("edit", {
    input: patch(header(result.reads.afterReplace.text), 1, "Hashline edit verified"),
  }, "comment-update-edit");
  result.reads.beforeUnknownUpdate = await invoke("read", { path: targetCommentPath }, "comment-before-unknown-update");
  result.writes.updateOutcomeUnknown = await invoke("write", { path: targetCommentPath, content: "Update outcome unknown" }, "comment-update-unknown");

  result.writes.createMissingPreview = await invoke("write", {
    path: newCommentPath,
    content: JSON.stringify({ content: "Preview missing authority", attachment_ids: ["${ATTACHMENT_ID}"], suppress_expert_ids: [] }),
  }, "comment-create-missing-preview");
  result.writes.create = await invoke("write", {
    path: newCommentPath,
    content: JSON.stringify({ content: "Create with attachment", attachment_ids: ["${ATTACHMENT_ID}"], suppress_expert_ids: [] }),
  }, "comment-create");
  result.writes.reply = await invoke("write", {
    path: replyPath,
    content: JSON.stringify({ content: "Reply with attachment", attachment_ids: ["${ATTACHMENT_ID}"], suppress_expert_ids: [] }),
  }, "comment-reply");
  result.writes.replyConflictingParent = await invoke("write", {
    path: replyPath,
    content: JSON.stringify({
      content: "Conflicting parent must not override reply path",
      parent_comment_id: "${OTHER_COMMENT_ID}",
      attachment_ids: [],
      suppress_expert_ids: [],
    }),
  }, "reply-conflicting-parent");
  result.writes.injection = await invoke("write", {
    path: newCommentPath,
    content: JSON.stringify({
      content: ${JSON.stringify(INJECTION_CONTENT)},
      attachment_ids: [],
      suppress_expert_ids: [],
    }),
  }, "comment-injection-literal");
  result.writes.createOutcomeUnknown = await invoke("write", {
    path: newCommentPath,
    content: JSON.stringify({ content: "Create outcome unknown", attachment_ids: [], suppress_expert_ids: [] }),
  }, "comment-create-unknown");
  result.writes.replyPreviewFailure = await invoke("write", {
    path: replyPath,
    content: JSON.stringify({ content: "Preview transport failure", attachment_ids: ["${ATTACHMENT_ID}"], suppress_expert_ids: [] }),
  }, "comment-reply-preview-failure");
  const tamperGate = {
    started: Promise.withResolvers(),
    release: Promise.withResolvers(),
  };
  const tamperApproval = { prompts: [], answer: "once", gate: tamperGate };
  const tamperSession = await openSession("tamper", { approvalMode: "yolo", approvalCapture: tamperApproval });
  const tamperArgs = {
    path: newCommentPath,
    content: JSON.stringify({
      content: "Approved original parameters",
      attachment_ids: ["${ATTACHMENT_ID}"],
      suppress_expert_ids: ["${SUPPRESS_EXPERT_ID}"],
    }),
  };
  const pendingTamper = invoke("write", tamperArgs, "comment-tamper-after-preview", tamperSession);
  result.approval.tamperPrompt = await Promise.race([
    tamperGate.started.promise,
    pendingTamper.then(() => null),
  ]);
  if (result.approval.tamperPrompt) {
    tamperArgs.content = JSON.stringify({
      content: "Mutated after approval prompt",
      attachment_ids: [],
      suppress_expert_ids: [],
    });
    tamperGate.release.resolve();
  }
  result.approval.tamper = await pendingTamper;
  result.approval.tamperPromptCount = tamperApproval.prompts.length;
  const editTamperGate = {
    started: Promise.withResolvers(),
    release: Promise.withResolvers(),
  };
  const editTamperApproval = { prompts: [], answer: "once", gate: editTamperGate };
  const editTamperSession = await openSession("edit-tamper", {
    approvalMode: "yolo",
    approvalCapture: editTamperApproval,
    toolNames: ["read", "write", "edit"],
  });
  result.approval.editTamperTargetBaseline = await invoke(
    "read",
    { path: targetCommentPath },
    "edit-tamper-target-baseline",
    editTamperSession,
  );
  result.approval.editTamperOtherBaseline = await invoke(
    "read",
    { path: "octo://loop/workspaces/${WORKSPACE_ID}/tasks/${OTHER_TASK_ID}/comments/${OTHER_COMMENT_ID}" },
    "edit-tamper-other-baseline",
    editTamperSession,
  );
  const editTamperArgs = {
    input: patch(header(result.approval.editTamperTargetBaseline.text), 1, "Approved edit original"),
  };
  const editTamperUpdatesBefore = (await (await fetch(gateway + "/__stats")).json()).commentUpdateRequests;
  const pendingEditTamper = invoke("edit", editTamperArgs, "edit-tamper-after-approval", editTamperSession);
  result.approval.editTamperPrompt = await Promise.race([
    editTamperGate.started.promise,
    pendingEditTamper.then(() => null),
  ]);
  if (result.approval.editTamperPrompt) {
    editTamperArgs.input = patch(
      header(result.approval.editTamperOtherBaseline.text),
      1,
      "Mutated edit target after approval",
    );
    editTamperGate.release.resolve();
  }
  result.approval.editTamper = await pendingEditTamper;
  const editTamperUpdatesAfter = (await (await fetch(gateway + "/__stats")).json()).commentUpdateRequests;
  result.approval.editTamperPatchCount = editTamperUpdatesAfter - editTamperUpdatesBefore;
  result.approval.editTamperPromptCount = editTamperApproval.prompts.length;
  await control("/__set_comment", { content: "Update outcome unknown" });

  const mandatoryApproval = { prompts: [], answer: "once" };
  const mandatory = await openSession("mandatory-approval", {
    approvalMode: "yolo",
    approvalCapture: mandatoryApproval,
  });
  result.approval.yoloCreate = await invoke("write", {
    path: newCommentPath,
    content: JSON.stringify({
      content: "Yolo still requires approval",
      attachment_ids: ["${ATTACHMENT_ID}"],
      suppress_expert_ids: ["${SUPPRESS_EXPERT_ID}"],
    }),
  }, "yolo-mandatory-create", mandatory);
  result.approval.yoloPrompt = mandatoryApproval.prompts[0] || null;
  const headless = await openSession("headless-yolo", { approvalMode: "yolo" });
  result.approval.noUiCreate = await invoke("write", {
    path: newCommentPath,
    content: JSON.stringify({ content: "Headless approval must fail closed", attachment_ids: [], suppress_expert_ids: [] }),
  }, "headless-yolo-create", headless);
  const acpApproval = { prompts: [], answer: "once" };
  const acp = await openSession("acp-allow-always", {
    approvalMode: "yolo",
    approvalCapture: acpApproval,
  });
  const acpApprovedArgs = {
    path: newCommentPath,
    content: JSON.stringify({ content: "ACP allow_always must still prompt", attachment_ids: [], suppress_expert_ids: [] }),
  };
  result.approval.acpAllowAlways = await invoke(
    "write",
    acpApprovedArgs,
    "acp-allow-always",
    acp,
    { context: { acpApprovedArgs } },
  );
  result.approval.acpAllowAlwaysPrompts = acpApproval.prompts;

  const concurrentApproval = { prompts: [], answer: "once" };
  const concurrent = await openSession("concurrent-approval", {
    approvalMode: "yolo",
    approvalCapture: concurrentApproval,
    extensionPaths: [process.env.OCTO_LOOP_APPROVAL_HOOK],
  });
  const concurrentArgsA = {
    path: newCommentPath,
    content: JSON.stringify({ content: "Concurrent preview A", attachment_ids: [], suppress_expert_ids: [] }),
  };
  const concurrentArgsB = {
    path: newCommentPath,
    content: JSON.stringify({ content: "Concurrent preview B", attachment_ids: [], suppress_expert_ids: [] }),
  };
  const pendingConcurrentA = invoke("write", concurrentArgsA, "concurrent-loop-A", concurrent);
  result.approval.concurrentGateStarted = await waitForApprovalAGate(pendingConcurrentA);
  const pendingConcurrentB = invoke("write", concurrentArgsB, "concurrent-loop-B", concurrent);
  result.approval.concurrentB = await pendingConcurrentB;
  result.approval.concurrentBPromptWhileAWaiting = concurrentApproval.prompts.some(
    prompt => prompt.full.includes("Concurrent preview B"),
  );
  await control("/__release_approval_a");
  result.approval.concurrentA = await pendingConcurrentA;
  result.approval.concurrentPrompts = concurrentApproval.prompts;
  await control("/__reset_approval_a");
  const localWriteRacePath = cwd + "/local-write-race.txt";
  await Bun.write(localWriteRacePath, "Local original content");
  const pendingLoopWriteDuringLocal = invoke("write", {
    path: newCommentPath,
    content: JSON.stringify({ content: "Loop write during local write B", attachment_ids: [], suppress_expert_ids: [] }),
  }, "loop-before-local-B", concurrent);
  result.approval.localWriteRaceGateStarted = await waitForApprovalAGate(pendingLoopWriteDuringLocal);
  result.approval.localWriteB = await invoke(
    "write",
    { path: localWriteRacePath, content: "Local write B content" },
    "local-write-B",
    concurrent,
  );
  result.approval.localWriteBContent = await Bun.file(localWriteRacePath).text();
  await control("/__release_approval_a");
  result.approval.localWriteLoopA = await pendingLoopWriteDuringLocal;
  result.approval.concurrentPrompts = concurrentApproval.prompts;

  const abortController = new AbortController();
  const abortApproval = {
    prompts: [],
    answer: "once",
    beforeAnswer: async () => abortController.abort(new DOMException("cancelled before submission", "AbortError")),
  };
  const abortSession = await openSession("abort-before-spawn", {
    approvalMode: "yolo",
    approvalCapture: abortApproval,
  });
  result.failures.abortBeforeSpawn = await invoke(
    "write",
    { path: newCommentPath, content: JSON.stringify({ content: "Aborted before CLI spawn", attachment_ids: [], suppress_expert_ids: [] }) },
    "abort-before-cli-spawn",
    abortSession,
    { signal: abortController.signal },
  );
  result.failures.abortBeforeSpawnPromptCount = abortApproval.prompts.length;


  const beforePlan = (await (await fetch(gateway + "/__stats")).json()).commentPageRequests;
  primary.setPlanModeState({ enabled: true, planFilePath: cwd + "/PLAN.md" });
  result.plan.create = await invoke("write", {
    path: newCommentPath,
    content: JSON.stringify({ content: "Plan mode comment", attachment_ids: [], suppress_expert_ids: [] }),
  }, "plan-comment-create");
  result.plan.reply = await invoke("write", {
    path: replyPath,
    content: JSON.stringify({ content: "Plan mode reply", attachment_ids: [], suppress_expert_ids: [] }),
  }, "plan-comment-reply");
  primary.setPlanModeState(undefined);
  result.plan.commentPageReads = (await (await fetch(gateway + "/__stats")).json()).commentPageRequests - beforePlan;

  const deniedApproval = { prompts: [], answer: "deny" };
  const denied = await openSession("denied", {
    approvalMode: "yolo",
    approvalCapture: deniedApproval,
    toolNames: ["read", "write", "edit"],
  });
  result.approval.create = await invoke("write", {
    path: newCommentPath,
    content: JSON.stringify({ content: "Denied comment", attachment_ids: [], suppress_expert_ids: [] }),
  }, "denied-comment-create", denied);
  result.approval.reply = await invoke("write", {
    path: replyPath,
    content: JSON.stringify({ content: "Denied reply", attachment_ids: [], suppress_expert_ids: [] }),
  }, "denied-comment-reply", denied);

  await control("/__fail_comment_page_two");
  result.failures.partialCommentList = await invoke("read", { path: commentsPath }, "comment-page-two-failure");
  await control("/__allow_comment_page_two");
  await control("/__set_empty_final_page", { resource: "workspaces" });
  result.failures.emptyFinalWorkspaceList = await invoke("read", { path: "octo://loop/workspaces" }, "empty-final-workspace-page");
  await control("/__set_empty_final_page", { resource: "tasks" });
  result.failures.emptyFinalTaskList = await invoke("read", { path: tasksPath }, "empty-final-task-page");
  await control("/__set_empty_final_page", { resource: "comments" });
  result.failures.emptyFinalCommentList = await invoke("read", { path: commentsPath }, "empty-final-comment-page");
  await control("/__clear_empty_final_page");
  const profileEnvKeys = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "OCTO_TOKEN",
    "OCTO_BOT_TOKEN",
    "OCTO_BOT_ID",
    "OCTO_TASK_TOKEN",
    "OCTO_CREDENTIAL_MODE",
    "OCTO_CONFIG_DIR",
  ];
  const savedProfileEnv = new Map(profileEnvKeys.map(key => [key, process.env[key]]));
  try {
    process.env.HOME = process.env.OCTO_LOOP_PROFILE_HOME;
    process.env.XDG_CONFIG_HOME = process.env.OCTO_LOOP_PROFILE_HOME + "/config";
    process.env.XDG_DATA_HOME = process.env.OCTO_LOOP_PROFILE_HOME + "/data";
    for (const key of profileEnvKeys.slice(3)) delete process.env[key];
    process.env.OCTO_CONFIG_DIR = process.env.OCTO_LOOP_PROFILE_HOME;
    await loginDefaultProfile("ob_loop_profile_a", "bf_loop_profile_a");
    const profileApproval = {
      prompts: [],
      answer: "once",
      beforeAnswer: async () => loginDefaultProfile("ob_loop_profile_b", "bf_loop_profile_b"),
    };
    const profileSession = await openSession("profile-change-during-approval", {
      approvalMode: "yolo",
      approvalCapture: profileApproval,
    });
    result.identity.profileChangedWrite = await invoke(
      "write",
      { path: newCommentPath, content: JSON.stringify({ content: "Profile identity changed during approval", attachment_ids: [], suppress_expert_ids: [] }) },
      "profile-change-during-approval",
      profileSession,
    );
    result.identity.profileChangedPrompt = profileApproval.prompts[0] || null;
    await loginDefaultProfile("ob_loop_profile_a", "bf_loop_profile_a");
    const profileUpdateApproval = {
      prompts: [],
      answer: "once",
      beforeAnswer: async () => loginDefaultProfile("ob_loop_profile_b", "bf_loop_profile_b"),
    };
    const profileUpdateSession = await openSession("profile-update-change-during-approval", {
      approvalMode: "yolo",
      approvalCapture: profileUpdateApproval,
    });
    result.identity.profileUpdateBaseline = await invoke(
      "read",
      { path: targetCommentPath },
      "profile-update-baseline",
      profileUpdateSession,
    );
    result.identity.profileChangedUpdate = await invoke(
      "write",
      { path: targetCommentPath, content: "Profile update identity changed during approval" },
      "profile-update-change-during-approval",
      profileUpdateSession,
    );
    result.identity.profileChangedUpdatePrompt = profileUpdateApproval.prompts[0] || null;
  } finally {
    for (const [key, value] of savedProfileEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const taskModeEnvKeys = [
    "OCTO_TOKEN",
    "OCTO_BOT_TOKEN",
    "OCTO_BOT_ID",
    "OCTO_TASK_TOKEN",
    "OCTO_CREDENTIAL_MODE",
    "OCTO_CONFIG_DIR",
  ];
  const savedTaskModeEnv = new Map(taskModeEnvKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of ["OCTO_TOKEN", "OCTO_BOT_TOKEN", "OCTO_BOT_ID"]) delete process.env[key];
    process.env.OCTO_CREDENTIAL_MODE = "task";
    process.env.OCTO_TASK_TOKEN = "bf_loop_task_mode";
    process.env.OCTO_CONFIG_DIR = process.env.OCTO_LOOP_PROFILE_HOME + "/not-a-directory";
    await Bun.write(process.env.OCTO_CONFIG_DIR, "deliberately not a profile directory");
    const taskModeSession = await openSession("task-mode-unreadable-profile");
    result.identity.taskModeRead = await invoke("read", { path: commentsPath }, "task-mode-unreadable-profile", taskModeSession);
  } finally {
    for (const [key, value] of savedTaskModeEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const committedContent = "Create committed before session switch";
  await control("/__hold_next_comment_create_response");
  const pendingCommittedCreate = invoke(
    "write",
    { path: newCommentPath, content: JSON.stringify({ content: committedContent, attachment_ids: [], suppress_expert_ids: [] }) },
    "commit-before-session-switch",
  );
  result.failures.committedCreateStarted = await waitForCommentCreate(pendingCommittedCreate);
  await primary.extensionRunner.emit({ type: "session_switch", reason: "new" });
  await control("/__release_comment_create_response");
  result.failures.committedCreateSessionSwitch = await pendingCommittedCreate;
  result.approval.primaryPrompts = primaryApproval.prompts;
  result.approval.deniedPrompts = deniedApproval.prompts;

  console.log("OCTO_LOOP_HOST_RESULT " + JSON.stringify(result));
} finally {
  for (const session of sessions.reverse()) await session.dispose();
}
`;

  try {
    const child = Bun.spawn([process.execPath, "-e", hostProgram], {
      cwd,
      env: {
        ...process.env,
        PI_EDIT_VARIANT: "hashline",
        PI_STRICT_EDIT_MODE: "1",
        OCTO_LOOP_CWD: cwd,
        OCTO_LOOP_GATEWAY: `http://127.0.0.1:${gateway.server.port}`,
        OCTO_LOOP_PLUGIN: pluginPath,
        OCTO_LOOP_APPROVAL_HOOK: approvalHookPath,
        OCTO_LOOP_PROFILE_HOME: profileHome,
        OCTO_CONFIG_DIR: profileHome,
        OCTO_BOT_ID: "",
        OCTO_TOKEN: "bf_loop_test_fixture",
        OCTO_BOT_TOKEN: "",
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
    const resultLine = stdout.split(/\r?\n/).find(line => line.startsWith("OCTO_LOOP_HOST_RESULT "));
    expect(resultLine, stdout).toBeDefined();
    const result = JSON.parse(resultLine!.slice("OCTO_LOOP_HOST_RESULT ".length));

    expect(result.reads.workspaces.isError).toBe(false);
    expect(result.reads.workspaces.text).toContain("Loop fixture workspace");
    expect(result.reads.tasks.isError).toBe(false);
    expect(result.reads.tasks.text).toContain("Loop fixture task");
    expect(result.reads.task.isError).toBe(false);
    expect(result.reads.task.text).toContain("Task detail");
    expect(result.reads.comments.isError).toBe(false);
    expect(result.reads.comments.text).toContain(TARGET_COMMENT_ID);
    expect(result.reads.comments.text).toContain(PARENT_COMMENT_ID);
    expect(result.reads.comments.text).toContain(ATTACHMENT_ID);
    expect(gateway.commentPages.some(page => page.taskId === TASK_ID && page.page === 2)).toBe(true);
    expect(result.reads.comment.isError).toBe(false);
    expect(result.reads.comment.text).toContain("Comment A line 1");
    expect(result.reads.uppercaseComment.isError).toBe(false);
    expect(result.reads.uppercaseComment.text).toContain("Comment A line 1");
    expect(result.reads.foreignComment.isError).toBe(false);
    expect(result.reads.foreignComment.text).toContain("Other task comment");
    expect(result.reads.wrongTaskComment.isError).toBe(true);
    expect(result.reads.wrongTaskWrite.isError).toBe(true);
    expect(result.reads.unknownTask.isError).toBe(true);
    expect(result.reads.unknownTaskComments.isError).toBe(true);
    expect(result.writes.unknownTaskCreate.isError).toBe(true);
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Unknown task comment").length).toBeLessThanOrEqual(1);
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Unknown task comment")).toHaveLength(0);

    expect(gateway.requests.some(request => request.path === "/fleet/api/v1/tasks" && request.workspaceId === WORKSPACE_ID)).toBe(true);
    expect(gateway.requests.some(request => request.path === `/fleet/api/v1/tasks/${TASK_ID}` && request.workspaceId === WORKSPACE_ID)).toBe(true);
    expect(gateway.requests.some(request => request.path === `/fleet/api/v1/tasks/${TASK_ID}/comments` && request.workspaceId === WORKSPACE_ID)).toBe(true);
    expect(result.snapshots.sessionSwitchWrite.isError).toBe(true);
    expect(result.snapshots.sessionSwitchCommentPageReads).toBe(0);
    expect(result.reads.afterSessionSwitch.isError).toBe(false);
    expect(gateway.commentUpdates.filter(request => (request.body as { content?: string } | undefined)?.content === "Session switched overwrite")).toHaveLength(0);
    expect(result.identity.otherIdentityRead.isError).toBe(false);
    expect(result.identity.otherIdentityRead.text).toContain("Comment A line 1");
    expect(gateway.requests.some(request => request.credential?.includes("bf_loop_identity_b"))).toBe(true);
    expect(result.identity.changedIdentityWrite.isError).toBe(true);
    expect(gateway.commentUpdates.filter(request => (request.body as { content?: string } | undefined)?.content === "Cross-identity overwrite")).toHaveLength(0);
    expect(result.identity.profileChangedWrite.isError).toBe(true);
    expect(result.identity.profileChangedWrite.text).toMatch(/identity|profile|credential|session|changed/i);
    expect(result.identity.profileChangedPrompt).toBeDefined();
    const profilePreview = gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Profile identity changed during approval");
    expect(profilePreview).toHaveLength(1);
    expect(profilePreview[0]!.credential).toContain("bf_loop_profile_a");
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Profile identity changed during approval")).toHaveLength(0);
    expect(result.identity.profileChangedUpdate.isError).toBe(true);
    expect(result.identity.profileChangedUpdate.text, JSON.stringify(result.identity.profileUpdateBaseline)).toMatch(/identity|profile|credential|session|changed/i);
    expect(result.identity.profileUpdateBaseline.isError).toBe(false);
    expect(result.identity.profileChangedUpdatePrompt).toBeDefined();
    expect(result.identity.profileChangedUpdatePrompt.full).toContain("Profile update identity changed during approval");
    expect(gateway.commentUpdates.filter(request => (request.body as { content?: string } | undefined)?.content === "Profile update identity changed during approval")).toHaveLength(0);
    expect(gateway.requests.some(request =>
      request.method === "GET" &&
      request.path === `/fleet/api/v1/tasks/${TASK_ID}/comments` &&
      request.credential?.includes("bf_loop_profile_a"),
    )).toBe(true);
    expect(result.identity.taskModeRead.isError).toBe(false);
    expect(gateway.requests.some(request =>
      request.method === "GET" &&
      request.path === `/fleet/api/v1/tasks/${TASK_ID}/comments` &&
      request.credential?.includes("bf_loop_task_mode"),
    )).toBe(true);

    expect(result.snapshots.baselineBeforeWriteRace.isError).toBe(false);
    expect(result.snapshots.baselineBeforeWriteRace.text).toContain("Comment A line 1");
    expect(result.snapshots.unreadWrite.isError).toBe(true);
    expect(result.snapshots.unreadWrite.text).toMatch(/read|snapshot/i);
    expect(result.snapshots.unreadCommentPageReads).toBe(0);
    expect(result.snapshots.writeRecheckStarted, JSON.stringify(result.snapshots.writeRace)).toBe(true);
    expect(result.snapshots.concurrentReadB.text).toContain("Remote B line 1");
    expect(result.snapshots.writeRace.isError).toBe(true);
    expect(result.snapshots.writeRace.text).toMatch(/changed|stale|conflict|re.?read/i);
    expect(result.snapshots.editRecheckStarted, JSON.stringify(result.snapshots.editRace)).toBe(true);
    expect(result.snapshots.concurrentReadC.text).toContain("Remote C line 1");
    expect(result.snapshots.editRace.isError).toBe(true);
    expect(result.snapshots.editRace.text).toMatch(/changed|stale|conflict|re.?read/i);
    expect(gateway.commentUpdates.filter(request => (request.body as { content?: string } | undefined)?.content === "Cross-task overwrite")).toHaveLength(0);
    expect(result.writes.replace.isError).toBe(false);
    expect(result.writes.hashlineEdit.isError).toBe(false);
    expect(gateway.commentUpdates.filter(request => (request.body as { content?: string } | undefined)?.content === "Client replacement based on A")).toHaveLength(0);
    expect(gateway.commentUpdates.filter(request => (request.body as { content?: string } | undefined)?.content === "Client edit based on B")).toHaveLength(0);
    expect(gateway.commentUpdates.filter(request => request.path === `/fleet/api/v1/comments/${TARGET_COMMENT_ID}`)).toHaveLength(3);
    expect(result.approval.editTamperTargetBaseline.isError).toBe(false);
    expect(result.approval.editTamperOtherBaseline.isError).toBe(false);
    expect(result.approval.editTamperPrompt).toBeDefined();
    expect(result.approval.editTamperPrompt.full).toContain("Approved edit original");
    expect(result.approval.editTamperPromptCount).toBe(1);
    expect(result.approval.editTamper.isError).toBe(true);
    expect(result.approval.editTamper.text).toMatch(/changed after preview|no mutation was submitted/i);
    expect(result.approval.editTamperPatchCount).toBe(0);
    expect(gateway.commentUpdates.find(request => (request.body as { content?: string } | undefined)?.content === "Whole replacement verified")?.body).toEqual({ content: "Whole replacement verified" });
    expect(gateway.commentUpdates.find(request => (request.body as { content?: string } | undefined)?.content === "Hashline edit verified")?.body).toEqual({ content: "Hashline edit verified" });
    expect(result.writes.updateOutcomeUnknown.isError).toBe(true);
    expect(result.writes.updateOutcomeUnknown.text).toMatch(/unknown|uncertain|re.?read|verify/i);
    expect(gateway.commentUpdates.every(request => request.workspaceId === WORKSPACE_ID)).toBe(true);
    expect(gateway.commentUpdates.filter(request => (request.body as { content?: string } | undefined)?.content === "Update outcome unknown")).toHaveLength(1);

    expect(result.writes.createMissingPreview.isError).toBe(true);
    expect(result.writes.create.isError).toBe(false);
    expect(result.writes.reply.isError).toBe(false);
    expect(result.writes.createOutcomeUnknown.isError).toBe(true);
    expect(result.writes.createOutcomeUnknown.text).toMatch(/unknown|uncertain|re.?read|verify/i);
    expect(result.writes.replyPreviewFailure.isError).toBe(true);
    expect(result.approval.primaryPrompts.some((prompt: ApprovalPrompt) => prompt.full.includes("Preview missing authority"))).toBe(false);
    expect(result.approval.primaryPrompts.some((prompt: ApprovalPrompt) => prompt.full.includes("Preview transport failure"))).toBe(false);
    expect(result.writes.replyConflictingParent.isError).toBe(true);
    expect(result.writes.injection.isError).toBe(false);
    const injectionBody = {
      content: INJECTION_CONTENT,
      attachment_ids: [],
      suppress_expert_ids: [],
    };
    const injectionPreview = gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === INJECTION_CONTENT);
    const injectionCreate = gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === INJECTION_CONTENT);
    expect(injectionPreview).toHaveLength(1);
    expect(injectionCreate).toHaveLength(1);
    expect(injectionPreview[0]!.body).toEqual(injectionBody);
    expect(injectionCreate[0]!.body).toEqual(injectionBody);
    expect(injectionPreview[0]!.path).toBe(`/fleet/api/v1/tasks/${TASK_ID}/comments/_trigger_preview`);
    expect(injectionCreate[0]!.path).toBe(`/fleet/api/v1/tasks/${TASK_ID}/comments`);
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Conflicting parent must not override reply path")).toHaveLength(0);
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Conflicting parent must not override reply path")).toHaveLength(0);
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Preview missing authority")).toHaveLength(1);
    expect(gateway.previewRequests.find(request => (request.body as { content?: string } | undefined)?.content === "Preview missing authority")?.body).toMatchObject({
      content: "Preview missing authority",
      attachment_ids: [ATTACHMENT_ID],
      suppress_expert_ids: [],
    });
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Create with attachment")).toHaveLength(1);
    expect(gateway.previewRequests.find(request => (request.body as { content?: string } | undefined)?.content === "Create with attachment")?.body).toMatchObject({
      content: "Create with attachment",
      attachment_ids: [ATTACHMENT_ID],
      suppress_expert_ids: [],
    });
    expect(gateway.previewRequests.find(request => (request.body as { content?: string } | undefined)?.content === "Create with attachment")?.body).toEqual(gateway.commentCreates.find(request => (request.body as { content?: string } | undefined)?.content === "Create with attachment")?.body);
    expect(gateway.previewRequests.find(request => (request.body as { content?: string } | undefined)?.content === "Reply with attachment")?.body).toEqual(gateway.commentCreates.find(request => (request.body as { content?: string } | undefined)?.content === "Reply with attachment")?.body);
    expect(gateway.previewRequests.find(request => (request.body as { content?: string } | undefined)?.content === "Reply with attachment")?.body).toMatchObject({
      content: "Reply with attachment",
      parent_comment_id: PARENT_COMMENT_ID,
      attachment_ids: [ATTACHMENT_ID],
      suppress_expert_ids: [],
    });
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Preview missing authority" || (request.body as { content?: string } | undefined)?.content === "Preview transport failure")).toHaveLength(0);
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Create with attachment")).toHaveLength(1);
    expect(gateway.commentCreates.find(request => (request.body as { content?: string } | undefined)?.content === "Create with attachment")?.body).toMatchObject({
      attachment_ids: [ATTACHMENT_ID],
      suppress_expert_ids: [],
    });
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Reply with attachment")).toHaveLength(1);
    expect(gateway.commentCreates.find(request => (request.body as { content?: string } | undefined)?.content === "Reply with attachment")?.body).toMatchObject({
      parent_comment_id: PARENT_COMMENT_ID,
      attachment_ids: [ATTACHMENT_ID],
      suppress_expert_ids: [],
    });
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Create outcome unknown")).toHaveLength(1);
    expect(gateway.commentCreates.every(request => request.workspaceId === WORKSPACE_ID)).toBe(true);
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Create outcome unknown")).toHaveLength(1);
    const mandatoryPreview = gateway.previewRequests.find(request => (request.body as { content?: string } | undefined)?.content === "Yolo still requires approval");
    const mandatoryCreate = gateway.commentCreates.find(request => (request.body as { content?: string } | undefined)?.content === "Yolo still requires approval");
    expect(result.approval.yoloCreate.isError).toBe(false);
    expect(result.approval.yoloPrompt).toBeDefined();
    expect(result.approval.yoloPrompt.full).toContain("Yolo still requires approval");
    expect(result.approval.yoloPrompt.full).toContain(TASK_ID);
    expect(result.approval.yoloPrompt.full).toContain(WORKSPACE_ID);
    expect(result.approval.yoloPrompt.full).toContain("comments/new");
    expect(result.approval.yoloPrompt.full).toContain(ATTACHMENT_ID);
    expect(result.approval.yoloPrompt.full).toContain(SUPPRESS_EXPERT_ID);
    expect(result.approval.yoloPrompt.full).toContain("Fixture expert");
    expect(result.approval.yoloPrompt.full).toContain(EXPERT_ID);
    expect(result.approval.yoloPrompt.full).toContain("mention");
    expect(result.approval.yoloPrompt.full).toContain("explicit mention");
    expect(mandatoryPreview?.body).toEqual(mandatoryCreate?.body);
    expect(mandatoryPreview?.body).toEqual({
      content: "Yolo still requires approval",
      attachment_ids: [ATTACHMENT_ID],
      suppress_expert_ids: [SUPPRESS_EXPERT_ID],
    });
    expect(result.approval.noUiCreate.isError).toBe(true);
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Headless approval must fail closed")).toHaveLength(0);
    expect(result.approval.noUiCreate.text).toMatch(/approval|interactive|UI|prompt/i);
    expect(result.approval.acpAllowAlways.isError, JSON.stringify(result.approval.acpAllowAlways)).toBe(false);
    expect(result.approval.acpAllowAlwaysPrompts).toHaveLength(1);
    expect(result.approval.acpAllowAlwaysPrompts[0]!.full).toContain("ACP allow_always must still prompt");
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "ACP allow_always must still prompt")).toHaveLength(1);
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "ACP allow_always must still prompt")).toHaveLength(1);
    expect(gateway.previewRequests.find(request => (request.body as { content?: string } | undefined)?.content === "ACP allow_always must still prompt")?.body)
      .toEqual(gateway.commentCreates.find(request => (request.body as { content?: string } | undefined)?.content === "ACP allow_always must still prompt")?.body);
    expect(result.approval.concurrentGateStarted).toBe(true);
    expect(result.approval.concurrentBPromptWhileAWaiting).toBe(true);
    expect(result.approval.concurrentA.isError).toBe(false);
    expect(result.approval.concurrentB.isError).toBe(false);
    expect(result.approval.localWriteRaceGateStarted).toBe(true);
    expect(result.approval.localWriteB.isError).toBe(false);
    expect(result.approval.localWriteBContent).toBe("Local write B content");
    expect(result.approval.localWriteLoopA.isError).toBe(false);
    expect(result.approval.concurrentPrompts.some((prompt: ApprovalPrompt) => prompt.full.includes("Loop write during local write B"))).toBe(true);
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Loop write during local write B")).toHaveLength(1);
    const concurrentPromptA = result.approval.concurrentPrompts.find((prompt: ApprovalPrompt) => prompt.full.includes("Concurrent preview A"));
    const concurrentPromptB = result.approval.concurrentPrompts.find((prompt: ApprovalPrompt) => prompt.full.includes("Concurrent preview B"));
    expect(concurrentPromptA).toBeDefined();
    expect(concurrentPromptA.full).toContain("Concurrent expert A");
    expect(concurrentPromptA.full).toContain(CONCURRENT_EXPERT_A_ID);
    expect(concurrentPromptA.full).toContain("preview A reason");
    expect(concurrentPromptA.full).not.toContain("Concurrent expert B");
    expect(concurrentPromptA.full).not.toContain(CONCURRENT_EXPERT_B_ID);
    expect(concurrentPromptB).toBeDefined();
    expect(concurrentPromptB.full).toContain("Concurrent expert B");
    expect(concurrentPromptB.full).toContain(CONCURRENT_EXPERT_B_ID);
    expect(concurrentPromptB.full).toContain("preview B reason");
    expect(concurrentPromptB.full).not.toContain("Concurrent expert A");
    expect(concurrentPromptB.full).not.toContain(CONCURRENT_EXPERT_A_ID);
    for (const [content, expertId] of [["Concurrent preview A", CONCURRENT_EXPERT_A_ID], ["Concurrent preview B", CONCURRENT_EXPERT_B_ID]]) {
      const preview = gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === content);
      const create = gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === content);
      expect(preview).toHaveLength(1);
      expect(create).toHaveLength(1);
      expect(preview[0]!.body).toEqual(create[0]!.body);
      expect(result.approval.concurrentPrompts.some((prompt: ApprovalPrompt) => prompt.full.includes(expertId))).toBe(true);
    }
    expect(result.failures.abortBeforeSpawn.isError).toBe(true);
    expect(result.failures.abortBeforeSpawn.text).toMatch(/abort|cancel/i);
    expect(result.failures.abortBeforeSpawn.text).not.toMatch(/outcome is unknown/i);
    expect(result.failures.abortBeforeSpawnPromptCount).toBe(1);
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Aborted before CLI spawn")).toHaveLength(1);
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Aborted before CLI spawn")).toHaveLength(0);
    expect(result.failures.committedCreateStarted).toBe(true);
    expect(result.failures.committedCreateSessionSwitch.isError).toBe(true);
    expect(result.failures.committedCreateSessionSwitch.text).toMatch(/outcome is unknown/i);
    expect(result.failures.committedCreateSessionSwitch.text).toMatch(/do not retry/i);
    expect(gateway.committedCommentContents).toContain("Create committed before session switch");
    expect(gateway.commentCreates.filter(request => (request.body as { content?: string } | undefined)?.content === "Create committed before session switch")).toHaveLength(1);
    expect(result.approval.tamperPrompt).toBeDefined();
    expect(result.approval.tamperPrompt.full).toContain("Approved original parameters");
    for (const resource of ["workspaces", "tasks", "comments"]) {
      expect(gateway.emptyFinalPageRequests).toContainEqual({ resource, page: 1, pageSize: 20, total: 21, dataLength: 20 });
      expect(gateway.emptyFinalPageRequests).toContainEqual({ resource, page: 2, pageSize: 20, total: 21, dataLength: 0 });
    }
    expect(result.failures.emptyFinalWorkspaceList.isError).toBe(true);
    expect(result.failures.emptyFinalWorkspaceList.text).not.toContain("Empty page workspace 1");
    expect(result.failures.emptyFinalTaskList.isError).toBe(true);
    expect(result.failures.emptyFinalTaskList.text).not.toContain("Empty page task 1");
    expect(result.failures.emptyFinalCommentList.isError).toBe(true);
    expect(result.failures.emptyFinalCommentList.text).not.toContain("Empty page comment 1");
    expect(result.approval.tamperPrompt.full).toContain(SUPPRESS_EXPERT_ID);
    expect(result.approval.tamperPromptCount).toBe(1);
    expect(result.approval.tamperPrompt.full).toContain(ATTACHMENT_ID);
    expect(result.approval.tamperPrompt.full).toContain("Fixture expert");
    expect(result.approval.tamperPrompt.full).toContain(EXPERT_ID);
    expect(result.approval.tamper.isError).toBe(true);
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Approved original parameters")).toHaveLength(1);
    expect(gateway.commentCreates.filter(request => ["Approved original parameters", "Mutated after approval prompt"].includes((request.body as { content?: string } | undefined)?.content ?? ""))).toHaveLength(0);
    const primaryCreatePrompt = result.approval.primaryPrompts.find((prompt: ApprovalPrompt) => prompt.full.includes("Create with attachment"));
    const primaryUpdatePrompt = result.approval.primaryPrompts.find((prompt: ApprovalPrompt) => prompt.full.includes("Whole replacement verified"));
    const primaryReplyPrompt = result.approval.primaryPrompts.find((prompt: ApprovalPrompt) => prompt.full.includes("Reply with attachment"));
    expect(primaryUpdatePrompt).toBeDefined();
    expect(primaryUpdatePrompt.full).toContain(TARGET_COMMENT_ID);
    expect(primaryReplyPrompt).toBeDefined();
    expect(primaryReplyPrompt.full).toContain(PARENT_COMMENT_ID);
    expect(primaryReplyPrompt.full).toContain(ATTACHMENT_ID);
    expect(primaryCreatePrompt).toBeDefined();
    expect(primaryCreatePrompt.full).toContain("suppress_expert_ids");
    expect(primaryCreatePrompt.full).toContain("[]");
    expect(primaryCreatePrompt.full).toMatch(/preview|trigger/i);
    expect(primaryCreatePrompt.full).toMatch(/(?:\b(?:none|no|zero|0|empty|nothing)\b[\s\S]{0,80}\b(?:experts?|candidates?|triggers?|objects?)\b|\b(?:experts?|candidates?|triggers?|objects?)\b[\s\S]{0,80}\b(?:none|no|zero|0|empty|nothing)\b)/i);
    expect(primaryCreatePrompt.full).not.toContain("Fixture expert");
    expect(primaryCreatePrompt.full).not.toContain(EXPERT_ID);
    const tamperPreview = gateway.previewRequests.find(request => (request.body as { content?: string } | undefined)?.content === "Approved original parameters");
    expect(tamperPreview?.body).toEqual({
      content: "Approved original parameters",
      attachment_ids: [ATTACHMENT_ID],
      suppress_expert_ids: [SUPPRESS_EXPERT_ID],
    });
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Mutated after approval prompt")).toHaveLength(0);
    expect(result.approval.deniedPrompts.find((prompt: ApprovalPrompt) => prompt.full.includes("Denied reply"))?.full).toContain(PARENT_COMMENT_ID);
    expect(result.approval.deniedPrompts).toHaveLength(2);
    expect(result.approval.deniedPrompts.some((prompt: ApprovalPrompt) => prompt.full.includes("Denied comment"))).toBe(true);
    expect(result.approval.deniedPrompts.some((prompt: ApprovalPrompt) => prompt.full.includes("Denied reply"))).toBe(true);
    expect(gateway.previewRequests.some(request => ["Denied comment", "Denied reply"].includes((request.body as { content?: string } | undefined)?.content ?? ""))).toBe(true);
    expect(gateway.commentCreates.some(request => ["Denied comment", "Denied reply", "Headless approval must fail closed", "Plan mode comment", "Plan mode reply"].includes((request.body as { content?: string } | undefined)?.content ?? ""))).toBe(false);
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Denied comment")).toHaveLength(1);
    expect(gateway.previewRequests.filter(request => (request.body as { content?: string } | undefined)?.content === "Denied reply")).toHaveLength(1);

    expect(result.plan.create.isError).toBe(true);
    expect(result.plan.reply.isError).toBe(true);
    expect(result.plan.commentPageReads).toBe(0);
    expect(gateway.previewRequests.some(request => ["Plan mode comment", "Plan mode reply"].includes((request.body as { content?: string } | undefined)?.content ?? ""))).toBe(false);
    expect(result.approval.create.isError).toBe(true);
    expect(result.approval.reply.isError).toBe(true);
    expect(gateway.commentCreates.some(request => ["Plan mode comment", "Plan mode reply", "Denied comment", "Denied reply"].includes((request.body as { content?: string } | undefined)?.content ?? ""))).toBe(false);

    expect(result.failures.partialCommentList.isError).toBe(true);
    expect(result.failures.partialCommentList.text).not.toContain("Earlier comment 1");
    expect(result.failures.partialCommentList.text).not.toContain(TARGET_COMMENT_ID);
    expect(gateway.failedCommentPageTwoRequests).toBeGreaterThan(0);
    expect(gateway.requests.filter(request => request.method === "PATCH").map(request => request.path)).toEqual([
      `/fleet/api/v1/comments/${TARGET_COMMENT_ID}`,
      `/fleet/api/v1/comments/${TARGET_COMMENT_ID}`,
      `/fleet/api/v1/comments/${TARGET_COMMENT_ID}`,
    ]);
  } finally {
    gateway.server.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(profileHome, { recursive: true, force: true });
  }
}, 120_000);
