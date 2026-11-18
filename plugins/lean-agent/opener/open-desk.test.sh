#!/bin/sh
# Spec for opener/open-desk.sh: fake pgrep and claude on PATH, a throwaway HOME. Run: sh opener/open-desk.test.sh
here="$(cd "$(dirname "$0")" && pwd)"; fail=0
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
ok() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want '$3' got '$2'"; fail=1; fi; }
sh -n "$here/open-desk.sh" && echo "ok   sh -n" || { echo "FAIL sh -n"; fail=1; }
mkdir -p "$t/bin" "$t/home/lean-agent-desk"
cat >"$t/bin/claude" <<'X'
#!/bin/sh
echo "claude $* in $(pwd -P)" >>"$FAKE_CALLS"
X
cat >"$t/bin/pgrep" <<'X'
#!/bin/sh
n=$(cat "$FAKE_N" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$FAKE_N"
[ "$n" -ge "$FAKE_UP_AT" ]
X
chmod +x "$t/bin/claude" "$t/bin/pgrep"
run() { HOME="$t/home" PATH="$t/bin:$PATH" FAKE_CALLS="$t/calls" FAKE_N="$t/n" FAKE_UP_AT="$1" LEAN_OPEN_INTERVAL=0 LEAN_OPEN_SETTLE=0 LEAN_OPEN_TRIES="$2" sh "$here/open-desk.sh"; }
log="$t/home/.lean-agent/logs/opener.log"

rm -f "$t/calls" "$t/n"; run 999 3
ok "gives up after the tries, exit 0" "$?" "0"
ok "claude never run when the app is absent" "$(cat "$t/calls" 2>/dev/null)" ""
ok "timeout logged" "$(grep -c 'not running' "$log")" "1"

rm -f "$t/calls" "$t/n"; run 3 10
ok "waits for the app, then opens once" "$(wc -l <"$t/calls" | tr -d ' ')" "1"
ok "runs --desktop with no prompt in the desk folder" "$(sed 's/ in .*//' "$t/calls")" "claude --desktop"
ok "cwd is the desk" "$(sed 's/.* in //' "$t/calls" | sed 's#.*/##')" "lean-agent-desk"
ok "opened logged" "$(tail -1 "$log" | grep -c 'desk opened')" "1"

rm -rf "$t/home/lean-agent-desk"; rm -f "$t/calls" "$t/n"; run 1 3
ok "missing desk folder: no claude" "$(cat "$t/calls" 2>/dev/null)" ""
ok "missing desk logged" "$(tail -1 "$log" | grep -c 'desk folder missing')" "1"
exit $fail
