---
name: review-learn
description: Learn from the review comments on a pull request or a project's recent PRs on GitHub or Azure DevOps, by the host in the origin URL (what reviewers repeatedly ask for), and feed them into the project's rules. Excludes only the lean-agent owner's own comments. Use for "learn from reviews" or after a PR round.
argument-hint: <project> [PR number]
roles: desk, thread
---

# Learn from reviews

## Desk

`/lean-agent:review-learn <project> [PR number]` runs in a thread, never on the desk: `lean_thread` action `new` with `project` and `text` "Run lean-agent:review-learn for <project> <PR number if given>; report what changed in the rules". No project: ask which (`lean_thread` `projects`).

## Thread

1. Collect with ONE call: `lean_review` `prs` (`project`; `pr` = a number, or `last` = how many, default 10; `base` = the branch the work
   goes into). It is the same fetch the `pr` skill uses for `comments` (`hooks/prhost.ts`) and picks the host from the project's origin
   URL: `github.com` -> `gh` (owner = `gh api user --jq .login`; the last merged PRs, `gh pr view <n> --json reviews,comments` and
   `gh api repos/{owner}/{repo}/pulls/<n>/comments`); `dev.azure.com` or `*.visualstudio.com` -> `az` (owner = the signed-in az
   user, `az account show --query user.name`; the last completed PRs, `az repos pr list --status completed --top <N> --target-branch
   <base>`, then PRs into other targets when fewer than N; the threads from REST `.../pullRequests/<n>/threads` with a bearer token from
   `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`: never a PAT, never printed). Any other host: the tool
   says it is not supported. To look at one PR's threads again by hand: `lean_run` `get` (`threads: true`, or a `path` with `select`).
2. The tool has already dropped what is never a lesson, each counted in its first lines: the owner's own comments (Only the owner's own
   comments are excluded; other humans and bots such as Copilot or CI reviewers are learned from), system threads (votes, policy results,
   ref updates, reviewer changes), deleted comments, bare approvals ("LGTM") and one-off typo fixes. Fallback only when the owner could
   not be found: skip comments that carry a lean-agent marker line (`<!-- lean-agent -->` or text starting `[lean-agent]`).
3. Read what is left: group it by theme and file area. An Azure thread's status says what happened to the point: `fixed` or `closed` =
   the author acted on it, `wontFix` or `byDesign` = the author disagreed (a lesson only if another reviewer says it too), `active` = still
   open.
4. A theme seen twice or more, or a rule stated outright ("always...", "never..."), becomes a **lesson** in the project's
   lesson store (one line each; the store is read by the reviewer, see `review`), not a line in `rules/*.md` (those are
   capped at 25 lines; the store has its own, much larger cap). First `lean_review` `lessons-list` (`project`) to see what
   is there. Then one `lean_review` `learn` call (`project`, `source` e.g. "review-learn <date>"):
   - `checklist`: general lines, each "Before adding X, check Y in Z" or "When changing X, also Y". No PR numbers, names or dates.
     **One test for where a line goes:** would a reviewer check it in ANY change (a string, stored here), or does it only describe one
     area's commands or layout (how that folder builds, tests or is laid out)? Give the second kind as `{text, area}` (`area` = the
     folder or rule name): the tool does not store it, it hands it back under "NOT stored" and you put it into that area's rule with the
     `learn` skill (`--area <area>`, which keeps the rule's 25-line cap).
   - `helpers`: for every existing helper or mechanism a human pointed to, open the code first and give
     `{name, where, what}` with `where` = the file path relative to the repo root (as `git ls-files` shows it). The tool runs the same
     existence check as `lessons-verify` before it adds a helper and refuses one whose path and symbol it cannot find, naming it
     ("refused helper X"): fix its path or leave it out. Reviewers asking for reuse ("we already have X for this") are the most valuable
     lessons: a helper whose name is already in the store updates its line.
   - `replace`: `[{old, new}]` to correct a line that is wrong or out of date.
   Near-duplicates of existing lines are skipped by the tool (it says so); lines the store cannot take (cap) are named.
   A rule about one area's commands or layout goes to a `paths:` rule via the `learn` skill (`--area <dir>`), keeping its size
   cap: give it as `{text, area}` in `checklist` and the tool returns it for that. One-off remarks go to `lean_remember` instead.
5. Manage the store with `lean_review`: `lessons-list`, `lessons-rm` (`which` = the number or a unique piece of text),
   `lessons-undo` (the last batch), `lessons-verify` (`repo` = absolute path; flags helper lines whose code path or symbol
   cannot be found; `apply: true` removes them; run it after a refactor). Nothing is deleted for good: a removed line is
   marked dropped and `lessons-undo` brings it back.
6. Report which themes were added, which skipped, how many lines went into the store (and how many were duplicates), which helpers were
   refused, which lines went to an area rule, and the comment counts: the last line of the `learn` answer gives them from the `prs`
   fetch ("comments seen N, kept K; excluded: the owner's own A, system threads B, deleted C; dropped as approval D, as typo fix E");
   quote it, so the owner's comments and the dropped approvals and typos are never mixed up.
