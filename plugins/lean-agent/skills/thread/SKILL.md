---
name: thread
description: Start, message, wake, park, close and list lean-agent threads (background Claude sessions, one folder each) through the lean_thread tool. Use whenever the desk routes work.
---

# Threads

A thread is a background session (`claude --bg`) in its own folder under `~/.lean-agent/threads/tN`. The desk only
ever touches threads through the `lean_thread` tool (full name `mcp__lean-agent__lean_thread`); never run
`claude --bg` or `--resume` yourself.

| action | input | effect |
|---|---|---|
| `new` | `title`, `project?`, `text` (the brief) | creates the folder, trusts it, starts the session, records its id |
| `send` | `tN`, `text` | queues the message; wakes the thread once if it is idle |
| `wake` | `tN` | resumes an idle thread with everything queued |
| `resume` | `tN` | same, with no message (after a restart) |
| `start` | `tN` | starts a thread that has no session yet (brief + queued messages) |
| `park` / `reopen` / `close` | `tN` | flips the state; close also stops a running session |
| `list` | none | every thread with its state, running flag and queued count |
| `projects` | `all?` | every registered project: path, private, guards, learned rules (areas, last learned, stale), open threads; private ones hidden by the private switch (`config.json` `private: "off"`) only with `all: true` |
| `project-add` | `project`, `path` | registers an existing folder (its real path) in `projects.json` |
| `project-remove` | `project` | unregisters only (never deletes files); refused while a thread that is not closed uses it |
| `project-private` | `project`, `on` | sets or clears the project's `private` flag |

The desk may also Read files under `~/.lean-agent` itself (`projects.json`, `config.json`).

Rules: a running thread is never resumed (its messages stay queued and it reads them itself); a thread is woken at
most once per 30 seconds; a parked or closed thread only queues. Report what the tool returned, not what you assume.
