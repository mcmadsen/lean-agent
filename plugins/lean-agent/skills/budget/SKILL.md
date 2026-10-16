---
name: budget
description: Show how many tokens this Claude Code session has used, per model and in total, against the lean-agent budget. Use when the user asks about token usage, cost, or remaining budget.
---

Run `lean-budget` with the Bash tool and show its table to the user unchanged.
Then add one or two sentences on where the tokens went, for example whether
cache reads dominate (cheap, from long context), output dominates (long replies
or edits), or a subagent model is the biggest line.

If `lean-budget` is not found, run
`python3 ~/.claude/plugins/*/lean-agent/*/scripts/usage.py report` instead.
