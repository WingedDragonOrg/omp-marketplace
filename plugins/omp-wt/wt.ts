// /wt — git worktree manager for Oh My Pi (user-level extension, auto-discovered).
//
// Usage:
//   /wt [name] [--base <ref>]    create (or reuse) a worktree under ~/.omp/wt/<repo>-<name>
//                                and move the current session into it (same primitive as /move)
//   /wt list                     list worktrees of the current repo
//   /wt rm <name|path> [-f]      remove a worktree (and prune); -f forces dirty removal;
//                                removing the session's own worktree moves the session back
//                                to the main checkout first (confirm dialog unless --yes)
//   /wt rm --all [-f] [-y]       remove every worktree except the current one and the
//                                main checkout (dirty ones need -f)
//   /wt prune                    prune stale worktree metadata
//
// Implementation notes (verified against omp 18.0.5):
// - `sessionManager.moveTo(absDir)` re-roots the session; `ctx.reload()` refreshes
//   cwd-scoped surfaces for the new directory. reload() is terminal for the handler
//   frame (documented constraint), so it must be the last statement.
// - Base dir honors OMP_WORKTREE_DIR (same env omp core uses for ~/.omp/wt).
// - `session_shutdown` handlers run with a 2s budget before teardown — too short for
//   a confirm dialog, so exit-time cleanup is NOT hooked there; `rm --self` is the
//   explicit close-out action instead.

import * as path from "node:path";
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";

const HELP = `Usage:
  /wt [name] [--base <ref>]   create/reuse worktree + move session into it
  /wt list                    list this repo's worktrees
  /wt rm <name|path> [-f|-y]  remove a worktree (-f forces dirty removal)
  /wt rm self [-y]            remove the current worktree, moving the session
                              back to the main checkout first
  /wt rm --all [-f|-y]        remove every worktree except the current one
                              and the main checkout
  /wt prune                   prune stale worktree metadata
  name defaults to wt-<YYYYMMDDHHMM>; lives under ~/.omp/wt/<repo>-<name>`;

function worktreeBaseDir(): string {
  const env = process.env.OMP_WORKTREE_DIR;
  if (env) return env.replace(/^~(?=\/|$)/, homedir());
  return path.join(homedir(), ".omp", "wt");
}

interface GitResult { code: number; out: string; err: string }

function runGit(cwd: string, args: string[]): GitResult {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? -1,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

/** realpathSync that tolerates missing paths (returns null instead of throwing). */
function realPath(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

function slugify(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "wt";
}

interface PorcelainWorktree { path: string; branch: string | null; head: string; bare: boolean; detached: boolean }

function listPorcelain(cwd: string): PorcelainWorktree[] {
  const out = runGit(cwd, ["worktree", "list", "--porcelain"]).out;
  const entries: PorcelainWorktree[] = [];
  let cur: Partial<PorcelainWorktree> | null = null;
  for (const line of out.split("\n")) {
    if (!line) { cur = null; continue; }
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9).trim(), branch: null, head: "", bare: false, detached: false };
      entries.push(cur as PorcelainWorktree);
    } else if (cur) {
      if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      else if (line === "bare") cur.bare = true;
      else if (line === "detached") cur.detached = true;
    }
  }
  return entries;
}

/** Resolve a user-supplied selector (name or path) to a porcelain worktree entry. */
function resolveWorktree(cwd: string, selector: string): PorcelainWorktree | null {
  const entries = listPorcelain(cwd);
  const abs = path.resolve(cwd, selector);
  const base = worktreeBaseDir();
  // Realpath both candidates and entries: the user may pass a symlinked path
  // (e.g. /tmp on macOS) while git porcelain reports resolved /private/tmp paths.
  const candidates = [abs, path.resolve(base, selector), path.resolve(base, `${path.basename(runGit(cwd, ["rev-parse", "--show-toplevel"]).out.trim())}-${selector}`)]
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

export default function (pi) {
  pi.setLabel("Worktree Manager");

  pi.registerCommand("wt", {
    description: "Create/list/remove git worktrees (~/.omp/wt) and move the session into one",
    getArgumentCompletions(arg: string) {
      if (arg.includes(" ")) return null;
      const c = arg.trim().toLowerCase();
      const items = [
        { label: "list", value: "list", description: "list this repo's worktrees" },
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

      const argv = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (argv[0] ?? "").toLowerCase();

      if (argv.includes("-h") || argv.includes("--help") || sub === "help") {
        notify(HELP, "info");
        return;
      }

      // ---- shared precondition: git repo ----
      if (runGit(ctx.cwd, ["rev-parse", "--git-dir"]).code !== 0) {
        notify("Not a git repository — /wt needs a git checkout.", "error");
        return;
      }

      // ---- list ----
      if (sub === "list" || sub === "ls") {
        const entries = listPorcelain(ctx.cwd);
        const lines = entries.map((e) => {
          const ref = e.bare ? "(bare)" : e.branch ? `[${e.branch}]` : e.detached ? `(detached ${e.head.slice(0, 7)})` : "(?)";
          const here = (realPath(e.path) ?? e.path) === (realPath(ctx.cwd) ?? ctx.cwd) ? "  <- current" : "";
          return `  ${shortPath(e.path).padEnd(46)} ${ref}${here}`;
        });
        notify(`Worktrees of ${shortPath(runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]).out.trim())}:\n${lines.join("\n")}`, "info");
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
        const commonDir = runGit(ctx.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out.trim();
        const mainPath = commonDir ? path.dirname(commonDir) : "";

        // ---- rm --all: remove every worktree except the current one and the main tree ----
        if (all) {
          if (selector) {
            notify("--all takes no selector — use /wt rm --all or /wt rm <name|path|self>", "error");
            return;
          }
          // Realpath both sides: ctx.cwd may be a symlinked path (e.g. /tmp on macOS)
          // while git porcelain reports the resolved path — lexical equality misses it
          // and would treat the session's own worktree as removable.
          const cwdAbs = realPath(ctx.cwd) ?? path.resolve(ctx.cwd);
          const mainAbs = mainPath ? realPath(mainPath) ?? path.resolve(mainPath) : "";
          // skip: the main tree, the session's own worktree, bare entries, and stale
          // registrations whose directory is gone (those are cleaned by the final prune)
          const victims = listPorcelain(ctx.cwd).filter((e) => {
            const p = realPath(e.path) ?? path.resolve(e.path);
            return !e.bare && p !== cwdAbs && p !== mainAbs && existsSync(e.path);
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
          if (!yes) {
            const msg =
              `Remove ${victims.length} worktree(s)?\n` +
              victims.map((v) => `  ${shortPath(v.path)}${v.branch ? ` [${v.branch}]` : ""}`).join("\n") +
              (dirty.length > 0 ? `\nUncommitted changes in ${dirty.length} worktree(s) will be lost.` : "");
            const ok = ctx.hasUI ? await ui.confirm("Remove worktrees", msg) : true;
            if (!ok) { notify("Cancelled.", "info"); return; }
          }
          const gitCwd = mainPath || ctx.cwd;
          const failed: string[] = [];
          for (const v of victims) {
            const args = ["worktree", "remove"];
            if (force) args.push("--force");
            args.push(v.path);
            if (runGit(gitCwd, args).code !== 0) failed.push(shortPath(v.path));
          }
          runGit(gitCwd, ["worktree", "prune"]);
          const removed = victims.length - failed.length;
          notify(
            failed.length === 0
              ? `Removed ${removed} worktree(s):\n${victims.map((v) => `  ${shortPath(v.path)}`).join("\n")}`
              : `Removed ${removed}, failed ${failed.length}:\n${failed.join(", ")}`,
            failed.length === 0 ? "info" : "warning",
          );
          return;
        }

        if (!selector) {
          notify("Usage: /wt rm <name|path|self> [-f] [-y] | /wt rm --all [-f] [-y]", "error");
          return;
        }

        const isSelf = selector === "self" || selector === ".";
        const cwdReal = realPath(ctx.cwd) ?? path.resolve(ctx.cwd);
        const mainReal = mainPath ? realPath(mainPath) ?? path.resolve(mainPath) : "";
        const target = isSelf
          ? listPorcelain(ctx.cwd).find((e) => (realPath(e.path) ?? path.resolve(e.path)) === cwdReal) ?? null
          : resolveWorktree(ctx.cwd, selector);
        if (!target) {
          notify(isSelf ? "Current directory is not a linked worktree (already on the main tree)." : `No worktree matches "${selector}". Try /wt list.`, "error");
          return;
        }

        const targetReal = realPath(target.path) ?? path.resolve(target.path);
        const targetIsCwd = targetReal === cwdReal;
        if (mainReal && targetReal === mainReal) {
          notify("Refusing to remove the main working tree.", "error");
          return;
        }
        if (!isSelf && targetIsCwd) {
          notify(`This is the session's worktree — use /wt rm self (moves the session back to ${shortPath(mainPath)} first).`, "warning");
          return;
        }

        // dirty check → confirm
        const dirty = runGit(target.path, ["status", "--porcelain"]).out.trim();
        if (dirty && !force) {
          notify(`Worktree ${shortPath(target.path)} has uncommitted changes:\n${dirty.split("\n").slice(0, 5).join("\n")}\nUse -f to remove anyway.`, "warning");
          return;
        }
        if (!yes) {
          const msg = `Remove worktree ${shortPath(target.path)}${target.branch ? ` (branch ${target.branch})` : ""}?` +
            (targetIsCwd ? `\nThe session will move back to ${shortPath(mainPath)} first.` : "") +
            (dirty ? "\nUncommitted changes will be lost." : "");
          const ok = ctx.hasUI ? await ui.confirm("Remove worktree", msg) : true;
          if (!ok) { notify("Cancelled.", "info"); return; }
        }

        // if the session lives in the target worktree, move it out first
        if (targetIsCwd) {
          if (!mainPath || runGit(mainPath, ["rev-parse", "--git-dir"]).code !== 0) {
            notify(`Cannot determine the main working tree to fall back to. Move out manually (/move <path>) and retry.`, "error");
            return;
          }
          try {
            await ctx.sessionManager.moveTo(path.resolve(mainPath));
          } catch (e) {
            notify(`Moving session back to main tree failed: ${e instanceof Error ? e.message : String(e)}`, "error");
            return;
          }
        }

        const args = ["worktree", "remove"];
        if (force) args.push("--force");
        args.push(target.path);
        const r = runGit(mainPath || ctx.cwd, args);
        if (r.code !== 0) {
          notify(`git worktree remove failed: ${r.err}`, "error");
          return;
        }
        runGit(mainPath || ctx.cwd, ["worktree", "prune"]);
        notify(`Removed worktree ${shortPath(target.path)}${targetIsCwd ? ` — session is back on ${shortPath(mainPath)}` : ""}`, "info");

        if (targetIsCwd) {
          await ctx.reload(); // terminal: refresh cwd-scoped surfaces for the main tree
        }
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
      const root = runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]).out.trim();
      const baseDir = worktreeBaseDir();
      const wtPath = path.join(baseDir, `${path.basename(root)}-${name}`);

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

      // move the session into the worktree (same primitive as built-in /move),
      // then refresh cwd-scoped surfaces. reload() is terminal for this frame.
      try {
        await ctx.sessionManager.moveTo(path.resolve(wtPath));
      } catch (e) {
        notify(`Move failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }
      notify(`Moved session to ${shortPath(wtPath)} — reloading…`, "info");
      await ctx.reload();
    },
  });
}
