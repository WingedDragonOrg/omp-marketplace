---
name: omp-plugin-module-relocation-fix
description: "Fix omp-marketplace plugins failing to load with ResolveMessage: Cannot find module '@oh-my-pi/...' after an omp upgrade relocated internal deep-import paths — locate the moved module in the host packages, remap imports, bump pinned devDeps, and release via the versioned plugin cache."
---

# omp plugin module-relocation fix

Symptom: extension fails to load at omp startup with `Failed to load extension <cache path>: ResolveMessage: Cannot find module '@oh-my-pi/<pkg>/<subpath>'`. Cause: the running omp upgraded and removed/moved a deep import the plugin pinned. Plugins resolve `@oh-my-pi/*` against the **host's bundled packages at runtime**, not their devDependency pin — so a newer host breaks old deep paths even though local tests were green.

## Diagnose

1. Get the versions: `~/.bun/bin/omp --version` vs the plugin's `package.json` devDeps.
2. The installed copy is a physical, version-keyed cache: `~/.omp/plugins/node_modules/<name>` symlinks to `~/.omp/plugins/cache/plugins/<marketplace>___<name>___<version>` and has **no node_modules** of its own — diff it against the repo to confirm whether the running copy is stale.
3. Host packages live at `~/.bun/install/global/node_modules/@oh-my-pi/*`. `grep -o` the failing subpath against the host package's `exports` map in its `package.json`; if absent, `grep -rln "<Symbol>" src/` that package (and sibling `@oh-my-pi/*` packages — code moves across package boundaries).

Known relocation (omp 18.2.x): `pi-coding-agent/modes/theme/*` → `@oh-my-pi/pi-tui/theme` barrel (theme, ensureTheme, initThemeSync, getEditorTheme, getLanguageFromPath, SymbolPreset); `pi-coding-agent/cli/git-tui/diff-pane` (`DiffPane`/`DiffDocument`) → `@oh-my-pi/pi-tui/apps/git/diff-pane` (reachable via the `./*` → `src/*.ts` wildcard export).

## Fix

1. Rewrite imports to the new specifier (follow the barrel for types/importable API; the host's own `pi-coding-agent/src/index.ts` shows the canonical barrel).
2. Bump `@oh-my-pi/*` devDeps in the plugin's `package.json` to the running version, `bun install`, then `bun run typecheck` + `bun test`. `bun install` creates an untracked `bun.lock` — delete it (repo convention: no lockfiles committed).
3. Bump the plugin version in **4 places** (cache dir is version-keyed; no bump = stale copy keeps running): `plugins/<name>/package.json`, `plugins/<name>/.omp-plugin/plugin.json`, `.omp-plugin/marketplace.json`, `.claude-plugin/marketplace.json` (two mirrors must stay byte-identical; `node scripts/check-catalog.mjs` verifies, commit hook enforces).
4. Commit, push, run `./upgrade.sh` (updates local marketplace, force-reinstalls all installed plugins locally, then the same over SSH on `my-mini`).
5. Confirm the installed copy: check the new `cache/plugins/*___<newversion>` dir contains the migrated import.

## Verify resolution the way the runtime does

The omp loader (`pi-coding-agent/src/extensibility/plugins/legacy-pi-compat.ts`) rewrites specifiers matching `^@(oh-my-pi|mariozechner|earendil-works)/(pi-agent-core|pi-ai|pi-coding-agent|pi-natives|pi-tui|pi-utils)(/.*)?$` to the canonical scope and resolves them with `Bun.resolveSync(specifier, dir-inside-host-pi-coding-agent)` against the **host binary's packages** (only a few `pi-ai` subpaths get remap-table rewrites; a removed path produces the ResolveMessage). Reproduce exactly:

```bash
G=~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent
printf 'console.log(Bun.resolveSync("<new specifier>", import.meta.dir));\n' > $G/src/.tmp-resolve-check.ts
bun $G/src/.tmp-resolve-check.ts; rm $G/src/.tmp-resolve-check.ts
```

A printed path proves the specifier passes the filter and the host exports map; a throw reproduces the user's load failure for an un-fixed specifier.
