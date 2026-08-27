# skill-gate

Conditional skill activation for oh-my-pi. Adds a `when:` block to `SKILL.md`
frontmatter so a skill is only advertised to the model when its environment
matches — a set env var, a platform, a working directory, a marker file, a
binary on `PATH`.

```yaml
---
name: prod-deploy
description: Deploy the service to the production cluster.
when:
  env:
    KUBECONFIG: true
    AWS_PROFILE: "/^prod-/"
  command: [kubectl, helm]
  os: [darwin, linux]
---
```

Without `KUBECONFIG`, that skill never reaches the system prompt and
`read skill://prod-deploy` is refused with the failing condition as the reason.

## Install

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install skill-gate@winged-dragon-org
```

Extension modules bind at session creation — start a new session after installing.

## The `when:` vocabulary

Field names are borrowed from existing manifests rather than invented, so the
schema is already familiar:

| Key | Source of the convention | Meaning |
|---|---|---|
| `os` | npm `package.json#os` | `process.platform` allowlist; `!win32` blocks |
| `arch` | npm `package.json#cpu` | `process.arch` allowlist; `!x64` blocks |
| `env` | Ansible `when:` | var must be set / unset / equal / match a regex |
| `cwd` | editorconfig-style globs | session cwd must match; `~` expands, `!` negates |
| `files` | GitHub Actions `paths:` | at least one file under cwd matches the glob |
| `command` | `command -v` checks | executable must resolve on `PATH` |
| `any` / `all` / `not` | JSON Schema `anyOf`/`allOf`/`not` | boolean combinators |

Top-level keys are **AND**-ed. A skill with no `when:` block is always active,
so existing skills are unaffected. `requires:` is accepted as an alias.

```yaml
when:
  env:
    CI: false                 # must be unset or empty
    NODE_ENV: production      # exact match
    AWS_PROFILE: "/^prod-/"   # /regex/flags
  cwd: ["~/work/**", "!**/vendor/**"]
  files: ["**/*.tf"]
  any:                        # at least one branch must pass
    - command: [terraform]
    - command: [tofu]
  not:
    env:
      SKILL_SAFE_MODE: true
```

`env: [FOO, BAR]` is shorthand for "both must be set".

There is deliberately **no shell or expression escape hatch**. A `SKILL.md` is
data fetched from a marketplace; evaluating shell from its frontmatter at
session start would turn `plugin install` into code execution. If you need
richer logic, express it as an env var that your shell profile computes.

## What it does at runtime

| Event | Action |
|---|---|
| `session_start` | reads `getActiveSkills()`, parses each `SKILL.md` frontmatter, evaluates gates |
| `before_provider_request` | removes blocked entries from the `<skills>` block of the outgoing system prompt; drops the block entirely when nothing is left |
| `tool_call` (`read`) | blocks `skill://<blocked>` with the failing condition as the reason |
| `/skill-gate [refresh]` | prints every gated skill with `on`/`off` and why |

Gates are evaluated against the live session `cwd` and re-evaluated when the
session moves (`/move`, `/wt`). Parsed frontmatter is cached per file mtime.

```
$ omp -p "/skill-gate"
skill-gate (cwd /srv/infra, 82 skills scanned)
off  prod-deploy — env AWS_PROFILE=<unset> does not match /^prod-/
on   tf-runbook — conditions met
```

## Limits

- **The skill is still discovered.** oh-my-pi loads it into the session either
  way; what a gate removes is its listing in the `<skills>` block of the system
  prompt sent to the model, so the model never learns the skill exists and
  cannot decide to use it. `read skill://<name>` is refused on top of that.
  `/skill:<name>` still works — an explicit user invocation is not gated.
- `task` subagents are covered: their sessions run the same in-process
  extension handlers, so a gated skill is stripped from the subagent prompt too
  (verified with a `sonic` subagent on a second provider).
- **`files:` is the one expensive condition.** It answers "does any file under
  cwd match this glob?" by walking the tree with `Bun.Glob().scan()`, which
  ignores `.gitignore` and therefore also descends into `node_modules`,
  `target/`, `.venv` and friends. A match short-circuits on the first hit, but a
  *miss* costs a full traversal — and a miss is the normal case for a gate that
  is off. Anchor the pattern so the walk stays shallow (`"*.tf"`,
  `"infra/*.tf"`, `"packages/*/Cargo.toml"`) instead of `"**/*.tf"`, or express
  the condition as `command:`/`env:`, which are O(1).
- Invalid `when:` blocks are reported through the extension logger and treated
  as "no gate" — a typo never silently hides a skill.

## Bundled demo

`skills/skill-gate-demo/SKILL.md` is gated on `SKILL_GATE_DEMO`. Compare:

```sh
omp -p "/skill-gate"
SKILL_GATE_DEMO=1 omp -p "/skill-gate"
```
