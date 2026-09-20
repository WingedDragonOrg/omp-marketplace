#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# Use the repository's existing installed host SDK; never install during a run.
export NODE_PATH="$PWD/plugins/annotate/node_modules"
export TZ=UTC LC_ALL=C LANG=C
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=0
export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z
export GIT_COMMITTER_DATE=2026-01-01T00:00:00Z
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
unset GIT_CONFIG_PARAMETERS GIT_TEMPLATE_DIR

command -v bun >/dev/null
command -v git >/dev/null
command -v python3 >/dev/null
if [[ ! -d "$NODE_PATH/@oh-my-pi/pi-coding-agent" ]]; then
  printf '%s\n' 'Missing local SDK: install plugins/annotate dependencies before benchmarking.' >&2
  exit 1
fi

# Bun's test-file resolver needs an ancestor node_modules for sibling plugins.
# Link the installed SDK for this invocation and remove only our own link on exit.
if [[ ! -e node_modules && ! -L node_modules ]]; then
  ln -s plugins/annotate/node_modules node_modules
  trap 'if [[ -L node_modules && "$(readlink node_modules)" == "plugins/annotate/node_modules" ]]; then rm -- node_modules; fi' EXIT
fi

# Correctness is a gate, not the performance metric. Timed work runs separately.
bun scripts/check-catalog.mjs --worktree
bun test plugins
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s plugins/model-prices/skills/model-prices/tests
bun scripts/bench/run.ts
