#!/bin/sh
# Login opener: wait for Claude Desktop (never launch it), then open a new session in the desk folder through the app's deep link
# (claude://code/new?folder=<percent-encoded real path>) with the system opener (`open`). `claude --desktop` refuses to run when its
# output is redirected, as it is under launchd, so it is only the last fallback (when `open` fails), and the outcome is always the
# LAST line of the log: the doctor prints it as "last opener run".
# Runs once per login (launchd RunAtLoad, no KeepAlive). Knobs for tests: LEAN_OPEN_INTERVAL, LEAN_OPEN_TRIES,
# LEAN_OPEN_SETTLE (seconds / count); LEAN_OPEN_LOG overrides the log file; LEAN_PGREP and LEAN_OPEN_CMD the pgrep and open programs.
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
opener="${LEAN_OPEN_CMD:-/usr/bin/open}"
until "$pgrep" -xq Claude || "$pgrep" -fq "/Claude.app/Contents/MacOS/Claude"; do
  i=$((i + 1))
  if [ "$i" -ge "$tries" ]; then
    echo "$(stamp) Claude Desktop not running after $((tries * interval))s: desk not opened" >>"$log"
    exit 0
  fi
  sleep "$interval"
done
sleep "${LEAN_OPEN_SETTLE:-10}" # let the app finish starting

# percent-encode a path byte by byte (encodeURIComponent's rule, minus a few marks that are encoded too: the link reads the same)
urlenc() {
  printf '%s' "$1" | LC_ALL=C od -An -v -tu1 | tr -s ' \t' '\n\n' | while read -r b; do
    [ -n "$b" ] || continue
    case "$b" in # unreserved: 0-9 (48-57) A-Z (65-90) a-z (97-122) and - . _ ~ (45 46 95 126); the rest as %XX
      45|46|95|126|4[89]|5[0-7]|6[5-9]|7[0-9]|8[0-9]|90|9[7-9]|10[0-9]|11[0-9]|12[0-2]) printf "\\$(printf '%03o' "$b")" ;;
      *) printf '%%%02X' "$b" ;;
    esac
  done
}
link="claude://code/new?folder=$(urlenc "$desk")"

out="$("$opener" "$link" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then
  echo "$(stamp) desk opened in the Claude app (deep link, exit 0)" >>"$log"
  exit 0
fi
why="$(printf '%s' "$out" | sed -n '/[^[:space:]]/{p;q;}' | cut -c1-200)"
if ! cd "$desk"; then
  echo "$(stamp) desk not opened: open exit $rc${why:+ ($why)}; the desk folder is unreachable; start a new session in ~/lean-agent-desk by hand" >>"$log"
  exit 0
fi
PATH="$PATH:$home/.local/bin:/opt/homebrew/bin:/usr/local/bin" # (after the given PATH: launchd's is minimal)
# (the CLI refuses when its output is redirected, so this probably fails under launchd too; its first line goes into the log line)
out2="$(claude --desktop 2>&1)"; rc2=$?
why2="$(printf '%s' "$out2" | sed -n '/[^[:space:]]/{p;q;}' | cut -c1-200)"
if [ "$rc2" -eq 0 ]; then
  echo "$(stamp) desk opened in the desk folder (claude --desktop, exit 0; the deep link failed: open exit $rc${why:+: $why})" >>"$log"
else
  echo "$(stamp) desk not opened: open exit $rc${why:+ ($why)}; claude --desktop exit $rc2${why2:+ ($why2)}; start a new session in ~/lean-agent-desk by hand" >>"$log"
fi
