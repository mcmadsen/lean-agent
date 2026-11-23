---
description: Let a thread whose worker was denied edit its own worktree itself (24 h, never lean-agent's own state)
argument-hint: <tN>
---

Your invoking this skill is NOT the user's accept: only a prompt the mod recorded as typed by the user, or their answer in a dialog, is. Call `lean_thread`
(`mcp__lean-agent__lean_thread`) action `allow-self-edit` with `tN` = the first word of `$ARGUMENTS`. The mod checks that their recorded words name the
thread and grants only then (the thread's registered worktrees, 24 h, until the thread closes). Say the result in one line: what it covers and that
`/lean-agent:revoke-edit <tN>` or the pane's Revoke button takes it back. If it is refused, do not call this skill again: say why and ask with AskUserQuestion
("Let <tN> edit its worktree itself"). Never put a slash command in a bash code fence (the app adds a Run button that runs it in a shell, where lean-agent does not see it):
give it as plain text.

Arguments: $ARGUMENTS
