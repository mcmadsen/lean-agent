---
name: goals
description: Show and manage thread goals (one line each) that the desk's chaser watches. Use for "what is everyone working on", "set goal for tN" or when a goal shows red in the pane.
argument-hint: list | set <tN> <text> | clear <tN>
---

# Goals

`~/.lean-agent/goals.json` is an object `{ "tN": {text, ts, chased?} }`. A thread updates its own goal with
`lean_goal` (that resets `ts`); the desk does not edit goals by hand except through this skill.

- **list**: one row per goal: thread, text, age, and tone: working (thread running), waiting (unread question),
  stuck (no update for an hour and idle), quiet.
- **set**: write the entry with `ts` now (Read, edit, Write the whole file).
- **clear**: remove the entry when the thread is closed or its goal is done.

The chaser runs in the desk mod: every minute, a goal untouched for an hour whose thread is open and has no unread
question gets one "status?" message (the thread is woken if idle), then it is left alone for another hour. If a
thread stays red after the chase, read `threads/tN/notes.md` and decide: send guidance, park or close.
