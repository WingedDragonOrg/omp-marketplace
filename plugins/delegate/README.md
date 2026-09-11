# Delegate

`delegate` adds the `/delegate <work>` command to Oh My Pi.

It runs a full background agent with the native `/tan` lifecycle while starting the child from a clean conversation context.

## Install

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install delegate@winged-dragon-org
```

Restart `omp` or start a new session after installation. Extension modules load when the session starts.

## Usage

```text
/delegate inspect the catalog and report any consistency failures
/delegate run the focused verification for the current change
```

The parent session continues immediately. The delegated agent is registered as a background job and its result remains available through the normal OMP job and Agent Hub surfaces.

## Context boundary

The delegated agent starts with an empty conversation transcript. It does not inherit the parent session's messages, tree branches, todos, or branch summaries. It does inherit the coding runtime needed to work in the same project:

- current working directory;
- active model and thinking configuration;
- system prompt and enabled tools;
- authentication and loaded provider extensions;
- LSP and MCP capabilities when available.

Because the child and parent use the same working directory, use separate Git worktrees when both agents may edit overlapping files.

`/delegate` is available in the interactive TUI and requires a persisted session with background jobs enabled.
