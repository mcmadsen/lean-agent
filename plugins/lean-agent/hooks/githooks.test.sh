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
echo "ok githooks"
