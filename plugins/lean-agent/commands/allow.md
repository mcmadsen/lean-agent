---
description: Allow a thread's remote writes (PR replies, comments, thread status; work item comments, updates) on one PR or work item, in advance
argument-hint: <tN> <PR number or URL | wi <work item id or URL>>
---

Your invoking this skill is NOT the user's accept: only a prompt the mod recorded as typed by the user, or their answer in a dialog, is. Call `lean_thread`
(`mcp__lean-agent__lean_thread`) action `allow-writes` with `tN` = the first word of `$ARGUMENTS` and `target` = `{ pr: <number or URL> }` for a PR,
or `{ workitem: <id or URL> }` when the second word is `wi` / `workitem` or the URL is a work item. Use only what the user typed, never another target.
The mod checks that their words name the target, and grants only then (24 h, at most 40 writes, until the thread closes). Say the result in one line:
what it covers and that `/lean-agent:revoke <tN>` or the pane's Revoke button takes it back. If it is refused, do not call this skill again: say why (the refusal says what the mod can see, names the forms that count and carries a canonical
question) and ask that question with AskUserQuestion (`lean_thread` `allow-ask` makes it; the user's Allow answer is the written yes). It counts only typed to the DESK's
prompt (also without the slash: `allow <tN> <PR number>`), never in a shell-mode line (starting with `!`). Never put a slash command in a bash code fence (the app adds a
Run button that runs it in a shell, where lean-agent does not see it): give it as plain text. A pasted PR or work item URL works, GUIDs and all: its number is the target, its org / project must be the thread's own.

Arguments: $ARGUMENTS
