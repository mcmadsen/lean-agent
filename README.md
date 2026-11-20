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
| **Workers** | Subagents a thread starts: haiku for routine edits, sonnet by default, opus only when the user asks for it and approves it in the pane; read-only readers and a reviewer (always sonnet) |
| **Pane** | The desk's side pane: what needs you, one card per thread, the inbox by thread, spend and the desk's context at a glance ([The pane](#the-pane)) |
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
- After a restart nothing is running. A thread's card offers **Resume** for threads that had a session and **Start** for the
  ones that never started. **Close** (press twice) and **Close all done** never touch a working thread; closed threads sit in a
  collapsed "Closed (N)" with **Reopen**. Section headers fold and unfold; an inbox row expands to its full text.
- Threads send a question or a done / blocked report straight to the desk's session; the inbox and the pane keep every report.
- A thread stopped by the usage limit shows "paused until 16:00" and is resumed by the desk two minutes after the reset, once per
  reset and never when you parked or closed it (`{ "desk": { "autoResume": false } }` turns it off; [spec](docs/usage-limit-resume.md)).

### Thread detail pane and the new-thread form

Two more panes open beside the desk pane (the desk pane's buttons call them; `openThreadPane(host, surface, id)` and
`openNewThread(host, surface)` in `hooks/threadpane.tsx` and `hooks/newthread.tsx`).

- **Thread pane** (`lean-agent-thread-<tN>`, titled "tN · title"; one per thread, several may be open and each redraws from its own
  thread's files): the brief (first four lines, expandable), goal, project, model/effort, state, branch and worktree path (from
  `worktrees.json`), the diff stat against the base (`git -C <worktree> diff --stat <base>...HEAD`, bounded to 12 files; the base is the
  review record's, else the project's default branch), the review record for HEAD (green only when its signature verifies, passes, open
  findings), cost today and total (the ledger's rollup, 120 days), the last 10 reports newest first (a row expands), the queued messages
  and the buttons **Open session** (stops an idle process, then the `claude://resume` link, the same path as "Open tN"), **Restart** and
  **Close** (press twice; Close never touches a working thread) and **Refresh**. A closed or missing thread shows one short line. Data is
  read through short caches (session listing 8 s, git 15 s, cost 30 s), so many open panes do not multiply the work.
- **New thread** (`lean-agent-new-thread`): a title field, a project (the registered ones or none), model (default, haiku, sonnet, opus;
  opus is labelled "needs your Approve press"),
  effort (default, high, medium, low; "default" leaves the field out, so sonnet / high or `config.json` `threads.model` /
  `threads.effort` apply exactly as for the tool), a multi-line brief (the engine's `Input` takes `rows`) and **Start**. Start runs the tool's own `new`
  code, no model turn, then opens the new thread's pane. Picking opus shows a note and a Reason field (why sonnet is not enough);
  Start then creates the thread but starts no session: the request waits in "Needs you" (see "Expensive models"). An empty title or brief, a title or brief that is too long and a project that
  is no longer registered are said inline, before any folder exists; a failed start keeps what you typed.
- Both are desk-only (elsewhere they say so). The pane's open/fold state is kept in the mod, not in `$.state`, so a mod reload folds it again.

### Thread sessions: what "running" means, wake, names, leftovers

`claude agents --json --all` (its `state` working / idle / done, and the process) is the source; the thread's own queue says whether
anything is read. `lean_thread list`, the pane cards, the thread pane and the send / wake replies show one of:

| shown | meaning |
|---|---|
| running | the process is alive and the turn is going |
| idle, N unread queued | the process may be alive but the turn ended (a listed `status` that still says busy does not make it running) |
| stuck | a queued message has been unread for `threads.stuckMinutes` (config.json, default 10): no tool call and no inbox read (a working session reads its queue at every tool call) |
| done / parked | the session ended or finished, or you parked the thread |

- **send** to an idle session wakes it (stops a lingering process, resumes with the batch); a send within 30 s of the last wake, or to a
  stuck session, only queues and says so ("queued, session idle: wake or restart it", or the stuck line), and the list shows the unread
  count. A reply never says "running" for an idle or stuck session.
- **wake** (and **resume**) wakes an **idle** session even when nothing is queued (the prompt is the task) and replaces a **stuck**
  session whose turn ended (stops it, starts a new session with the handover, queued messages included). A plain `send` never
  replaces a stuck session. A session that is still **working** is never stopped by send, wake or resume, even when it looks stuck
  (one tool call that runs longer than `threads.stuckMinutes`, or a subagent wait, reads no queue: raise the setting for long builds);
  only `restart` replaces it (its current step is lost). A session that waits on a prompt for you is never "stuck".
- A `[working]` report of a session that is not running is marked stale in the list, the card and the thread pane. A start whose
  session ended its turn without a tool call (idle moments after the start; later, the ledger shows no request beyond the first and the
  thread reported nothing since the start) is reported loudly: "started, but it ended its turn at once: wake it with the task".
  Nothing here has been checked against a live session's real `state` values yet.
- **The prompt starts with the task**: "Resume the work now (task: ...). Answer status requests with a short lean_report as a side
  effect, never as the whole turn." (the task is the goal, else the first line of the brief). Restart, wake and the handover all start
  that way, and the thread guide says the same: a status request arriving mid-work gets one short report and the work goes on.
- **Names.** Every fresh start and restart passes `-n "tN · title"`, then `"tN · title (2)"`, `"(3)"` for each session that replaces an
  older one. After a start or wake the name is read back from `claude agents`; when the app lists another one, the reply says so.
  Claude Code 2.1 names a background session only when it starts (`claude --bg -n`; `claude --bg --resume <id>` takes no flags) and
  has no command or flag to rename one, so lean-agent leaves the name as it is (it does not edit the app's files); the doctor
  row says which sessions show another name, and a restart gives the right one.
- **Superseded sessions.** After a fresh session replaces an old one, the old one is removed from the app's list with `claude rm <id>`
  (its conversation is kept; never `--discard-unpushed`, never `--force-remove-worktree`; never a session whose process is alive or
  working, never the one just started, never one outside the thread's folder). A refusal ("not safe") is logged in the thread's
  `history.jsonl`, said in the reply and left. `{ "threads": { "removeOld": false } }` keeps them all. The doctor row **stale thread
  sessions** lists stopped sessions of threads that have a newer session; `doctor fix` removes them the same way.
- **A restart or fresh start says what it costs**: "new session: handover about 3.2k tokens (~$0.01 first turn, estimate); the old
  session's conversation is not resumed" (the handover at about four characters a token, as uncached input of the model's list price;
  the guide and tool listing are not counted).
- The thread's `CLAUDE.md` is regenerated from `thread.json` at every fresh start (no stale `model:` line after a model change), and
  says that tools which start the shell in the worktree are fine while the thread itself never `cd`s (absolute paths, `git -C`).

`/lean-agent` opens the pane. Threads run with an allow-list: Edit, Write and Bash inside their own worktrees and the
lean-agent folder without asking. Pushes stay behind the review gate and the private-project rule.

## The pane

Top to bottom (the desk's pane; any other session sees only the way to the desk or to setup):

1. **Header.** The desk's model and effort as a chip (`[sonnet/high]`; `≠ pin` and a yellow line when the desk really runs another
   model), today's spend and the last 7 days, the desk's context as a bar against `deskTokens` (green, yellow from 80 %, red from
   100 %) with **Restart desk** beside it from 80 %, and the version and refresh time, small and dim. The one-time line "lean-agent set
   sonnet / high" is drawn for 30 seconds after it first appears; after that the chip says "(set by lean-agent)".
2. **Needs you (N)**, only when something waits: a thread blocked on an approval (**Open tN** opens its own session, where you
   answer; the card goes away as soon as the thread works again), an unanswered thread question, a report that is ready to push (its sha and branch, review green, not yet pushed: "ask the
   desk to push"; there is no push button, the desk pushes), a blocked thread or one waiting on a prompt, a script waiting for your
   Adopt / Reject, and the desk over its context limit. Each is a card with its button.
3. **Threads.** One bordered card per open thread, coloured by state (green working, yellow asking / approval / waiting / paused,
   red blocked, dim done / idle / parked). Line 1: id and the whole title (it wraps). Line 2: model/effort, the state as ONE word,
   the branch, the review verdict (`review green`, `review not green`, `no review`) and today's cost. Line 3: the last report on one
   line. Buttons: **Open** (the thread's detail pane), **Resume** / **Start**, **Restart** and **Close** (both press twice). The
   branch, commit and verdict are read from the thread's latest reports and the signed review record of the commit they name; a
   record whose signature does not verify counts as "not green".
4. **Inbox.** Reports and questions grouped by thread, a thread with something unread first and open, unread rows first, then the
   last 5 read ones ("show all" for the rest). A read row older than 7 days is archived: hidden here, still in
   `~/.lean-agent/desk/inbox.jsonl`. **ack all** marks everything read.
5. **Goals** (only when there are some), **Closed (N)** and **More** (projects, scripts) are folded sections.
6. **Footer actions.** **New thread**, **Feedback export** (the anonymised export file of `/lean-agent-feedback`; nothing is posted),
   **Setup / repair** and **Restart desk**, always here (the header's button shows only near the limit; both press twice and do the same).

In the minimized widget form (Claude desktop), the pane draws a glance and no button, because clicks may not reach it: threads
running and blocked, how many need you, the desk's context in percent and today's spend. On a narrow body (under 50 columns) the
rows get shorter and the buttons wrap; the tree is the same on the terminal, the desktop app, VS Code and mobile.

**Notifications.** The desk shows a toast, once per event, when a thread enters "Needs you" (an approval, a question, a report ready
to push, a blocked thread) or reports done. A script decides, no model is involved. The first pass after an install only records what
is there. `config.json`: `{ "notify": { "toast": true, "sound": false } }`; `toast: false` silences it. `sound` does nothing yet: the
engine plays only an audio file the plugin bundles, and lean-agent ships none (speech would read thread titles aloud, so it is not
used either).

### Approvals of a thread's denied action

A PR reply or comment, a work item comment or update and a GitHub PR comment no longer wait for this: the thread asks with `action` and
the desk sends it after your yes (next section). For any other action Claude Code's permission check denies in a thread, the thread
reports `blocked` with the exact action and the pane shows "tN needs your yes in its own session". You answer **in that session**
(**Open tN**). The desk never
asks you for it with a question and never passes a yes on with `send`: Claude Code's permission check is not bypassed by a model or a
message, and the classifier reads a relayed yes as the model undermining oversight. A plugin hook cannot carry the decision either:
`PermissionRequest` answers asks that go to a person, a classifier's denial is not one, and `PermissionDenied` can only say `retry`,
which runs the same check again (read from the engine's typings, not measured live; details in the changelog). The card exists only
while the thread is really blocked: not working, and no tool call since its report. A thread reports `blocked` with an `approval`
only for what the permission check denied, never for something it decides itself (a subagent cap, a model choice). An expensive model
is the pane's Approve, a push the desk's `approve-push`.

### Remote writes go through the desk (typed actions)

A thread may not make a remote write itself (Claude Code's permission check or classifier denies it, and the user would have to answer
in the thread's own session). So it asks, and the desk's mod performs the write after the human said yes, the way `push` already works:
no model ever bypasses a permission check, and no hook carries a decision.

1. The thread calls `lean_report` (state blocked) with `action: {kind, params, why}`. The kinds are a fixed table
   (`hooks/deskactions.ts`), nothing else: `ado-pr-reply` {org, project, repo, pr, thread, body}, `ado-pr-comment` {org, project, repo,
   pr, body}, `ado-workitem-comment` {org, project, id, body}, `ado-workitem-update` {org, project, id, fields: state, assignedTo, tags,
   title; strings}, `gh-pr-comment` {repo (owner/name), pr, body}. An unknown kind or param is refused with the list; pushes, merges,
   deletes and settings changes are not in it.
2. The mod stores the request in its own store, signed (HMAC with the review key, like the push approval): id, thread, kind, params, the
   exact rendering (method, URL, body) and the sha256 of it. The pane's "Needs you" shows "t5 wants to reply to PR thread 7 on PR 42
   (org/project/repo): <the exact text>" with **Approve** / **Deny** (two presses each), and the desk's inbox line says what to do.
3. The desk runs `lean_thread action-list`, which prints the question to ask; the desk asks the user with AskUserQuestion, pasting it:
   it names the request id, a check code and the exact text, with the options Approve, Deny, Edit first. The mod reads the user's answer
   from that tool's own result (`answers`, question text to the label chosen) in the desk's `tool.call` hook and records it for that one
   request, only when the question the user saw carried the id, the check code and the exact text. A model cannot stand in for it: an
   `answers` field in the call's input is refused, free text is no choice, and a spec reads the sources to keep the answer's writers to
   the question hook and the pane's press.
4. `lean_thread approve-action <id>` (desk only) is refused unless a signed human Approve for that request id and text is on record, the
   request is under 2 h old and unused, and the text derived again from the params still has the signed check code. Single use. A model-made
   call, another request's answer, a changed text, an expired or already used request are all refused with the reason.
5. The mod sends it, never a model and never the thread's shell (argv, no shell): Azure DevOps through `az account get-access-token
   --resource 499b84ac-...` and `curl` with the token and the body on STDIN as a curl config (never in an argument list, a log or an output),
   GitHub through `gh api` with the body on stdin. It records the result (id / URL, or the error) in the thread's `history.jsonl` and sends
   the thread a message so it carries on. A failing send leaves the request approved and unused and says why; a connection that broke
   after the request may have arrived is marked used (never sent twice) and the thread is told the outcome is unknown. Deny tells the
   thread "denied: report blocked or continue without it"; Edit first sends nothing and the thread makes a NEW request (new id, new check
   code) with the changed text.

Not run live: the answer is read from the engine's typed `AskUserQuestion` result (`{questions, answers, response?, annotations?}`, as
`next(e)` of a `tool.call` hook resolves it; the 1.0.14 note that `classic.PostToolUse` carries `tool_response.answers` is the same
data); the specs drive a stand-in for that tool beneath the plugin. If a real session's result turns out not to carry the answers, the
desk says so ("could not be read by the mod") and the pane's Approve / Deny on the card is the human's decision instead. Not covered: a
PR thread's *status* change (fixed / closed) after a reply is outside the five kinds and stays a manual step.

Avoidable blocks: `lean_doctor refusals` groups the guard's recorded refusals by pattern with a count and a one-line fix, and the
doctor shows a `note top refusals` row when one pattern repeats (config `refusals.repeat`, default 3). `lean_thread new` takes
`allowEdit` (absolute paths, at least two levels deep) and `allowCmd` (plain read-only commands): they are written into the brief as the
exact lines the thread copies into its workers' prompts, for work that needs a path outside the worktree (a repo's `.claude/skills/...`
file). No allow rule is added to any settings file to get past a classifier, and the guard is not widened for anything that writes or runs
a program.

### Why a thread gets blocked (measured)

Measured on the feedback exports of three days (7 distinct files, lean-agent 1.0.5 to 1.0.12; the full table is in the changelog under
"Unreleased"): of 78 guard refusals, 68 were a reader, reviewer or explorer refused a shell command (63 of them under the git-only
wording that 1.0.9 and 1.0.14 widened; what is left, `cd`, redirects, `;`, `&&`, `$(...)`, `xargs`, paths outside the roots, refuses on
purpose) and 10 were the desk refused in strict mode (it routes instead). No worker `allow-edit` refusal was recorded. The blocks a
user had to answer in a thread's own session were 2 remote writes (an Azure DevOps work-item update, a PR thread reply) denied by Claude
Code's own permission check or classifier, plus 1 push the thread tried itself (the push gate is the desk's). The other `blocked`
reports were no permission block (an MCP server not signed in, a registry slot, a policy rule of the user's own project). So the
avoidable ones are the remote writes and the grants a brief forgot.

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
| `rules-pr` | draft PR with optimised Claude files (CLAUDE.md, `.claude/rules`) for a project; needs the user's yes to push like any push |
| `compare` | what a session costs at start vs a clean Claude Code session (overhead), or one read-only task both ways with a judge |
| `scripts` | scripts over models: propose, audit, adopt and reuse small scripts (`lean_script`) |
| `todo` | the user's to-do list in `~/.lean-agent/todo.json` |
| `stats`, `budget` | what sessions and workers cost, which rules load, caps |
| `find` | search lean-agent's own state (threads, notes, memory, handovers, saved output, reviews) |
| `feedback` | draft a bug report (posting needs the user's OK), or `/lean-agent-feedback`: one anonymised export file written by the mod |
| `lean-mode` | work frugally on long unattended runs |
| `doctor` | check and repair the install, migrate from 0.45 |

## Execution model

All work goes to small workers; the guard enforces it (hooks/orchestrate.ts), no text has to be remembered. `lean.orchestrate` in
`~/.lean-agent/config.json` (default `true`; `false` = the behaviour before this section, every rule below off).

| Who | May do | Refused with |
|---|---|---|
| desk | `lean_*` tools, AskUserQuestion, Skill, Read / read-only Bash inside `~/.lean-agent` only (each result cut to `deskToolResultChars`, default 6000) | "the desk routes: start or ask a thread (lean_thread new / send)" |
| thread | `lean_*` tools (incl. `lean_run`), Agent (workers), `git status/log/add/commit/worktree/diff --stat…`, its own thread-folder files, at most `threads.directReads` (default 3) direct Reads per turn of ≤ 200 lines | "one step for a small worker: lean-agent:worker-haiku (allow-edit: <path>) / lean-agent:reader-haiku" |
| worker / reader | ONE step, a tool-call budget `workers.steps` (default 15), answer ≤ 30 lines; never starts agents | at the budget: "return what you have; the thread splits the rest" |

- Haiku by default: an Agent call to `worker-sonnet` / `reader-sonnet` needs a prompt line `why-sonnet: <reason>`; opus stays under the
  pane approval. A worker brief is at most `workers.briefChars` (default 1500); at most `threads.workers` (default 4) run at once.
- An Agent result of a worker / reader is cut to `agentResultChars` (default 6000, head + tail); the full text is a file under
  `~/.lean-agent/output/`.
- Small workers and the reviewer passes do not count against a user `agents.cap`.
- `lean_run` runs a test / build command with its output in `~/.lean-agent/runs/<ts>.log` and returns the exit code, the failing test
  names and the last 40 lines; a thread never reads the stream. Other Bash for a thread (tests, builds, sed, node…) is refused.
- `hooks/preflight.ts` (`preflightText`) computes a fresh start's facts by script: branch, HEAD, `git status --short`, diff stat, last
  report line, open tasks, PR / work-item reference.
- `lean_doctor context [session]` measures a session from its transcript by script: tokens added by tool and result size, the ten
  largest single results, delegated against direct tokens, the Haiku share.

## Workers

Agent definitions in `plugins/lean-agent/agents/`:

| Agent | For |
|---|---|
| `lean-agent:worker-haiku` | small mechanical edits, renames, formatting, simple lookups. Use first for anything routine |
| `lean-agent:worker-sonnet` | ordinary implementation, tests, bug fixes (default) |
| `lean-agent:worker-opus` | hard design or debugging, only when the user asks for it; never a default, and refused unless the user approved opus for that thread in the pane |
| `lean-agent:reader-haiku`, `lean-agent:reader-sonnet` | read-only lookup and analysis |
| `lean-agent:reviewer` | read-only review of a diff |
| `lean-agent:explorer` | explores one area for the `learn` skill |
| `lean-agent:auditor` | read-only audit of one candidate script (`scripts` skill) |

**Readers and the reviewer** (and only our own agent types) run these read-only shell commands without a grant: `git -C <checkout>
log|show|diff|status|rev-parse|merge-base|ls-files` and `rg`, `grep`, `find`, `ls`, `wc`, `head`, `tail`, `cat`, `sed -n`, `stat`,
`file`, `diff`, `jq`, `tree`, `sort` (no `-o`), `uniq` (one operand), `cut`, `tr`, `nl`, joined by `|`, on paths inside `~/.lean-agent` and
the registered projects. A glob (`src/*.ts`) is allowed when every file it can match is inside those folders (no `..`, no link out, no
name that could read as a flag), `2>/dev/null` is allowed, and `rg`/`grep` with no path search the current folder when it is inside
them. Still refused: any other redirect, `;`, `&&`, `||`, `$(...)`, backticks, `xargs`, `cd` (use absolute paths), `sort -o`, `uniq in out`,
a path outside the roots. A worker whose edit is refused for a path outside its `allow-edit` grant stops and reports that path.

Defaults (mistakes are expensive where the work happens): threads run on sonnet / effort high (`config.json` `threads.model` /
`threads.effort` override; `lean_thread new|start` `model` / `effort` override per thread); the desk is sonnet / high again (the opus pin of 1.0.10 and 1.0.11 is reverted; `lean_doctor fix` replaces it; a `config.json` `desk.model` / `desk.effort` you set wins);
`worker-sonnet`, `worker-opus` and `reader-sonnet` run at effort medium (a worker does one briefed task; the thread that briefs it
carries the reasoning), `reviewer` and `auditor` at high (a missed finding costs more than the tokens), the haiku agents and the explorer at low.

**Expensive models.** Opus (or anything that is not haiku or sonnet: a deny-by-default test, so fable and unknown names count) needs
your approval, and only your press in the desk pane gives it; no `lean_thread`, `lean_doctor` or `lean_script` action, no `config.json`
value (a session can write the lean-agent folder) and no message can. `lean_thread new|start|reopen|restart|resume` that asks for one,
with a reason, does NOT start the thread: the request (thread, model, effort, reason) is a card in "Needs you" with **Approve** and
**Deny** (two presses each) and **Start on sonnet instead**, and the reply tells the desk to ask you to press Approve. Approve starts it
on that model; Deny, or no answer, leaves it unstarted. Inside sessions the guard refuses an Agent call to `worker-opus` or to any agent
whose model resolves to an expensive one, an Agent `model` override to one, a Bash `claude ... --model <x>` (or `-m`), a `lean_compare`
on one and a review on opus without your approval ("opus needs the user's approval: report it and stop"; the thread reports blocked, and the
refusal is a card to approve or deny). An approval is signed (HMAC, the review key in the mod's own store), for ONE thread (or the desk)
and ONE model family, ends when the thread closes and after 24 h at most, and is logged in the thread's `history.jsonl` with the time and
what was approved. A desk the app started on an expensive model is switched to sonnet / high at start; when that cannot be done a red
"Needs you" row says so. Your own `/model` or the app's menu is your choice and is never blocked. `lean_doctor stats` shows the opus
share of the window's spend with the threads on it, and `check` has a FIX row when opus is over 40 % of the last 7 days' spend.

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

### Rules PR: the team gets what lean-agent learned

Learned rules live in `~/.lean-agent`, so only the user benefits. Ask the desk "propose a rules PR for `<project>`": it routes
the work to a thread with the `rules-pr` skill, which opens a **draft** PR that improves the project's own Claude files
(every `CLAUDE.md`, `.claude/rules/*.md`): path-specific sections move out of the always-loaded files into `.claude/rules/<topic>.md`
with `paths:`, rules lean-agent saw used again and again are added in the team's voice, stale and duplicate lines go. The push
and the PR follow the usual flow (the thread reports "ready to push", the desk asks you, nothing is pushed without your yes).

No model counts anything. `lean_rules` `pr-plan` reads the repo's Claude files (tracked or not; `CLAUDE.local.md` counts for
tokens but is never changed), the rule-load log, the review lesson store and the workers' "missing context" reports, and writes
`~/.lean-agent/<project>/rules-pr/plan-<date>.json` and `.md`:

| What | How it is decided |
|---|---|
| tokens per session before -> after | characters / 4 of every file that loads in every session (root and `.claude` `CLAUDE.md`, rules without `paths:`) vs only in an area |
| sections to move | an always-loaded section whose heading or text names one folder or glob that exists in the repo (not one that holds most of the repo) |
| rules to add | a lean rule loaded in at least 3 sessions over at least 7 days (`config.json` `rulesPr.minSessions`, `minDays`) whose lines are not already in the repo; lines that are stale or name lean-agent, thread ids, costs, personal paths, emails or ticket numbers are left out |
| stale lines | backticked paths and symbols the repo no longer has (`remove` when every name is gone, `review` when only some are) |
| duplicates | lean rules and lessons whose lines are in the repo files, and repo lines said twice (the copy that loads in fewer sessions goes) |
| missing context | workers' `missing` reports clustered by words, recurring and not covered by any rule |

The PR body carries the table of tokens per session, the moved sections, the added rules with their evidence (sessions, days,
missing-context counts) and the removed lines. After the PR merged, `lean_rules` `retire-upstreamed` (dry run unless
`apply: true`, which needs `ref: origin/main`: only merged, committed text counts) retires the lean rules and review lessons whose
text now lives in the repo files into `rules-pr/retired/<date>-<time>/` so nothing loads twice; `lean_rules` `check` lists the duplicates that remain.

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

**Two levels, so a review does not eat the day.** `lean_review` `prepare` takes `level`: **light** (the default) is ONE sonnet pass on
correctness, behaviour and reuse, for an intermediate checkpoint, and **never records green**; **full** is the strict review below
(every pass, two runs for a high-risk diff, the record the push gate needs) and is asked for only right before the thread says "ready
to push". The level a sha was prepared at is kept in the mod's own store, so a light pass cannot be recorded green by leaving the level
out of the record call; a full review never takes a light pass for "the last reviewed sha". `prepare` also prints
`expected review cost ~$1.20 (2 passes, sonnet; median of 5 earlier reviewer passes on this project)`: the median cost of this
project's earlier reviewer passes in the usage ledger, else a stated default of $1.50 a pass. It carries the thread's own registered
worktree (every reviewer command is `git -C <worktree> ...`) and the `allow-cmd:` line for it. **Generated files are left out** of the
file lists, the risk, the line count and the diff the reviewer reads (it gets `':(exclude,literal)path'` pathspecs for them; a change that edits `.gitattributes` cannot mark its own files, and `record` reads the same worktree `prepare` did): files marked
`linguist-generated` in `.gitattributes`, `*.snap`, paths under `golden` / `fixtures` / `__snapshots__`, lockfiles (`package-lock.json`,
`pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`), minified bundles and the globs of `config.json`
`review.exclude` (`{"review": {"exclude": ["docs/api/**", "*.gen.ts"]}}`); the text says how many files and lines were left out.

**The review is strict** (the 0.45 review, restored): ordered passes, inputs computed by a script and enforcement by a script.

- **Passes**, in order: 0 completeness (what the change promises against what it delivers, self-declared gaps); 1 correctness, each
  changed path traced from its entry points to its effects; 2 behaviour before -> after (intended or unintended), `risks` with one
  concrete check each, side effects the old code did that the new code no longer does; 3 reuse and duplication (at least one search
  per new symbol; verdicts `wraps-existing`, `extends-existing`, `duplicate`, `justified-new`); 4 scope and platform (siblings checked
  and listed; does a lifecycle already do it reversibly); 5 tests (a coverage table: edited test -> what it protected -> `still-covered`,
  `lost` or `intentional`; would the new test fail without the fix); 6 defaults and state (a defaulted parameter every production
  caller passes, widened values and their consumers, module state the specs never reset); 7 style, last.
- **Severity**: `blocker`, `major`, `minor`, `nit`. Duplication is major only for ~10+ copied lines or a second mechanism (smaller
  is a `style` minor); a fix too narrow for its siblings is major; "optional" is minor; a finding the reviewer did not verify
  goes to `checks`, never major. The reviewer ends with one JSON block (`findings`, `gaps`, `user_facing`, `risks`, `checks`, `reuse`,
  `coverage`, `siblings`, `searches`, `unverified`).
- **Inputs by script, not model**: `lean_review` `prepare` (project, base, head, branch) reads the diff and lists new symbols and
  files, tests whose assertions the change edits (renamed, flipped, deleted, skipped; a pure rename needs nothing), new parameters
  with defaults, new module-level state and changed, moved or removed exported symbols. The heuristics are language-agnostic
  (TS/JS, Python, Go, Rust, C#, Java, Kotlin, Swift) and err toward listing more; the reviewer extends the lists.
- **Enforcement by the record**: `lean_review` `record` recomputes those lists from the commit itself and REFUSES green (the record is
  written not green, with the reason) when a new symbol has no `reuse` entry, an edited test has no `coverage` entry, a second-opinion
  candidate was not confirmed or rejected, or a blocker or major finding is open. Duplication, scope and platform findings are at least
  major; so are an unintended user-facing change, a removed side effect and a goal-blocking gap; a `duplicate` verdict next to existing
  code outside the change becomes a major duplication finding; a short `justified-new` next to an existing candidate becomes a check.
  The HMAC signing is unchanged: only the tool signs, and a green needs the reviewer's JSON.
- **Declines**: `lean_review` `decline` (project, branch or `all`, finding kind plus symbol, why) records a decision the user made.
  Later reviews of that branch are told and a matching finding is left out, on later commits too; a decline never turns a verdict
  green by itself (the open findings are what the gate counts).
- **Second opinion and model**: for a new abstraction or a big diff (3+ new symbols, 2+ new files) a cheap `reader-haiku` search-only
  pass (or 12+ changed files with something new in them) looks for existing code first, and the main reviewer must confirm or reject each candidate. The reviewer is **always sonnet**
  and `prepare` prints who reviews and why: for a high-risk diff (security, concurrency, migrations/schema/storage, UI strings/locales,
  public API, config formats, removed public symbols or ~800+ changed lines) `reviewer: sonnet x2 (risk: ...)`, TWO independent sonnet
  passes whose JSON blocks are merged like 0.45's `review --runs 2` (`lean_review` `record` with `reviews: [a, b]`, or `merge` first:
  findings matched by category, file and wording, `[2/2]` when both found them, `[1/2]` otherwise, the union counts, so a major only one
  run found still blocks; a high-risk diff with one block, two identical blocks or a hand-written `runs: 2` is never green);
  `reviewer: sonnet (...)` otherwise and on every re-review. Opus reviews only when `config.json` `review.model` is `opus` or the brief
  explicitly asks AND you approved it for that thread in the pane; without that approval sonnet runs and a request waits in "Needs you".
- **Re-review**: pass 2+ gives the reviewer only the open findings, the declines and the diff since the last reviewed sha (plus the
  reuse, scope and platform passes on the files changed since). An earlier round's `reuse` and `coverage` entries still count (kept in
  the mod's own store, which a session cannot write), an earlier blocker or major must be listed again or named in `fixed`, and a new
  major about code that did not change since is a minor, so it converges. A record is refused green when git could not produce the diff,
  the range is empty, or `base` is not a branch or tag name (a sha or `HEAD~1` would shrink the range).
- **Project lessons**: the review loads the matching review checklist and shared-helper lessons through `lean_review` `lessons`
  (the lesson store is owned by a separate change; the review skips it when the action is absent).

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

**Alerts by default** (they warn, they never refuse a request): `{ "budget": { "daily": 25, "threadDaily": 20 } }` (USD; both are
the defaults, `"off"` turns one off). The desk gets a notice (the pane lists it) and a toast when the day's spend reaches 50% and 80% of
`budget.daily`, once per day per level, with today's spend, the top 3 threads by cost and their models; and when one thread passes
`budget.threadDaily` (once a day per thread). The goals chaser also asks a stale thread that is over `threadDaily` what the spend bought.
A thread's cost today is on its pane card (`ThreadRow.cost`); `threadCostsToday` in `stats.ts` adds its model and whether it is over the alert.
Doctor counts "the desk spent $X on opus today" only from the moment lean-agent pinned the model (earlier spend is a note), and shows
"opus is N% of spend" as a FIX only while a thread is on opus now (then naming only those threads), otherwise as a note.

## Context size

Every request pays for the whole context in cache reads, so lean-agent keeps contexts small without interrupting work:

- **A thread that reports `done` is finished as a session.** When its last report is `done` and its turn has ended, the desk's
  10 s tick stops its process ("t3 finished: next message starts a new session"; the pane row says so). A thread that reported
  done but is still on a final step is stopped only once it is idle. Any later `send`, `wake`, `resume` or `start` for it starts a
  NEW session with a handover (brief, goal, notes, reports including the done report, queued messages, branch and worktree), never a
  resume of the old conversation (unless the thread is in keep mode, below). Nothing checkpoints a thread mid-work.
- **Restart buttons** (the pane, instead of any automatic restart): every open thread card has `Restart` (press twice: the second
  press confirms; a working thread's label warns that the current step is lost). It stops the session (only one in the thread's own
  folder) and starts a new one with the handover, same model and effort ("Restarted from the pane."). The desk can do the same with
  `lean_thread restart tN` when you ask. `Restart desk` (or `/lean-agent-restart-desk`) writes `~/.lean-agent/desk/handover.md` and
  opens a new desk session, which reads it. The mod cannot close the old desk (no engine call closes a session; it is a Desktop session,
  which `claude rm` and `claude stop` are not assumed to reach): it records the old session's id and title before the new desk opens, and
  the new desk's first notice, then once per desk turn, and the doctor name it and say "archive it in the Claude app (right-click,
  Archive)" until `claude agents --json --all` no longer lists it as an active row (a row is taken as archived only when the listing says
  so: that field is an assumption, so the reminder also ends 7 days after the restart). A desk the listing never shows cannot be checked:
  the reminder ends 24 h after the restart, or with `lean_doctor dismiss-old-desk`. `claude rm <id>` (no flags) runs only when that exact id
  is listed as a background-kind session that is not working and lives in the desk folder; the result is logged in
  `~/.lean-agent/desk/old-desk.json`. The mod never stops the Claude app or a service.
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
  the desk is over `deskTokens` the pane shows, under "Needs you", "desk context Nk: the app cannot compact the desk automatically.
  Press Restart desk (fresh desk with the handover) or type /compact" with the `Restart desk` button on the same card (press twice;
  the header's bar has the same button from 80 % of the limit).
  `lean_doctor check` shows it as a `note` row, not `FIX`. The mod does not send `/compact` itself: no engine call is documented to
  run a slash command in a headless session.
  The 1.0.6 key `checkpoint.deskTokens` is still read; `checkpoint.threadTokens` and `checkpoint.enabled` do nothing (the thread limit
  below is the top-level `threadTokens`, a different rule: it acts at the next message, never mid-work).

### Thread context limit and keep mode

Two Opus threads averaged about 180k tokens of context per request, and cache reads of a long conversation dominated a whole day's
cost. So a thread's context is capped, at turn end, and a thread can opt in to keeping its session after it reports done.

- **What is recorded.** The thread's own mod writes its context size at the end of every main-thread turn into the thread's folder
  (`~/.lean-agent/threads/tN/context.json`: `tokens`, `at`, `sid`; a temp file moved over the old one, so a reader never sees half a
  file). The engine raises `session.measure` after each turn in which a figure moved; its `context` is what `$.session.usage()`
  answers, and `context.tokens` is the input tokens the last request was answered over (uncached, cache-written and cache-read
  together). `Stop` is not used: in the engine's types it is the person pressing Esc or Ctrl+C, not the end of a turn, and the classic
  `Stop` hook carries no size. Subagent turns do not raise it, so only the thread's own conversation is measured.
- **What happens at the limit** (`threadTokens`, default 120000): nothing mid-turn, ever. When the NEXT message for the thread arrives
  (`send`, `wake`, `resume`, the chaser) and the session is idle or done, its recorded size is compared with the limit. Over it (one
  token over, equal is fine): a NEW session starts with the handover (brief, goal, notes, reports, queued messages, task first)
  instead of a resume, and the reply says so: "context was 142k (limit 120k): started a new session with the handover (old
  conversation kept read-only, not resumed) ... handover about 9.0k tokens (~$0.05 first turn, estimate)". A working session is never
  touched: the message queues as before and the check runs when it is idle or done. A usage-limit resume skips the check (that session
  was stopped inside a turn, so its last turn-end size is not current).
- **When the size is not known** (a thread from before this feature, a write that failed, a record made by an older session id of the
  thread, a damaged file) the session counts as under the limit and is never restarted on a guess; `lean_thread list` says `ctx unknown`.
- **The warning.** The card, the thread pane and `lean_thread list` show `ctx 108k/120k`: dim up to `threadWarnTokens`, yellow above
  it, red over the limit (the line then says the next message starts a new session). `threadWarnTokens` defaults to 100000 (83% of
  `threadTokens`, to the nearest 1000, when only `threadTokens` is set; it never exceeds the limit).
- **Keep mode** (off by default): `keep: true` on `new` / `start` (the new-thread form has a "Keep session" choice, off), or
  `lean_thread keep tN on|off`; stored as `keep` in `thread.json`. Without keep a thread that reported done is finished as a session and
  its next message starts a new one ("new session (not in keep mode)"). With keep it is NOT finished: follow-ups resume the same session
  ("resumed (keep mode): context 85k, cached re-read ~$0.04 (estimate)") until its context passes the limit, and then the restart above
  applies (the limit wins over keep). A resume re-reads the whole context from the cache each turn; a new session pays one small
  uncached handover: keep mode pays off only for many small follow-ups to the same thread.
- **What it costs.** The numbers are estimates from lean-agent's own price table (`hooks/budget.ts`): a fresh session's handover is
  priced as uncached input of the model it starts on (about four characters a token), a resume as the recorded context read once from
  the cache. No model computes anything.
- **Config** (`~/.lean-agent/config.json`, tokens, whole numbers of at least 10000; anything else, a string included, is ignored and the
  default applies): `threadTokens` (default 120000), `threadWarnTokens` (default 100000).

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
| `threads/tN/context.json` | the thread session's context size at its last turn end (`tokens`, `at`, `sid`), written by the thread's own mod |
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
- **A thread runs an older lean-agent than the installed one** (`lean_thread list` and the start reply say "running 1.0.9, installed 1.0.11"; its
  `review` skill comes from `~/.claude/plugins/cache/<marketplace>/lean-agent/1.0.9/`, its `lean_review` lacks newer fields, a guard refusal
  ends with `(lean-agent 1.0.9)`). The thread's own mod writes the version it runs into `thread.json` (`running`) at its session start;
  `thread.json` `version` is only what the desk saw installed when it started the session, which is why this used to go unnoticed.
  *Cause, as far as it could be established:* lean-agent pins nothing (a thread's `settings.json` only switches OTHER plugins off, and
  `claude --bg` is started without `--plugin-dir`); the plugin cache keeps every installed version's folder, so an older path still
  resolves; and Claude Code applies a plugin update only to a session started after it (`claude plugin update` says "restart required to
  apply"). The thread above was started from the pane while the background service behind `claude --bg` still held the plugin it
  loaded at its own start, and a session it starts gets that state, not the installed one. This was concluded from the code and the CLI
  (not reproduced: it needs a service started before an update). *What you can do:* when no thread is working, quit and reopen the Claude
  app (that restarts the service; `claude respawn <id>` restarts one session onto the current binary, whether it also reloads plugins
  was not verified), then restart the thread from the pane; the start reply shows the version it now runs. The doctor shows a
  `FIX thread tN running X, installed Y` row with this advice. lean-agent never restarts a service itself and never tells the desk to.
  Until it is fixed, do not ask that thread for anything its version lacks.
- **"Open tN" opened a new desk (or a new empty session) instead of the thread** (reported on a Mac with 1.0.12). *Not verified:* whether the
  app resolves the id of a `claude --bg` session with `claude://resume?session=<id>`; the mod only hands the link to `open` and cannot see
  what the app shows, so it never says the right session opened (the reply says "if a new desk opened instead, close it" and names the
  session). What the mod does regardless: a session started in a thread's folder (`~/.lean-agent/threads/tN`) is that thread whatever
  its session id (it never becomes a desk, and its id is recorded in `thread.json` `sids`); a session in `~/lean-agent-desk` is the desk.
  *Checks to run on the Mac, and what each result means* (please report the three outputs):
  1. `claude agents --json` — find the thread's row (its `name` is `tN · <title>`) and note its session id and `cwd`.
  2. `open "claude://resume?session=<that id>"` by hand, with the thread idle (press "Open tN" does the same after stopping its process).
     Does the app show that thread's conversation, or a new session?
  3. `claude agents --json` again — compare: the same id (the app resumed it), a NEW row or id in the thread folder (the app resumed it as a
     copy: lean-agent now treats that copy as the thread, but its history is the copy's), or a new session in another folder (the link did
     not resolve the id).
  Whatever the link does, `claude attach <id>` in a terminal reaches the thread's own session, and the app's session list shows it by name.
- **A script audit never got a verdict** (`lean_script show` says "unaudited" after the auditor finished, or `decide` says "was never audited").
  The mod records the verdict from the auditor's `LEAN-AUDIT` line when the auditor's Agent call returns; with a background auditor that
  return carries no verdict (1.0.12 forces auditor calls to the foreground; whether the engine honours that is *unverified*). Now:
  `lean_script audit` says "Audit started; verdict not recorded yet" and `show` says "audited, waiting for the verdict" until it arrives;
  the audit thread passes a background hand-back on with `lean_script record-audit` (name, sha, verdict, flags, reason; the mod checks it
  like a reply and needs its own record that an auditor started with the exact brief for that text), and `decide` falls back to the audit
  thread's last report with a `LEAN-AUDIT` line for that script text ("verdict taken from the audit thread's report", logged). Only one
  audit thread runs per script text. A network flag still needs your explicit adopt. A verdict passed on with `record-audit` is only as
  reliable as the session that relays it, so it is recorded but never adopts by itself: an `adopt` waits in the pane for your Adopt /
  Reject (`decide`); `adapt` and `reject` take effect as for a reply.
- **A rule does not load**: it must be a real file in `.claude/rules/lean-agent/`; `lean_rules sync` recreates it.
- **A thread seems stuck**: `goals` shows its last goal line; a status request goes out after an hour of quiet.
- **Spend refused**: `budget` shows which cap was hit; raise it in `config.json`.
- **A push is refused because the branch's worktree is registered to a closed thread**: nothing to fix by hand. The push takes the registration over for the pushing thread by script (live linked worktree of the project, HEAD at the approved sha, all push gates green); `lean_worktree register` from the thread does the same. A worktree of an open, parked or closing thread is never taken over: ask that thread to close it. `doctor` lists worktrees owned by closed threads.

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
