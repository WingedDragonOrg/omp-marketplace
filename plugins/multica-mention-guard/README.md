# multica-mention-guard

Session-stop guard for [Multica](https://multica.dev) daemon tasks. When an omp session is
running as a Multica task, the extension publishes the session's final message to the issue
verbatim and, at most once, reminds the model how to mention participants — instead of
letting the run end with a restated final or a mention of a non-existent agent.

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install multica-mention-guard@winged-dragon-org
```

Extension modules bind at session creation, so start a new session after installing.

## Activation contract

`resolveTaskContext` (`src/domain.ts`) classifies every session into one of three states:

| State | Condition | Behaviour |
|---|---|---|
| `inactive` | none of `MULTICA_TASK_ID` / `MULTICA_AGENT_ID` / `MULTICA_WORKSPACE_ID` set | no hooks registered, zero overhead |
| `invalid` | partial env, non-UUID ids, or `.multica/daemon_task_context.json` missing / malformed / `agent_id` mismatched | one advisory reminder on the first stop, then permanent pass-through |
| `active` | all three ids are UUIDs and the daemon marker agrees | full guard |

The marker is read from `<cwd>/.multica/daemon_task_context.json` and must carry
`managed_by: "multica-daemon-task"`, a UUID `agent_id` matching the environment, and a UUID
`issue_id` — the issue id comes from the marker, never from the environment.

## What the guard does

- **Publishes the final verbatim.** On `session_stop` it writes the last assistant message to
  a private temp file (`0600`, `wx`) and runs
  `multica issue comment add <issue> --parent <trigger-comment> --allow-external-file --content-file …`,
  so the text is never re-rendered through the model.
- **Threads correctly.** The parent is `trigger_comment_id` of the current run, resolved from
  `multica issue runs`; a missing or ambiguous run aborts rather than guessing.
- **Validates mentions against the live roster.** `[@Name](mention://agent/<uuid>)` targets must
  exist in `multica agent list` (non-archived, runtime-bound, never the agent itself) or
  `multica workspace member list`.
- **Reminds at most once.** Empty / oversized / mention-less / bad-target finals produce a
  single `additionalContext` continuation; the next stop is unconditionally released. The same
  one-shot rule covers uncertain delivery and pre-dispatch persistence failures.
- **Steps aside for recorded no-action.** A confirmed `multica squad activity … no_action` tool
  result (`classifyNoActionEvidence`) suppresses the guard for that stop.
- **Bounded subprocesses.** `BunCommandExecutor` enforces a 5 s timeout and a 16 MiB output cap,
  escalating SIGTERM → SIGKILL on ignored termination.

## Layout

```
src/index.ts        extension entry (omp.extensions) + DI wiring
src/domain.ts       task context, mention validation, no-action classification
src/guard.ts        stop-handling state machine (host-agnostic)
src/multica-cli.ts  multica CLI backend + bounded Bun subprocess executor
src/schema.ts       dependency-free validation of `multica --output json` payloads
test/               35 bun tests covering all four modules
docs/specs/         design spec the implementation was written against
```

## Development

```sh
bun test        # no install required: the runtime has zero dependencies
bun install     # only for `bun run typecheck` (@types/bun, typescript)
bun run typecheck
```

The runtime deliberately has **no** package dependencies: marketplace installs symlink the
cached plugin into `~/.omp/plugins/node_modules/<name>` without running an install step, so a
bare `import … from "zod"` would fail to resolve at extension load. `src/schema.ts` replaces
those schemas with hand-written parsers that keep the same accept/reject boundary.
