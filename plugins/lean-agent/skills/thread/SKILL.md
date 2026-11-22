---
name: thread
description: Start, message, wake, park, close and list lean-agent threads (background Claude sessions, one folder each) through the lean_thread tool. Use whenever the desk routes work.
argument-hint: <new | send | wake | park | close | list | dismiss | review> [tN] [text]
roles: desk
---

# Threads

Threads are background sessions in `~/.lean-agent/threads/tN`. Touch them only through `lean_thread`; never run `claude --bg` or `--resume`. Report what the tool returned.

| action | input | effect |
|---|---|---|
| `new` | `title`, `project?`, `text` (brief), `model?` (haiku/sonnet; opus: see below), `effort?`, `needs?` (MCP servers/plugins on top of the project profile), `keep?`, `review?` ({pr\|branch\|sha, base?}: a review thread) | creates and starts the session; workers may read and edit: brief them with `job:` and one step (`allowEdit` / `allowCmd` are accepted and ignored) |
| `send` / `wake` / `resume` | `tN`, `text?` | `send` queues and wakes an idle thread once; a running one is never resumed. A finished thread (not keep mode) or one over its context limit gets a NEW session with a handover; so does a stale-version or unapproved-opus one |
| `restart` | `tN`, `model?`, `effort?`, `reason?` | only on the user's request: stops the session, starts a new one with the handover (a parked thread reopens) |
| `start` | `tN`, `model?`, `effort?`, `reason?`, `needs?`, `keep?` | starts a thread that has no session yet |
| `park` / `close` / `reopen` | `tN` | `close` stops a finished session, clears the goal, never deletes the folder; `reopen` of a closed thread starts a NEW session with a handover |
| `keep` | `tN`, `on?` | keep mode: follow-ups to a done thread resume it until its context passes the limit; offer it only for many small follow-ups |
| `list` | none | state, running / idle / stuck, queued, model, `ctx` size, agents |
| `find` / `ask` / `report` | `text` / `tN` + `text` / `tN` | answered from the store with no model turn (or a small fresh one), never by waking an old session |
| `dismiss` | `tN` [`kind`] or `notice` | only after the user said so: hides tN's current Needs-you item (or `kind`: question, prompt, approval, blocked, stalled, restart, ready, model, action), or a top line (`notice`: its id or `all`) until a newer one arrives; nothing is answered |
| `goal-set` / `goal-clear` | `tN`, `text` | the thread's one-line goal (the chaser watches it) |
| `profile` | `project`, `mcp?`, `plugins?`, `fill?`, `on?` | the project's MCP/plugin allow-list (outside it: deferred, not removed); `fill: true` learns it from usage; a PR thread gets `needs: ["azure-devops"]` |
| `projects` / `project-add` / `project-remove` / `project-private` | `project`, `path?`, `on?` | registry; `projects all: true` includes private ones; turning private off needs the user's yes first (AskUserQuestion), then `confirm: true` |
| `action-list` | none | the remote writes threads asked for with an `action` request, each with the exact question to ask the user |
| `approve-action` | `id` | ONLY after the user chose Approve in AskUserQuestion for that request: the mod sends exactly the approved text once (a `batch` request: all its numbered writes, in order, stopped at the first failure, reported per item). Refused without a human Approve, when denied, expired (2 h), sent already or changed |
| `approve-push` / `push` | `tN`, `sha` (full), `reason?` / `pr?` | ONLY after the user explicitly approved that sha and branch in the chat. `approve-push`: single use, 2 h, signed. `push`: the desk pushes the approved commit (never forced, never a tag) from the thread's registered worktree, opens the PR with `gh` / `az` when `pr` is given, or answers with the host's create-PR link. Refused with the reason unless the project is not private, the worktree's HEAD is `sha` on an unprotected non-default branch, a full green review exists for `sha` and the approval is valid. The reply names what happened |

Rules:
- Opus: never choose opus (or any model that is not haiku or sonnet); only when the user wants it, pass `model: opus` + `reason`. The thread does NOT start: the request waits in the pane's "Needs you" for their Approve press (no tool call or message approves). Deny or no answer: `start` on sonnet when the user says so. A call that names no model for a thread recorded on an unapproved opus starts a new sonnet session. Do not ask for the press unless the reply says a request waits.
- Reports reach the desk by themselves. A question: AskUserQuestion, then `send` the answer. A blocked report with an `action` request: `action-list`, ask with its exact question (options Approve / Deny / Edit first), `approve-action` only after Approve. Never call `approve-action` on your own, never fill `answers`. A blocked report with an `approval` (a denied action) is not a question: never ask it, never `send` a yes (it does not satisfy Claude Code's permission check); say once to press "Open tN" in the pane.
- Forge writes: never curl / az / gh a forge write; request the action kind (ado-pr-reply, ado-pr-thread-status, ado-pr-comment, ado-workitem-comment, ado-workitem-update, gh-pr-comment, gh-pr-thread-resolve, batch). A reply can carry `status` (one approval for reply + resolve); several writes for one PR are one `batch`. Never brief a thread to curl / az / gh a forge write: a `new` / `send` text that does is flagged.
- Done ends the session (the tick stops it, "tN finished"). Close a done thread when the user needs nothing more; never ask a thread to close itself.
- `stuck` or "queued, session idle" means nobody read the message: `wake` (replaces a stuck session whose turn ended), or `restart` (the only way to replace a stuck session that still works: its step is lost, say so first). Never say "running" when the list says idle or stuck.
- Skills a brief can name: `learn <project>`, `review-learn`, `compare`, `rules-pr` (branch `chore/claude-rules-<date>`, reviewed, then the usual approve-push with `pr.draft: true`; after the merge `send` the thread to run its last step).
