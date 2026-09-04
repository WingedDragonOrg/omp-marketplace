#!/usr/bin/env bash
set -euo pipefail

readonly MARKETPLACE="winged-dragon-org"
readonly REMOTE_HOST="my-mini"

list_installed_plugins() {
  omp plugin list |
    sed -nE 's/^[[:space:]]+([^[:space:]]+)[[:space:]]+\([^)]*\).*/\1/p'
}

reinstall_plugins() {
  local installed_plugins
  local plugin

  if ! installed_plugins="$(list_installed_plugins)"; then
    return 1
  fi
  while IFS= read -r plugin; do
    [[ -n "$plugin" ]] || continue
    printf '  ==> %s --force\n' "$plugin"
    if ! omp plugin install "$plugin" --force; then
      return 1
    fi
  done <<< "$installed_plugins"
}

run_upgrade() {
  if ! omp plugin marketplace update "$MARKETPLACE"; then
    return 1
  fi
  reinstall_plugins
}

run_local_upgrade() {
  printf '==> local\n'
  run_upgrade
}

run_remote_upgrade() {
  printf '==> %s\n' "$REMOTE_HOST"
  ssh "$REMOTE_HOST" \
    'export PATH="$HOME/.bun/bin:$PATH"; bash -s -- --remote' < "$0"
}

if [[ ${1:-} == --remote ]]; then
  run_upgrade
  exit
fi

status=0
if ! run_local_upgrade; then
  status=1
fi
if ! run_remote_upgrade; then
  status=1
fi
exit "$status"
