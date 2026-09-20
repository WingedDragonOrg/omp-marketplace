// Offline benchmarks for the wtm worktree manager and the delegate plugin.
//
// /wtm runs the handler the plugin registers; /delegate runs the real dispatchDelegate against a
// real SessionManager. Only external boundaries are injected (model controller, parent-session
// lookup, MCP manager); no plugin logic is re-implemented here, and no user repository is touched.
//
//   wtm_list_native_fallback — real git repo with three real worktrees. PATH is narrowed to a
//     temp bin holding only `git`, so `/wtm list` deterministically takes its native Git fallback;
//     HOME and every git config source are redirected, so no user configuration can reach git.
//   delegate_clean_dispatch — eight dispatches per run; each must hand the controller an empty
//     clean source while keeping the parent's runtime identity.
//
// Timed work touches no clock, randomness, or network: fixed fixtures, checksums over
// consumer-visible observations, setup/verify/teardown outside the timing.

import assert from "node:assert/strict";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

import type { TanControllerContext } from "../../plugins/delegate/delegate";
import { dispatchDelegate } from "../../plugins/delegate/delegate";
import registerWorktreeManager from "../../plugins/wtm/wtm.ts";
import type { BenchmarkCase } from "./types";

interface Notice {
  text: string;
  level: "info" | "error" | "warning";
}

/** FNV-1a over canonical facts: deterministic and wide enough to catch mutation. */
function checksum(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Canonical from the start: git reports resolved paths, so path comparison needs real paths. */
function createTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Bun does not forward process.env mutations to children, so the bench passes the env itself. */
function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${new TextDecoder().decode(result.stderr).trim()}`);
  }
  return new TextDecoder().decode(result.stdout);
}

/** Executable lookup over the current PATH, the way the plugin resolves `wt`. */
function findExecutableOnPath(name: string): string | null {
  const isExecutable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return directories.map((directory) => path.join(directory, name)).find(isExecutable) ?? null;
}

/** Saved values; `undefined` means the variable was unset. Restored verbatim in teardown. */
type EnvSnapshot = Record<string, string | undefined>;

function captureEnv(keys: readonly string[]): EnvSnapshot {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// HOME and every git config source are redirected so no user config, identity, or hook can reach
// the fixture; the bookkeeping variables are cleared so a caller's GIT_DIR/GIT_WORK_TREE cannot
// hijack the temporary repository.
const WTM_OWNED_ENV = [
  "HOME", "PATH", "XDG_CONFIG_HOME",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "OMP_WORKTREE_DIR",
];
const WTM_UNSET_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "OMP_WORKTREE_DIR"];
const WTM_BRANCHES = ["bench-w1", "bench-w2", "bench-w3"];
const FIXED_IDENTITY = { name: "Plugin Benchmark", email: "bench@example.invalid" };

interface WtmFixture {
  repo: string;
  /** Registered worktrees in `git worktree list` order: main tree first. */
  listed: Array<{ branch: string; dir: string }>;
}

interface WtmCommandContext {
  cwd: string;
  hasUI: boolean;
  ui: { notify(text: string, level: Notice["level"]): void };
}

interface RegisteredWtmCommand {
  handler(args: string, ctx: WtmCommandContext): Promise<void>;
}

/** Capture the /wtm handler the plugin registers, exactly as the extension host would. */
function registerWtmCommand(): RegisteredWtmCommand {
  let registered: RegisteredWtmCommand | undefined;
  registerWorktreeManager({
    setLabel() {},
    sendUserMessage() {},
    registerCommand(name: string, spec: unknown) {
      // The plugin's own command spec; the bench context covers what `/wtm list` reads.
      if (name === "wtm") registered = spec as unknown as RegisteredWtmCommand;
    },
  } as unknown as ExtensionAPI);
  if (!registered) throw new Error("/wtm did not register a command");
  return registered;
}

function createWtmFixture(root: string, gitExecutable: string): WtmFixture {
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  // Build the narrowed PATH first: every fixture command below must run the same git binary the
  // timed runs resolve, and `wt` must stay undiscoverable or the measured path would change.
  mkdirSync(home);
  mkdirSync(bin);
  symlinkSync(gitExecutable, path.join(bin, "git"));

  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main", "--quiet"]);
  git(repo, ["config", "user.name", FIXED_IDENTITY.name]);
  git(repo, ["config", "user.email", FIXED_IDENTITY.email]);
  writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "--quiet", "-m", "initial"]);

  // Worktrees live in their own directory, so registration order and git's listing order agree.
  const listed: WtmFixture["listed"] = [{ branch: "main", dir: realpathSync(repo) }];
  for (const branch of WTM_BRANCHES) {
    const dir = path.join(root, "wts", branch);
    mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, ["worktree", "add", "-b", branch, dir, "main"]);
    writeFileSync(path.join(dir, `${branch}.txt`), `${branch}\n`);
    git(dir, ["add", `${branch}.txt`]);
    git(dir, ["commit", "--quiet", "-m", `add ${branch}`]);
    listed.push({ branch, dir: realpathSync(dir) });
  }

  return { repo: realpathSync(repo), listed };
}

function createWtmListCase(): BenchmarkCase {
  const notices: Notice[] = [];
  let root: string | undefined;
  let fixture: WtmFixture | undefined;
  let envBefore: EnvSnapshot | undefined;
  let context: WtmCommandContext | undefined;
  let list: RegisteredWtmCommand["handler"] | undefined;

  return {
    name: "wtm_list_native_fallback",
    operations: 1,

    setup(): void {
      if (fixture !== undefined) return;
      const gitPath = Bun.which("git");
      if (!gitPath) throw new Error("the plugin benchmark needs git on PATH");
      const gitExecutable = realpathSync(gitPath);
      const created = createTempRoot("omp-bench-wtm-");
      root = created;
      envBefore = captureEnv(WTM_OWNED_ENV);
      process.env.HOME = path.join(created, "home");
      process.env.XDG_CONFIG_HOME = path.join(created, "xdg");
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
      process.env.GIT_CONFIG_SYSTEM = "/dev/null";
      process.env.GIT_CONFIG_COUNT = "0";
      for (const key of WTM_UNSET_ENV) delete process.env[key];
      // /usr/bin and /bin stay for the system commands git shells out to.
      process.env.PATH = [path.join(created, "bin"), "/usr/bin", "/bin"].join(path.delimiter);

      // A reachable Worktrunk would silently move the measurement to another code path.
      if (findExecutableOnPath("wt") !== null) throw new Error("cannot isolate Worktrunk: it is reachable on the benchmark PATH");

      fixture = createWtmFixture(created, gitExecutable);
      list = registerWtmCommand().handler;
      context = { cwd: fixture.repo, hasUI: true, ui: { notify: (text, level) => notices.push({ text, level }) } };
    },

    async verify(): Promise<void> {
      if (!fixture || !list || !context) throw new Error("wtm benchmark is not set up");
      // The isolated environment is the precondition for the measured path.
      assert.equal(findExecutableOnPath("wt"), null, "Worktrunk is reachable during the benchmark");
      const globalUser = Bun.spawnSync(["git", "config", "--global", "--get", "user.name"], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      assert.notEqual(globalUser.exitCode, 0, `user git config is visible: ${new TextDecoder().decode(globalUser.stdout).trim()}`);

      notices.length = 0;
      await list("list", context);
      assert.equal(notices.length, 1, "/wtm list emitted an unexpected number of notices");
      assert.equal(notices[0]!.level, "info", "/wtm list notice level changed");
      // Consumer-visible semantics: every registered worktree with its branch, and only the
      // session worktree marked current. Wording and column padding are not part of the contract.
      const rows = notices[0]!.text.split("\n").slice(1).map((line) => {
        const match = /^(.*?)\s+\[([^\]]+)\](  <- current)?$/.exec(line);
        if (!match) throw new Error(`unrecognized /wtm list line: ${line}`);
        return { dir: match[1]!.trim(), branch: match[2]!, current: match[3] !== undefined };
      });
      assert.deepEqual(
        rows,
        fixture.listed.map((worktree, index) => ({ dir: worktree.dir, branch: worktree.branch, current: index === 0 })),
        "/wtm list no longer reports the registered worktrees, branches, and current worktree",
      );
      // Listing worktrees must not write into the repository.
      assert.equal(git(fixture.repo, ["status", "--porcelain"]).trim(), "", "/wtm list dirtied the repository");
      notices.length = 0;
    },

    async run(): Promise<number> {
      if (!fixture || !root || !list || !context) throw new Error("wtm benchmark is not set up");
      const tempRoot = root;
      notices.length = 0;
      await list("list", context);
      // Normalized paths: the checksum describes the output shape, not the temp directory name.
      const facts = notices.map((notice) => `${notice.level}\n${notice.text.split(tempRoot).join("<ROOT>")}`);
      return checksum(facts.join("\n---\n"));
    },

    teardown(): void {
      const created = root;
      root = undefined;
      fixture = undefined;
      notices.length = 0;
      if (envBefore) {
        restoreEnv(envBefore);
        envBefore = undefined;
      }
      if (created) rmSync(created, { recursive: true, force: true });
    },
  };
}

const DELEGATE_WORK = "  benchmark clean-context delegation  ";
/** Fixed batch: one dispatch costs ~1 ms, too close to timer noise on its own. */
const DELEGATE_DISPATCHES_PER_RUN = 8;
const DELEGATE_PARENT_TEXT = "parent-only transcript entry";

interface DelegateObservation {
  work: string | undefined;
  sessionIsParent: boolean;
  facadeSessionId: string;
  facadeCwd: string;
  cleanFile: string | undefined;
  /** Message entries in the clean transcript handed to the controller. */
  cleanMessages: number;
  cleanHasParentText: boolean;
}

function createDelegateDispatchCase(): BenchmarkCase {
  const notices: Notice[] = [];
  let root: string | undefined;
  let project = "";
  let parent: SessionManager | undefined;
  let parentSession: AgentSession | undefined;
  let context: ExtensionCommandContext | undefined;
  let observation: DelegateObservation | undefined;
  let starts = 0;

  const parentFile = (): string => {
    const file = parent?.getSessionFile();
    if (!file) throw new Error("the benchmark parent session was not persisted");
    return file;
  };

  return {
    name: "delegate_clean_dispatch",
    operations: DELEGATE_DISPATCHES_PER_RUN,

    async setup(): Promise<void> {
      if (parent !== undefined) return;
      const created = createTempRoot("omp-bench-delegate-");
      root = created;
      project = path.join(created, "project");
      mkdirSync(project);
      const sessionDir = path.join(created, "sessions");
      parent = SessionManager.create(project, sessionDir);
      parent.appendMessage({ role: "user", content: DELEGATE_PARENT_TEXT, timestamp: 1767225600000 });
      // Persistence is lazy: the parent transcript must exist on disk before the dispatch, so the
      // faked host state matches production.
      await parent.ensureOnDisk();
      await parent.flush();
      assert.ok(parent.getSessionFile(), "the benchmark parent session was not persisted");

      // Host session and model runtime stand-ins: only the caller-owned surroundings of the
      // dispatch under test are faked.
      parentSession = {
        sessionId: parent.getSessionId(),
        sessionManager: parent,
        model: { provider: "bench", id: "bench-model" },
        asyncJobManager: {},
        settings: {},
      } as unknown as AgentSession;
      context = {
        cwd: project,
        hasUI: true,
        mode: "tui",
        ui: { notify: (text: string, level: Notice["level"]) => notices.push({ text, level }) },
        sessionManager: parent,
      } as unknown as ExtensionCommandContext;
    },

    async verify(): Promise<void> {
      if (!parent || !context) throw new Error("delegate benchmark is not set up");
      const file = parentFile();
      starts = 0;
      notices.length = 0;
      observation = undefined;
      await dispatch();
      const seen = observation;
      if (!seen?.cleanFile) throw new Error("dispatchDelegate never handed the controller a clean session");
      assert.deepEqual(notices, [], "/delegate reported a problem for a valid dispatch");
      // Clean source on one side, parent identity on the other.
      assert.deepEqual(
        {
          work: seen.work, parentAgent: seen.sessionIsParent, cleanIsParentFile: seen.cleanFile === file,
          cleanIsSibling: path.dirname(seen.cleanFile) === path.dirname(file),
          facadeKeepsParentIdentity: seen.facadeSessionId === parent.getSessionId() && seen.facadeCwd === project,
          cleanIsEmpty: seen.cleanMessages === 0 && seen.cleanHasParentText === false,
          cleanLeftBehind: existsSync(seen.cleanFile),
        },
        {
          work: DELEGATE_WORK.trim(), parentAgent: true, cleanIsParentFile: false, cleanIsSibling: true,
          facadeKeepsParentIdentity: true, cleanIsEmpty: true, cleanLeftBehind: false,
        },
        "the delegate dispatch contract changed",
      );
      // The real dispatcher still enforces its own host contract: an empty request is a warning and
      // never reaches the controller.
      notices.length = 0;
      await dispatch({ args: "   " });
      assert.deepEqual(notices.map((notice) => notice.level), ["warning"], "/delegate no longer rejects an empty request");
      assert.equal(starts, 1, "the controller did not start exactly once");
      notices.length = 0;
      starts = 0;
    },

    async run(): Promise<number> {
      if (!parent || !context) throw new Error("delegate benchmark is not set up");
      const file = parentFile();
      const expectedWork = DELEGATE_WORK.trim();
      const blocks: string[] = [];

      for (let index = 0; index < DELEGATE_DISPATCHES_PER_RUN; index++) {
        starts = 0;
        notices.length = 0;
        observation = undefined;
        await dispatch();
        const seen = observation;
        const cleanFile = seen?.cleanFile;
        blocks.push([
          `work=${seen?.work === expectedWork}`, `parentAgent=${seen?.sessionIsParent === true}`, `starts=${starts}`,
          `cleanSource=${cleanFile !== undefined && cleanFile !== file && path.dirname(cleanFile) === path.dirname(file)}`,
          `identity=${seen?.facadeSessionId === parent.getSessionId() && seen?.facadeCwd === project}`,
          `cleanEmpty=${seen?.cleanMessages === 0 && seen?.cleanHasParentText === false}`,
          `cleanDropped=${cleanFile !== undefined && !existsSync(cleanFile)}`, `notices=${notices.length}`,
        ].join(","));
      }
      return checksum(blocks.join("\n"));
    },

    async teardown(): Promise<void> {
      const manager = parent;
      const created = root;
      parent = undefined;
      parentSession = undefined;
      context = undefined;
      root = undefined;
      notices.length = 0;
      observation = undefined;
      starts = 0;
      try {
        await manager?.close();
      } finally {
        if (created) rmSync(created, { recursive: true, force: true });
      }
    },
  };

  /**
   * Fake controller: the model boundary. It mirrors how the native tan controller consumes the
   * facade — materialize and flush the session, then read what the child agent would see.
   */
  function controller(tanContext: TanControllerContext): { start(work: string): Promise<void> } {
    return {
      async start(work: string): Promise<void> {
        starts++;
        const manager = tanContext.sessionManager;
        await manager.ensureOnDisk();
        await manager.flush();
        const cleanFile = manager.getSessionFile();
        const transcript = (cleanFile ? readFileSync(cleanFile, "utf8") : "").split("\n").filter((line) => line.trim() !== "");
        observation = {
          work,
          sessionIsParent: tanContext.session === parentSession,
          facadeSessionId: manager.getSessionId(),
          facadeCwd: manager.getCwd(),
          cleanFile,
          cleanMessages: transcript.filter((line) => {
            const parsed: unknown = JSON.parse(line);
            return typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "message";
          }).length,
          cleanHasParentText: transcript.some((line) => line.includes(DELEGATE_PARENT_TEXT)),
        };
      },
    };
  }

  /** Run the plugin's dispatcher with the host boundaries injected. */
  async function dispatch(options: { args?: string } = {}): Promise<void> {
    if (!parent || !parentSession || !context) throw new Error("delegate benchmark is not set up");
    await dispatchDelegate(options.args ?? DELEGATE_WORK, context, {
      resolveParentSession: () => parentSession,
      createTanController: controller,
      // MCP servers are an external service: never instantiate the real manager.
      mcpManager: {} as unknown as MCPManager,
    });
  }
}

export const cases: BenchmarkCase[] = [createWtmListCase(), createDelegateDispatchCase()];
