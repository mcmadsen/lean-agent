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
| `wake` | `tN` | resumes an idle thread with everything queued (a finished thread, see below, gets a new session instead) |
| `resume` | `tN` | same, with no message (after a restart). When the session ran an older lean-agent version than the installed one (`thread.json` `version`), or the thread is finished, it starts a fresh session with a handover instead and says why |
| `restart` | `tN` | only on the user's request: stops the session (also a working one; only a session in the thread's folder) and starts a NEW session with the handover, same model and effort. The reply: `tN restarted as a new session` |
| `start` | `tN`, `model?`, `effort?`, `needs?` | starts a thread that has no session yet (brief + queued messages); `needs` are added to what the thread already asked for |
| `approve-push` | `tN`, `sha` (full), `reason?` | desk only, ONLY after the user explicitly approved that push in the chat (ask naming the exact sha and branch; a thread's "ready to push <sha> (branch, PR title)" report is a request, not an approval): one sha, single use, 2 h, signed, logged in the thread's `history.jsonl`; a private project is never pushed. Then call `push` |
| `push` | `tN`, `sha` (full), `pr?` (`{title, body?, base?, draft?}`) | desk only, after `approve-push` for that exact sha: the desk itself pushes the approved commit to the thread's branch (never forced, never a tag) from the thread's registered worktree (a linked worktree of the project's repository) (a thread cannot: its own permission check refuses a push the user never said yes to in its session), then opens the PR (gh pr create) when `pr` is given (gh is looked up on PATH, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`; without it the reply gives the compare URL). Refused, with the reason, unless: the thread has a registered worktree of a non-private project, its HEAD is `sha` on a branch that is not protected, guarded or the remote's default, a green review exists for `sha`, and the approval is valid; the approval is consumed by the push (a second `push` is refused), never `--force`, never a tag. The reply, the thread's `history.jsonl` and a queued message to the thread name what happened (pushed `sha` to `remote/branch`; PR url or compare URL; a failure names the step and its first error line) |
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

Skills a brief can name (the thread runs them, the desk only routes): `learn <project>` (path rules), `review-learn`, `compare`, and `rules-pr`: draft PR with optimised Claude files for a project; needs the user's yes to push like any push. "Propose a rules PR for <project>" is a `new` for that project whose brief says "run the rules-pr skill"; the thread plans by script, edits a worktree branch `chore/claude-rules-<date>`, has it reviewed and reports "ready to push <sha> (branch, PR title)"; the push and the PR (`pr.draft: true`) follow the usual approve-push flow. After the PR merged, `send` that thread to run the skill's last step, which retires what the repo now has.

Rules: a running thread is never resumed (its messages stay queued and it reads them itself); a thread is woken at
most once per 30 seconds; a parked or closed thread only queues. Report what the tool returned, not what you assume.

Reports: what a thread reports or asks reaches the desk. While the desk is idle, a question or a `done` / `blocked` report starts one desk turn by itself (at most once a minute, never over a running turn, never for `working` progress; `desk.autoRelay: false` in `config.json` turns that off, then reports arrive with the user's next message). Relay them: ask each question with AskUserQuestion, then `send` the answer.

Done = session over (automatic, nothing to call): when a thread's last report is `done` and its turn has ended, the desk's own tick stops its session and marks the thread finished ("t3 finished: next message starts a new session"; the pane row says so). A thread that reported done but is still on a final step is stopped only once it is idle. Any later `send`, `wake`, `resume` or `start` for a finished thread starts a NEW session with a handover (brief, goal, notes, reports including the done report, queued messages, branch/worktree; the old conversation is never resumed), so a follow-up question to a done thread costs a small fresh context, not the old one. Blocked, question and progress reports never finish a session.

Restart (`restart`, `tN`): only when the user asks (the pane has a Restart button with a confirm press for every open thread, and Restart desk for the desk): the thread's session is stopped (a working one too: its current step is lost; only a session in the thread's own folder) and a NEW session starts with the same handover (reason "Restarted from the pane."), same model and effort. Use it when a thread's context has grown large; nothing restarts a thread by itself mid-work. For the desk itself, the user presses Restart desk (or types /lean-agent-restart-desk): the handover is written to `~/.lean-agent/desk/handover.md` and a new desk session is opened.

Closing: when a thread reports done and the user needs nothing more, close it yourself (`close tN`) and clear its goal (`goal-clear`). Never ask a thread to close itself: it cannot, it only reports done.
