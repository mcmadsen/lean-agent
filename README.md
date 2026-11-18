# lean-agent

Token-frugal orchestration for Claude Code, as one plugin. A **desk** session in the Claude desktop app routes work to
**threads** (background Claude sessions, one folder each); cheap **workers** do the mechanical parts; learned
**path-scoped rules** replace long project briefings; review gates, private projects and daily budgets keep it safe and
cheap. Version 1.0 is pure Claude Code: skills, subagents, a TypeScript mod and plain state files. There is no CLI and no
Python.

- [How it fits together](#how-it-fits-together)
- [Install](#install)
- [Upgrade from 0.45](#upgrade-from-045)
- [Use](#use)
- [Skills](#skills)
- [Workers](#workers)
- [Learned rules](#learned-rules)
- [Reviews and the push gate](#reviews-and-the-push-gate)
- [Budgets](#budgets)
- [Guards](#guards)
- [State files](#state-files)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it fits together

| Piece | What it is |
|---|---|
| **Desk** | A local Claude desktop session in `~/lean-agent-desk`. Its generated `CLAUDE.md` makes it a router: it never reads code or edits files, it starts and talks to threads |
| **Threads** | Background sessions (`claude --bg`), one folder each under `~/.lean-agent/threads/tN`, visible in the Claude app. A thread works in its own git worktree and reports back with `lean_report` / `lean_ask` / `lean_goal` |
| **Workers** | Subagents a thread starts: haiku for routine edits, sonnet by default, opus only when a cheaper one failed; read-only readers and a reviewer |
| **Pane** | The desk's side pane: goals, answers (with acknowledge), threads with Resume / Start buttons, a status line with spend |
| **Opener** | A login item that waits for the Claude app (never launches it) and opens the desk folder with `claude --desktop` |
| **Rules** | What the `learn` skill writes per project: short `paths:`-scoped rules that load only when a matching file is read |

The desk and threads talk through small files under `~/.lean-agent`: a message to a thread is queued and handed over
once at the thread's next tool call (or, if the thread is idle, by waking it once). A thread's report reaches the desk
the same way. A thread that is running is never resumed; an idle one is woken at most once per 30 seconds.

## Install

Requirements: Claude Code 2.1.327 or newer, the Claude desktop app, macOS for the login opener (the plugin itself also
runs without it).

```sh
claude plugin marketplace add mcmadsen/lean-agent
claude plugin install lean-agent@lean-agent
```

1. Open the Claude app and start a new **local** session in any folder (no desk needed yet).
2. Type `/lean-agent-setup` (or type `/lean-agent` and press **Set up lean-agent**). No model turn and no tool are
   needed: it creates `~/lean-agent-desk`, installs the opener at `~/.lean-agent/bin/open-desk.sh` plus the launch agent
   `com.lean-agent.desk`, and trusts the desk folder. In a session that is not the desk, `/lean-agent` then shows
   **Open desk** (it never launches the Claude app); or start a new local session in `~/lean-agent-desk`.
3. From the next login the desk opens by itself once the Claude app is running.

## Upgrade from 0.45

1. Quit a hosted 0.45 desk if one is running.
2. `claude plugin update lean-agent`.
3. Nothing else: the first local Claude session you start unloads the old `com.lean-agent.up` service at once and runs the
   migration. Only if the status line or the desk pane says "lean-agent 1.0: run migrate in the desk", open the desk and type `migrate`.

Migration is one-time and idempotent (it writes `~/.lean-agent/migrated-1.0.json`):

| 0.45 data | What happens |
|---|---|
| projects, handovers, reviews, passes, memory, todos, worktrees, config, ledger | kept as they are |
| goals without a thread, open questions to the desk | converted to `goals.json` / `questions.jsonl`; the old files are archived |
| **threads** | **all open threads are closed**; nothing is carried over. A readable list stays in `~/.lean-agent/legacy-0.45/closed-threads.md` |
| recipes | become project skills: `~/.lean-agent/<project>/skills/<name>/SKILL.md` |
| cards | moved to `legacy-0.45/`; run the `learn` skill per project to build rules |
| service, window, cap, update files and locks | moved to `legacy-0.45/` |
| old `com.lean-agent.up` service | unloaded; its plist archived |
| old `lean-agent` command on PATH | removed (1.0 has no CLI) |

The CLI commands are gone. What each one did now lives in a skill (see [Skills](#skills)) or in the pane. The old
`lean-agent-map` pane is retired.

## Use

Talk to the desk in plain language. It starts a thread for anything that touches code:

- "Fix the flaky login test in the api project": the desk calls `lean_thread new`, the thread works in a worktree and
  reports; the report appears in the pane and in the desk's next answer.
- "Tell t2 to also update the changelog": queued for t2, handed over at its next step.
- "What is everyone working on?": the `goals` skill lists one line per thread.
- "Park t3", "close t1", "reopen t3": flips the thread's state; closing also stops a finished-but-alive session and clears
  the goal. Reopening a **closed** thread starts a new session in the same folder with a handover built from its brief, notes,
  reports and remembered items (the old conversation is never resumed).
- After a restart nothing is running. The pane offers **Resume** for threads that had a session and **Start** for the
  ones that never started. **Close** (press twice) and **Close all done** never touch a working thread; closed threads sit in a
  collapsed "Closed (N)" with **Reopen**. Section headers fold and unfold; an answer row expands to its full text.
- Threads send a question or a done / blocked report straight to the desk's session; the inbox and the pane keep every report.
- A thread stopped by the usage limit shows "paused until 16:00" and is resumed by the desk two minutes after the reset, once per
  reset and never when you parked or closed it (`{ "desk": { "autoResume": false } }` turns it off; [spec](docs/usage-limit-resume.md)).

`/lean-agent` opens the pane. Threads run with an allow-list: Edit, Write and Bash inside their own worktrees and the
lean-agent folder without asking. Pushes stay behind the review gate and the private-project rule.

## Skills

| Skill | Use |
|---|---|
| `thread` | start, message, wake, park, close, list threads |
| `goals` | one line per thread; the chaser asks a thread that has been quiet for an hour for a status |
| `handover` | write a handover note for the next session |
| `worktree` | create, list, remove worktrees under `~/.lean-agent/worktrees` and sync learned rules into them |
| `branch` | branch names the way the project wants them (no `lean/` prefix, optional type and task id) |
| `pr` | pull requests on GitHub (`gh`) or Azure DevOps (`az`), by the origin URL: a thread opens and updates them, the desk only reads status |
| `review` | review the branch diff in passes and record the verdict for HEAD |
| `review-learn` | learn from review comments on pull requests |
| `learn` | write path-scoped rules for a project |
| `compare` | what a session costs at start vs a clean Claude Code session (overhead), or one read-only task both ways with a judge |
| `scripts` | scripts over models: propose, audit, adopt and reuse small scripts (`lean_script`) |
| `todo` | the user's to-do list in `~/.lean-agent/todo.json` |
| `stats`, `budget` | what sessions and workers cost, which rules load, caps |
| `find` | search lean-agent's own state (threads, notes, memory, handovers, saved output, reviews) |
| `feedback` | draft a bug report (posting needs the user's OK), or `/lean-agent-feedback`: one anonymised export file written by the mod |
| `lean-mode` | work frugally on long unattended runs |
| `doctor` | check and repair the install, migrate from 0.45 |

## Workers

Agent definitions in `plugins/lean-agent/agents/`:

| Agent | For |
|---|---|
| `lean-agent:worker-haiku` | small mechanical edits, renames, formatting, simple lookups. Use first for anything routine |
| `lean-agent:worker-sonnet` | ordinary implementation, tests, bug fixes (default) |
| `lean-agent:worker-opus` | hard design or debugging, only after a cheaper worker failed |
| `lean-agent:reader-haiku`, `lean-agent:reader-sonnet` | read-only lookup and analysis |
| `lean-agent:reviewer` | read-only review of a diff |
| `lean-agent:explorer` | explores one area for the `learn` skill |
| `lean-agent:auditor` | read-only audit of one candidate script (`scripts` skill) |

Defaults (mistakes are expensive where the work happens): threads run on sonnet / effort high (`config.json` `threads.model` /
`threads.effort` override; `lean_thread new|start` `model` / `effort` override per thread); the desk is sonnet / high;
`worker-sonnet`, `worker-opus` and `reviewer` run at effort high, `reader-sonnet` at medium, the haiku agents and the explorer at low.

A worker's last line is `LEAN-FEEDBACK {...}`: `missing` context becomes an entry in the project's `gaps.jsonl` (three
for one area mark its rules stale) and `remember` items go to shared memory. A long Bash result is squeezed (head, tail
and every error kept; the full text is saved under `~/.lean-agent/output/`) and each role sees only the tools it needs.

## Learned rules

`learn` explores each area of a repository with `lean-agent:explorer` subagents and writes at most 25 lines per area to
`~/.lean-agent/<project>/rules/<area>.md` with `paths:` frontmatter. The `lean_rules` tool copies them as real files
into `<repo>/.claude/rules/lean-agent/` (symlinked rule folders do not load) and keeps them out of git through
`.git/info/exclude`: nothing shows in `git status` and nothing is committed. Worktrees get their own copy through the
`worktree` skill. Recipes become `lean-agent-<name>` skills the same way.

An area is stale after a commit touches many of its files, its manifest changes or workers report gaps for it; the
desk then says "rules for X are stale: re-learn when you touch it". `stats` lists rules that never loaded.

## Compare

"Is lean-agent worth its overhead on this project?" `lean_doctor` `compare` (the desk) answers it without a model judging
anything: in the project folder with lean-agent switched off (`--settings` with `enabledPlugins` false for the installed
`lean-agent@...`), in a throw-away thread-shaped folder and in the desk folder it runs `claude -p "Reply with OK."
--output-format json` and `claude -p "/context"` (local, free) and prints clean / thread / desk side by side: the first
turn's input tokens (measured) and cost, and `/context`'s categories (system prompt, system tools, MCP tools, custom agents,
memory files, skills, messages). On the clean column it switches skills and MCP servers off one at a time to show each share.
The suggestions below the table name the concrete step: another plugin's skills to switch off for the project, an MCP server
to drop (`tools.thread.drop` in `config.json`), a big memory file to move into path rules, rules that never loaded, gaps that
look like script candidates. Runs cost a few cents and are capped at $0.25.

Task mode (the `compare` skill, run in a thread, only after the user agrees to the cost) runs one read-only task clean and as
a thread on the same model and effort, then a haiku judge compares correctness and completeness only. Reports are saved as
`~/.lean-agent/compare/<date>-<project>.md` with a `history.jsonl`: names and numbers only, never file contents, the task or
the answers; a private project is never compared. `lean_doctor` `compare` with `mode: history` lists them.

## Reviews and the push gate

`review` runs the read-only `lean-agent:reviewer` on the diff, one full pass and then deltas, and writes
`~/.lean-agent/<project>/reviews/<sha>.json`. A green record unlocks `git push` and PR publishing for that commit
only; a new commit needs a new review. `review-learn` turns repeated reviewer comments into rules: it learns from every
author except the lean-agent owner's own comments.

## Budgets

Cost-only, from the per-request usage the mod sees. `~/.lean-agent/config.json`:

```json
{ "dailyCapUsd": { "desk": 5, "thread": 20 }, "workerCapUsd": 2, "workerCaps": { "lean-agent:worker-opus": 4 } }
```

Desk reports: while the desk is idle, a thread's question or `done` / `blocked` report starts one desk turn (at most once a minute);
`{ "desk": { "autoRelay": false } }` in the same file turns that off, and reports then wait for your next message.

Past a cap the next model request is refused with a notice; a worker past its cap ends and reports what is left. Every
step is a row in `ledger.jsonl`. There is no plan-window percentage (no verified source exists).

## Guards

All fail closed (a guard that throws denies):

- **Desk strict mode**: the desk may read lean-agent state and use its own tools; it may not edit code or run builds. Its shell is limited to read-only status commands (`gh pr view|list|status`, `gh search prs`, `az repos pr list|show`, `git -C <dir> log|status|remote get-url`).
- **Push gate**: see above. The review must be green for the commit each pushed ref points at (not just HEAD).
- **Guarded branches** (every repo): a plain `git push` to `main`, `master`, `develop` or `release/*` (or a project's own `guards.push-deny`
  list in `projects.json`, even an empty one) is refused in the shell guard and in the pre-push hook: "Push your own branch and open a
  pull request". Pushes to a local path or `file://` URL are not checked (`LEAN_AGENT_PUSH_GUARD_LOCAL=1` checks them); the session
  env `LEAN_AGENT_PUSH_GUARD_OVERRIDE=1` skips the check. The hook trusts only `private.list` and refuses pushes (fail closed) when it
  is missing or older than `projects.json`; open any lean-agent session to refresh it.
- **Private projects**: an allow-list, review or not, no override. `git push` and `git remote add|set-url` are refused. Every `gh` or `az`
  call found anywhere in a command (also inside `bash -c`, `$(...)`, backticks, subshells, after `;` `&&` `|`, with global flags such as
  `gh -R o/r`) must be read-only, or the whole command is denied: `gh pr view|list|diff|checks|status`, `gh issue view|list|status`,
  `gh repo view|list`, `gh run view|list`, `gh auth status`, `gh api` with no write method or field flags, `az ... list|show|query|get`.
  Subcommands are matched by position, so `gh issue list --label release` passes. Commands that cannot be parsed (unbalanced quotes,
  `eval`, a `$variable` as program name) are denied. Everything else (gist, workflow run, secret set, ...) is denied as not on the list.
  `git fetch|log|status` pass. A whole-text check also refuses `git push`, `gh ... create|comment|merge`, `-c core.hooksPath=` and
  `GIT_CONFIG_COUNT/KEY_*` anywhere in the command, quoted or not. Residual risk: `ssh`, `flock` and `parallel` are parsed, but code inside `python -c` or other interpreters' strings, `awk system()`
  and `eval` with variables is not; `git push` from them is still refused by the pre-push hook, a backstop installed for
  thread sessions (it chains to the repo's own hooks, husky and git-lfs included, and fails closed if its private list is unreadable;
  `--no-verify` skips it, which is why the shell check refuses that). Other projects only get the push gate and the protected-branch / `--force` guard.
- **Workers**: readers are read-only; an edit grant is explicit (`allow-edit`).

## State files

Everything is plain JSON or JSONL under `~/.lean-agent` (one folder, resolved from `$HOME`):

| File | Content |
|---|---|
| `threads/tN/thread.json`, `brief.md`, `inbox.jsonl` | a thread, its brief and queued messages |
| `desk/inbox.jsonl`, `goals.json`, `questions.jsonl` | what threads reported, goals, open questions |
| `<project>/rules`, `skills`, `gaps.jsonl`, `reviews/`, `learn.json` | per-project learning and reviews |
| `scripts/candidates/<name>/`, `scripts/<name>/`, `<project>/scripts/<name>/`, `scripts/uses.jsonl`, `decisions.jsonl` | proposed and adopted scripts (script, `meta.json`, recipe `SKILL.md`), their uses and the user's overrides |
| `memory/`, `todo.json`, `worktrees.json`, `handovers/` | shared notes and lists |
| `config.json`, `ledger.jsonl` | caps and spend |
| `bin/open-desk.sh`, `logs/opener.log`, `migrated-1.0.json`, `legacy-0.45/` | opener, its log, migration marker and archive |

Writes are atomic (temp file then rename); appends are single `O_APPEND` writes; a damaged file reads as empty.

## Troubleshooting

- **The desk did not open at login**: `doctor check` shows the last opener line. The opener only acts while the Claude
  app is running (it waits ten minutes and never launches it). `/lean-agent-setup` (or `doctor fix`) reinstalls it.
- **"folder not trusted" from a thread start**: the desk trusts folders by real path (`~/.claude.json`). `/lean-agent-setup`
  repeats it; if `~/.claude.json` does not parse, lean-agent leaves it alone: accept the trust dialog once.
- **A rule does not load**: it must be a real file in `.claude/rules/lean-agent/`; `lean_rules sync` recreates it.
- **A thread seems stuck**: `goals` shows its last goal line; a status request goes out after an hour of quiet.
- **Spend refused**: `budget` shows which cap was hit; raise it in `config.json`.

## Development

```sh
claude plugin validate plugins/lean-agent
sh plugins/lean-agent/opener/open-desk.test.sh   # opener, with a fake pgrep and claude
sh plugins/lean-agent/hooks/rules-loaded.test.sh
sh plugins/lean-agent/hooks/githooks.test.sh   # hook wrappers (private check + chaining), real git in temp repos
claude plugin test plugins/lean-agent            # mod specs (*.test.ts, *.test.tsx); no sign-in needed
```

Design notes: [docs/design-1.0.md](docs/design-1.0.md). The designer brief for the pane:
[docs/live-map-design-brief.md](docs/live-map-design-brief.md).

## License

MIT
