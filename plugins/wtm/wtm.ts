// /wtm — Git worktree lifecycle and Worktrunk merge integration for Oh My Pi.
//
// Stable Worktrunk v0.76.x releases are used for create/reuse, list, remove, hooks,
// approvals, configured worktree paths, and merge. Existing lifecycle commands
// retain a native Git fallback; merge requires Worktrunk.
//
// OMP owns session migration through its built-in `/move`. Worktrunk owns Git
// lifecycle operations. Cleanup-enabled merge prepares a verified safe landing
// and an explicit continuation command; self removal deletes its source first,
// then prepares a `/move` handoff.
//
// `OMP_WORKTREE_DIR` overrides Worktrunk's configured path for new worktrees
// while preserving the historical <repo>-<name> layout.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { homedir } from "node:os";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";

const HELP = `Usage:
  /wtm [branch] [--base <ref>]     create/reuse worktree + prepare /move
  /wtm list                        list this repo's worktrees
  /wtm rm <name|path> [-f] [-y]    remove one worktree; keep its branch
  /wtm rm self [-f] [-y]           remove current worktree + prepare /move
  /wtm rm --all [-f] [-y]          remove eligible worktrees except primary/current
  /wtm prune                       prune stale Git worktree metadata
  /wtm merge [target] [flags]      run Worktrunk's local merge pipeline

Merge flags:
  --no-squash --no-commit --no-rebase --no-remove --no-ff
  --stage all|tracked|none  --source <path>  -y

Handoff:
  Create/reuse and cleanup-enabled merge operations prepare /move.
  Self removal deletes the current worktree, then prepares /move to primary.
  Submit /move for the prepared handoff. Merge continuations still require
  a second /wtm invocation. -y skips only the current confirmation.

Backend:
  Stable Worktrunk v0.76.x releases provide paths, lifecycle hooks, approvals, and merge.
  Lifecycle commands fall back to native Git only before mutation. Merge never falls back.
  Unapproved project commands must first be approved with 'wt config approvals add'.
  -y skips only the current OMP confirmation. OMP_WORKTREE_DIR preserves the
  <repo>-<name> layout for newly created worktrees.`;

type CommandArgumentParse =
  | { kind: "ok"; args: string[] }
  | { kind: "error"; detail: string };

function parseCommandArguments(raw: string): CommandArgumentParse {
  const args: string[] = [];
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) index++;
    if (index >= raw.length) break;

    if (raw[index] !== '"') {
      const start = index;
      while (index < raw.length && !/\s/.test(raw[index])) index++;
      args.push(raw.slice(start, index));
      continue;
    }

    const start = index;
    index++;
    let escaped = false;
    while (index < raw.length) {
      const char = raw[index];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        index++;
        break;
      }
      index++;
    }
    if (index > raw.length || raw[index - 1] !== '"') {
      return { kind: "error", detail: "unterminated JSON string argument" };
    }
    if (index < raw.length && !/\s/.test(raw[index])) {
      return { kind: "error", detail: "a JSON string argument must end at a token boundary" };
    }

    const literal = raw.slice(start, index);
    try {
      const value: unknown = JSON.parse(literal);
      if (typeof value !== "string") {
        return { kind: "error", detail: "quoted arguments must decode to strings" };
      }
      args.push(value);
    } catch {
      return { kind: "error", detail: `invalid JSON string argument: ${literal}` };
    }
  }
  return { kind: "ok", args };
}

function buildMoveCommand(destination: string): string | null {
  if (/[\0\r\n]/.test(destination)) return null;
  return `/move "${destination}"`;
}

function worktreeBaseDir(): string {
  const env = process.env.OMP_WORKTREE_DIR;
  if (env) return env.replace(/^~(?=\/|$)/, homedir());
  return path.join(homedir(), ".omp", "wt");
}

interface CommandResult { code: number; out: string; err: string }

function runCommand(cwd: string, command: string[]): CommandResult {
  try {
    const proc = Bun.spawnSync(command, { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return {
      code: proc.exitCode ?? -1,
      out: new TextDecoder().decode(proc.stdout),
      err: new TextDecoder().decode(proc.stderr),
    };
  } catch (error) {
    return {
      code: -1,
      out: "",
      err: error instanceof Error ? error.message : String(error),
    };
  }
}

function runGit(cwd: string, args: string[]): CommandResult {
  return runCommand(cwd, ["git", ...args]);
}

type WorktrunkBackend =
  | { kind: "available"; executable: string; version: string }
  | { kind: "missing" }
  | { kind: "unsupported"; executable: string; version: string }
  | { kind: "invalid"; executable: string; detail: string };

interface WorktrunkSwitchResult {
  action: string;
  branch: string;
  path: string;
}

function findExecutable(name: string): string | null {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function resolveWorktrunk(cwd: string): WorktrunkBackend {
  const found = findExecutable("wt");
  if (!found) return { kind: "missing" };
  const executable = realPath(found) ?? path.resolve(found);
  const result = runCommand(cwd, [executable, "--version"]);
  if (result.code !== 0) {
    return { kind: "invalid", executable, detail: result.err.trim() || `exit ${result.code}` };
  }
  const match = /^wt v(0)\.(\d+)\.(\d+)([-+][^\s]+)?$/.exec(result.out.trim());
  if (!match) return { kind: "invalid", executable, detail: `unexpected version: ${result.out.trim()}` };
  const version = `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}`;
  if (match[1] === "0" && match[2] === "76" && !match[4]) return { kind: "available", executable, version };
  return { kind: "unsupported", executable, version };
}

function runWorktrunk(backend: Extract<WorktrunkBackend, { kind: "available" }>, cwd: string, args: string[]): CommandResult {
  return runCommand(cwd, [backend.executable, ...args]);
}

function parseWorktrunkSwitch(out: string): WorktrunkSwitchResult | null {
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("action" in value) ||
    !("branch" in value) ||
    !("path" in value) ||
    typeof value.action !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.path !== "string" ||
    !path.isAbsolute(value.path)
  ) {
    return null;
  }
  return { action: value.action, branch: value.branch, path: value.path };
}

interface WorktrunkListItem {
  branch: string | null;
  head: string;
  path: string;
  main: boolean;
  current: boolean;
  detached: boolean;
}

interface WorktrunkList {
  defaultBranch: string;
  items: WorktrunkListItem[];
}

type WorktrunkListProbe =
  | { kind: "ok"; list: WorktrunkList }
  | { kind: "error"; detail: string };

function parseWorktrunkList(out: string): WorktrunkList | null {
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("schema" in value) ||
    value.schema !== 2 ||
    !("repo" in value) ||
    value.repo === null ||
    typeof value.repo !== "object" ||
    Array.isArray(value.repo) ||
    !("default_branch" in value.repo) ||
    typeof value.repo.default_branch !== "string" ||
    !("collected" in value) ||
    value.collected === null ||
    typeof value.collected !== "object" ||
    Array.isArray(value.collected) ||
    !("ci" in value.collected) ||
    !("summary" in value.collected) ||
    typeof value.collected.ci !== "boolean" ||
    typeof value.collected.summary !== "boolean" ||
    !("items" in value) ||
    !Array.isArray(value.items)
  ) {
    return null;
  }

  const items: WorktrunkListItem[] = [];
  for (const item of value.items) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !("branch" in item) ||
      (item.branch !== null && typeof item.branch !== "string") ||
      !("head" in item) ||
      item.head === null ||
      typeof item.head !== "object" ||
      Array.isArray(item.head) ||
      !("sha" in item.head) ||
      typeof item.head.sha !== "string" ||
      !("worktree" in item) ||
      item.worktree === null ||
      typeof item.worktree !== "object" ||
      Array.isArray(item.worktree) ||
      !("path" in item.worktree) ||
      !("main" in item.worktree) ||
      !("current" in item.worktree) ||
      !("detached" in item.worktree) ||
      typeof item.worktree.path !== "string" ||
      !path.isAbsolute(item.worktree.path) ||
      typeof item.worktree.main !== "boolean" ||
      typeof item.worktree.current !== "boolean" ||
      typeof item.worktree.detached !== "boolean"
    ) {
      return null;
    }
    items.push({
      branch: item.branch,
      head: item.head.sha,
      path: item.worktree.path,
      main: item.worktree.main,
      current: item.worktree.current,
      detached: item.worktree.detached,
    });
  }
  return { defaultBranch: value.repo.default_branch, items };
}

function probeWorktrunkList(
  backend: Extract<WorktrunkBackend, { kind: "available" }>,
  cwd: string,
): WorktrunkListProbe {
  const result = runWorktrunk(backend, cwd, [
    "list",
    "--format=json",
    "--config-set", "list.full=false",
    "--config-set", "list.summary=false",
    "--config-set", "list.json-schema=2",
  ]);
  if (result.code !== 0) {
    return { kind: "error", detail: result.err.trim() || `exit ${result.code}` };
  }
  const list = parseWorktrunkList(result.out);
  return list
    ? { kind: "ok", list }
    : { kind: "error", detail: "incompatible list JSON" };
}

interface WorktrunkRemoveResult {
  branch: string | null;
  path: string;
  branchOutcome: "not_attempted";
}

type WorktrunkRemoveOutcome =
  | { kind: "ok"; result: WorktrunkRemoveResult; stderr: string }
  | { kind: "error"; detail: string }
  | { kind: "incompatible"; detail: string; stderr: string };

function parseWorktrunkRemove(out: string): WorktrunkRemoveResult | null {
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("kind" in value) ||
    value.kind !== "worktree" ||
    !("branch" in value) ||
    (value.branch !== null && typeof value.branch !== "string") ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !path.isAbsolute(value.path) ||
    !("branch_outcome" in value) ||
    value.branch_outcome !== "not_attempted" ||
    !("branch_checked_out_at" in value) ||
    (value.branch_checked_out_at !== null && typeof value.branch_checked_out_at !== "string")
  ) {
    return null;
  }
  return {
    branch: value.branch,
    path: value.path,
    branchOutcome: value.branch_outcome,
  };
}

function removeWithWorktrunk(
  backend: Extract<WorktrunkBackend, { kind: "available" }>,
  cwd: string,
  worktreePath: string,
  expectedBranch: string | null,
  force: boolean,
): WorktrunkRemoveOutcome {
  const args = [
    "remove",
    worktreePath,
    "--no-delete-branch",
    "--foreground",
    "--format=json",
  ];
  if (force) args.push("--force");
  const result = runWorktrunk(backend, cwd, args);
  if (result.code !== 0) {
    return { kind: "error", detail: filterWorktrunkStderr(result.err) || `exit ${result.code}` };
  }
  const parsed = parseWorktrunkRemove(result.out);
  if (!parsed) {
    return { kind: "incompatible", detail: "incompatible Worktrunk JSON", stderr: result.err };
  }
  if (canonicalPath(parsed.path) !== canonicalPath(worktreePath)) {
    return {
      kind: "incompatible",
      detail: `reported different worktree ${shortPath(parsed.path)}`,
      stderr: result.err,
    };
  }
  if (parsed.branch !== expectedBranch) {
    return {
      kind: "incompatible",
      detail: `reported branch ${parsed.branch ?? "(detached)"} instead of ${expectedBranch ?? "(detached)"}`,
      stderr: result.err,
    };
  }
  return { kind: "ok", result: parsed, stderr: result.err };
}

interface WorktrunkApprovalCommand {
  phase: string;
  name: string | null;
  template: string;
  approved: boolean;
}

interface WorktrunkApprovalState {
  state: "no_commands" | "approval_required" | "approved";
  commands: WorktrunkApprovalCommand[];
  stale: string[];
}

type WorktrunkApprovalCheck =
  | { kind: "approved" }
  | { kind: "blocked"; commands: WorktrunkApprovalCommand[]; stale: string[] }
  | { kind: "error"; detail: string };

function parseWorktrunkApprovals(out: string): WorktrunkApprovalState | null {
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("state" in value) ||
    (value.state !== "no_commands" && value.state !== "approval_required" && value.state !== "approved") ||
    !("commands" in value) ||
    !Array.isArray(value.commands) ||
    !("stale" in value) ||
    !Array.isArray(value.stale)
  ) {
    return null;
  }
  const stale: string[] = [];
  for (const entry of value.stale) {
    if (typeof entry !== "string") return null;
    stale.push(entry);
  }


  const commands: WorktrunkApprovalCommand[] = [];
  for (const command of value.commands) {
    if (
      command === null ||
      typeof command !== "object" ||
      Array.isArray(command) ||
      !("phase" in command) ||
      typeof command.phase !== "string" ||
      ("name" in command && command.name !== null && typeof command.name !== "string") ||
      !("template" in command) ||
      typeof command.template !== "string" ||
      !("approved" in command) ||
      typeof command.approved !== "boolean"
    ) {
      return null;
    }
    commands.push({
      phase: command.phase,
      name: "name" in command && typeof command.name === "string" ? command.name : null,
      template: command.template,
      approved: command.approved,
    });
  }
  return {
    state: value.state,
    commands,
    stale,
  };
}

function checkWorktrunkApprovals(
  backend: Extract<WorktrunkBackend, { kind: "available" }>,
  cwd: string,
  phases: readonly string[],
): WorktrunkApprovalCheck {
  const result = runWorktrunk(backend, cwd, ["config", "approvals", "list", "--format=json"]);
  if (result.code !== 0) {
    return { kind: "error", detail: result.err.trim() || `exit ${result.code}` };
  }
  const state = parseWorktrunkApprovals(result.out);
  if (!state) return { kind: "error", detail: "incompatible approvals JSON" };
  const commands = state.commands.filter((command) => phases.includes(command.phase) && !command.approved);
  if (commands.length > 0 || state.stale.length > 0) {
    return { kind: "blocked", commands, stale: state.stale };
  }
  return { kind: "approved" };
}

type Notify = (text: string, level: "info" | "error" | "warning") => void;

function reportApprovalBlock(notify: Notify, check: Extract<WorktrunkApprovalCheck, { kind: "blocked" }>): void {
  const lines = [
    ...check.commands.map((command) =>
      `${command.phase}${command.name ? `/${command.name}` : ""}: ${command.template}`
    ),
    ...check.stale.map((template) => `stale approval: ${template}`),
  ];
  notify(
    `Worktrunk project commands require native approval:\n${lines.map((line) => `  ${line}`).join("\n")}\n` +
    "Review the complete scope in this repository with `wt config approvals add`, then retry /wtm.",
    "warning",
  );
}

function filterWorktrunkStderr(stderr: string): string {
  return stderr.split("\n").filter((line) => {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    return !(
      /cannot change directory.*shell integration/i.test(plain) ||
      /to enable automatic cd.*wt config shell install/i.test(plain) ||
      /to change directory, run (?:cd|wt switch)/i.test(plain) ||
      /shell restart.*activates shell integration/i.test(plain)
    );
  }).join("\n").trim();
}

function reportWorktrunkStderr(notify: Notify, stderr: string): void {
  const text = filterWorktrunkStderr(stderr);
  if (!text) return;
  const backgroundFailure = /post-(?:start|switch|commit|remove|merge).*(?:fail|error|exited)/is.test(text);
  notify(
    backgroundFailure
      ? `${text}\nInspect background hook output with \`wt config state logs\`.`
      : text,
    backgroundFailure ? "warning" : "info",
  );
}

type MergeStage = "all" | "tracked" | "none";

interface MergeOptions {
  target: string | null;
  source: string | null;
  noSquash: boolean;
  noCommit: boolean;
  noRebase: boolean;
  noRemove: boolean;
  noFf: boolean;
  stage: MergeStage;
  yes: boolean;
}

type MergeArgumentParse =
  | { kind: "ok"; options: MergeOptions }
  | { kind: "error"; detail: string };

function parseMergeArguments(args: string[]): MergeArgumentParse {
  const options: MergeOptions = {
    target: null,
    source: null,
    noSquash: false,
    noCommit: false,
    noRebase: false,
    noRemove: false,
    noFf: false,
    stage: "all",
    yes: false,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--no-squash") options.noSquash = true;
    else if (arg === "--no-commit") options.noCommit = true;
    else if (arg === "--no-rebase") options.noRebase = true;
    else if (arg === "--no-remove") options.noRemove = true;
    else if (arg === "--no-ff") options.noFf = true;
    else if (arg === "-y" || arg === "--yes") options.yes = true;
    else if (arg === "--source" || arg.startsWith("--source=")) {
      const value = arg === "--source" ? args[++index] : arg.slice("--source=".length);
      if (!value) return { kind: "error", detail: "--source requires an absolute worktree path" };
      if (options.source !== null) return { kind: "error", detail: "--source may be specified only once" };
      options.source = value;
    } else if (arg === "--stage" || arg.startsWith("--stage=")) {
      const value = arg === "--stage" ? args[++index] : arg.slice("--stage=".length);
      if (value !== "all" && value !== "tracked" && value !== "none") {
        return { kind: "error", detail: "--stage requires all, tracked, or none" };
      }
      options.stage = value;
    } else if (arg.startsWith("-")) {
      return { kind: "error", detail: `Unknown merge flag: ${arg}` };
    } else if (options.target) {
      return { kind: "error", detail: "Merge accepts at most one target branch" };
    } else {
      options.target = arg;
    }
  }
  return { kind: "ok", options };
}

function buildMergeContinuation(target: string, options: MergeOptions, sourcePath: string): string {
  const args = [`/wtm merge`, JSON.stringify(target)];
  if (options.noSquash) args.push("--no-squash");
  if (options.noCommit) args.push("--no-commit");
  if (options.noRebase) args.push("--no-rebase");
  if (options.noRemove) args.push("--no-remove");
  if (options.noFf) args.push("--no-ff");
  args.push("--stage", options.stage, "--source", JSON.stringify(sourcePath));
  return args.join(" ");
}

function activeGitOperation(cwd: string): string | null {
  const statePaths: Array<[string, string]> = [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ];
  for (const [gitPath, operation] of statePaths) {
    const result = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", gitPath]);
    if (result.code === 0 && existsSync(stripLineEnding(result.out))) return operation;
  }
  const status = runGit(cwd, ["status", "--porcelain"]);
  if (status.code === 0 && status.out.split("\n").some((line) => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(line))) {
    return "merge conflict";
  }
  return null;
}

interface WorktrunkMergeResult {
  branch: string;
  committed: boolean;
  rebased: boolean;
  removed: boolean;
  squashed: boolean;
  target: string;
}

function parseWorktrunkMerge(out: string): WorktrunkMergeResult | null {
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("branch" in value) ||
    typeof value.branch !== "string" ||
    !("committed" in value) ||
    typeof value.committed !== "boolean" ||
    !("rebased" in value) ||
    typeof value.rebased !== "boolean" ||
    !("removed" in value) ||
    typeof value.removed !== "boolean" ||
    !("squashed" in value) ||
    typeof value.squashed !== "boolean" ||
    !("target" in value) ||
    typeof value.target !== "string"
  ) {
    return null;
  }
  return {
    branch: value.branch,
    committed: value.committed,
    rebased: value.rebased,
    removed: value.removed,
    squashed: value.squashed,
    target: value.target,
  };
}

function branchOid(cwd: string, branch: string): string | null {
  const result = runGit(cwd, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  return result.code === 0 ? result.out.trim() : null;
}

function canonicalPath(value: string): string {
  return realPath(value) ?? path.resolve(value);
}

function stripLineEnding(output: string): string {
  return output.replace(/\r?\n$/, "");
}


function worktrunkFallbackWarning(backend: Exclude<WorktrunkBackend, { kind: "available" } | { kind: "missing" }>): string {
  if (backend.kind === "unsupported") {
    return `Worktrunk ${backend.version} is outside the supported v0.76.x range; using native Git.`;
  }
  return `Worktrunk is not usable (${backend.detail}); using native Git.`;
}

/** realpathSync that tolerates missing paths (returns null instead of throwing). */
function realPath(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

function slugify(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "wt";
}

interface PorcelainWorktree {
  path: string;
  branch: string | null;
  head: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

function listPorcelain(cwd: string): PorcelainWorktree[] {
  const out = runGit(cwd, ["worktree", "list", "--porcelain", "-z"]).out;
  const entries: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;
  for (const field of out.split("\0")) {
    if (!field) {
      current = null;
      continue;
    }
    if (field.startsWith("worktree ")) {
      current = {
        path: field.slice(9),
        branch: null,
        head: "",
        bare: false,
        detached: false,
        prunable: false,
      };
      entries.push(current);
    } else if (current) {
      if (field.startsWith("HEAD ")) current.head = field.slice(5);
      else if (field.startsWith("branch ")) current.branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (field === "bare") current.bare = true;
      else if (field === "detached") current.detached = true;
      else if (field.startsWith("prunable")) current.prunable = true;
    }
  }
  return entries;
}

function worktreeRepositoryIdentity(worktreePath: string): string | null {
  if (!existsSync(worktreePath)) return null;
  const root = runGit(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0 || canonicalPath(stripLineEnding(root.out)) !== canonicalPath(worktreePath)) return null;
  const commonDir = runGit(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return commonDir.code === 0 ? canonicalPath(stripLineEnding(commonDir.out)) : null;
}

function isLiveWorktreePath(worktreePath: string, repositoryIdentity?: string): boolean {
  const identity = worktreeRepositoryIdentity(worktreePath);
  return identity !== null && (repositoryIdentity === undefined || identity === repositoryIdentity);
}

function isLiveWorktree(entry: PorcelainWorktree, repositoryIdentity?: string): boolean {
  return !entry.bare && !entry.prunable && isLiveWorktreePath(entry.path, repositoryIdentity);
}

/** Resolve a user-supplied selector (name or path) to a porcelain worktree entry. */
function resolveWorktree(cwd: string, selector: string): PorcelainWorktree | null {
  const repositoryIdentity = worktreeRepositoryIdentity(cwd);
  if (!repositoryIdentity) return null;
  const entries = listPorcelain(cwd).filter((entry) => isLiveWorktree(entry, repositoryIdentity));
  const abs = path.resolve(cwd, selector);
  const base = worktreeBaseDir();
  // Realpath both candidates and entries: the user may pass a symlinked path
  // (e.g. /tmp on macOS) while git porcelain reports resolved /private/tmp paths.
  const candidates = [abs, path.resolve(base, selector), path.resolve(base, `${path.basename(stripLineEnding(runGit(cwd, ["rev-parse", "--show-toplevel"]).out))}-${selector}`)]
    .map((c) => realPath(c) ?? c);
  return (
    entries.find((e) => candidates.some((c) => c === (realPath(e.path) ?? path.resolve(e.path)))) ??
    entries.find((e) => e.branch === selector) ??
    null
  );
}

function shortPath(p: string): string {
  const home = homedir();
  return p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}

export default function (pi: ExtensionAPI) {
  pi.setLabel("WTM Worktree Manager");

  pi.registerCommand("wtm", {
    description: "Manage Git worktrees with Worktrunk lifecycle and merge automation",
    getArgumentCompletions(arg: string) {
      if (arg.includes(" ")) return null;
      const c = arg.trim().toLowerCase();
      const items = [
        { label: "list", value: "list", description: "list this repo's worktrees" },
        { label: "merge", value: "merge ", description: "run Worktrunk's local merge pipeline" },
        { label: "rm", value: "rm ", description: "remove a worktree" },
        { label: "--all", value: "--all", description: "with rm: remove all other worktrees" },
        { label: "prune", value: "prune", description: "prune stale worktree metadata" },
        { label: "--base", value: "--base ", description: "git ref to base a new worktree on (default HEAD)" },
      ];
      const hits = c ? items.filter((i) => i.label.startsWith(c)) : items;
      return hits.length > 0 ? hits : null;
    },
    async handler(rawArgs: string, ctx) {
      const ui = ctx.ui;
      const notify = (text: string, level: "info" | "error" | "warning") => {
        try { ui.notify(text, level); } catch { console.error(text); }
      };

      const prepareMoveHandoff = (destination: string, continuation?: string): boolean => {
        const resolvedDestination = canonicalPath(destination);
        const command = buildMoveCommand(resolvedDestination);
        if (!command) {
          notify(
            `Worktree remains at ${shortPath(resolvedDestination)}, but its path contains a line break or NUL and cannot be represented as one /move command.`,
            "error",
          );
          return false;
        }
        if (ctx.hasUI && typeof ui.setEditorText === "function") {
          try {
            ui.setEditorText(command);
          } catch {
            // The notification below remains a copyable handoff.
          }
        }
        const lines = [
          `Worktree ready at ${shortPath(resolvedDestination)}; the move command is ready:`,
          `  ${command}`,
        ];
        if (continuation) {
          lines.push("After /move succeeds, run:", `  ${continuation}`);
        }
        notify(lines.join("\n"), "info");
        return true;
      };

      const parsedCommand = parseCommandArguments(rawArgs ?? "");
      if (parsedCommand.kind === "error") {
        notify(`Cannot parse /wtm arguments: ${parsedCommand.detail}.`, "error");
        return;
      }
      const argv = parsedCommand.args;
      const sub = (argv[0] ?? "").toLowerCase();

      if (argv.includes("-h") || argv.includes("--help") || sub === "help") {
        notify(HELP, "info");
        return;
      }

      // ---- shared precondition: git repo ----
      if (runGit(ctx.cwd, ["rev-parse", "--git-dir"]).code !== 0) {
        notify("Not a git repository — /wtm needs a git checkout.", "error");
        return;
      }

      // ---- merge ----
      if (sub === "merge") {
        const parsedArguments = parseMergeArguments(argv.slice(1));
        if (parsedArguments.kind === "error") {
          notify(`${parsedArguments.detail}\n${HELP}`, "error");
          return;
        }
        const options = parsedArguments.options;
        const backend = resolveWorktrunk(ctx.cwd);
        if (backend.kind === "missing") {
          notify("Worktrunk is required for /wtm merge. Install a supported v0.76.x release and retry.", "error");
          return;
        }
        if (backend.kind !== "available") {
          const detail = backend.kind === "unsupported"
            ? `installed version ${backend.version}`
            : backend.detail;
          notify(`Worktrunk v0.76.x is required for /wtm merge (${detail}).`, "error");
          return;
        }

        const probe = probeWorktrunkList(backend, ctx.cwd);
        if (probe.kind === "error") {
          notify(`Worktrunk merge capability probe failed: ${probe.detail}. Repository unchanged.`, "error");
          return;
        }

        const currentRootResult = runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]);
        if (currentRootResult.code !== 0) {
          notify(`Cannot resolve the current worktree: ${currentRootResult.err.trim()}`, "error");
          return;
        }
        const currentPath = stripLineEnding(currentRootResult.out);
        const currentCanonical = canonicalPath(currentPath);
        const currentRepositoryIdentity = worktreeRepositoryIdentity(currentPath);
        const registered = listPorcelain(ctx.cwd);
        const current = registered.find((entry) => canonicalPath(entry.path) === currentCanonical);
        if (!currentRepositoryIdentity || !current || !isLiveWorktree(current, currentRepositoryIdentity)) {
          notify("The current session is not in a live registered worktree.", "error");
          return;
        }

        if (options.source !== null && !path.isAbsolute(options.source)) {
          notify("--source requires an absolute worktree path.", "error");
          return;
        }
        const sourcePath = options.source === null ? currentPath : canonicalPath(options.source);
        const sourceCanonical = canonicalPath(sourcePath);
        const sourceRepositoryIdentity = worktreeRepositoryIdentity(sourcePath);
        const source = registered.find((entry) => canonicalPath(entry.path) === sourceCanonical);
        if (
          !sourceRepositoryIdentity ||
          sourceRepositoryIdentity !== currentRepositoryIdentity ||
          !source ||
          !source.branch ||
          !isLiveWorktree(source, currentRepositoryIdentity)
        ) {
          notify("/wtm merge requires --source to name a live registered branch worktree in the current repository.", "error");
          return;
        }

        const target = options.target ?? probe.list.defaultBranch;
        const targetBefore = branchOid(currentPath, target);
        const sourceBefore = branchOid(sourcePath, source.branch);
        if (!targetBefore) {
          notify(`Target branch ${target} does not exist locally; /wtm merge never fetches.`, "error");
          return;
        }
        if (!sourceBefore) {
          notify(`Cannot resolve source branch ${source.branch}.`, "error");
          return;
        }

        const inProgress = activeGitOperation(sourcePath);
        if (inProgress) {
          notify(
            `Source ${source.branch} has an in-progress ${inProgress}; resolve or abort it in ${shortPath(sourcePath)} before starting a new merge.`,
            "error",
          );
          return;
        }

        const primaryMetadata = probe.list.items.find((item) => item.main);
        const primaryPath = primaryMetadata && isLiveWorktreePath(primaryMetadata.path, currentRepositoryIdentity)
          ? primaryMetadata.path
          : null;
        const targetWorktree = registered.find((entry) =>
          entry.branch === target &&
          canonicalPath(entry.path) !== sourceCanonical &&
          isLiveWorktree(entry, currentRepositoryIdentity)
        );
        const sourceIsPrimary = primaryPath ? canonicalPath(primaryPath) === sourceCanonical : false;
        const cleanupCanRemoveSource = !options.noRemove && !sourceIsPrimary && source.branch !== target;
        const statusLines = runGit(sourcePath, ["status", "--porcelain"]).out.split("\n").filter(Boolean);

        if (
          cleanupCanRemoveSource &&
          statusLines.length === 0 &&
          runGit(currentPath, ["merge-base", "--is-ancestor", sourceBefore, targetBefore]).code === 0
        ) {
          notify(
            `Worktrunk integration is already complete for ${source.branch} -> ${target}, but source cleanup remains. ` +
            "The merge pipeline was not replayed. Inspect `wt config state logs`, then finish cleanup with native Worktrunk.",
            "warning",
          );
          return;
        }

        if (cleanupCanRemoveSource && currentCanonical === sourceCanonical) {
          const safePath = targetWorktree?.path ??
            (primaryPath && canonicalPath(primaryPath) !== sourceCanonical ? primaryPath : null);
          if (!safePath) {
            notify("Cannot find a registered safe landing outside the source worktree; repository unchanged.", "error");
            return;
          }
          const continuation = buildMergeContinuation(target, options, sourceCanonical);
          prepareMoveHandoff(safePath, continuation);
          return;
        }

        const approvalPhases = ["pre-merge", "post-merge"];
        if (!options.noCommit) {
          approvalPhases.push("pre-commit", "post-commit", "commit-template-append");
        }
        if (!options.noRemove && source.branch !== target) {
          approvalPhases.push("pre-remove", "post-remove", "post-switch");
        }
        const approval = checkWorktrunkApprovals(backend, sourcePath, approvalPhases);
        if (approval.kind === "error") {
          notify(`Worktrunk approval probe failed: ${approval.detail}. Repository unchanged.`, "error");
          return;
        }
        if (approval.kind === "blocked") {
          reportApprovalBlock(notify, approval);
          return;
        }

        const staged = statusLines.filter((line) => line[0] !== " " && line[0] !== "?").length;
        const unstaged = statusLines.filter((line) => line[1] !== " " && line[0] !== "?").length;
        const untracked = statusLines.filter((line) => line.startsWith("??")).length;
        const commits = runGit(sourcePath, ["rev-list", "--count", `${target}..${source.branch}`]).out.trim();
        if (!options.yes) {
          const summary = [
            `Source: ${source.branch} (${sourceBefore.slice(0, 12)})`,
            `Target: ${target} (${targetBefore.slice(0, 12)})`,
            `Changes: ${staged} staged, ${unstaged} unstaged, ${untracked} untracked`,
            `Commits ahead: ${commits || "unknown"}`,
            `Stage: ${options.stage}`,
            `Commit: ${options.noCommit ? "disabled" : "enabled"}`,
            `Squash: ${options.noSquash || options.noCommit ? "disabled" : "enabled"}`,
            `Rebase: ${options.noRebase ? "disabled" : "enabled"}`,
            `Fast-forward: ${options.noFf ? "merge commit" : "required"}`,
            `Cleanup: ${options.noRemove ? "disabled" : cleanupCanRemoveSource ? "enabled" : "preserved by Worktrunk"}`,
            "Message: existing commits, configured Worktrunk generator, or deterministic fallback",
          ].join("\n");
          const confirmed = ctx.hasUI ? await ui.confirm("Merge worktree", summary) : true;
          if (!confirmed) {
            notify("Cancelled.", "info");
            return;
          }
        }

        const mergeArgs = ["merge", target, "--stage", options.stage];
        if (options.noSquash) mergeArgs.push("--no-squash");
        if (options.noCommit) mergeArgs.push("--no-commit");
        if (options.noRebase) mergeArgs.push("--no-rebase");
        if (options.noRemove) mergeArgs.push("--no-remove");
        if (options.noFf) mergeArgs.push("--no-ff");
        mergeArgs.push("--format=json", "-C", sourcePath);

        const result = runWorktrunk(backend, currentPath, mergeArgs);
        const parsed = result.code === 0 ? parseWorktrunkMerge(result.out) : null;
        const compatibleResult = parsed && parsed.branch === source.branch && parsed.target === target
          ? parsed
          : null;
        const targetAfter = branchOid(currentPath, target);
        const targetState = targetAfter === null
          ? "absent or unreadable"
          : targetAfter !== targetBefore ? "updated" : "unchanged";
        const afterEntries = listPorcelain(currentPath);
        const sourceRegistered = afterEntries.some((entry) => canonicalPath(entry.path) === sourceCanonical);
        const sourceBranchPresent = branchOid(currentPath, source.branch) !== null;
        const sourcePathPresent = existsSync(sourcePath);
        const cleanup = result.code === 0 && compatibleResult?.removed
          ? "cleanup scheduled"
          : "cleanup not confirmed";
        const state = [
          `target ${target} ${targetState}`,
          `source worktree ${sourceRegistered ? "registered" : "not registered"}`,
          `source branch ${sourceBranchPresent ? "present" : "absent"}`,
          `source path ${sourcePathPresent ? "present" : "absent"}`,
          cleanup,
        ].join("; ");
        const session = primaryPath && canonicalPath(primaryPath) === currentCanonical
          ? `Session remains at primary safe landing ${shortPath(currentPath)}; primary branch may differ from merge target ${target}.`
          : current.branch === target
            ? `Session remains at target worktree ${shortPath(currentPath)}.`
            : `Session remains at safe worktree ${shortPath(currentPath)}.`;

        if (result.code !== 0) {
          notify(
            `Worktrunk merge failed or partially completed: ${filterWorktrunkStderr(result.err) || `exit ${result.code}`}. ${state}. ${session} Native Git was not retried.`,
            "error",
          );
        } else if (!compatibleResult) {
          notify(
            `Worktrunk merge returned incompatible JSON after execution. ${state}. ${session} Native Git was not retried.`,
            "error",
          );
        } else {
          notify(`Worktrunk merge completed: ${state}. ${session}`, "info");
          reportWorktrunkStderr(notify, result.err);
        }
        return;
      }

      // ---- list ----
      if (sub === "list" || sub === "ls") {
        const backend = resolveWorktrunk(ctx.cwd);
        if (backend.kind === "available") {
          const probe = probeWorktrunkList(backend, ctx.cwd);
          if (probe.kind === "ok") {
            const lines = probe.list.items.map((item) => {
              const ref = item.branch ? `[${item.branch}]` : item.detached ? `(detached ${item.head.slice(0, 7)})` : "(?)";
              const here = item.current || (realPath(item.path) ?? item.path) === (realPath(ctx.cwd) ?? ctx.cwd) ? "  <- current" : "";
              return `  ${shortPath(item.path).padEnd(46)} ${ref}${here}`;
            });
            notify(`Worktrees (default ${probe.list.defaultBranch}):\n${lines.join("\n")}`, "info");
            return;
          }
          notify(`Worktrunk list probe failed (${probe.detail}); using native Git.`, "warning");
        } else if (backend.kind !== "missing") {
          notify(worktrunkFallbackWarning(backend), "warning");
        }

        const entries = listPorcelain(ctx.cwd);
        const lines = entries.map((entry) => {
          const ref = entry.bare ? "(bare)" : entry.branch ? `[${entry.branch}]` : entry.detached ? `(detached ${entry.head.slice(0, 7)})` : "(?)";
          const here = (realPath(entry.path) ?? entry.path) === (realPath(ctx.cwd) ?? ctx.cwd) ? "  <- current" : "";
          return `  ${shortPath(entry.path).padEnd(46)} ${ref}${here}`;
        });
        notify(`Worktrees of ${shortPath(stripLineEnding(runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]).out))}:\n${lines.join("\n")}`, "info");
        return;
      }

      // ---- prune ----
      if (sub === "prune") {
        const r = runGit(ctx.cwd, ["worktree", "prune"]);
        if (r.code !== 0) { notify(`git worktree prune failed: ${r.err}`, "error"); return; }
        notify("Pruned stale worktree metadata.", "info");
        return;
      }

      // ---- rm ----
      if (sub === "rm" || sub === "remove" || sub === "del") {
        const rest = argv.slice(1);
        const force = rest.includes("-f") || rest.includes("--force");
        const yes = rest.includes("-y") || rest.includes("--yes");
        const all = rest.includes("-a") || rest.includes("--all");
        const selector = rest.find((a) => !a.startsWith("-"));

        // main working tree (where the session falls back to when removing its own worktree)
        const commonDir = stripLineEnding(runGit(ctx.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out);
        const configuredWorktree = runGit(ctx.cwd, ["config", "--path", "--get", "core.worktree"]);
        const repositoryIdentity = worktreeRepositoryIdentity(ctx.cwd);
        const configuredWorktreePath = stripLineEnding(configuredWorktree.out);
        let mainPath = repositoryIdentity && configuredWorktree.code === 0 &&
          isLiveWorktreePath(configuredWorktreePath, repositoryIdentity)
          ? configuredWorktreePath
          : repositoryIdentity && commonDir &&
              isLiveWorktreePath(path.dirname(commonDir), repositoryIdentity)
            ? path.dirname(commonDir)
            : "";

        let worktrunkBackend: Extract<WorktrunkBackend, { kind: "available" }> | null = null;
        const detectedBackend = resolveWorktrunk(ctx.cwd);
        if (detectedBackend.kind === "available") {
          const probe = probeWorktrunkList(detectedBackend, ctx.cwd);
          if (probe.kind === "ok") {
            worktrunkBackend = detectedBackend;
            const primary = probe.list.items.find((item) => item.main);
            if (primary && repositoryIdentity && isLiveWorktreePath(primary.path, repositoryIdentity)) mainPath = primary.path;
          } else {
            notify(`Worktrunk remove probe failed (${probe.detail}); using native Git.`, "warning");
          }
        } else if (detectedBackend.kind !== "missing") {
          notify(worktrunkFallbackWarning(detectedBackend), "warning");
        }

        // ---- rm --all: remove every worktree except the current one and the main tree ----
        if (all) {
          if (selector) {
            notify("--all takes no selector — use /wtm rm --all or /wtm rm <name|path|self>", "error");
            return;
          }
          // Realpath both sides: ctx.cwd may be a symlinked path (e.g. /tmp on macOS)
          // while git porcelain reports the resolved path — lexical equality misses it
          // and would treat the session's own worktree as removable.
          const cwdAbs = realPath(ctx.cwd) ?? path.resolve(ctx.cwd);
          const mainAbs = mainPath ? realPath(mainPath) ?? path.resolve(mainPath) : "";
          // skip: the main tree, the session's own worktree, bare entries, and stale
          // registrations whose directory is gone (those are cleaned by the final prune)
          const victims = listPorcelain(ctx.cwd).filter((entry) => {
            const candidate = canonicalPath(entry.path);
            return candidate !== cwdAbs && candidate !== mainAbs &&
              repositoryIdentity !== null && isLiveWorktree(entry, repositoryIdentity);
          });
          if (victims.length === 0) {
            notify("No other worktrees to remove.", "info");
            return;
          }
          const dirty = victims.filter((v) => runGit(v.path, ["status", "--porcelain"]).out.trim() !== "");
          if (dirty.length > 0 && !force) {
            notify(
              `${dirty.length} of ${victims.length} worktree(s) have uncommitted changes (e.g. ${shortPath(dirty[0].path)}).\nUse -f to remove anyway.`,
              "warning",
            );
            return;
          }
          if (worktrunkBackend) {
            const approval = checkWorktrunkApprovals(worktrunkBackend, ctx.cwd, ["pre-remove", "post-remove"]);
            if (approval.kind === "error") {
              notify(`Worktrunk approval probe failed (${approval.detail}); using native Git.`, "warning");
              worktrunkBackend = null;
            } else if (approval.kind === "blocked") {
              reportApprovalBlock(notify, approval);
              return;
            }
          }

          if (!yes) {
            const msg =
              `Remove ${victims.length} worktree(s)?\n` +
              victims.map((v) => `  ${shortPath(v.path)}${v.branch ? ` [${v.branch}]` : ""}`).join("\n") +
              (dirty.length > 0 ? `\nUncommitted changes in ${dirty.length} worktree(s) will be lost.` : "");
            const ok = ctx.hasUI ? await ui.confirm("Remove worktrees", msg) : true;
            if (!ok) { notify("Cancelled.", "info"); return; }
          }
          const gitCwd = mainPath || ctx.cwd;
          const removedPaths: string[] = [];
          const issues: string[] = [];
          for (const victim of victims) {
            if (!repositoryIdentity || !isLiveWorktreePath(victim.path, repositoryIdentity)) {
              issues.push(`${shortPath(victim.path)} (no longer a live worktree in the current repository)`);
              continue;
            }
            if (worktrunkBackend) {
              const beforeWorktrees = listPorcelain(gitCwd).filter((entry) => isLiveWorktree(entry, repositoryIdentity));
              const outcome = removeWithWorktrunk(worktrunkBackend, gitCwd, victim.path, victim.branch, force);
              if (outcome.kind !== "error") reportWorktrunkStderr(notify, outcome.stderr);
              const victimReal = canonicalPath(victim.path);
              const afterWorktrees = listPorcelain(gitCwd).filter((entry) => isLiveWorktree(entry, repositoryIdentity));
              const stillRegistered = afterWorktrees.some((entry) => canonicalPath(entry.path) === victimReal);
              const removed = !stillRegistered && !existsSync(victim.path);
              const unexpected = beforeWorktrees.filter((entry) =>
                canonicalPath(entry.path) !== victimReal &&
                !afterWorktrees.some((after) => canonicalPath(after.path) === canonicalPath(entry.path))
              );
              if (removed) removedPaths.push(shortPath(victim.path));
              if (outcome.kind === "error") {
                issues.push(`${shortPath(victim.path)} (${outcome.detail}${removed ? "; removal confirmed" : ""})`);
              } else if (outcome.kind === "incompatible") {
                issues.push(`${shortPath(victim.path)} (${outcome.detail}${removed ? "; removal confirmed" : ""})`);
              } else if (!removed) {
                issues.push(`${shortPath(victim.path)} (still registered after Worktrunk success)`);
              }
              if (unexpected.length > 0) {
                issues.push(`unexpectedly removed ${unexpected.map((entry) => shortPath(entry.path)).join(", ")}`);
              }
              continue;
            }

            const args = ["worktree", "remove"];
            if (force) args.push("--force");
            args.push(victim.path);
            const result = runGit(gitCwd, args);
            if (result.code === 0) removedPaths.push(shortPath(victim.path));
            else issues.push(`${shortPath(victim.path)} (${result.err.trim() || `exit ${result.code}`})`);
          }
          runGit(gitCwd, ["worktree", "prune"]);
          notify(
            issues.length === 0
              ? `Removed ${removedPaths.length} worktree(s):\n${removedPaths.map((removed) => `  ${removed}`).join("\n")}`
              : `Removed ${removedPaths.length}, issues ${issues.length}:\n${issues.join("\n")}`,
            issues.length === 0 ? "info" : "warning",
          );
          return;
        }

        if (!selector) {
          notify("Usage: /wtm rm <name|path|self> [-f] [-y] | /wtm rm --all [-f] [-y]", "error");
          return;
        }

        const isSelf = selector === "self" || selector === ".";
        const cwdReal = realPath(ctx.cwd) ?? path.resolve(ctx.cwd);
        const mainReal = mainPath ? realPath(mainPath) ?? path.resolve(mainPath) : "";
        const target = isSelf
          ? listPorcelain(ctx.cwd).find((e) => (realPath(e.path) ?? path.resolve(e.path)) === cwdReal) ?? null
          : resolveWorktree(ctx.cwd, selector);
        if (!target) {
          notify(isSelf ? "Current directory is not a linked worktree (already on the main tree)." : `No live worktree in the current repository matches "${selector}". Try /wtm list.`, "error");
          return;
        }

        const targetReal = realPath(target.path) ?? path.resolve(target.path);
        const targetIsCwd = targetReal === cwdReal;
        if (mainReal && targetReal === mainReal) {
          notify("Refusing to remove the main working tree.", "error");
          return;
        }
        if (!isSelf && targetIsCwd) {
          notify(`This is the session's worktree — use /wtm rm self (removes it and prepares a move to ${shortPath(mainPath)}).`, "warning");
          return;
        }

        let selfMoveDestination: string | null = null;
        if (isSelf && targetIsCwd) {
          if (!mainPath || !repositoryIdentity || !isLiveWorktreePath(mainPath, repositoryIdentity)) {
            notify("Cannot determine a live primary worktree for the move handoff.", "error");
            return;
          }
          selfMoveDestination = mainPath;
          if (!buildMoveCommand(canonicalPath(mainPath))) {
            prepareMoveHandoff(mainPath);
            return;
          }
        }

        if (!repositoryIdentity || !isLiveWorktreePath(target.path, repositoryIdentity)) {
          notify(`Refusing to remove ${shortPath(target.path)} because it is not a live worktree in the current repository.`, "error");
          return;
        }

        // dirty check → confirm
        const dirty = runGit(target.path, ["status", "--porcelain"]).out.trim();
        if (dirty && !force) {
          notify(`Worktree ${shortPath(target.path)} has uncommitted changes:\n${dirty.split("\n").slice(0, 5).join("\n")}\nUse -f to remove anyway.`, "warning");
          return;
        }
        if (worktrunkBackend) {
          const approval = checkWorktrunkApprovals(worktrunkBackend, ctx.cwd, ["pre-remove", "post-remove"]);
          if (approval.kind === "error") {
            notify(`Worktrunk approval probe failed (${approval.detail}); using native Git.`, "warning");
            worktrunkBackend = null;
          } else if (approval.kind === "blocked") {
            reportApprovalBlock(notify, approval);
            return;
          }
        }

        if (!yes) {
          const msg = `Remove worktree ${shortPath(target.path)}${target.branch ? ` (branch ${target.branch}, HEAD ${target.head.slice(0, 12)})` : ""}?` +
            (dirty ? "\nUncommitted changes will be lost." : "");
          const ok = ctx.hasUI ? await ui.confirm("Remove worktree", msg) : true;
          if (!ok) { notify("Cancelled.", "info"); return; }
        }

        if (!isLiveWorktreePath(target.path, repositoryIdentity)) {
          notify(`Refusing to remove ${shortPath(target.path)} because its repository identity changed after confirmation.`, "error");
          return;
        }


        const gitCwd = mainPath || ctx.cwd;
        if (worktrunkBackend) {
          const beforeWorktrees = listPorcelain(gitCwd).filter((entry) => isLiveWorktree(entry, repositoryIdentity));
          const outcome = removeWithWorktrunk(worktrunkBackend, gitCwd, target.path, target.branch, force);
          if (outcome.kind !== "error") reportWorktrunkStderr(notify, outcome.stderr);
          const afterWorktrees = listPorcelain(gitCwd).filter((entry) => isLiveWorktree(entry, repositoryIdentity));
          const stillRegistered = afterWorktrees.some((entry) => canonicalPath(entry.path) === targetReal);
          const removed = !stillRegistered && !existsSync(target.path);
          const unexpected = beforeWorktrees.filter((entry) =>
            canonicalPath(entry.path) !== targetReal &&
            !afterWorktrees.some((after) => canonicalPath(after.path) === canonicalPath(entry.path))
          );
          if (!removed) {
            const outcomeDetail = outcome.kind === "error"
              ? outcome.detail
              : outcome.kind === "incompatible"
                ? outcome.detail
                : "worktree is still registered";
            const collateral = unexpected.length > 0
              ? `; unexpectedly removed ${unexpected.map((entry) => shortPath(entry.path)).join(", ")}`
              : "";
            notify(`Worktrunk remove failed for ${shortPath(target.path)}: ${outcomeDetail}${collateral}`, "error");
            return;
          }

          runGit(gitCwd, ["worktree", "prune"]);
          const details: string[] = [];
          if (outcome.kind === "error") details.push(`command reported ${outcome.detail}`);
          else if (outcome.kind === "incompatible") details.push(outcome.detail);
          if (unexpected.length > 0) {
            details.push(`unexpectedly removed ${unexpected.map((entry) => shortPath(entry.path)).join(", ")}`);
          }
          const detail = details.length > 0 ? `; ${details.join("; ")}` : "";
          notify(
            `Removed worktree ${shortPath(target.path)}${detail}`,
            details.length > 0 ? "warning" : "info",
          );
          if (selfMoveDestination) prepareMoveHandoff(selfMoveDestination);
          return;
        }

        const args = ["worktree", "remove"];
        if (force) args.push("--force");
        args.push(target.path);
        const result = runGit(gitCwd, args);
        if (result.code !== 0) {
          notify(`git worktree remove failed: ${result.err}`, "error");
          return;
        }
        runGit(gitCwd, ["worktree", "prune"]);
        notify(`Removed worktree ${shortPath(target.path)}`, "info");
        if (selfMoveDestination) prepareMoveHandoff(selfMoveDestination);
        return;
      }

      // ---- create (default) ----
      // parse: [name] [--base <ref>]
      const positional: string[] = [];
      let baseRef = "";
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--base") {
          const v = argv[i + 1];
          if (!v || v.startsWith("-")) { notify("--base requires a git ref", "error"); return; }
          baseRef = v;
          i++;
        } else {
          positional.push(argv[i]);
        }
      }

      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
      const name = slugify(positional[0] ?? `wt-${stamp}`);
      const root = stripLineEnding(runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]).out);
      const baseDir = worktreeBaseDir();
      const wtPath = path.join(baseDir, `${path.basename(root)}-${name}`);

      const backend = resolveWorktrunk(ctx.cwd);
      if (backend.kind === "available") {
        const probe = probeWorktrunkList(backend, ctx.cwd);
        if (probe.kind === "error") {
          notify(`Worktrunk switch probe failed (${probe.detail}); using native Git.`, "warning");
        } else {
          const branchExists = runGit(ctx.cwd, ["branch", "--list", name]).out.trim() !== "";
          const worktreeExists = probe.list.items.some((item) => item.branch === name);
          const phases = worktreeExists
            ? ["pre-switch", "post-switch"]
            : ["pre-switch", "pre-start", "post-start", "post-switch"];
          const approval = checkWorktrunkApprovals(backend, ctx.cwd, phases);
          if (approval.kind === "error") {
            notify(`Worktrunk approval probe failed (${approval.detail}); using native Git.`, "warning");
          } else if (approval.kind === "blocked") {
            reportApprovalBlock(notify, approval);
            return;
          } else {
            const worktrunkArgs = ["switch"];
            if (!branchExists) {
              worktrunkArgs.push("--create", name, `--base=${baseRef || "@"}`);
            } else {
              worktrunkArgs.push(name);
            }
            worktrunkArgs.push("--no-cd", "--format=json");
            if (process.env.OMP_WORKTREE_DIR) {
              worktrunkArgs.push("--config-set", `worktree-path=${JSON.stringify(wtPath)}`);
            }

            const result = runWorktrunk(backend, ctx.cwd, worktrunkArgs);
            if (result.code !== 0) {
              const afterFailure = probeWorktrunkList(backend, ctx.cwd);
              const retained = afterFailure.kind === "ok"
                ? afterFailure.list.items.find((item) => item.branch === name)
                : null;
              const detail = filterWorktrunkStderr(result.err) || `exit ${result.code}`;
              notify(
                retained
                  ? `Worktrunk switch failed after retaining ${shortPath(retained.path)}: ${detail}. Retry /wtm ${name} to reuse it.`
                  : `Worktrunk switch failed: ${detail}`,
                "error",
              );
              return;
            }
            const switched = parseWorktrunkSwitch(result.out);
            if (!switched) {
              notify("Worktrunk switch changed repository state but returned incompatible JSON; native Git was not retried.", "error");
              return;
            }
            const sourceRepositoryIdentity = worktreeRepositoryIdentity(ctx.cwd);
            const reconciled = listPorcelain(ctx.cwd);
            const switchedEntry = reconciled.find((entry) =>
              canonicalPath(entry.path) === canonicalPath(switched.path)
            );
            if (
              switched.branch !== name ||
              !switchedEntry ||
              switchedEntry.branch !== name ||
              !sourceRepositoryIdentity ||
              !isLiveWorktree(switchedEntry, sourceRepositoryIdentity)
            ) {
              const retained = reconciled.find((entry) =>
                entry.branch === name &&
                sourceRepositoryIdentity !== null &&
                isLiveWorktree(entry, sourceRepositoryIdentity)
              );
              notify(
                `Worktrunk switch returned ${shortPath(switched.path)}, which is not a live registered worktree for branch ${name}.` +
                `${retained ? ` Reconciled worktree: ${shortPath(retained.path)}.` : ""} Repository state was retained; native Git was not retried.`,
                "error",
              );
              return;
            }
            notify(`${worktreeExists ? "Reusing" : "Created"} Worktrunk worktree: ${shortPath(switched.path)} (branch ${switched.branch})`, "info");
            reportWorktrunkStderr(notify, result.err);
            prepareMoveHandoff(switched.path);
            return;
          }
        }
      } else if (backend.kind !== "missing") {
        notify(worktrunkFallbackWarning(backend), "warning");
      }

      const existing = listPorcelain(ctx.cwd).find((e) => path.resolve(e.path) === path.resolve(wtPath));
      if (existing) {
        notify(`Reusing existing worktree: ${shortPath(wtPath)}`, "info");
      } else {
        // If a local branch <name> already exists, `git worktree add <path> <name>` checks it
        // out; otherwise create it from --base (default HEAD).
        const branches = runGit(ctx.cwd, ["branch", "--list", name]).out.trim();
        const gitArgs = ["worktree", "add"];
        if (branches) gitArgs.push(wtPath, name);
        else if (baseRef) gitArgs.push(wtPath, "-b", name, baseRef);
        else gitArgs.push(wtPath, "-b", name);
        const r = runGit(ctx.cwd, gitArgs);
        if (r.code !== 0) {
          notify(`git worktree add failed: ${r.err}`, "error");
          return;
        }
        notify(`Created worktree: ${shortPath(wtPath)} (branch ${name})`, "info");
      }

      const repositoryIdentity = worktreeRepositoryIdentity(ctx.cwd);
      const destination = listPorcelain(ctx.cwd).find((entry) =>
        canonicalPath(entry.path) === canonicalPath(wtPath)
      );
      if (!destination || destination.branch !== name || !repositoryIdentity || !isLiveWorktree(destination, repositoryIdentity)) {
        notify(`Cannot verify ${shortPath(wtPath)} as a live registered worktree for branch ${name}.`, "error");
        return;
      }
      prepareMoveHandoff(destination.path);
    },
  });
}
