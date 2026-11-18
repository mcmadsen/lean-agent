# Changelog

## Unreleased

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

### Fixed
- Background threads blocked silently on permission prompts nobody answers. The `worktree` skill and the thread template say to create
  worktrees with `git -C <repo> worktree add <abs path>` under `~/.lean-agent/worktrees` and never with Claude Code's EnterWorktree
  tool (it asks for a path outside `.claude/worktrees/`); the thread template adds three work rules (edit files only with Edit / Write,
  one simple command per Bash call with absolute paths and `git -C`, never `cd`, no EnterWorktree). The skills contract fails when a
  skill, template or command names EnterWorktree without forbidding it.
- A worktree or branch folder no longer lands in `projects.json`: `project-add` refuses a path that is a linked git worktree, lives
  under `~/.lean-agent/worktrees` or is in `worktrees.json` (it names the main checkout to register instead), and `lean_doctor check`
  flags an existing entry whose path is a worktree (offering `project-remove`, which never deletes files).

### Fixed (earlier in this release)
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

### Added
- Skills declare `roles: desk, thread` in their front matter. `hooks/skills-contract.mjs` (run by `skills-contract.test.sh`) checks
  that every `lean_*` tool a skill names exists for a role the skill is offered to (and is marked where only one role has it) and
  extracts the Bash commands a skill gives the desk; `hooks/skills-roles.test.ts` runs them through `deskBashOk`.
  `hooks/skills-desk-commands.ts` is generated (`node plugins/lean-agent/hooks/skills-contract.mjs --write`).

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
