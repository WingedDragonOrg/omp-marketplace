---
name: worktrunk-json-shape-probe
description: "Diagnose or prevent /wtm \"incompatible Worktrunk JSON\" warnings in plugins/wtm: probe the real wt v0.76.x stdout shape per command, keep the fake wt in wtm.test.ts in sync, and rebuild fixtures from real output. Use when a Worktrunk-backed operation warns after succeeding, when adding a new wt JSON consumer, or when bumping Worktrunk."
---

# Verifying Worktrunk JSON shapes against the wtm plugin

## Failure mode

A live `/wtm` notice like:

```
Warning: Removed worktree <path>; incompatible Worktrunk JSON
```

means the operation **succeeded** (worktree gone, registration pruned) but the parser rejected `wt` stdout. WTM's parsers are strict by design; the fake `wt` in `wtm.test.ts` (`installFakeWorktrunk`) can encode a shape the real CLI never prints, so the suite stays green while live runs warn. Never "fix" this by loosening the parser before dumping real output.

## Verified shapes — wt v0.76.0 (probed 2026-09-16)

| invocation | stdout shape | consumer |
|---|---|---|
| `wt remove <path> --no-delete-branch --foreground --format=json` | **array**, one record per removal: `[{kind:"worktree", branch, path, branch_outcome, branch_checked_out_at}]` | `parseWorktrunkRemove` |
| `wt switch [--create] <name> --no-cd --format=json` | object `{action, branch, path, created_branch, base_branch}` | `parseWorktrunkSwitch` |
| `wt merge <target> --stage <s> --format=json -C <path>` | object `{branch, committed, rebased, removed, squashed, target}` | `parseWorktrunkMerge` |
| `wt list --format=json --config-set list.full=false --config-set list.summary=false --config-set list.json-schema=2` | object `{schema:2, repo:{default_branch}, collected, items:[…]}` | `parseWorktrunkList` |
| `wt config approvals list --format=json` | object `{state, commands, stale}` | `parseWorktrunkApprovals` |

Only `remove` is an array. With `--no-delete-branch`, `branch_outcome` stays `not_attempted` regardless of whether the branch is merged, unmerged, or detached. `wt merge` rejects `--foreground` (remove-only flag).

## Probe recipe — scratch repo, never the user's

```sh
T=$(mktemp -d); git init -q "$T/repo"; cd "$T/repo"
git config user.email t@t; git config user.name t
echo a > a; git add a; git commit -qm init
git worktree add -q "$T/w1" -b topic1
wt remove "$T/w1" --no-delete-branch --foreground --format=json
```

Run each command from the **primary** worktree; from inside a linked worktree `wt` reports `不是 Git 仓库`. For the branch-outcome matrix, repeat with an unmerged branch and a detached worktree.

## Rules

- Dump real stdout first; copy that shape verbatim into the parser and the fixture.
- The fake must mirror reality (array for `remove`). Use the `removeRaw` harness option to inject hostile shapes (multi-record array, empty array, single object) for boundary tests.
- Keep the exactly-one-record rule for `remove`: multiple records mean the CLI behaved unexpectedly — warn on the incoherent shape, never claim clean success.
- Regression tests: pin the success path to `level === "info"` + `Removed worktree <path>`; prove the assertion fails against the pre-fix parser (run the current test file against `git show HEAD:plugins/wtm/wtm.ts` in a throwaway dir).
- On any Worktrunk version bump, re-probe all five commands: WTM gates on v0.76.x and treats everything else as unsupported.
