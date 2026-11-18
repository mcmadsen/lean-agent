#!/bin/sh
# Login opener: wait for Claude Desktop (never launch it), then open the desk folder with `claude --desktop`.
# Runs once per login (launchd RunAtLoad, no KeepAlive). Knobs for tests: LEAN_OPEN_INTERVAL, LEAN_OPEN_TRIES,
# LEAN_OPEN_SETTLE (seconds / count); LEAN_OPEN_LOG overrides the log file.
home="${HOME:?}"
log="${LEAN_OPEN_LOG:-$home/.lean-agent/logs/opener.log}"
mkdir -p "$(dirname "$log")" 2>/dev/null
stamp() { date '+%Y-%m-%d %H:%M:%S'; }
if ! desk="$(cd "$home/lean-agent-desk" 2>/dev/null && pwd -P)"; then
  echo "$(stamp) desk folder missing: run the doctor skill (doctor --fix)" >>"$log"
  exit 0
fi
interval="${LEAN_OPEN_INTERVAL:-5}"; tries="${LEAN_OPEN_TRIES:-120}"; i=0
pgrep="${LEAN_PGREP:-/usr/bin/pgrep}" # launchd has a minimal PATH
until "$pgrep" -xq Claude || "$pgrep" -fq "/Claude.app/Contents/MacOS/Claude"; do
  i=$((i + 1))
  if [ "$i" -ge "$tries" ]; then
    echo "$(stamp) Claude Desktop not running after $((tries * interval))s: desk not opened" >>"$log"
    exit 0
  fi
  sleep "$interval"
done
sleep "${LEAN_OPEN_SETTLE:-10}" # let the app finish starting
cd "$desk" || exit 0
PATH="$home/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
claude --desktop >>"$log" 2>&1
echo "$(stamp) desk opened in the desk folder (exit $?)" >>"$log"
