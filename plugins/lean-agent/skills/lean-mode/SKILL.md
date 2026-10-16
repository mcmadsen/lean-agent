---
name: lean-mode
description: Work in a token-frugal way for long or unattended agent runs. Use when the user asks to save tokens, run cheaply, or keep an agent going for a long time, or when lean-agent reports the budget is getting low.
---

Follow these rules for the rest of the session:

**Reading**
- Search before you read: Grep or Glob for the symbol, then Read only the
  lines you need with `offset`/`limit`. Never read a whole large file to find
  one function.
- Don't re-read a file you already have in context unless it changed.
- Prefer `git diff --stat` and `git diff -- <file>` over reading whole files to
  see what changed.

**Commands**
- Make noisy commands quiet: `-q`/`--silent`, `--reporter=dot`, `| tail -50`,
  `--no-progress`. Run one failing test, not the whole suite, while iterating.
- lean-agent squeezes big Bash output and saves the full log. Grep the saved
  log instead of re-running the command.

**Delegation**
- Hand bulk, mechanical work (wide searches, reading many files, summarising
  logs) to a subagent on a small model and keep only its conclusion.
- Don't spawn subagents for things one Grep can answer.

**Writing**
- Keep replies short: results and decisions, not narration.
- Make edits with targeted Edit calls, not full-file rewrites.

**Long runs**
- At a natural checkpoint, write progress to a short `PROGRESS.md` so a
  compacted or resumed session can continue without re-discovering everything.
- When lean-agent warns about the budget, finish the current step, update
  `PROGRESS.md`, and stop.
