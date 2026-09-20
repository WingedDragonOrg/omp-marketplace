# WTM

WTM is an Oh My Pi (`omp`) extension for Git worktree lifecycle management and Worktrunk-powered local merges. It also bundles the model-readable `wtm` skill for `.config/wt.toml` configuration. Its slash command is `/wtm`; OMP's built-in `/wt` and `/worktree` commands remain available.

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
/wtm init                                      ask the agent to initialize .config/wt.toml from the bundled skill
/wtm [branch] [--base <ref>]                  create/reuse worktree and prepare /move
/wtm list                                     list this repository's worktrees
/wtm rm <branch|path> [-f] [-y]               remove one worktree; retain its branch
/wtm rm self [-f] [-y]                        remove current worktree, then prepare /move
/wtm rm --all [-f] [-y]                       remove eligible worktrees except primary/current
/wtm prune                                    prune stale Git worktree metadata
/wtm merge [target] [flags] [--source <path>] run Worktrunk's local merge pipeline
```

A missing branch defaults to `wt-<YYYYMMDDHHMM>`. New branches start from the current `HEAD` unless `--base <ref>` is supplied.

## Agent-assisted Worktrunk configuration

The plugin ships `skills/wtm/SKILL.md`, discovered by OMP as the `wtm` skill. The skill explains the distinction between user configuration (`~/.config/worktrunk/config.toml`) and the committed project file (`.config/wt.toml`), hook forms, template variables, approvals, and Node/Python/Rust examples. The agent can read it explicitly with `skill://wtm` or `/skill:wtm`.

Run `/wtm init` from a Git repository to send the agent a ready-made initialization prompt. It asks the agent to inspect the repository's real commands, preserve existing configuration, create or minimally update `.config/wt.toml`, and verify the result with read-only or dry-run Worktrunk commands. The command does not install Worktrunk, start long-running services, commit changes, or perform destructive Git operations.

### Session move handoff

WTM never changes the active OMP session directory directly. After create or reuse, it validates the live registered worktree and prepares:

```text
/move "<absolute-worktree-path>"
```

In the TUI the command is placed in the editor. Press Enter to let OMP core relocate the session and refresh project settings, providers, plugins, skills, commands, terminal title, footer, and todos. On non-TUI surfaces WTM prints the same copyable command.

For create/reuse handoffs, the target is verified when WTM creates the handoff. If it is deleted or replaced before `/move` is submitted, rerun the original `/wtm` command to generate a current handoff. `rm self` verifies the primary before deleting its source, then prepares `/move` to that primary; a cleanup-enabled merge verifies a landing worktree before the pipeline starts and prepares `/move` once Worktrunk removed the source. Paths containing a line break or NUL are retained after creation but cannot be placed into a one-line slash command.

Generated `/move` commands wrap the raw absolute path in outer double quotes and escape nothing, matching how OMP passes the `/move` argument through. `/wtm` itself accepts JSON string tokens, so `--source`, branch, and target values keep spaces, double quotes, and backslashes.

### Remove

- `-f` / `--force` allows removal of a dirty worktree.
- `-y` / `--yes` skips the confirmation for the invocation where it appears.

Worktrunk removal runs in the foreground with `--no-delete-branch`. `/wtm rm --all` excludes the primary worktree, current session worktree, bare entries, and stale registrations. A final `git worktree prune` removes stale metadata only.

`/wtm rm self` removes the current linked worktree immediately, then prepares `/move` to the live primary worktree in the same invocation. It preserves the normal dirty-worktree check, project command approval, and confirmation behavior:

- `-f` / `--force` allows removal of a dirty worktree.
- `-y` / `--yes` skips the confirmation for this invocation.

After `/move` succeeds, no second `/wtm rm` command is needed. The worktree branch remains because removal uses `--no-delete-branch`.

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

#### Conflict pre-check

Worktrunk v0.76.x has no dry-run for `wt merge`, and a conflicting rebase stops with the rebase left open in the source worktree. Before Worktrunk starts, WTM replays the conflict-relevant steps with `git merge-tree`:

- the squashed change for the default pipeline;
- every replayed commit for `--no-squash` and `--no-commit`, including uncommitted changes committed by `--stage all|tracked|none`;
- the merge commit for `--no-rebase --no-ff`;
- nothing for `--no-rebase` without `--no-ff`, because a fast-forward cannot conflict.

Worktrunk reports `Already up to date` — and merges without replaying anything — only while the measurement base is an ancestor of the source with no merge commit in between, so a source that merged the target or a side branch still replays its commits and the pre-check follows that. The measurement base is the target branch, or its fetched upstream when the target lags that upstream and the source is based on it. A target that kept its own commits while its upstream gained others cannot fast-forward, so a source based on that upstream is refused before Worktrunk starts, matching Worktrunk's own refusal.

The replay runs in a sandboxed object store (`GIT_OBJECT_DIRECTORY` plus a private copy of the index, so staged content takes part without the real index being written), leaving refs, index, worktree, and object database untouched. A predicted conflict stops with the conflicting files named, and Worktrunk is not started. States the pre-check cannot verify — a missing merge base, `--no-commit` with a dirty source, or a Git older than 2.38 — stop before Worktrunk and report the reason. `wt merge <target>` remains available to run the pipeline without the pre-check.

#### One-invocation merge

A cleanup-enabled merge runs the whole Worktrunk pipeline from the source worktree and lets Worktrunk remove the source worktree and branch. It finishes by preparing `/move` to a live landing worktree, so the session leaves the deleted directory without a second `/wtm` invocation:

1. WTM picks a landing worktree: the live target worktree, otherwise Worktrunk's primary, otherwise the main worktree from Git's worktree list. No usable landing stops the command before Worktrunk starts, as does a landing path that cannot be represented as one `/move` command.
2. Approvals, the conflict pre-check, and the confirmation summary run before Worktrunk starts.
3. Worktrunk performs commit, squash, rebase, validation, merge, and cleanup.
4. WTM reconciles the target ref, source worktree registration, source branch, and source path from the landing worktree, so reconciliation never runs in the deleted source.
5. When the source worktree is gone, or Worktrunk reports `removed=true`, WTM prepares `/move "<landing-path>"`.

`--no-remove`, a primary source, or a source branch equal to the target keep the session where it is. An explicit `--source` can name any live branch worktree of the same repository, including the one the session occupies.

After every merge attempt, WTM reconciles the target ref, source worktree registration, source branch, and source path. A failed or incompatible Worktrunk result never triggers native Git mutation. Resolve or abort an active rebase, merge, cherry-pick, or revert before retrying.

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
