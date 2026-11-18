#!/bin/sh
# Spec for the behaviours the skills promise (ported from the 0.45 python tests): review-learn excludes only the
# lean-agent owner's own comments; worktree reuses an existing worktree; the review skill records through lean_review.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
here=$root/skills
fail() { echo "FAIL: $*"; exit 1; }
# structure: every skill/agent/command has frontmatter with a name (= its folder/file) and a description
field() { awk -v k="$2" 'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} index($0,k":")==1{sub(k": *","");print;exit}' "$1"; }
for d in "$here"/*/; do
  n=$(basename "$d"); f=$d/SKILL.md
  [ -f "$f" ] || fail "skill $n has no SKILL.md"
  [ "$(field "$f" name)" = "$n" ] || fail "skill $n: frontmatter name must equal the folder"
  [ -n "$(field "$f" description)" ] || fail "skill $n: no description"
done
for f in "$root"/agents/*.md; do
  n=$(basename "$f" .md)
  [ "$(field "$f" name)" = "$n" ] || fail "agent $n: frontmatter name must equal the file name"
  [ -n "$(field "$f" description)" ] || fail "agent $n: no description"
done
for f in "$root"/commands/*.md; do [ -n "$(field "$f" description)" ] || fail "command $(basename "$f"): no description"; done
# every lean_* tool a skill, agent or command relies on is defined by the mod
for t in $(grep -rhoE '(^|[^a-z_])lean_[a-z_]+' "$here" "$root/agents" "$root/commands" | sed 's/^[^l]*//' | sort -u); do
  grep -qE "['\"]$t['\"]" $(ls "$root"/hooks/*.ts "$root"/hooks/*.tsx 2>/dev/null | grep -v '\.test\.ts') 2>/dev/null || fail "tool $t is used in a skill/agent/command but defined nowhere in hooks/"
done
need() { [ -f "$here/$1/SKILL.md" ] || fail "no skill $1";  grep -q -- "$2" "$here/$1/SKILL.md" || { echo "FAIL: $1 lacks: $2"; exit 1; }; }
need review-learn 'gh api user --jq .login'
need review-learn 'Only the owner'
need review-learn 'other humans and bots'
need review-learn 'Fallback only when'
need worktree '\*\*reuse\*\*'
need worktree 'not a path to guess'
need review 'lean_review'
need review 'only the tool'
need review 'allow-cmd: git diff <base>...<sha>, git log <base>..<sha>, git show <sha>, git merge-base <base> <sha>'
grep -q 'allow-cmd' "$root/agents/reviewer.md" || fail "reviewer.md does not mention the allow-cmd limit"
if grep -q 'Write `~/.lean-agent/<project>/reviews' "$here/review/SKILL.md"; then echo "FAIL: review skill still writes the record by hand"; exit 1; fi
# roles: tools named per role, and the desk's commands (hooks/skills-roles.test.ts runs them through strict mode)
node "$root/hooks/skills-contract.mjs" || fail "skills roles (see above)"
echo "ok skills-contract"
