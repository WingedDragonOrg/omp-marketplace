#!/usr/bin/env bash
set -euo pipefail

readonly MARKETPLACE="winged-dragon-org"
readonly REMOTE_HOST="my-mini"

run_local_upgrade() {
  printf '==> local\n'
  omp plugin marketplace update "$MARKETPLACE" &&
    omp plugin upgrade
}

run_remote_upgrade() {
  printf '==> %s\n' "$REMOTE_HOST"
  ssh "$REMOTE_HOST" \
    'omp plugin marketplace update winged-dragon-org && omp plugin upgrade'
}

status=0
if ! run_local_upgrade; then
  status=1
fi
if ! run_remote_upgrade; then
  status=1
fi
exit "$status"
