---
name: rules-pr
description: Turn what lean-agent learned about a project into a DRAFT pull request that improves the project's own CLAUDE.md files and .claude/rules, so the whole team benefits and the always-loaded text shrinks. Run in a thread, never the desk. Use for "propose a rules PR for <project>", "upstream the learned rules", "optimise the project's Claude files", or after such a PR merged (step 8).
argument-hint: <project> [--min-sessions N] [--min-days N]
roles: desk, thread
---

# Rules PR

## Desk

`/lean-agent:rules-pr <project> [flags]` runs in a thread, never on the desk: `lean_thread` action `new` with `project` and `text` "Run lean-agent:rules-pr for <project> <flags>; report the draft PR link". No project: ask which (`lean_thread` `projects`).

## Thread

Run in a thread. The project's learned rules (`~/.lean-agent/<project>/rules/`), its load log, the review lessons and the workers'
missing-context reports become a draft PR on the project's repo. **Scripts over models**: `lean_rules` `pr-plan` computes every
count, match and estimate without a model (files and their tokens, which load every session, duplicates, stale lines, sections
to move, rules worth adding with their evidence, tokens before and after). You write the edits and the PR text from the plan.
Copy numbers from the plan; never recount, round or estimate them yourself.

**Hard rules**
- Never touch `CLAUDE.local.md` (the plan lists it as local: it counts for tokens, is never changed) or any user memory
  (`~/.claude`, `MEMORY.md`), and never write into `~/.lean-agent` or `<repo>/.claude/rules/lean-agent/` (lean-agent's own copies).
- Team files and the PR never contain lean-agent tool names (`lean_*`), thread ids (`tN`), costs, the user's paths (`/Users/...`,
  `~/...`), emails, or PR and ticket numbers from elsewhere. The plan already leaves out lines that do (`unsafe` lists them);
  rewrite, do not paste.
- Keep every team instruction's meaning: a line is removed only because the same instruction stands elsewhere in the repo's files
  (`repoVsRepo`) or because the thing it names is gone (`stale`, checked by you in the code first). Moving a section moves its
  text unchanged apart from its heading level.
- A line is added only after you checked it against the code in this run (`git -C <worktree> grep`, read the file). A claim you
  could not check is not written; it goes to the PR's "needs a look" list.
- A thread never pushes or opens the PR (step 7). Never the EnterWorktree tool.

1. **Preview.** `lean_rules` `pr-plan` with `project` (the registered checkout is read; optional `min_sessions`, `min_days`,
   `window_days` from the argument). It writes `~/.lean-agent/<project>/rules-pr/plan-<date>.json` and `.md` and answers with
   the summary. "NOTHING to propose" (or a project that is not a git checkout): `lean_report` done with that sentence and stop.
2. **Worktree.** The `worktree` skill, `new <project> chore/claude-rules-<yyyy-mm-dd>` (today's date) from the project's default
   branch (`git -C <repo> symbolic-ref --short refs/remotes/origin/HEAD`, else `main` or `master`), registered. An existing
   registry entry for that branch is reused. Work only there with absolute paths and `git -C <worktree>`, no `cd`.
3. **Plan against what you edit.** `lean_rules` `pr-plan` again with `repo` = the worktree path (the plan of step 1 may be for a
   different commit). Read the JSON it names. Everything below uses this plan. Line numbers in it are for the files as they are
   now: after the first edit of a file find a section or line by its heading and text, not by number.
4. **Remove stale and duplicate lines** (commit 1). The plan matches by words, numbers and negations, not by meaning: read both
   lines before deleting. `duplicates.repoVsRepo`: delete the line in `file` only when it says the same as the one in `sameAs`
   and holds nothing that one lacks (a condition, an exception, a number); otherwise leave it. Delete whole lines of a wrapped
   paragraph, never half. `stale` with `action: remove`: confirm with `git grep` that the names are gone, then delete the line;
   `review` (a path alone may be generated or ignored: `dist/`, `.env`): find the new name and fix the line, or delete it when the
   thing is gone, or leave it and list it under "needs a look". A heading left without text goes too. Commit message:
   `Remove stale and duplicate lines from the Claude files`.
5. **Move path-specific sections** (commit 2). For each `moves` group by `target`: create (or extend, `merge: true`) the rule
   file with frontmatter `paths:` (a YAML list of the plan's globs, quoted) and the section text, then delete the section from its
   file. Check each glob matches a tracked file (`git -C <worktree> ls-files -- '<glob>'`). Commit: `Move area-specific
   instructions into path-scoped rules`.
6. **Add what the team keeps needing** (commit 3). For each `upstream` entry: write the plan's `text` into `target` (a new file
   with the entry's `paths:`, or merged into the existing file; no `paths:` means a section of the root `CLAUDE.md`), in the team's
   voice: short imperatives about the code, no "we learned", no mention of any assistant. Check every line against the code
   (hard rule). Recurring `missing.clusters` that have no rule: add a line only when the answer is verifiable in the code, the
   count goes into the PR; a `mechanical` cluster is a script's job, not a rule. A rule file stays short (about 25 lines).
   Commit: `Add area rules the team keeps needing`.
7. **Check, review, report.**
   - `lean_rules` `pr-plan` once more with `repo` = the worktree (it replaces today's plan files: the PR body numbers come from
     this last plan): `tokens.alwaysBefore` of the new plan is the "after" of step 3 within a few tokens (estimates are rounded
     per line); when it is clearly higher, find which edit added always-loaded text. Its `stale` has no `remove` left and
     `repoVsRepo` is empty (or only lines you decided to keep).
   - The `review` skill (strict) on the branch against the default branch; fix findings in a new commit and review again.
   - `lean_report` with state `done`, the text starting `ready to push <full sha> (chore/claude-rules-<date>, <PR title>)`, then
     the PR title, `draft: true`, and the PR body between `--- PR body ---` and `--- end ---`. The desk asks the user and pushes;
     you stop there. Never run `git push`, `gh` or `az`.

   PR body (fill from the plan's numbers; no lean-agent names, no thread ids, no costs, no local paths):
   ```
   ## What
   Moves area-specific sections of CLAUDE.md into path-scoped rules, adds rules the team keeps needing, removes stale and
   duplicate lines. Every instruction keeps its meaning. Draft: please check the added rules.

   ## Tokens per session (estimate: characters / 4)
   | | before | after |
   |---|---|---|
   | loaded in every session | <alwaysBefore> | <alwaysAfter> |
   | loaded only in an area | <scopedBefore> | <scopedAfter> |

   ## Moved sections
   | from | section | to | applies to | tokens |
   ## Added rules
   | file | evidence |   (evidence: loaded in <sessions> assistant sessions over <spanDays> days, <first> to <last>;
                          <count> reports of missing context about it)
   ## Removed lines
   - stale: <file> "<line>" (<what was not found>)
   - duplicate: <file> "<line>" (same as <sameAs>)
   ## Needs a look
   - <review lines, unverified claims>
   ```
8. **After the PR merged** (a later run, when the user says so). The merged text must be in the registered checkout's view of
   the default branch (ask the user to fetch when `git -C <repo> log <ref> -1 -- <a file of the PR>` does not show it).
   `lean_rules` `retire-upstreamed` with `ref` = that branch (`origin/main`): a dry run lists the lean rules and review lessons
   whose text now lives in the committed repo files, and for each rule the lines that are NOT there and would go with it (read
   them: if one matters, add it to the repo first); show it to the user, then again with `apply: true` (needs `ref`): they are
   retired from `~/.lean-agent` into `rules-pr/retired/<date>-<time>/` (backup; a lesson is only marked dropped, reason
   upstreamed, and not learned again) and learn will not write the area again. Then `lean_rules` `sync` with `all: true` to remove their copies from the checkouts, and `lean_rules` `check`
   (it reports duplicates between the repo files and what is left). Report what was retired.
