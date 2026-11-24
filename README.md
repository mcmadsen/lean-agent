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
| stalled | alive and working, but no tool call and no report (the thread's or a worker's) for `threads.stallMinutes` (default 10), or a message unread that long; red, one notice per stall; `threads.stallRestart: true` restarts it by script |
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
6. **Footer actions.** **New thread**, **Feedback export** (the anonymised export file of `/lean-agent-feedback`, sent where `config.json` `feedback.destination` says: the button names it, e.g. "exports to ~/Downloads"; a GitHub post only after your Approve),
   **Setup / repair** and **Restart desk**, always here (the header's button shows only near the limit; both press twice and do the same).

In the minimized widget form (Claude desktop), the pane draws a glance and no button, because clicks may not reach it: threads
running and blocked, how many need you, the desk's context in percent and today's spend. On a narrow body (under 50 columns) the
rows get shorter and the buttons wrap; the tree is the same on the terminal, the desktop app, VS Code and mobile.

**Notifications.** The desk shows a toast, once per event, when a thread enters "Needs you" (an approval, a question, a report ready
to push, a blocked thread) or reports done. A script decides, no model is involved. The first pass after an install only records what
is there. `config.json`: `{ "notify": { "toast": true, "sound": false } }`; `toast: false` silences it. `sound` does nothing yet: the
engine plays only an audio file the plugin bundles, and lean-agent ships none (speech would read thread titles aloud, so it is not
used either).

**Header, Dismiss, tips.** "lean-agent is not set up" and the Set up button show only while the setup itself is missing; other doctor
findings read "Doctor: N findings (F fix, I info)". Every Needs-you card (a question, a prompt wait, an approval, a blocked or stalled
thread, a ready report, a model or write request, a script) has a two-press **Dismiss**, and every line at the top (budget alert, notice, doctor finding, plan window,
the message of a pane action) a one-press one: it is logged in the history (who, when, what), hides that item until a newer one of its kind arrives (a
newer question, prompt wait, blocked report; the next threshold or day; changed text), never answers a question, and the record stays. "Needs you (N)" and
`lean_thread list` leave dismissed items out; "N dismissed" has a **show** toggle. `lean_thread dismiss tN`, `dismiss tN kind:<kind>` or `dismiss notice <id|all>` does the same on your word. `/lean-agent:list` lists threads
(`/lean-agent:threads` is the old name). When you ask the desk for something a direct command does, it adds one line "Tip: do this directly
with /lean-agent:review <pr>" (once per command per day, quiet for a week after you used the command; `config.json` `"tips": false` turns it off).

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

### When Claude Code's permission check denies a worker (no prompt exists)

Claude Code's auto-mode classifier can deny a thread's worker call ("Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Destructive or Unwanted Actions]"). In a background session that is a denial, not a question: **there is no permission prompt and nothing to press**. lean-agent says so (the pane card and the desk text read "no permission prompt exists for tN: the auto-mode classifier denied a worker call (reason ...)") and never shows an `Open tN` button unless the session list (`claude agents --json`) shows a real prompt. What helps:

1. **The thread does the step itself.** After a denied worker call the thread's own Edit / Write / NotebookEdit / Read / Grep / Glob are allowed in its registered worktrees (plus the worktree folders and absolute paths the denied brief named) for the rest of that session, never in lean-agent's own state. The engine's own permission check still judges each edit. Logged as `delegation-denied` with the reason category.
2. **Retry with a narrower brief.** A broad brief ("remove all legacy code across several packages and docs") looks destructive to the classifier; a small additive step does not. ONE file plus its spec, the exact change, one test command, an additive step first, your own words quoted as the authority (the mod gives the thread the ones it recorded), never one worker for a repo-wide removal or rewrite. A script checks the denied brief and says "this brief is broad: split it" with the counts.
3. **Let the thread edit its worktree itself (your word).** Say it in the chat ("let tN edit its worktree itself", "go ahead, do it yourself"), press the pane's **Let tN edit its worktree itself** button, or answer the desk's question: the mod makes a signed grant (the thread's registered worktrees only, 24 h or until the thread closes) and shows your words in the pane ("tN may edit its worktree itself (your words: '...')") with a **Revoke** button. The mod only accepts words you typed that name the thread and carry an instruction; no tool action or thread text creates a grant. `/lean-agent:allow-edit <tN>`, `/lean-agent:revoke-edit <tN>`, or type "stop editing" / "revoke". Counted as `self-edit-grant`.

### Files for your folders: `lean_thread deliver`

A thread never writes to Downloads, Desktop or Documents itself (a worker gets EPERM on macOS, and a hook refuses it). It writes the file you asked for to its `scratch/` folder and the desk calls `deliver` (tN, file, to, name?): the mod copies it (never overwriting: `name-2`, `name-3`) when your recorded words of the last 24 h name the folder or say "save" / "put it in"; otherwise the desk asks you with a question that names the file and the folder. If macOS blocks the Claude app from the folder, the reply says exactly where to allow it: System Settings > Privacy & Security > Files and Folders (or Full Disk Access).

### Remote writes go through the desk (typed actions)

A thread may not make a remote write itself (Claude Code's permission check or classifier denies it, and the user would have to answer
in the thread's own session). So it asks, and the desk's mod performs the write after the human said yes, the way `push` already works:
no model ever bypasses a permission check, and no hook carries a decision.

1. The thread calls `lean_report` (state blocked) with `action: {kind, params, why}`. The kinds are a fixed table
   (`hooks/deskactions.ts`), nothing else: `ado-pr-reply` {org, project, repo, pr, thread, body, status?}, `ado-pr-thread-status` {org,
   project, repo, pr, thread, status}, `ado-pr-comment` {org, project, repo, pr, body}, `ado-workitem-comment` {org, project, id, body},
   `ado-workitem-update` {org, project, id, fields: state, assignedTo, tags, title; strings}, `gh-pr-comment` {repo (owner/name), pr,
   body}, `gh-pr-thread-resolve` {repo, pr, thread (the review thread's node id)} and `batch` {items} (below). An unknown kind or param
   is refused with the list; pushes, merges, deletes and settings changes are not in it.
   - **Thread status.** `status` is one of active, fixed, wontFix, closed, byDesign, pending (case-insensitive; sent as the REST value in
     `PATCH .../pullRequests/<pr>/threads/<thread>?api-version=7.1`). `ado-pr-thread-status` sets it alone and is rendered "set thread 7
     of PR 42 to fixed". An optional `status` on `ado-pr-reply` is the same ONE request and ONE approval: the card shows the text AND
     "then set the thread to fixed"; the mod posts the reply, then sets the status, and only if the reply worked. The result says what
     happened to each ("reply: done; status: failed (...)"); a reply that fails sends nothing and the request stays retryable, a status
     that fails after the reply leaves the request used (the reply is never posted twice) and the thread asks again for the status.
     `gh-pr-thread-resolve` is the GitHub twin (`gh api graphql`, the `resolveReviewThread` mutation, argv only).
   - **One approval for several writes.** `action: {kind: "batch", items: [{kind, params}, ...]}` holds up to 10 items of the kinds above
     for ONE target (the same org, project, repo and pr, or the same work item, or the same GitHub repo and pr; a second target, a
     nested batch or an eleventh item is refused). The question and the card list every item, numbered `1/3 ...` in order, with its exact
     text; the check code hashes all renderings, so one Approve covers exactly that list. The mod runs them in order, stops at the first
     failure and reports each ("1: done; 2: failed (HTTP 409); 3: not run"). Deny, Edit first, expiry and the hash check work as for one
     write; once any write went out the request is never repeated whole.
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
desk says so ("could not be read by the mod") and the pane's Approve / Deny on the card is the human's decision instead.

#### Standing approval for status changes (never for text)

"Ask nothing of me" for the low-risk writes: only `ado-pr-thread-status` (status fixed, closed or active) and `gh-pr-thread-resolve`, never a
reply, a comment, a work item update or any kind that carries text. Two ways, and both are the user's own act:

- **From the card.** A Needs-you card of such a request (and the desk's question) has a third choice, "Approve, and allow status changes on
  this PR for 24 h" (two presses in the pane). The mod sends this request and stores a signed grant {thread, org / project / repo / pr (or
  the GitHub repo and pr), kinds, statuses, expiry}: valid 24 h or until the thread closes, for that thread and that PR only, logged in the
  thread's `history.jsonl` (`standing-grant`). A tool cannot create one: no action kind, report or message writes the grant store, and a
  spec (in `skills-contract.test.sh`) keeps the writer to the human's answer (the pane press, or the answer to the desk's question as the
  tool result carries it).
- **A rule you write by hand** in `~/.lean-agent/config.json` (sessions cannot write that file; the guard refuses it):
  `"actions": { "standing": [{ "project": "Shop App", "kinds": ["ado-pr-thread-status"], "statuses": ["fixed"] }] }`. `project` is the
  Azure DevOps project (for `gh-pr-thread-resolve`: the repo, `owner/name` or the name, or the lean-agent project of the thread). The rule
  is not bound to a thread or a PR. Only fixed, closed and active can be named.

With a grant or a rule, a request of those kinds is executed by the mod at once, by the same executor as an approved request (signature,
hash re-check, token on stdin), reported to the thread in the `lean_report` reply, and shown in the pane as "sent under your standing
approval: set thread 7 of PR 42 to fixed" with a **Revoke** button for a grant (a rule is removed by editing `config.json`). A `batch` is
covered only when EVERY item is covered; one reply or comment in it, another PR, another thread (for a grant) or another status and the
user is asked as usual. `lean_thread action-list` shows the active grants and the number of rules; the desk does not ask again.

#### Approvals: in advance or by question

A thread's remote write goes out in one of two ways, both the human's: **in advance** (a written accept of the user's own, below) or **by
question** (the desk asks with AskUserQuestion, naming the exact text, as above). A request whose every write is inside a live written
grant is sent at once; anything else is asked.

- **The user's words, captured by the mod** (`hooks/humanprompts.ts`). In the desk session the `prompt.submit` hook keeps the user's own
  prompts of the last 24 h (text, time) in the mod store. The engine says where a prompt came from (`origin.kind`, a closed set it sets itself,
  which no hook can change; and `isMeta` for a prompt the person does not see as typed): only `composer` (the person's Enter, typed or queued,
  or a click on a transcript link) and `bridge` (the person's message through Remote Control, phone or web) are recorded. A thread report
  relayed into the desk (a plugin's own `$.prompt.submit`, origin `plugin`), a scheduled wake, a task notification, another session's
  message, a channel, the SDK host, an `unclassified` turn and any `isMeta` prompt are never recorded, and a hook's added context is not part of the
  text. In a session an app shows (the Claude desktop app, an IDE, a phone) the person's typed turn arrives through the SDK host (`sdk`): it is recorded there, and only there; a `claude -p` run from a shell is `sdk` too but has no app surface, so it records nothing (and a subagent may not start a Claude session at all). An event with no `origin` records nothing: the desk then always asks. The engine marks no paste (it is expanded into
  the text), so a prompt longer than 1500 characters is not recorded: an instruction is short, a long one is a pasted document. Nothing a tool
  call or a thread writes lands there.
- **The advance accept.** `lean_thread allow-writes` {tN, target: {pr: number or URL | workitem: id}, kinds?} (or the user's command
  `/lean-agent:allow <tN> <PR or wi <id>>`, whose text is the user's prompt and counts as the instruction itself). The desk model may PROPOSE the
  scope; the mod creates the grant only if ONE recorded human prompt of the last 24 h (a) names that target (the PR number or its URL, the work
  item id: digits match as a whole token, never inside 1042, 142, 42.5 or 1,042; a number after "work item" is not a PR) and (b) carries an
  instruction for that work from the script table in `hooks/writeinstr.ts` (fix | resolve | address | answer | reply to | handle | respond to |
  close | update ... comments | threads | review | feedback | PR | work item, or approve | allow | go ahead | yes ... writes | replies | comments; a
  verb right after "don't" / "never" does not count). No model judges it. Otherwise: "no written instruction from the user covers <target>:
  ask with AskUserQuestion", nothing is created.
- **The grant** is signed (the mod's key) and holds the thread, the exact target (org / project / repo / pr or work item, read from the thread's
  project remote when only a number was written; a URL proposed without the URL in the user's words must be the project's own repo), the kinds
  (a PR: reply with its status, thread status, comment; a work item: comment, update), an expiry (24 h, or the thread closing), a cap of
  writes (`actions.maxWritesPerGrant` in `config.json`, default 40; a reply with a status is two) and the quote of the words it rests on.
  It replaces a grant of the same thread and target. The grant row is re-signed with each count, so a hand-edited row is no grant.
- **Execution.** A request whose EVERY item is inside a live grant (same thread, same target, allowed kind; a batch only when all are) is sent by
  the mod at once through the same executor as an approved one (signature, hash re-check, token on stdin), counted against the cap, logged in
  `history.jsonl` (`writes-sent`, with the grant id), reported to the thread in the `lean_report` reply, and shown in the pane as "sent under your
  instruction '<quote>': reply to PR thread 7 on PR 42 (...): <text> (write 3 of 40)" with a **Revoke** button. GitHub: `gh-pr-comment` is
  covered like the Azure kinds (its repo and PR are in the request); `gh-pr-thread-resolve` only after the mod verified by a read (`gh api graphql`,
  the thread node's pull request and repository) that the thread belongs to the granted PR, else it is asked. Never covered by any grant: pushes,
  merges, deletes, permission or settings changes, kinds outside the table, a target the user did not name, another thread's request.
- **Revoking** only takes power away: the pane's Revoke, `lean_thread revoke-writes` (tN or id), `/lean-agent:revoke <tN>`, or the user typing
  "stop writes" / "revoke" (with a tN or a PR number it takes only those; alone it takes all, and the 1.0.24 status-only grants with them).
  A closed thread keeps no grant. No `lean_report` action, thread text or tool call creates or extends a grant; only `allow-writes` with the
  user's recorded words does.

Not run live: the engine's `origin` stamps (specs drive the recorder with the documented values), the pane line and Revoke button on a real
surface, and `gh api graphql` against GitHub (specs use canned output).

Avoidable blocks: `lean_doctor refusals` groups the guard's recorded refusals by pattern with a count and a one-line fix, and the
doctor shows a `note top refusals` row when one pattern repeats (config `refusals.repeat`, default 3). Every refusal of the execution model
(desk routing, thread orchestrate, worker budgets, briefs, grants, `lean_run`, desk actions, trimmed results, the auto-restart guard, the review
and external-review gates) is one record (role, rule id, short text, version) in the same file, and a tool a session or worker needed and
did not have (or a worker's `split:` / `missing:` / `refused:` line) is a `missing-tool` record: the feedback export lists both, under "Guard
refusals" and "Missing tools". `lean_thread new` takes
`allowEdit` (absolute paths, at least two levels deep) and `allowCmd` (plain read-only commands): they are written into the brief as the
exact lines the thread copies into its workers' prompts, for work that needs a path outside the worktree (a repo's `.claude/skills/...`
file). No allow rule is added to any settings file to get past a classifier, and the guard is not widened for anything that writes or runs
a program.

### Replying to and resolving PR threads without a block

A thread **owns** a pull request only by an explicit signal: the desk started it FOR the PR (`new` with `pr`, a number or URL; a review thread's PR counts), it opened the PR with its own push, or your words named the PR for `/lean-agent:allow`. A PR number merely mentioned in a brief owns nothing (the `new` reply says "brief mentions PR <n>: it is not owned; pass pr to let <tN> reply without a question"). A work item is owned only when the thread created it, when the brief says `AB#N` / "work item N" and the branch name contains N as a whole token, or when your allow-writes named it; a number in a branch name alone is nothing. For its owned PR the thread replies, comments, links the PR to a work item and moves its own work item to Reviewing without asking you; the desk says so once and how ("<tN> owns PR <n> (you passed pr): ..."). What still asks you: resolving a thread (fixed / closed), votes, merges, pushes, deletes, creating a work item, anything on a PR or work item the thread does not own. Every send shows in the pane as a line with its exact text and a **Revoke** button; typing `stop writes` takes the default back, `actions.ownPrDefault: false` in `config.json` switches it off. Config: `actions.ownPrMaxPerDay` (default 20 writes per PR per day), `actions.ownWorkItemStates` (default Reviewing, Active, In Progress, Resolved).

A request waiting for your Approve does not stop the thread: it stays `working`, wears "waiting for your Approve: ...", and goes on with the steps that do not need it. In the desk's dialog the fourth choice, "Approve, and allow this kind on this PR for 24 h", covers a reply, a GitHub comment, a PR link, a thread status of fixed / closed / active and a work item state; a clear typed answer ("yes", "always approve") counts as the press, anything else is told to the desk, never dropped.

Threads can also create work items (`ado-workitem-create`) and link a PR to one (`ado-pr-workitem-link`); resolving a PR thread is `ado-pr-thread-status` with status `fixed`.

#### Where to type it

`/lean-agent:allow <tN> <n>` (or `lean-agent:allow <tN> <n>`, or `allow <tN> <n>`) goes to the **desk's prompt**, the chat box of the desk session, not a terminal. A shell-mode line (one that starts with `!`) runs in your shell and is **not seen by lean-agent**, so it is never recorded: that is why `! /lean-agent:allow <tN> <n>` ends in "no such file" and the same without the slash records nothing. You can also paste the PR URL (Azure DevOps with GUIDs, a work item URL or a GitHub PR) with "please handle this", or say "fix the comments on PR <n>". If it is refused, the answer lists these forms and quotes your last message when it was a near miss.

If a refusal says "no message typed by you since HH:MM UTC names PR <n>", the mod saw no prompt of yours that names it. Give `/lean-agent:allow <tN> <n>` as **plain text** at the desk prompt, never in a code block with a **Run** button: Run executes it in a shell (`zsh: no such file or directory`), where lean-agent does not see it. Or answer the question the refusal carries (or the desk asks with `allow-ask`): "Allow <tN> to post replies and comments ... on PR <n> ... for 24 h? [Allow / Not now]". Your **Allow** answer in the dialog is the written yes: the same grant as your words (24 h, at most 40 writes, Revoke), history "by the user in a dialog". Nothing a model sends makes that grant.

### Reading a forge

A status check after an approved write ("did the thread statuses land?") is a read and needs no workaround. A reader, a worker, the
reviewer and the thread may run a fixed allow-list of read-only forms (`hooks/forgeread.ts`); everything else stays as before, and a
forge write still gets the "forge writes go through the desk" text:

- `az`: `repos pr show|list`, `repos pr policy list`, `repos pr reviewer list`, `repos pr work-item list`, `repos show|list`, `repos ref list`,
  `boards work-item show`, `boards query`, `pipelines runs show|list`, `pipelines build show|list`, `pipelines show|list`, `devops invoke`
  with `--http-method GET` or no method, `rest` with `--method get` or no method and no `--body`, `account show`, `account get-access-token`.
- `gh`: `pr view|list|checks|diff|status`, `run view|list`, `issue view|list`, `repo view`, `release view|list`, `api` only as a GET (no
  `-X` other than GET, no `-f` / `-F` / `--field` / `--raw-field` / `--input`: those make it a POST), `api graphql` only when the query
  text starts with `query` or `{` (a `mutation` is a write).
- `curl` / `wget` to `dev.azure.com`, `*.visualstudio.com`, `api.github.com`, `github.com`: a plain GET (no `-X` other than GET, no
  `-d` / `--data*` / `-F` / `--form` / `-T` / `--upload-file` / `--json`, no output file outside a temp or scratch folder).

A read form outside the list is refused with "read it with lean_run get (forge reads by the mod), or one of: az repos pr show, az devops
invoke (GET), gh pr view, gh api (GET)"; the refusal record's rule id is `forge-read`.

`lean_run` `get` reads by the mod, so no token is ever needed in a shell: `{host: "ado", org, project, path, query?}` (a REST path under
the project, e.g. `git/repositories/<repo>/pullRequests/<n>/threads`) or `{host: "github", path}` (e.g. `repos/<owner>/<repo>/pulls/<n>/comments`).
GET only, forge hosts only, no `..` in the path. The Azure bearer token from `az account get-access-token` goes to `curl` on stdin (never
argv, a log or the output); GitHub goes through `gh api`. The answer is the JSON, cut to 8000 characters, and `select` (a list of dotted
field paths, e.g. `["value.id", "value.status"]`) keeps only those fields. The common check is a shortcut:
`lean_run {get: {host: "ado", org, project, repo, pr, threads: true}}` returns one line per thread: id, status, the first comment's first
80 characters. A thread and its workers may call it; builds are `lean_run {ci}`.

### Why a thread gets blocked (measured)

Measured on the feedback exports of three days (7 distinct files, lean-agent 1.0.5 to 1.0.12; the full table is in the changelog under
"Unreleased"): of 78 guard refusals, 68 were a reader, reviewer or explorer refused a shell command (63 of them under the git-only
wording that 1.0.9 and 1.0.14 widened; what is left, `cd`, redirects, `;`, `&&`, `$(...)`, `xargs`, paths outside the roots, refuses on
purpose) and 10 were the desk refused in strict mode (it routes instead). No worker `allow-edit` refusal was recorded. The blocks a
user had to answer in a thread's own session were 2 remote writes (an Azure DevOps work-item update, a PR thread reply) denied by Claude
Code's own permission check or classifier, plus 1 push the thread tried itself (the push gate is the desk's). The other `blocked`
reports were no permission block (an MCP server not signed in, a registry slot, a policy rule of the user's own project). So the
avoidable ones are the remote writes and the grants a brief forgot.

### The desk restarts itself

(Replaces the sentence in "The desk cannot compact itself in the app ..." that says `desk.autoRestart: true` (default false), and the "Restart desk ... press twice" wording: the button stays, but you rarely need it.)

A desk session lives for days and needs a new session now and then. The mod does that by script at the **end of a desk turn** (config `desk.autoRestart`, default **true**; `false` = the **Restart desk** button only), for one of four reasons:

| Reason | When |
|---|---|
| context | the desk's context is at 95 % of `deskTokens` (default 100000) or over |
| update | lean-agent was updated (`claude plugin update`) and this desk still runs the older version (the same comparison as the doctor's version-skew row) |
| model | the desk model pin could not be applied after two tries in this session |
| tools | the desk lost its tools: the mod's own send to a thread was refused with "this session has no SendMessage tool" |

It restarts only when all of this holds: this session is the current desk; no turn is running (an AskUserQuestion open is a running turn); the desk is shown in the Claude desktop app; no thread's question to you is open (over 120 % of the limit it goes on anyway: the handover carries the question); and the loop guard allows it: the last automatic restart was more than 30 minutes ago and fewer than 4 happened in the last 24 hours. Otherwise nothing happens, or, for the loop guard, ONE notice and the amber line say the desk needs a restart and the button is yours. A model or tools reason is not repeated for the same cause within 24 h (the new desk would have the same trouble).

What it does: writes the desk handover (script-built: unanswered thread questions, pending requests, pending approvals, grants in force, open threads with what each is doing, goals), records the old desk (`desk/old-desk.json`), and opens the new desk with the app's deep link. On macOS it uses `open -g`, so **the app does not come to the front**; Linux and Windows use their usual opener. A toast says what happened and why: "desk restarted automatically: context 104k". The state is in `desk/auto-restarts.json` (the guard) and `desk/auto-started.json` (what the new desk reads).

**The new desk knows.** Its first notice reads "this desk was started automatically at 09:41 UTC because context 104k; the handover was read" and then what the handover lists (open questions, pending requests, approvals, grants, threads). A desk started by the Restart desk button starts the same way, without the "started automatically" line.

**The old desk retires itself.** Two desks never both run timers. Once `~/.lean-agent/desk.json` names another session as the desk, the old session's timers (relays, the chaser, thread restarts, stall, continue-by-script, delivery to threads, budget alerts and toasts) do nothing, its prompt hook takes no reports and applies no pin, and it answers any prompt with one line: "this desk was replaced by a newer one (started 09:41 UTC): use the newer session". Resuming the old session by hand makes it the current desk again and retires the other.

**Archiving the old row.** The mod cannot close or archive a Claude app session: the engine has no close call, the app's deep links (`claude://code/new`, `claude://resume`) have no archive verb (the CLI binary lists only the scheme), and `claude rm` is for background sessions. So **each automatic restart leaves one old desk row for you to archive** (right-click it, Archive). The reminder is one quiet line: said once in the new desk's first notice, then a single line in the pane and a doctor row until the row is gone, 24 h have passed (7 days if it was listed as active), or you run `lean_doctor dismiss-old-desk`. It is no longer repeated in every desk turn.

**After an update.** The update instructions become: `claude plugin update lean-agent`; **the desk restarts itself after an update when it is idle** (at the end of its next turn, under the conditions above). Threads keep running the older code until their next restart, and a Claude background service that started before the update keeps handing out the old plugin: for that, keep "quit and reopen the app" (when no thread is working).

Not verified: the live Claude app. The specs run on a fake host (every reason, each blocking condition, the loop guard, the `open -g` argv, the toast, the new desk's first notice, the old desk's checks); `claude --desktop` and the app were not started in the build container, so whether the app really keeps the focus with `open -g`, and whether a freshly opened desk session finds the handover at its start, were not seen live.

### A thread restarts itself near its context cap (checkpoint)

A thread cannot restart itself, and the mod used to restart only at the limit (`threadTokens`, default 120k). A thread that saw the 100k warning and had written its notes could then only ask a person. Now it has a call of its own:

`lean_run {checkpoint: {next: "<the next step, 1-3 sentences>"}}`

- The mod writes the state snapshot and checks that the thread wrote `scratch/notes.md` (or `notes.md`) since the warning; if not, it writes the `next` text to `scratch/next.md` itself. It records `checkpoint.json` in the thread folder (reason `checkpoint`, the `next` text) and answers: "checkpoint saved. End your turn now: you are restarted automatically and continue with: <next>".
- The desk's timer starts a fresh session 10 seconds after the turn ended (a session that still works is stopped after `threads.stopGraceMinutes`): the core handover, and `next` as the LAST instruction. No desk message, no user step, no wait for the limit. One desk line: "t7 restarted itself at 104k (checkpoint)".
- Loop guard, shared with the limit restart: one automatic restart per thread per 10 minutes; a fresh session that calls it again sooner is told to keep working (the mod still restarts at the limit). `threads.autoRestart: false` turns it off. Only a thread's own session may call it.
- The 100k and 90% warning lines tell the thread to do exactly this and never to end its turn asking the desk or the user for a restart.
- A turn that ends with "Next: my context is near its cap, a fresh session continues ..." (phrases: fresh / new session, restart me / this thread / tN, "ask the desk to restart", near its / the cap, context limit) is treated as the same checkpoint restart by the "next:" continue code, never as "do the next step now" in the full session. A report that asks the desk for a restart is executed as a checkpoint too. An ordinary step such as "restart the dev server" is still just continued.
- The desk never restarts a thread for its context; it restarts by hand only when you ask.

## A thread that waits is never lost; a large PR is reviewed by area (1.0.29)

**A request in prose is caught.** A thread asks the user through `lean_ask` (a question) or `lean_report` with `action` (a write that needs approval): both put an item on "Needs you". A request typed into the prose of a `working` report (or any state except `done` and `blocked`, with no `action` and no open question of that thread) is caught by script: the sentences of the report are matched against one table (`hooks/requestwords.ts`: "for approval", "ok to post", "may I", "should I", "do you want", "please confirm", "waiting for your", "nothing is posted until", "tell me whether" ...; "approved earlier", "no approval needed", "you approved" are not requests). On a hit the report is delivered as usual, the mod writes the same two records a `lean_ask` writes (the desk question "tN seems to wait for your answer: <the sentence, 200 characters at most>" with the id of the report, and `waiting.json`), tells the desk at once, and the thread gets one line: *that read like a request for the user: use `lean_ask` or `lean_report` with `action`; the desk has been told*. The guide of a thread says it too.

**A restart while waiting.** A thread is WAITING when `waiting.json` exists (written at a `lean_ask`, a blocked report without an approval card, or a caught prose request) and nothing was done since, or its last report is a question or `blocked`. When such a thread is restarted (context limit, stall, escalation) the mod, by script and not through the thread:

1. puts the open item back to the desk (a mod row, same id, with the time since; the question stays on "Needs you");
2. gives the new session this lead instead of "do nothing": *You were waiting for the desk's answer to `<item id>: <first 200 characters>`. The desk has it open. If a message below answers it, act on it. If not, write ONE report with state `waiting` ('restarted at the context limit; still waiting on `<id>`') and end your turn.*;
3. when the store has no open item for the request (a prose request from before the catch), says *the desk has NO open item for it: re-send the request now with `lean_ask` or `lean_report` with `action`*;
4. writes the `waiting` report itself when the new session ends its turn without one (`holdSilentEnd`, at the turn end), so the thread never ends silently.

`waiting` is a report state next to `working | blocked | done`: the pane shows the thread amber, "waiting on the desk since 10:42 (waiting for your answer or approval; nothing done since)", never idle or done, from the original time of the question; an answer or any instruction from the desk clears it.

**A large PR.** `lean_review prepare` on a diff of more than 300 changed files (after the generated-file exclusion) or 20000 changed lines returns only counts (files, lines, by top-level folder, the 10 riskiest files by size, new symbols, export changes and risky names) and a partition into at most 6 areas by folder, balanced by changed lines: *this PR is too large for one review: review it by area*. The review thread runs `prepare` with `scope: "area-N"` (the brief and the pathspecs of that area only), the reviewer pass over it, and `record` with the same `scope`: an area record is never green and is an external-style record; the records of one sha add up (`areas`: verdict and open count per area), the report gate refuses `done` until every area has its record, and the evidence appended to the final report lists each area's verdict. The partition is a pure function of the diff, so `record` rebuilds the same areas.

**Small replies.** `lean_review merge` (the two reviewer passes of a high-risk diff) returns the counts by severity, the top 10 findings (severity, `file:line`, one line) and the path of the full merged JSON in the thread's scratch folder; pass that path as `review` to `record`, unchanged (the mod checks it is the merged block). A `record` with more than 10 open findings lists the counts and the top 10 and names the record file. The thread result cap `threadToolResultChars` (default 8000) also applies to a thread's own lean-agent tool results (`lean_review`, `lean_run`, `lean_thread` ...), except `lean_report` and `lean_ask`: the full text is saved in the output folder and the last line says where. The size warning counts the result being returned (the engine's figure does not hold it yet), so a result that jumps a thread over the warn level says so in the same reply.

**Changed code only.** `prepare` (light, full, per area, and for an external ref) lists the changed files with their changed new-side line ranges (the hunks of `git diff -U0` against the merge base; an added file is `1-N`, a deletion inside a file marks the spot, a deleted file has none and counts as a whole). The reviewer, the review brief and the review skill say: review only what this change adds or changes, existing code is context only, report nothing about a file or line outside the changed hunks, and report a problem an unchanged file shows because of the change on the changed line that causes it; the reader's brief says to read the changed files first and other files only to understand a caller or a definition used in the change. The script enforces it (`hooks/reviewchange.ts`) at `lean_review merge` and `record` (the merge only when it can read the range): a finding whose file is not changed, or whose line is more than 3 lines outside every changed hunk, is dropped and counted ("2 findings dropped: outside the change (files: a.ts, b.ts)", in the compact reply). A finding without a file stays only in the categories tests, docs, scope and completeness and is marked `[cross-file: no file or line]`; a finding about a deleted file stays. The area split of a large PR counts changed files only.

### Inline review comments

A review thread can post its findings as PR comments that sit on the changed line, in one request:

- **Kinds.** `ado-pr-comment` takes optional `file` (repo-relative), `line` (the line in the PR's new version), `endLine` and `side` (`right`, the default, or `left` for a removed line); with a file and line it creates a new Azure DevOps thread with a `threadContext` (`rightFileStart/End`, or `leftFileStart/End`). `gh-pr-review-comment` {repo, pr, file, line, body, endLine?, side?} posts through `gh api repos/<owner>/<repo>/pulls/<n>/comments` with `path`, `line`, `side` and `commit_id` = the PR head commit, read by a GET at send time (the card shows a placeholder, the mod fills it in; the request and the body go through `gh api ... --input -`, never a shell). Azure DevOps goes through the same REST call and `az` bearer token as every other write: the token is on curl's stdin, never in an argument list, a log or an output.
- **The anchor check** (`hooks/anchor.ts`, no model). For every inline comment the mod reads the PR's changed files and their added / modified line ranges (GitHub: `pulls/<n>/files` patches; Azure DevOps: the last iteration, its changes, and the file diff) when the request is made and again right before it is sent. A comment is refused when its file is not in the PR, or its line (side right) is not an added or changed line of the new file, or (side left) not a removed line; a deleted file allows only side `left`; a binary file allows none. The refusal reads "t7 asked for src/a.ts:120: the PR does not change that line (changed ranges: 40-52, 98-110)". A diff that cannot be read (the GET failed, GitHub left the patch out of a very large file, the Azure DevOps change list was cut short) is refused as "could not verify the anchor: not sent". A request is shown to you only after the check passed. If the line is gone at send time (a push in between), nothing is written for that comment, the thread is told, and for a single comment the request is closed; "could not verify" at send time leaves the request approved so you can try again.
- **Review batches.** A `batch` of only PR comments (inline or general) for one PR may hold up to 60 items; every other mix stays at 10. The card and the AskUserQuestion list them numbered, grouped by file, each with its line and text (cut at 300 characters in the question; the card has the full text, up to the pane's own 4000-character card limit: a review that long is approved in the desk's question). One Approve covers exactly the list (the hash covers every write, in order). `continueOnError` (default true for comment batches, false for every other batch) means a failing item is reported with its reason and the rest still run; the result has one line per item. The 1.0.28 own-PR default covers owned-PR comments as before; its text lint runs per item, and an item that fails it holds the whole batch for you.
- **Review-comment text lint** (`lintReviewText`, with the anchor check): a comment that is only a disclaimer ("partial coverage", "no tests run", "I could not verify", "not reviewed") or only "LGTM" is refused with the reason, in every comment kind (not in replies). One real sentence next to a disclaimer lets the text through.
- **Not tested live.** Everything above is covered by specs with canned `gh` / `curl` output and synthetic diffs; nothing was posted to a real GitHub or Azure DevOps. In particular the Azure DevOps file-diff read (`POST .../filediffs?api-version=7.1-preview.1`, its `lineDiffBlocks` fields) and the threadContext offsets are written from the REST documentation and are not confirmed against a real organization; GitHub's inline comment on a multi-line range (`start_line`) likewise. If the Azure DevOps diff read returns something else in your organization, comments refuse as "could not verify the anchor: not sent" (nothing is posted wrongly).

#### More fields of an Azure DevOps inline comment, and the `pr-changes` read

`ado-pr-comment` fields, all optional (the inline ones need `file` + `line`): `file`, `line`, `endLine` (alias `lineEnd`; giving both with different values is refused), `offset` and `offsetEnd` (column, default 1 each: the line length is not known, so the comment covers the line from its start), `side` (`right`, default, writes `rightFileStart/End`; `left` writes `leftFileStart/End`), `iteration` and `changeTrackingId` (inline only; `changeTrackingId` needs `iteration`), and, with or without a file, `status` at creation (`active` default, `fixed`, `wontFix`, `closed`, `byDesign`, `pending`, sent as 1..6), `commentType` (`text` default = 1, `codeChange` = 2) and `parentCommentId` (default 0). An inline comment also carries `pullRequestThreadContext: {iterationContext: {firstComparingIteration: N, secondComparingIteration: N}, changeTrackingId}` so it follows iteration N: the iteration you name, else the PR's latest, and the file's changeTrackingId from that iteration's change list unless given. The card shows the placeholders `<latest iteration>` / `<change id>`; the mod fills them at send time with the iteration the anchor check read (the same one), and sends nothing if it cannot (`could not verify the anchor: not sent`). A comment with a `status` other than active is not covered by the own-PR default (it asks, as every status change does). `gh-pr-review-comment` keeps `repo, pr, file, line, body, endLine, side` (the GitHub API has no iterations).

`lean_run {pr-changes: {forge: "ado"|"github", org, project, repo, pr, iteration?}}` (GitHub: `repo` as owner/name and `pr` only) reads the same diff by script and returns one line per changed file, `path [status]: added <ranges of the new side> | removed <ranges of the old side>`, with a first line naming the PR and iteration. It needs no local checkout and no git ref. The answer is cut at 6000 characters (the whole table, at most 200 files, is written to `scratch/pr-changes-<pr>[-it<n>].txt` in the thread's folder); an unreadable PR is a refusal, never a guess.

Not tested against a real server: the shape of `pullRequestThreadContext` / `iterationContext`, the numeric `status` values, the iteration list and change-entry fields (`sourceRefCommit`, `commonRefCommit`, `changeTrackingId`) and the file-diff POST are written from the Azure DevOps 7.1 REST documentation as known and exercised only with canned JSON.

### Allowing a thread's remote writes: what counts as your yes

The mod records only what you type in the chat box (or send from the phone). A slash command run by a Run button, or typed in a shell box, runs in the shell and never reaches lean-agent. Ways to give the go: write the PR or the go as plain words ("post the comments on PR 123"), type `/lean-agent:allow tN <PR>` in the chat box, or answer the desk's question (Allow / Not now): your Allow is recorded as the written yes, with the same 24 h scope and Revoke as typed words. If nothing was recorded, the refusal says so ("recorded prompts: 3, none names PR 123") and the desk asks with the question.

### Review writes on an Azure DevOps PR (1.0.29)

Six more kinds in the same table as `ado-pr-reply` and the others (`hooks/deskactions.ts`). Each is typed, shown to you with the exact text and URL, needs your Approve bound to the request id, and is sent by the same executor (the bearer token goes to curl on stdin, never in an argument list, a log or an output). Every one takes `org`, `project`, `repo`, `pr`.

| Kind | Further params | What the desk sends | Without a question? |
|---|---|---|---|
| `ado-pr-vote` | `vote`: `approve` (10), `approve-with-suggestions` (5), `reject` (-10), `reset` (0), `wait-for-author` (-5) | `PUT .../pullRequests/<pr>/reviewers/<you>` `{vote}`. "You" is the identity the login belongs to, read by one `GET .../_apis/connectionData` right before the send; if it cannot be read, nothing is written | Only `reset` on a PR the thread owns. Approve, reject, wait-for-author and approve-with-suggestions are always yours to answer |
| `ado-pr-update` | `title?`, `description?`, `draft?` (true / false), `status?` (`active` or `abandoned`) | `PATCH .../pullRequests/<pr>` with only the fields named | No |
| `ado-pr-reviewer` | `op` (`add` / `remove`), `reviewer` (the id, or the unique email or display name as the API takes it), `required?` (add only) | `PUT` / `DELETE .../pullRequests/<pr>/reviewers/<reviewer>` | No |
| `ado-pr-policy-queue` | `evaluationId` (GUID) | `PATCH <project>/_apis/policy/evaluations/<evaluationId>` (queue the evaluation again) | No |
| `ado-pr-workitem-unlink` | `workitem` (`workItem` is accepted as the same field) | reads the work item's relations, finds the PR's link and removes it by position with a `test` guard on its url (`PATCH .../wit/workitems/<id>`); no link found: nothing is written | Yes, for a PR and a work item the thread owns (like the link) |
| `ado-pr-label` | `op` (`add` / `remove`), `label` (at most 40 characters) | `POST .../pullRequests/<pr>/labels` `{name}` / `DELETE .../labels/<label>` | Yes, on a PR the thread owns |

What a thread never does with `ado-pr-update`, and is refused with the reason "the user does this by hand": completing the PR (status `completed`), auto-complete, squash / merge options, bypassing policy, deleting the source branch. Votes and reviewer changes are never covered by the own-PR default, by a standing approval or by `allow-writes`: the answer is always yours. They can be part of a `batch` for one PR; one item that is not covered makes the whole batch a question.

Not tested against a live organisation: the specs run on canned curl output, nothing is ever sent from them.

## The pane (1.0.30)

A polish of the desk pane, and one optional look. **It was not judged visually here:** the container has no desktop app, so the layout, the colors and the theme are covered by specs that read the tree (texts, buttons, keys), not by eye. Send a screenshot of the pane and the list in both modes if anything looks off.

**The "Needs you" card.** The buttons (Approve, Deny, Open, Dismiss) are the first row of the card; the card's label is an amber chip (`needs you`, `blocked`, `question`, `ready to push`, `stalled`) and the text under it is the normal text color. A review of several comments is a numbered list grouped by file, one line each (where the comment goes and its first 120 characters); "show full text" opens all of it. A request the pane cannot show whole (over 400 characters) has no Approve in the pane, as before, and the card now says so: "Approve in the desk question".

**One row per fact.**
- The desk context is one bar and one row under it, from 80 %: "restarting the desk (...): a new session opens by itself" when the 1.0.29 automatic restart will run (95 % of the limit and the guard of one per 30 minutes allows it), otherwise "restart the desk (...)" with the Restart desk button. No card, no second line, no "type /compact". The footer button stays.
- The old desk that was not archived is one amber line (not a red error and not again in the doctor lines). The rules cap ("N over the size cap, still loaded") and a held-back automatic restart are amber too. A real failure stays red with `error:`.
- The doctor is one line, "Doctor: N findings (F fix)", with show / hide for the lines (each cut to one line); the ones that need a fix are always shown, in red. A doctor line that repeats what the desk row or a notice already says is left out.

**Threads.** Every thread has a status chip (`working`, `waiting`, `needs you`, `done`, `restarting`, `blocked`), then model, cost, a context bar (`ctx 79k of 120k`), branch and review. A done thread is **one row**: title, chip, cost, context, Open | Resume, "more". One main button per state: working and waiting: Open; done and idle: Open | Resume; blocked: Restart. Behind "more": Resume, Start new session, Restart from handover, Close. "review not green" is red only on a done thread; on a working one it is dim. A thread that checkpointed itself (its checkpoint record names the session and the restart has not happened) is a `restarting` chip and has no blocked card. "Close all done" is unchanged. The 5 h plan window is a bar with the number (green, amber from 90 %, red from 100 %).

**The optional look.** Off unless the config says so:

```json
{ "pane": { "theme": "on" } }
```

in `~/.lean-agent/config.json`. When on, the look (a calm palette, cool grays and one teal accent, light and dark; danger, success and warning keep red, green and amber) is sent once at each session start with `$.theme.set`, built by `makeColors` (`hooks/make-colors.js`, copied unchanged from the plugin-authoring skill; a spec checks that nothing in its `problems` makes Desktop ignore the theme and that every color name is real). With the config off, or never set, lean-agent sets nothing and clears nothing. The theme is cleared only when the config goes from on to off (the mod keeps one record, `~/.lean-agent/look.json`, so it clears a look it set and never another plugin's at any other time). `lean_doctor` has one row: `pane theme: off`, `on, drawn`, or `on, not drawn: <the reason>` (the terminal and editors draw no look).

## Settings (lean_config)

Every setting of `~/.lean-agent/config.json` can be listed, read, changed and checked from the chat: you never need to edit the file by hand. The desk has one tool for it, `lean_config`; a thread or a worker never has it (a thread that needs a setting changed reports that to the desk, and the desk asks you).

**How to change a setting.** Type it in the chat box, or say it in words and the desk calls the tool:

- `/lean-agent:config` lists the settings per group: key, current value, default, one line of what it does; `*` marks a value that differs from the default.
- `/lean-agent:config desk.model` shows one setting (value, default, what it accepts, when it applies); `/lean-agent:config desk.model opus` sets it; `/lean-agent:config reset desk.model` puts the default back (the key is removed from the file).
- `/lean-agent:config validate` checks the whole file: an unknown key is named with the nearest known key ("did you mean desk.autoRestart?"), a bad value with what it accepts, a flat spelling that nothing reads with the nested form to use.

The value is checked against one table (`hooks/configkeys.ts`): the type (true / false, a number in its range, one of the allowed words, a list, a folder that exists; `~` stays as you typed it in the file and is expanded only where the path is used). The file is written atomically, keeps every key lean-agent does not know, the nesting style it already has (`"desk": { "model": ... }` or the flat `"feedback.destination"` where the reader accepts it) and its indent. A value that looks like a secret is refused. The reply says when the change applies: **now**, **from the next session** (threads already running keep the old value) or **after the desk restarts**. A `config.json` that is not valid JSON is never overwritten: the tool says what is wrong. `lean_doctor check` has one row, `config: N settings differ from the defaults (keys), M invalid`, with `lean_config validate` as the fix.

**Sensitive settings.** A setting marked `(sensitive)` in the table loosens a safety rule: turning the execution model off, the approvals and the hold time of remote writes, what a thread or worker may load, run or spend, skipping reviews. The mod changes one only when your own typed words this session name the key (a slash command typed in the chat box counts, a line run in a shell box never reaches the mod) or when you pressed Approve on the question the mod itself asked for exactly that change (bound to the request, like an approval of a thread's remote write). Otherwise the tool refuses and says how to go on: type `/lean-agent:config <key> <value>` in the chat box, or the desk asks you with a question. Resetting a sensitive key follows the same rule.

<!-- config-table:start -->
| Setting | Group | Type | Default | Applies | What it does |
| --- | --- | --- | --- | --- | --- |
| `desk.model` | desk | haiku / sonnet / opus | sonnet | desk restart | Which model the desk session runs on. |
| `desk.effort` | desk | low / medium / high | high | desk restart | How much effort the desk session puts in. |
| `desk.blockAppModel` | desk | boolean | false | now | Refuse the app switching the desk to another model (default: it asks you first). |
| `desk.autoRelay` | desk | boolean | true | now | Hand a thread's report to the desk at once, without waiting for your next message. |
| `desk.autoResume` | desk | boolean | true | now | Resume a thread blocked by the usage limit two minutes after the limit resets. |
| `desk.autoRestart` | desk | boolean | true | now | The mod opens a fresh desk itself when the desk must restart (off: only the Restart desk button). |
| `desk.reportChars` | desk | number >= 0 | 400 | now | Characters of a thread report the desk gets (0 = the whole report). |
| `deskTokens` | desk | number >= 10000 | 100000 | now | The desk compacts itself when its conversation passes this many tokens. |
| `deskToolResultChars` | desk | number >= 1 | 6000 | now | Largest tool result the desk keeps whole, in characters (longer ones are cut). |
| `notify.toast` | desk | boolean | true | now | Show a toast for desk notices. |
| `notify.sound` | desk | boolean | false | now | Play a sound with a toast (accepted; no sound clip is bundled yet). |
| `tips` | desk | boolean | true | now | Show an occasional tip about a lean-agent feature. |
| `tools.desk.drop` | desk | list | [] | desk restart | Tool names (globs allowed) taken away from the desk. |
| `handover.mode` | desk | core / full | core | now | What a restarted thread gets first: core (only what changes behaviour, rest on request) or full. |
| `handoverTokens` | desk | number >= 500 | 6000 | now | In full handover mode: the handover is cut to about this many tokens. |
| `tools.thread.drop` | threads | list | [] | next session | Tool names (globs allowed) taken away from threads. |
| `threads.model` | threads | haiku / sonnet / opus | sonnet | next session | Which model new threads run on. |
| `threads.effort` | threads | low / medium / high | medium | next session | How much effort new threads put in (medium; high when lean.orchestrate is off). |
| `threads.autoRestart` | threads | boolean | true | now | Restart a thread by itself when its context is full (off: it stops and asks). |
| `threads.stopGraceMinutes` | threads | number >= 0 | 3 | now | Minutes after the stop record before a still-working thread is restarted anyway. |
| `threads.autoContinue` | threads | boolean | true | now | Continue a thread that ends its turn with "next: ..." (off: no automatic continue). |
| `threads.continueSeconds` | threads | number >= 1 | 20 | now | Seconds a "next: ..." turn waits before the continue message is sent. |
| `threads.escalate` | threads | boolean | true | now | Restart a thread that ignored a message from the desk (off: ask you first). |
| `threads.answerWaitSeconds` | threads | number >= 1 | 45 | now | Seconds a thread has to react to a message before it counts as ignored. |
| `threads.waitReminderMinutes` | threads | number >= 1 | 15 | now | Minutes an unanswered thread question waits before it comes back once. |
| `threads.stuckMinutes` | threads | number >= 1 | 10 | now | Minutes an unread message may wait before the thread counts as stuck. |
| `threads.removeOld` | threads | boolean | true | now | Remove the old stopped session of a thread after a restart. |
| `threads.stallMinutes` | threads | number >= 1 | 10 | now | Minutes without a tool call or report before a working thread counts as stalled. |
| `threads.stallRestart` | threads | boolean | false | now | Restart a stalled thread automatically (default: only flag it). |
| `threads.skills` | threads | lean / all | lean | next session | Skills a thread lists: lean (lean-agent's only) or all. |
| `threadTokens` | threads | number >= 10000 | 120000 | now | A thread restarts itself when its context passes this many tokens. |
| `threadWarnTokens` | threads | number >= 10000 | 100000 | now | A thread is told to wrap up when its context passes this many tokens (default 83% of threadTokens). |
| `threadToolResultChars` | threads | number >= 2000 (0 = off) | 8000 | now | Largest tool result a thread keeps whole, in characters (0 = no cut). |
| `attribution` | threads | boolean | false | next session | Let threads add Claude attribution lines to commits and pull requests. |
| `workers.briefChars` (sensitive) | workers | number >= 1 | 3000 | now | Longest brief a worker accepts, in characters. |
| `workers.steps` (sensitive) | workers | number >= 1 | 24 | now | Most tool calls one worker may make before it must return what it has. |
| `workers.stepsByJob.lookup` (sensitive) | workers | number >= 1 | 10 | now | Tool calls for a lookup job. |
| `workers.stepsByJob.edit` (sensitive) | workers | number >= 1 | 16 | now | Tool calls for an edit job. |
| `workers.stepsByJob.run` (sensitive) | workers | number >= 1 | 6 | now | Tool calls for a run job. |
| `workers.stepsByJob.check` (sensitive) | workers | number >= 1 | 10 | now | Tool calls for a check job. |
| `workers.requireJob` | workers | boolean | false | now | Refuse a worker brief whose first line does not name the job. |
| `workers.answerChars` | workers | number >= 100 | 1200 | now | Characters of a subagent answer that come back into the conversation. |
| `agentResultChars` | workers | number >= 1 | 6000 | now | Largest result a subagent keeps whole, in characters. |
| `learn.maxExplorers` | workers | number >= 1 | 4 | now | Explorers the learn skill may run at once. |
| `ask.model` | workers | haiku / sonnet / opus | haiku | now | Model that answers a thread question put to the desk. |
| `ask.effort` | workers | low / medium / high | low | now | Effort of the model that answers a thread question put to the desk. |
| `review.model` | review | string | auto | now | Model of the reviewer (auto picks by the risk of the change). |
| `review.perMilestone` (sensitive) | review | boolean | true | now | Review again at every milestone (off: skip the pass between milestones). |
| `review.minLines` (sensitive) | review | number >= 0 | 60 | now | Changed lines since the last pass below which a milestone review is skipped. |
| `review.exclude` (sensitive) | review | list | [] | now | Globs of files left out of a review (generated files are always left out). |
| `review.lessonTokens` | review | number >= 1 | 3200 | now | Tokens of review lessons a new review is given. |
| `review.lessonMax` | review | number >= 1 | 1500 | now | Most review lessons kept per project. |
| `rulesPr.minSessions` | review | number >= 1 | 3 | now | Sessions a learned rule must have loaded in before it is proposed upstream. |
| `rulesPr.minDays` | review | number >= 1 | 7 | now | Days a learned rule must have been in use before it is proposed upstream. |
| `rulesPr.minGaps` | review | number >= 1 | 2 | now | Reports of a missing piece of context before it is proposed as a rule. |
| `rulesPr.windowDays` | review | number >= 1 | 90 | now | Days back that rule loads and reports are counted. |
| `budget.daily` | budget | number >= 0 | 25 | now | Daily spend in USD at which the desk is warned (0 = no alert). |
| `budget.threadDaily` | budget | number >= 0 | 15 | now | Daily spend of one thread in USD at which the desk is warned (0 = no alert). |
| `dailyCapUsd.desk` (sensitive) | budget | number >= 0.01 | none | now | Daily USD cap for desk sessions; past it requests are refused (none by default). |
| `dailyCapUsd.thread` (sensitive) | budget | number >= 0.01 | none | now | Daily USD cap for thread sessions; past it requests are refused (none by default). |
| `dailyCapUsd.plain` (sensitive) | budget | number >= 0.01 | none | now | Daily USD cap for plain sessions; past it requests are refused (none by default). |
| `workerCapUsd` (sensitive) | budget | number >= 0.01 | none | now | USD one worker may spend before it ends and reports (none by default). |
| `workerCaps` (sensitive) | budget | json | none | now | USD cap per worker kind, e.g. {"worker-opus": 4}. |
| `window.holdAbove` | budget | number >= 1 <= 100 | 85 | now | Percent of the usage window above which starting a thread warns and holds. |
| `pane.theme` | pane | on / off | off | desk restart | Give the app lean-agent's own look (on) or leave it alone (off). |
| `feedback.destination` | feedback | local / folder / github / folder+github | local | now | Where the feedback export goes: local, folder, github or folder+github. |
| `feedback.folder` | feedback | path | none | now | Folder the feedback export is copied to (for folder and folder+github), e.g. ~/Downloads. |
| `threads.plugins` (sensitive) | safety | list or all | [] | next session | Plugins a thread loads besides lean-agent (all = every plugin you have). |
| `threads.mcp` (sensitive) | safety | all / project / none | all | next session | MCP servers a thread may use: all, project (the project's only) or none. |
| `threads.tools` (sensitive) | safety | list or all | none | next session | Built-in tools of a thread session (all = the full set; default is a short list). |
| `threads.directReads` (sensitive) | safety | number >= 0 | 3 | now | Direct file reads a thread may do per turn before it must use a worker. |
| `threads.workers` (sensitive) | safety | number >= 1 | 4 | now | Workers one thread may run at once. |
| `workers.commit` (sensitive) | safety | boolean | true | now | A worker may commit its own change when the brief says commit. |
| `agents.cap` (sensitive) | safety | number >= 1 | none | now | Most subagents a thread session may start (no cap by default; small workers do not count). |
| `grants.ttlMinutes` (sensitive) | safety | number >= 1 | 120 | now | Minutes a worker slot is held before it counts as ended. |
| `lean.orchestrate` (sensitive) | safety | boolean | true | next session | The desk only routes and threads only brief workers (off: threads edit and run things themselves). |
| `actions.holdSeconds` (sensitive) | safety | number >= 0 | 30 | now | Seconds a covered reply or comment is held before it is sent (0 = at once). |
| `actions.ownPrDefault` (sensitive) | safety | boolean | true | now | A thread owns the pull request it opens: its replies go out without a question. |
| `actions.ownPrMaxPerDay` (sensitive) | safety | number >= 1 <= 1000 | 20 | now | Pull requests a thread may take as its own per day. |
| `actions.ownWorkItemStates` (sensitive) | safety | list | ["Reviewing","Active","In Progress","Resolved"] | now | Work item states a thread may move its own work item to. |
| `actions.maxWritesPerGrant` (sensitive) | safety | number >= 1 <= 1000 | 40 | now | Writes one approval in advance (allow) covers. |
| `actions.standing` (sensitive) | safety | json | [] | now | Standing approvals: a list of {project, kinds, statuses} that need no question. |
| `private` (sensitive) | safety | on / off | on | now | Private projects: on keeps them hidden from lists, off shows them. |
| `tools.plain.drop` | other | list | [] | next session | Tool names (globs allowed) taken away from plain sessions that are not the desk or a thread. |
| `toolResultChars` | other | number >= 2000 (0 = off) | 20000 | now | Largest tool result kept whole, in characters (0 = no cut). |
| `refusals.repeat` | other | number >= 2 | 3 | now | How often one refusal pattern repeats before the doctor names it. |
<!-- config-table:end -->

The table is generated from the registry by `node scripts/config-table.mjs` (`--write` puts it between the markers above); `node scripts/config-table.mjs --check`, run by `hooks/skills-contract.test.sh`, fails when the hooks read a key the registry lacks, an entry has no one-line description, or this table differs from the registry, so the table cannot drift. Add a key to `hooks/configkeys.ts` when you add a reader.

## Skills

| Skill | Use |
|---|---|
| `config` | list, show, change, reset and validate settings through `lean_config` (`/lean-agent:config [key [value]]`), never by hand-editing `config.json` |
| `thread` | start, message, wake, park, close, list threads |
| `goals` | one line per thread; the chaser asks a thread that has been quiet for an hour for a status |
| `handover` | write a handover note for the next session |
| `worktree` | create, list, remove worktrees under `~/.lean-agent/worktrees` and sync learned rules into them |
| `branch` | branch names the way the project wants them (no `lean/` prefix, optional type and task id) |
| `pr` | pull requests on GitHub (`gh`) or Azure DevOps (`az`), by the origin URL: a thread opens and updates them, the desk only reads status |
| `review` | every review: `/lean-agent:review <pr\|branch\|sha\|url> [base]` on the desk starts a review thread; in a thread it reviews the worktree (or someone else's ref, read-only) in passes and records the verdict |
| `review-learn` | learn from review comments on pull requests |
| `learn` | write path-scoped rules for a project |
| `rules-pr` | draft PR with optimised Claude files (CLAUDE.md, `.claude/rules`) for a project; needs the user's yes to push like any push |
| `compare` | what a session costs at start vs a clean Claude Code session (overhead), or one read-only task both ways with a judge |
| `scripts` | scripts over models: propose, audit, adopt and reuse small scripts (`lean_script`) |
| `todo` | the user's to-do list in `~/.lean-agent/todo.json` |
| `stats`, `budget` | what sessions and workers cost, which rules load, caps |
| `find` | search lean-agent's own state (threads, notes, memory, handovers, saved output, reviews) |
| `feedback` | draft a bug report (posting needs the user's OK), or `/lean-agent-feedback`: one anonymised export file written by the mod, copied to `feedback.folder` or offered as a public GitHub issue per `feedback.destination` (never without the Approve card) |
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
- `lean_run {ci: {...}}` is a read-only CI check that waits INSIDE the tool (a thread and its workers may call it; no model turn per
  check): `{host: "ado", org, project, id | ids | branch, waitMinutes}` runs `az pipelines runs show --id <n> --org ... --project ...`
  (`runs list --branch` without an id); `{host: "github", repo, id | ids | pr | branch, waitMinutes}` runs `gh run view <id> --json
  status,conclusion,jobs,...`, `gh pr checks` or `gh run list --branch`. argv only, from a fixed table of read-only subcommands (a write
  subcommand or a write flag is refused before anything runs). It polls every 45 s until every run finished or `waitMinutes` (0-30,
  default 10) is over and returns ONE line per run: id, status / result, the failed stage / job / step / test names when the JSON has
  them, the URL; or "still running after N min". A failed run is an error result; a timeout is not.
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
| `lean-agent:reader-mcp` | read-only lookup through ONE MCP server / connector the thread granted for that job (`allow-mcp:`), haiku |
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

## Fixed overhead

What every request carries before any work is the cost that repeats. `lean_doctor overhead` (desk; optional `session` id to read a
transcript) measures it by script, no model, per role: the role's template (CLAUDE.md text), the agent definition, the skills listing
(name + description of the skills for that role) and lean-agent's own tool schemas, as chars / 4. With a session transcript it adds the first
request's usage against the measured parts (the rest is the engine's system prompt plus built-in and MCP tool schemas, which no file holds)
and what the transcript names of MCP (servers, tool names, instructions). This repository's own files (1.0.15, tool schemas estimated from source):

| role | template | agent | skills | lean tools | total |
|---|---:|---:|---:|---:|---:|
| desk | 1056 | 0 | 998 | 2788 | 4842 |
| thread | 1567 | 0 | 1109 | 4510 | 7186 |
| worker-haiku | 0 | 572 | 0 | 0 | 572 |
| reader-haiku | 0 | 754 | 0 | 0 | 754 |
| reader-sonnet | 0 | 781 | 0 | 0 | 781 |
| worker-sonnet | 0 | 598 | 0 | 0 | 598 |
| reviewer | 0 | 3099 | 0 | 0 | 3099 |
| auditor | 0 | 855 | 0 | 0 | 855 |

After the rule text diet (1.0.15), the guides, in tokens:

| text | before | after | change |
|---|---:|---:|---:|
| `templates/front-desk.md` | 3222 | 1056 | -67% |
| `templates/thread.md` | 2679 | 1567 | -42% |
| `skills/thread/SKILL.md` | 4683 | 1352 | -71% |

**Removing tools instead of refusing them.** A refusal at call time leaves the tool's schema in every request. What was found (engine
types, `claude --help`, the engine binary), and what each way does:

- Agent frontmatter `tools:` is a hard allow-list for a subagent (a call to any other tool is refused, and its schema is not sent); left
  out, the agent gets every tool its parent has, MCP included. `disallowedTools:` removes names from that, and takes MCP server specs
  (`mcp__server`, `mcp__server__*`, `mcp__*`). `maxTurns:` is a frontmatter key (a backstop; the guard's step budgets are the rule).
  `skills:` preloads skills; left out, none. `agents/*.md` carry minimal `tools:` lists (readers and the reviewer / auditor / explorer:
  Read, Grep, Glob, Bash; workers: + Edit, Write): no Agent, no skill, no MCP tool, nothing else.
- A deny rule in `settings.json` `permissions.deny` without a pattern was believed to take the tool out of the model's tool list; measured in 1.0.19 it does NOT remove its schema from the request (`--tools` does). `hooks/leantools.ts`
  exports `deskSettings()` (every built-in the desk's strict mode cannot allow, the claude.ai connectors, project MCP servers, cron,
  bundled skills, the engine's git text, auto-memory) and `threadSettings({ mcp, extraDeny })` (the built-ins a lean-agent thread never
  calls: plan mode, worktree, cron, task list, the install / suggest / search tools, notebook edit), and `mergeSettings(base, fragment)`.
- The mod's own `tool.list` hook already cuts the desk's pool (`trimTools`, `config.json` `tools.<role>.drop` on top); that shapes what the
  model is shown and holds for every agent. The settings fragments add the same cut BEFORE the mod loads and in a folder session
  opened from the app.
- Engine switches in settings `env` (found in the engine binary, unverified live): `ENABLE_CLAUDEAI_MCP_SERVERS=false`,
  `CLAUDE_CODE_DISABLE_CRON`, `..._EXPLORE_PLAN_AGENTS`, `..._BUNDLED_SKILLS`, `..._CLAUDE_API_SKILL`, `..._CLAUDE_CODE_SKILL`,
  `..._GIT_INSTRUCTIONS`, `..._AUTO_MEMORY`, `..._ADVISOR_TOOL`.
- Cannot be removed: the engine's system prompt, the schemas of the tools a role really uses (Bash and Edit are the big ones), the
  plugin skills listing (it is trimmed to the role's skills, not to nothing) and lean-agent's own tool schemas (each is used).
  `--tools`, `--strict-mcp-config` and `--bare` exist for a session you start yourself; a background thread is started by `claude --bg`
  and its settings file is the only lever.

**MCP is opt-in per job.** No worker or reader has an MCP tool by default. A thread grants a server for ONE job with a brief line
`allow-mcp: <server>[, <server>]` (a connector's display name works: `Datadog` matches `mcp__claude_ai_Datadog__*`) and starts
`lean-agent:reader-mcp` (haiku; the one definition without a `tools:` list, because an allow-list cannot name servers that vary: it
removes the edit, agent, web and skill tools with `disallowedTools`). The guard records the line like `allow-cmd` and lets exactly that
server's tools through for that worker, read-only ones only: a tool whose name starts with create, update, delete, upsert, edit, run, trigger,
execute, send and similar verbs (or has a write word in it) is refused with "needs `allow-mcp-write: <server>` plus the user's approval through
the desk". `allow-mcp-write` is recorded but a worker alone is never let through; the thread reports it with `lean_report`. Another server, no
grant, an unresolved agent type: refused. The grant belongs to the job and ends with it. The MCP result is cut by the same output cap
(`toolResultChars`, saved in full) and the worker's answer by the `lookup` schema below. A project's `profile.mcp` (the `learn` skill's
profile) is respected: a listed server is never in a deny rule, and `threadSettings` never disables a connector at all (it is only removed from the desk).

**Return schemas and fail fast.** The first line of a worker brief names the job: `job: lookup|edit|run|check`. The Agent result is cut
to the job's schema and marked `[lean-agent: result outside the <job> schema, trimmed to ...]`; a conforming result is untouched:

| job | result | tool calls |
|---|---|---:|
| lookup | `answer:` (<= 20 lines), `refs: path:line, ...` | 5 |
| edit | `files:`, `diffstat:`, `result: pass\|fail`, `note:` (one line) | 8 |
| run | `result: pass\|fail`, <= 20 lines | 3 |
| check | `result: pass\|fail`, <= 20 lines | 5 |

`config.json` `workers.stepsByJob: { "lookup": 5, ... }` sets the budgets; `workers.steps` stays the ceiling. At the budget the guard refuses
further calls ("return what you have in the <job> schema") and the worker's `maxTurns` is the hard stop. `workers.requireJob: true` refuses a
brief without the job line (default off: such a brief keeps `workers.steps` and no schema). Retries are counted per thread and brief
(`why-sonnet:` lines and spacing ignored): the first run is allowed, the second identical brief only with a `why-sonnet:` line, the third is
refused ("split the job differently or report blocked"), never a loop; a changed brief starts again.

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

**Every review goes through the skill.** `/lean-agent:review <pr|branch|sha|url> [base]` on the desk (or `lean_thread new` with
`review: {pr | branch | sha, base?}` and `project`) starts a review thread on sonnet / high; its brief comes from
`templates/review-brief.md`. It reads the ref read-only into a scratch repository (never your tree), runs the passes and records with
`mode: "external"`: such a record is never green and never counts for the push gate. The thread cannot report done without a full-level
record for the reviewed sha; the mod appends the evidence (sha, level, passes, verdicts, findings by severity) to the report itself.

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

## Fewer turns, cheaper roles, visible cost (1.0.27)

A thread's own session is its biggest cost: every turn re-reads the whole context, and one orchestration step used to take about five turns (brief a worker, wait for the notification, read the diff, commit, report). 1.0.27 attacks that, and shows where the money goes.

**Workers commit their own change.** Put `commit: <message>` in an edit brief. The worker runs the brief's one test command first and commits only when it passes (`git add` of the files it changed, `git commit` in its worktree); its answer is `files`, `diffstat`, `sha`, `result`, `note`. A failing test means no commit and no `sha`. One brief may carry up to three small related edits (one job type, one test command). The thread checks by the sha and the diffstat and does not re-read the diff or run `git diff` unless the step failed. The guard allows a worker's `git add` / `commit` / `status` / `diff` and refuses `reset --hard`, `rebase`, `commit --amend`, a checkout or switch of another branch, `push` and tags. `workers.commit: false` switches it off.

**Effort by role.** With `lean.orchestrate` on, a thread that only briefs workers defaults to effort medium; `threads.effort` and `effort:` on `lean_thread new` still win, and `high` is for design and refactoring work the desk names. Fresh starts, restarts and auto restarts follow one rule (an effort a call named is kept, a recorded default is recomputed), and the start reply names the effort. Worker agents keep their own effort (medium for sonnet workers, low for haiku).

**A cheaper reviewer.** `maxTurns: 12`, the tool-call budget of a `check` job (`workers.stepsByJob.check`), per-file added/removed line counts handed over by script with "read each changed file once, diff hunks only", a re-review that reads only the diff since the last reviewed sha (light and full), a JSON-only answer with at most 12 findings (`path:line`). Every `lean_review` reply ends with "review cost for <sha>: $ over N passes, M requests", and "expected ~$X" is the median of earlier passes of the same level in the project.

**Cost per tier and job.** `lean_doctor stats` has a section "by worker tier and job" (runs, requests, cost, cost per run, second tries, step budget hits per agent type and job type), "thread main session" (requests, average context, cost) and an estimate of what the sonnet edit runs would have cost on haiku. The thread pane shows "main $a · workers $b · reviews $c"; the card turns amber at `budget.threadDaily` (default $15 now). When a project has a good haiku record for a job type (at least 5 successful runs, at least 80%), the `why-sonnet` refusal says so.

### Savings

What each part can save, in words (the section "by worker tier and job" and the saving line in `lean_doctor stats` measure it on your own ledger):

- **Worker commits** remove the turns a thread spent reading a diff, committing and reporting per step; each removed turn is one whole re-read of the thread's context, so the saving grows with the thread's context size and the number of steps.
- **Effort medium for orchestrating threads** lowers the thinking the thread's own session does on every turn, where its job is only to brief, wait and check.
- **The cheaper reviewer** cuts the reviewer's exploration (the budget and the per-file counts), and its re-reads of what did not change.
- **Per-tier cost and the haiku record** save nothing by themselves: they show which edit jobs sonnet ran that haiku had already done well in the project, so the next brief can start on haiku.
- **The lower thread alert** warns earlier, before a thread's day gets expensive.

## Budgets

Cost-only, from the per-request usage the mod sees. `~/.lean-agent/config.json`:

```json
{ "dailyCapUsd": { "desk": 5, "thread": 20 }, "workerCapUsd": 2, "workerCaps": { "lean-agent:worker-opus": 4 } }
```

Desk reports: while the desk is idle, a thread's question or `done` / `blocked` report starts one desk turn (at most once a minute);
`{ "desk": { "autoRelay": false } }` in the same file turns that off, and reports then wait for your next message.

Past a cap the next model request is refused with a notice; a worker past its cap ends and reports what is left. Every
step is a row in `ledger.jsonl`. There is no plan-window percentage (no verified source exists).

**Alerts by default** (they warn, they never refuse a request): `{ "budget": { "daily": 25, "threadDaily": 15 } }` (USD; both are
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
- **What happens at the limit** (`threadTokens`, default 120000, `threadWarnTokens` 100000): since 1.0.19 the thread STOPS working (next bullet: the hard stop). When the NEXT message for the thread arrives
  (`send`, `wake`, `resume`, the chaser) and the session is idle or done, its recorded size is compared with the limit. Over it (one
  token over, equal is fine): a NEW session starts with the handover (brief, goal, notes, reports, queued messages, task first)
  instead of a resume, and the reply says so: "context was 142k (limit 120k): started a new session with the handover (old
  conversation kept read-only, not resumed) ... handover about 9.0k tokens (~$0.05 first turn, estimate)". A working session is never
  touched: the message queues as before and the check runs when it is idle or done. A usage-limit resume skips the check (that session
  was stopped inside a turn, so its last turn-end size is not current).
- **When the size is not known** (a thread from before this feature, a write that failed, a record made by an older session id of the
  thread, a damaged file) the session counts as under the limit and is never restarted on a guess; `lean_thread list` says `ctx unknown`.
- **`threadTokens` can be raised** (e.g. 160000 in `config.json`; `threadWarnTokens` follows at 83%). What it costs: every request of the thread
  re-reads the whole context from the cache (about a tenth of the input price), so a thread that lives to 160k instead of 120k pays about a third
  more cache reads per request near the end of its life, and a longer session summarises worse; the base of every session (next bullets) is paid
  either way. Lower is cheaper per request but restarts more often (each restart pays the handover once).
- **The warning.** The card, the thread pane and `lean_thread list` show `ctx 96k/120k, +4k/turn` (the growth per turn is the mean of the last
  20 turn-end samples in `context.json`; no figure before two steps up). The colour: dim up to `threadWarnTokens`, yellow above
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

### Where a thread's context goes, and keeping it small

`lean_doctor overhead tN` prints what a thread session's context is made of, by part, largest first, each with the one config line or action that shrinks it (the thread's own mod records the engine's context breakdown in its folder, `context-parts.json`: counted at the first turn end, estimated at every later one). The start reply says "fixed base F k (tools, MCP tools, skills, memory ...) + first prompt P k = first request N k" and "free context M k (limit L k, base B k)"; the pane and list show "ctx 96k/120k (fixed 28k)". The fixed base is what every request carries (system prompt, built-in tools, MCP tool schemas, the skills listing, memory files, custom agents); the first prompt is the brief or handover, and the messages are the work.

Four things keep the messages small. Readers and workers write findings longer than a few lines to `<thread folder>/scratch/<job>-<short id>.md` and answer with the path and at most 5 lines (`workers.answerChars`, default 1200: a longer final answer is sent back once, a second one is counted as `answer-too-long`). At the warn level the thread is told once to write what it has learned to `scratch/notes.md`; a restart's handover carries those notes and the scratch file list and says not to re-read the sources they cover. A reader the permission check denied is retried once with one file and one question, then read in counted slices of 200 lines. And `lean_thread new` / `start` / `send` warn the desk, by script, when a brief names sources over half of the thread's free context: split it into a READING thread that writes a summary file and a WRITING thread that reads only that file.

The fixed base shrinks too: a thread's skills listing holds only the lean-agent skills a thread uses (listing budget thread <= 1.5k tokens, desk <= 2.5k, `threads.skills: all` turns the trim off), and lean-agent's own tool schemas are short (thread <= 4.5k tokens, desk <= 6k; `lean_rules`, `lean_compare`, `lean_worktree` and `lean_profile` load through ToolSearch when a skill needs them). Both budgets are pinned by specs.

### Keeping the desk's conversation small

The desk only routes work, so its conversation should stay small, and the mod makes it so by script. A thread's report reaches the desk as a digest: the thread id and state, the first 400 characters cut at a sentence end, one line each for the sha, branch and review verdict, and the path of the full report file (`lean_thread report tN` returns more: `section: "<heading>"` or `full: true`). A question, an approval request and a blocked report keep their full text. `lean_thread list` is one short line per thread (`verbose: true` for the long form), a start / restart / send reply is at most 3 lines, and `lean_doctor check` prints the FIX rows and a count (`verbose: true` for every row). To see what a desk's Messages are made of, ask `lean_doctor context`: tokens by source, the ten largest items (kind and time, never the text) and the growth per turn.

The desk cannot compact itself in the app, so it has a limit instead: `deskTokens` (default 100000). From 80% the handover is written and the pane header says "desk context N k of L k: restart the desk soon (the handover is ready)" with the Restart desk button next to it; at the limit the desk's next reply starts with one line saying so. With `desk.autoRestart: true` (default false) the mod opens the new desk itself at the end of the turn when no question to you is open. The handover carries the open questions, pending requests, grants and what each open thread is doing, and is at most 3k tokens. Config: `desk.reportChars` (default 400; 0 = the full text), `deskTokens`, `desk.autoRestart`.

### What a restarted thread receives

A thread that starts again (reopen, restart, a resume that must start fresh) gets a handover built by script from the store, never from the old conversation. `lean_doctor handover tN` previews it and starts with one header line: "handover for tN: about X tokens: brief B, corrections C, notes N, snapshot S, preflight P".

- **The brief is the oldest word.** Directly after it comes "Corrections since the brief" ("These came after the brief and win where they differ:"): every desk message to the thread after its start, queued or delivered, including the text given to a restart / wake / resume, newest last, each with its time. A path in the brief that points into another thread's folder is flagged, because the thread cannot count on reading it.
- **Notes are found where the thread kept them**: `notes.md`, `notes/*.md` and `scratch/*.md` (newest first, at most 6 files). The text of `notes.md` and `notes/progress.md` (else the newest notes file) is carried within the handover budget, the rest by name, size and first line with "read these before re-reading sources". With no goal set, the goal is the first line of the brief. The doctor preview lists the files it used and those it found but left out (reason: budget).
- **One account of the checkout.** The state snapshot and the preflight section read one computation of `git status` and `git diff --stat HEAD`: a snapshot younger than 60 s is reused ("as of <time>"), an older one is recomputed once and written back. The handover states the commit and whether the worktree was dirty, and prints one diff number per file.
- **Open tasks are the thread's own.** The preflight lists only open to-do items that carry the thread's id, branch or worktree, or PR / work item, or share at least two significant words with its goal or title (stop words: `hooks/stopwords.ts`): at most 5, then a count of the others ("N more tasks not about this thread"), never the rest. With none linked it says "open tasks: none linked to this thread".

### What fills a thread's context, and how little a restart needs

A thread's context is its cost, so lean-agent keeps it small by script. At the warn level (`threadWarnTokens`) and again at 90% of the limit the thread's next tool result carries one line: what its context consists of (tool results by tool, its own tool inputs and Agent briefs, worker answers, the first prompt, the two biggest single results by kind and size, never their text) and one fix for the largest source. `lean_doctor context tN` prints the same, and the thread can ask for it itself with `lean_run {context: true}`.

Noise is cut before it enters the conversation: `lean_run` answers a recognised runner (jest, vitest, mocha, node:test, pytest, go test, cargo test, tsc, eslint, and the yarn / npm / pnpm wrappers) with the exit code, the runner's totals and the failed tests only (a clean run is one line); an unknown runner keeps its last 15 lines; the whole output is the file named in the reply. A thread's own Bash and MCP results are capped at `threadToolResultChars` (default 8000; a worker's keep `toolResultChars`, 20000); the cut says which command produced the text, and a `git diff` / `git show` result adds "use --stat first, then one path at a time". A worker brief over 1500 characters gets a hint to point at a notes file instead of restating it.

A restart prompt is built by script and bounded. `handover.mode` in `config.json` is `"core"` (the default) or `"full"`. Core: at most ~1500 tokens, only what changes behaviour (the task line, the first 600 characters of the brief, at most 5 corrections since the brief, the open question or blocked request verbatim, branch / HEAD / dirty / one diffstat line, the next step) plus a pull list of one-line commands with sizes. Reports, the state snapshot, the preflight and the notes are not in the prompt; the thread pulls a section when the next step needs it: `lean_run {pull: "reports"}` lists the reports and `{pull: "reports", section: "3"}` reads one; `{pull: "notes"}` lists headings, `{pull: "notes", section: "<heading>"}` reads one; `{pull: "snapshot", section: "status,tasks"}`; `{pull: "preflight", section: "<word>"}`; `{pull: "brief"}`. Full: the bounded prompt (`handoverTokens`, default 6000, for the whole prompt: the last 3 reports as digests, the snapshot at 1500 characters, the preflight at 800). `lean_doctor handover tN` shows both sizes against their budgets and says "over budget by N tokens" when a fixed part does not fit.

### Messages to a thread: direct delivery, verified, restarted by script

A thread reads its inbox file only at its next tool call, so a thread that asked a question and ended its turn never saw the answer. The mod now delivers by script (`hooks/deliver-to-thread.ts`): a message for a thread whose session is alive goes straight to it with `$.session.send` (`send`, `wake`, the answer to a question, approval results, the chaser). The engine runs `$.session.send` only in a session whose tool pool has the `SendMessage` tool, so the desk keeps that tool in its pool and its settings (`doctor fix` removes the old deny entry; a desk started before needs a restart); the desk model itself still cannot call it, only the mod's own marked send passes the guard. No setting or environment variable turns messaging on beyond that. If the send is refused for the session, the refusal is remembered for 10 minutes and the next route runs at once: a session shown as `blocked` + `idle` with no `waitingFor` (a thread that asked and ended its turn) is idle, so the wake resumes it with the message (stop the idle process, `claude --bg --resume`, conversation kept). A session on an open permission prompt cannot take a message; the reply says so and the inbox keeps it. With no live session the old inbox + wake runs. Whichever route carried it, the desk's timer checks the thread's `activity.json`: no prompt, tool call, worker call or received message within `threads.answerWaitSeconds` (default 45) for an idle or waiting thread means it did not react, and the mod stops that session and starts a fresh one whose first prompt carries the message (its notes are kept), with one notice and no question to the user. Not for FYI / status-check messages, an open permission prompt or a working session that asked nothing. `threads.escalate: false` turns the restart off (one notice asks instead). A thread that asked a question shows `waiting for your answer` (not `running`) until it does something or the answer arrives; after `threads.waitReminderMinutes` (default 15) the question comes back once as a notice.

### Threads that stop, keep going, and hold before they send

**"next:" at the end of a turn.** The thread's own mod looks at the last assistant text of every turn. When it ends in a line that announces a next action (`next:`, `next step:`, "I will now ...", "now I'll ...", "going to ...", "then I will ..."; the table is `hooks/nextwords.ts`), nothing came after it, and the thread is not done, blocked, asking a question, waiting on a request, hard-stopped or parked, it writes `continue-pending.json` in the thread folder. After `threads.continueSeconds` (default 20) with no newer activity the desk's timer sends, by script, "Do the next step now: <the announced text>. Do not report again before you have made progress." At most 3 such continues in a row without a tool call between them; then one desk notice ("<tN> keeps stopping after 'next:'") and the stall state. `threads.autoContinue` (default true) switches it off.

**Keep going.** `lean_thread keep-going tN on|off` (or `keepGoing: true` on `new` / `start`) is the standing order "keep going, no asks": every turn end that is not done, blocked, a question or a pending request is continued by script with "Continue with the next step of your task." (at most 30 an hour, then a notice). Such a thread is flagged stalled after 5 minutes. The pane and `list` show "keep-going".

**Stall earlier, restart before the cap.** `threads.stallMinutes` defaults to 10. A stalled thread whose context is at 80% of `threadTokens` or more is restarted at once by script, with the handover ("<tN> stalled at 112k of 120k: restarted"). Below 80% it is flagged and noticed as before (`threads.stallRestart` still decides whether those restart).

**Grants hold before they send** (`hooks/sendhold.ts`). A covered request (standing grant, written instruction, own-PR default) is not sent when a prompt of yours is newer than the last time the desk delivered anything to that thread and is less than 30 minutes old: it is held and asked as usual ("a newer instruction from you may not have reached <tN>: ..."). A covered reply or comment (anything with text) waits `actions.holdSeconds` (default 30; 0 sends at once): the desk gets the exact text in its next context, the pane shows it with the countdown and Send now / Cancel buttons, `lean_thread action-cancel <id>` cancels (the request then stays pending for your own answer). Status-only writes are not held.

**Parked means parked.** `park` clears the restart marker, the pending continue, the delivery watch and the usage-limit resume record; every automatic path checks `state === 'open'` at the moment it acts. Messages to a parked thread stay queued in its inbox until it is reopened.

## The store is the memory

A session started from scratch must know what it needs from the old one through lean-agent, so sessions stay small and replaceable.
Everything here is done by script (the thread's or the desk's mod), never by a model turn.

- **State snapshot.** At every main-thread turn end the thread's mod writes `<thread folder>/state.json` atomically: branch, HEAD,
  `git status --short`, diff stat, files edited this turn, task list (what the thread wrote with its task tools), last report, open
  questions and the context size. The handover of a fresh session includes it (and the preflight text when `hooks/preflight.ts`
  registers one with `setPreflight`).
- **See the handover.** `lean_doctor handover tN` prints exactly what a fresh session would get: the sections, the tokens of each, and
  what is missing (no goal, no notes, no snapshot). The handover is cut to `handoverTokens` (config, default 6000): the least needed text
  goes first (remembered items, notes, queued messages, older reports), the newest stays, and every cut line names the file with the full text.
- **Hard stop at the limit** (1.0.19; field: a thread that had "checkpointed" kept working and reported the checkpoint again at every turn). At or
  over `threadTokens`, from `session.measure` at a turn end and from the tool.call hook every 10 tool calls (`$.session.usage()`, so a long turn
  cannot run past it), the thread's mod writes the snapshot and ONE record to the desk per session ("context 123k over the limit 120k: state
  saved, restart me"; never again for the same session), then refuses every further tool call of the thread itself except `lean_report` with
  one line ("context limit reached (123k of 120k): your state is saved. End your turn now; ..."; refusal rule `context-limit`). Workers already
  running finish; their results are put into the snapshot's "pending results" by script and handed to the fresh session, never acted on. A
  session whose last report is a question or `blocked` may still ask and report. A `lean_report` that is only a checkpoint / context notice is
  accepted once, then answered with the stop line. The thread guide and the `lean_report` description say: never report a checkpoint or your
  context size, the mod does it.
- **Automatic restart at the context limit** (config `threads.autoRestart`, default true). The desk's timer restarts a stopped thread with work
  left (not after done, blocked or a question: its next message starts fresh) as soon as its session is idle (20 s after the record) or
  `threads.stopGraceMinutes` (default 3) after it even if the session still shows as working (every tool call is refused by then): a fresh session
  with the task-first handover, the snapshot and the pending worker results, the old one removed, a notice and a toast with the size and the
  estimated cost. One automatic restart per thread per 10 minutes; a fresh session that starts over the limit stops and asks you; a session
  waiting for your answer is not restarted; only while the desk runs. The check when the next message arrives stays as the fallback.
- **The base of a thread session, measured** (`claude -p 'Reply with the single word ok.' --model haiku --output-format json`, input + cache read
  + cache creation tokens, before any work): plain folder, all built-in tools 42,044 · `--tools Agent,Bash,Read` 10,230 · `--tools ''` 3,730 ·
  thread folder as is 47,133 · thread folder `--tools Agent,Bash,Read` 19,779. In this build (same method, thread-shaped folder, no lean-agent MCP
  tools): default 40.7k · `Agent,Bash,Read,SendMessage,TaskStop` 12.7k · `+Skill` 21.2k (the skills listing, ~8.5k, is folder-dependent) ·
  `+Edit,Write,Grep,Glob` 23.3k (with Skill) / 14.9k (without). The built-in tool schemas are about 38k of the base. `permissions.deny` does NOT
  remove a tool from the request; `--tools` does. A subagent can only use tools its parent session has (measured: a `lean-agent:worker-haiku` of
  a parent started with `--tools Agent,Bash,Read,Skill,SendMessage,TaskStop` answered "Write is disabled"; with `Edit,Write,Grep,Glob` added it
  wrote the file), so the default list keeps what workers and readers need: `Agent, Bash, Read, Edit, Write, Grep, Glob, Skill, SendMessage,
  TaskStop, ToolSearch, WebFetch, WebSearch` (measured in a bare environment: 47.1k with the full set, 31.0k with this list, so about 16k less
  on every request; that is the floor: your base depends on your plugins, skills and connectors (a field machine measured 62k with the same list): run
  `lean_doctor overhead probe [tN]` to see where yours goes; the mod still refuses the thread's own edits). Config `threads.tools` (array of names) replaces the list; `[]` or `"all"` starts
  threads with the full set again. A tool a thread or worker then lacks is recorded as a missing tool (feedback export). The flag goes on a fresh start, an automatic restart and a `--resume` (before the `--`); it is
  ignored with `lean.orchestrate: false`. The desk is opened by the app without flags and no settings key equivalent to `--tools` was found: its
  pool is cut by the mod's `tool.list` hook (`tools.desk.drop`), unmeasured. `lean_doctor overhead [tN]` shows the REAL base (the first
  request of a session transcript) next to the text estimate, and the start reply of a thread says the measured base once a thread session
  recorded it (`base.json`).
- **`lean_doctor context tN`** names the three biggest sources of the thread's context (by tool, from its transcript) with one suggested fix each.
  The result of a BACKGROUND worker arrives as an engine notification the mod has no hook for, so it is not cut to the job schema (only a
  foreground result is); the brief asks for the foreground and the schema.
- **Answers from the store.** `lean_thread find <words|PR|branch|project>` lists matching lines with thread id and source file.
  `lean_thread ask tN "<question>"` answers from the store by script when lines match, else starts a FRESH small session (haiku, low;
  config `ask.model`, `ask.effort`) with the handover and the question; the big old session is never resumed. `lean_thread report tN`
  gives a script summary: state, sha, review verdict, open questions, counts and the path of the full text.
- **Plan window.** Each session's mod snapshots the 5 hour and 7 day rate-limit windows to `desk/windows.json`. `lean_doctor stats` leads with
  `5h window: 78% used, resets 14:20 (in 1h 13m) | 7d: 41%` and the snapshot age. The desk notices at 80 % and 90 % (once per window) and
  names the working threads. Above `window.holdAbove` (config, default 85) the replies of `new` and `start` carry a warning; nothing is refused.

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

- **A thread's `curl` / `az` / `gh` was refused with "forge writes go through the desk"** (refusal rule `forge-write`): a thread never makes a forge write
  by script; it asks with `lean_report` and `action: {kind, params}` (`ado-pr-reply` with an optional `status`, `ado-pr-thread-status`, ... `batch`), the user
  approves, the mod sends it. A brief or a remembered note that says to curl a status change is stale: `lean_thread new` / `send` flags such a brief, a thread's
  start prompt shows such a remembered item as "(retired: forge writes go through action kinds)", and `lean_doctor` counts them (`fix` retires them in the store, with a backup).

- **Restarting the desk starts it on opus again**: the pane header and `lean_doctor check` say why ("pin applied at start", "the app chose it, the pin could not be applied: <reason>", or "you chose it by hand ... (kept for this session)"). A model the app applies before your first prompt is never taken for your choice and the pin is applied; if it cannot be, a red row says what failed, then pick Sonnet in the model menu. `lean_doctor fix` tries the pin again.

- **An MCP server says `ENOTFOUND not-setup` (or another placeholder host)**: it needs a variable the desk does not have, see
  "MCP servers that need a variable". `lean_doctor check` names it; ask the desk to set it.

- **A thread cannot edit because Claude Code's permission check (auto mode classifier) denied its worker call**: lean-agent hears the denial
  (`PermissionDenied`, or a failed Agent result that says so), tells the thread "do this one step yourself", and allows the thread's own Edit/Write on the paths
  that brief named (refusal row `delegation-denied`; the permission check still judges each of those edits). Workers need no `allow-edit` line any more.
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
- **Auto mode: "a hook changed this call's input" / "auto mode classifier gave no verdict"** on an Agent call (1.0.16 only). 1.0.16 rewrote the call
  to `run_in_background: false`, which auto mode rejects, and the reissue then hit the duplicate guard. Update: lean-agent never changes a tool call's
  input now, a rejected call consumes no retry, and the threads pass `run_in_background: false` themselves.
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
