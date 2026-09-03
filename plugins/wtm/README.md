# WTM

WTM is an Oh My Pi (`omp`) extension for Git worktree lifecycle management and Worktrunk-powered local merges. Its slash command is `/wtm`; OMP's built-in `/wt` and `/worktree` commands remain available.

Compatible Worktrunk releases provide structured worktree operations, project hooks, command approvals, configured paths, and merge automation. Create, list, remove, and prune retain a native Git fallback.

## Install

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install wtm@winged-dragon-org
```

Users migrating the marketplace identity install the new entry explicitly:

```sh
omp plugin uninstall wt@winged-dragon-org
omp plugin install wtm@winged-dragon-org
```

Restart `omp` or start a new session after installation. Extension modules load when the session starts.

For Worktrunk-backed behavior, install a stable Worktrunk v0.76.x release separately and ensure `wt` is on `PATH`. The marketplace plugin does not install or upgrade the binary. Prerelease builds and other Worktrunk versions are rejected for merge and use the native Git fallback for lifecycle commands.

Manual installation remains available by placing `wtm.ts` in `~/.omp/agent/extensions/`.

## Commands

```text
/wtm [branch] [--base <ref>]                  create/reuse worktree and prepare /move
/wtm list                                     list this repository's worktrees
/wtm rm <branch|path> [-f] [-y]               remove one worktree; retain its branch
/wtm rm self [-f] [-y]                        prepare /move, then remove current worktree
/wtm rm --all [-f] [-y]                       remove eligible worktrees except primary/current
/wtm prune                                    prune stale Git worktree metadata
/wtm merge [target] [flags] [--source <path>] run Worktrunk's local merge pipeline
```

A missing branch defaults to `wt-<YYYYMMDDHHMM>`. New branches start from the current `HEAD` unless `--base <ref>` is supplied.

### Session move handoff

WTM never changes the active OMP session directory directly. After create or reuse, it validates the live registered worktree and prepares:

```text
/move "<absolute-worktree-path>"
```

In the TUI the command is placed in the editor. Press Enter to let OMP core relocate the session and refresh project settings, providers, plugins, skills, commands, terminal title, footer, and todos. On non-TUI surfaces WTM prints the same copyable command.

The target is verified when WTM creates the handoff. If it is deleted or replaced before `/move` is submitted, rerun the original `/wtm` command to generate a current handoff. Paths containing a line break or NUL are retained after creation but cannot be placed into a one-line slash command.

Generated `/wtm` continuation commands encode path, target, and ref values as JSON string tokens. This preserves spaces, double quotes, and backslashes. Manually entered unquoted tokens continue to work.

### Remove

- `-f` / `--force` allows removal of a dirty worktree.
- `-y` / `--yes` skips the confirmation for the invocation where it appears.

Worktrunk removal runs in the foreground with `--no-delete-branch`. `/wtm rm --all` excludes the primary worktree, current session worktree, bare entries, and stale registrations. A final `git worktree prune` removes stale metadata only.

`/wtm rm self` is a two-step operation:

1. WTM prepares `/move` to the live primary worktree and prints `/wtm rm "<source-path>"`.
2. Submit `/move`.
3. Run the printed remove command.

The continuation omits the preparation-stage `-y`. The second invocation revalidates repository identity, branch, HEAD, dirty state, approvals, and displays a fresh confirmation before removal.

### Merge

```text
--source <absolute-worktree-path>
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

The target defaults to Worktrunk's detected default branch. WTM does not fetch before merge or push afterward. Commit messages come from existing commits, the user's Worktrunk generator, or Worktrunk's deterministic fallback.

A cleanup-enabled merge from the current linked source is also two-step:

1. WTM selects a live target worktree when available, otherwise the live primary worktree.
2. It prepares `/move` and prints a complete `/wtm merge ... --source "<source-path>"` continuation without `-y`.
3. After `/move`, run the continuation. WTM revalidates both worktrees, refs, dirty state, Git recovery state, approvals, and asks for confirmation before invoking Worktrunk.

`--no-remove`, a primary source, or a source branch equal to the target can run directly. An explicit `--source` can run from any other live worktree in the same repository.

After every merge attempt, WTM reconciles the target ref, source worktree registration, source branch, and source path. A failed or incompatible Worktrunk result never triggers native Git mutation. Resolve or abort an active rebase, merge, cherry-pick, or revert before retrying. When the target already contains the source but cleanup remains, inspect `wt config state logs` and finish cleanup with native Worktrunk rather than replaying the merge pipeline.

## Project command approvals

Before an execution stage that can run project hooks or project commit guidance, WTM reads:

```sh
wt config approvals list --format=json
```

Relevant unapproved commands or stale approval records stop the operation before mutation. Review and persist approvals from a terminal in the repository:

```sh
wt config approvals add
```

Then retry `/wtm`. WTM does not write approvals, pass Worktrunk's `--yes`, or use `--no-hooks`. `/wtm ... -y` skips only that invocation's OMP confirmation and cannot bypass project command approval.

Blocking hook failures stop the Worktrunk pipeline. Completed Git operations are not rolled back after background hook failures; the notification points to `wt config state logs`.

## Paths and compatibility

Without `OMP_WORKTREE_DIR`, new worktrees use Worktrunk's configured `worktree-path`. With `OMP_WORKTREE_DIR`, they use the `<repo>-<name>` naming convention under that directory. Existing registered worktrees are reused at their current paths.

Path comparisons are realpath-based. Git porcelain is read with NUL delimiters, preserving spaces, quotes, backslashes, and trailing whitespace in worktree paths.

Worktrunk list calls disable full and summary collection. The absolute Worktrunk executable selected by the v0.76.x version gate remains fixed for the entire command.

Tested against OMP 18.1.5, Bun 1.3.14, and Worktrunk 0.76.0.
