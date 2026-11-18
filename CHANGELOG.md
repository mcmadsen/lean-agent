# Changelog

## Unreleased

Learn flow (the 1.0.6 work; the version lines in `plugin.json`, `marketplace.json` and `pane.tsx` are left to the desk, which also
builds 1.0.5).

### Fixed
- **Version skew is visible.** A session keeps the hooks module it loaded at start, while skills, agents and templates are read from
  the plugin folder again after `claude plugin update`: the skill text could say 1.0.4 while the guard refused like 1.0.3 (an explorer
  was refused `rg`, `ls` and `cat`). The mod now compares its own version with the installed one (the plugin root's
  `.claude-plugin/plugin.json` and Claude Code's `installed_plugins.json`, the higher wins; cached for a minute) at `session.start`
  and every `turn.start`: a status line and one `prompt.compose` line say "lean-agent code X is running but Y is installed: start a
  new session (threads: close and Start)". `lean_doctor check` reports it as a FIX row. Every refusal of the guard (`decide`) ends with
  "(lean-agent <running version>)", and `feedback.jsonl` rows and `refusals.jsonl` carry the running version.

### Added
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
  caps) reads all `ledger*.jsonl`. New rows leave out zero token counts (about 100 bytes shorter; a missing number reads as 0).
- **Rule loads are counted again.** `lean_rules stats` showed no load for rules that had loaded. The `InstructionsLoaded` shell hook
  was the only path, so the mod now also logs `classic.InstructionsLoaded` itself into the same log; a load seen by both counts once,
  and `_project.md` is listed (it was left out of "never loaded"). Not checked on a live Claude Code session in this work (a nested
  session was not allowed): confirm with a learned rule and a Read of a matching file.
- **Unexpected models are visible.** The stats table shows role x model, and `lean_doctor check` lists spend today of the desk on a
  model other than the one lean-agent pins, of threads on a model no thread was started on, and live sessions
  (`claude agents --json`, when it reports a model) that differ from what lean-agent started. Those rows need a new session, not a
  setup press.

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
