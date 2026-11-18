#!/bin/sh
# Spec for the pre-push hook in githooks.ts: with the core.hooksPath env a thread session gets, git itself refuses a
# push from a repo registered as private (by path, subfolder or remote URL) and allows a normal repo.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
root=$(cd "$root" && pwd -P)
lean="$root/.lean-agent"
mkdir -p "$lean/githooks"
# the hook is the PRE_PUSH template literal (\\ -> \)
awk '/^export const PRE_PUSH = `/{f=1;sub(/^[^`]*`/,"");print;next} f&&/^`$/{exit} f{print}' "$here/githooks.ts" | sed 's/\\\\/\\/g' > "$lean/githooks/pre-push"
sh -n "$lean/githooks/pre-push"
chmod 755 "$lean/githooks/pre-push"
mk() {
  git init -q --bare "$root/$1.git"
  git init -q "$root/$1"
  git -C "$root/$1" remote add origin "$root/$1.git"
  git -C "$root/$1" -c user.name=t -c user.email=t@t commit -q --allow-empty -m x
}
mk secret; mk app; mk mirror
printf '{"secret":{"path":"%s","private":true},"app":{"path":"%s"},"other":{"path":"/nowhere","private":true,"remote":"%s"}}' "$root/secret" "$root/app" "$root/mirror.git" > "$lean/projects.json"
push() { env HOME="$root" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0="$lean/githooks" git -C "$1" push -q origin HEAD:refs/heads/feature 2>&1; }
if out=$(push "$root/secret"); then echo "FAIL: private push allowed"; exit 1; fi
echo "$out" | grep -q 'private project' || { echo "FAIL: no refusal text: $out"; exit 1; }
mkdir "$root/secret/src"
if push "$root/secret/src" >/dev/null; then echo "FAIL: private subfolder push allowed"; exit 1; fi
if out=$(push "$root/mirror"); then echo "FAIL: push by private remote URL allowed"; exit 1; fi
echo "$out" | grep -q 'private project' || { echo "FAIL: no refusal for url: $out"; exit 1; }
push "$root/app" >/dev/null || { echo "FAIL: normal repo push refused"; exit 1; }
echo "ok githooks"
