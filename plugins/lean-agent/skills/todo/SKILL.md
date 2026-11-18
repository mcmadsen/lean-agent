---
name: todo
description: Keep the user's to-do list (add, list, done) in ~/.lean-agent/todo.json. Use for "remember to...", "what is on my list", "tick off ...".
argument-hint: add <text> | list | done <id>
roles: desk, thread
---

# Todos

File: `~/.lean-agent/todo.json`, an array of `{id, text, ts, done, doneTs?, project?}`; `id` is the highest id + 1.
Read the file (missing = empty), change it, write the whole file back with Write (thread: Write; desk: it has no Write, so **list** only and `send` a thread to **add** or **done**).

- **add**: append `{id, text, ts: <epoch ms>, done: false}`; say the id.
- **list**: open items first (id, text, project), then at most 5 recently done; empty list = say so.
- **done**: set `done: true` and `doneTs`; unknown id = say which ids exist. Never delete items.
