---
description: Take back the written approval for a thread's remote writes (the PR or work item it was allowed on)
argument-hint: <tN>
---

Call `lean_thread` (`mcp__lean-agent__lean_thread`) action `revoke-writes` with `tN` = the first word of `$ARGUMENTS` (without it: every written approval).
Say in one line what was revoked: from now on that thread's writes are asked with AskUserQuestion again.

Arguments: $ARGUMENTS
