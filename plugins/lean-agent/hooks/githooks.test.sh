#!/bin/sh
# Spec for the hook wrapper in githooks.ts: with the core.hooksPath env a thread session gets, git refuses a push from a
# repo listed as private (path, subfolder, remote URL), fails closed when the list is unreadable, allows a normal repo,
# and chains to the repo's own hooks (.git/hooks and a local core.hooksPath), passing args and exit codes through.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
root=$(cd "$root" && pwd -P)
lean="$root/.lean-agent"
mkdir -p "$lean/githooks"
# the hook is the HOOK template literal (\\ -> \, \${ -> ${)
awk '/^export const HOOK = `/{f=1;sub(/^[^`]*`/,"");print;next} f&&/^`$/{exit} f{print}' "$here/githooks.ts" | sed 's/\\\\/\\/g; s/\\\${/${/g' > "$lean/githooks/pre-push"
sh -n "$lean/githooks/pre-push"
chmod 755 "$lean/githooks/pre-push"
for n in pre-commit commit-msg post-checkout; do cp "$lean/githooks/pre-push" "$lean/githooks/$n"; done
mk() {
  git init -q --bare "$root/$1.git"
  git init -q "$root/$1"
  git -C "$root/$1" remote add origin "$root/$1.git"
  git -C "$root/$1" -c user.name=t -c user.email=t@t -c core.hooksPath=/dev/null commit -q --allow-empty -m x
}
mk secret; mk app; mk mirror
printf 'path %s\nurl %s\n' "$root/secret" "$(printf '%s' "$root/mirror.git" | tr 'A-Z' 'a-z' | sed 's:\.git$::')" > "$lean/githooks/private.list"
g() { d=$1; shift; env HOME="$root" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0="$lean/githooks" git -C "$d" -c user.name=t -c user.email=t@t "$@" 2>&1; }
push() { g "$1" push -q origin HEAD:refs/heads/feature; }
if out=$(push "$root/secret"); then echo "FAIL: private push allowed"; exit 1; fi
echo "$out" | grep -q 'private project' || { echo "FAIL: no refusal text: $out"; exit 1; }
mkdir "$root/secret/src"
if push "$root/secret/src" >/dev/null; then echo "FAIL: private subfolder push allowed"; exit 1; fi
if out=$(push "$root/mirror"); then echo "FAIL: push by private remote URL allowed"; exit 1; fi
echo "$out" | grep -q 'private project' || { echo "FAIL: no refusal for url: $out"; exit 1; }
push "$root/app" >/dev/null || { echo "FAIL: normal repo push refused"; exit 1; }
# unreadable list: pre-push fails closed, other hooks are not blocked
mv "$lean/githooks/private.list" "$lean/githooks/private.list.off"
if out=$(push "$root/app"); then echo "FAIL: push allowed without a list"; exit 1; fi
echo "$out" | grep -q 'fail closed' || { echo "FAIL: no fail-closed text: $out"; exit 1; }
g "$root/app" commit -q --allow-empty -m y >/dev/null || { echo "FAIL: commit blocked by missing list"; exit 1; }
mv "$lean/githooks/private.list.off" "$lean/githooks/private.list"
# chaining: the repo's own hook in .git/hooks still runs, gets its args, and its exit code decides
printf '#!/bin/sh\necho "ran:$1" >> "%s/log"\ncase "$(cat "$1")" in *veto*) exit 1;; esac\n' "$root" > "$root/app/.git/hooks/commit-msg"
printf '#!/bin/sh\necho ran-pre-commit >> "%s/log"\n' "$root" > "$root/app/.git/hooks/pre-commit"
chmod 755 "$root/app/.git/hooks/commit-msg" "$root/app/.git/hooks/pre-commit"
g "$root/app" commit -q --allow-empty -m fine >/dev/null || { echo "FAIL: commit refused"; exit 1; }
grep -q 'ran-pre-commit' "$root/log" && grep -q 'ran:.*COMMIT_EDITMSG' "$root/log" || { echo "FAIL: repo hooks did not run"; exit 1; }
if g "$root/app" commit -q --allow-empty -m veto >/dev/null; then echo "FAIL: repo hook exit code lost"; exit 1; fi
# chaining to a repo-local core.hooksPath (husky style, relative)
mkdir "$root/app/.husky"
printf '#!/bin/sh\necho husky-pre-push >> "%s/log"\ncat >/dev/null\n' "$root" > "$root/app/.husky/pre-push"
chmod 755 "$root/app/.husky/pre-push"
git -C "$root/app" config core.hooksPath .husky
push "$root/app" >/dev/null || { echo "FAIL: push with husky refused"; exit 1; }
grep -q husky-pre-push "$root/log" || { echo "FAIL: husky hook did not run"; exit 1; }
# the registry: only private.list is trusted. projects.json newer than the list (in ANY layout, even one line) fails closed
# with how to refresh; a list at least as new as projects.json is used.
git -C "$root/app" config --unset core.hooksPath
mk late; mk viaurl
push "$root/late" >/dev/null || { echo "FAIL: late project should push before registration"; exit 1; }
sleep 1
printf '{"late":{"path":"%s","private":true},"open":{"path":"%s","private":false}}' "$root/late" "$root/app" > "$lean/projects.json"
if out=$(push "$root/app"); then echo "FAIL: stale private.list (one-line projects.json) allowed a push"; exit 1; fi
echo "$out" | grep -q 'Open any lean-agent session' || { echo "FAIL: no refresh hint: $out"; exit 1; }
sleep 1
printf 'path %s\nurl %s\n' "$root/late" "$(printf '%s' "$root/VIAURL.git/" | tr 'A-Z' 'a-z' | sed 's:/*$::; s:\.git$::')" > "$lean/githooks/private.list"
if out=$(push "$root/late"); then echo "FAIL: fresh list ignored (private path)"; exit 1; fi
echo "$out" | grep -q 'private project' || { echo "FAIL: no refusal text for list path: $out"; exit 1; }
git -C "$root/viaurl" remote set-url origin "$root/VIAURL.git/"
if push "$root/viaurl" >/dev/null; then echo "FAIL: list url ignored"; exit 1; fi
push "$root/app" >/dev/null || { echo "FAIL: non-private project refused by fresh list"; exit 1; }
# unreadable / missing list: fail closed
mv "$lean/githooks/private.list" "$lean/githooks/private.list.off"
if push "$root/app" >/dev/null; then echo "FAIL: no list at all allowed a push"; exit 1; fi
mv "$lean/githooks/private.list.off" "$lean/githooks/private.list"
# guarded branches (0.45 test_push_guards as specs): plain pushes refused, other branches pass, own list replaces defaults,
# local destinations and the override variable skip; the repo's own pre-push hook still gets git's ref list on stdin
touch "$lean/githooks/private.list"
Z=0000000000000000000000000000000000000000
hook() { # hook <repo> <url> <remote branch>: run the pre-push hook directly with git's stdin format
  r=$1; u=$2; br=$3
  printf 'refs/heads/topic %s refs/heads/%s %s\n' "$Z" "$br" "$Z" | (cd "$r" && env HOME="$root" "$lean/githooks/pre-push" origin "$u" 2>&1)
}
R=git@github.com:o/r.git
for b in main master develop release/1.0; do
  if out=$(hook "$root/app" $R "$b"); then echo "FAIL: push to $b allowed"; exit 1; fi
  echo "$out" | grep -q 'Push your own branch and open a pull request' || { echo "FAIL: no guard text for $b: $out"; exit 1; }
done
for b in feature bugfix/b-1 maintenance; do hook "$root/app" $R "$b" >/dev/null || { echo "FAIL: push to $b refused"; exit 1; }; done
# local destinations are not checked unless LEAN_AGENT_PUSH_GUARD_LOCAL=1; the override variable skips the check
hook "$root/app" "$root/app.git" main >/dev/null || { echo "FAIL: local destination was checked"; exit 1; }
hook "$root/app" file:///srv/x.git main >/dev/null || { echo "FAIL: file:// destination was checked"; exit 1; }
if printf 'refs/heads/t %s refs/heads/main %s\n' "$Z" "$Z" | (cd "$root/app" && env HOME="$root" LEAN_AGENT_PUSH_GUARD_LOCAL=1 "$lean/githooks/pre-push" origin "$root/app.git" >/dev/null 2>&1); then echo "FAIL: LOCAL=1 ignored"; exit 1; fi
printf 'refs/heads/t %s refs/heads/main %s\n' "$Z" "$Z" | (cd "$root/app" && env HOME="$root" LEAN_AGENT_PUSH_GUARD_OVERRIDE=1 "$lean/githooks/pre-push" origin $R >/dev/null 2>&1) || { echo "FAIL: override ignored"; exit 1; }
# a project's own guards.push-deny (own/deny lines) replaces the defaults, even when empty
printf 'own %s\ndeny %s|prod-*\n' "$root/app" "$root/app" > "$lean/githooks/private.list"
hook "$root/app" $R main >/dev/null || { echo "FAIL: own list should replace the defaults"; exit 1; }
if hook "$root/app" $R prod-1 >/dev/null; then echo "FAIL: own deny glob ignored"; exit 1; fi
printf 'own %s\n' "$root/app" > "$lean/githooks/private.list"
hook "$root/app" $R main >/dev/null || { echo "FAIL: empty own list should allow main"; exit 1; }
# the repo's own pre-push hook still receives git's ref list on stdin and its exit code
mkdir -p "$root/app/.git/hooks"
printf '#!/bin/sh\ncat > "%s/stdin"\nexit 3\n' "$root" > "$root/app/.git/hooks/pre-push"
chmod 755 "$root/app/.git/hooks/pre-push"
: > "$lean/githooks/private.list"
if hook "$root/app" $R feature >/dev/null; then echo "FAIL: repo pre-push exit code lost"; exit 1; fi
grep -q 'refs/heads/feature' "$root/stdin" || { echo "FAIL: repo pre-push did not get the ref list"; exit 1; }
rm "$root/app/.git/hooks/pre-push"
# the chain honours a global core.hooksPath (and ignores lean-agent's own env override)
mkdir "$root/ghooks"
printf '#!/bin/sh\necho global-pre-commit >> "%s/log"\n' "$root" > "$root/ghooks/pre-commit"
chmod 755 "$root/ghooks/pre-commit"
rm -f "$root/app/.git/hooks/pre-commit"
git config --file "$root/.gitconfig" core.hooksPath "$root/ghooks"
: > "$root/log"
g "$root/app" commit -q --allow-empty -m g >/dev/null || { echo "FAIL: commit with global hooksPath"; exit 1; }
grep -q global-pre-commit "$root/log" || { echo "FAIL: global core.hooksPath hook did not run"; exit 1; }
git config --file "$root/.gitconfig" --unset core.hooksPath
echo "ok githooks"
