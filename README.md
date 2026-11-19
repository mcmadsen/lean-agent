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
| **Opener** | A login item that waits for the Claude app (never launches it) and opens a new session in the desk folder through the app's `claude://code/new?folder=…` link (`open`; `claude --desktop` only as the last fallback) |
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
`threads.effort` override; `lean_thread new|start` `model` / `effort` override per thread); the desk is opus / high (`config.json` `desk.model` / `desk.effort` override);
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
desk then says "rules for X are stale: re-learn when you touch it". `stats` lists rules that never loaded (and says "loading unverified" when no load was ever recorded).

## Compare

"Is lean-agent worth its overhead on this project?" `lean_doctor` `compare` (the desk) answers it without a model judging
anything: in the project folder with lean-agent switched off (`--settings` with `enabledPlugins` false for the installed
`lean-agent@...`), in a throw-away thread-shaped folder and in the desk folder it runs `claude -p "Reply with OK."
--output-format json` and `claude -p "/context"` (local, free) and prints clean / thread / desk side by side: the first
turn's input tokens (measured) and cost, and `/context`'s categories (system prompt, system tools, MCP tools, custom agents,
memory files, skills, messages). On the clean column it switches skills and MCP servers off one at a time to show each share.
The suggestions below the table name the concrete step: another plugin's skills or an MCP server to leave out of the project
profile (`lean_thread profile`: outside it a server is deferred, not removed; the sizes shown are definition sizes, mostly deferred,
not first-turn cost, and a server or plugin the project's threads really used reads "keep"), a big memory file to move into path
rules, rules that never loaded, gaps that look like script candidates. Runs cost a few cents and are capped at $0.25.

**Project profile.** A project can carry an allow-list of MCP servers and plugins (`~/.lean-agent/<project>/profile.json`, written
by `lean_thread profile`, learned from what its threads really called with `fill`). Threads of that project start with it:
plugins outside it are switched off in the thread's settings, MCP servers outside it are deferred (still found by ToolSearch).
`needs: ["azure-devops"]` on `lean_thread new` adds a server for one thread. A project without a profile loads everything, as before.

Task mode (the `compare` skill, run in a thread, only after the user agrees to the cost) runs one read-only task clean and as
a thread on the same model and effort, then a haiku judge compares correctness and completeness only. Reports are saved as
`~/.lean-agent/compare/<date>-<project>.md` with a `history.jsonl`: names and numbers only, never file contents, the task or
the answers; a private project is never compared. `lean_doctor` `compare` with `mode: history` lists them.

## Reviews and the push gate

`review` runs the read-only `lean-agent:reviewer` on the diff, one full pass and then deltas, and writes
`~/.lean-agent/<project>/reviews/<sha>.json`. A green record unlocks `git push` and PR publishing for that commit
only; a new commit needs a new review. `review-learn` turns repeated reviewer comments into lessons (below) and, for one area's
commands and layout, into rules: it learns from every author except the lean-agent owner's own comments.

**Review lessons.** What human reviewers caught that an automated review missed ("before adding a date parser, check
`parseDate` in `src/lib/dates.ts`") and the shared helpers that already exist are kept per project in
`~/.lean-agent/<project>/review-lessons.jsonl`, not in `rules/*.md`: a rule holds 25 lines, a project that has been reviewed for a
year has hundreds. A review does not read them all. `lean_review` `lessons` (`project`, `base`/`head` or `paths`) picks, with a script
and no model, the lines whose paths or globs match the changed files, whose helper name occurs in the diff, or whose keywords occur in
the diff or the goal, plus the helpers in the same or the next folder; they are grouped by topic and capped at about 3200 tokens
(`config.json` `review.lessonTokens`), always under a short rule to search for an existing helper before accepting new code that detects,
parses or normalises something. Every call logs which lines and why to `~/.lean-agent/logs/review-lessons.jsonl`. The store holds at most
1500 live lines (`review.lessonMax`). Manage it with `lean_review` `learn`, `lessons-list`, `lessons-rm`, `lessons-undo` and
`lessons-verify` (helper lines whose code cannot be found). Coming from 0.45: `migrate` copies `library/<project>/cards.json`,
`review-learned.json` (with its lesson registry), `review-learn-batches.json` and `review-learned-threads.json` to
`legacy-0.45/lessons-<project>/` (never deleting the originals) and imports the live lines; installs that migrated before get it at the
next start. `lean_rules check` and the doctor say when 0.45 lessons are not imported yet.

The reviewer reads the project's path rules through git too: `git -C <repo> show <rev>:<path>`, `git grep`, `git diff -- <path>`,
`git log -p -- <path>` and a plain `git show <rev>:<path>` in the project's worktree load the rules of the files they name, and for the
reviewer a path-less `git diff` loads `_project.md` and the rules written for the whole repo.

**The push runs in the desk, not in a thread.** Claude Code judges every command in the session that runs it, and your "push and
open a PR" is said to the desk, so a thread's own session would refuse `git push` as unwanted. A thread therefore never runs
`git push` or `gh pr create`: after a green review it reports "ready to push `<sha>` (branch, PR title)" and stops. The desk asks you
(naming the exact sha and branch), and only after your explicit yes calls `lean_thread` `approve-push` (one sha, single use, 2 hours)
and then `push` (`tN`, `sha`, optional `pr: { title, body?, base?, draft? }`). Before anything leaves the machine the mod checks, in
order, and refuses with the reason: the desk role; the thread exists and its project is not private; the sha is the full one; the
thread's registered worktree (a linked worktree of the project's own repository, so its config is the project's) has that sha as
HEAD on a branch that is not protected (`main`, `release/*` ...), guarded or the remote's default (read from the remote when this
checkout has none; unknown = refused); a green review for that sha; a valid approval. Then it consumes the approval and pushes
that exact commit to `<remote>/<branch>` (the branch's own remote or `origin`; never `--force`, never a tag, no prompt, bounded in
time), and with `pr` runs `gh pr create --head <branch>` from the worktree
(`gh` is looked up on PATH, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`; without it the reply gives the compare URL from
the push output). No PR is attempted after a failed push. The reply, the thread's `history.jsonl` and a queued message to the
thread ("the desk pushed `<sha>`; PR `<url>`") say what happened; a failure names the step and its first error line. A second
`push` needs a new approval.

## Budgets

Cost-only, from the per-request usage the mod sees. `~/.lean-agent/config.json`:

```json
{ "dailyCapUsd": { "desk": 5, "thread": 20 }, "workerCapUsd": 2, "workerCaps": { "lean-agent:worker-opus": 4 } }
```

Desk reports: while the desk is idle, a thread's question or `done` / `blocked` report starts one desk turn (at most once a minute);
`{ "desk": { "autoRelay": false } }` in the same file turns that off, and reports then wait for your next message.

Past a cap the next model request is refused with a notice; a worker past its cap ends and reports what is left. Every
step is a row in `ledger.jsonl`. There is no plan-window percentage (no verified source exists).

## Context size

Every request pays for the whole context in cache reads, so lean-agent keeps contexts small without interrupting work:

- **A thread that reports `done` is finished as a session.** When its last report is `done` and its turn has ended, the desk's
  10 s tick stops its process ("t3 finished: next message starts a new session"; the pane row says so). A thread that reported
  done but is still on a final step is stopped only once it is idle. Any later `send`, `wake`, `resume` or `start` for it starts a
  NEW session with a handover (brief, goal, notes, reports including the done report, queued messages, branch and worktree), never a
  resume of the old conversation. Nothing checkpoints a thread mid-work.
- **Restart buttons** (the pane, instead of any automatic restart): every open thread row has `Restart` (press twice: the second
  press confirms; a working thread's label warns that the current step is lost). It stops the session (only one in the thread's own
  folder) and starts a new one with the handover, same model and effort ("Restarted from the pane."). The desk can do the same with
  `lean_thread restart tN` when you ask. `Restart desk` (or `/lean-agent-restart-desk`) writes `~/.lean-agent/desk/handover.md` and
  opens a new desk session, which reads it; close the old one.
- **Oversized tool results are cut before a thread sees them.** A Bash or MCP text over 20000 characters keeps its head and tail;
  the full text is saved under `~/.lean-agent/output/` (the same folder as the Bash line squeeze; files older than 7 days, and all but
  the newest 2000, are pruned) and one line says where. Edit and Write results, errors, subagents and the desk are
  never touched. `lean_doctor stats` counts it ("saved 140.0k chars in 12 results"). Set `{ "toolResultChars": 30000 }` in
  `config.json` to change the limit (a value below 2000 is ignored; `0` turns the cut off).
- The **desk**, when idle and over `deskTokens` (config.json, default 200000), compacts itself with fixed instructions (goals, open
  threads, questions, your decisions and approvals kept; tool output dropped). A compaction that was vetoed or failed is recorded with
  its reason (a notice, and `lean_doctor check`) and tried again when the desk's turn ends. If it cannot compact, `desk/handover.md`
  is written and the status line reads "desk context Nk: type /compact (or start a new desk session; it reads the handover)".
  **In Claude Desktop the desk is an SDK (headless) session, and the engine does not offer `session.compact` there** ("compaction
  here runs inside a turn"). That is not a failure: it is asked once per session start (no retry, no red row, no notice), and while
  the desk is over `deskTokens` the pane shows, at the top, "desk context Nk: the app cannot compact the desk automatically. Press
  Restart desk (fresh desk with the handover) or type /compact" with the `Restart desk` button next to it (press twice).
  `lean_doctor check` shows it as a `note` row, not `FIX`. The mod does not send `/compact` itself: no engine call is documented to
  run a slash command in a headless session.
  The 1.0.6 key `checkpoint.deskTokens` is still read; `checkpoint.threadTokens` and `checkpoint.enabled` do nothing.

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
| `mcp-env.json` (user-only, `chmod 600`), `mcp-env-import.json` | MCP variables a thread gets from a command or a value; what the 0.45 import did (names only) |

Writes are atomic (temp file then rename); appends are single `O_APPEND` writes; a damaged file reads as empty.

## MCP servers that need a variable (e.g. a site/domain)

A plugin's MCP config may reference variables, for example `https://${DD_MCP_DOMAIN:-not-setup}/v1/mcp` with headers
`${DD_API_KEY:-}`. Claude Code fills `${VAR}` from the **session's environment**. The desk runs inside the Claude app and threads
are started from it, so a variable you export in `~/.zshrc` never reaches them; the server then connects to its placeholder
default (`getaddrinfo ENOTFOUND not-setup`). Editing the default inside the plugin folder does not help either: background
sessions get their own copy of synced plugins, and a plugin update resets it.

What every session does get is the `env` block of `~/.claude/settings.json`. lean-agent writes there for you:

- **Detect.** `lean_doctor check` (and the pane, and `/lean-agent-setup`) lists, per server, the variables its config references
  that the desk and threads do not have, names only: `MCP  plugin:datadog:mcp needs DD_MCP_DOMAIN (unset: it falls back to
  'not-setup', a placeholder, so the server cannot connect)`. It reads the config of enabled plugins (installed and synced), your
  user MCP servers (`~/.claude.json`) and the `.mcp.json` of registered projects. A variable with an empty or a usable default is
  not reported.
- **Fix a non-secret value** (a site, a domain, a region): tell the desk "set DD_MCP_DOMAIN to mcp.<site>". It calls
  `lean_doctor mcp-env` with the name and value, which merges the variable into the `env` block of `~/.claude/settings.json`
  (every other key kept, atomic write). Every session started from then on has it: app, terminal, desk, threads. A session that is
  already running keeps its old environment, so start a new desk session before its MCP server picks the value up. Only a
  variable that an enabled plugin's or your own MCP config references is written (an allowlist: no other name can be planted; a
  project's `.mcp.json` is listed but never opens it, add such a variable to the `env` block by hand). Names that look secret
  (`KEY`, `TOKEN`, `SECRET`, `PASS*`, `CRED*`, `AUTH`, `COOKIE`, `DSN`, `WEBHOOK`, `DATABASE_URL`-style, `PAT`, ...; a plain site
  variable such as `JIRA_URL` or `AUTH0_DOMAIN` is fine), values that look like a credential (a URL with a password or a
  `?key=` parameter, `ghp_`/`sk-`-style tokens, long random strings; a UUID or a path is fine) and names that change how sessions
  run (`PATH`, `NODE_*`, `GIT_*`, proxies, `CLAUDE_*`, ...) are refused. A value that is already set is not overwritten: the desk
  passes `replace: true` only when you asked to change it, and the reply says "replaced". The pane has no text field, so the desk
  asks you and makes the call.
- **Secrets never go into `settings.json`** (a plain file, often synced or committed). For the **desk** and the app, sign in
  through the server itself (OAuth): the Datadog plugin's server asks for a login, and the stored login needs no key. For
  **threads**, put a command that prints the value in `~/.lean-agent/mcp-env.json` (`chmod 600`, your own file; edit it by hand,
  no tool writes commands):

  ```json
  { "DD_API_KEY": { "command": "security find-generic-password -s dd-api-key -w" },
    "GH_TOKEN": { "command": ["gh", "auth", "token"] } }
  ```

  A string runs as `/bin/sh -c <string>`, a list runs as an argv with no shell. An app-launched process may have a minimal
  `PATH`, so use absolute paths (`/opt/homebrew/bin/gh`, `/usr/bin/security`). Whenever a thread gets a new session (new, start,
  reopen, a checkpoint, a resume of a thread whose session runs older code; not a plain wake) the mod runs the commands side by
  side (15 s limit, one line of output expected; a keychain prompt that needs you will time out when you are away) and writes the
  values into **that thread's** `.claude/settings.json` (created empty and `chmod 600` first, the mode checked after; if that
  fails the thread starts without the values and the start reply says so), never anywhere else, never into a log, a report or the
  feedback export; the start reply names the variables only. Only names an MCP config references are used, and a file that is not
  yours, or that others can write (checked before it is read, symlinks followed), is ignored; one others can only read is
  tightened to `chmod 600`. A `{ "value": "..." }` entry also works for threads. The desk and the app do not
  read `mcp-env.json`. Limits to know: the values stay in the thread folder's settings file after the thread closes (until its next
  start rewrites it; the file is user-only), and the thread's Bash tool inherits them like any settings `env` value.
- **Which value wins.** Checked with Claude Code 2.1.328: a variable in the user `env` block and the same one in a project's
  `.claude/settings.json` (a thread folder is one): the user's value is used. A thread's value only fills gaps, and lean-agent
  never adds a name your user `env` block already sets, so nothing is shadowed.
- **From 0.45.** `lean-agent mcp env NAME VALUE` kept values in `~/.lean-agent/mcp-env.json`. At the first session start after the
  update the plain non-secret values are moved into the `env` block (the doctor names them), commands and secrets stay in the file.

## Troubleshooting

- **An MCP server says `ENOTFOUND not-setup` (or another placeholder host)**: it needs a variable the desk does not have, see
  "MCP servers that need a variable". `lean_doctor check` names it; ask the desk to set it.

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
