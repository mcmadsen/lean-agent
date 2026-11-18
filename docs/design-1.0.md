# lean-agent 1.0.0 design: pure Claude Code

Status: design, 2026-11-18. Replaces 0.45.x. One major release.

## 0. Decisions this design is built on (final)

- One release, **1.0.0**. No 0.46 step.
- **Pure Claude Code.** No `bin/lean-agent`, no `scripts/*.py`. Everything is a plugin: skills, slash commands,
  subagent definitions, a TypeScript mod (function hooks), plain JSON/JSONL state files, and CLAUDE.md files.
- **Desk** = a local Claude Desktop session in the desk folder. It learns its job at startup from that folder's
  CLAUDE.md and from the plugin (skills, commands, mod).
- **Threads** = background sessions (`claude --bg`), one folder each, started and resumed by desk skills through Bash
  (or by mod tools/pane buttons through `$.process.run`). They are visible in the Claude app.
- **Login opener** only opens the desk: wait for Claude Desktop (never launch it), then `claude --desktop` in the desk
  folder. After a reboot no thread starts; the pane offers Resume / Start for the last running threads.
- **Dropped:** Remote Control hosting without Desktop, the hosted desk, desk switching, the `up` service.

Verified on the Mac (Claude Code 2.1.327, see notes-desktop-major.md): `--desktop` takes no prompt and opens a draft;
`claude --bg -n <name> "<prompt>"` runs autonomously; `claude --bg --resume <sid> "<msg>"` from the session's own
folder continues the same conversation; resuming a *running* session forks a copy; `claude agents --json [--all]
[--cwd]`, `stop`, `logs`, `attach` exist; bg sessions show in the app; the trust dialog uses the real path.

Mod API used (from ref/types/claude-code.d.ts): `tool.call` (deny / answer / post-process a tool), `tool.list`
(drop tools), `prompt.submit` and `prompt.compose` (inject context), `session.start` (role detection,
`$.tool.register`), `turn.start` / `turn.step` (per-request usage, `e.agentId` for subagents, can refuse a request) /
`turn.complete` (observe answer; cannot continue a turn), `session.receive` / `session.send` (peer messages),
`ui.render` + `ui.press` (pane), `ui.status` / `ui.notify`, `$.fs`, `$.process.run|spawn`, `$.clock.every|after`,
`$.state`, `$.store`, `$.agent.register`, `$.http.fetch`, `$.session.usage`.

## 1. Feature inventory

Legend: **KEEP** (how in pure Claude Code), **CHANGE** (what changes), **DROP** (why).
"mod" = the plugin's TypeScript hooks module; "skill" = `skills/<name>/SKILL.md`; "agent" = `agents/<name>.md`.

| # | Feature today | Verdict | 1.0 form |
|---|---|---|---|
| 1 | Front desk rules (route, never work, tables, AskUserQuestion for anything waiting on the user) | KEEP | `desk/CLAUDE.md` generated from `templates/front-desk.md`, rewritten for skills instead of CLI lines |
| 2 | Strict mode for the desk | KEEP | mod `tool.call` guard, only when `session.cwd` is the desk folder (see 2.6) |
| 3 | `thread new` | KEEP | skill `thread` (+ `/lean-agent:new`): creates `threads/tN/`, writes `brief.md`, runs `claude --bg -n "tN · title"` |
| 4 | `thread send` | KEEP | skill `thread`: append to `threads/tN/inbox.jsonl`; wake if idle (2.4) |
| 5 | thread report back to the desk | KEEP | mod tool `lean_report` registered in thread sessions; writes `desk/inbox.jsonl` |
| 6 | `thread close` / `reopen` / `park` | KEEP | skill `thread`: flip `thread.json.state`; close = `claude stop <id>` (the first 8 chars of the sid) if running; reopen = Resume |
| 7 | `thread list` / status table | KEEP | skill `thread` reads `threads/*/thread.json` + `claude agents --json --all` |
| 8 | Clearing / compaction of threads | CHANGE | Claude Code's own auto-compaction; mod `session.compact` writes `notes.md` first so Resume/Start can rebuild |
| 9 | `lean-agent run` workers with model choice | CHANGE | subagents: `agents/worker-haiku.md`, `worker-sonnet.md`, `worker-opus.md` (model + tools), called by threads via the Agent tool |
| 10 | read-only workers (`--read-only`, `--allow-cmd`) | CHANGE | `agents/reader-*.md` with `tools: Read, Grep, Glob` (+ Bash only with a mod `tool.call` allowlist keyed on `e.agentId`) |
| 11 | `--allow-edit` path grants | CHANGE | mod `tool.call` on Edit/Write for subagents: allow only paths in the grant written by the thread to `$.state` |
| 12 | Worker cards (`--cards`, `suggest`, card selection per task) | DROP | replaced by native path-scoped rules (2.8): a rule loads by itself when a session or subagent reads a matching file, so no selection step, no `lean_cards` tool |
| 13 | `learn` / `unlearn` / `projects` / `cards` / `optimize` / `card shorten` | CHANGE | `/lean-agent:learn` skill + `agents/explorer.md` write small `paths:`-scoped rule files (2.8); `unlearn` removes the link; `optimize` = `learn --trim`; `projects` = `projects.json` |
| 14 | `LEAN-FEEDBACK` line + card stats | CHANGE | mod `turn.complete` (`e.agentId`) parses the worker's last line: `missing` -> `<project>/gaps.jsonl` (input for the next learn), `remember` -> `memory/`. Card stats -> rule-load stats from the `InstructionsLoaded` hook (2.8) |
| 15 | Budgets per run (`--max-reads`, tokens, timeout, escalate) | CHANGE | mod `turn.step` per `agentId` sums `usage`; over budget -> answer without `next` (no request) and a notice. Escalation = thread re-runs with a bigger agent (rule, not code) |
| 16 | Recipes / `do` | CHANGE | become project skills: `~/.lean-agent/<project>/skills/<name>/SKILL.md`, linked into checkouts like the rules (2.8) so Claude Code lists and runs them natively; `recipe` skill dropped |
| 16a | `suggest` (pick model/cards for a task) | DROP | the thread picks the worker agent by the rule in its CLAUDE.md; context comes from path rules |
| 17 | `runs` / `runs --wait/--lost/--resume` | DROP | the Agent tool is synchronous inside a thread; no detached worker processes to track |
| 18 | `review` + reviewer quality gate | KEEP | skill `review` + `agents/reviewer.md` (opus, read-only); result `~/.lean-agent/<project>/reviews/<sha>.json` |
| 19 | Review passes / fix loop (full, then deltas) | KEEP | skill `review` keeps `passes.json` per branch; delta mode passes the last reviewed sha |
| 20 | Learn from reviews | KEEP | skill `review-learn` via `gh`: excludes only the owner's own comments (owner login from `gh api user`); marker match is the fallback |
| 21 | Push gate (review before push) | KEEP | mod `tool.call` on Bash `git push`: deny unless `reviews/<HEAD sha>.json` is green |
| 22 | Worktrees + shared worktrees | KEEP | skill `worktree` (git worktree under `~/.lean-agent/worktrees/<project>/<branch>`), registry `worktrees.json` |
| 23 | Push guard (protected branches, never `--force` to shared) | KEEP | same mod `tool.call` Bash guard as 21 |
| 24 | Private projects (never push/publish) | KEEP | `projects.json` `private: true`; mod denies every Bash command in their paths that contains a `gh`/`az` call not on the read-only allow-list (found anywhere in the text, also in `bash -c`, `$(...)`, subshells), plus `git push` and `git remote add|set-url`; unparsable commands are denied; read-only `gh pr view|list|diff|checks|status`, `gh issue view|list`, `gh api` GET and `az ... list|show` pass |
| 25 | Goals + chaser/watchdog | KEEP | `goals.json`; desk mod `$.clock.every(60s)` marks stale goals, wakes the owning idle thread with a "status?" message, shows red in the pane |
| 26 | myq / waiting / answers / inbox | KEEP | thread mod tool `lean_ask` -> `questions.jsonl`; desk asks with AskUserQuestion; answer goes to the thread inbox; pane "Answers" with ack |
| 27 | Dialog hook (AskUserQuestion bookkeeping) | KEEP | mod `tool.call` on AskUserQuestion: after `next(e)` records the answer against the open question ids |
| 28 | todos | KEEP | `todo.json` + skill `todo` (add/list/done) |
| 29 | memory / `remember` / shared memory | KEEP | mod tool `lean_remember`; mod `prompt.compose` adds a short `session` section with the project's memory to threads and workers |
| 30 | handoff notes / handovers | KEEP | skill `handover` writes Markdown files as today |
| 31 | Plan usage windows (Pro/Max) | CHANGE | mod reads `$.session.usage` + `turn.step.usage`; plan-window % only if a source is verified (R6), else dropped |
| 32 | Cost tracking / `stats` / `budget` / `savings` / `week` | CHANGE | mod appends `ledger.jsonl` from `turn.step` (model, tokens, agentId, thread); skill `stats` summarizes; `savings --measure` dropped |
| 33 | Budget gate on the desk/threads (`budget_hook`) | KEEP | mod `turn.step`: daily/plan cap from `config.json`; refuse requests above it with a notice |
| 34 | compare / context trimming (`context`, MCP presets, `mcp_trim`) | CHANGE | mod `tool.list` drops tools/MCP tools per role from `config.json`; presets = agent `tools:` lists. `compare` dropped |
| 35 | Output squeezing (`lean-sq`, squeeze_hook) | KEEP | mod `tool.call` on Bash: after `next(e)` squeeze a long result, save full output to `~/.lean-agent/output/`, return the short form |
| 36 | doctor | KEEP | skill `doctor` (+ `/lean-agent:doctor`): checks plugin enabled, desk folder trust, opener loaded, `claude agents` works, `gh` auth, state files parse |
| 37 | update / sync / self-update | CHANGE | `claude plugin update lean-agent` (marketplace); doctor shows the version. `sync` and self-update dropped |
| 38 | feedback | KEEP | skill `feedback`: drafts an issue text; posting needs the user's OK |
| 39 | map / pane / statusline | CHANGE | one pane in the desk (2.5); `ui.status` line in threads; SVG map / `--watch` dropped |
| 40 | Desk switching / hosted desk / `desk status` / auto mode | DROP | the desk is always the local Desktop session; no other host |
| 41 | `up` service, Remote Control hosting, `service install` | DROP | replaced by the login opener (3) |
| 42 | PR helpers (`pr tN`, PR state rows) | KEEP | skill `pr` using `gh`; desk table template unchanged |
| 43 | Branch names (`branch-name`) | KEEP | skill `branch` rule text (no prefix `lean/`, `--type`, task id) |
| 44 | Attribution asked once | KEEP | `config.json` `attribution`; the thread CLAUDE.md states it |
| 45 | schedule | CHANGE | desk mod `$.clock` reads `scheduled.jsonl`, sends the message to a thread at its time (only while the desk runs) |
| 46 | find / grep-log / output / text-len | CHANGE | `find` = skill over `~/.lean-agent` with Grep; `output`/`grep-log` = Read/Grep on saved output; text-len dropped |
| 47 | advise | DROP | project know-how is in path rules that load when the files are read; routing is the desk's job |
| 48 | Browser tasks / draft-first | KEEP | thread CLAUDE.md rule (draft, then ask) |
| 49 | MCP servers in workers (`mcp-env`, `mcp preset/check/ignore`) | CHANGE | agent `tools:` names `mcp__server__tool`; `mcp check` folded into doctor |
| 50 | Sign-in handling (`lean_auth`) | DROP | bg sessions use the app's sign-in |

## 2. Architecture

### 2.1 Folders and state

```
~/.lean-agent/
  desk/                     desk STATE (inbox.jsonl, inbox-read.json, pane-ack.json, notes.md); the desk FOLDER is ~/lean-agent-desk
                            (CLAUDE.md generated by the mod at session start; strict mode is enforced by the mod's tool.call guard, not by settings)
    inbox.jsonl             thread -> desk messages (reports, questions)
  threads/tN/               thread folder (cwd of the bg session tN)
    CLAUDE.md               thread rules (from templates/thread.md) + project pointer
    brief.md                the request as the desk wrote it
    thread.json             {id, title, project, state: open|parked|closed, sid, sids[], started, last_turn}
    inbox.jsonl             desk -> thread messages {id, ts, text, consumed_ts?}
    notes.md                thread's running notes (written before compaction and on close)
  <project>/                rules/ (learned, 2.8), skills/ (ex-recipes), learn.json, gaps.jsonl,
                            reviews/, passes.json, handovers/ (as today)
  projects.json goals.json questions.jsonl todo.json worktrees.json config.json ledger.jsonl
  memory/  output/  logs/opener.log
```

Writes are append-only JSONL or write-temp-then-rename JSON through one mod helper (no lock files; one writer per
file except `ledger.jsonl`, which is append-only).

### 2.2 What the desk learns at startup

- `desk/CLAUDE.md`: role, routing rules, table template, "use the `thread` skill", "anything waiting on the user is an
  AskUserQuestion". About 60 lines (today's front-desk.md minus CLI lines).
- The plugin (user scope, enabled in `~/.claude/settings.json`), loaded by local Desktop sessions and bg sessions:
  - skills: `thread`, `goals`, `todo`, `review`, `review-learn`, `worktree`, `learn`, `pr`, `branch`, `handover`,
    `stats`, `doctor`, `feedback`, `find`.
  - commands: `/lean-agent` (toggle pane), `/lean-agent:new`, `/lean-agent:threads`, `/lean-agent:doctor`.
  - agents: `worker-haiku|sonnet|opus`, `reader-haiku|sonnet`, `reviewer`, `explorer`.
  - mod `hooks/register.tsx`: `session.start` decides the role from `session.cwd`: desk folder -> **desk**,
    `threads/tN` -> **thread tN**, anything else -> **plain** (only squeeze, push guard, ledger).
- Skills the desk must not use (review, worktree, learn) say so in their first line; strict mode enforces it.

### 2.3 Messaging desk <-> threads

Desk -> thread (`thread` skill, step "send"):
1. Append `{id, ts, text}` to `threads/tN/inbox.jsonl`.
2. Is tN running? `claude agents --json --cwd ~/.lean-agent/threads/tN` (2.4). Running -> done (the thread's mod
   delivers it). Idle -> wake it (2.4).

Thread side (thread mod), "consume" = mark `consumed_ts`, deliver once:
- `tool.call` (every tool, main loop only, `!e.agentId`): `const r = await next(e)`; if unconsumed messages exist,
  return `r` with the batch appended to the tool result: `[lean-agent] message from the desk: ...`. This reaches a
  busy thread at its next tool call.
- `prompt.submit`: a resumed turn's prompt is the batch itself; the hook marks those ids consumed (the wake prompt
  carries `<!-- lean:ids=... -->`).
- Turn end: `turn.complete` cannot extend a turn. A message that arrives after the last tool call stays unconsumed;
  the desk mod's sweep (every 10 s: unconsumed inbox + thread not running) wakes it. No Stop command hook needed.

Thread -> desk:
- mod tools registered at `session.start` in thread role: `lean_report(text, state)`, `lean_ask(question, options)`,
  `lean_goal(update)`, `lean_remember(text, project)`. Each appends to `desk/inbox.jsonl` / `questions.jsonl` /
  `goals.json`.
- Desk mod delivery: `tool.call` (desk busy) appends like above; `prompt.submit` (user types) adds pending reports
  as `context`; while the desk is idle: `ui.notify` + the pane's count. Optional, if verified (R4): `$.session.send`
  to the desk's session id so the report arrives as a peer message (`session.receive`) and starts a desk turn.

### 2.4 Starting, waking, detecting threads

- Start: `cd ~/.lean-agent/threads/tN && claude --bg -n "tN · <title>" "$(cat brief.md)"`. The sid comes from
  `claude agents --json --cwd .` (newest entry) and is written to `thread.json`.
- Wake an idle thread: `cd ~/.lean-agent/threads/tN && claude --bg --resume <sid> -- "<batch>"`.
  The new sid (if `claude agents` lists a new one) is appended to `sids[]`; `sid` = the latest.
- Never resume a running thread (it forks a copy). Running = an entry in `claude agents --json --cwd <folder>` with a
  running state, cross-checked by the thread mod's heartbeat (`thread.json.last_turn`, written at `turn.start` /
  `turn.complete`). One wake at a time per thread: the desk mod holds a `$.state` flag per tN for 30 s.
- Who runs these: the `thread` skill (Bash, allowed in desk settings) and the pane buttons (`$.process.run`, argv
  form, no shell). Both go through one mod tool `lean_thread(action, tN, text?)` so the logic exists once: the skill
  just calls the tool.

### 2.5 The pane (desk only)

`ui.render` in desk role; refresh `$.clock.every(5 s)` while visible; data read directly from files (no CLI call).

- **Goals**: open goals, newest first; green working / amber waiting on you / red stuck / dim quiet.
- **Answers**: answers and reports, unread first, `ack` per row and `ack all` (`ui.press` -> mark read).
- **Threads**: open threads with state (running / idle / parked) and last line. For threads running before the last
  shutdown (`thread.json.state = open` and not running now): **Resume** (`--resume <sid>` with "Continue from your
  notes and inbox.") and **Start** (fresh `--bg` with `brief.md` + `notes.md`, for when the old session is gone).
- Footer: plugin version, last refresh, last error, budget today.
Threads have no pane; their status line (`ui.status`) shows tN, budget used, unread inbox.

### 2.6 Strict mode (desk)

Mod `tool.call` in desk role, registered with `.catch(($, e, next) => next.called ? next(e) : { deny: "lean-agent guard failed" })`
so it fails closed:
- deny Edit, Write, NotebookEdit, Agent/Task, WebFetch; Read/Grep/Glob only under `~/.lean-agent`;
- Bash only for `claude --bg`, `claude agents`, `gh pr view|list`, `git -C <p> log|status` (read-only), else deny with
  "route this to a thread (thread skill)";
- the `lean_thread` / goal / todo tools are allowed.
Same mechanism in threads for push guard / private projects and in workers for read-only and `--allow-edit`.

### 2.7 Budgets and cost

- `turn.step` (main and subagents, `e.agentId`): after `next(e)` read `usage` -> append to `ledger.jsonl`
  `{ts, role, tN, agentId, agent type, model, in, out, cache_read, cache_write, usd}` (price table in the mod).
- Per-worker cap: thread sets `$.state` `budget[agentId]` when the Agent call starts (`tool.call` on Agent knows the
  subagent type and the thread's requested cap); `turn.step` refuses once exceeded and the worker ends with a notice.
- Daily cap per role from `config.json`; the pane footer shows today's spend; `stats` skill summarizes the ledger.
- Plan window %: `$.session.usage` first; if it exposes no plan window, see R6.

### 2.8 Learned project rules (replaces cards, advise, suggest)

**Native mechanism (verified in the installed Claude Code 2.1.327 and its types).** Besides the root `CLAUDE.md`,
Claude Code loads instruction files lazily: a nested `CLAUDE.md` in a subfolder loads when the session works under that
folder (`load_reason: "nested_traversal"`), and a `.claude/rules/*.md` file with `paths:` frontmatter loads only when
the session reads or edits a file matching one of its globs (`load_reason: "path_glob_match"`, the globs reported in
`globs`). A rules file without `paths:` is always loaded. The `InstructionsLoaded` command-hook event reports every load
(`file_path`, `load_reason`, `globs`, `trigger_file_path`). Format:

```markdown
---
paths:
  - "services/billing/**/*.ts"
  - "services/billing/**/*.sql"
---
# billing
- Test: `pnpm --filter billing test -- <file>`; integration tests need `docker compose up db` first.
- Money is integer cents (`Cents` type); never use float arithmetic.
- Gotcha: migrations run in filename order; new files get the next number from `migrations/INDEX`.
```

So a worker that reads `services/billing/x.ts` gets exactly the billing rule and nothing else: the same token saving as
selected cards, with no selection call and no `lean_cards` / `advise` / `suggest` step.

**Where the rules live: options compared.**

| Option | Loads natively | Files in the repo | Worktrees | Verdict |
|---|---|---|---|---|
| A. Real files in `<repo>/.claude/rules/` (committed) | yes | yes, visible, team-shared | come with git | only on request (`commit` mode) |
| B. Nested `CLAUDE.md` in subfolders | yes | yes, scattered in every area | come with git if committed | no: litters many folders, clashes with the team's own CLAUDE.md files |
| C. `~/.lean-agent/<project>/rules/` COPIED as real files into `<repo>/.claude/rules/lean-agent/` + `.git/info/exclude` (R9: a symlinked dir does not load) | yes | real files, invisible to git | the worktree skill syncs the copy into each worktree; `info/exclude` is shared by all worktrees | default before R9 (superseded: rules are copied, see the decision in 2.8) |
| D. Additional directory (`--add-dir` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`) | loads that dir's rules, but `paths:` would match files of *that* dir, not the repo | none | n/a | no: path scoping breaks |
| E. User rules `~/.claude/rules/*.md` | yes | none | n/a | no: loads in every project; relative globs would fire in the wrong repo |

Pick **C**: lean-agent owns the source of truth outside the repo, nothing appears in `git status`, nothing gets
committed by accident, and path scoping works because the link sits in the repo's own `.claude/rules/`. A project can
opt into **A** (`projects.json` `"rules": "commit"`): learn then writes the same files as real files for the team to
review and commit. Private projects default to C as well.

**How `/lean-agent:learn <project> [--area <dir>] [--trim]` produces them** (run in a thread, never the desk):
1. The skill lists areas: top-level packages/services from the workspace manifest (`package.json` workspaces,
   `go.work`, `Cargo.toml`, `pyproject`), else first-level source folders; skips areas already covered by the repo's
   own CLAUDE.md / `.claude/rules` (no duplicates).
2. Per area one `explorer` subagent (`agents/explorer.md`: model haiku or sonnet, tools Read, Grep, Glob and Bash
   limited by the mod to `git log|ls-files`, read-only manifests). It returns at most ~25 lines: build/test/lint
   commands for that area, conventions that are not obvious from the code, gotchas (from `gaps.jsonl`, review
   comments learned by `review-learn`, and `memory/` entries for that path).
3. The skill writes `rules/<area>.md` with `paths:` globs for the area and a footer
   `<!-- lean-agent: learned <sha> <date> sources: <globs> -->`, plus one always-loaded `rules/_project.md` of at most
   10 lines (how to build/test the whole repo). Caps: 25 lines per rule, 40 rule files; the mod refuses Writes outside
   `~/.lean-agent/<project>/rules/` during learn.
4. Links it (`ln -s ~/.lean-agent/<project>/rules <repo>/.claude/rules/lean-agent`, `echo .claude/rules/lean-agent >>
   .git/info/exclude` once) and records `learn.json` `{sha, areas: {area: {globs, sha, lines}}}`.
`--trim` rewrites rules that loaded often but were flagged in `gaps.jsonl`, and deletes rules that never loaded in
30 days (stats below).

**Freshness.**
- On demand: `/lean-agent:learn <project> --area <dir>`; the desk routes "re-learn X" to a thread.
- Changed-file trigger: the thread mod at `session.start` (and the worktree skill after a pull) runs
  `git diff --name-only <area sha>..HEAD` per area; areas whose source globs changed in more than N files (default 15)
  or whose build manifest changed are marked stale in `learn.json`, shown in the pane, and the thread gets one line
  "rules for billing are stale: re-learn when you touch it". No automatic background re-learn (it costs tokens).
- Feedback: a worker's `LEAN-FEEDBACK missing` naming a path goes to `gaps.jsonl`; three gaps for one area mark it stale.
- Stats: an `InstructionsLoaded` command hook in `hooks.json` (one line: `cat >> ~/.lean-agent/logs/rules-loaded.jsonl`)
  logs which lean-agent rules load and for which file; `stats` and `--trim` read it.

**How threads and subagents get them.** Nothing to do: a thread or worker that reads `services/billing/x.ts` in the
checkout or a linked worktree gets `billing.md` from Claude Code itself (R10, R11 verify subagents, bg sessions and
worktrees). The thread CLAUDE.md says only: "project rules load when you read files; do not paste them into briefs".
`lean_remember` with a path appends to that area's rule (or `gaps.jsonl` if the rule is at its cap) instead of global
memory; memory without a path stays in `memory/`.

**Recipes** become skills the same way: `~/.lean-agent/<project>/skills/` linked as `<repo>/.claude/skills/lean-agent-*`
(excluded from git), so Claude Code lists and runs them natively.

## 3. Login opener and trust

`~/Library/LaunchAgents/com.lean-agent.desk.plist` (written by the `doctor --fix` step / migration):

```xml
<plist version="1.0"><dict>
  <key>Label</key><string>com.lean-agent.desk</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
    <string>exec "$HOME/.lean-agent/bin/open-desk.sh"</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/lean-agent-desk.log</string>
  <key>StandardErrorPath</key><string>/tmp/lean-agent-desk.log</string>
</dict></plist>
```

`~/.lean-agent/bin/open-desk.sh` (no KeepAlive: it runs once per login):

```sh
#!/bin/sh
log="$HOME/.lean-agent/logs/opener.log"; desk="$(cd "$HOME/lean-agent-desk" && pwd -P)"
i=0; until pgrep -xq "Claude"; do i=$((i+1)); [ $i -ge 120 ] && { echo "$(date) Claude Desktop not running after 10 min" >>"$log"; exit 0; }; sleep 5; done
sleep 10   # let the app finish starting
cd "$desk" && PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" claude --desktop >>"$log" 2>&1
echo "$(date) desk opened in $desk (exit $?)" >>"$log"
```

Doctor reads the last line of `opener.log`. Trust pre-setup: write `hasTrustDialogAccepted: true` for the **real**
paths (`pwd -P`: on macOS `/Users/<u>/lean-agent-desk` and each `~/.lean-agent/threads/tN`) into `~/.claude.json` `projects`,
done by the `thread` tool on each new folder and by migration for the desk. Whether the app honours CLI trust is R2;
the fallback is one trust click for the desk folder (threads are bg sessions and use CLI trust).

## 4. Migration from 0.45.x

Done by the `doctor` skill's `migrate` step on first 1.0 start (idempotent, writes `~/.lean-agent/migrated-1.0.json`):

| Data | Action |
|---|---|
| `projects.json`, handovers, reviews, passes, `memory/`, `todo.json`, `worktrees.json`, `config.json`, `ledger.jsonl` | kept as is (formats read by the mod) |
| `goals` / `questions` (myq) / waiting | converted to `goals.json` / `questions.jsonl` (open items only) |
| `<project>/cards` | not converted (cards were selected per task, rules are per path): moved to `legacy-0.45/`; the pane offers "Learn <project>" per registered project. Hand-written cards (no source file) are fed to that learn run as input |
| recipes | converted to `<project>/skills/<name>/SKILL.md` (task file -> body, model/read-only -> frontmatter `model`/`allowed-tools`) |
| `threads.json` | each open thread -> `threads/tN/thread.json` + `brief.md` (title, last report) + `notes.md` (handoff notes); state `open`, `sid` empty -> pane shows **Start** only (old sessions lived in another cwd and cannot be resumed from the new folder) |
| `service.json`, `up.json`, `desk.json`, `windows.json`, `session-cap.json`, self-update files, `*.lock` | moved to `~/.lean-agent/legacy-0.45/` |

Old service: `launchctl bootout gui/$(id -u)/com.lean-agent.up; mv ~/Library/LaunchAgents/com.lean-agent.up.plist ~/.lean-agent/legacy-0.45/`.
Old plugin: the 1.0 plugin keeps the name `lean-agent`, so `claude plugin update lean-agent` replaces it; the
`bin/lean-agent` shim on PATH is removed by migrate (with a line saying so). The retired `lean-agent-map` pane is closed
by the mod as today.

What the user does:
1. Quit any running hosted desk (`lean-agent service stop --yes` on 0.45, last time).
2. `claude plugin update lean-agent` (or reinstall from the marketplace).
3. Open Claude Desktop, new local session in `~/lean-agent-desk` (once), type "migrate". The desk runs the
   migration, installs the opener, trusts the folders and shows the pane; old threads are closed (none carried over).

## 5. Implementation plan

Tests: mod logic via `claude plugin test plugins/lean-agent` (`*.test.ts(x)` against the engine; no sign-in needed);
skills/agents via `claude plugin validate`; the shell opener via `sh -n` + a fake `pgrep`/`claude` on PATH.

| WP | Work | Size | Tests |
|---|---|---|---|
| 1 | Plugin skeleton 1.0: delete `scripts/`, `bin/`, Python hooks from `hooks.json`; mod role detection; state helper (atomic write, JSONL append) | M | role from cwd (desk/thread/plain); atomic write survives a concurrent reader |
| 2 | Thread core: `lean_thread` tool (new/send/wake/close/park/reopen/list), `claude agents --json` parser, trust writer; `thread` skill + desk CLAUDE.md | L | fake `claude` via `$.process` stub: start records sid; send to running = no resume; send to idle = one resume; never two wakes in 30 s |
| 3 | Delivery: thread `tool.call` append + `prompt.submit` consume; `lean_report`/`lean_ask`/`lean_goal`; desk sweep and desk-side delivery | M | message consumed exactly once; message after last tool call delivered by sweep; report shows in desk tool result / prompt context |
| 4 | Strict mode + push guard + private projects + read-only/allow-edit for workers (`tool.call`, fail-closed `.catch`) | M | table of allowed/denied calls per role; a throwing guard denies |
| 5 | Pane: goals, answers (ack), threads with Resume/Start; status line | M | render snapshot (like examples/pane.test.tsx); press Resume -> one `claude --bg --resume` argv |
| 6 | Workers: agents/*.md, LEAN-FEEDBACK parsing (gaps, memory), budgets via `turn.step`, ledger | M | `turn.step` refusal at cap; feedback `missing` lands in `gaps.jsonl`; ledger row per step |
| 6a | Learned rules: `learn` skill, `agents/explorer.md`, rule sync (copy + `.git/info/exclude`), worktree hook-up, staleness check, `InstructionsLoaded` stats hook, recipe -> skill conversion | M | fixture repo: learn writes rules with valid `paths:` frontmatter and size caps; copy synced + excluded (`git status` clean); stale area detected after a commit touching its globs; never writes outside `.claude/rules/lean-agent/` |
| 7 | Skills port: review (+passes, push gate record), review-learn (owner exclusion), worktree, pr, branch, todo, goals+chaser, handover, stats, find, feedback | L | validate; review record unlocks the push guard for that sha only; chaser wakes a stale idle thread |
| 8 | Squeeze (`tool.call` Bash post-processing) + `tool.list` trimming | S | long output squeezed and saved; errors kept; trimmed tools absent per role |
| 9 | Opener + doctor + migrate | M | fake-`pgrep` loop timeout logs; migrate idempotent on a 0.45 fixture home |
| 10 | README rewrite (~300 lines), CHANGELOG, version 1.0.0 | S | link check |

Order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 6a -> 8 -> 7 -> 9 -> 10. Verify R1-R5 on the Mac before WP2 is finished, R9-R11 before WP6a.

### Riskiest assumptions (verify on the Mac)

| R | Assumption | Command |
|---|---|---|
| R1 | `claude agents --json --cwd` shows a running/idle state and the sid we need | `cd /tmp/x && claude --bg -n probe "sleep 60 via Bash, then say done"; claude agents --json --cwd "$(pwd -P)"` (while running and after) |
| R2 | The app honours CLI trust (`~/.claude.json` `hasTrustDialogAccepted`) for `--desktop` | `mkdir -p /tmp/t2 && cd /tmp/t2 && claude` (accept trust) then `claude --desktop` in `/tmp/t2`: does the app still ask? |
| R3 | A user-scope plugin's mod (tool.call, ui.render) loads in a local Desktop session and in `--bg` sessions | `claude --bg -n probe2 "call the lean_ping tool"` with a test mod registering `lean_ping`; check `claude agents logs <sid>` |
| R4 | `$.session.send` from a bg thread reaches the desk session as a peer message and starts a turn | test mod: thread tool `lean_ping_desk` calls `$.session.send({to: <desk sid>, text})`; watch the desk in the app |
| R5 | Permission prompts in bg sessions: what happens when a thread needs approval (blocks? shows in app?) and whether `--permission-mode acceptEdits` / settings allow-lists apply to `--bg` | `claude --bg -n probe3 "create /tmp/t3/a.txt"` in a folder without allow rules; look in the app |
| R6 | A plan-window usage source exists for a mod (`$.session.usage` or the status line input) | test mod logging `await $.session.usage({})` on `turn.complete` |
| R7 | `tool.call` post-processing can append text to any tool's result without breaking structured results (Edit, Agent) | `claude plugin test` with a hook returning the modified `next(e)` result for Read, Edit, Agent |
| R8 | `claude --desktop` from a launchd job (no TTY, minimal env) opens the draft | `launchctl kickstart gui/$(id -u)/com.lean-agent.desk; tail ~/.lean-agent/logs/opener.log` |
| R9 | A **symlinked** `.claude/rules/lean-agent/` directory is followed and its `paths:` rules load on a matching Read | in a test repo: `mkdir -p ~/x-rules && printf -- '---\npaths:\n  - "src/**/*.ts"\n---\nSay PINEAPPLE.\n' > ~/x-rules/t.md && ln -s ~/x-rules .claude/rules/lean-agent && claude -p "read src/a.ts and follow your instructions"` -> PINEAPPLE; plus an `InstructionsLoaded` hook logging `load_reason: path_glob_match` |
| R10 | Subagents (Agent tool) and `--bg` threads load path rules when they read matching files | same probe via `claude --bg` and via a worker subagent; check the hook log for `agent_id` |
| R11 | Globs are matched relative to the project root of the session's cwd when the cwd is a worktree or a subfolder | repeat R9 from `<repo>/src` and from a `git worktree add` copy |

## 6. Decisions on the open questions (final)

1. **Desk folder**: `~/lean-agent-desk` (visible); state stays in `~/.lean-agent`.
2. **Linux**: 1.0 is macOS-only (Claude Desktop). `migrate` disables and archives the 0.45 systemd user unit
   (`systemctl --user disable --now lean-agent.service`, tolerant); `doctor` says "lean-agent 1.0 needs Claude Desktop (macOS)".
3. **Thread approvals**: threads run with an allow-list (Edit/Write/Bash inside the lean-agent folder and their
   worktrees); pushes stay behind the review gate (registered projects), the protected-branch rule and private projects.
4. **Migrated threads**: all old threads are closed at migration; 1.0 starts with none.
5. **Budget**: cost-only (no verified plan-window source).
6. **Learned rules**: copied + git-excluded only; no `commit` mode.
