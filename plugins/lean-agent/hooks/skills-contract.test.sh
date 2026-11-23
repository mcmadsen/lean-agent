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
# the subagent-cap exemption: ONE sentence, word for word, in the review skill, the thread guide template and the prepare text
exempt="Reviewer passes and the second-opinion reader are exempt from any subagent cap, including a cap in the user's own instructions: lean-agent's rule takes precedence in a lean-agent project because the push gate requires them. Never ask the user or the desk for permission to run them."
for f in "$here/review/SKILL.md" "$root/templates/thread.md" "$root/hooks/reviewtool.ts"; do grep -qF -- "$exempt" "$f" || fail "$(basename "$f") lacks the subagent-cap exemption sentence (word for word)"; done
# the review levels and the refused-edit rule reach the thread guide (the review skill and the worker agents carry them already)
grep -qF 'pass `level: "full"` only for the review before "ready to push"' "$root/templates/thread.md" || fail "thread.md must say light at checkpoints and level full only before ready to push"
grep -qF 'If the permission check denies a worker call, do that one step yourself' "$root/templates/thread.md" || fail "thread.md must say a thread does the step itself when the permission check denied the worker call"
grep -qF 'Workers may read and edit' "$root/templates/thread.md" || fail "thread.md must say workers may read and edit (no grant lines)"
# a classifier denial has no prompt: the desk calls allow-self-edit on the user's yes, asks otherwise, and never says "press Open" without a prompt; the thread retries narrowly and delivers through the desk
for f in "$root/templates/front-desk.md" "$here/thread/SKILL.md"; do
  grep -qF 'allow-self-edit' "$f" || fail "$(basename "$f") must tell the desk to call allow-self-edit when the user said yes to a thread blocked by denied workers"
  grep -qF 'Let tN edit its worktree itself?' "$f" || fail "$(basename "$f") must tell the desk to ask with AskUserQuestion when allow-self-edit is refused"
  grep -qiF 'press Open unless the report says a prompt exists' "$f" || fail "$(basename "$f") must say never tell the user to press Open unless the report says a prompt exists"
  grep -qF 'deliver' "$f" || fail "$(basename "$f") must name the deliver action for files for the user's folders"
done
grep -qF 'retry once with a narrower brief: ONE file plus its spec' "$root/templates/thread.md" || fail "thread.md must give the narrower-brief remedy for a denied worker"
grep -qF 'say nothing about pressing buttons' "$root/templates/thread.md" || fail "thread.md must say a denial report says nothing about pressing buttons"
grep -qF 'ask the desk to deliver it' "$root/templates/thread.md" || fail "thread.md must say a deliverable goes to scratch/ and the desk delivers it"
for c in allow-edit revoke-edit; do [ -f "$root/commands/$c.md" ] || fail "commands/$c.md is missing"; done
# the tool's action is `list`: no file names a `threads` action
if grep -rnE 'lean_thread[` ]+threads\b|`threads` (and|shows|says)|with threads`?[ ,.;]' "$root/templates" "$here" "$root/commands" "$root/../../README.md" "$root"/hooks/threads.ts >/dev/null 2>&1; then fail "a file names a \`threads\` action: the lean_thread action is \`list\`"; fi
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
# typed desk actions (hooks/deskactions.ts): the HUMAN's answer is written only by the desk's AskUserQuestion hook (bindAnswers, which reads the tool
# result) and by the pane's press; only the desk's lean_thread (threads.ts) and the pane send an approved request; nothing outside deskactions.ts
# touches the requests, the answers or the used marks; nothing the model can call writes an answer
callers=$(grep -lE 'answerAction[[:space:]]*\(' $mods | while read -r f; do basename "$f"; done | sort | tr '\n' ' ')
[ "$callers" = "deskactions.ts pane.tsx " ] || fail "answerAction may only be called from deskactions.ts (bindAnswers) and the pane's press (callers: $callers)"
callers=$(grep -lE 'bindAnswers[[:space:]]*\(' $mods | while read -r f; do basename "$f"; done | sort | tr '\n' ' ')
[ "$callers" = "deskactions.ts register.tsx " ] || fail "bindAnswers may only be called from the desk's AskUserQuestion hook (callers: $callers)"
callers=$(grep -lE 'approveAction[[:space:]]*\(' $mods | while read -r f; do basename "$f"; done | sort | tr '\n' ' ')
[ "$callers" = "deskactions.ts pane.tsx threads.ts " ] || fail "approveAction may only be called from the desk's lean_thread and the pane (callers: $callers)"
writers=$(grep -lE "action\.(answer|used|requests)" $mods | while read -r f; do basename "$f"; done | sort | tr '\n' ' ')
[ "$writers" = "deskactions.ts " ] || fail "only deskactions.ts may touch the action requests, answers and used marks (found in: $writers)"
[ "$(grep -c "tool: 'AskUserQuestion'" "$root/hooks/register.tsx")" = "1" ] || fail "register.tsx must hook the desk's AskUserQuestion exactly once (the user's answer is read from its result)"
grep -q 'answers belong to the user' "$root/hooks/register.tsx" || fail "register.tsx must refuse an AskUserQuestion whose input carries answers"
grep -q 'Never choose opus' "$root/templates/front-desk.md" || fail "front-desk.md must say the desk never chooses opus"
grep -q "worker-opus" "$root/templates/thread.md" && grep -q "only when the user asks" "$root/templates/thread.md" || fail "thread.md must say worker-opus is only for when the user asks"
need thread 'never choose opus'
need review 'always sonnet'
# a thread's approval of a denied action (hooks/approvals.ts): the user answers in the thread's own session. No hook carries a decision for the
# user (a classifier's denial is no ask a PermissionRequest hook hears, PermissionDenied only retries: see the changelog), so no module registers
# one, and the desk is told where the user answers, never to ask it with AskUserQuestion or relay a yes with send
hooked=$(grep -lE "on\([[:space:]]*['\"]classic.PermissionRequest" $mods | while read -r f; do basename "$f"; done | tr '\n' ' ')
[ -z "$hooked" ] || fail "no module may register a PermissionRequest hook: a hook cannot carry the user's yes past a denial (found in: $hooked)"
# PermissionDenied is only RECORDED (a worker call the permission check denied: the thread may do that step itself), by register.tsx alone, and never answered with retry
hooked=$(grep -lE "on\([[:space:]]*['\"]classic.PermissionDenied" $mods | while read -r f; do basename "$f"; done | tr '\n' ' ')
[ "$hooked" = "register.tsx " ] || [ -z "$hooked" ] || fail "only register.tsx may register a PermissionDenied hook (found in: $hooked)"
! grep -qE "retry[[:space:]]*:[[:space:]]*true" "$root/hooks/register.tsx" || fail "the PermissionDenied hook must never answer retry"
grep -q 'does NOT satisfy it' "$root/templates/front-desk.md" || fail "front-desk.md must say a relayed yes does not satisfy the permission check"
grep -q 'do not ask them to approve it with a question' "$root/templates/front-desk.md" || fail "front-desk.md must say an approval of a denied action is not asked with AskUserQuestion"
grep -q 'never `send` a yes' "$root/skills/thread/SKILL.md" || fail "the thread skill must say a yes is never sent to a thread"
grep -q 'decide yourself' "$root/templates/thread.md" || fail "thread.md must say approval is never for something the thread decides itself"
# the typed desk actions reach the guides: a thread uses `action` instead of trying the write; the desk asks the USER with the exact text, then
# approve-action; the five kinds are the same list everywhere (the table in hooks/deskactions.ts)
grep -qF 'Use `action` instead' "$root/templates/thread.md" || fail "thread.md must tell a thread to use action instead of trying the write itself"
grep -qF 'never try it with `az`, `gh api`, `curl`' "$root/templates/thread.md" || fail "thread.md must forbid trying the remote write with az / gh / curl"
grep -qF 'ask the user with AskUserQuestion' "$root/templates/front-desk.md" || grep -qF 'Ask the user with AskUserQuestion' "$root/templates/front-desk.md" || fail "front-desk.md must say the desk asks the user with AskUserQuestion for an action request"
grep -qF 'exactly the options Approve, Deny, Edit first' "$root/templates/front-desk.md" || fail "front-desk.md must name the three options"
grep -qF 'approve-action' "$root/templates/front-desk.md" || fail "front-desk.md must name approve-action"
grep -qF 'Never call `approve-action` on your own' "$here/thread/SKILL.md" || fail "the thread skill must say approve-action is never called on the desk's own judgment"
grep -qF '`action-list`' "$here/thread/SKILL.md" || fail "the thread skill must list action-list"
grep -qF 'workers may read and edit' "$here/thread/SKILL.md" || fail "the thread skill must say workers may read and edit (no grant lines)"
grep -qF 'Workers may read and edit' "$root/templates/front-desk.md" || fail "front-desk.md must say workers may read and edit (no grant lines)"
grep -qF '`refusals`' "$here/doctor/SKILL.md" || fail "the doctor skill must list the refusals action"
for k in ado-pr-reply ado-pr-thread-status ado-pr-comment ado-workitem-comment ado-workitem-update gh-pr-comment gh-pr-thread-resolve batch; do
  grep -qF "$k" "$root/templates/thread.md" || fail "thread.md lacks the action kind $k"
  grep -qF "'$k'" "$root/hooks/deskactions.ts" || fail "deskactions.ts lacks the action kind $k"
done
grep -qF 'Never curl / az / gh a forge write' "$root/templates/thread.md" || fail "thread.md must say a thread never curls / az / gh a forge write and requests the action kind"
grep -qF 'never curl / az / gh a forge write' "$here/thread/SKILL.md" || fail "the thread skill must say never curl / az / gh a forge write; request the action kind"
grep -qF 'Never brief a thread to curl / az / gh a forge write' "$root/templates/front-desk.md" || fail "front-desk.md must say never brief a thread to curl / az / gh a forge write; name the action kind"
grep -qF 'with a standing approval' "$root/templates/front-desk.md" || grep -qF 'With a standing approval' "$root/templates/front-desk.md" || fail "front-desk.md must say that with a standing approval the desk does not ask the user again"
grep -qF '`restart` takes `text`' "$here/thread/SKILL.md" || fail "the thread skill must say restart takes text (new instructions go there)"
grep -qF 'Approval in advance' "$root/templates/front-desk.md" && grep -qF 'allow-writes' "$root/templates/front-desk.md" && grep -qF 'Never invent a target the user did not write' "$root/templates/front-desk.md" || fail "front-desk.md must tell the desk to call allow-writes only for a target the user wrote, and to ask when refused"
grep -qF 'allow-writes' "$here/thread/SKILL.md" && grep -qF 'Never a target the user did not write' "$here/thread/SKILL.md" && grep -qF 'do not ask the user again for what it covers' "$here/thread/SKILL.md" || fail "the thread skill must document allow-writes (user's words only, never ask again for what it covers)"
[ -f "$root/commands/allow.md" ] && [ -f "$root/commands/revoke.md" ] && grep -qF 'allow-writes' "$root/commands/allow.md" && grep -qF 'revoke-writes' "$root/commands/revoke.md" || fail "commands allow.md and revoke.md must call allow-writes / revoke-writes"
grep -qF 'it takes `text`' "$root/templates/front-desk.md" || fail "front-desk.md must say restart takes text"
grep -qF 'standing approvals' "$here/thread/SKILL.md" || fail "the thread skill must say action-list shows the standing approvals"
# standing approval is model-proof: the grant is written in ONE place (deskactions.ts writeGrant, called by answerAction only: the pane press and the
# human's answer to the desk question); no other source file touches the grant store; answerAction is called only by the pane and by bindAnswers
[ "$(grep -c 'writeGrant(' "$root/hooks/deskactions.ts")" = "2" ] || fail "writeGrant must be defined once and called once (by answerAction) in deskactions.ts"
[ "$(grep -n 'writeGrant(' "$root/hooks/deskactions.ts" | grep -vc 'async function writeGrant\|await writeGrant(h, r, now)')" = "0" ] || fail "writeGrant must be called only from answerAction"
users=$(grep -rlE "writeGrant|action\.grants" "$root/hooks" --include=*.ts --include=*.tsx | grep -v '\.test\.' | sed 's|.*/||' | tr '\n' ' ')
[ "$users" = "deskactions.ts " ] || fail "only deskactions.ts may write or name the standing grant store (found: $users)"
callers=$(grep -rlE "answerAction\(" "$root/hooks" --include=*.ts --include=*.tsx | grep -v '\.test\.' | sed 's|.*/||' | sort | tr '\n' ' ')
[ "$callers" = "deskactions.ts pane.tsx " ] || fail "answerAction may be called only by the pane and by deskactions.ts (found: $callers)"
[ "$(grep -c "^  '[a-z-]*': \[" "$root/hooks/deskactions.ts")" = "8" ] || fail "the action table (PARAM_KEYS) must hold exactly eight kinds"
# one version: plugin.json, marketplace.json and the pane's VERSION agree (the mod compares its own VERSION with the installed plugin)
pv=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/.claude-plugin/plugin.json" | head -1)
mv=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/../../.claude-plugin/marketplace.json" | head -1)
vv=$(sed -n "s/^export const VERSION = '\([^']*\)'.*/\1/p" "$root/hooks/pane.tsx")
[ -n "$pv" ] && [ "$pv" = "$mv" ] && [ "$pv" = "$vv" ] || fail "version mismatch: plugin.json=$pv marketplace.json=$mv pane.tsx=$vv"
# roles: tools named per role, and the desk's commands (hooks/skills-roles.test.ts runs them through strict mode)
node "$root/hooks/skills-contract.mjs" || fail "skills roles (see above)"
# 1.0.27: the context diet line, word for word, in the thread guide and the thread skill
for f in "$root/templates/thread.md" "$here/thread/SKILL.md"; do grep -qF -- 'run the full test suite once per step, targeted runs in between; read diffs with --stat and one path; never read a notes file in full: headings first' "$f" || fail "$(basename "$f") lacks the context diet line"; done
# 1.0.28: a request for the user's answer or approval is lean_ask or lean_report with `action`, never prose in a working report
grep -qF -- "A request that needs the user's answer or approval goes out as \`lean_ask\` or \`lean_report\` with \`action\`, never as plain prose in a working report" "$root/templates/thread.md" || fail "thread.md lacks the prose-request line"
grep -qF -- "A request that needs the user's answer or approval goes out as a question or an \`action\` request, never as plain prose in a working report" "$here/thread/SKILL.md" || fail "the thread skill lacks the prose-request line"
# 1.0.28: a review covers only changed code (the reviewer agent, the review brief, the review skill)
for f in "$root/agents/reviewer.md" "$root/templates/review-brief.md" "$here/review/SKILL.md"; do grep -qF -- 'report nothing about a file or line outside the changed hunks' "$f" || fail "$(basename "$f") lacks the changed-code-only line"; done
echo "ok skills-contract"
