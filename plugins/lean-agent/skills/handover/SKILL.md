---
name: handover
description: Write a handover note (what was done, state, next steps, open questions) as a Markdown file so the next session or person can continue. Use when ending a long thread or when asked for a handoff.
argument-hint: [tN]
---

# Handover

Write `~/.lean-agent/handovers/<YYYY-MM-DD>-<slug>.md` (create the folder). Contents, short and concrete:

1. **Goal**: one sentence, and the project and branch/worktree path.
2. **Done**: bullets with commits (short sha + subject) and PR links.
3. **State**: what builds/passes, what does not (command and the first error line).
4. **Next**: ordered steps, each doable without asking.
5. **Open questions** and anything waiting on the user.
6. **Pointers**: files worth reading first (path:line), saved outputs under `~/.lean-agent/output/`.

No secrets, no personal data. For a thread, also save the same text to `threads/tN/notes.md` and tell the desk with
`lean_report`.
