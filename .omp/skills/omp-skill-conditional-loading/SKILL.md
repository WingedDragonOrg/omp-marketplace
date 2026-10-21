---
name: omp-skill-conditional-loading
description: "Gate oh-my-pi skills on environment (env vars, OS/arch, cwd, marker files, PATH binaries) from a plugin/extension, and probe omp internals for prompt/payload seams — use when adding SKILL.md frontmatter fields or conditionally hiding skills from the model."
---

# Conditional skill loading in oh-my-pi

Verified against omp 18.0.6 (Homebrew, compiled binary) on 2026-08-27 while building the `skill-gate` marketplace plugin.

## 1. There is no discovery seam — stop looking for one

Probe the binary before designing:

```sh
cd /opt/homebrew/Cellar/omp/<ver>/bin
strings -a omp | grep -n "customDirectories\|ignoredSkills\|emitResourcesDiscover\|before_provider_request"
strings -a omp | sed -n '<line>,<line+180>p'   # dump the surrounding function
```

Findings that hold for 18.x:

- `loadSkills()` filters only on settings (`disabledExtensions` `skill:<name>`, source toggles, `ignoredSkills`, `includeSkills`, `customDirectories`). No hook, no callback.
- The Skill object it builds keeps only `name/description/filePath/baseDir/source/containRoot/hide/_source` — **custom frontmatter keys are discarded**, so a gate must re-read `SKILL.md` from `filePath`.
- `resources_discover` returns `{skillPaths, promptPaths, themePaths}` but `emitResourcesDiscover` has **no callsites**: dead code, do not build on it.
- Extension `ctx` exposes no settings mutation and no `refreshSkills()`.

## 2. The two levers that do work

- `pi.pi.getActiveSkills()` — the host package export namespace is handed to extensions as `pi.pi`; it includes `getActiveSkills`, `setActiveSkills`, `loadSkills`, `discoverSkills`. `getActiveSkills()` returns the session's already-deduped skills **with `filePath`**, so never re-implement discovery/precedence.
- `before_provider_request` — receives the raw provider wire payload and may mutate it in place (the runner keeps object identity). Rewriting the system text there is per-request and provider-agnostic if all four shapes are handled:
  - OpenAI-compat: `payload.messages[0].role === "system"`, `content` string;
  - `role: "developer"` variant;
  - Anthropic: top-level `payload.system` as string;
  - or `payload.system` as an array of `{type:"text", text}` blocks.
- `tool_call` on `read` with `path` starting `skill://<name>` → `{ block: true, reason }` gives the model an actionable refusal.

## 3. The two prompt templates to strip

```
default:  <skills>\n<skill name="foo">\n<desc>\n</skill>\n</skills>
custom:   <skills>\n- foo: <desc, may span several lines>\n</skills>
```

For the list form, only treat `^- (name): ` as an entry start when `name` is in the known skill-name set — descriptions legitimately contain lines beginning with `- `. When every entry is removed, drop the whole block plus its preamble lines (`Matching skill → MUST read …`, `Skills are specialized knowledge…`, `If a skill applies…`).

## 4. Frontmatter schema: borrow, don't invent

`os`/`arch` from npm `package.json#os`/`cpu` (with `!negation`), `env`/`cwd`/`files`/`command` from Ansible-style `when:`, `any`/`all`/`not` from JSON Schema. Top-level keys AND together; no `when:` means always active (backward compatible). Refuse a shell/expression escape hatch: SKILL.md is data pulled from a marketplace, and evaluating it at session start turns `plugin install` into code execution.

`files:` is the only expensive predicate — `Bun.Glob().scan()` ignores `.gitignore`, short-circuits on the first hit but pays a full tree walk on a miss, which is the normal case for a gate that is off. Prefer anchored patterns.

## 5. Verification recipe (no core rebuild needed)

```sh
# extension flag MUST precede -p; otherwise it silently never loads
omp -e /abs/path/to/plugin -p "/my-command"

# capture what the model actually receives: second extension dumps the payload
# after the first mutated it (handlers run in -e order, same object)
omp -e ./plugins/skill-gate -e /tmp/sysdump.ts -p "say ok"
grep -c 'gated-name' /tmp/system.txt      # expect 0, then 1 with the env set
```

A sysdump extension writing `payload.system` + system-role messages to a file is the ground truth for prompt content; `strings` on the binary is the ground truth for seams. Both beat reading docs, which describe `resources_discover` as if it were live.

Other verified behaviors:

- Extension slash commands run **without a model turn** (~1s) and work in `-p` mode, but `ctx.ui.notify` is a no-op headless — fall back to `console.log` when `!ctx.hasUI`.
- `task` subagents run the parent process's extension handlers (two session ids fire `before_provider_request` in one run), so prompt rewriting covers them.
- Pure logic (gate parsing/evaluation, prompt stripping) is unit-testable through the `eval` tool by `await import("…/src/gate.ts")` — Bun runs the TS directly, no build step.
