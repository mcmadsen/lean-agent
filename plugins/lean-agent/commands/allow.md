---
description: Allow a thread's remote writes (PR replies, comments, thread status; work item comments, updates) on one PR or work item, in advance
argument-hint: <tN> <PR number or URL | wi <work item id or URL>>
---

The user typed this command: it is their written accept, recorded by the mod from their own prompt (never from you). Call `lean_thread`
(`mcp__lean-agent__lean_thread`) action `allow-writes` with `tN` = the first word of `$ARGUMENTS` and `target` = `{ pr: <number or URL> }` for a PR,
or `{ workitem: <id or URL> }` when the second word is `wi` / `workitem` or the URL is a work item. Use only what the user typed, never another target.
The mod checks that their words name the target, and grants only then (24 h, at most 40 writes, until the thread closes). Say the result in one line:
what it covers and that `/lean-agent:revoke <tN>` or the pane's Revoke button takes it back. If it is refused, say why (the refusal names the forms that count and
the user's last message that did not) and ask with AskUserQuestion. It counts only typed to the DESK's prompt (also without the slash: `allow <tN> <PR number>`), never in a
shell-mode line (starting with `!`). A pasted PR or work item URL works, GUIDs and all: its number is the target, its org / project must be the thread's own.

Arguments: $ARGUMENTS
