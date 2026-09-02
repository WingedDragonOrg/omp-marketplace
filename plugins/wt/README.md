# wt

Oh My Pi (`omp`) extension for Git worktree lifecycle management and Worktrunk-powered local merges.

The plugin uses compatible Worktrunk releases for structured worktree operations, project hooks, command approvals, configured paths, and merge automation. Existing create, list, remove, and prune commands retain a native Git fallback.

## Install

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install wt@winged-dragon-org
```

Restart `omp` or start a new session after installation. Extension modules load when the session starts.

For Worktrunk-backed behavior, install a stable Worktrunk v0.76.x release separately and ensure `wt` is on `PATH`. The marketplace plugin does not install or upgrade the binary. Prerelease builds and other Worktrunk versions are rejected for merge and use the native Git fallback for existing lifecycle commands.

Manual plugin installation remains available by placing `wt.ts` in `~/.omp/agent/extensions/`.

## Commands

```text
/wt [name] [--base <ref>]       create/reuse worktree + move session
/wt list                        list this repository's worktrees
/wt rm <name|path> [-f] [-y]    remove one worktree; retain its branch
/wt rm self [-f] [-y]           move to primary, then remove current worktree
/wt rm --all [-f] [-y]          remove eligible worktrees except primary/current
/wt prune                       prune stale Git worktree metadata
/wt merge [target] [flags]      run Worktrunk's local merge pipeline
```

A missing name defaults to `wt-<YYYYMMDDHHMM>`. New branches start from the current `HEAD` unless `--base <ref>` is supplied.

### Remove flags

- `-f` / `--force`: allow removal of a dirty worktree.
- `-y` / `--yes`: skip the plugin's removal confirmation.

Worktrunk removal always runs in the foreground with `--no-delete-branch`. `/wt rm --all` excludes the primary worktree, the current session worktree, bare entries, and stale registrations. A final `git worktree prune` removes stale metadata only.

### Merge flags

```text
--no-squash
--no-commit
--no-rebase
--no-remove
--no-ff
--stage all|tracked|none
-y / --yes
```

The default Worktrunk pipeline:

1. handles uncommitted changes;
2. squashes source commits;
3. rebases onto the local target;
4. runs pre-merge validation;
5. fast-forwards the target;
6. runs remove hooks and schedules eligible source cleanup;
7. starts background post hooks.

The target defaults to Worktrunk's detected default branch. The plugin does not fetch before merge or push afterward. Commit messages come from existing commits, the user's Worktrunk generator, or Worktrunk's deterministic fallback.

Before a cleanup-enabled merge from a linked worktree, the plugin moves the OMP session to a registered target worktree when available, otherwise to the primary worktree. Once Worktrunk starts, the session does not automatically return to a source that background cleanup may delete. `--no-remove` retains both the source worktree and its session.

After every merge attempt, the plugin reconciles the target ref, source worktree registration, source branch, and source path. A failed or incompatible Worktrunk result never triggers a second native Git mutation.

## Project command approvals

Before an operation that can run project hooks or project commit guidance, the plugin reads:

```sh
wt config approvals list --format=json
```

Relevant unapproved commands or stale approval records stop the operation before mutation. Review and persist approvals from a terminal in the repository:

```sh
wt config approvals add
```

Then retry `/wt`. The plugin does not write approvals, pass Worktrunk's `--yes`, or use `--no-hooks`. `/wt ... -y` skips only the OMP confirmation and cannot bypass project command approval.

Blocking hook failures stop the Worktrunk pipeline. Completed Git or session operations are not rolled back after background hook failures; the notification points to `wt config state logs`.

## Paths and compatibility

Without `OMP_WORKTREE_DIR`, new worktrees use Worktrunk's configured `worktree-path`. With `OMP_WORKTREE_DIR`, new worktrees use the existing `<repo>-<name>` naming convention under that directory. Existing registered worktrees are reused at their current paths without migration.

Path comparisons are realpath-based, so symlinked paths such as macOS `/tmp` and `/private/tmp` resolve to the same worktree identity.

Worktrunk calls use deterministic JSON list settings with full and summary collection disabled. The absolute Worktrunk executable selected by the v0.76.x version gate remains fixed for the entire command.

Tested against omp 18.0.5, Bun 1.3.14, and Worktrunk 0.76.0.
