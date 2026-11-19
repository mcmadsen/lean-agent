---
name: review-learn
description: Learn from the review comments on a pull request or a project's recent PRs (what reviewers repeatedly ask for) and feed them into the project's rules. Excludes only the lean-agent owner's own comments. Use for "learn from reviews" or after a PR round.
argument-hint: <project> [PR number]
roles: thread
---

# Learn from reviews

1. Find the owner: `gh api user --jq .login`. This login is the lean-agent owner. Only the owner's own comments are
   excluded; other humans and bots (Copilot, CI reviewers) are learned from.
   Fallback only when `gh` cannot tell the owner: skip comments that carry a lean-agent marker line
   (`<!-- lean-agent -->` or text starting `[lean-agent]`).
2. Collect: `gh pr view <n> --json reviews,comments` and `gh api repos/{owner}/{repo}/pulls/<n>/comments`
   (inline comments). Without a number: the last 10 merged PRs, `gh pr list --state merged --limit 10`.
3. Drop comments by the owner, pure approvals, and one-off typo fixes. Group the rest by theme and file area.
4. A theme seen twice or more, or a rule stated outright ("always...", "never..."), becomes a **lesson** in the project's
   lesson store (one line each; the store is read by the reviewer, see `review`), not a line in `rules/*.md` (those are
   capped at 25 lines; the store has its own, much larger cap). First `lean_review` `lessons-list` (`project`) to see what
   is there. Then one `lean_review` `learn` call (`project`, `source` e.g. "review-learn <date>"):
   - `checklist`: general lines, each "Before adding X, check Y in Z" or "When changing X, also Y". No PR numbers, names or dates.
   - `helpers`: for every existing helper or mechanism a human pointed to, open the code first and give
     `{name, where, what}` with `where` = the file path relative to the repo root (as `git ls-files` shows it). A helper you
     cannot find in the code is left out. Reviewers asking for reuse ("we already have X for this") are the most valuable
     lessons: a helper whose name is already in the store updates its line.
   - `replace`: `[{old, new}]` to correct a line that is wrong or out of date.
   Near-duplicates of existing lines are skipped by the tool (it says so); lines the store cannot take (cap) are named.
   A rule about one area's commands or layout still goes to a `paths:` rule via the `learn` skill (`--area <dir>`), keeping
   its size cap. One-off remarks go to `lean_remember` instead.
5. Manage the store with `lean_review`: `lessons-list`, `lessons-rm` (`which` = the number or a unique piece of text),
   `lessons-undo` (the last batch), `lessons-verify` (`repo` = absolute path; flags helper lines whose code path or symbol
   cannot be found; `apply: true` removes them; run it after a refactor). Nothing is deleted for good: a removed line is
   marked dropped and `lessons-undo` brings it back.
6. Report which themes were added, which skipped, how many lines went into the store (and how many were duplicates), and
   how many comments were excluded as the owner's.
