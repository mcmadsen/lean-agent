#!/bin/sh
# InstructionsLoaded command hook: log loads of lean-agent rules (stdin: the event JSON) for `stats` and `learn --trim`.
in=$(cat | tr -d '\n')
case "$in" in */rules/lean-agent/*) ;; *) exit 0 ;; esac
d="${HOME}/.lean-agent/logs"
mkdir -p "$d" || exit 0
printf '{"ts":%s,"e":%s}\n' "$(date +%s)" "$in" >> "$d/rules-loaded.jsonl"
