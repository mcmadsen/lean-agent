---
name: find
description: Search lean-agent's own state (threads, notes, memory, handovers, saved command output, reviews) for a word or topic. Use for "where did we...", "find the thread about...", or to read a squeezed command output.
argument-hint: <text>
---

# Find

Search under `~/.lean-agent` with Grep (or `rg` through Bash where there is no Grep tool), most useful first:

1. `threads/*/thread.json` and `brief.md` (titles, briefs) to name the thread, then its `notes.md`.
2. `memory/`, `handovers/`, `<project>/gaps.jsonl`, `todo.json`.
3. `output/`: full text of squeezed Bash results. The squeezed result names its file; Read it with an offset/limit or Grep
   it for the error instead of rerunning the command.

Show at most 10 hits as `path:line  text`; then offer to open the best one. Ledger and feedback files are for the
`stats` skill, not for this one.
