---
description: Allow a thread's remote writes (PR replies, comments, thread status; work item comments, updates) on one PR or work item, in advance
argument-hint: <tN> <PR number or URL | wi <work item id or URL>>
---

Your invoking this skill is NOT the user's accept: the mod records only commands and words the user typed in the chat box (never a shell box), and their answer in a dialog. Call `lean_thread`
(`mcp__lean-agent__lean_thread`) action `allow-writes` with `tN` = the first word of `$ARGUMENTS` and `target` = `{ pr: <number or URL> }` for a PR,
or `{ workitem: <id or URL> }` when the second word is `wi` / `workitem` or the URL is a work item. Use only what the user typed, never another target.
The mod checks that their words name the target, and grants only then (24 h, at most 40 writes, until the thread closes). Say the result in one line:
what it covers and that `/lean-agent:revoke <tN>` or the pane's Revoke button takes it back. If it is refused, do not call this skill again: tell the user what the refusal lists ("recorded prompts: 3, none names PR 123") and ask its canonical
question with AskUserQuestion at once (`lean_thread` `allow-ask` makes it; the user's Allow answer is the written yes). Typed words count only in the CHAT box (also without the slash: `allow <tN> <PR number>`), never in a shell-mode line (starting with `!`). Never put a slash command in a bash code fence: the app turns it into a Run button that runs it in the shell; give it as plain text or ask with AskUserQuestion. A pasted PR or work item URL works, GUIDs and all: its number is the target, its org / project must be the thread's own.

Arguments: $ARGUMENTS
