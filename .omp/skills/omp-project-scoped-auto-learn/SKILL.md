---
name: omp-project-scoped-auto-learn
description: Implement or review an OMP plugin that adds global/project scope to auto-learn and managed-skill persistence
---

# OMP project-scoped auto-learn

Use this procedure when adding `scope: "global" | "project"` behavior to OMP auto-learn through a plugin or extension.

## Current boundary

- Native managed skills are read and written only under `getManagedSkillsDir()` (normally `~/.omp/agent/managed-skills`).
- OMP auto-discovers project skills under `<repoRoot>/.omp/skills/<name>/SKILL.md`.
- `<repoRoot>/.omp/managed-skills` is not a supported native provider.
- `omp plugin install --scope project` controls plugin activation, not where native `learn` persists skills.

## Architecture

Shadow native `learn` and `manage_skill` with `pi.registerTool`, extending their schemas with an optional scope.

- `scope: "global"`: remove the wrapper-only field and delegate to the native same-name tool through `ctx.invokeTool`.
- `scope: "project"`: resolve the repository root and implement the skill operation against `<repoRoot>/.omp/skills/<name>/SKILL.md`.
- For project-scoped `learn`, delegate any memory-only portion to native `learn`; handle only the skill write locally. Do not reimplement native memory behavior.

A new uniquely named tool is lower coupling, but prompt guidance cannot guarantee auto-learn will choose it. Shadowing is the deterministic compatibility route.

## Scope policy

Make project writes explicit opt-in through a repository marker/config or an explicit tool argument. Keep global as the omission default unless the project has opted in; background learning must not silently dirty repositories.

A `before_agent_start` handler may inject concise policy explaining when to select project versus global scope, but persistence routing must remain enforced by the wrapper.

## Safe project writes

1. Resolve a real project/repository root; fail closed when unavailable.
2. Validate the skill name with a restrictive allowlist.
3. Reject absolute paths, separators, `..`, and symlink escapes.
4. Preserve native `create`, `update`, and `delete` existence semantics.
5. Write valid `SKILL.md` frontmatter with a non-empty description.
6. Use atomic file replacement.
7. Leave the repository change visible; never commit automatically.

## Reload behavior

A skill created during a model turn is not in that turn's already-built skill inventory. It becomes available in a new session or after `/reload-plugins`. Tool execution context does not expose `ctx.reload()`.

## Upgrade verification

On each OMP upgrade:

1. Diff native `learn` and `manage_skill` schemas against the wrappers.
2. Probe a global call and confirm native behavior is unchanged.
3. Probe a project call and inspect the exact repository file.
4. Start a fresh/reloaded session and confirm the project skill is advertised.
5. Test traversal, symlink escape, missing repo root, duplicate create, missing update, and missing delete.
