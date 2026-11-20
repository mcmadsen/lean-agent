---
name: review
description: Strict review of the current branch's diff in ordered passes with the read-only reviewer agent (inputs computed by script, enforcement by the lean_review tool), then a recorded verdict for the HEAD commit; a green record is what unlocks `git push`. Use before any push or when asked to review.
argument-hint: [base-branch]
roles: thread
---

# Review and push gate

Run in a thread, in the repo or worktree to push. A push needs `lean_review` to have recorded a green verdict for the
full HEAD sha (registered projects only); any new commit changes the sha, so the review must be redone after every change.
**A thread never runs `git push` or `gh pr create` itself**: its own permission check judges the command in a session that
never heard the user's yes (it was said to the desk), so it refuses. After a green review, `lean_report` "ready to push
<full sha> (branch, PR title)" and stop. Before that, make sure this worktree is registered: `lean_worktree` `register` with its
absolute path (a no-op refresh when it is, and it adopts one made with plain `git worktree add`); the desk's push needs it, and the
answer says why when it refuses (a taken key is replaced when stale, else registered under a `~2` suffix). The desk asks the user, records the yes with `approve-push <tN> <sha>` (one sha, single
use, 2 hours) and pushes with `push` (and opens the PR) from the desk. Or the user pushes by hand with the printed `git -C ... push` command.

The review is strict on purpose: the reviewer works in ordered passes (completeness, correctness traced end to end, behaviour
before -> after, reuse and duplication, scope and platform, tests, defaults and state, style last), a script (not a model) computes
what it must look at, and the `lean_review` tool refuses green when the reviewer's own result does not hold. Never argue with the
tool's refusal: do what it says.

1. `git rev-parse HEAD` (full sha), the branch (`git branch --show-current`), `git diff <base>...HEAD --stat`; base defaults to
   the default branch. The goal is the thread's goal, the branch name, the commit messages and the PR or work-item text, in one line.
2. **Prepare (a script, no model):** `lean_review` (`mcp__lean-agent__lean_review`) with `action: "prepare"`, `project` (the name in
   `projects.json`), `base`, `branch`. It computes from the diff: new symbols and files, edited tests whose assertions change
   (renamed, flipped, deleted, skipped), new parameters with defaults, new module-level state, changed or removed exported symbols,
   the user's declines for this branch, and on a later pass the open findings and the delta since the last reviewed sha. The first
   line is `LEAN-REVIEW-PREP {...}` (the model, the number of runs and why, whether a second opinion comes first, whether this is a
   re-review); everything after the first lines goes into the reviewer's prompt as it is. Print the reviewer line (`reviewer: sonnet x2
   (risk: ...)`, or `reviewer: sonnet (...)`) so the user sees who reviews and why. The reviewer is **always sonnet**; never pass
   `model` to prepare yourself: it is only for a model the brief explicitly names.
3. **Lessons:** call `lean_review` with `action: "lessons"` (`project`, `base`, `head` = the full HEAD sha, `goal` = the one-line goal from step 1: its words select lessons too) and add the text block it returns to the
   reviewer's prompt (the project's review checklist and shared helpers that match the changed paths). If the tool says it has no such
   action or errors, go on without it.
4. **Second opinion (only when prepare says so: a new abstraction or a big diff, never on a re-review):** spawn
   `lean-agent:reader-haiku`, search-only, with the new symbols and files from prepare and this brief: "For each new symbol or file,
   read its definition in the diff, then search the repository (`rg`; by name, key identifiers and behaviour words such as counter,
   register, subscribe, store, cache, overlay, defer, retry, debounce, poll, map) for existing code that already does the same job.
   A thin wrapper or hook that calls existing code is `wraps-existing`, not a duplicate. Also name siblings that share the problem.
   Do not review style, tests or correctness. Answer as `symbol -> file:line candidate (duplicate | extends-existing |
   wraps-existing | justified-new, why)`, brief." Give it the same `allow-cmd` line as the reviewer and one more line of its own, `review: second-opinion` (that line is how
   the guard knows this reader belongs to the review: see "Subagent cap" in step 5). Pass its candidates (only those
   with a candidate that is not `justified-new`) to the reviewer as "second opinion: you must confirm or reject EACH one in `reuse`";
   keep them as `second` (`[{symbol, candidate}]`) for the record.
5. **Pass 1:** spawn the `lean-agent:reviewer` agent on the model prepare printed (the Agent call's `model`: `sonnet`, always). A
   high-risk diff (security, concurrency, migrations/schema/storage, UI strings/locales, public API, config formats, removed public
   symbols, ~800+ changed lines) gets TWO independent sonnet passes: prepare prints `reviewer: sonnet x2 (risk: ...)`, you spawn two
   separate reviewer Agent calls with the same prompt (neither sees the other's answer) and keep both JSON blocks. A re-review and a
   docs/tests-only diff get one. Opus reviews only when `config.json` `review.model` is `opus` or the brief explicitly asks for it AND the
   user approved it in the pane for this thread: without that approval prepare says so, files a request in the pane and sonnet runs; never
   spawn a reviewer on opus (or `worker-opus`) on your own, the guard refuses it ("opus needs the user's approval: report it and stop"). Its prompt: the project path, base and full HEAD sha, the goal, the whole
   prepare text, the lessons, the second opinion, the project's test command, and these lines, with the real base and full HEAD sha
   filled in (a grant matches the command or a prefix of it followed by more words; nothing else, no pipes or redirects). Your session's
   folder is the thread folder, which is NOT a repository, so every git command names the checkout: `<worktree>` is the absolute path of the
   worktree (or repo) you review, the same path `git -C` takes everywhere else here:
   `allow-cmd: git -C <worktree> diff <base>...<sha>, git -C <worktree> log <base>..<sha>, git -C <worktree> show <sha>, git -C <worktree> merge-base <base> <sha>`
   On a re-review add `git -C <worktree> diff <since>...<sha>` to that line. The prepare text names its commands as `git -C <checkout> diff|show`
   too: use that checkout as written. Tell the reviewer to use these as written; `git -C <worktree> diff|log|show|status|rev-parse|merge-base`
   and read-only `rg`/`grep`/`find`/`ls`/`cat` are built in, and Read covers the rest; it has no other shell access (no `git grep`).
   **Subagent cap.** A cap on subagents (`config.json` `agents.cap`, or one in the user's CLAUDE.md) is for the thread's work, not for the
   review: the reviewer passes (up to 4 per review: two runs on the first pass of a high-risk diff, one on each re-review; 6 per session) and the second-opinion reader (the `review: second-opinion` line) do not
   count against it, and the guard lets them through when the cap is used up. Never skip or merge a reviewer pass to save a slot, and do not
   put the `review: second-opinion` line on any other agent.
   It answers in prose plus ONE fenced `json` block (findings, gaps, user_facing, risks, checks, reuse, coverage, siblings, searches,
   unverified) before its LEAN-FEEDBACK line. Keep that block: it is the `review` of the record (for two runs, the `reviews` of it).
6. Fix every blocker and major finding (edit, test, commit). A finding the user decides not to fix is declined, never ignored: ask
   the user (`lean_ask`), then `lean_review` with `action: "decline"`, `project`, `branch` (or `all: true`), `kind` (the finding's
   category), `symbol`, `why`; later passes are told and do not raise it again. A decline never turns a verdict green by itself.
   Run the reviewer's `checks` that a worker can (a command, a test on base and head) and fix what they show.
7. **Pass 2 and 3 (re-review):** prepare again on the new HEAD. The reviewer now gets ONLY the open findings, the declines and the diff
   since the last reviewed sha (plus the reuse, scope and platform passes on the files changed since), in ONE `sonnet` pass, so the review
   converges: a new major about code that did not change since is minor. Stop after at most 3 passes; if blockers remain, record
   `green: false` and report with `lean_report`.
8. **Record** with `lean_review` (`action: "record"`, the default): `project`, `sha` (full HEAD), `base`, `branch`, `green`,
   `passes`, `model`, `second` (if any) and `review` (the reviewer's last JSON block, as it wrote it); for a high-risk diff pass
   `reviews: [<run 1 block>, <run 2 block>]` instead (the tool merges them like `review --runs 2`: findings both runs raised are marked
   `[2/2]`, the others `[1/2]`, the union counts, so a major only one run found still blocks; `action: "merge"` with the same `reviews`
   returns the merged block to read, and that block, unchanged, is accepted as `review`). A high-risk diff with one block is refused
   green, and so are two identical blocks. `base` must be the NAME of
   the branch or tag the work goes into (a sha or `HEAD~1` is refused: it would shrink what is checked). Never write the file yourself:
   only the tool signs a record, and an unsigned one is ignored. Green means: tests pass and the tool accepts it. The tool REFUSES green,
   with the reason, when a new symbol has no `reuse` entry, an edited test no `coverage` entry, a second-opinion candidate no answer,
   an earlier blocker/major is neither listed again nor in `fixed`, git could not produce the diff, or a blocker or major finding is open (duplication, scope and platform findings count as major; unintended user-facing changes,
   removed side effects and a goal-blocking gap are majors too). A refusal is recorded as not green: send the reviewer back for the
   missing entries (same prompt, the refusal text added), or fix the open findings, then record again for the same or the new sha.
   Never record green for a sha you did not review, and never without the reviewer's JSON.
9. Say the verdict in one line (green or not, the model, open findings by severity). Private projects are never pushed whatever the record says.
