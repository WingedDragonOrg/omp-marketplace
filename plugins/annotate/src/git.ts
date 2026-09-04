import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseUnifiedDiff, type CodeSnapshot } from "./model";

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitExecutor = (cwd: string, args: string[]) => Promise<GitCommandResult>;

export type GitSnapshotResult =
  | { kind: "ok"; snapshot: CodeSnapshot }
  | { kind: "error"; detail: string };

function cleanOutput(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function commandError(result: GitCommandResult, fallback: string): GitSnapshotResult {
  const detail = result.stderr.trim() || result.stdout.trim() || fallback;
  return { kind: "error", detail };
}

/** Read the combined staged and unstaged diff relative to the current HEAD. */
export async function readGitSnapshot(exec: GitExecutor, cwd: string): Promise<GitSnapshotResult> {
  let result: GitCommandResult;
  try {
    result = await exec(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) return commandError(result, "Unable to identify the Git repository.");
  const root = cleanOutput(result.stdout);
  if (!root.trim()) return { kind: "error", detail: "Git returned an empty repository root." };

  try {
    result = await exec(root, ["rev-parse", "--git-common-dir"]);
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) return commandError(result, "Unable to identify the Git repository metadata.");
  const commonDir = cleanOutput(result.stdout);
  if (!commonDir.trim()) return { kind: "error", detail: "Git returned an empty common directory." };

  try {
    result = await exec(root, ["rev-parse", "HEAD"]);
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) return commandError(result, "The repository has no readable HEAD.");
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
  if (result.code !== 0) return commandError(result, "Unable to read the current Git diff.");

  const diff = result.stdout;
  const repositoryId = resolve(root, commonDir);
  const diffFingerprint = createHash("sha256").update(`${headOid}\0${diff}`).digest("hex");
  return {
    kind: "ok",
    snapshot: {
      root,
      repositoryId,
      headOid,
      diffFingerprint,
      files: parseUnifiedDiff(diff),
    },
  };
}
