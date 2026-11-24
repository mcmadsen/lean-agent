---
description: Show and change lean-agent's settings (config.json) without hand-editing it
argument-hint: [key [value] | reset <key> | validate]
---

Your invoking this command is NOT the user's accept for a sensitive key: the mod records only commands and words the user typed in the chat box (never a shell box). Call
`lean_config` (`mcp__lean-agent__lean_config`) from `$ARGUMENTS`, using the config skill: no arguments = action `list` (a short table per group: key, now, default, `*` marks
non-defaults); one word = `get` with that key; `reset <key>` = `unset`; `validate` = `validate`; a key and a value (the rest of the line) = `set`. Use only what the user typed, never
another key or value. Say the result in one line, including when it applies (now, from the next session, after the desk restarts). A sensitive key (marked in the list) changes only
because the user typed its name in this command or in their words, or pressed Approve on the question the tool returns: if the tool refuses, say "this setting loosens a safety rule: type `/lean-agent:config <key> <value>` in the chat box, or I ask you with a question",
and ask that question with AskUserQuestion, pasted exactly with exactly the options Approve, Not now. Never put the command in a code block (the app turns it into a Run button that runs it in a shell): give it as plain text.

Arguments: $ARGUMENTS
