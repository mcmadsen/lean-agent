---
name: pr
description: Open, inspect and update pull requests with gh for a thread's branch (create with the right title/body, show state, checks and review comments). Use for "open a PR", "pr tN" or PR status rows for the desk.
argument-hint: create | status [tN] | comments <n>
---

# Pull requests

Never in a private project (the guard denies every gh/az call that is not read-only, and any push, there) and never before the `review` skill
has recorded a green review for HEAD (the push guard enforces it).

- **create**: `git push -u origin <branch>` (after a green review), then
  `gh pr create --title "<title>" --body-file <file>`; the body is what changed and why, plus how it was tested.
  Add the attribution lines only if `~/.lean-agent/config.json` `attribution` is true (your thread CLAUDE.md states the value; default off). Report the URL with
  `lean_report`.
- **status**: `gh pr view <n> --json state,reviewDecision,statusCheckRollup,url,isDraft,mergeable`; for a thread, find
  the PR with `gh pr list --head <branch> --json number,url,state`. One row per PR: `tN | #n | state | checks | review`.
- **comments**: `gh pr view <n> --json reviews,comments` plus `gh api repos/{owner}/{repo}/pulls/<n>/comments`.
- Merging, closing and deleting remote branches are the user's call: ask first with `lean_ask`.
