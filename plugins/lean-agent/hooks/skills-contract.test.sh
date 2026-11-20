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
need review-learn 'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798'
need review-learn 'never a PAT'
need review-learn 'az repos pr list --status completed --top'
need pr 'lean_review` `prs'
need worktree '\*\*reuse\*\*'
need worktree 'not a path to guess'
need worktree 'frozen-lockfile'
need worktree 'yarn install --immutable'
need worktree 'npm ci'
need worktree 'Never symlink'
need worktree 'byte-identical'
need worktree '\*\*adopt\*\*'
need worktree 'Never the EnterWorktree tool'
grep -q 'never with the EnterWorktree tool' "$root/templates/thread.md" || fail "thread.md must forbid the EnterWorktree tool"
grep -q 'edit files only with the Edit' "$root/templates/thread.md" || fail "thread.md lacks the work rules (Edit/Write only, one simple command, no cd)"
need review 'lean_review'
need review 'approve-push'
need review 'only the tool'
need review 'allow-cmd: git -C <worktree> diff <base>...<sha>, git -C <worktree> log <base>..<sha>, git -C <worktree> show <sha>, git -C <worktree> merge-base <base> <sha>'
need review 'NOT a repository'
need review 'review: second-opinion'
need scripts 'never executes'
need scripts 'LEAN-AUDIT'
need scripts 'is never `adopt`'
need scripts 'decide'
need scripts 'lean-agent-script-'
grep -q 'LEAN-AUDIT' "$root/agents/auditor.md" || fail "auditor.md does not describe the LEAN-AUDIT line"
grep -q 'allow-cmd' "$root/agents/reviewer.md" || fail "reviewer.md does not mention the allow-cmd limit"
if grep -q 'Write `~/.lean-agent/<project>/reviews' "$here/review/SKILL.md"; then echo "FAIL: review skill still writes the record by hand"; exit 1; fi
# the learn flow's promises
need learn 'legacy-0.45/index.md'
need learn 'candidate facts, not rules'
need learn 'covered_by'
need learn 'learn.maxExplorers'
need learn 'UNVERIFIED'
need learn 'CONFLICT'
need learn '`--gaps`'
need learn '`--full`'
need learn '`--verify`'
need learn 'all: true'
need learn 'Preflight, ONE explorer'
need learn 'lean-agent:reader-sonnet'
need learn 'capped file list'
need learn 'relies'
need learn '<!-- lean-agent:scripts -->'
need learn 'SCRIPT CANDIDATES'
need learn 'MECHANICAL'
grep -q 'MECHANICAL' "$root/agents/explorer.md" || fail "explorer.md does not ask for script knowledge"
need compare 'lean_compare'
need compare 'lean_doctor'
need compare 'enabledPlugins'
need compare 'never file contents'
need compare 'The desk never runs it'
grep -q 'compare' "$root/../../README.md" || fail "README has no compare section"
for a in explorer reader-haiku reader-sonnet auditor; do
  for k in refused unverified unreached; do grep -q "\"$k\"" "$root/agents/$a.md" || fail "$a.md: LEAN-FEEDBACK lacks $k"; done
done
grep -q 'Grep and Glob may not exist' "$root/agents/explorer.md" || fail "explorer.md does not say Grep/Glob may be missing"
grep -q 'STOP trying variants' "$root/agents/explorer.md" || fail "explorer.md does not say to stop on a refusal"
# the expensive-model rule (hooks/expensive.ts): only the user's press in the pane approves a model that is not haiku or sonnet. No other hooks
# module may call grantModelApproval or touch the approvals; the desk's and the thread's guides and the skills say never to choose opus
mods=$(ls "$root"/hooks/*.ts "$root"/hooks/*.tsx 2>/dev/null | grep -v '\.test\.ts')
callers=$(grep -lE 'grantModelApproval[[:space:]]*\(' $mods | while read -r f; do basename "$f"; done | sort | tr '\n' ' ')
[ "$callers" = "expensive.ts pane.tsx " ] || fail "grantModelApproval may only be called from the pane's Approve press (callers: $callers)"
writers=$(grep -l 'model\.approvals' $mods | while read -r f; do basename "$f"; done | sort | tr '\n' ' ')
[ "$writers" = "expensive.ts " ] || fail "only expensive.ts may touch the model approvals (found in: $writers)"
[ "$(grep -c 'grantModelApproval(' "$root/hooks/pane.tsx")" = "1" ] || fail "pane.tsx must call grantModelApproval from exactly one place (the Approve press)"
grep -q 'Never choose opus' "$root/templates/front-desk.md" || fail "front-desk.md must say the desk never chooses opus"
grep -q "worker-opus" "$root/templates/thread.md" && grep -q "only when the user asks" "$root/templates/thread.md" || fail "thread.md must say worker-opus is only for when the user asks"
need thread 'never choose opus'
need review 'always sonnet'
# one version: plugin.json, marketplace.json and the pane's VERSION agree (the mod compares its own VERSION with the installed plugin)
pv=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/.claude-plugin/plugin.json" | head -1)
mv=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/../../.claude-plugin/marketplace.json" | head -1)
vv=$(sed -n "s/^export const VERSION = '\([^']*\)'.*/\1/p" "$root/hooks/pane.tsx")
[ -n "$pv" ] && [ "$pv" = "$mv" ] && [ "$pv" = "$vv" ] || fail "version mismatch: plugin.json=$pv marketplace.json=$mv pane.tsx=$vv"
# roles: tools named per role, and the desk's commands (hooks/skills-roles.test.ts runs them through strict mode)
node "$root/hooks/skills-contract.mjs" || fail "skills roles (see above)"
echo "ok skills-contract"
