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
| `new` | `title`, `project?` (a registered project, see `projects`), `text` (the brief), `model?` (haiku/sonnet/opus), `effort?` (low/medium/high) | creates the folder, trusts it, starts the session, records its id |
| `send` | `tN`, `text` | queues the message; wakes the thread once if it is idle |
| `wake` | `tN` | resumes an idle thread with everything queued |
| `resume` | `tN` | same, with no message (after a restart). When the session ran an older lean-agent version than the installed one (`thread.json` `version`), it starts a fresh session with a handover instead and says why |
| `start` | `tN`, `model?`, `effort?` | starts a thread that has no session yet (brief + queued messages) |
| `approve-push` | `tN`, `sha` (full), `reason?` | desk only, ONLY after the user explicitly approved that push in the chat: one sha, single use, 2 h, signed, logged in the thread's `history.jsonl`; a private project is never pushed |
| `park` / `close` | `tN` | flips the state; close also stops a finished-but-alive session and clears the thread's goal (never deletes the folder) |
| `reopen` | `tN`, `model?`, `effort?` | a parked thread: back to open (then `resume`). A CLOSED thread: a NEW session in the same folder with a handover (brief, goal, notes, report history, remembered items, queued messages, branch/worktree); the old conversation is never resumed, its session id stays in `thread.json` `sids` |
| `list` | none | every thread with its project, state, running flag and queued count |
| `projects` | `all?` | every registered project: path, private, guards, learned rules (areas, last learned, stale), open threads; private ones hidden by the private switch (`config.json` `private: "off"`) only with `all: true` |
| `project-add` | `project`, `path` | registers an existing folder (its real path) in `projects.json` |
| `project-remove` | `project` | unregisters only (never deletes files); refused while a thread that is not closed uses it |
| `project-private` | `project`, `on` | sets or clears the project's `private` flag |
| `goal-set` | `tN`, `text` | sets the thread's one-line goal (the chaser watches it) |
| `goal-clear` | `tN` | removes the thread's goal |

Projects come from `projects.json`: run `lean_thread projects` to see the names, or `project-add` (name + folder) to register one. `new` with a project name that is not registered is refused and answers with the known names; leave `project` out for a thread that needs none.

The desk may also Read files under `~/.lean-agent` itself (`projects.json`, `config.json`).

Threads start on sonnet/high (config.json `threads.model` / `threads.effort` change that; the call's `model` / `effort` win); the choice is recorded in `thread.json` and shown by `list` and the pane. A resume passes no flags: the session keeps its saved options.

Rules: a running thread is never resumed (its messages stay queued and it reads them itself); a thread is woken at
most once per 30 seconds; a parked or closed thread only queues. Report what the tool returned, not what you assume.

Reports: what a thread reports or asks reaches the desk. While the desk is idle, a question or a `done` / `blocked` report starts one desk turn by itself (at most once a minute, never over a running turn, never for `working` progress; `desk.autoRelay: false` in `config.json` turns that off, then reports arrive with the user's next message). Relay them: ask each question with AskUserQuestion, then `send` the answer.

Closing: when a thread reports done and the user needs nothing more, close it yourself (`close tN`) and clear its goal (`goal-clear`). Never ask a thread to close itself: it cannot, it only reports done.
