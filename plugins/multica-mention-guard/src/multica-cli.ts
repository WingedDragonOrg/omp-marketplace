import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeUuid, type TaskContext } from "./domain";
import {
  parseAgent,
  parseComment,
  parseCreatedComment,
  parseMember,
  parseRun,
} from "./schema";
import type { GuardBackend, GuardComment, GuardSnapshot } from "./guard";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  signal: AbortSignal;
  onDispatched?: () => void;
}

export interface CommandExecutor {
  run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult>;
}

type ActiveTaskContext = Extract<TaskContext, { kind: "active" }>;

export class MulticaCliBackend implements GuardBackend {
  constructor(
    private readonly context: ActiveTaskContext,
    private readonly executor: CommandExecutor,
  ) {}

  async loadSnapshot(signal: AbortSignal): Promise<GuardSnapshot> {
    const commentsPromise = this.runJson(
      "issue comment list",
      ["multica", "issue", "comment", "list", this.context.issueId, "--output", "json"],
      parseComment,
      signal,
    );
    const agentsPromise = this.runJson(
      "agent list",
      ["multica", "agent", "list", "--output", "json"],
      parseAgent,
      signal,
    );
    const membersPromise = this.runJson(
      "workspace member list",
      ["multica", "workspace", "member", "list", "--output", "json"],
      parseMember,
      signal,
    );
    const runsPromise = this.runJson(
      "issue runs",
      ["multica", "issue", "runs", this.context.issueId, "--output", "json"],
      parseRun,
      signal,
    );
    const [[comments, runs], rosterResults] = await Promise.all([
      Promise.all([commentsPromise, runsPromise]),
      Promise.allSettled([agentsPromise, membersPromise]),
    ]);
    const agents = rosterResults[0].status === "fulfilled" ? rosterResults[0].value : [];
    const members = rosterResults[1].status === "fulfilled" ? rosterResults[1].value : [];
    const rosterVerified =
      rosterResults[0].status === "fulfilled" &&
      rosterResults[1].status === "fulfilled";

    const matchingRuns = runs.filter(run => normalizeUuid(run.id) === this.context.taskId);
    if (matchingRuns.length !== 1) {
      throw new Error("multica issue runs: current task is missing or ambiguous");
    }
    const rawParentId = matchingRuns[0]!.trigger_comment_id ?? null;
    let expectedParentId: string | null;
    if (rawParentId === null) {
      expectedParentId = null;
    } else {
      const normalizedParentId = normalizeUuid(rawParentId);
      if (!normalizedParentId) {
        throw new Error("multica issue runs: trigger_comment_id is invalid");
      }
      expectedParentId = normalizedParentId;
    }

    const agentIds = new Set<string>();
    for (const agent of agents) {
      const id = normalizeUuid(agent.id);
      if (id && agent.archived_at === null && agent.runtime_bound) agentIds.add(id);
    }
    const memberIds = new Set<string>();
    for (const member of members) {
      const id = normalizeUuid(member.user_id);
      if (id) memberIds.add(id);
    }

    const normalizedComments: GuardComment[] = comments.map(comment => ({
      issueId: comment.issue_id,
      sourceTaskId: comment.source_task_id ?? null,
      authorType: comment.author_type,
      authorId: comment.author_id,
      type: comment.type,
      parentId: comment.parent_id ?? null,
      content: comment.content,
    }));
    return {
      comments: normalizedComments,
      agentIds,
      memberIds,
      expectedParentId,
      rosterVerified,
    };
  }

  async publishFinal(
    body: string,
    parentId: string | null,
    signal: AbortSignal,
    onDispatched: () => void,
  ): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "omp-multica-mention-guard-"));
    const contentPath = join(directory, "comment.md");
    try {
      await writeFile(contentPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const command = ["multica", "issue", "comment", "add", this.context.issueId];
      if (parentId !== null) command.push("--parent", parentId);
      command.push(
        "--allow-external-file",
        "--content-file",
        contentPath,
        "--output",
        "json",
      );
      const result = await this.executor.run(command, { signal, onDispatched });
      if (result.exitCode !== 0) {
        throw new Error(`multica issue comment add exited with code ${result.exitCode}`);
      }
      let output: unknown;
      try {
        output = JSON.parse(result.stdout);
      } catch (error) {
        throw new Error("multica issue comment add: invalid JSON output", { cause: error });
      }
      if (!parseCreatedComment(output)) {
        throw new Error("multica issue comment add: invalid JSON output");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async runJson<T>(
    label: string,
    command: readonly string[],
    parseRecord: (value: unknown) => T | undefined,
    signal: AbortSignal,
  ): Promise<T[]> {
    const result = await this.executor.run(command, { signal });
    if (result.exitCode !== 0) {
      throw new Error(`multica ${label} exited with code ${result.exitCode}`);
    }
    let output: unknown;
    try {
      output = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`multica ${label}: invalid JSON output`, { cause: error });
    }
    if (!Array.isArray(output)) {
      throw new Error(`multica ${label}: invalid JSON output`);
    }
    const records: T[] = [];
    for (const item of output) {
      const record = parseRecord(item);
      if (record === undefined) {
        throw new Error(`multica ${label}: invalid JSON output`);
      }
      records.push(record);
    }
    return records;
  }
}

const TERMINATION_GRACE_MS = 100;
const FORCE_KILL_WAIT_MS = 250;

export class BunCommandExecutor implements CommandExecutor {
  constructor(private readonly options: { timeoutMs: number; maxOutputBytes: number }) {}

  async run(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
    if (options.signal.aborted) throw options.signal.reason;
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(this.options.timeoutMs),
    ]);
    const process = Bun.spawn([...command], {
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    options.onDispatched?.();

    const completion = Promise.all([
      readBounded(process.stdout, this.options.maxOutputBytes),
      readBounded(process.stderr, this.options.maxOutputBytes),
      process.exited,
    ]);
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      const [stdout, stderr, exitCode] = await Promise.race([
        completion,
        aborted.promise,
      ]);
      return { exitCode, stdout, stderr };
    } catch (error) {
      process.kill("SIGTERM");
      const exitedGracefully = await Promise.race([
        process.exited.then(() => true),
        Bun.sleep(TERMINATION_GRACE_MS).then(() => false),
      ]);
      if (!exitedGracefully) {
        process.kill("SIGKILL");
        await Promise.race([
          process.exited.catch(() => undefined),
          Bun.sleep(FORCE_KILL_WAIT_MS),
        ]);
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxOutputBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxOutputBytes) throw new Error("subprocess output exceeded limit");
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
