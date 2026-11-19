---
name: review
description: Review the current branch's diff in passes with the read-only reviewer agent and record a verdict for the HEAD commit; a green record is what unlocks `git push`. Use before any push or when asked to review.
argument-hint: [base-branch]
roles: thread
---

# Review and push gate

Run in a thread, in the repo or worktree to push. A push needs `lean_review` to have recorded a green verdict for the
full HEAD sha (registered projects only); any new commit changes the sha, so the review must be redone after every change.
**A thread never runs `git push` or `gh pr create` itself**: its own permission check judges the command in a session that
never heard the user's yes (it was said to the desk), so it refuses. After a green review, `lean_report` "ready to push
<full sha> (branch, PR title)" and stop. The desk asks the user, records the yes with `approve-push <tN> <sha>` (one sha, single
use, 2 hours) and pushes with `push` (and opens the PR) from the desk. Or the user pushes by hand with the printed `git -C ... push` command.

1. `git rev-parse HEAD` (full sha), `git diff <base>...HEAD --stat`; base defaults to the default branch.
2. Pass 1: spawn the `lean-agent:reviewer` agent with the diff command and the project's test command. It lists findings by
   severity with `path:line`. A reviewer is read-only and may run only the commands the Agent call grants, so put
   exactly these lines in its prompt, with the real base and full HEAD sha filled in (a grant matches the command
   or a prefix of it followed by a space; nothing else, no pipes or redirects):
   `allow-cmd: git diff <base>...<sha>, git log <base>..<sha>, git show <sha>, git merge-base <base> <sha>`
   Tell it to use them as written; `git diff|log|show|status|rev-parse` and read-only `rg`/`grep`/`find`/`ls`/`cat` are built in, and Read covers the rest; it has no other shell access.
3. Fix every blocker and major finding (edit, test, commit), then run pass 2 on the new HEAD. Stop after at most 3
   passes; if blockers remain, record `green: false` and report with `lean_report`.
4. Record the verdict with the `lean_review` tool (`mcp__lean-agent__lean_review`): `project` (the name in
   `projects.json`), `sha` (full), `green`, `passes`, `findings` (open ones). Never write the file yourself: only the tool
   signs a record, and an unsigned one is ignored. Green means: tests pass, no open blocker or major finding. Never
   record green for a sha you did not review.
5. Say the verdict in one line. Private projects are never pushed whatever the record says.
