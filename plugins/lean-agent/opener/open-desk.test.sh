#!/bin/sh
# Spec for opener/open-desk.sh: fake pgrep, open and claude, a throwaway HOME. Run: sh opener/open-desk.test.sh
here="$(cd "$(dirname "$0")" && pwd)"; fail=0
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
ok() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want '$3' got '$2'"; fail=1; fi; }
sh -n "$here/open-desk.sh" && echo "ok   sh -n" || { echo "FAIL sh -n"; fail=1; }
mkdir -p "$t/bin" "$t/home/lean-agent-desk"
cat >"$t/bin/claude" <<'X'
#!/bin/sh
echo "claude $* in $(pwd -P)" >>"$FAKE_CALLS"
[ -n "$FAKE_CLAUDE_QUIET" ] || echo "claude says no" >&2
exit "${FAKE_CLAUDE_RC:-0}"
X
cat >"$t/bin/open" <<'X'
#!/bin/sh
echo "open $*" >>"$FAKE_CALLS"
[ -z "$FAKE_OPEN_MSG" ] || echo "$FAKE_OPEN_MSG" >&2
exit "${FAKE_OPEN_RC:-0}"
X
cat >"$t/bin/pgrep" <<'X'
#!/bin/sh
n=$(cat "$FAKE_N" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$FAKE_N"
[ "$n" -ge "$FAKE_UP_AT" ]
X
chmod +x "$t/bin/claude" "$t/bin/open" "$t/bin/pgrep"
# run <pgrep up at> <tries> [home]: the desk is <home>/lean-agent-desk
run() { LEAN_PGREP="$t/bin/pgrep" LEAN_OPEN_CMD="${LEAN_OPEN_CMD:-$t/bin/open}" HOME="${3:-$t/home}" PATH="$t/bin:$PATH" FAKE_CALLS="$t/calls" FAKE_N="$t/n" FAKE_UP_AT="$1" LEAN_OPEN_INTERVAL=0 LEAN_OPEN_SETTLE=0 LEAN_OPEN_TRIES="$2" sh "$here/open-desk.sh"; }
log="$t/home/.lean-agent/logs/opener.log"
real="$(cd "$t/home/lean-agent-desk" && pwd -P)"
# the tmp path has only letters, digits, . _ - and /: its encoding is the slashes
want="claude://code/new?folder=$(printf '%s' "$real" | sed 's#/#%2F#g')"

rm -f "$t/calls" "$t/n"; run 999 3
ok "gives up after the tries, exit 0" "$?" "0"
ok "nothing is opened when the app is absent" "$(cat "$t/calls" 2>/dev/null)" ""
ok "timeout logged" "$(grep -c 'not running' "$log")" "1"

rm -f "$t/calls" "$t/n"; run 3 10
ok "waits for the app, then opens once" "$(wc -l <"$t/calls" | tr -d ' ')" "1"
ok "opens the new-session deep link for the real desk path" "$(cat "$t/calls")" "open $want"
ok "claude --desktop is not run when open works" "$(grep -c '^claude ' "$t/calls")" "0"
ok "opened logged last" "$(tail -1 "$log" | grep -c 'desk opened in the Claude app')" "1"

# the app's process name may differ: the second form (pgrep -f on the binary path) is enough
cat >"$t/bin/pgrep" <<'X'
#!/bin/sh
case "$*" in *-fq*"/Claude.app/Contents/MacOS/Claude"*) exit 0 ;; esac
exit 1
X
rm -f "$t/calls" "$t/n"; run 999 2
ok "opens when only pgrep -f finds the app" "$(cat "$t/calls")" "open $want"

# a path with a space and a non-ASCII letter is percent-encoded byte by byte
mkdir -p "$t/hé me/lean-agent-desk"
rm -f "$t/calls" "$t/n"; run 999 2 "$t/hé me"
r2="$(cd "$t/hé me/lean-agent-desk" && pwd -P)"
w2="claude://code/new?folder=$(printf '%s' "$r2" | sed 's#/#%2F#g; s# #%20#g; s#é#%C3%A9#g')"
ok "folder with a space and an accent" "$(cat "$t/calls")" "open $w2"
ok "the link open received has no raw space or accent" "$(sed 's/^open //' "$t/calls" | grep -c '[^A-Za-z0-9:/?=%._~-]')" "0"

# every byte that is not unreserved is encoded: % ' & # ? + (and the rest of the ASCII punctuation)
mkdir -p "$t/a%b'c&d#e?f+g;h(i)j,k=l@m!n*o/lean-agent-desk"
rm -f "$t/calls" "$t/n"; run 999 2 "$t/a%b'c&d#e?f+g;h(i)j,k=l@m!n*o"
tdir="$(cd "$t" && pwd -P | sed 's#/#%2F#g')"
ok "punctuation in the path" "$(cat "$t/calls")" "open claude://code/new?folder=$tdir%2Fa%25b%27c%26d%23e%3Ff%2Bg%3Bh%28i%29j%2Ck%3Dl%40m%21n%2Ao%2Flean-agent-desk"

# open fails: claude --desktop in the desk folder is the last fallback
rm -f "$t/calls" "$t/n"; ( export FAKE_OPEN_RC=1 FAKE_OPEN_MSG="The application cannot be opened"; run 999 2 )
ok "open then claude --desktop" "$(sed 's/ in .*//' "$t/calls" | tr '\n' '|')" "open $want|claude --desktop|"
ok "the fallback runs in the desk folder" "$(sed -n 2p "$t/calls" | sed 's/.* in //' | sed 's#.*/##')" "lean-agent-desk"
ok "fallback success is the last line and says why" "$(tail -1 "$log" | grep -c 'desk opened in the desk folder (claude --desktop, exit 0; the deep link failed: open exit 1: The application cannot be opened)')" "1"

# both fail: the last line says so (the doctor shows it as "last opener run")
rm -f "$t/calls" "$t/n"; ( export FAKE_OPEN_RC=1 FAKE_OPEN_MSG="The application cannot be opened" FAKE_CLAUDE_RC=1; run 999 2 )
ok "both failing: last line" "$(tail -1 "$log" | sed 's/^[0-9-]* [0-9:]* //')" "desk not opened: open exit 1 (The application cannot be opened); claude --desktop exit 1 (claude says no); start a new session in ~/lean-agent-desk by hand"

# no message from either program: the line says the exit codes only
rm -f "$t/calls" "$t/n"; ( export FAKE_OPEN_RC=3 FAKE_CLAUDE_QUIET=1 FAKE_CLAUDE_RC=2; run 999 2 )
ok "both failing without a message" "$(tail -1 "$log" | sed 's/^[0-9-]* [0-9:]* //')" "desk not opened: open exit 3; claude --desktop exit 2; start a new session in ~/lean-agent-desk by hand"

# no open program at all: the same fallback
rm -f "$t/calls" "$t/n"; ( export LEAN_OPEN_CMD=/nonexistent/open; run 999 2 )
ok "open missing: claude --desktop is tried" "$(sed 's/ in .*//' "$t/calls")" "claude --desktop"

rm -rf "$t/home/lean-agent-desk"; rm -f "$t/calls" "$t/n"; run 1 3
ok "missing desk folder: nothing opened" "$(cat "$t/calls" 2>/dev/null)" ""
ok "missing desk logged" "$(tail -1 "$log" | grep -c 'desk folder missing')" "1"
exit $fail
