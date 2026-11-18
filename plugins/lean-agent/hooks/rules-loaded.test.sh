#!/bin/sh
# Spec for rules-loaded.sh: logs lean-agent rule loads only, one JSON line each, under $HOME/.lean-agent/logs.
set -e
here=$(cd "$(dirname "$0")" && pwd)
sh -n "$here/rules-loaded.sh"
h=$(mktemp -d)
trap 'rm -rf "$h"' EXIT
printf '%s' '{"file_path":"/r/.claude/rules/lean-agent/billing.md","load_reason":"path_glob_match","trigger_file_path":"/r/services/billing/a.ts"}' | HOME="$h" sh "$here/rules-loaded.sh"
printf '%s' '{"file_path":"/r/.claude/rules/mine.md","load_reason":"session_start"}' | HOME="$h" sh "$here/rules-loaded.sh"
log="$h/.lean-agent/logs/rules-loaded.jsonl"
[ "$(wc -l < "$log")" -eq 1 ] || { echo "FAIL: expected one logged line"; exit 1; }
grep -q '"e":{"file_path":"/r/.claude/rules/lean-agent/billing.md"' "$log" || { echo "FAIL: event not embedded"; exit 1; }
grep -q '^{"ts":[0-9]*,' "$log" || { echo "FAIL: no timestamp"; exit 1; }
echo "ok rules-loaded"
