# omp-wt

Oh My Pi (`omp`) extension: a git worktree manager for the `/wt` command.

Worktrees are created under `~/.omp/wt/<repo>-<name>` (honors `OMP_WORKTREE_DIR`)
and the current session is moved into them with the same primitive as `/move`.

## Install

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install omp-wt@winged-dragon-org
```

Restart `omp` (or start a new session) — extension modules load at session start.

Manual alternative: drop `wt.ts` into `~/.omp/agent/extensions/`.

## Usage

```text
/wt [name] [--base <ref>]    create/reuse worktree + move session into it
                             (name defaults to wt-<YYYYMMDDHHMM>, branch = name)
/wt list                     list this repo's worktrees
/wt rm <name|path> [-f] [-y] remove one worktree
/wt rm self [-y]             remove the current worktree, moving the session
                             back to the main checkout first
/wt rm --all [-f] [-y]       remove every worktree except the current one
                             and the main checkout
/wt prune                    prune stale worktree metadata
```

Flags for `rm`:

- `-f` / `--force` — remove even with uncommitted changes (otherwise the command
  refuses and shows the first dirty files)
- `-y` / `--yes` — skip the confirmation dialog

Notes:

- Path comparisons are realpath-based, so symlinked checkouts (e.g. macOS `/tmp`
  vs `/private/tmp`) still match correctly.
- `rm --all` never touches the main working tree, the worktree the session is
  currently in, bare entries, or stale registrations (the trailing
  `git worktree prune` cleans those).
- `ctx.reload()` re-roots cwd-scoped surfaces after moving the session; it is
  terminal for the handler frame.

Tested against omp 18.0.5.
