# winged-dragon-org

Oh My Pi (`omp`) plugin marketplace for [WingedDragonOrg](https://github.com/WingedDragonOrg).
Also readable by Claude Code (`.claude-plugin/marketplace.json` mirror).

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin discover winged-dragon-org
omp plugin install wt@winged-dragon-org
```

## Plugins

| Plugin | Surface | Description |
|---|---|---|
| `wt` | extension | `/wt` — create, list, remove, prune git worktrees under `~/.omp/wt` and move the session into one |
| `skill-gate` | extension + skill | `when:` frontmatter gates a skill on env vars, os/arch, cwd, marker files or PATH binaries; `/skill-gate` explains each decision |
| `spec` | skill | `spec-design` — design interview that converges an idea into an implementable spec in `docs/specs/`, one product-level decision at a time |
| `multica-mention-guard` | extension | Publishes a Multica task's final message verbatim and gates `session_stop` on valid `mention://` targets, reminding once |

## Layout

```
.omp-plugin/marketplace.json     catalog (omp reads this first)
.claude-plugin/marketplace.json  same catalog, for Claude Code
plugins/<name>/                  one directory per plugin
```

`metadata.pluginRoot: "plugins"` is prepended to every relative plugin `source`,
so catalog entries carry `"source": "./<name>"`.

## Adding a plugin

1. Create `plugins/<name>/` containing any of:

   | Path | Surface | Visible as |
   |---|---|---|
   | `skills/<skill>/SKILL.md` | skill | skill name |
   | `commands/<cmd>.md` | slash command | `/<plugin>:<cmd>` — marketplace commands are namespaced |
   | `agents/<agent>.md` | subagent | agent name for the `task` tool |
   | `hooks/pre/`, `hooks/post/` | hooks | — |
   | `package.json` with `omp.extensions` | extension module | tools, commands, event handlers |
   | `.mcp.json` | MCP servers | — |
   | `.omp-plugin/plugin.json` | manifest | version, description, path remaps |

2. Append an entry to both catalog files' `plugins[]`:

   ```json
   { "name": "<name>", "description": "…", "source": "./<name>", "version": "1.0.0" }
   ```

3. Push. Users pull the new catalog with `omp plugin marketplace update winged-dragon-org`.

Naming: lowercase letters, digits, `-` and `.`; must start and end alphanumeric; ≤64 chars.

## Versioning

`omp plugin upgrade` only reinstalls entries whose **catalog** `version` changed
(semver must be newer; non-semver just has to differ). Bump the catalog entry on
every plugin change, otherwise installed copies stay stale.

## Repo checks

Renaming a plugin touches four places — directory name, catalog `name`, catalog `source`,
and the `name`/`version` inside `package.json` + `.omp-plugin/plugin.json`. Miss one and
the break only shows up when someone else installs.

`scripts/check-catalog.mjs` is the single check, enforced in two layers:

| Layer | Mechanism | Covers |
|---|---|---|
| CI | `.github/workflows/catalog.yml` on push + PR | everyone, always — the authoritative gate |
| pre-commit | `.githooks/pre-commit` | fails locally before a bad commit exists |

Git cannot ship hooks through a clone — `core.hooksPath` is local config by design, so
cloning never arms code execution. Enable the hook once per clone:

```sh
git config core.hooksPath .githooks
```

The check validates **staged** content, not the working tree — a `git mv` stages the
pre-rename blobs while the working tree already looks fixed:

- both catalogs parse; the `.claude-plugin` mirror is byte-identical to `.omp-plugin`
- marketplace/plugin ids obey the naming rules; no duplicate plugin names
- every relative `source` resolves to a directory that has files in the commit
- directory name, catalog `name`, `package.json` `name`, `plugin.json` `name` all agree
- catalog `version` matches both manifests' `version`
- every `omp.extensions` entry point exists in the commit
- no plugin directory is missing a catalog entry

Run it by hand any time:

```sh
node scripts/check-catalog.mjs             # staged content (CI uses --worktree)
node scripts/check-catalog.mjs --worktree  # working tree
```

## Verifying an install

```sh
omp plugin list                      # install registry
ls ~/.omp/plugins/node_modules       # extension symlinks
omp -p --no-session "/<plugin>:<cmd>"                        # markdown commands
omp -p --no-session --skills "<skill>" "List your skills."    # skills
```

Skills are only injected when the `read` tool exists — a `--no-tools` probe reports an
empty skill inventory and proves nothing.

Skills, commands and agents refresh with `/reload-plugins`; extension modules require a
new session.
