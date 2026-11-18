---
description: Start a new lean-agent thread (a background session) for a task
argument-hint: <title> [-- brief]
---

Start a new thread with the `lean_thread` tool (`mcp__lean-agent__lean_thread`), action `new`.
Use the text before `--` in `$ARGUMENTS` as the title and the text after it (or the title when there is none) as the
brief; add `project` when the arguments name a registered project (names: `lean_thread` action `projects`; an unknown one is
refused with the list of known ones). The thread runs on sonnet / effort high unless you pass `model` / `effort`. Then report
the thread id and say that its reports show in the desk pane, and that a question or a done/blocked report is sent to the desk
directly by the thread (an idle desk starts a turn for it; the desk's own 10 s check does the same if that send is refused;
else I relay it at your next message).

Arguments: $ARGUMENTS
