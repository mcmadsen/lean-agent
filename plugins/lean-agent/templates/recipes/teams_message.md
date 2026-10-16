---
name: Write a Microsoft Teams message in the user's Chrome
description: Draft (and only on approval send) a Teams chat message via Claude in Chrome; how-to, rules, pitfalls
type: reference
---
Route: run the worker with `--chrome` (the user's own signed-in Chrome through the Claude in Chrome
extension). No Teams API or MCP server is needed. Needs `lean-agent chrome check` to have passed once,
and Teams allowed in the Claude extension's site permissions.

1. Open a NEW tab at https://teams.microsoft.com and never use the user's existing tabs. If a login,
   MFA or account picker appears, stop with status needs-input.
2. Find the conversation with the search box at the top, using the person's or chat's full name. If no
   chat or several chats match, stop with needs-input and list the candidates. Never guess a recipient.
3. Open the chat and check that its header shows the expected name. To answer one specific message,
   hover it and choose Reply, then type in the reply box.
4. Click the compose box and type the text. In Teams, Enter SENDS. Use Shift+Enter for line breaks and
   never press Enter at the end of a draft.
5. Without approval to send, stop here with status awaiting-confirmation. Quote the chat name and the
   exact text. The draft stays in the compose box.
6. Only when the run has --allow-send, and for exactly the approved text: press Enter once (or click
   Send), confirm the message appears in the chat, and report the chat name and the time.
