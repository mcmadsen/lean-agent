---
description: Alias of /lean-agent:list (the old name): list lean-agent threads with state, running flag and queued messages
---

Same as `/lean-agent:list`: call the `lean_thread` tool (`mcp__lean-agent__lean_thread`) with action `list` and show its answer as a
short table: id, title, state, running, queued. Do not start or wake anything.
