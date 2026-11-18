---
description: Start a new lean-agent thread (a background session) for a task
argument-hint: <title> [-- brief]
---

Start a new thread with the `lean_thread` tool (`mcp__lean-agent__lean_thread`), action `new`.
Use the text before `--` in `$ARGUMENTS` as the title and the text after it (or the title when there is none) as the
brief; add `project` when the arguments name a registered project. Then report the thread id and say that the desk
will relay its reports.

Arguments: $ARGUMENTS
