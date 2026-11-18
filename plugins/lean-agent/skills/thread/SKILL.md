---
name: thread
description: Start, message, wake, park, close and list lean-agent threads (background Claude sessions, one folder each) through the lean_thread tool. Use whenever the desk routes work.
roles: desk
---

# Threads

A thread is a background session (`claude --bg`) in its own folder under `~/.lean-agent/threads/tN`. The desk only
ever touches threads through the `lean_thread` tool (full name `mcp__lean-agent__lean_thread`); never run
`claude --bg` or `--resume` yourself.

| action | input | effect |
|---|---|---|
| `new` | `title`, `project?` (a registered project, see `projects`), `text` (the brief), `model?` (haiku/sonnet/opus), `effort?` (low/medium/high), `needs?` (MCP servers or plugins this thread needs on top of its project profile, e.g. `["azure-devops"]`) | creates the folder, trusts it, starts the session, records its id; a project with a profile adds ` · mcp: a,b · plugins: x` (what the thread loads) |
| `send` | `tN`, `text` | queues the message; wakes the thread once if it is idle |
| `wake` | `tN` | resumes an idle thread with everything queued |
| `resume` | `tN` | same, with no message (after a restart). When the session ran an older lean-agent version than the installed one (`thread.json` `version`), it starts a fresh session with a handover instead and says why |
| `start` | `tN`, `model?`, `effort?`, `needs?` | starts a thread that has no session yet (brief + queued messages); `needs` are added to what the thread already asked for |
| `approve-push` | `tN`, `sha` (full), `reason?` | desk only, ONLY after the user explicitly approved that push in the chat: one sha, single use, 2 h, signed, logged in the thread's `history.jsonl`; a private project is never pushed |
| `park` / `close` | `tN` | flips the state; close also stops a finished-but-alive session, takes it out of the app's list (`claude rm`, only for a session in the thread's folder; its conversation is kept) and clears the thread's goal (never deletes the folder). The reply says what happened to the session: "session stopped", "no running session (already stopped)", "no session in the list" |
| `reopen` | `tN`, `model?`, `effort?`, `needs?` | a parked thread: back to open (then `resume`). A CLOSED thread: a NEW session in the same folder with a handover (brief, goal, notes, report history, remembered items, queued messages, branch/worktree); the old conversation is never resumed, its session id stays in `thread.json` `sids` |
| `list` | none | every thread with its project, state, running flag, queued count, model/effort and, when its project has a profile, what it loads (`mcp: a,b · plugins: x`) |
| `profile` | `project`; then `mcp?`, `plugins?` (set: a list left out stays), `fill?: true` (add what the project's threads really used), `on: false` (remove) | the project's MCP/plugin allow-list: with no other input it shows the profile and the usage counted in the project's threads ("azure-devops used 41 times in 12 threads") |
| `projects` | `all?` | every registered project: path, private, guards, learned rules (areas, last learned, stale), open threads; private ones hidden by the private switch (`config.json` `private: "off"`) only with `all: true` |
| `project-add` | `project`, `path` | registers an existing folder (its real path) in `projects.json` |
| `project-remove` | `project` | unregisters only (never deletes files); refused while a thread that is not closed uses it |
| `project-private` | `project`, `on` | sets or clears the project's `private` flag |
| `goal-set` | `tN`, `text` | sets the thread's one-line goal (the chaser watches it) |
| `goal-clear` | `tN` | removes the thread's goal |

Projects come from `projects.json`: run `lean_thread projects` to see the names, or `project-add` (name + folder) to register one. `new` with a project name that is not registered is refused and answers with the known names; leave `project` out for a thread that needs none.

The desk may also Read files under `~/.lean-agent` itself (`projects.json`, `config.json`).

Threads start on sonnet/high (config.json `threads.model` / `threads.effort` change that; the call's `model` / `effort` win); the choice is recorded in `thread.json` and shown by `list` and the pane. A resume passes no flags: the session keeps its saved options.

Profiles (per project, `~/.lean-agent/<project>/profile.json`; no profile = every thread loads everything, as before): a profile is an allow-list. A thread starts with the profile plus its `needs`. MCP servers outside it are DEFERRED, not removed: the thread's mod marks their tools deferred, so ToolSearch still finds them and a thread that unexpectedly needs one can call it (nothing is dropped, lean-agent's own tools are never touched). Plugins outside it are switched off in the thread's settings (`enabledPlugins`), except lean-agent and a plugin that brings an MCP server (that one stays, its server is deferred). Give a PR thread `needs: ["azure-devops"]`, a triage thread `needs: ["sentry"]`; do not edit profiles by hand when `profile` with `fill: true` can learn them from usage (threads count the MCP servers and skills they call: names and counts, never arguments). A thread that needs more asks you a question; you answer by starting it with `needs` (a running session keeps what it started with: `needs` on `resume`/`wake` do not apply, use `start`, or close and `reopen`).

Rules: a running thread is never resumed (its messages stay queued and it reads them itself); a thread is woken at
most once per 30 seconds; a parked or closed thread only queues. Report what the tool returned, not what you assume.

Reports: what a thread reports or asks reaches the desk. While the desk is idle, a question or a `done` / `blocked` report starts one desk turn by itself (at most once a minute, never over a running turn, never for `working` progress; `desk.autoRelay: false` in `config.json` turns that off, then reports arrive with the user's next message). Relay them: ask each question with AskUserQuestion, then `send` the answer.

Checkpoints (automatic, nothing to call): a thread whose context passed `checkpoint.threadTokens` (default 100000) writes a report with the state `checkpoint`; the desk's own tick then starts a NEW session for the same tN with a handover (like a reopen) and stops the old one, and the pane row shows "checkpoint N". A checkpoint report is not a question or a done report: nothing to relay. Do not `resume` or `send` to a thread to "wake" it during that: the tick does it within seconds.

Closing: when a thread reports done and the user needs nothing more, close it yourself (`close tN`) and clear its goal (`goal-clear`). Never ask a thread to close itself: it cannot, it only reports done.
