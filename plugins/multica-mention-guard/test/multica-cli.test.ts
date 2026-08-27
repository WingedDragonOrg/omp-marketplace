import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import {
  BunCommandExecutor,
  MulticaCliBackend,
  type CommandExecutor,
  type CommandResult,
  type RunCommandOptions,
} from "../src/multica-cli";
import type { TaskContext } from "../src/domain";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const MEMBER_ID = "66666666-6666-4666-8666-666666666666";
const PARENT_ID = "77777777-7777-4777-8777-777777777777";

const context: Extract<TaskContext, { kind: "active" }> = {
  kind: "active",
  taskId: TASK_ID,
  agentId: AGENT_ID,
  workspaceId: WORKSPACE_ID,
  issueId: ISSUE_ID,
};

class FakeExecutor implements CommandExecutor {
  readonly commands: string[][] = [];
  onRun:
    | ((command: readonly string[], options: RunCommandOptions) => Promise<CommandResult>)
    | undefined;

  async run(
    command: readonly string[],
    options: RunCommandOptions,
  ): Promise<CommandResult> {
    this.commands.push([...command]);
    if (!this.onRun) throw new Error("unexpected command");
    return this.onRun(command, options);
  }
}

const responses: Record<string, string> = {
  "issue comment list": JSON.stringify([
    {
      issue_id: ISSUE_ID,
      source_task_id: TASK_ID,
      author_type: "agent",
      author_id: AGENT_ID,
      type: "comment",
      parent_id: PARENT_ID,
      content: "complete",
    },
  ]),
  "agent list": JSON.stringify([
    {
      id: OTHER_AGENT_ID,
      archived_at: null,
      runtime_bound: true,
    },
    {
      id: "88888888-8888-4888-8888-888888888888",
      archived_at: "2026-01-01T00:00:00Z",
      runtime_bound: true,
    },
    {
      id: "99999999-9999-4999-8999-999999999999",
      archived_at: null,
      runtime_bound: false,
    },
  ]),
  "workspace member list": JSON.stringify([{ user_id: MEMBER_ID }]),
  "issue runs": JSON.stringify([
    {
      id: TASK_ID,
      trigger_comment_id: PARENT_ID,
    },
  ]),
};

function commandKind(command: readonly string[]): string {
  if (command[1] === "issue" && command[2] === "comment") return "issue comment list";
  if (command[1] === "agent") return "agent list";
  if (command[1] === "workspace") return "workspace member list";
  if (command[1] === "issue" && command[2] === "runs") return "issue runs";
  return "unknown";
}

describe("MulticaCliBackend", () => {
  test("loads and validates the current task snapshot from four CLI reads", async () => {
    const executor = new FakeExecutor();
    executor.onRun = async command => ({
      exitCode: 0,
      stdout: responses[commandKind(command)] ?? "",
      stderr: "",
    });
    const backend = new MulticaCliBackend(context, executor);

    const result = await backend.loadSnapshot(new AbortController().signal);

    expect(result.expectedParentId).toBe(PARENT_ID);
    expect([...result.agentIds]).toEqual([OTHER_AGENT_ID]);
    expect([...result.memberIds]).toEqual([MEMBER_ID]);
    expect(result.rosterVerified).toBe(true);
    expect(result.comments).toEqual([
      {
        issueId: ISSUE_ID,
        sourceTaskId: TASK_ID,
        authorType: "agent",
        authorId: AGENT_ID,
        type: "comment",
        parentId: PARENT_ID,
        content: "complete",
      },
    ]);
    expect(executor.commands).toEqual([
      ["multica", "issue", "comment", "list", ISSUE_ID, "--output", "json"],
      ["multica", "agent", "list", "--output", "json"],
      ["multica", "workspace", "member", "list", "--output", "json"],
      ["multica", "issue", "runs", ISSUE_ID, "--output", "json"],
    ]);
  });

  test("publishes through a private UTF-8 content file without putting body in argv", async () => {
    const executor = new FakeExecutor();
    const body = `Complete result. [@Reviewer](mention://agent/${OTHER_AGENT_ID})`;
    let contentPath = "";
    let dispatched = false;
    executor.onRun = async (command, options) => {
      const pathIndex = command.indexOf("--content-file");
      contentPath = command[pathIndex + 1] ?? "";
      expect(pathIndex).toBeGreaterThan(0);
      expect(command).not.toContain(body);
      expect(command).toContain("--parent");
      expect(command).toContain("--allow-external-file");
      expect(await readFile(contentPath, "utf8")).toBe(body);
      expect((await stat(contentPath)).mode & 0o777).toBe(0o600);
      options.onDispatched?.();
      dispatched = true;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        stderr: "",
      };
    };
    const backend = new MulticaCliBackend(context, executor);
    await backend.publishFinal(
      body,
      PARENT_ID,
      new AbortController().signal,
      () => {
        dispatched = true;
      },
    );

    expect(dispatched).toBe(true);
    expect(await Bun.file(contentPath).exists()).toBe(false);
  });

  test("preserves comments and routing when a roster command fails", async () => {
    const executor = new FakeExecutor();
    executor.onRun = async command => {
      const kind = commandKind(command);
      if (kind === "agent list") {
        return { exitCode: 1, stdout: "", stderr: "offline" };
      }
      return { exitCode: 0, stdout: responses[kind]!, stderr: "" };
    };
    const backend = new MulticaCliBackend(context, executor);

    const result = await backend.loadSnapshot(new AbortController().signal);

    expect(result.rosterVerified).toBe(false);
    expect(result.comments).toHaveLength(1);
    expect(result.expectedParentId).toBe(PARENT_ID);
  });

  test("rejects malformed delivery-state JSON instead of returning a partial snapshot", async () => {
    const executor = new FakeExecutor();
    executor.onRun = async command => ({
      exitCode: 0,
      stdout:
        commandKind(command) === "issue comment list"
          ? "{}"
          : responses[commandKind(command)]!,
      stderr: "",
    });
    const backend = new MulticaCliBackend(context, executor);

    await expect(backend.loadSnapshot(new AbortController().signal)).rejects.toThrow(
      "issue comment list",
    );
  });
});

describe("BunCommandExecutor", () => {
  test("captures a real subprocess result and reports dispatch", async () => {
    const executor = new BunCommandExecutor({ timeoutMs: 1_000, maxOutputBytes: 1_024 });
    let dispatched = false;

    const result = await executor.run(["/bin/echo", "ready"], {
      signal: new AbortController().signal,
      onDispatched: () => {
        dispatched = true;
      },
    });

    expect(dispatched).toBe(true);
    expect(result).toEqual({ exitCode: 0, stdout: "ready\n", stderr: "" });
  });

  test("terminates a subprocess that exceeds its internal timeout", async () => {
    const executor = new BunCommandExecutor({ timeoutMs: 20, maxOutputBytes: 1_024 });
    const startedAt = performance.now();

    await expect(
      executor.run(["/bin/sleep", "1"], {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("rejects subprocess output that exceeds the configured bound", async () => {
    const executor = new BunCommandExecutor({ timeoutMs: 1_000, maxOutputBytes: 4 });

    await expect(
      executor.run(["/bin/echo", "12345"], {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("output exceeded limit");
  });

  test("escalates termination when a timed-out child ignores SIGTERM", async () => {
    const executor = new BunCommandExecutor({ timeoutMs: 20, maxOutputBytes: 1_024 });
    const startedAt = performance.now();

    await expect(
      executor.run(
        [
          "python3",
          "-c",
          "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(5)",
        ],
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow();

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
