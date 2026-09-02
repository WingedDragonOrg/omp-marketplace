import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import registerWorktreeManager from "./wt.ts";

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

function makeHarness(cwd: string): Harness {
  let command: RegisteredCommand | undefined;
  const notices: Notice[] = [];
  const moves: string[] = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const state = { reloads: 0 };
  registerWorktreeManager({
    setLabel() {},
    registerCommand(name: string, spec: unknown) {
      if (name === "wt" && isRegisteredCommand(spec)) command = spec;
    },
  });
  if (!command) throw new Error("/wt command was not registered");

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
    console.log(JSON.stringify({
      kind: "worktree",
      branch,
      path: process.env.WT_FAKE_REMOVE_REPORTED_PATH || target,
      branch_outcome: "not_attempted",
      branch_checked_out_at: null,
    }));
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

describe("/wt backend selection", () => {
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

  test("uses supported Worktrunk create output as the session destination", async () => {
    // Catches bypassing Worktrunk, omitting the HEAD base, or deriving cwd from human output.
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

    expect(harness.moves).toEqual([target]);
    expect(harness.reloads).toBe(1);
    const calls = fakeCalls(log);
    const switchCall = calls.find((args) => args.includes("switch"));
    expect(switchCall).toBeDefined();
    expect(switchCall).toContain("--create");
    expect(switchCall).toContain("--base=@");
    expect(switchCall).toContain("--no-cd");
    expect(switchCall).toContain("--format=json");
    expect(switchCall?.some((arg) => arg.startsWith("worktree-path="))).toBe(true);
  });
});

describe("/wt fallback and list behavior", () => {
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
    expect(harness.moves).toEqual([created]);
    expect(harness.reloads).toBe(1);
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

    expect(harness.moves).toEqual([legacyPath]);
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

describe("/wt Worktrunk removal", () => {
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

  test("keeps the session on primary when self removal fails", async () => {
    // Catches reloading into a source that Worktrunk may have partially removed.
    const root = tempRoot();
    const repo = initRepo(root);
    const source = path.join(root, "self-topic");
    git(repo, ["worktree", "add", "-b", "self-topic", source]);
    installFakeWorktrunk(root, { removeExit: 9 });
    const harness = makeHarness(source);

    await harness.handler("rm self -y", harness.ctx);

    expect(harness.moves).toEqual([repo]);
    expect(harness.reloads).toBe(0);
    expect(existsSync(source)).toBe(true);
    expect(harness.notices.at(-1)?.level).toBe("error");
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

describe("/wt Worktrunk approvals and hooks", () => {
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
    expect(harness.moves).toEqual([target]);
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
    expect(harness.notices.at(-1)?.text).toContain("Retry /wt hook-topic");
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

    expect(harness.moves).toEqual([target]);
    expect(harness.notices.some(({ text }) => text.includes("wt config state logs"))).toBe(true);
  });
});

describe("/wt Worktrunk merge", () => {
  test("runs the default merge after moving to a safe primary", async () => {
    // Catches launching cleanup while the OMP session still points at the removable source.
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
      requiredMove: repo,
    });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(harness.moves).toEqual([repo]);
    expect(harness.reloads).toBe(1);
    expect(git(repo, ["rev-parse", "main"])).toBe(sourceHead);
    expect(existsSync(source)).toBe(false);
    expect(runGitBranchExists(repo, "feature")).toBe(false);
    const mergeCall = fakeCalls(log).find((args) => args.includes("merge"));
    expect(mergeCall).toContain("--format=json");
    expect(mergeCall).not.toContain("--yes");
    expect(harness.notices.some(({ text }) => text.includes("target main updated"))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("cleanup scheduled"))).toBe(true);
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
  test("prefers a registered target worktree as safe landing", async () => {
    // Catches ignoring an exact target checkout in favor of an unrelated primary.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const targetPath = path.join(root, "develop");
    git(repo, ["worktree", "add", "-b", "develop", targetPath]);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
        { branch: "develop", path: targetPath, main: false, current: false },
      ]),
      mergeResult: {
        branch: "feature",
        committed: false,
        rebased: true,
        removed: true,
        squashed: true,
        target: "develop",
      },
      mergeUpdateTarget: true,
      mergeRemoveSource: true,
      mergeDeleteSourceBranch: true,
      mergePrimary: repo,
      mergeTarget: "develop",
      requiredMove: targetPath,
    });
    const harness = makeHarness(source);

    await harness.handler("merge develop -y", harness.ctx);

    expect(harness.moves).toEqual([targetPath]);
    expect(harness.reloads).toBe(1);
    expect(existsSync(source)).toBe(false);
  });

  test("reconciles target update after pre-remove failure", async () => {
    // Catches claiming an atomic failure when Worktrunk already advanced the target ref.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const sourceHead = git(source, ["rev-parse", "HEAD"]);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeRaw: "",
      mergeExit: 7,
      mergeStderr: "pre-remove project:cleanup failed",
      mergeUpdateTarget: true,
      mergePrimary: repo,
      mergeTarget: "main",
      requiredMove: repo,
    });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(git(repo, ["rev-parse", "main"])).toBe(sourceHead);
    expect(existsSync(source)).toBe(true);
    expect(runGitBranchExists(repo, "feature")).toBe(true);
    expect(harness.moves).toEqual([repo]);
    expect(harness.reloads).toBe(1);
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
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeRaw: "",
      mergeExit: 8,
      mergeStderr: "rebase conflict remains in source",
      mergePrimary: repo,
      mergeTarget: "main",
      requiredMove: repo,
    });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(git(repo, ["rev-parse", "main"])).toBe(targetBefore);
    expect(existsSync(source)).toBe(true);
    expect(runGitBranchExists(repo, "feature")).toBe(true);
    expect(harness.reloads).toBe(1);
    expect(harness.notices.some(({ text }) => text.includes("target main unchanged"))).toBe(true);
  });

  test("does not retry after incompatible merge JSON", async () => {
    // Catches a second native merge after Worktrunk already changed the target.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const sourceHead = git(source, ["rev-parse", "HEAD"]);
    const log = installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeRaw: "not-json",
      mergeUpdateTarget: true,
      mergePrimary: repo,
      mergeTarget: "main",
      requiredMove: repo,
    });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(git(repo, ["rev-parse", "main"])).toBe(sourceHead);
    expect(fakeCalls(log).filter((args) => args.includes("merge"))).toHaveLength(1);
    expect(harness.notices.some(({ text }) => text.includes("incompatible JSON"))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("Native Git was not retried"))).toBe(true);
  });

  test("labels a non-target primary as the safe landing", async () => {
    // Catches telling the user that a valid primary checkout is the requested target checkout.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    git(repo, ["branch", "develop", "main"]);
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
        target: "develop",
      },
      mergeUpdateTarget: true,
      mergePrimary: repo,
      mergeTarget: "develop",
      requiredMove: repo,
    });
    const harness = makeHarness(source);

    await harness.handler("merge develop -y", harness.ctx);

    expect(harness.moves).toEqual([repo]);
    expect(harness.notices.some(({ text }) => text.includes("primary safe landing"))).toBe(true);
    expect(harness.notices.some(({ text }) => text.includes("checked out target develop"))).toBe(false);
  });


  test("blocks an unapproved cleanup post-switch hook", async () => {
    // Catches omitting Worktrunk's destination hook from the merge approval preflight.
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
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(harness.moves).toEqual([]);
    expect(harness.notices.at(-1)?.text).toContain("post-switch/announce: echo merged");
  });
  test("reloads the safe landing when the pinned binary disappears", async () => {
    // Catches an ENOENT escaping after session pre-migration and skipping the required reload.
    const root = tempRoot();
    const { repo, source } = initMergeSource(root);
    const targetBefore = git(repo, ["rev-parse", "main"]);
    installFakeWorktrunk(root, {
      list: worktrunkListFixture("main", [
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergePrimary: repo,
      mergeTarget: "main",
      deleteAfterApprovals: true,
    });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(git(repo, ["rev-parse", "main"])).toBe(targetBefore);
    expect(harness.moves).toEqual([repo]);
    expect(harness.reloads).toBe(1);
    expect(harness.notices.some(({ text }) => text.includes("Native Git was not retried"))).toBe(true);
  });
});

describe("/wt Worktrunk compatibility boundary", () => {
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
    expect(harness.moves).toEqual([target]);
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

describe("/wt reviewed reconciliation boundaries", () => {
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
    // Catches reloading OMP into an ordinary directory occupying stale worktree metadata.
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
        removed: false,
        squashed: false,
        target: "develop",
      },
      mergePrimary: repo,
      mergeTarget: "develop",
      requiredMove: repo,
    });
    const harness = makeHarness(source);

    await harness.handler("merge develop -y", harness.ctx);

    expect(harness.moves).toEqual([repo]);
    expect(harness.reloads).toBe(1);
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
    const source = path.join(root, "separate-feature");
    git(repo, ["worktree", "add", "-b", "feature", source]);
    writeFileSync(path.join(source, "feature.txt"), "feature\n");
    git(source, ["add", "feature.txt"]);
    git(source, ["commit", "-m", "feature"]);
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
      requiredMove: repo,
    });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

    expect(harness.moves).toEqual([repo]);
    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(true);
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
        { branch: "main", path: repo, main: true, current: false },
        { branch: "feature", path: source, main: false, current: true },
      ]),
      mergeRaw: "",
      mergeExit: 7,
      mergeStderr: "target update failed",
      mergeDeleteTarget: true,
      mergePrimary: repo,
      mergeTarget: "main",
      requiredMove: repo,
    });
    const harness = makeHarness(source);

    await harness.handler("merge -y", harness.ctx);

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

  test("moves self removal to Worktrunk primary metadata", async () => {
    // Catches treating a separate Git metadata directory as the primary worktree.
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

    expect(harness.moves).toEqual([repo]);
    expect(existsSync(source)).toBe(false);
    expect(runGitBranchExists(repo, "feature")).toBe(true);
    expect(harness.reloads).toBe(1);
  });

  test("rejects primary metadata from a different repository", async () => {
    // Catches accepting any live Git root as a merge safe landing.
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
      mergePrimary: unrelated,
      mergeTarget: "develop",
    });
    const harness = makeHarness(source);

    await harness.handler("merge develop -y", harness.ctx);

    expect(harness.moves).toEqual([]);
    expect(fakeCalls(log).some((args) => args.includes("merge"))).toBe(false);
    expect(harness.notices.at(-1)?.text).toContain("Cannot find a registered safe landing");
  });
});
