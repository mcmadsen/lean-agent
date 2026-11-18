---
name: learn
description: Learn a project's build/test commands, conventions and gotchas into path-scoped rules that load only when a file of that area is read. Run in a thread, never the desk. Use for "learn <project>", "re-learn <area>", "verify the rules" or "trim the rules".
argument-hint: <project> [--gaps | --full] [--area <dir>] [--verify] [--trim]
roles: thread
---

# Learn project rules

Run in a thread whose checkout is the project. Rules are written to `~/.lean-agent/<project>/rules/` (the source of
truth) and COPIED into the checkout by the `lean_rules` tool; never write into `<repo>/.claude/rules/` yourself and
never symlink (symlinked rule folders do not load).

**Modes**
- `--gaps` (the default when the repo has its own `CLAUDE.md` or `.claude/rules`): few files, ONLY what those docs miss,
  plus the contracts between areas. Most areas end as "covered by docs" (step 4) and get no rule.
- `--full` (the default when the repo has no such docs): every area gets a rule.
- `--area <dir>`: only that area, in either mode. `--verify`: step 5. `--trim`: step 6.

**Budget** (`lean_rules` `check` prints the live numbers): a rule is at most 25 non-empty body lines AND about 500 tokens
(2,000 characters), no line wider than 240 characters; `_project` at most 10 lines and 150 tokens (600 characters); at most
40 rule files. Sync skips a rule over any cap (and removes its older copy from the checkout).

**Hard rule**: a line is written or kept only if it was checked against the code in THIS run. A claim you could not check
goes to an `UNVERIFIED` list in your final report, never into a rule.

0. **Sources first.** Never `cd` into the project: run `git -C <repo> ...` and use absolute paths everywhere (also in the
   explorer briefs).
   - *Legacy 0.45 cards.* If `~/.lean-agent/legacy-0.45/index.md` has a section for this project (cards live in
     `legacy-0.45/cards-<project>/`), read the index, then the cards of the area at hand, as **candidate facts, not rules**.
     Drop: commit hashes, PR/branch status, sizes, counts, dates, diaries, `file:line` cites. Keep: mechanisms, invariants,
     commands, traps. Every kept fact is checked against the code (hard rule); narrative worth keeping that is not a path
     rule (a decision, why something is the way it is) goes to `lean_remember`.
   - *The repo's own docs.* `git -C <repo> ls-files | rg 'CLAUDE\.md|\.claude/rules'`. Optional, once: a doc index (path +
     first heading, `rg -m1 '^#' <doc>`) pasted into every brief.
1. **List the areas**: workspace packages/services (`package.json` workspaces, `go.work`, `Cargo.toml`, `pyproject`), else
   first-level source folders. Pick the mode. Skip areas already recorded with `covered_by` (see `lean_rules` `check`) unless
   `--area` names them. For each area note: its folders, its docs (root docs, docs inside the area, `.claude/rules` whose
   `paths:` match), and the capped file list: `git -C <repo> ls-files -- <folder> | head -200` (`| wc -l` for the true
   size; the brief says "first 200 of N"). **The lead always passes this list**, so even an explorer that can only Read works.
2. **Explore.**
   - *Cost.* Small areas (about 40 files or fewer, one or two docs) the lead explores itself, inline: no subagent. Explorers
     are for big areas only; every one costs a brief, a model run and your re-check of its answer.
   - *Model.* Judgment-heavy areas (comparing code with several docs, cross-area contracts, conflicting conventions) go to
     `lean-agent:reader-sonnet`; command and listing work (build/test commands, what lives where) to `lean-agent:explorer`
     (haiku). When an area has docs to reconcile, choose sonnet: the delta needs reading, not listing.
   - *Preflight, ONE explorer first.* Brief: "run `git -C <repo> ls-files <folder> | head -3` and `rg -n <word> <file>`;
     report which worked and the exact refusal text of what did not." Launch the rest only when both worked. If one is
     refused, the refusal ends with `(lean-agent <version>)`: if that is not the installed version (the desk's doctor check
     says "start a new session"), this session runs old code: tell the user, do not retry. Otherwise the lead lists
     the files itself and hands each explorer its capped list (the brief already carries it), or uses `lean-agent:reader-sonnet`.
   - *Caps.* A cap on subagents (the user's `CLAUDE.md` or `~/.lean-agent/config.json` `learn.maxExplorers`, default 4)
     is a hard limit: group areas into at most that many assignments, each with a budget of 25 lines per area it holds
     (answers as `## <area>` sections); the explorer reports what it did not reach in `unreached`.
   - *The brief* (per area or group): the folders, the capped file list, the area's repo docs (paths) and the line "READ
     THESE FIRST; return only what they do not say; a bullet whose source is one of them is dropped; where code and a doc
     contradict, report `CONFLICT: <doc path> says ..., <code path:line> does ...` with both sides", the legacy-card facts
     to check, and the gaps from `~/.lean-agent/<project>/gaps.jsonl` and the memory notes for that path. It returns at most
     25 lines per area, each bullet naming the file it was checked in. Its `LEAN-FEEDBACK` line carries `refused`,
     `unverified` and `unreached`; the mod files them (`refusals.jsonl`, `feedback.jsonl`).
   - *Script knowledge* (the brief asks for it per area, as two extra sections after the 25 lines): (a) `SCRIPTS`: the repo's
     own scripts for the area (`package.json` scripts, Makefile/justfile targets, `tools/` or `scripts/` folders, CI steps that
     can run locally), each as `<command>: what question it answers`; (b) `MECHANICAL`: tasks where a thread would otherwise
     spend model time on mechanical work (counting, listing, diffing generated files, finding the worktrees or packages that
     match something) and the script or one-liner that already does it, or "none: candidate for a script". Each entry names
     the file it was found in.
3. **Write** `rules/<area>.md` (see Budget):

   ```markdown
   ---
   paths:
     - "services/billing/**/*.ts"
   ---
   # billing
   - Test: `pnpm --filter billing test -- <file>`
   - Money is integer cents; see docs/billing.md for rounding
   <!-- lean-agent: learned <sha> <date> sources: services/billing/** -->
   ```

   plus one always-loaded `rules/_project.md` (no `paths:`: how to build and test the whole repo).
   Rules say what the code and the repo docs do not; no file listings, no secrets, no hashes/dates/counts.
   - A bullet may point at a doc (`see <path>`), never restate it. A bullet that an explorer sourced from a doc is dropped.
   - **Scripts, not descriptions.** Where a script answers a question, the rule says "for X run `<script>`" (the command as it
     is run from the repo root) instead of describing how to find X by hand; `SCRIPTS` entries that a thread will need go in,
     the rest stay out. `MECHANICAL` entries with no script are not rules: they go to the report as script candidates.
   - **Keep the scripts block.** A rule may hold `<!-- lean-agent:scripts -->` ... `<!-- /lean-agent:scripts -->` (a later release
     writes adopted scripts there). When you rewrite a rule, copy that block through byte for byte, in place; never merge it
     into the bullets, shorten it or drop it. The footer is the OTHER comment (`<!-- lean-agent: learned ... -->`, with a space
     after the colon); the block counts toward the caps like any other body lines.
   - Keep a `CONFLICT` as one line only if the user should know; otherwise it belongs in your report.
   - **Wiring between areas.** `paths:` takes a list: one rule with the globs of both sides (`- "services/api/client/**"`,
     `- "apps/web/src/api/**"`; braces like `src/**/*.{ts,tsx}` work) loads when either side is read. Put such contracts
     in `rules/contract-<a>-<b>.md` and record it as its own area with all its globs.
   - Checked or out: for each line, either the code showed it in this run or it goes to the `UNVERIFIED` list.
4. **Record, check, sync.**
   - `lean_rules` `record` per area: `area` (the rule file is `rules/<area>.md`), `globs`, `sha` = `git rev-parse HEAD`,
     `relies` (up to about 10 files and symbols the rule stands on; the mod writes them into the footer as `relies-on:`;
     `stale` uses the files among them, `verify` all of them). `lines` is counted from the file: do not pass it. An area the repo's own docs fully
     cover gets `covered_by: <doc path>` and no rule file: it is never stale and the next run skips it.
   - `lean_rules` `check` (a dry run, nothing copied): lines and characters per rule, cap violations. Shorten what it flags.
   - `lean_rules` `sync` with `repo` = the checkout and `all: true` (every worktree of the project, also the ones from
     `git worktree list`). It copies the rules AND the project's recipe skills, removes stale copies, adds
     `.claude/rules/lean-agent/` and `.claude/skills/lean-agent-*/` to the shared `.git/info/exclude`, and answers ONE line
     per checkout (`<path>: copied N, removed M, skipped K, exclude ok`) plus what it skipped; `verbose: true` lists paths.
5. **`--verify`** (rules that exist): `lean_rules` `verify` with `repo` (optionally `area`): it takes every backticked path,
   symbol and number (three digits or more) of each rule, as whole words, at most 150 names per call (later rules
   print NOT CHECKED: run again with `area`), and the `relies-on` list, searches the repo for it (fixed strings, read-only) and lists
   the names that no longer exist per rule, and relied-on files that changed or vanished since the recorded sha. Then, only
   for what it cannot judge (behaviour, numbers' meaning, commands that still work), re-check by bullet group and decide
   KEEP / FIX / DROP; `record` again (new `sha`), `check`, `sync`.
6. **`--trim`**: call `lean_rules` `stats`. Rewrite rules that loaded often but have gaps in `gaps.jsonl`; delete rules in
   `never` after 30 days; `check`, `sync` again. A rule's scripts block is never deleted or shortened by trim (not even when
   the rest of the rule goes: say so in the report and keep the block's lines in a rule that stays). Read the gaps too: a gap
   that describes mechanical work (counting, listing, diffing, "find the ...") is not a missing fact but a script candidate; list
   those in the report under `SCRIPT CANDIDATES` with the question each would answer.

**Final report** (`lean_report`): areas learned / covered by docs / skipped, rules and total lines, `CONFLICT`s (doc vs code),
the `UNVERIFIED` list, `SCRIPT CANDIDATES` (mechanical tasks without a script), the folders explorers did not reach, commands that were refused (command and text), and how many
explorers ran against inline work.

Freshness: `lean_rules` `stale` (run at thread start automatically) names areas whose relied-on files changed or vanished,
whose manifest changed, whose changed files exceed max(15, 10% of the area's files), or that have three gaps; re-learn
those with `--area` when you touch them. There is no background re-learn.
