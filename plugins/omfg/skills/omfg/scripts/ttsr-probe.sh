#!/usr/bin/env bash
# ttsr-probe.sh <rule.md> <corpus.json>
#
# Runs every case in the corpus through `omp ttsr test` against one rule file in
# isolation and reports which cases behaved as intended. Exit 1 if any case fails,
# so this doubles as a regression gate after editing a condition.
#
# corpus.json:
# {
#   "cases": [
#     { "expect": "trigger", "why": "...", "text": "..." },
#     { "expect": "quiet",   "why": "...", "text": "...", "source": "tool",
#       "tool": "edit", "path": "src/a.ts" }
#   ]
# }
# Defaults: source = "text", tool = "edit" (only used when source = "tool").

set -uo pipefail

rule=${1:?usage: ttsr-probe.sh <rule.md> <corpus.json>}
corpus=${2:?usage: ttsr-probe.sh <rule.md> <corpus.json>}

pass=0
fail=0

while IFS= read -r case_json; do
  expect=$(jq -r '.expect' <<<"$case_json")
  why=$(jq -r '.why // ""' <<<"$case_json")
  source=$(jq -r '.source // "text"' <<<"$case_json")
  tool=$(jq -r '.tool // "edit"' <<<"$case_json")
  path=$(jq -r '.path // ""' <<<"$case_json")

  args=(ttsr test --rule "$rule" --file - --source "$source" --json)
  [ "$source" = "tool" ] && args+=(--tool "$tool")
  [ -n "$path" ] && args+=(--path "$path")

  result=$(jq -r '.text' <<<"$case_json" | omp "${args[@]}")
  hits=$(jq -r '.triggered | length' <<<"$result")

  if { [ "$expect" = "trigger" ] && [ "$hits" -gt 0 ]; } ||
     { [ "$expect" = "quiet" ] && [ "$hits" -eq 0 ]; }; then
    pass=$((pass + 1))
    printf 'ok   %-8s %s\n' "$expect" "$why"
  else
    fail=$((fail + 1))
    printf 'FAIL %-8s %s\n' "$expect" "$why"
    if [ "$hits" -gt 0 ]; then
      jq -r '.triggered[].matched.regex[] | "       matched: " + .' <<<"$result"
    else
      jq -r '.text | "       sample:  " + .' <<<"$case_json"
    fi
  fi
done < <(jq -c '.cases[]' "$corpus")

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
