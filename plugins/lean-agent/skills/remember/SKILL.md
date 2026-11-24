---
name: remember
description: Remember a standing rule, preference, decision or fact for later sessions without bloating context. Use for "remember", "from now on", "always / never", a correction the user repeats.
argument-hint: <text> | list [scope] | retire <id> | prune
roles: desk, thread
---

# Remember

ONE private store (never CLAUDE.md, never a repo file). You write only the text, 200 characters at most; scripts pick the scope, merge a near-duplicate, cap each scope at 12, refuse secrets, and put the standing orders in every session's prompt.

**When:** the user states a standing preference or rule; repeats a correction; gives a decision with its reason; had to repeat a fact.
**Never:** anything the repo shows, ephemeral task state, secrets, tokens, emails, home paths, other people's data. A rule that loosens a safety rule (permissions, approvals, pushes, sends) is kept only by the user's own typed `/lean-agent:remember <text>`.

- desk: `lean_memory` add {text, scope?, kind?, trigger?, output?}; when it answers "for this thread, this project or always?", ask the user that, then add with the scope. list, find, get, retire, edit, confirm (a candidate), prune (suggests only). One thread's standing rule: `lean_thread` action `rule` (tN, text).
- thread: `lean_remember` {text, scope?, kind?, trigger?, output?}: for itself, its project or a task; "always" is the desk's.
- The mod already stores a typed "remember / from now on / always / never" and says so in one line: repeat that line to the user, never add it twice. A candidate it shows once: ask keep or drop.
- Full text on demand (desk: `lean_memory` find; thread: `lean_run` {pull: "memory", section: words}); the index, the relevant reminders ("memory: ...") and the triggers come from the mod.
