---
name: review
description: Review the current branch's diff in passes with the read-only reviewer agent and record a verdict for the HEAD commit; a green record is what unlocks `git push`. Use before any push or when asked to review.
argument-hint: [base-branch]
---

# Review and push gate

Run in a thread, in the repo or worktree to push. The push guard allows `git push` only when
`~/.lean-agent/<project>/reviews/<full HEAD sha>.json` exists with `"green": true`; any new commit changes the sha, so
the review must be redone after every change.

1. `git rev-parse HEAD` (full sha), `git diff <base>...HEAD --stat`; base defaults to the default branch.
2. Pass 1: spawn the `reviewer` agent with the diff command and the project's test command. It lists findings by
   severity with `path:line`.
3. Fix every blocker and major finding (edit, test, commit), then run pass 2 on the new HEAD. Stop after at most 3
   passes; if blockers remain, record `green: false` and report with `lean_report`.
4. Write `~/.lean-agent/<project>/reviews/<sha>.json` (Write tool; project = the name in `projects.json`):
   `{"green": true|false, "sha": "<full sha>", "project": "<name>", "passes": N, "findings": ["<open finding>", ...]}`
   Green means: tests pass, no open blocker or major finding. Never write green for a sha you did not review.
5. Say the verdict in one line. Private projects are never pushed whatever the record says.
