---
name: review-learn
description: Learn from the review comments on a pull request or a project's recent PRs (what reviewers repeatedly ask for) and feed them into the project's rules. Excludes only the lean-agent owner's own comments. Use for "learn from reviews" or after a PR round.
argument-hint: <project> [PR number]
---

# Learn from reviews

1. Find the owner: `gh api user --jq .login`. This login is the lean-agent owner. Only the owner's own comments are
   excluded; other humans and bots (Copilot, CI reviewers) are learned from.
   Fallback only when `gh` cannot tell the owner: skip comments that carry a lean-agent marker line
   (`<!-- lean-agent -->` or text starting `[lean-agent]`).
2. Collect: `gh pr view <n> --json reviews,comments` and `gh api repos/{owner}/{repo}/pulls/<n>/comments`
   (inline comments). Without a number: the last 10 merged PRs, `gh pr list --state merged --limit 10`.
3. Drop comments by the owner, pure approvals, and one-off typo fixes. Group the rest by theme and file area.
4. A theme seen twice or more, or a rule stated outright ("always...", "never..."), becomes one line under the
   matching `paths:` rule via the `learn` skill (`--area <dir>`), keeping its size cap. One-off remarks go to
   `lean_remember` instead.
5. Report which themes were added, which skipped, and how many comments were excluded as the owner's.
