# Changelog

## Unreleased

One combined release: the desk, thread and pane work, the learn flow, stats and compare work, and scripts over models with the feedback export. The sections are grouped by area; the
version lines in `plugin.json`, `marketplace.json` and `pane.tsx` are left to the desk.

### Fixed (learn flow, stats, mod)
- **Version skew is visible.** A session keeps the hooks module it loaded at start, while skills, agents and templates are read from
  the plugin folder again after `claude plugin update`: the skill text could say 1.0.4 while the guard refused like 1.0.3 (an explorer
  was refused `rg`, `ls` and `cat`). The mod now compares its own version with the installed one (the plugin root's
  `.claude-plugin/plugin.json` and Claude Code's `installed_plugins.json`, the higher wins; cached for a minute) at `session.start`
  and every `turn.start`: a status line and one `prompt.compose` line say "lean-agent code X is running but Y is installed: start a
  new session (threads: close and Start)". `lean_doctor check` reports it as a FIX row. Every refusal of the guard (`decide`) ends with
  "(lean-agent <running version>)", and `feedback.jsonl` rows and `refusals.jsonl` carry the running version.

### Added (learn flow, stats, compare)
- **An explorer that can explore.** The learn skill runs ONE preflight explorer (`git -C <repo> ls-files <folder> | head -3`,
  `rg -n <word> <file>`) before launching the rest; on a refusal the lead lists the files itself and hands each explorer a capped
  `git ls-files` list, or uses `lean-agent:reader-sonnet`. The lead always passes the capped list. `agents/explorer.md` says Grep/Glob
  may not exist, to use the read-only Bash commands and to stop and report a refused command. Small areas are explored inline by the
  lead; explorers are for big ones. Judgment-heavy areas use `reader-sonnet`, listing work stays on the haiku explorer.
- **LEAN-FEEDBACK `refused`, `unverified`, `unreached`** (explorer and readers): commands the guard refused with its text, claims not
  checked, folders not covered. Counts and the first entries go to `feedback.jsonl`, refusals to `refusals.jsonl`.
- **Deltas, not restatements.** The brief carries the area's folders, the capped file list and the repo's own docs
  (`CLAUDE.md`, `.claude/rules`): "read these first, return only what they do not say, contradictions as `CONFLICT` with both sides".
  A rule bullet may point at a doc (`see <path>`) but never restates it.
- **Modes and budgets.** `--gaps` (default when the repo has its own docs) and `--full`. Size budget next to the line cap: 2,000
  characters per rule (about 500 tokens), 600 for `_project` (about 150), no line wider than 240; lines count non-empty body lines.
  `lean_rules check` is a dry run (lines, chars, cap violations, rules without `paths:`, covered and missing areas); `sync` skips a
  rule over any cap and says why. `record` counts `lines` from the file itself (a differing caller value is reported) and warns when a
  rule is over a cap. A rule's `paths:` takes several globs (and `{a,b}` braces): the way to wire areas together.
- **Areas covered by repo docs** are recorded with `covered_by: <doc>` (no rule file): never stale, skipped by the next run.
- **Verification.** Hard rule: a rule line is written or kept only if checked against the code in the run; the rest goes to an
  `UNVERIFIED` list in the report. `lean_rules verify` extracts every backticked path, symbol and number of each rule (and its
  `relies-on` list) and searches the repo with `git grep -F` / `git ls-files` (read-only, at most 150 names per call, 40 per rule); the
  skill's `--verify` mode then re-checks semantically only what it cannot judge (KEEP / FIX / DROP).
- **`relies-on:`** in the rule footer (written by `record` from `relies`): an area is stale when a relied-on file changed or vanished
  since the recorded sha, not only by changed-file count; the count limit is `max(15, 10% of the area's files)`.
- **Legacy 0.45 cards.** learn step 0 reads `legacy-0.45/index.md` and the project's cards as candidate facts (drop hashes, PR status,
  sizes, counts, dates, diaries, `file:line` cites; keep mechanisms, invariants, commands, traps; narrative to `lean_remember`). The
  migration, and the versioned tidy (now v2, so people migrated earlier get it too), write that index: per card file, title, size and
  area guess.
- **Subagent caps.** `learn.maxExplorers` in `config.json` (default 4) or a cap from the user's `CLAUDE.md`: areas are grouped into at
  most that many assignments, 25 lines per area each; the explorer reports `unreached`.
- **Sync of every worktree.** `lean_rules sync` with `all: true` syncs every worktree of the project (`git worktree list --porcelain`
  plus `worktrees.json`) and answers one line per checkout ("<path>: copied N, removed M, skipped K, exclude ok") and the skipped
  rules once; `verbose: true` lists every path. The skill says recipe skills are synced together with rules.
- **Stats are computed by the mod.** The desk could not answer "stats" itself: the skill had a model read and sum a ledger that was
  about 27 MB after a day. `lean_doctor` has a new action `stats` (`days` default 7, max 90; `project`): spend today and for the
  window with request counts, today against `dailyCapUsd`, tables by model, role x model, role, agent and thread (top 10 + rest),
  rule loads per project (never-loaded rules listed, `_project.md` included), worker feedback and gaps, and the count of 0.45 and
  unparsable ledger lines. The `stats` skill says "call it; never read `ledger.jsonl` yourself". The pane footer reads
  "budget today: $x · 7d $y" (view.ts, no pane change).
- **One ledger reader, with rollups.** `hooks/ledger.ts` folds the ledger into per-day aggregates (by model, agent, role, thread and
  role x model: dollars, tokens, requests) kept in `~/.lean-agent/rollup.json` with a byte offset per ledger file; a sync reads only
  the bytes past the offset (`tail -c +N`), never the file from the top. It is rebuilt from the files only when missing, damaged or a
  file is shorter than its offset. The daily-cap cache of `budget.ts` is rebuilt from the same rollup on a new day, so the day change
  no longer reads the whole ledger either.
- **Both ledger schemas.** The 0.45 rows (ISO `ts`, `cost_usd`, `usage{...}`, no `role`/`usd`; about 2 KB each, most of an old
  ledger) were skipped, so "7 days" showed only today. They are read now: `cost_usd` is the dollars, role is `unknown`, the 0.45
  worker role is the agent, the thread is `thread` or `-`. They are never counted against a daily cap.
- **Ledger rotation, no row lost.** At session start a `ledger.jsonl` that begins with a 0.45 row is renamed once to
  `ledger-legacy.jsonl`, and one that begins in a past month to `ledger-YYYY-MM.jsonl`; a fresh `ledger.jsonl` follows. It is a
  rename (a concurrent writer lands in the old or the new file), the rollup offset moves with the file, and every reader (stats,
  caps) reads all `ledger*.jsonl`. The rollup also remembers each file's first line: a renamed file (a crash between the rename and
  the rollup write, another session in between) is recognised by it and not folded twice, and a fresh `ledger.jsonl` that outgrew an
  old offset rebuilds instead of being read mid-line; the cap cache is dropped by a rotation. (0.45 wrote naive timestamps: read as
  UTC, which only moves an old row across midnight.) New rows leave out zero token counts (about 100 bytes shorter; a missing number reads as 0).
- **Rule loads are counted again.** `lean_rules stats` showed no load for rules that had loaded. The `InstructionsLoaded` shell hook
  was the only path, so the mod now also logs `classic.InstructionsLoaded` itself into the same log; a load seen by both counts once,
  and `_project.md` is listed (it was left out of "never loaded"). Not checked on a live Claude Code session in this work (a nested
  session was not allowed): confirm with a learned rule and a Read of a matching file.
- **Unexpected models are visible.** The stats table shows role x model, and `lean_doctor check` lists spend today of the desk on a
  model other than the one lean-agent pins, of threads on a model no thread was started on, and live sessions
  (`claude agents --json`, when it reports a model) that differ from what lean-agent started. Those rows need a new session, not a
  setup press.
- **Learn collects script knowledge.** Explorers also report the repo's own scripts for an area (`SCRIPTS`: package.json scripts,
  Makefile/justfile targets, tools/ and scripts/ folders, CI steps that run locally, each with the question it answers) and
  mechanical work a thread would otherwise spend model time on (`MECHANICAL`); rules then say "for X run `<script>`" instead of
  describing how to find X. A `<!-- lean-agent:scripts -->` ... `<!-- /lean-agent:scripts -->` block in a rule (the mod writes
  adopted scripts there at every sync) is kept byte for byte by rewrites and never deleted by `--trim`; the footer matcher no longer takes it for
  the footer. `--trim` lists mechanical-looking gaps as `SCRIPT CANDIDATES` in the report.
- **Compare is back (rebuilt the 1.0 way).** `lean_doctor` `compare` (desk; `project`, `mode` overhead or history) and a thread's
  `lean_compare` (task mode) run `claude -p "Reply with OK." --output-format json` and `claude -p "/context"` (local, free) in the
  project folder with lean-agent switched off (`--settings` `enabledPlugins` false for the installed `lean-agent@...`, checked live: a
  disabled plugin's tokens drop out of the first turn), in a throw-away thread-shaped folder and in the desk folder: clean / thread /
  desk side by side (first-turn input tokens measured, cost, and `/context`'s categories), skills and MCP switched off one at a time on
  the clean column, suggestions with the concrete step (plugins to switch off, `tools.thread.drop`, memory files into path rules,
  rules that never loaded, script candidates), capped at $0.25. Task mode (the `compare` skill, run in a thread after the user agrees to
  the cost) runs one read-only task clean and as a thread on the same model and effort and a haiku judge compares correctness and
  completeness. Reports: `~/.lean-agent/compare/<date>-<project>.md` and `history.jsonl`, names and numbers only; a private project is
  never compared. README section "Compare".

### Fixed (squeeze)
- **A long failing Bash command failed the whole tool call.** `squeezeResult` rewrote the Bash result as a string. The engine validates
  a hook's answer against the tool's output schema, and Bash's result is the record `{ stdout, stderr, interrupted, ... }` (a failed
  call's is its error text): the string answer was refused ("expected object, received string"), so any long output of a command that
  exited non-zero failed outright, and the successful ones, being records, were never squeezed at all. It now squeezes `stdout` and
  `stderr` of the record, keeps its shape and every other field, saves the full text first, and leaves every other shape (error text,
  content blocks) untouched.

### Changed (desk, threads, pane)
- **Effort defaults go up where mistakes are expensive.** Threads default to sonnet / effort **high** (was medium); `config.json`
  `threads.effort` and `lean_thread new|start` `effort` still override. `worker-sonnet` and `reviewer` run at effort high,
  `reader-sonnet` at medium (was low), `worker-opus` stays high, `worker-haiku`, `reader-haiku` and `explorer` stay low.
- **Reopen is a fresh session, never a resume.** `lean_thread reopen` (and the pane's Reopen) on a CLOSED thread starts a new
  background session in the same folder (same tN, project, worktree, branch; `--model` / `--effort` from `thread.json`) with a
  handover the mod builds: brief, project / worktree / branch, goal (a close keeps the cleared goal's text), notes.md, the thread's
  report history (oldest first, about 4k tokens, the newest report whole), its `lean_remember` items and queued desk messages. The
  old session id stays in `sids`; its conversation is never resumed. It also regenerates the thread's own CLAUDE.md from the current
  template (only when lean-agent wrote it), so a fresh session runs today's code and rules. Result: "tN reopened as a new session
  (old conversation kept read-only)". A parked thread's `reopen` still only flips the state.
- `resume` of a thread that is not closed stays a resume, except when `thread.json` `version` (the lean-agent version installed when
  its session started or was resumed) is older than the installed one: then it starts fresh the same way and says why. An unrecorded
  version is unknown and resumes. `close` clears the thread's goal itself; it never deletes anything.
- A `done` report is a handover: the thread template asks for branch, worktree path, last commit, pushed or not, open items and next
  step, and `lean_report` answers a done report that lacks most of them with a one-line reminder.
- **Thread -> desk direct.** `lean_report` (done, blocked, or `important: true`) and `lean_ask` still write the inbox (source of truth,
  pane, dedupe) and also `$.session.send` one compact line (`[lean-agent] t3 done: ... (close t3 when nothing is left)`) to the
  desk's session; the desk records its session id in `~/.lean-agent/desk.json` when it resolves as desk. The desk's `session.receive`
  hook (origin plugin lean-agent) marks that inbox row delivered, so the next prompt does not repeat it. A missing desk id or a refused
  or failed send falls back to the inbox alone (and the desk's own 10 s `prompt.submit` relay, `desk.autoRelay`), and the tool result
  says so. Verified live: a message sent from one background session to another session id on the same machine arrives as a peer
  message and starts a turn in an idle session. Desk -> thread keeps the inbox queue (read at the thread's next tool step, a wake for
  an idle one): for a running thread `$.session.send` would add nothing and could deliver twice.
- **Pane.** Every section header (Goals, Answers, Projects, Threads, Closed) is a toggle button with a count (`▾ Answers (14, 2
  unread)`); the fold state lives in `$.state` (declared in `types/index.d.ts`), so it survives redraws and mod reloads. Defaults:
  Goals open when there is a goal, Answers open, Projects folded, Threads open, Closed folded. Answers show the newest 5 and "show all
  (N)"; with more than 8 rows "show all" groups them by thread (foldable, the folded group shows its newest line). A row is a button
  that expands to the full report text; unread rows come first with a dot, read ones are dimmed.
- **Pane: Close.** Each thread row has Close (first press arms "Confirm close tN" for 10 s, the second closes through
  `lean_thread close`: stops a finished-but-alive session, clears the goal, no model turn); a working thread shows "busy" instead. A
  "Close all done" button appears when 2+ threads reported done and closes only those whose last report is done and whose session is
  not working (blocked, asking and working threads stay; the check is repeated at the second press). Closed threads move to a
  collapsed "Closed (N)" with a Reopen button each. A session waiting on a prompt nobody answers (`claude agents` `waitingFor`) is
  marked "needs you: open it in the app".

### Added (desk, threads)
- **Usage-limit auto-resume** (spec: `docs/usage-limit-resume.md`). A thread session blocked by the account's usage limit (`claude
  agents --json` state `blocked` without `waitingFor`) used to sit there until someone noticed. The desk's mod (every 60 s) finds
  the reset time (the thread's own mod records the exhausted rate-limit windows at the failed turn; else the last "You've hit your
  ... limit · resets 4pm (UTC)" line of `claude logs <id>`, parsed: `4pm`, `16:00`, `(UTC)` / `(GMT+2)` / IANA zones, `Nov 20, 4pm`,
  `in 2h`; anything else is no answer), and two minutes after it stops a lingering process (`claude stop`, wait until no pid) and
  runs `claude --bg --resume <sid> -- "The usage limit reset; check your worktree state and continue."` (queued desk messages ride
  along). Once per reset (`threads/tN/limit.json` holds the mark, set before the resume; a failed start gives it back, three tries),
  never for a parked or closed thread (marked cancelled, a later reopen does not revive it), never over a working or
  permission-blocked session. The pane row says "paused until 16:00" (instead of "needs you") and keeps Close.
  `desk.autoResume: false` in `config.json` turns it off. Not yet seen on a live limit: see the spec's last section.

### Fixed (desk, threads)
- Background threads blocked silently on permission prompts nobody answers. The `worktree` skill and the thread template say to create
  worktrees with `git -C <repo> worktree add <abs path>` under `~/.lean-agent/worktrees` and never with Claude Code's EnterWorktree
  tool (it asks for a path outside `.claude/worktrees/`); the thread template adds three work rules (edit files only with Edit / Write,
  one simple command per Bash call with absolute paths and `git -C`, never `cd`, no EnterWorktree). The skills contract fails when a
  skill, template or command names EnterWorktree without forbidding it.
- A worktree or branch folder no longer lands in `projects.json`: `project-add` refuses a path that is a linked git worktree, lives
  under `~/.lean-agent/worktrees` or is in `worktrees.json` (it names the main checkout to register instead), and `lean_doctor check`
  flags an existing entry whose path is a worktree (offering `project-remove`, which never deletes files).

### Fixed (desk skills, relay)
- The `pr` skill no longer promises the desk what strict mode refuses. Every step names its role: the desk only reads status
  (`gh pr view|list|status`, `gh search prs`, `az repos pr list|show`); create, comments, update and every push are "route to the
  thread that owns the branch". The host comes from the project's origin URL: github.com uses `gh`; dev.azure.com and
  `*.visualstudio.com` use `az repos pr list|show|create|update` (REST with a PAT as the fallback); a missing or logged-out CLI is
  reported plainly instead of "command not found".
- Desk strict mode allows those read-only forms (`deskBashOk` reuses the private-project guard's own gh/az read-only classifier,
  so the two cannot drift; no `--web`, `--output-file`, `--template`, pipe, redirect or expansion) and `git -C <dir> remote get-url
  <remote>` (to find the host). `gh search` is now read-only in private projects too.
- Skills offered to the desk no longer name thread-only tools or the desk's missing Write/Edit: each step says who runs it
  (`thread: lean_report; desk: tell the user`). The `goals` skill sets and clears through new `lean_thread` actions `goal-set` /
  `goal-clear` (tN, text): two enum words in a tool the desk already has, no new tool, the mod writes the file, and it works for a
  parked or closed thread that a `send` would not wake.
- `lean_thread new` refuses a project that is not registered and answers with the known names (nothing is created); `list` shows
  each thread's project; `commands/new.md` and the `thread` skill say projects come from `lean_thread projects`.
- Reports reach an idle desk. The engine's `$.prompt.submit` starts a turn once the session is idle, so a question or a `done` /
  `blocked` report now starts ONE desk turn with the unread reports (at most once a minute, never while a turn runs, never for
  `working` progress; `desk.autoRelay: false` in `config.json` turns it off and reports wait for the user's next message). A
  refused submit marks the reports unread again.
- Finished threads are closed by the desk: the desk template and `thread` skill say "close it yourself (and clear its goal); never
  ask a thread to close itself", the thread template says a thread cannot close itself and reports done, and a delivered `done`
  report ends with "(close tN when nothing is left)".

### Added (skills roles)
- Skills declare `roles: desk, thread` in their front matter. `hooks/skills-contract.mjs` (run by `skills-contract.test.sh`) checks
  that every `lean_*` tool a skill names exists for a role the skill is offered to (and is marked where only one role has it) and
  extracts the Bash commands a skill gives the desk; `hooks/skills-roles.test.ts` runs them through `deskBashOk`.
  `hooks/skills-desk-commands.ts` is generated (`node plugins/lean-agent/hooks/skills-contract.mjs --write`).

### Added (scripts, feedback export)
- **Scripts over models.** If a simple script can do a job (counting, summing, aggregating, listing, transforming, diffing,
  validating), run it instead of a model reading the data; and any script a session fabricates is audited and judged before it
  is reused. The thread template, the worker and reader prompts, the `learn` skill and the desk template say so (2-3 lines each).
- New tool `lean_script` (thread and desk) and skill `scripts`:
  - `propose` (thread): the mod copies the script into `~/.lean-agent/scripts/candidates/<name>/` with `meta.json` (purpose, run
    with `{script}`, inputs, outputs, author, project or `global`, created, sha256) and **never executes it**. A secret in the text
    refuses the proposal. A script about lean-agent's own data (`~/.lean-agent` files) is also filed in `feedback.jsonl` as
    a "candidate for lean-agent core".
  - Nudge: when a thread's Bash runs a script file it wrote this session from a scratch place (`/tmp`, a scratchpad, its own
    folder) and nothing proposed it, the next prompt carries one line, once per file: "you ran <file>; if it is reusable,
    lean_script propose it".
  - `audit`: a thread gets the brief for the new read-only `lean-agent:auditor` agent (sonnet/high, a fixed checklist: reads,
    writes, network, deletes, secrets, hardcoded values, determinism, error handling, other data); the desk starts a thread that
    does it. The auditor ends with a `LEAN-AUDIT` line and **the mod records the verdict** when the Agent call returns, applying
    its own rules: network, deletes or overwrites, writes outside the declared outputs, hardcoded values, a home path or email in
    the text, or a script right only for its original data are never `adopt` (they become `adapt` with the concrete changes); a
    secret is `reject`. Verdicts are `adopt`, `adapt` (changes), `reject` (reason); a tampered copy (sha256) is refused. There is
    no way to hand the mod a verdict: it is taken only from an auditor's Agent reply, only for the candidate folder that call's
    prompt names, once per script content.
  - The `run` line is a bare interpreter (python3, node, bash, sh, ruby, perl ...) then `{script}`, no inline-code flags, quotes or
    shell operators; `outputs` may not be a catch-all; inputs/outputs/purpose are one line and scanned like the script; a thread
    proposes only for its own project or `global`. The store is changed under a lock folder (threads and the desk are separate
    processes; a stale lock is moved aside by one taker, a holder releases only its own) and `lean_rules sync` generates a
    script's skill from the verified meta, only while it is still adopted, still the audited text, with an audit for exactly it.
    The mod also scans the text for network and delete patterns (never `adopt`); the auditor's other claims are its judgement,
    and `decide` is the human gate. The sha-256 moved to `sha.ts` (reviews and the script store share it).
  - `adopt` moves the script to `~/.lean-agent/scripts/<name>/` or `~/.lean-agent/<project>/scripts/<name>/` and writes a recipe
    skill `lean-agent-script-<name>` with `run: <command>`; `lean_rules sync` copies it into checkouts (git-excluded).
    `list`, `show`, `retire` (kept under `scripts/retired/`); a Bash run of an adopted script is counted in `scripts/uses.jsonl`.
  - Desk: the pane shows "Scripts: N candidates, M adopted"; `lean_script decide <name> adopt|reject` (desk only, with a reason, logged in
    `scripts/decisions.jsonl`) lets the user override a verdict. Adopting over an audit that said otherwise needs `confirm: true`;
    a script with a secret or a hardcoded home path or email is never adopted, not even by the user, and a script that was never
    audited cannot be adopted.
- **Feedback export, done by the mod.** `/lean-agent-feedback [notes]` (a mod command, any session, no model turn) and the desk's
  `lean_doctor` action `export` write ONE markdown file `~/.lean-agent/feedback-export/<YYYY-MM-DD-HHMM>.md` and print its path:
  the notes, the environment (running vs installed lean-agent version with a SKEW flag, `claude --version`, OS family), the doctor's
  problem lines, every draft in `feedback-drafts/` not exported before, the LEAN-FEEDBACK since the last export (counts by status;
  the `missing` / `refused` / `unverified` / `unreached` texts grouped and de-duplicated with counts; gap lines count as `missing`),
  the guard refusals (text, agent type, counts; the mod logs each refusal it makes, `src: "guard"`, to `refusals.jsonl`: the ONE file
  and the one writer, `appendRefusal`, that also takes the refusals workers report in LEAN-FEEDBACK as `src: "worker"` rows; the
  export counts the guard rows as refusals and takes the worker rows for the `refused` texts, and reads the `unverified` /
  `unreached` texts from the feedback rows' `unverifiedClaims` / `unreachedFolders`; `core-candidate` rows are skipped), the script candidates
  flagged for lean-agent core and the threads that reported `blocked`. It is anonymised by code, deterministically: home dir and
  any user's home folder (macOS or Linux style) to `~`, the OS user name, registered project names to project-A, B ... (a stable local map in
  `feedback-export/projects.map.json`, never exported; thread ids stay), emails, URLs other than the lean-agent repo, azure
  organisations, hex of 7+ characters, numbers after PR / issue / ticket words and `#`, tokens and keys. A final check REFUSES to write
  the file when a known private string survived and names the rule that missed. Over 40 KB the oldest and least repeated items are
  summarised. The stable project-name map lives in `~/.lean-agent/.private/`, not in the export folder; scp-style remotes, IPs,
  host names, env-style credentials (`DB_PASSWORD=...`) and a registered project's folder name are masked too. It never posts and uses no network; `skills/feedback` says: a single report is a draft as before (post with `gh` only
  if installed and only on an explicit yes), "export" is this.
- **Scripts are easy to update.** An adopted script keeps versions (`scripts/<name>/v1/`, `v2/` ..., sha256, author, date and audit
  verdict per version, `current` in `meta.json`) and a stable `scripts/<name>/run` that the rule line and the recipe skill always
  name, so an update never edits a rule or a skill. `lean_script update <name>` (thread or desk; a new file or exact `edits`) stores a
  pending version with a diff and the auditor audits only the change plus the checklist; a changed purpose or run line is shown in
  the verdict and needs the desk's `decide`. On adopt `current` switches and `run` is overwritten. `rollback <name> [version]` (desk;
  a thread gives a reason) switches back at once and is logged; `diff` and `show` print versions, verdicts, uses and failures.
  A failed Bash run of an adopted script is counted, two failures (or `report-bad <name> <why>`) mark it `needs-update` (rule line,
  `list`, desk pane; the next thread that uses it is nudged once to send a fix). A script edited by hand (sha mismatch) is
  `edited, unaudited`: no skill is shipped for it, the rule line says so, a thread run is warned about, a subagent may not run it.
  Hardening: the auditor echoes the sha256 of the text it read (`"sha"` in its `LEAN-AUDIT` line, taken from the brief) and the mod
  refuses a reply that does not match the stored text, so an audit started on an older text is never recorded against a newer one;
  version numbers are never reused (not after a replaced, rejected or rolled-back update); a rollback drops the update that waits; a
  thread changes only its own project's scripts and global ones (update, rollback, report-bad, retire, as propose); the desk's
  audit thread is started after the store lock is released.
- **"Can this be a script" lives in the rules.** On adopt, and at every `lean_rules sync`, the mod writes ONE line per adopted
  script between `<!-- lean-agent:scripts -->` markers into the rule of its area (else `_project`), regenerated from the store so
  learn/trim rewrites keep it, within the rule caps (overflow goes to `_project`, then one "N more scripts" pointer); retire removes
  it. `_project` gets once the line "Prefer scripts over model work ...". A thread's `lean_report` with state `done` is asked once per
  session whether a step could have been a script. `lean_rules stats` lists `scriptCandidates`: reported gaps that read like
  mechanical work (count, list, sum, find all, which files).
- **An audit adopts on its own only when the mod proves the script clean.** An `adopt` verdict used to adopt at once, on an auditor
  prompt the thread wrote. Now (1) the auditor's prompt must be exactly the brief the mod generated and returned to the thread
  (`briefBlock`): the guard refuses any other prompt for `lean-agent:auditor` (extra instructions, a stale brief), and the mod ignores
  a verdict whose prompt differs; (2) the script adopts by itself only when the run line is on the allowlist, there is no secret or
  privacy finding, no network or delete (the auditor's answer and the mod's text scan), no write outside its declared outputs (a
  stdout-only declaration with a file write in the text is caught) and nothing hardcoded; (3) otherwise, when the auditor said adopt,
  the status becomes `audited` and it WAITS for the desk (an update waits the same way): the pane's Scripts line lists it with
  Adopt / Reject (two presses, like Close), `lean_script decide` does the same, both logged as the user's decision (adopting over
  the mod's rules needs confirm; a secret, a privacy finding or a bad run line is never adoptable). `lean_script` `list`, `show`,
  `diff` and `audit` show a thread only its own project's scripts and the global ones.
  The proof is a heuristic, not a guarantee: the text scan sends to the desk whatever it cannot see (a program the script starts,
  code built at run time, a write through a variable mode, a shell redirect, a copy, text addressed to the auditor), and for a script
  that declares files the auditor's list of writes is the only check. The pane's Adopt / Reject are bound to the sha256 of the text
  that was shown (a script proposed again under the same name between the two presses is refused), `decide` refuses a run line off
  the allowlist, and a thread cannot replace another project's script by proposing under its name.
- Review fixes elsewhere: the handover prompt of a reopen is cut by bytes as well as characters (3-byte characters could pass the
  argv limit); a submodule or `--separate-git-dir` checkout (a `.git` file that is not `.git/worktrees/...`) is no longer taken for a
  linked worktree by `project-add` and the doctor; the daily-cap cache no longer counts a row appended during its own rebuild twice;
  `lean_doctor stats` ignores a `project` that is not a plain name; the folder lock re-reads the stale token right before taking a
  dead lock over.
- Rules: `lean_rules stats` counts only the loads from the project's own checkouts (a same-named rule of another project no longer
  hides this project's never-loaded one; a project with no registered folder counts every load, as before). The script-rule rebuild
  and a learn `record` take one lock folder per project (`.rules-lock`, shared lock code in `folderlock.ts`, also used by the script
  store), so a rule is never rewritten by both at once.
- The `auditor` agent type gets the explorer's built-in read-only commands; an Agent call for it with `allow-*` lines from a
  session that cannot own grants is refused like the other agent types.

## 1.0.4

### Added
- **Push approval.** The review-gate refusal named an override that did not exist. Now the desk's `lean_thread` has
  `approve-push` (tN, full sha, reason?): a signed (same HMAC store as `lean_review`), single-use record, valid 2 hours, logged in
  the thread's `history.jsonl`; the push gate accepts it like a green review. Only the desk has the tool; the record is bound to
  project, sha and thread, consumption is kept in the mod's store (a thread that rewrites the record cannot revive it), it is
  taken atomically and only when every pushed sha is covered. It is not bound to a remote or branch, and it is consumed when the
  guard accepts the command (a push that then fails needs a new approval). The desk template says to use it only when the user explicitly approved in the chat. The refusal says
  "ask the desk: approve-push tN <sha>" and prints the manual `git -C <worktree> push <remote> <branch>`. Private projects are
  still never pushed.
- **Read-only search without Grep/Glob.** This Claude Code build has neither tool. `lean-agent:reader-*`, `reviewer` and
  `explorer` now always run `rg`, `grep`, `find` (not `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*`, `-fls`),
  `ls`, `wc`, `head`, `tail`, `cat` on paths inside `~/.lean-agent` (thread folders, worktrees) or a registered project (the session
  folder alone is no root), and pipes
  between such commands (and the built-in git reads). A strict scanner proves each pipeline plain: no redirect, substitution,
  `;`/`&`/`||`, and no unquoted glob, `{a,b}` brace expansion, word-initial tilde or `$`; quote patterns. Each command has an allow-list of flags (and `find` of predicates): any other flag, abbreviation or
  cluster letter refuses the command, so there is no `-exec`, `-delete`, `-fprint*`, `-L`/`-H`/`--follow`, `-f`/`--file`,
  `--pre`, `-z`, `tail -f`, `--files0-from`; any `..` word is refused. The desk may run the same under `~/.lean-agent`.
  The agent prompts, the learn / review / find / lean-mode skills and the templates say so.
- An Agent call for one of our agent types (`lean-agent:` or the bare name a grant also binds to) with `allow-cmd` / `allow-edit` lines from a session that cannot own grants (not a
  thread's own loop) is refused up front, with the reason.
- The worktree skill installs dependencies in a fresh worktree from the lockfile (`yarn install --frozen-lockfile` / `--immutable`
  by yarn version, `npm ci`, `pnpm install --frozen-lockfile`) through a worker and reports it; it never symlinks
  `node_modules` (borrowing only from a donor with byte-identical lockfile and `link:` / `file:` targets, and it says which),
  and it can **adopt** a worktree made with plain `git worktree add`.
- A thread can report `superseded: true` with `lean_report` (its brief was replaced by a later user message); the desk text and the
  pane row show it.
- New threads get the attribution setting in their CLAUDE.md (`attribution: off - ...`), from config.json `attribution` (default
  false); existing threads keep the file they have.

### Changed
- A session first resolved as thread tN records its id in `threads/tN/thread.json` `sids` (`sid` stays; the desk's saves keep ids
  written meanwhile), so a later start from any folder resolves by id; a closed thread or an id held by two records matches nothing. Every refusal of a role-bound tool says the tool, the role, where the session started and what
  its id matched.
- A tidy, once per version and also on `migrate`, runs for everyone, also on 1.0.x: `CLAUDE.md` guides that mention lean-agent and 1.0
  did not write, above a thread or worktree folder or under a project folder (the 0.45 ones tell threads to use the removed CLI),
  and `current-thread.json` (written by the 0.45 CLI; 1.0 never reads it) move to `legacy-0.45/` (an earlier backup is never
  overwritten). A user's own notes that do not mention lean-agent stay. `lean_doctor check` flags such files, also a per-thread
  one (that one is moved by hand).

## 1.0.3

### Fixed
- A subagent whose type cannot be read is `unresolved` (was `unknown`): a reader with no grants, refused with "agent type
  unresolved" so it can be reported; the debug log line `agent fields` shows what the engine gave. Verified live: the engine's
  AgentInfo carries `type: "lean-agent:explorer"`, which resolves, and the explorer ran `git ls-files` and `git log` with no grant.
  `git -C <dir>` for the built-in git commands may point into the session folder, `~/.lean-agent` and registered projects.
- A thread or desk keeps its role. A Bash `cd` into the repo no longer demotes it to plain (so `lean_rules` works after a
  `cd`, and the desk stays in strict mode wherever it moves); only plain -> desk/thread is promoted on a folder change. A
  session whose id is a thread's `sid` is that thread from any folder, and a thread/desk tool that would refuse looks the role
  up once more first. The learn skill and thread template say to use `git -C <repo>` instead of `cd`.
- Readers no longer depend on the brief for read-only git. `lean-agent:explorer` can always run `git ls-files` and `git log`;
  `lean-agent:reader-*` and `lean-agent:reviewer` can always run `git log`, `ls-files`, `show`, `diff`, `status` and `rev-parse`
  (a learn thread reported Bash refused for `git ls-files` / `git log`). Read-only by construction: one plain command, no redirect,
  pipe, quote-wrapped `; | < >`, expansion, brace, tilde or glob (`{ } ~ $ * ? [`; use Glob for patterns), no `-c` / `--config-env` / `--exec-path`, no `--output` / `-o` on log, diff and show, no `--ext-diff`,
  one absolute `-C <dir>` only inside the session folder, `~/.lean-agent` or a registered project (no `..`). `allow-cmd` grants still add on top; `other:explorer` and a bare `explorer` get nothing built in. Residual risk, accepted: the repo's own config can run programs for `status` / `diff` / `show` (fsmonitor, textconv), and `status` refreshes `.git/index`.
- The learn skill's explorer brief lists the area folders and points at Glob/Grep; the explorer prompt and the thread
  template say what is built in.

## 1.0.2

### Added
- Model and effort are pinned. The desk folder's `.claude/settings.json` gets `model: sonnet`, `effortLevel: high` (setup /
  `lean_doctor fix`, merged into an existing file; `lean_doctor check` reports a missing or different value; config.json
  `desk.model` / `desk.effort` override). Threads start with `--model sonnet --effort medium` instead of the user's default
  model (config.json `threads.model` / `threads.effort`, or `model` / `effort` on `lean_thread` `new` / `start`); the choice is
  recorded in `thread.json`, written to the thread folder's settings, and shown in `list` and the pane row. A resume passes
  no flags. The plugin's agents set `effort` (workers haiku low / sonnet medium / opus high, readers and explorer low, reviewer medium).
- The desk can answer "what projects do we have?": `lean_thread` gets `projects` (path, private, guards, learned rules with
  areas / last learned / stale, open threads; private projects hidden by the 0.45 private switch only with `all: true`),
  `project-add` (existing folder, real path), `project-remove` (unregisters only, refused while a thread uses it) and
  `project-private`. The desk pane has a compact Projects section, and the desk's CLAUDE.md says the desk may Read files
  under `~/.lean-agent`. A damaged `projects.json` is never overwritten; writes are serialised; a private project cannot be
  removed, and turning private off needs `confirm: true` (the desk asks the user first).
- The desk records what happened to its skill listing ("trimmed 5 -> 2", "format not recognised", "no skill_listing
  attachment seen"; names and counts only, never text) and shows it in the pane footer and in `lean_doctor check`, with the
  attachment and section names seen this session, so a report needs no debug log.

### Fixed
- The plugin's subagents are named with the plugin prefix in the Agent tool (`lean-agent:worker-sonnet`, `lean-agent:reviewer`,
  ...). The guard matched `/^worker-/`, so a real worker counted as a reader and could not edit even with an `allow-edit`
  grant. Only a type with exactly a leading `lean-agent:` is ours now (`lean-agent:worker-*` = worker; a bare `worker-x`
  from a user/project agent and another plugin's `x:worker-y` are readers). Grants bind with either spelling, `workerCaps`
  keys may be `worker-opus` or `lean-agent:worker-opus`, stats and feedback merge both spellings, and the templates, skills
  and README name the agents with the prefix. The spawned type is read from `AgentInfo.type` (what `$.agent.list()` names it);
  the code read `subagentType`, which that row does not carry, so every subagent counted as an unknown reader.
- **Open desk** no longer says "The Claude app is not running" inside the Claude app: a pane drawn on the desktop surface
  skips the check. Elsewhere the check calls `/usr/bin/pgrep` (`-x Claude`, then `-f` on the app binary path), and if the
  check itself errors `claude --desktop` is tried anyway and its real error is shown. The login opener uses the same two checks.
- Thread resume ran `claude --bg --resume <sid> -n <label> -- <prompt>`; any extra flag makes the CLI start a copy of the
  session. It now passes only `--resume <sid> -- <prompt>`. That continues the session itself only once its process has exited:
  a finished session whose process is still alive (listed with a pid, state done) is stopped first (`claude stop`, then
  waited for), a working one is never stopped or resumed (the listing is read again right before the stop). Closing a thread also stops a finished session that still has its process. If the CLI still prints "started a copy as <id>" the thread
  follows the copy (when the id names exactly one listed session) and the result says so.
- The desk's skill-listing trim did not take effect on a real Mac: the engine caches `prompt.attachment`, and a listing built
  while the session was still in its spare folder (role not yet the desk) stayed. The role change now asks for the
  attachments, sections and tool descriptions again. The filter also accepts renamed listing types (any name holding
  "skill"), backticked and `*` bullets, and a listing in the Skill tool's description; an unknown format is still left untouched.
- On the desk, the agent listing (`agent.offer`) and MCP-instructions sections/attachments are left out; the desk never spawns subagents.
- Closing a thread ran the nonexistent `claude agents stop <sid>`; it now runs `claude stop <id>` (first 8 chars of the sid).

## 1.0.1

### Added
- Setup without a model turn: `/lean-agent-setup` (check + fix, any session) and a **Set up lean-agent** button in the
  `/lean-agent` pane, which now works in every session (it opens by itself only in the desk): setup first, **Open desk** in a session that is not the desk,
  **Setup / repair** in the desk. One code path with `lean_doctor fix`.

### Changed
- The desk's tool pool is cut to the tools strict mode can allow (plus lean-agent's own), its skill listing to lean-agent's
  skills: far less context before the first message. `tools.desk.drop` still applies on top; threads and plain sessions are unchanged.

### Fixed
- A desk (or thread) session the Claude app pre-starts in a spare folder and then moves into the chosen folder now gets
  its tools, timers and git hooks: the role is decided again when the directory changes (`CwdChanged`, checked lazily at
  each turn and prompt too).
- Session start is fail-soft: one failing setup step no longer stops tool registration.
- `tool.list` now answers the engine's `{ value }` shape, so `tools.<role>.drop` takes effect.

## 1.0.0

One major release: lean-agent is now pure Claude Code.

### Changed
- The desk is a local Claude desktop session in `~/lean-agent-desk`; threads are `claude --bg` sessions, one folder each.
- Learned project knowledge is path-scoped rules (copied into `.claude/rules/lean-agent/`, git-excluded) instead of cards.
- Recipes are project skills. Budgets are cost-only. Threads run with an allow-list (Edit/Write inside the lean-agent folder, which holds their worktrees; Bash); `git push` needs a signed green review in registered projects only, shared branches are never force-pushed, and private projects are never pushed or published (an allow-list: only read-only gh/az calls pass, found anywhere in the command, unparsable commands are denied).
- A login opener (`com.lean-agent.desk`) waits for the Claude app and opens the desk; it never launches the app.
- New `doctor` skill and `lean_doctor` tool: check, fix, migrate.

### Removed
- The `lean-agent` CLI, all Python scripts, the hosted desk and Remote Control hosting without the app, desk switching,
  the `com.lean-agent.up` service, plan-window percentages and the hosted Live Map.
- Linux support: 1.0 is macOS-only (it needs the Claude desktop app). Linux users stay on 0.45.

### Migration from 0.45
- Automatic: the first session the 1.0 mod starts (any local session) unloads a leftover 0.45 service at once
  (`launchctl bootout`; `systemctl --user disable --now` for a Linux unit) so it cannot crash-loop after
  `claude plugin update` removed its files, then runs the idempotent migrate. If that fails the status line and the
  pane say "lean-agent 1.0: run migrate in the desk". Details are logged in `~/.lean-agent/logs/migrate.jsonl`.
- All open 0.45 threads are closed (a list is kept in `~/.lean-agent/legacy-0.45/`);
  goals, questions, recipes and the other state are converted or kept; cards are archived and re-learned with `learn`.
- The old service is unloaded and the old `lean-agent` command shim is removed.
- Kept from 0.45: plain pushes to `main`, `master`, `develop` and `release/*` (or a project's own `guards.push-deny` in
  `projects.json`) are refused at the shell level and in the pre-push hook; overrides: `LEAN_AGENT_PUSH_GUARD_OVERRIDE=1`, and
  pushes to a local path / `file://` URL are not checked. Residual risk (documented): a push hidden in `python -c`
  is not parsed by the shell guard; the pre-push hook is the backstop.

See `docs/design-1.0.md`.
