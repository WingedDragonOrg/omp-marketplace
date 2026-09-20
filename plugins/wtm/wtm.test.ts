import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import registerWorktreeManager from "./wtm.ts";

const originalPath = process.env.PATH;
const originalWorktreeDir = process.env.OMP_WORKTREE_DIR;
const temporaryRoots: string[] = [];

interface Notice {
  text: string;
  level: "info" | "error" | "warning";
}

interface HandlerContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify(text: string, level: Notice["level"]): void;
    confirm(title: string, message: string): Promise<boolean>;
    setEditorText(text: string): void;
  };
  sessionManager: {
    moveTo(destination: string): Promise<void>;
  };
  reload(): Promise<void>;
}

interface RegisteredCommand {
  handler(args: string, ctx: HandlerContext): Promise<void>;
}

interface Harness {
  handler: RegisteredCommand["handler"];
  notices: Notice[];
  sentMessages: string[];
  editorTexts: string[];
  moves: string[];
  confirmations: Array<{ title: string; message: string }>;
  reloads: number;
  ctx: HandlerContext;
}

function isRegisteredCommand(value: unknown): value is RegisteredCommand {
  return value !== null && typeof value === "object" && "handler" in value && typeof value.handler === "function";
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function runGitBranchExists(cwd: string, branch: string): boolean {
  const result = Bun.spawnSync(["git", "show-ref", "--verify", `refs/heads/${branch}`], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-wt-test-")));
  temporaryRoots.push(root);
  return root;
}

function initRepo(root: string): string {
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "WT Test"]);
  git(repo, ["config", "user.email", "wt-test@example.invalid"]);
  writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

interface ListWorktreeFixture {
  branch: string | null;
  path: string;
  main: boolean;
  current: boolean;
}

function worktrunkListFixture(defaultBranch: string, worktrees: ListWorktreeFixture[]): object {
  return {
    schema: 2,
    repo: { default_branch: defaultBranch, forge: null },
    collected: { ci: false, summary: false },
    items: worktrees.map((worktree, index) => ({
      branch: worktree.branch,
      head: {
        sha: `${index + 1}`.repeat(40),
        short_sha: `${index + 1}`.repeat(7),
        subject: "fixture",
        committed_at: "2026-09-02T00:00:00Z",
      },
      worktree: {
        path: worktree.path,
        main: worktree.main,
        current: worktree.current,
        previous: false,
        detached: worktree.branch === null,
        branch_mismatch: false,
        duplicate_branch: false,
        changes: {
          staged: false,
          modified: false,
          untracked: false,
          renamed: false,
          deleted: false,
          conflicted: false,
          diff: { added: 0, deleted: 0 },
        },
      },
      display: { state: "fixture", symbols: "", statusline: "fixture" },
    })),
  };
}

function initMergeSource(root: string, branch = "feature"): { repo: string; source: string } {
  const repo = initRepo(root);
  const source = path.join(root, branch);
  git(repo, ["worktree", "add", "-b", branch, source]);
  writeFileSync(path.join(source, `${branch}.txt`), `${branch}\n`);
  git(source, ["add", `${branch}.txt`]);
  git(source, ["commit", "-m", `add ${branch}`]);
  return { repo, source };
}

/** Point refs/remotes/origin/<target> at a commit and make <target> track it, so `@{upstream}` resolves. */
function trackUpstream(root: string, repo: string, target: string, tip: string): void {
  git(repo, ["update-ref", `refs/remotes/origin/${target}`, tip]);
  git(repo, ["config", "remote.origin.url", path.join(root, "origin.git")]);
  git(repo, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  git(repo, ["config", `branch.${target}.remote`, "origin"]);
  git(repo, ["config", `branch.${target}.merge`, `refs/heads/${target}`]);
}

/** Count object files so a test can prove a read-only check wrote nothing into the repository. */
function objectCount(cwd: string): number {
  const objects = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  let count = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
      else count++;
    }
  };
  walk(objects);
  return count;
}

function makeHarness(cwd: string): Harness {
  let command: RegisteredCommand | undefined;
  const notices: Notice[] = [];
  const sentMessages: string[] = [];
  const editorTexts: string[] = [];
  const moves: string[] = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const state = { reloads: 0 };
  registerWorktreeManager({
    setLabel() {},
    sendUserMessage(content: string) {
      sentMessages.push(content);
    },
    registerCommand(name: string, spec: unknown) {
      if (name === "wtm" && isRegisteredCommand(spec)) command = spec;
    },
  });
  if (!command) throw new Error("/wtm command was not registered");

  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify(text: string, level: Notice["level"]) {
        notices.push({ text, level });
      },
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return true;
      },
      setEditorText(text: string) {
        editorTexts.push(text);
      },
    },
    sessionManager: {
      async moveTo(destination: string) {
        moves.push(destination);
        process.env.WT_TEST_MOVED_TO = destination;
      },
    },
    async reload() {
      state.reloads++;
    },
  };

  return {
    handler: command.handler,
    notices,
    sentMessages,
    editorTexts,
    moves,
    confirmations,
    get reloads() { return state.reloads; },
    ctx,
  };
}

function installFakeWorktrunk(root: string, options: {
  version?: string;
  list?: unknown;
  approvals?: unknown;
  switchResult?: unknown;
  switchExit?: number;
  switchStderr?: string;
  realSwitch?: boolean;
  removeResult?: unknown;
  removeExit?: number;
  realRemove?: boolean;
  removeRaw?: string;
  removeReportedPath?: string;
  removeCollateral?: string;
  mergeResult?: unknown;
  mergeRaw?: string;
  mergeExit?: number;
  mergeStderr?: string;
  mergeUpdateTarget?: boolean;
  mergeDeleteTarget?: boolean;
  mergeRemoveSource?: boolean;
  mergeDeleteSourceBranch?: boolean;
  mergePrimary?: string;
  mergeTarget?: string;
  requiredMove?: string;
  deleteAfterApprovals?: boolean;
} = {}): string {
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const executable = path.join(bin, "wt");
  const log = path.join(root, "wt-calls.jsonl");
  const script = `#!${process.execPath}\n` + String.raw`
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
const argv = process.argv.slice(1);
const args = argv[0] === import.meta.path ? argv.slice(1) : argv;
appendFileSync(process.env.WT_FAKE_LOG, JSON.stringify(args) + "\n");
if (args.includes("--version")) {
  console.log("wt v" + process.env.WT_FAKE_VERSION);
} else if (args.includes("approvals")) {
  if (process.env.WT_FAKE_DELETE_AFTER_APPROVALS === "1") rmSync(import.meta.path);
  console.log(process.env.WT_FAKE_APPROVALS);
} else if (args.includes("list")) {
  console.log(process.env.WT_FAKE_LIST);
} else if (args.includes("switch")) {
  if (process.env.WT_FAKE_SWITCH_STDERR) console.error(process.env.WT_FAKE_SWITCH_STDERR);
  const requestedExit = Number(process.env.WT_FAKE_SWITCH_EXIT);
  if (requestedExit !== 0) process.exit(requestedExit);
  if (process.env.WT_FAKE_REAL_SWITCH === "1") {
    const switched = JSON.parse(process.env.WT_FAKE_SWITCH);
    const registered = Bun.spawnSync(["git", "-C", switched.path, "rev-parse", "--git-dir"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (registered.exitCode !== 0) {
      mkdirSync(dirname(switched.path), { recursive: true });
      const branchExists = Bun.spawnSync(["git", "show-ref", "--verify", "refs/heads/" + switched.branch], {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode === 0;
      const addArgs = branchExists
        ? ["git", "worktree", "add", switched.path, switched.branch]
        : ["git", "worktree", "add", "-b", switched.branch, switched.path, "@"];
      const added = Bun.spawnSync(addArgs, {
        cwd: process.cwd(),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (added.exitCode !== 0) {
        console.error(new TextDecoder().decode(added.stderr));
        process.exit(added.exitCode ?? 1);
      }
    }
  }
  console.log(process.env.WT_FAKE_SWITCH);
} else if (args.includes("merge")) {
  const requiredMove = process.env.WT_FAKE_REQUIRED_MOVE;
  if (requiredMove && process.env.WT_TEST_MOVED_TO !== requiredMove) {
    console.error("merge started before the required session move");
    process.exit(71);
  }
  const source = args.includes("-C") ? args[args.indexOf("-C") + 1] : process.cwd();
  const primary = process.env.WT_FAKE_MERGE_PRIMARY;
  const mergeIndex = args.indexOf("merge");
  const targetArg = args[mergeIndex + 1];
  const target = targetArg && !targetArg.startsWith("-")
    ? targetArg
    : process.env.WT_FAKE_MERGE_TARGET;
  const sourceBranchResult = Bun.spawnSync(["git", "-C", source, "branch", "--show-current"], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const sourceBranch = new TextDecoder().decode(sourceBranchResult.stdout).trim();
  if (process.env.WT_FAKE_MERGE_UPDATE_TARGET === "1") {
    const sourceHead = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const oid = new TextDecoder().decode(sourceHead.stdout).trim();
    const update = Bun.spawnSync(["git", "-C", primary, "update-ref", "refs/heads/" + target, oid], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (update.exitCode !== 0) {
      console.error(new TextDecoder().decode(update.stderr));
      process.exit(update.exitCode ?? 1);
    }
  }
  if (process.env.WT_FAKE_MERGE_DELETE_TARGET === "1") {
    const deletion = Bun.spawnSync(["git", "-C", primary, "update-ref", "-d", "refs/heads/" + target], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (deletion.exitCode !== 0) {
      console.error(new TextDecoder().decode(deletion.stderr));
      process.exit(deletion.exitCode ?? 1);
    }
  }
  if (process.env.WT_FAKE_MERGE_REMOVE_SOURCE === "1") {
    process.chdir(primary);
    const removal = Bun.spawnSync(["git", "worktree", "remove", "--force", source], {
      cwd: primary,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (removal.exitCode !== 0) {
      console.error(new TextDecoder().decode(removal.stderr));
      process.exit(removal.exitCode ?? 1);
    }
    if (process.env.WT_FAKE_MERGE_DELETE_SOURCE_BRANCH === "1") {
      const branchRemoval = Bun.spawnSync(["git", "branch", "-D", sourceBranch], {
        cwd: primary,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (branchRemoval.exitCode !== 0) {
        console.error(new TextDecoder().decode(branchRemoval.stderr));
        process.exit(branchRemoval.exitCode ?? 1);
      }
    }
  }
  if (process.env.WT_FAKE_MERGE_STDERR) console.error(process.env.WT_FAKE_MERGE_STDERR);
  if (process.env.WT_FAKE_MERGE_RAW) console.log(process.env.WT_FAKE_MERGE_RAW);
  const mergeExit = Number(process.env.WT_FAKE_MERGE_EXIT);
  if (mergeExit !== 0) process.exit(mergeExit);
} else if (args.includes("remove")) {
  const requestedExit = Number(process.env.WT_FAKE_REMOVE_EXIT);
  if (requestedExit !== 0) {
    console.error("configured remove failure");
    process.exit(requestedExit);
  }
  if (process.env.WT_FAKE_REAL_REMOVE === "1") {
    const target = args[args.indexOf("remove") + 1];
    const branchResult = Bun.spawnSync(["git", "-C", target, "branch", "--show-current"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const branch = new TextDecoder().decode(branchResult.stdout).trim();
    const removeArgs = ["git", "worktree", "remove"];
    if (args.includes("--force")) removeArgs.push("--force");
    removeArgs.push(target);
    const removal = Bun.spawnSync(removeArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (removal.exitCode !== 0) {
      console.error(new TextDecoder().decode(removal.stderr));
      process.exit(removal.exitCode ?? 1);
    }
    if (process.env.WT_FAKE_REMOVE_COLLATERAL) {
      const collateralRemoval = Bun.spawnSync(
        ["git", "worktree", "remove", "--force", process.env.WT_FAKE_REMOVE_COLLATERAL],
        {
          cwd: process.cwd(),
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (collateralRemoval.exitCode !== 0) {
        console.error(new TextDecoder().decode(collateralRemoval.stderr));
        process.exit(collateralRemoval.exitCode ?? 1);
      }
    }
    if (process.env.WT_FAKE_REMOVE_RAW) {
      console.log(process.env.WT_FAKE_REMOVE_RAW);
    } else {
      console.log(JSON.stringify([{
        kind: "worktree",
        branch,
        path: process.env.WT_FAKE_REMOVE_REPORTED_PATH || target,
        branch_outcome: "not_attempted",
        branch_checked_out_at: null,
      }]));
    }
  } else {
    console.log(process.env.WT_FAKE_REMOVE);
  }
} else {
  console.error("unexpected fake wt command: " + args.join(" "));
  process.exit(2);
}
`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);

  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.WT_FAKE_LOG = log;
  process.env.WT_FAKE_VERSION = options.version ?? "0.76.0";
  process.env.WT_FAKE_LIST = JSON.stringify(options.list ?? {
    schema: 2,
    repo: { default_branch: "main", forge: null },
    collected: { ci: false, summary: false },
    items: [],
  });
  process.env.WT_FAKE_APPROVALS = JSON.stringify(options.approvals ?? {
    state: "no_commands",
    commands: [],
    stale: [],
  });
  process.env.WT_FAKE_SWITCH = JSON.stringify(options.switchResult ?? {});
  process.env.WT_FAKE_SWITCH_EXIT = String(options.switchExit ?? 0);
  process.env.WT_FAKE_SWITCH_STDERR = options.switchStderr ?? "";
  process.env.WT_FAKE_REAL_SWITCH = options.realSwitch === false ? "0" : "1";
  process.env.WT_FAKE_REMOVE = JSON.stringify(options.removeResult ?? {});
  process.env.WT_FAKE_REMOVE_EXIT = String(options.removeExit ?? 0);
  process.env.WT_FAKE_REAL_REMOVE = options.realRemove ? "1" : "0";
  process.env.WT_FAKE_REMOVE_RAW = options.removeRaw ?? "";
  process.env.WT_FAKE_REMOVE_REPORTED_PATH = options.removeReportedPath ?? "";
  process.env.WT_FAKE_REMOVE_COLLATERAL = options.removeCollateral ?? "";
  process.env.WT_FAKE_MERGE_RAW = options.mergeRaw ?? JSON.stringify(options.mergeResult ?? {
    branch: "feature",
    committed: false,
    rebased: true,
    removed: false,
    squashed: true,
    target: options.mergeTarget ?? "main",
  });
  process.env.WT_FAKE_MERGE_EXIT = String(options.mergeExit ?? 0);
  process.env.WT_FAKE_MERGE_STDERR = options.mergeStderr ?? "";
  process.env.WT_FAKE_MERGE_UPDATE_TARGET = options.mergeUpdateTarget ? "1" : "0";
  process.env.WT_FAKE_MERGE_DELETE_TARGET = options.mergeDeleteTarget ? "1" : "0";
  process.env.WT_FAKE_MERGE_REMOVE_SOURCE = options.mergeRemoveSource ? "1" : "0";
  process.env.WT_FAKE_MERGE_DELETE_SOURCE_BRANCH = options.mergeDeleteSourceBranch ? "1" : "0";
  process.env.WT_FAKE_MERGE_PRIMARY = options.mergePrimary ?? "";
  process.env.WT_FAKE_MERGE_TARGET = options.mergeTarget ?? "main";
  process.env.WT_FAKE_REQUIRED_MOVE = options.requiredMove ?? "";
  process.env.WT_FAKE_DELETE_AFTER_APPROVALS = options.deleteAfterApprovals ? "1" : "0";
  return log;
}

function fakeCalls(log: string): string[][] {
  if (!Bun.file(log).size) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
  else process.env.OMP_WORKTREE_DIR = originalWorktreeDir;
  delete process.env.WT_FAKE_LOG;
  delete process.env.WT_FAKE_VERSION;
  delete process.env.WT_FAKE_LIST;
  delete process.env.WT_FAKE_APPROVALS;
  delete process.env.WT_FAKE_SWITCH;
  delete process.env.WT_FAKE_SWITCH_EXIT;
  delete process.env.WT_FAKE_SWITCH_STDERR;
  delete process.env.WT_FAKE_REAL_SWITCH;
  delete process.env.WT_FAKE_REMOVE;
  delete process.env.WT_FAKE_REMOVE_EXIT;
  delete process.env.WT_FAKE_REAL_REMOVE;
  delete process.env.WT_FAKE_REMOVE_RAW;
  delete process.env.WT_FAKE_REMOVE_REPORTED_PATH;
  delete process.env.WT_FAKE_REMOVE_COLLATERAL;
  delete process.env.WT_TEST_MOVED_TO;
  delete process.env.WT_FAKE_MERGE_RAW;
  delete process.env.WT_FAKE_MERGE_EXIT;
  delete process.env.WT_FAKE_MERGE_STDERR;
  delete process.env.WT_FAKE_MERGE_UPDATE_TARGET;
  delete process.env.WT_FAKE_MERGE_DELETE_TARGET;
  delete process.env.WT_FAKE_MERGE_REMOVE_SOURCE;
  delete process.env.WT_IDENTITY_LOG;
  delete process.env.WT_IDENTITY_LINK;
  delete process.env.WT_IDENTITY_REPLACEMENT;
  delete process.env.WT_FAKE_MERGE_DELETE_SOURCE_BRANCH;
  delete process.env.WT_FAKE_MERGE_PRIMARY;
  delete process.env.WT_FAKE_MERGE_TARGET;
  delete process.env.WT_FAKE_REQUIRED_MOVE;
  delete process.env.WT_FAKE_DELETE_AFTER_APPROVALS;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});


describe("/wtm backend selection", () => {
  test("rejects merge without Worktrunk before changing the repository", async () => {
    // Catches treating the new `merge` subcommand as a worktree name on the native backend.
    const root = tempRoot();
    const repo = initRepo(root);
    process.env.PATH = "/usr/bin:/bin";
    process.env.OMP_WORKTREE_DIR = path.join(root, "worktrees");
    const before = git(repo, ["show-ref"]);
    const harness = makeHarness(repo);

    await harness.handler("merge", harness.ctx);

    expect(git(repo, ["show-ref"])).toBe(before);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
    expect(harness.notices.some(({ text, level }) => level === "error" && text.includes("Worktrunk"))).toBe(true);
  });

  test("prepares the built-in move from supported Worktrunk create output", async () => {
    // Catches mutating the session directly instead of handing the verified path to OMP core.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "managed", "repo-topic");
    process.env.OMP_WORKTREE_DIR = path.join(root, "managed");
    const log = installFakeWorktrunk(root, {
      switchResult: {
        action: "created_branch",
        branch: "topic",
        path: target,
        created_branch: true,
        base_branch: "main",
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("topic", harness.ctx);

    expect(harness.editorTexts).toEqual([`/move "${target}"`]);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
    const calls = fakeCalls(log);
    const switchCall = calls.find((args) => args.includes("switch"));
    expect(switchCall).toBeDefined();
    expect(switchCall).toContain("--create");
    expect(switchCall).toContain("--base=@");
    expect(switchCall).toContain("--no-cd");
    expect(switchCall).toContain("--format=json");
    expect(switchCall?.some((arg) => arg.startsWith("worktree-path="))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("move command is ready"))).toBe(true);
    expect(harness.notices.every(({ text }) => !text.includes("Moved session"))).toBe(true);
  });

  test("preserves special characters in a move handoff", async () => {
    // Catches shell/JSON escaping a freeform /move path that OMP only unwraps once.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, `managed space`, `repo "quoted" \\ tail `);
    process.env.OMP_WORKTREE_DIR = path.dirname(target);
    installFakeWorktrunk(root, {
      switchResult: {
        action: "created_branch",
        branch: "quoted-topic",
        path: target,
        created_branch: true,
        base_branch: "main",
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("quoted-topic", harness.ctx);

    expect(harness.editorTexts).toEqual([`/move "${target}"`]);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
  });

  test("registers only the WTM slash command", () => {
    // Catches reintroducing a command name reserved by OMP core.
    const names: string[] = [];
    registerWorktreeManager({
      setLabel() {},
      registerCommand(name: string) {
        names.push(name);
      },
    });

    expect(names).toEqual(["wtm"]);
  });

  test("sends the Worktrunk initialization prompt in the current session language", async () => {
    const root = tempRoot();
    const repo = initRepo(root);
    const harness = makeHarness(repo);

    await harness.handler("init", harness.ctx);

    expect(harness.sentMessages[0]).toContain("skill://wtm");
    expect(harness.sentMessages[0]).toContain(".config/wt.toml");
    expect(harness.sentMessages[0]).toContain("请使用触发本命令的用户当前会话语言回答");
    expect(harness.sentMessages[0]).toContain("默认使用简体中文回答");
    expect(harness.sentMessages[0]).toContain("保留现有配置");
    expect(harness.sentMessages[0]).toContain("wt step tether");
    expect(harness.sentMessages[0]).toContain("非裸 Git checkout");

  });

  test("rejects initialization from a bare Git repository", async () => {
    const root = tempRoot();
    const bare = path.join(root, "repo.git");
    git(root, ["init", "--bare", bare]);
    const harness = makeHarness(bare);

    await harness.handler("init", harness.ctx);

    expect(harness.sentMessages).toEqual([]);
    expect(harness.notices.at(-1)?.text).toContain("non-bare Git checkout");
  });

  test("prints a copyable move command when no TUI is available", async () => {
    // Catches making the handoff depend on setEditorText.
    const root = tempRoot();
    const repo = initRepo(root);
    const worktreeDir = path.join(root, "headless-worktrees");
    const target = path.join(worktreeDir, "repo-headless-topic");
    process.env.PATH = "/usr/bin:/bin";
    process.env.OMP_WORKTREE_DIR = worktreeDir;
    const harness = makeHarness(repo);
    harness.ctx.hasUI = false;

    await harness.handler("headless-topic", harness.ctx);

    expect(harness.editorTexts).toEqual([]);
    expect(harness.notices.some(({ text }) => text.includes(`/move "${target}"`))).toBe(true);
    expect(harness.moves).toEqual([]);
  });

  test("uses a timestamped branch when create has no positional name", async () => {
    // Catches treating the empty command as help or producing a non-unique generic branch.
    const root = tempRoot();
    const repo = initRepo(root);
    process.env.PATH = "/usr/bin:/bin";
    process.env.OMP_WORKTREE_DIR = path.join(root, "default-worktrees");
    const harness = makeHarness(repo);

    await harness.handler("", harness.ctx);

    const branches = git(repo, ["branch", "--format=%(refname:short)"]).split("\n");
    const generated = branches.find((branch) => /^wt-\d{12}$/.test(branch));
    expect(generated).toBeDefined();
    expect(harness.editorTexts).toHaveLength(1);
    expect(harness.editorTexts[0]).toContain(`repo-${generated}`);
  });

  test("uses an explicit base with a timestamped default branch", async () => {
    // Catches dropping --base when the positional branch is omitted.
    const root = tempRoot();
    const repo = initRepo(root);
    git(repo, ["branch", "base-point"]);
    writeFileSync(path.join(repo, "later.txt"), "later\n");
    git(repo, ["add", "later.txt"]);
    git(repo, ["commit", "-m", "later"]);
    process.env.PATH = "/usr/bin:/bin";
    process.env.OMP_WORKTREE_DIR = path.join(root, "base-worktrees");
    const harness = makeHarness(repo);

    await harness.handler("--base base-point", harness.ctx);

    const branches = git(repo, ["branch", "--format=%(refname:short)"]).split("\n");
    const generated = branches.find((branch) => /^wt-\d{12}$/.test(branch));
    expect(generated).toBeDefined();
    expect(git(repo, ["rev-parse", generated!])).toBe(git(repo, ["rev-parse", "base-point"]));
  });

  test("retains a created worktree whose path cannot fit a slash command", async () => {
    // Catches inserting a multiline path into the editor or rolling back completed Worktrunk state.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "managed", "line\nbreak");
    installFakeWorktrunk(root, {
      switchResult: {
        action: "created_branch",
        branch: "line-break",
        path: target,
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("line-break", harness.ctx);

    expect(existsSync(target)).toBe(true);
    expect(harness.editorTexts).toEqual([]);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("cannot be represented")
    )).toBe(true);
  });
});

describe("/wtm fallback and list behavior", () => {
  test("keeps native create available when Worktrunk is absent", async () => {
    // Catches making the optional dependency mandatory for existing commands.
    const root = tempRoot();
    const repo = initRepo(root);
    const worktreeDir = path.join(root, "native-worktrees");
    process.env.PATH = "/usr/bin:/bin";
    process.env.OMP_WORKTREE_DIR = worktreeDir;
    const harness = makeHarness(repo);

    await harness.handler("native-topic --base main", harness.ctx);

    const created = path.join(worktreeDir, "repo-native-topic");
    expect(git(repo, ["show-ref", "--verify", "refs/heads/native-topic"])).not.toBe("");
    expect(harness.editorTexts).toEqual([`/move "${created}"`]);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
  });

  test("reuses an existing branch at its registered legacy path", async () => {
    // Catches computing a new configured path instead of trusting Worktrunk's registered result.
    const root = tempRoot();
    const repo = initRepo(root);
    const legacyPath = path.join(root, "legacy-location");
    git(repo, ["worktree", "add", "-b", "legacy-topic", legacyPath]);
    process.env.OMP_WORKTREE_DIR = path.join(root, "new-layout");
    const log = installFakeWorktrunk(root, {
      switchResult: {
        action: "switched",
        branch: "legacy-topic",
        path: legacyPath,
        created_branch: false,
        base_branch: "main",
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("legacy-topic", harness.ctx);

    expect(harness.editorTexts).toEqual([`/move "${legacyPath}"`]);
    expect(harness.moves).toEqual([]);
    const switchCall = fakeCalls(log).find((args) => args.includes("switch"));
    expect(switchCall).toBeDefined();
    expect(switchCall).not.toContain("--create");
  });

  test("lists Worktrunk schema two without full or summary collection", async () => {
    // Catches silently reverting to Git porcelain or inheriting network and LLM list settings.
    const root = tempRoot();
    const repo = initRepo(root);
    const log = installFakeWorktrunk(root, {
      list: {
        schema: 2,
        repo: { default_branch: "main", forge: null },
        collected: { ci: false, summary: false },
        items: [{
          branch: "main",
          head: {
            sha: "0123456789abcdef0123456789abcdef01234567",
            short_sha: "0123456",
            subject: "initial",
            committed_at: "2026-09-02T00:00:00Z",
          },
          worktree: {
            path: repo,
            main: true,
            current: true,
            previous: false,
            detached: false,
            branch_mismatch: false,
            duplicate_branch: false,
            changes: {
              staged: false,
              modified: false,
              untracked: false,
              renamed: false,
              deleted: false,
              conflicted: false,
              diff: { added: 0, deleted: 0 },
            },
          },
          display: { state: "is_main", symbols: "^", statusline: "main ^" },
        }],
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("list", harness.ctx);

    const listCall = fakeCalls(log).find((args) => args.includes("list"));
    expect(listCall).toBeDefined();
    expect(listCall).toContain("--format=json");
    expect(listCall).toContain("list.full=false");
    expect(listCall).toContain("list.summary=false");
    expect(listCall).toContain("list.json-schema=2");
    expect(harness.notices.at(-1)?.text).toContain("[main]");
    expect(harness.notices.at(-1)?.text).toContain("<- current");
  });
});

describe("/wtm Worktrunk removal", () => {
  test("keeps the branch after Worktrunk removes its worktree", async () => {
    // Catches omitting --no-delete-branch from the Worktrunk boundary.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "remove-topic");
    git(repo, ["worktree", "add", "-b", "remove-topic", target]);
    const log = installFakeWorktrunk(root, { realRemove: true });
    const harness = makeHarness(repo);


    await harness.handler("rm remove-topic -y", harness.ctx);

    expect(existsSync(target)).toBe(false);
    expect(git(repo, ["show-ref", "--verify", "refs/heads/remove-topic"])).not.toBe("");
    expect(harness.notices.at(-1)?.level).toBe("info");
    expect(harness.notices.at(-1)?.text).toContain(`Removed worktree ${target}`);
    const removeCall = fakeCalls(log).find((args) => args.includes("remove"));
    expect(removeCall).toContain("--no-delete-branch");
    expect(removeCall).toContain("--foreground");
    expect(removeCall).toContain("--format=json");
  });

  test("refuses a dirty Worktrunk removal without force", async () => {
    // Catches delegating before the plugin's preserved dirty-worktree guard.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "dirty-topic");
    git(repo, ["worktree", "add", "-b", "dirty-topic", target]);
    writeFileSync(path.join(target, "tracked.txt"), "dirty\\n");
    const log = installFakeWorktrunk(root, { realRemove: true });
    const harness = makeHarness(repo);

    await harness.handler("rm dirty-topic -y", harness.ctx);

    expect(existsSync(target)).toBe(true);
    expect(fakeCalls(log).some((args) => args.includes("remove"))).toBe(false);
    expect(harness.notices.at(-1)?.level).toBe("warning");
  });

  test("passes force only for an explicitly forced removal", async () => {
    // Catches losing dirty work despite the caller omitting or misrouting -f.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "forced-topic");
    git(repo, ["worktree", "add", "-b", "forced-topic", target]);
    writeFileSync(path.join(target, "tracked.txt"), "dirty\\n");
    const log = installFakeWorktrunk(root, { realRemove: true });
    const harness = makeHarness(repo);

    await harness.handler("rm forced-topic -f -y", harness.ctx);

    expect(existsSync(target)).toBe(false);
    const removeCall = fakeCalls(log).find((args) => args.includes("remove"));
    expect(removeCall).toContain("--force");
  });

  test("removes the current worktree before preparing a primary move", async () => {
    // Catches failing to remove the source before preparing the move handoff.
    const root = tempRoot();
    const repo = initRepo(root);
    const source = path.join(root, "self topic");
    git(repo, ["worktree", "add", "-b", "self-topic", source]);
    const log = installFakeWorktrunk(root, { realRemove: true });
    const harness = makeHarness(source);

    await harness.handler("rm self -y", harness.ctx);

    expect(existsSync(source)).toBe(false);
    expect(runGitBranchExists(repo, "self-topic")).toBe(true);
    expect(harness.editorTexts).toEqual([`/move "${repo}"`]);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
    expect(harness.confirmations).toEqual([]);
    expect(fakeCalls(log).some((args) => args.includes("remove"))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("/wtm rm"))).toBe(false);
  });

  test("shows fresh identity before removing a worktree recreated at the same path", async () => {
    // Catches treating a path-only selector as authorization to delete a replacement.
    const root = tempRoot();
    const repo = initRepo(root);
    const source = path.join(root, "recreated-source");
    git(repo, ["worktree", "add", "-b", "old-source", source]);
    git(repo, ["worktree", "remove", source]);
    git(repo, ["branch", "-D", "old-source"]);
    git(repo, ["worktree", "add", "-b", "replacement-source", source]);
    process.env.PATH = "/usr/bin:/bin";
    const harness = makeHarness(repo);
    harness.ctx.ui.confirm = async (title, message) => {
      harness.confirmations.push({ title, message });
      return false;
    };

    await harness.handler(`rm ${JSON.stringify(source)}`, harness.ctx);

    expect(existsSync(source)).toBe(true);
    expect(harness.confirmations).toHaveLength(1);
    expect(harness.confirmations[0].message).toContain("replacement-source");
    expect(harness.confirmations[0].message).toContain(git(source, ["rev-parse", "--short=12", "HEAD"]));
  });

  test("rejects a removal path replaced by another repository", async () => {
    // Catches deleting a foreign checkout that occupies stale worktree metadata from this repository.
    const root = tempRoot();
    const repo = initRepo(root);
    const source = path.join(root, "foreign-replacement");
    git(repo, ["worktree", "add", "-b", "old-source", source]);
    rmSync(source, { recursive: true, force: true });
    mkdirSync(source);
    git(source, ["init", "-b", "main"]);
    git(source, ["config", "user.name", "Foreign Test"]);
    git(source, ["config", "user.email", "foreign@example.invalid"]);
    git(source, ["commit", "--allow-empty", "-m", "foreign"]);
    const foreignHead = git(source, ["rev-parse", "HEAD"]);
    process.env.PATH = "/usr/bin:/bin";
    const harness = makeHarness(repo);

    await harness.handler(`rm ${JSON.stringify(source)} -f -y`, harness.ctx);

    expect(existsSync(source)).toBe(true);
    expect(git(source, ["rev-parse", "HEAD"])).toBe(foreignHead);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("current repository")
    )).toBe(true);
  });

  test("excludes foreign repositories occupying stale paths from remove all", async () => {
    // Catches classifying any live Git root as an eligible worktree of the current repository.
    const root = tempRoot();
    const repo = initRepo(root);
    const current = path.join(root, "current-topic");
    const foreign = path.join(root, "foreign-topic");
    git(repo, ["worktree", "add", "-b", "current-topic", current]);
    git(repo, ["worktree", "add", "-b", "foreign-topic", foreign]);
    rmSync(foreign, { recursive: true, force: true });
    mkdirSync(foreign);
    git(foreign, ["init", "-b", "main"]);
    git(foreign, ["config", "user.name", "Foreign Test"]);
    git(foreign, ["config", "user.email", "foreign@example.invalid"]);
    git(foreign, ["commit", "--allow-empty", "-m", "foreign"]);
    const foreignHead = git(foreign, ["rev-parse", "HEAD"]);
    process.env.PATH = "/usr/bin:/bin";
    const harness = makeHarness(current);

    await harness.handler("rm --all -f -y", harness.ctx);

    expect(existsSync(foreign)).toBe(true);
    expect(git(foreign, ["rev-parse", "HEAD"])).toBe(foreignHead);
  });

  test("decodes a JSON string selector for a special-character path", async () => {
    // Catches splitting a JSON string token on whitespace or escape characters.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, `topic "quoted" \\ path`);
    git(repo, ["worktree", "add", "-b", "special-topic", target]);
    process.env.PATH = "/usr/bin:/bin";
    const harness = makeHarness(repo);

    await harness.handler(`rm ${JSON.stringify(target)} -y`, harness.ctx);

    expect(existsSync(target)).toBe(false);
    expect(runGitBranchExists(repo, "special-topic")).toBe(true);
  });

  test("remove all targets only eligible registered worktrees", async () => {
    // Catches deleting the primary, current, bare, or already-missing registrations.
    const root = tempRoot();
    const repo = initRepo(root);
    const current = path.join(root, "current-topic");
    const victim = path.join(root, "victim-topic");
    const stale = path.join(root, "stale-topic");
    git(repo, ["worktree", "add", "-b", "current-topic", current]);
    git(repo, ["worktree", "add", "-b", "victim-topic", victim]);
    git(repo, ["worktree", "add", "-b", "stale-topic", stale]);
    rmSync(stale, { recursive: true, force: true });
    const log = installFakeWorktrunk(root, { realRemove: true });
    const harness = makeHarness(current);

    await harness.handler("rm --all -y", harness.ctx);

    const removeCalls = fakeCalls(log).filter((args) => args.includes("remove"));
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toContain(victim);
    expect(existsSync(repo)).toBe(true);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(victim)).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });

  test("prune removes only stale worktree metadata", async () => {
    // Catches substituting Worktrunk's merged-worktree pruning workflow.
    const root = tempRoot();
    const repo = initRepo(root);
    const valid = path.join(root, "valid-topic");
    const stale = path.join(root, "stale-topic");
    git(repo, ["worktree", "add", "-b", "valid-topic", valid]);
    git(repo, ["worktree", "add", "-b", "stale-topic", stale]);
    rmSync(stale, { recursive: true, force: true });
    installFakeWorktrunk(root);
    const harness = makeHarness(repo);

    await harness.handler("prune", harness.ctx);

    expect(existsSync(valid)).toBe(true);
    expect(git(repo, ["show-ref", "--verify", "refs/heads/valid-topic"])).not.toBe("");
    expect(git(repo, ["show-ref", "--verify", "refs/heads/stale-topic"])).not.toBe("");
    expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(stale);
  });
});

describe("/wtm Worktrunk approvals and hooks", () => {
  test("stops before create when a relevant command is unapproved", async () => {
    // Catches using Worktrunk's run-scoped --yes bypass instead of its persisted approval state.
    const root = tempRoot();
    const repo = initRepo(root);
    const log = installFakeWorktrunk(root, {
      approvals: {
        state: "approval_required",
        commands: [{
          phase: "pre-start",
          name: "install",
          template: "npm ci --ignore-scripts",
          approved: false,
        }],
        stale: [],
      },
      switchResult: {
        action: "created_branch",
        branch: "topic",
        path: path.join(root, "topic"),
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("topic", harness.ctx);

    const calls = fakeCalls(log);
    expect(calls.some((args) => args.includes("approvals"))).toBe(true);
    expect(calls.some((args) => args.includes("switch"))).toBe(false);
    expect(harness.moves).toEqual([]);
    expect(harness.notices.at(-1)?.text).toContain("pre-start/install: npm ci --ignore-scripts");
    expect(harness.notices.at(-1)?.text).toContain("wt config approvals add");
  });

  test("stops when Worktrunk reports stale approval records", async () => {
    // Catches allowing --yes to re-approve an edited command between inspection and execution.
    const root = tempRoot();
    const repo = initRepo(root);
    const log = installFakeWorktrunk(root, {
      approvals: {
        state: "approved",
        commands: [{
          phase: "pre-switch",
          name: "check",
          template: "git status --short",
          approved: true,
        }],
        stale: ["rm -rf old-build"],
      },
      switchResult: {
        action: "created_branch",
        branch: "topic",
        path: path.join(root, "topic"),
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("topic", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("switch"))).toBe(false);
    expect(harness.notices.at(-1)?.text).toContain("stale approval: rm -rf old-build");
  });

  test("continues after Worktrunk reports relevant commands approved", async () => {
    // Catches treating permanent native approval as unavailable to the wrapper.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "approved-topic");
    const log = installFakeWorktrunk(root, {
      approvals: {
        state: "approved",
        commands: [{
          phase: "pre-switch",
          name: "check",
          template: "git status --short",
          approved: true,
        }],
        stale: [],
      },
      switchResult: {
        action: "created_branch",
        branch: "approved-topic",
        path: target,
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("approved-topic", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("approvals"))).toBe(true);
    expect(harness.editorTexts).toEqual([`/move "${target}"`]);
    expect(harness.moves).toEqual([]);
  });

  test("does not let remove yes bypass project approval", async () => {
    // Catches conflating the plugin confirmation flag with Worktrunk command consent.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "approval-topic");
    git(repo, ["worktree", "add", "-b", "approval-topic", target]);
    const log = installFakeWorktrunk(root, {
      approvals: {
        state: "approval_required",
        commands: [{
          phase: "pre-remove",
          name: "cleanup",
          template: "npm run cleanup",
          approved: false,
        }],
        stale: [],
      },
      realRemove: true,
    });
    const harness = makeHarness(repo);

    await harness.handler("rm approval-topic -y", harness.ctx);

    expect(existsSync(target)).toBe(true);
    expect(fakeCalls(log).some((args) => args.includes("remove"))).toBe(false);
    expect(harness.confirmations).toEqual([]);
  });

  test("keeps a failed blocking hook as a Worktrunk failure", async () => {
    // Catches retrying native Git after Worktrunk has started its hook pipeline.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "hook-topic");
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "hook-topic", path: target, main: false, current: false },
      ]),
      switchExit: 7,
      switchStderr: "pre-start project:test failed",
    });
    const harness = makeHarness(repo);

    await harness.handler("hook-topic", harness.ctx);

    expect(fakeCalls(log).filter((args) => args.includes("switch"))).toHaveLength(1);
    expect(runGitBranchExists(repo, "hook-topic")).toBe(false);
    expect(harness.moves).toEqual([]);
    expect(harness.notices.at(-1)?.text).toContain("pre-start project:test failed");
    expect(harness.notices.at(-1)?.text).toContain(target);
    expect(harness.notices.at(-1)?.text).toContain("Retry /wtm hook-topic");
  });

  test("points to Worktrunk logs after a background hook warning", async () => {
    // Catches hiding post-hook failures after the Git and session operations succeed.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "background-topic");
    installFakeWorktrunk(root, {
      switchResult: {
        action: "created_branch",
        branch: "background-topic",
        path: target,
      },
      switchStderr: "post-start project:dev exited with status 1",
    });
    const harness = makeHarness(repo);

    await harness.handler("background-topic", harness.ctx);

    expect(harness.editorTexts).toEqual([`/move "${target}"`]);
    expect(harness.moves).toEqual([]);
    expect(harness.notices.some(({ text }) => text.includes("wt config state logs"))).toBe(true);
  });
});

describe("/wtm Worktrunk merge", () => {
  test("merges and cleans up the current linked source in one invocation", async () => {
    // Catches the retired two-step flow that moved the session off the source before Worktrunk ran.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const sourceHead = git(source, ["rev-parse", "HEAD"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: true,
        squashed: false,
        target: "main",
      },
      mergeUpdateTarget: true,
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge main --no-ff --stage tracked -y", harness.ctx);

    const mergeCall = fakeCalls(log).find((args) => args.includes("merge"));
    expect(mergeCall).toContain("--format=json");
    expect(mergeCall).toContain("--no-ff");
    expect(mergeCall).toContain("tracked");
    expect(git(repo, ["rev-parse", "main"])).toBe(sourceHead);
    expect(existsSync(source)).toBe(false);
    expect(runGitBranchExists(repo, "feature")).toBe(false);
    expect(harness.confirmations).toEqual([]);
    expect(harness.notices.some(({ text }) => text.includes("Worktrunk merge completed"))).toBe(true);
    expect(harness.editorTexts).toEqual([`/move "${repo}"`]);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
  });

  test("executes an explicit source from another worktree with fresh confirmation", async () => {
    // Catches ignoring --source or carrying the preparation-stage confirmation skip into execution.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const sourceHead = git(source, ["rev-parse", "HEAD"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: true,
        removed: true,
        squashed: true,
        target: "main",
      },
      mergeUpdateTarget: true,
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge "main" --source ${JSON.stringify(source)}`, harness.ctx);

    expect(harness.confirmations).toHaveLength(1);
    expect(harness.editorTexts).toEqual([]);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
    expect(git(repo, ["rev-parse", "main"])).toBe(sourceHead);
    expect(existsSync(source)).toBe(false);
    expect(runGitBranchExists(repo, "feature")).toBe(false);
    const mergeCall = fakeCalls(log).find((args) => args.includes("merge"));
    expect(mergeCall).toContain("--format=json");
    expect(mergeCall).toContain(source);
    expect(harness.notices.some(({ text }) => text.includes("target main updated"))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("cleanup scheduled"))).toBe(true);
  });

  test("refuses a new merge while the source has an in-progress rebase", async () => {
    // Catches replaying the Worktrunk pipeline over conflict recovery state.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const rebaseState = git(source, ["rev-parse", "--git-path", "rebase-merge"]);
    mkdirSync(rebaseState, { recursive: true });
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge --source ${JSON.stringify(source)}`, harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("approvals") || args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("in-progress") && text.includes("rebase")
    )).toBe(true);
  });

  test("detects an in-progress merge in the primary worktree", async () => {
    // Catches resolving a primary Git state path relative to the plugin process instead of the repository.
    const root = tempRoot();
    const repo = initRepo(root);
    const mergeHead = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"]);
    writeFileSync(mergeHead, `${git(repo, ["rev-parse", "HEAD"])}\n`);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
      ]),
    });
    const harness = makeHarness(repo);

    await harness.handler("merge --no-remove", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("approvals") || args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("in-progress") && text.includes("merge")
    )).toBe(true);
  });

  test("runs the pipeline when the target already contains the source", async () => {
    // Catches stopping at "integration is already complete" instead of letting Worktrunk clean up.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    git(repo, ["merge", "--ff-only", "feature"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: true,
        squashed: false,
        target: "main",
      },
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge --source ${JSON.stringify(source)} -y`, harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(runGitBranchExists(repo, "feature")).toBe(false);
    expect(harness.notices.some(({ level }) => level === "error")).toBe(false);
  });

  test("starts a new merge when an integrated source has uncommitted changes", async () => {
    // Catches mistaking source HEAD ancestry for completion when Worktrunk still has dirty content to integrate.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    git(repo, ["merge", "--ff-only", "feature"]);
    writeFileSync(path.join(source, "dirty.txt"), "new work\n");
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
      mergeResult: {
        branch: "feature",
        committed: true,
        rebased: false,
        removed: false,
        squashed: false,
        target: "main",
      },
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge -y --source ${JSON.stringify(source)}`, harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
  });

  test("rejects an ordinary directory as an explicit merge source", async () => {
    // Catches accepting path existence without live Git worktree registration and repository identity.
    const root = tempRoot();
    const repo = initRepo(root);
    const ordinary = path.join(repo, "ordinary");
    mkdirSync(ordinary);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
      ]),
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge --source ${JSON.stringify(ordinary)}`, harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("approvals") || args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("live registered branch worktree")
    )).toBe(true);
  });

  test("rejects an explicit source from another repository", async () => {
    // Catches authorizing a source solely because it is a valid worktree on disk.
    const root = tempRoot();
    const currentRoot = path.join(root, "current-root");
    mkdirSync(currentRoot);
    const currentRepo = initRepo(currentRoot);
    const otherRoot = path.join(root, "other-root");
    mkdirSync(otherRoot);
    const { source: otherSource } = initMergeSource(otherRoot);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: currentRepo, main: true, current: true },
      ]),
    });
    const harness = makeHarness(currentRepo);

    await harness.handler(`merge --source ${JSON.stringify(otherSource)}`, harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("approvals") || args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("current repository")
    )).toBe(true);
  });

  test("merges when --source names the worktree the session occupies", async () => {
    // Catches treating --source as permission to defer the merge instead of running it.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: true,
        squashed: false,
        target: "main",
      },
      mergeUpdateTarget: true,
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler(`merge -y --source ${JSON.stringify(source)}`, harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(harness.editorTexts).toEqual([`/move "${repo}"`]);
    expect(harness.notices.at(-1)?.text).toContain("move command is ready");
  });

  test("runs directly when the primary source is also the target branch", async () => {
    // Catches requiring a handoff when Worktrunk cannot remove the current primary branch.
    const root = tempRoot();
    const repo = initRepo(root);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
      ]),
      mergeResult: {
        branch: "main",
        committed: false,
        rebased: false,
        removed: false,
        squashed: false,
        target: "main",
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("merge -y", harness.ctx);

    expect(harness.editorTexts).toEqual([]);
    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
  });

  test("keeps the source session for no-remove merge flags", async () => {
    // Catches pre-migrating or cleaning a source that the caller explicitly retained.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: false,
        squashed: false,
        target: "main",
      },
      mergeUpdateTarget: true,
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge main --no-squash --no-commit --no-rebase --no-remove --no-ff --stage tracked -y", harness.ctx);

    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
    expect(existsSync(source)).toBe(true);
    const mergeCall = fakeCalls(log).find((args) => args.includes("merge"));
    for (const flag of ["--no-squash", "--no-commit", "--no-rebase", "--no-remove", "--no-ff", "--stage", "tracked"]) {
      expect(mergeCall).toContain(flag);
    }
    expect(mergeCall).not.toContain("-y");
    expect(mergeCall).not.toContain("--yes");
  });

  test("shows the requested merge pipeline before mutation", async () => {
    // Catches a confirmation that omits the destructive cleanup and history-rewrite choices.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: true,
        removed: false,
        squashed: true,
        target: "main",
      },
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge --no-remove", harness.ctx);

    expect(harness.confirmations).toHaveLength(1);
    const summary = harness.confirmations[0].message;
    expect(summary).toContain("Source: feature");
    expect(summary).toContain("Target: main");
    expect(summary).toContain("Stage: all");
    expect(summary).toContain("Squash: enabled");
    expect(summary).toContain("Rebase: enabled");
    expect(summary).toContain("Cleanup: disabled");
    expect(summary).toContain("Conflicts: none");
    expect(summary).toContain("Message:");
  });


  test("shows no-commit as disabling the squash step", async () => {
    // Catches presenting a pipeline that Worktrunk will not actually execute.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: true,
        removed: false,
        squashed: false,
        target: "main",
      },
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge --no-commit --no-remove", harness.ctx);

    expect(harness.confirmations).toHaveLength(1);
    expect(harness.confirmations[0].message).toContain("Commit: disabled");
    expect(harness.confirmations[0].message).toContain("Squash: disabled");
  });
  test("moves the session to the target worktree after cleanup", async () => {
    // Catches preparing a handoff before the merge or ignoring the live target checkout.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const targetPath = path.join(root, "develop");
    git(repo, ["worktree", "add", "-b", "develop", targetPath]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
        { branch: "develop", path: targetPath, main: false, current: false },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: true,
        squashed: false,
        target: "develop",
      },
      mergeUpdateTarget: true,
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "develop",
    });
    const harness = makeHarness(source);

    await harness.handler("merge develop -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(harness.editorTexts).toEqual([`/move "${targetPath}"`]);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
  });

  test("reconciles target update after pre-remove failure", async () => {
    // Catches claiming an atomic failure when Worktrunk already advanced the target ref.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const sourceHead = git(source, ["rev-parse", "HEAD"]);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
      mergeRaw: "",
      mergeExit: 7,
      mergeStderr: "pre-remove project:cleanup failed",
      mergeUpdateTarget: true,
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge -y --source ${JSON.stringify(source)}`, harness.ctx);

    expect(git(repo, ["rev-parse", "main"])).toBe(sourceHead);
    expect(existsSync(source)).toBe(true);
    expect(runGitBranchExists(repo, "feature")).toBe(true);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
    expect(harness.notices.some(({ text }) => text.includes("target main updated"))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("source worktree registered"))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("Native Git was not retried"))).toBe(true);
  });

  test("preserves source recovery state after rebase failure", async () => {
    // Catches aborting, resetting, or deleting the source after Worktrunk leaves recovery state.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const targetBefore = git(repo, ["rev-parse", "main"]);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
      mergeRaw: "",
      mergeExit: 8,
      mergeStderr: "rebase conflict remains in source",
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge -y --source ${JSON.stringify(source)}`, harness.ctx);

    expect(git(repo, ["rev-parse", "main"])).toBe(targetBefore);
    expect(existsSync(source)).toBe(true);
    expect(runGitBranchExists(repo, "feature")).toBe(true);
    expect(harness.reloads).toBe(0);
    expect(harness.notices.some(({ text }) => text.includes("target main unchanged"))).toBe(true);
  });

  test("does not retry after incompatible merge JSON", async () => {
    // Catches a second native merge after Worktrunk already changed the target.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const sourceHead = git(source, ["rev-parse", "HEAD"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
      mergeRaw: "not-json",
      mergeUpdateTarget: true,
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge -y --source ${JSON.stringify(source)}`, harness.ctx);

    expect(git(repo, ["rev-parse", "main"])).toBe(sourceHead);
    expect(fakeCalls(log).filter((args) => args.includes("merge"))).toHaveLength(1);
    expect(harness.notices.some(({ text }) => text.includes("incompatible JSON"))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("Native Git was not retried"))).toBe(true);
  });

  test("moves the session to the primary worktree when the target has no checkout", async () => {
    // Catches inventing a target checkout instead of selecting the live primary.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    git(repo, ["branch", "develop", "main"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: true,
        squashed: false,
        target: "develop",
      },
      mergeUpdateTarget: true,
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "develop",
    });
    const harness = makeHarness(source);

    await harness.handler("merge develop -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(harness.editorTexts).toEqual([`/move "${repo}"`]);
  });


  test("blocks an unapproved cleanup post-switch hook", async () => {
    // Catches omitting Worktrunk's destination hook from the merge approval preflight.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
      approvals: {
        state: "approval_required",
        commands: [{
          phase: "post-switch",
          name: "announce",
          template: "echo merged",
          approved: false,
        }],
        stale: [],
      },
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge -y --source ${JSON.stringify(source)}`, harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(harness.moves).toEqual([]);
    expect(harness.notices.at(-1)?.text).toContain("post-switch/announce: echo merged");
  });
  test("reports a pinned binary disappearing before merge execution", async () => {
    // Catches an executable ENOENT escaping without reconciliation diagnostics.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const targetBefore = git(repo, ["rev-parse", "main"]);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
      mergePrimary: repo,
      mergeTarget: "main",
      deleteAfterApprovals: true,
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge -y --source ${JSON.stringify(source)}`, harness.ctx);

    expect(git(repo, ["rev-parse", "main"])).toBe(targetBefore);
    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
    expect(harness.notices.some(({ text }) => text.includes("Native Git was not retried"))).toBe(true);
  });

  test("stops before Worktrunk when the squashed change would conflict", async () => {
    // Catches starting the pipeline and leaving a conflicted rebase open in the source worktree.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    writeFileSync(path.join(source, "tracked.txt"), "feature content\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "-m", "feature edits tracked"]);
    writeFileSync(path.join(source, "staged.txt"), "staged\n");
    git(source, ["add", "staged.txt"]);
    writeFileSync(path.join(repo, "tracked.txt"), "main content\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "main edits tracked"]);
    const refsBefore = git(repo, ["show-ref"]);
    const statusBefore = git(source, ["status", "--porcelain"]);
    const objectsBefore = objectCount(repo);
    const indexPath = git(source, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = readFileSync(indexPath);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
    });
    const harness = makeHarness(source);

    await harness.handler("merge main -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(git(repo, ["show-ref"])).toBe(refsBefore);
    expect(git(source, ["status", "--porcelain"])).toBe(statusBefore);
    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(objectCount(repo)).toBe(objectsBefore);
    expect(existsSync(git(source, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"]))).toBe(false);
    expect(harness.editorTexts).toEqual([]);
    expect(harness.confirmations).toEqual([]);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("would conflict") && text.includes("tracked.txt") && text.includes("unchanged")
    )).toBe(true);
  });

  test("keeps staged new files in the --stage tracked pre-check", async () => {
    // Catches dropping index-only content, which Worktrunk commits as an add/add conflict.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    writeFileSync(path.join(source, "shared.txt"), "feature\n");
    git(source, ["add", "shared.txt"]);
    writeFileSync(path.join(repo, "shared.txt"), "main\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "main adds shared"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
    });
    const harness = makeHarness(source);

    await harness.handler("merge main --stage tracked --no-remove -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("would conflict") && text.includes("shared.txt")
    )).toBe(true);
  });

  test("stops when the target diverged from an upstream the source is based on", async () => {
    // Catches predicting a merge that Worktrunk refuses because the target cannot fast-forward:
    // the local main kept its own commit while the fetched upstream gained another, and the
    // source branches from that newer upstream tip.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    writeFileSync(path.join(repo, "upstream.txt"), "upstream\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "upstream work"]);
    const upstreamTip = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(repo, "local.txt"), "local\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "local main work"]);
    git(repo, ["checkout", "-q", "-b", "upstream-extra", upstreamTip]);
    writeFileSync(path.join(repo, "second-upstream.txt"), "second\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "second upstream work"]);
    const newerUpstream = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-q", "main"]);
    trackUpstream(root, repo, "main", newerUpstream);
    git(source, ["reset", "--hard", newerUpstream]);
    writeFileSync(path.join(source, "feature.txt"), "feature\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "-m", "feature work"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
    });
    const harness = makeHarness(source);

    await harness.handler("merge main -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("diverged") && text.includes("origin/main") && text.includes("unchanged")
    )).toBe(true);
  });

  test("replays when a merge commit sits between the target and the source", async () => {
    // Catches treating a source that merged a side branch as "Already up to date": Worktrunk
    // still replays the branch's commits, which conflicts here.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const base = git(repo, ["rev-parse", "main"]);
    git(source, ["checkout", "-q", "-b", "feature-side"]);
    writeFileSync(path.join(source, "tracked.txt"), "side content\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "-m", "side edits tracked"]);
    git(source, ["checkout", "-q", "feature"]);
    writeFileSync(path.join(source, "tracked.txt"), "feature content\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "-m", "feature edits tracked"]);
    git(source, ["merge", "--no-ff", "-X", "ours", "-m", "merge side", "feature-side"]);
    expect(() => git(repo, ["merge-base", "--is-ancestor", base, "feature"])).not.toThrow();
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
    });
    const harness = makeHarness(source);

    await harness.handler("merge main --no-squash --no-remove", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("would conflict") && text.includes("while replaying") && text.includes("tracked.txt")
    )).toBe(true);
  });

  test("reports scheduled cleanup without claiming the worktree is gone", async () => {
    // Catches announcing a removal that the reconciliation never confirmed.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: true,
        squashed: false,
        target: "main",
      },
      mergeUpdateTarget: true,
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge main -y", harness.ctx);

    expect(existsSync(source)).toBe(true);
    expect(harness.editorTexts).toEqual([`/move "${repo}"`]);
    const notice = harness.notices.find(({ text }) => text.includes("Worktrunk merge completed"))?.text ?? "";
    expect(notice).toContain("cleanup scheduled");
    expect(notice).toContain("may still be removed");
    expect(notice).not.toContain("was removed with its branch");
  });

  test("checks per-commit replay when the source history is preserved", async () => {
    // Catches a squash-only check that would let a conflicting --no-squash rebase start.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    writeFileSync(path.join(source, "tracked.txt"), "first\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "-m", "feature edits tracked"]);
    writeFileSync(path.join(source, "tracked.txt"), "initial\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "-m", "feature restores tracked"]);
    writeFileSync(path.join(repo, "tracked.txt"), "main content\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "main edits tracked"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: false,
        squashed: false,
        target: "main",
      },
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge main --no-squash --no-remove -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("would conflict") && text.includes("replaying") && text.includes("tracked.txt")
    )).toBe(true);

    // The same history squashes into a change that applies cleanly.
    await harness.handler("merge main --no-remove -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
  });

  test("checks the merge commit when rebase is disabled", async () => {
    // Catches assuming --no-rebase cannot conflict while --no-ff merges the source tip.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    writeFileSync(path.join(source, "tracked.txt"), "feature content\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "-m", "feature edits tracked"]);
    writeFileSync(path.join(repo, "tracked.txt"), "main content\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "main edits tracked"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge main --no-rebase --no-ff --no-remove -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("would conflict") && text.includes("tracked.txt")
    )).toBe(true);
  });

  test("keeps fast-forward-only merges unblocked by the pre-check", async () => {
    // Catches applying the replay check to a --no-rebase pipeline that can only fast-forward.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    writeFileSync(path.join(source, "tracked.txt"), "feature content\n");
    git(source, ["add", "-A"]);
    git(source, ["commit", "-m", "feature edits tracked"]);
    writeFileSync(path.join(repo, "tracked.txt"), "main content\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "main edits tracked"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: false,
        squashed: false,
        target: "main",
      },
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge main --no-rebase --no-remove -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
  });

  test("stops when --no-commit cannot commit a dirty source", async () => {
    // Catches sending a pipeline to Worktrunk that refuses the same state.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    writeFileSync(path.join(source, "dirty.txt"), "uncommitted\n");
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
    });
    const harness = makeHarness(source);

    await harness.handler("merge main --no-commit --no-remove -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("--no-commit") && text.includes("clean working tree")
    )).toBe(true);
  });

  test("stops before cleanup when no landing worktree can receive the session", async () => {
    // Catches deleting the session's directory without a usable /move handoff.
    const root = tempRoot();
    const repo = path.join(root, "session-repo");
    const gitDir = path.join(root, "session-metadata");
    mkdirSync(repo);
    git(root, ["init", "--separate-git-dir", gitDir, "-b", "main", repo]);
    git(repo, ["config", "user.name", "WT Test"]);
    git(repo, ["config", "user.email", "wt-test@example.invalid"]);
    writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "initial"]);
    const source = path.join(root, "session-feature");
    git(repo, ["worktree", "add", "-b", "feature", source]);
    writeFileSync(path.join(source, "feature.txt"), "feature\n");
    git(source, ["add", "feature.txt"]);
    git(source, ["commit", "-m", "feature"]);
    rmSync(repo, { recursive: true, force: true });
    const refsBefore = git(source, ["show-ref"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "feature", path: source, main: false, current: true },
      ]),
    });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(git(source, ["show-ref"])).toBe(refsBefore);
    expect(harness.editorTexts).toEqual([]);
    expect(harness.notices.some(({ text, level }) =>
      level === "error" && text.includes("/move") && text.includes("repository unchanged")
    )).toBe(true);
  });
});

describe("/wtm Worktrunk compatibility boundary", () => {
  test("falls back before mutation for an unsupported Worktrunk version", async () => {
    // Catches sending mutating argv to a future CLI whose JSON contract was never validated.
    const root = tempRoot();
    const repo = initRepo(root);
    process.env.OMP_WORKTREE_DIR = path.join(root, "native-fallback");
    const log = installFakeWorktrunk(root, { version: "0.77.0" });
    const harness = makeHarness(repo);

    await harness.handler("future-topic", harness.ctx);

    expect(runGitBranchExists(repo, "future-topic")).toBe(true);
    expect(fakeCalls(log)).toEqual([["--version"]]);
    expect(harness.notices.some(({ text }) => text.includes("outside the supported v0.76.x range"))).toBe(true);
  });

  test("rejects merge for an unsupported Worktrunk version", async () => {
    // Catches falling through to either native mutation or an unvalidated merge contract.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const targetBefore = git(repo, ["rev-parse", "main"]);
    const log = installFakeWorktrunk(root, { version: "0.77.0" });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(git(repo, ["rev-parse", "main"])).toBe(targetBefore);
    expect(fakeCalls(log)).toEqual([["--version"]]);
    expect(harness.moves).toEqual([]);
    expect(harness.notices.at(-1)?.level).toBe("error");
  });

  test("filters shell navigation hints while preserving hook diagnostics", async () => {
    // Catches leaking irrelevant cd advice or hiding actionable project-hook failures.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "warning-topic");
    installFakeWorktrunk(root, {
      switchResult: {
        action: "created_branch",
        branch: "warning-topic",
        path: target,
      },
      switchStderr: [
        `Worktree for warning-topic @ ${target}, but cannot change directory - shell integration not installed`,
        "To enable automatic cd, run wt config shell install",
        "post-start project:dev exited with status 1",
        "project warning: dev server port unavailable",
      ].join("\n"),
    });
    const harness = makeHarness(repo);

    await harness.handler("warning-topic", harness.ctx);

    const output = harness.notices.map(({ text }) => text).join("\n");
    expect(output).not.toContain("shell integration");
    expect(output).not.toContain("automatic cd");
    expect(output).toContain("post-start project:dev exited with status 1");
    expect(output).toContain("project warning: dev server port unavailable");
    expect(output).toContain("wt config state logs");
  });

  test("pins the resolved executable for the entire operation", async () => {
    // Catches a PATH symlink swap selecting a different binary after the version gate.
    const root = tempRoot();
    const repo = initRepo(root);
    const bin = path.join(root, "identity-bin");
    mkdirSync(bin);
    const link = path.join(bin, "wt");
    const original = path.join(root, "wt-original");
    const replacement = path.join(root, "wt-replacement");
    const identityLog = path.join(root, "identity.log");
    const target = path.join(root, "identity-topic");
    git(repo, ["worktree", "add", "-b", "identity-topic", target]);
    const originalScript = `#!${process.execPath}\n` + String.raw`
import { appendFileSync, rmSync, symlinkSync } from "node:fs";
const argv = process.argv.slice(1);
const args = argv[0] === import.meta.path ? argv.slice(1) : argv;
appendFileSync(process.env.WT_IDENTITY_LOG, "original\n");
if (args.includes("--version")) {
  rmSync(process.env.WT_IDENTITY_LINK);
  symlinkSync(process.env.WT_IDENTITY_REPLACEMENT, process.env.WT_IDENTITY_LINK);
  console.log("wt v0.76.0");
} else if (args.includes("approvals")) {
  console.log(process.env.WT_FAKE_APPROVALS);
} else if (args.includes("list")) {
  console.log(process.env.WT_FAKE_LIST);
} else if (args.includes("switch")) {
  console.log(process.env.WT_FAKE_SWITCH);
}
`;
    const replacementScript = `#!${process.execPath}\n` + String.raw`
import { appendFileSync } from "node:fs";
appendFileSync(process.env.WT_IDENTITY_LOG, "replacement\n");
process.exit(91);
`;
    writeFileSync(original, originalScript);
    writeFileSync(replacement, replacementScript);
    chmodSync(original, 0o755);
    chmodSync(replacement, 0o755);
    symlinkSync(original, link);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.WT_IDENTITY_LOG = identityLog;
    process.env.WT_IDENTITY_LINK = link;
    process.env.WT_IDENTITY_REPLACEMENT = replacement;
    process.env.WT_FAKE_LIST = JSON.stringify(worktrunkListFixture("main", [
      { branch: "main", path: repo, main: true, current: true },
    ]));
    process.env.WT_FAKE_APPROVALS = JSON.stringify({ state: "no_commands", commands: [], stale: [] });
    process.env.WT_FAKE_SWITCH = JSON.stringify({
      action: "created_branch",
      branch: "identity-topic",
      path: target,
    });
    const harness = makeHarness(repo);

    await harness.handler("identity-topic", harness.ctx);

    const identities = readFileSync(identityLog, "utf8").trim().split("\n");
    expect(identities.length).toBeGreaterThanOrEqual(3);
    expect(identities.every((identity) => identity === "original")).toBe(true);
    expect(harness.editorTexts).toEqual([`/move "${target}"`]);
    expect(harness.moves).toEqual([]);
  });

  test("rejects unvalidated prerelease builds inside the supported minor", async () => {
    // Catches treating a prerelease wire contract as an allowlisted stable patch release.
    const root = tempRoot();
    const repo = initRepo(root);
    process.env.OMP_WORKTREE_DIR = path.join(root, "prerelease-fallback");
    const log = installFakeWorktrunk(root, { version: "0.76.1-beta.1" });
    const harness = makeHarness(repo);

    await harness.handler("prerelease-topic", harness.ctx);

    expect(runGitBranchExists(repo, "prerelease-topic")).toBe(true);
    expect(fakeCalls(log)).toEqual([["--version"]]);
    expect(harness.notices.some(({ text }) => text.includes("outside the supported v0.76.x range"))).toBe(true);
  });
});

describe("/wtm reviewed reconciliation boundaries", () => {
  test("rejects a switch result that is not a registered worktree", async () => {
    // Catches moving the session to an unrelated directory from structurally valid JSON.
    const root = tempRoot();
    const repo = initRepo(root);
    const unrelated = path.join(root, "ordinary-directory");
    mkdirSync(unrelated);
    installFakeWorktrunk(root, {
      realSwitch: false,
      switchResult: {
        action: "created_branch",
        branch: "topic",
        path: unrelated,
      },
    });
    const harness = makeHarness(repo);

    await harness.handler("topic", harness.ctx);

    expect(harness.moves).toEqual([]);
    expect(harness.reloads).toBe(0);
    expect(harness.notices.at(-1)?.text).toContain("not a live registered worktree");
    expect(harness.notices.at(-1)?.text).toContain("native Git was not retried");
  });

  test("skips a recreated stale target path as merge landing", async () => {
    // Catches handing /move an ordinary directory occupying stale worktree metadata.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const staleTarget = path.join(root, "stale-develop");
    git(repo, ["worktree", "add", "-b", "develop", staleTarget]);
    rmSync(staleTarget, { recursive: true, force: true });
    mkdirSync(staleTarget);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
        { branch: "develop", path: staleTarget, main: false, current: false },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: true,
        squashed: false,
        target: "develop",
      },
      mergeUpdateTarget: true,
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "develop",
    });
    const harness = makeHarness(source);

    await harness.handler("merge develop -y", harness.ctx);

    expect(harness.editorTexts).toEqual([`/move "${repo}"`]);
    expect(harness.moves).toEqual([]);
    expect(existsSync(source)).toBe(false);
    expect(harness.reloads).toBe(0);
  });

  test("uses Worktrunk primary metadata with a separate git directory", async () => {
    // Catches deriving the primary worktree as dirname(git-common-dir).
    const root = tempRoot();
    const repo = path.join(root, "separate-repo");
    const gitDir = path.join(root, "separate-metadata");
    mkdirSync(repo);
    git(root, ["init", "--separate-git-dir", gitDir, "-b", "main", repo]);
    git(repo, ["config", "user.name", "WT Test"]);
    git(repo, ["config", "user.email", "wt-test@example.invalid"]);
    writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["branch", "develop", "main"]);
    const source = path.join(root, "separate-feature");
    git(repo, ["worktree", "add", "-b", "feature", source]);
    writeFileSync(path.join(source, "feature.txt"), "feature\n");
    git(source, ["add", "feature.txt"]);
    git(source, ["commit", "-m", "feature"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("develop", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: true,
        squashed: false,
        target: "develop",
      },
      mergeUpdateTarget: true,
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "develop",
    });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(harness.editorTexts).toEqual([`/move "${repo}"`]);
    expect(harness.moves).toEqual([]);
  });

  test("omits cleanup approvals for no-remove merge", async () => {
    // Catches blocking a retained-source pipeline on hooks it cannot execute.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      approvals: {
        state: "approval_required",
        commands: [{
          phase: "pre-remove",
          name: "cleanup",
          template: "npm run cleanup",
          approved: false,
        }],
        stale: [],
      },
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: false,
        squashed: false,
        target: "main",
      },
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge --no-remove -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
    expect(harness.moves).toEqual([]);
  });

  test("omits commit approvals for no-commit merge", async () => {
    // Catches blocking a pipeline on commit guidance after commit and squash are disabled.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      approvals: {
        state: "approval_required",
        commands: [{
          phase: "commit-template-append",
          template: "Use ticket context",
          approved: false,
        }],
        stale: [],
      },
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: false,
        squashed: false,
        target: "main",
      },
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(source);

    await harness.handler("merge --no-commit --no-remove -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
  });

  test("reports a target ref removed by a partial merge", async () => {
    // Catches collapsing a missing target ref into the unchanged state.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: true },
        { branch: "feature", path: source, main: false, current: false },
      ]),
      mergeRaw: "",
      mergeExit: 7,
      mergeStderr: "target update failed",
      mergeDeleteTarget: true,
      mergePrimary: repo,
      mergeTarget: "main",
    });
    const harness = makeHarness(repo);

    await harness.handler(`merge -y --source ${JSON.stringify(source)}`, harness.ctx);

    expect(runGitBranchExists(repo, "main")).toBe(false);
    expect(harness.notices.some(({ text }) => text.includes("target main absent or unreadable"))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("target main unchanged"))).toBe(false);
  });

  test("flags removal JSON for a different worktree", async () => {
    // Catches reporting compatible success when Worktrunk names a different removal target.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "remove-identity");
    const reported = path.join(root, "different-worktree");
    git(repo, ["worktree", "add", "-b", "remove-identity", target]);
    installFakeWorktrunk(root, {
      realRemove: true,
      removeReportedPath: reported,
    });
    const harness = makeHarness(repo);

    await harness.handler("rm remove-identity -y", harness.ctx);

    expect(existsSync(target)).toBe(false);
    expect(harness.notices.at(-1)?.level).toBe("warning");
    expect(harness.notices.at(-1)?.text).toContain("reported different worktree");
    expect(harness.notices.at(-1)?.text).toContain(reported);
  });

  test("reports collateral live worktree removal", async () => {
    // Catches losing a second worktree without naming the unexpected side effect.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "remove-target");
    const collateral = path.join(root, "remove-collateral");
    git(repo, ["worktree", "add", "-b", "remove-target", target]);
    git(repo, ["worktree", "add", "-b", "remove-collateral", collateral]);
    installFakeWorktrunk(root, {
      realRemove: true,
      removeCollateral: collateral,
    });
    const harness = makeHarness(repo);

    await harness.handler("rm remove-target -y", harness.ctx);

    expect(existsSync(target)).toBe(false);
    expect(existsSync(collateral)).toBe(false);
    expect(harness.notices.at(-1)?.level).toBe("warning");
    expect(harness.notices.at(-1)?.text).toContain("unexpectedly removed");
    expect(harness.notices.at(-1)?.text).toContain(collateral);
  });

  test("flags removal output with more than one record", async () => {
    // Catches trusting ambiguous Worktrunk output for a worktree that is already gone.
    const root = tempRoot();
    const repo = initRepo(root);
    const target = path.join(root, "multi-record");
    git(repo, ["worktree", "add", "-b", "multi-record", target]);
    installFakeWorktrunk(root, {
      realRemove: true,
      removeRaw: JSON.stringify([
        {
          kind: "worktree",
          branch: "multi-record",
          path: target,
          branch_outcome: "not_attempted",
          branch_checked_out_at: null,
        },
        {
          kind: "worktree",
          branch: "other-topic",
          path: path.join(root, "other-topic"),
          branch_outcome: "not_attempted",
          branch_checked_out_at: null,
        },
      ]),
    });
    const harness = makeHarness(repo);

    await harness.handler("rm multi-record -y", harness.ctx);

    expect(existsSync(target)).toBe(false);
    expect(harness.notices.at(-1)?.level).toBe("warning");
    expect(harness.notices.at(-1)?.text).toContain("incompatible Worktrunk JSON");
    expect(harness.notices.at(-1)?.text).toContain(target);
  });

  test("uses Worktrunk primary metadata while removing itself", async () => {
    // Catches deriving the move target from a separate Git metadata directory.
    const root = tempRoot();
    const repo = path.join(root, "remove-separate-repo");
    const gitDir = path.join(root, "remove-separate-metadata");
    mkdirSync(repo);
    git(root, ["init", "--separate-git-dir", gitDir, "-b", "main", repo]);
    git(repo, ["config", "user.name", "WT Test"]);
    git(repo, ["config", "user.email", "wt-test@example.invalid"]);
    writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "initial"]);
    const source = path.join(root, "remove-separate-feature");
    git(repo, ["worktree", "add", "-b", "feature", source]);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      realRemove: true,
    });
    const harness = makeHarness(source);

    await harness.handler("rm self -y", harness.ctx);

    expect(harness.editorTexts).toEqual([`/move "${repo}"`]);
    expect(harness.moves).toEqual([]);
    expect(existsSync(source)).toBe(false);
    expect(runGitBranchExists(repo, "feature")).toBe(true);
    expect(harness.reloads).toBe(0);
  });

  test("rejects primary metadata from a different repository", async () => {
    // Catches accepting any live Git root as a landing worktree.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    git(repo, ["branch", "develop", "main"]);
    const unrelated = path.join(root, "unrelated-primary");
    mkdirSync(unrelated);
    git(unrelated, ["init", "-b", "main"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("develop", [
        { branch: "main", path: unrelated, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: false,
        removed: true,
        squashed: false,
        target: "develop",
      },
      mergeUpdateTarget: true,
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "develop",
    });
    const harness = makeHarness(source);

    await harness.handler("merge develop -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(harness.editorTexts).toEqual([`/move "${repo}"`]);
    expect(harness.moves).toEqual([]);
  });
});
