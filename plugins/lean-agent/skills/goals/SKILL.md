---
name: goals
description: Show and manage thread goals (one line each) that the desk's chaser watches. Use for "what is everyone working on", "set goal for tN" or when a goal shows red in the pane.
argument-hint: list | set <tN> <text> | clear <tN>
roles: desk, thread
---

# Goals

`~/.lean-agent/goals.json` is an object `{ "tN": {text, ts, chased?} }`. The mod writes it; nobody edits it by hand (the desk
has no Write/Edit).

- **list** (desk or thread): Read the file; one row per goal: thread, text, age, and tone: working (thread running), waiting
  (unread question), stuck (no update for an hour and idle), quiet.
- **set** (desk): `lean_thread` action `goal-set` with `tN` and `text`; it writes the entry with `ts` now. thread: `lean_goal` for its own goal.
- **clear** (desk): `lean_thread` action `goal-clear` with `tN`, when the thread is closed or its goal is done. A thread does not clear its own goal.

desk: set and clear go through `lean_thread` rather than asking the thread with `send`: it is two words in a tool the desk already
has (no new tool, no Write), the mod writes the file in one step, and it works for a parked or closed thread that no `send` would wake.

The chaser runs in the desk mod: every minute, a goal untouched for an hour whose thread is open and has no unread
question gets one "status?" message (the thread is woken if idle), then it is left alone for another hour. If a
thread stays red after the chase, read `threads/tN/notes.md` and decide: send guidance, park or close.
