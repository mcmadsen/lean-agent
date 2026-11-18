---
name: compare
description: Measure what a lean-agent session costs at start against a clean Claude Code session (overhead: cheap, no model judging), or run one read-only task both ways and let a judge compare (task mode, costs money). Use for "compare <project>", "what does lean-agent cost per session" or "optimize the overhead".
argument-hint: <project> [--task "<read-only task>"] [--history]
roles: desk, thread
---

# Compare

Both modes run in the mod: you call one tool and show its answer. Nothing is measured by reading files yourself.

**Overhead mode** (cheap: about a dozen one-turn calls on haiku, capped at $0.25, `/context` itself is free).
- Desk: `lean_doctor` with `action: compare`, `project: <registered name>` (`mode: history` lists the saved reports).
- Thread: `lean_compare` with `mode: overhead` and the project.
- What it does: in the project folder with lean-agent switched off (the clean column), in a throw-away thread-shaped folder (the
  thread column) and in the desk folder (the desk column), it runs `claude -p "Reply with OK."` and `/context`. Rows: the first turn's input tokens (measured),
  its cost, and `/context`'s estimates (system prompt, system tools, MCP tools, custom agents, memory files, skills,
  messages). On the clean column it also switches skills and MCP servers off one at a time and reports each one's share.
- Read the table to the user as it is, then the suggestions: each names the concrete step (a plugin or MCP server to leave out
  of the project profile, desk: `lean_thread` `profile` with `mcp` / `plugins` (outside it a server is deferred, not removed;
  a thread asks the desk), a memory file to
  move into path rules with `learn <project> --gaps`, rules that never loaded with `learn <project> --trim`, gaps that look
  like script candidates). Do not apply any of them without the user's yes.
- The per-server and per-plugin sizes are `/context` definition sizes, most of them deferred by the engine: NOT first-turn cost
  (the "One source off at a time" lines are the measured effect). A server or plugin the project's threads really called is
  marked "used N times in M threads: keep", lean-agent's own server is never suggested, and advice is given for the thread
  column only. The thread column starts with the project's profile (a "Loaded in thread" line says which MCP servers and plugins).
- The thread and desk columns are `-p` runs: what the mod trims by role only counts if its hooks module loaded there (the
  report says so when it did not); the live desk's own `/context` is the check.

**Task mode** (explicit; costs money, up to about $2 for the two runs plus a few cents for the judge). The desk never runs it.
- desk: tells the user the cost, waits for a yes, then starts a thread (`lean_thread` `new`, project and a brief that says "use the compare skill, task mode, task: ...").
- thread: calls `lean_compare` with `mode: task`, `project` and `task` (one read-only task about the project, specific enough to have a checkable answer).

The mod runs it clean and as a thread (same model,
sonnet, effort high, same read-only tools), then a haiku judge compares correctness and completeness only (the order of the two
answers alternates). It reports tokens, cost, turns, time and the verdict. If the verdict is `tie` or `?`, you may spot-check the
two claims with `lean-agent:reviewer`; say that this is your judgment, not the judge's.

**Reports**: `~/.lean-agent/compare/<date>-<project>.md` and `history.jsonl`: names and numbers only, never file contents, the
task text, the answers or the judge's reason (that goes to you, once). A private project is never compared. The `feedback`
skill may attach the latest summary line, nothing else.
