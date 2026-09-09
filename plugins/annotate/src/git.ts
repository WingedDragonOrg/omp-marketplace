import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseUnifiedDiff, type CodeSnapshot } from "./model";

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitExecutor = (cwd: string, args: string[]) => Promise<GitCommandResult>;

export interface GitCommit {
  oid: string;
  shortOid: string;
  timestamp: string;
  subject: string;
}

export const RECENT_COMMIT_LIMIT = 20;

export type GitCommitsResult =
  | { kind: "ok"; commits: GitCommit[] }
  | { kind: "error"; detail: string };

export type GitSnapshotResult =
  | { kind: "ok"; snapshot: CodeSnapshot }
  | { kind: "error"; detail: string };

interface RepositoryIdentity {
  root: string;
  repositoryId: string;
}

type RepositoryResult =
  | { kind: "ok"; repository: RepositoryIdentity }
  | { kind: "error"; detail: string };

function cleanOutput(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function commandError(result: GitCommandResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

async function readRepositoryRoot(exec: GitExecutor, cwd: string): Promise<RepositoryResult> {
  try {
    const result = await exec(cwd, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) return { kind: "error", detail: commandError(result, "Unable to identify the Git repository.") };
    const root = cleanOutput(result.stdout);
    if (!root.trim()) return { kind: "error", detail: "Git returned an empty repository root." };
    return { kind: "ok", repository: { root, repositoryId: "" } };
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function readRepositoryIdentity(exec: GitExecutor, cwd: string): Promise<RepositoryResult> {
  const rootResult = await readRepositoryRoot(exec, cwd);
  if (rootResult.kind === "error") return rootResult;
  const root = rootResult.repository.root;
  try {
    const result = await exec(root, ["rev-parse", "--git-common-dir"]);
    if (result.code !== 0) return { kind: "error", detail: commandError(result, "Unable to identify the Git repository metadata.") };
    const commonDir = cleanOutput(result.stdout);
    if (!commonDir.trim()) return { kind: "error", detail: "Git returned an empty common directory." };
    return { kind: "ok", repository: { root, repositoryId: resolve(root, commonDir) } };
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

function createSnapshot(
  repository: RepositoryIdentity,
  headOid: string,
  diff: string,
  commitOid?: string,
): CodeSnapshot {
  return {
    root: repository.root,
    repositoryId: repository.repositoryId,
    headOid,
    ...(commitOid === undefined ? {} : { commitOid }),
    diffFingerprint: createHash("sha256").update(`${headOid}\0${diff}`).digest("hex"),
    files: parseUnifiedDiff(diff),
  };
}

/** Read the combined staged and unstaged diff relative to the current HEAD. */
export async function readGitSnapshot(exec: GitExecutor, cwd: string): Promise<GitSnapshotResult> {
  const repositoryResult = await readRepositoryIdentity(exec, cwd);
  if (repositoryResult.kind === "error") return repositoryResult;
  const { root } = repositoryResult.repository;

  let result: GitCommandResult;
  try {
    result = await exec(root, ["rev-parse", "HEAD"]);
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) return { kind: "error", detail: commandError(result, "The repository has no readable HEAD.") };
  const headOid = cleanOutput(result.stdout).trim();
  if (!headOid) return { kind: "error", detail: "Git returned an empty HEAD." };

  try {
    result = await exec(root, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-textconv",
      "--default-prefix",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--unified=40",
      "HEAD",
      "--",
    ]);
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) return { kind: "error", detail: commandError(result, "Unable to read the current Git diff.") };

  return { kind: "ok", snapshot: createSnapshot(repositoryResult.repository, headOid, result.stdout) };
}

/** Read a single commit's patch as a stable code-review snapshot. */
export async function readGitSnapshotAtCommit(
  exec: GitExecutor,
  cwd: string,
  commitOid: string,
): Promise<GitSnapshotResult> {
  if (!/^[0-9a-f]{4,64}$/i.test(commitOid)) return { kind: "error", detail: "Invalid Git commit id." };
  const repositoryResult = await readRepositoryIdentity(exec, cwd);
  if (repositoryResult.kind === "error") return repositoryResult;
  const { root } = repositoryResult.repository;

  let result: GitCommandResult;
  try {
    result = await exec(root, [
      "show",
      "--no-ext-diff",
      "--no-color",
      "--no-textconv",
      "--format=",
      "--default-prefix",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--unified=40",
      commitOid,
      "--",
    ]);
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) return { kind: "error", detail: commandError(result, "Unable to read the selected Git commit.") };

  return {
    kind: "ok",
    snapshot: createSnapshot(repositoryResult.repository, commitOid, result.stdout, commitOid),
  };
}

/** Return the newest commits that can be opened as code-review sources. */
export async function readGitCommits(
  exec: GitExecutor,
  cwd: string,
  limit = RECENT_COMMIT_LIMIT,
): Promise<GitCommitsResult> {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : RECENT_COMMIT_LIMIT;
  const rootResult = await readRepositoryRoot(exec, cwd);
  if (rootResult.kind === "error") return rootResult;
  const root = rootResult.repository.root;

  let result: GitCommandResult;
  try {
    result = await exec(root, ["log", "--no-decorate", "--format=%H%x00%h%x00%cI%x00%s%x00", "-n", String(safeLimit), "--"]);
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) return { kind: "error", detail: commandError(result, "Unable to read recent Git commits.") };

  const fields = result.stdout.split("\0");
  const commits: GitCommit[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const oid = fields[index]!;
    const shortOid = fields[index + 1]!;
    const timestamp = fields[index + 2]!;
    const subject = fields[index + 3]!;
    if (!oid || !shortOid || !timestamp) continue;
    commits.push({ oid, shortOid, timestamp, subject });
  }
  return { kind: "ok", commits };
}
