import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const COMMENT_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_COMMENT_ID = "77777777-7777-4777-8777-777777777777";
const CREATE_CONTENT = "Mutation confirmed before cleanup";
const UPDATE_CONTENT = "Update confirmed before cleanup";

type Operation = "create" | "update";
type Fault = "cleanup" | "missing-identity";
type MutationRequest = { method: string; path: string; body: unknown };
type HostResult = {
  operation: Operation;
  mutation: { isError: boolean; text: string };
  baseline?: { isError: boolean; text: string };
  approvalCount: number;
};

function startGateway(cleanupParent?: string) {
  const mutations: MutationRequest[] = [];
  let cleanupFailureInjected = false;
  let injectionError: string | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let body: unknown;
      if (request.method !== "GET" && request.method !== "HEAD") {
        try {
          body = await request.clone().json();
        } catch {
          body = undefined;
        }
      }

      if (request.method === "GET" && url.pathname === "/fleet/api/v1/workspaces") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const pageSize = Number(url.searchParams.get("page_size") ?? 20);
        const data = page === 1 ? [{
          workspace_id: WORKSPACE_ID,
          name: "Cleanup fixture workspace",
          slug: "cleanup-fixture",
          description: "Loop mutation cleanup test",
          context: null,
          settings: {},
          repos: [],
          issue_prefix: "CLEAN",
          avatar_url: null,
          created_at: "2026-11-11T00:00:00Z",
          updated_at: "2026-11-11T00:00:00Z",
        }] : [];
        return Response.json({ data, pagination: { page, page_size: pageSize, total: 1 } });
      }

      if (request.method === "GET" && url.pathname === "/fleet/api/v1/tasks") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const pageSize = Number(url.searchParams.get("page_size") ?? 20);
        const data = page === 1 ? [{ task_id: TASK_ID, title: "Cleanup fixture task", status: "in_progress" }] : [];
        return Response.json({ data, pagination: { page, page_size: pageSize, total: 1 } });
      }

      if (request.method === "GET" && url.pathname === `/fleet/api/v1/tasks/${TASK_ID}`) {
        return Response.json({ data: { task_id: TASK_ID, title: "Cleanup fixture task", description: "Fixture task" } });
      }

      if (request.method === "GET" && url.pathname === `/fleet/api/v1/tasks/${TASK_ID}/comments`) {
        const page = Number(url.searchParams.get("page") ?? 1);
        const pageSize = Number(url.searchParams.get("page_size") ?? 20);
        const data = page === 1 ? [{
          comment_id: COMMENT_ID,
          task_id: TASK_ID,
          content: "Existing comment before update",
          parent_id: null,
          attachments: [],
        }] : [];
        return Response.json({ data, pagination: { page, page_size: pageSize, total: 1 } });
      }

      if (request.method === "POST" && url.pathname === `/fleet/api/v1/tasks/${TASK_ID}/comments/_trigger_preview`) {
        return Response.json({ data: { experts: [] } });
      }

      const createPath = url.pathname === `/fleet/api/v1/tasks/${TASK_ID}/comments`;
      const updatePath = url.pathname === `/fleet/api/v1/comments/${COMMENT_ID}`;
      if ((request.method === "POST" && createPath) || (request.method === "PATCH" && updatePath)) {
        mutations.push({ method: request.method, path: url.pathname, body });
        if (cleanupParent && !cleanupFailureInjected) {
          try {
            await chmod(cleanupParent, 0o500);
            cleanupFailureInjected = true;
          } catch (error) {
            injectionError = error instanceof Error ? error.message : String(error);
            return Response.json({ error: `Could not inject cleanup failure: ${injectionError}` }, { status: 500 });
          }
        }
        const data = request.method === "POST"
          ? {
              comment_id: CREATED_COMMENT_ID,
              task_id: TASK_ID,
              content: (body as { content?: string } | undefined)?.content,
              parent_id: (body as { parent_comment_id?: string } | undefined)?.parent_comment_id ?? null,
              attachments: [],
            }
          : {
              comment_id: COMMENT_ID,
              task_id: TASK_ID,
              content: (body as { content?: string } | undefined)?.content,
              parent_id: null,
              attachments: [],
            };
        return Response.json({ data }, { status: request.method === "POST" ? 201 : 200 });
      }

      return Response.json({ error: `unexpected fixture request: ${request.method} ${url.pathname}` }, { status: 404 });
    },
  });

  return {
    server,
    mutations,
    get cleanupFailureInjected() { return cleanupFailureInjected; },
    get injectionError() { return injectionError; },
  };
}

function identityStrippingCliSource(): string {
  return `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(process.env.OMP_TEST_REAL_CLI, args, {
  input: readFileSync(0),
  encoding: "utf8",
  env: process.env,
});
if (result.error) {
  process.stderr.write(result.error.message);
  process.exitCode = 1;
} else {
  process.stderr.write(result.stderr || "");
  let output = result.stdout || "";
  const mutation = args[0] === "loop" && (
    (args[1] === "task" && args[2] === "comment" && args[3] === "create") ||
    (args[1] === "comment" && args[2] === "update")
  );
  if (mutation) {
    const envelope = JSON.parse(output);
    if (!envelope || envelope.ok !== true || !("data" in envelope)) {
      process.stderr.write("real octo-cli did not return an ok:true mutation envelope");
      process.exitCode = 1;
    } else {
      delete envelope.identity;
      output = JSON.stringify(envelope);
      process.exitCode = result.status ?? 1;
    }
  } else {
    process.exitCode = result.status ?? 1;
  }
  process.stdout.write(output);
}
`;
}

async function runScenario(operation: Operation, fault: Fault): Promise<{
  host: { exitCode: number; stdout: string; stderr: string; result: HostResult | null };
  mutations: MutationRequest[];
  cleanupFailureInjected: boolean;
  injectionError?: string;
}> {
  const realCli = Bun.which("octo-cli");
  if (!realCli) throw new Error("octo-cli is required for the Loop cleanup integration test");

  const cwd = await mkdtemp(join(tmpdir(), "omp-octo-loop-cleanup-host-"));
  const tempParent = await mkdtemp(join(tmpdir(), "omp-octo-loop-cleanup-tmp-"));
  const configDir = join(cwd, ".octo-config");
  await mkdir(configDir, { recursive: true });
  const pluginPath = resolve(import.meta.dir, "../src/index.ts");
  const sdkPath = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/index.ts");
  const runtimeInitPath = resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-coding-agent/src/modes/runtime-init.ts");
  const wrapperDir = join(cwd, "bin");
  if (fault === "missing-identity") {
    await mkdir(wrapperDir, { recursive: true });
    const wrapperPath = join(wrapperDir, "octo-cli");
    await writeFile(wrapperPath, identityStrippingCliSource());
    await chmod(wrapperPath, 0o755);
  }
  const gateway = startGateway(fault === "cleanup" ? tempParent : undefined);

  const hostProgram = `
// The host runs via bun -e; use absolute SDK paths resolved from the test module.
const sdk = await import(${JSON.stringify(sdkPath)});
const runtime = await import(${JSON.stringify(runtimeInitPath)});
import { chmod } from "node:fs/promises";
const { AgentRegistry, Settings, SessionManager, createAgentSession } = sdk;
const cwd = process.env.OMP_LOOP_CLEANUP_CWD;
const gateway = process.env.OMP_LOOP_CLEANUP_GATEWAY;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const address = typeof input === "string" || input instanceof URL ? input : input.url;
  const url = new URL(address);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "::1" && url.hostname !== "localhost") {
    throw new Error("Loop cleanup test blocked non-loopback request to " + url.origin);
  }
  return realFetch(input, init);
};
const settings = Settings.isolated({
  "tools.approvalMode": "yolo",
  "tools.xdev": true,
  "edit.mode": "hashline",
  "plan.enabled": true,
});
const created = await createAgentSession({
  cwd,
  agentDir: cwd + "/.agent-loop-cleanup-test",
  sessionManager: SessionManager.inMemory(cwd),
  settings,
  additionalExtensionPaths: [process.env.OMP_LOOP_CLEANUP_PLUGIN],
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
let approvalCount = 0;
let result;
try {
  await runtime.initializeExtensions(session, {
    mode: "rpc",
    uiContext: {
      select: async () => undefined,
      approve: async () => { approvalCount++; return "once"; },
    },
    reportSendError: (_action, error) => console.error(error.message),
    reportRuntimeError: error => console.error(error.error),
  });
  await session.runToolRegistryMutation(async () => {});
  const targetPath = "octo://loop/workspaces/${WORKSPACE_ID}/tasks/${TASK_ID}/comments/${COMMENT_ID}";
  const newCommentPath = "octo://loop/workspaces/${WORKSPACE_ID}/tasks/${TASK_ID}/comments/new";
  const write = session.getToolByName("write");
  let baseline;
  if (process.env.OMP_LOOP_OPERATION === "update") {
    const read = session.getToolByName("read");
    const readResult = read
      ? await read.execute("cleanup-update-baseline", { path: targetPath })
      : { isError: true, content: [{ text: "builtin read tool missing" }] };
    baseline = {
      isError: readResult.isError === true,
      text: (readResult.content || []).filter(block => typeof block.text === "string").map(block => block.text).join("\\n"),
    };
  }
  const mutationPath = process.env.OMP_LOOP_OPERATION === "create" ? newCommentPath : targetPath;
  const mutationContent = process.env.OMP_LOOP_OPERATION === "create"
    ? JSON.stringify({ content: "${CREATE_CONTENT}", attachment_ids: [], suppress_expert_ids: [] })
    : "${UPDATE_CONTENT}";
  const mutation = write
    ? await write.execute("cleanup-outcome-" + process.env.OMP_LOOP_OPERATION, { path: mutationPath, content: mutationContent })
    : { isError: true, content: [{ text: "builtin write tool missing" }] };
  result = {
    operation: process.env.OMP_LOOP_OPERATION,
    mutation: {
      isError: mutation.isError === true,
      text: (mutation.content || []).filter(block => typeof block.text === "string").map(block => block.text).join("\\n"),
    },
    ...(baseline ? { baseline } : {}),
    approvalCount,
  };
} catch (error) {
  result = {
    operation: process.env.OMP_LOOP_OPERATION,
    mutation: { isError: true, text: error instanceof Error ? error.message : String(error) },
    approvalCount,
  };
} finally {
  if (process.env.OMP_LOOP_CLEANUP_RESTORE_TMP === "1") {
    try { await chmod(process.env.TMPDIR, 0o700); } catch {}
  }
  await session.dispose();
}
console.log("OCTO_LOOP_CLEANUP_HOST_RESULT " + JSON.stringify(result));
`;

  try {
    const path = fault === "missing-identity" ? `${wrapperDir}:${process.env.PATH ?? ""}` : process.env.PATH;
    const child = Bun.spawn([process.execPath, "-e", hostProgram], {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        TMPDIR: tempParent,
        TMP: tempParent,
        TEMP: tempParent,
        PATH: path,
        OMP_TEST_REAL_CLI: realCli,
        OMP_LOOP_CLEANUP_CWD: cwd,
        OMP_LOOP_CLEANUP_GATEWAY: `http://127.0.0.1:${gateway.server.port}`,
        OMP_LOOP_CLEANUP_PLUGIN: pluginPath,
        OMP_LOOP_CLEANUP_RESTORE_TMP: fault === "cleanup" ? "1" : "0",
        OMP_LOOP_OPERATION: operation,
        OCTO_CONFIG_DIR: configDir,
        OCTO_TOKEN: "bf_loop_cleanup_fixture",
        OCTO_BOT_ID: "",
        OCTO_BOT_TOKEN: "",
        OCTO_TASK_TOKEN: "",
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
    const resultLine = stdout.split(/\r?\n/).find(line => line.startsWith("OCTO_LOOP_CLEANUP_HOST_RESULT "));
    return {
      host: {
        exitCode,
        stdout,
        stderr,
        result: resultLine ? JSON.parse(resultLine.slice("OCTO_LOOP_CLEANUP_HOST_RESULT ".length)) as HostResult : null,
      },
      mutations: gateway.mutations,
      cleanupFailureInjected: gateway.cleanupFailureInjected,
      injectionError: gateway.injectionError,
    };
  } finally {
    try { await chmod(tempParent, 0o700); } catch {}
    gateway.server.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(tempParent, { recursive: true, force: true });
  }
}

for (const operation of ["create", "update"] as const) {
  test(`Loop ${operation} reports server-confirmed success when credential cleanup fails`, async () => {
    const result = await runScenario(operation, "cleanup");
    expect(result.host.exitCode, result.host.stderr).toBe(0);
    expect(result.host.result, result.host.stdout).not.toBeNull();
    expect(result.cleanupFailureInjected, result.injectionError).toBe(true);
    expect(result.host.result!.approvalCount).toBe(1);
    expect(result.host.result!.mutation.isError).toBe(false);
    expect(result.host.result!.mutation.text).toMatch(/confirmed by the server/i);
    expect(result.host.result!.mutation.text).toMatch(/temporary credential cleanup failed/i);
    expect(result.host.result!.mutation.text).toMatch(/do not retry the mutation/i);
    expect(result.host.result!.mutation.text).not.toMatch(/outcome is unknown|may have been submitted/i);
    expect(result.host.result!.baseline?.isError).not.toBe(true);
    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]!.method).toBe(operation === "create" ? "POST" : "PATCH");
    expect(result.mutations[0]!.body).toMatchObject({ content: operation === "create" ? CREATE_CONTENT : UPDATE_CONTENT });
  }, 60_000);

  test(`Loop ${operation} preserves confirmed outcome when successful CLI envelope omits identity`, async () => {
    const result = await runScenario(operation, "missing-identity");
    expect(result.host.exitCode, result.host.stderr).toBe(0);
    expect(result.host.result, result.host.stdout).not.toBeNull();
    expect(result.host.result!.approvalCount).toBe(1);
    expect(result.host.result!.mutation.isError).toBe(true);
    expect(result.host.result!.mutation.text).toMatch(/confirmed by (?:the )?(?:server|octo-cli)/i);
    expect(result.host.result!.mutation.text).toMatch(/do not retry the mutation/i);
    expect(result.host.result!.mutation.text).not.toMatch(/outcome is unknown|may have been submitted/i);
    expect(result.host.result!.baseline?.isError).not.toBe(true);
    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]!.method).toBe(operation === "create" ? "POST" : "PATCH");
    expect(result.mutations[0]!.body).toMatchObject({ content: operation === "create" ? CREATE_CONTENT : UPDATE_CONTENT });
  }, 60_000);
}
