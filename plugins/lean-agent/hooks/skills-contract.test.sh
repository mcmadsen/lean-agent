#!/bin/sh
# Spec for the behaviours the skills promise (ported from the 0.45 python tests): review-learn excludes only the
# lean-agent owner's own comments; worktree reuses an existing worktree; the review skill records through lean_review.
set -e
here=$(cd "$(dirname "$0")" && pwd)/../skills
need() { grep -q -- "$2" "$here/$1/SKILL.md" || { echo "FAIL: $1 lacks: $2"; exit 1; }; }
need review-learn 'gh api user --jq .login'
need review-learn 'Only the owner'
need review-learn 'other humans and bots'
need review-learn 'Fallback only when'
need worktree '\*\*reuse\*\*'
need worktree 'not a path to guess'
need review 'lean_review'
need review 'only the tool'
if grep -q 'Write `~/.lean-agent/<project>/reviews' "$here/review/SKILL.md"; then echo "FAIL: review skill still writes the record by hand"; exit 1; fi
echo "ok skills-contract"
