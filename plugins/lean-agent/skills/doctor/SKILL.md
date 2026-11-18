---
name: doctor
description: Check and repair the lean-agent install (desk folder, login opener, trust), and migrate 0.45 state to 1.0 once. Use when the user says doctor, migrate, "desk did not open at login", or after updating from 0.45.
roles: desk
---

# Doctor and migrate

Everything goes through the desk's `lean_doctor` tool (full name `mcp__lean-agent__lean_doctor`). It only works in the
desk session; report what it returned, never what you assume.

If the tool is missing (no `lean_doctor` / `lean_thread`), this session is not the desk: tell the user to start a NEW
session in `~/lean-agent-desk`. On 1.0.0 a session the app moved there from a spare folder never gets the tools; that
needs 1.0.1 (`claude plugin update lean-agent`).
Without the tool, setup still works from the mod: the user types `/lean-agent-setup` (check + fix, any session), or
`/lean-agent` and presses **Set up lean-agent** / **Open desk**. Tell them that first.

| action | effect |
|---|---|
| `check` | read-only report: `claude` on PATH, desk folder `~/lean-agent-desk`, folder trusted, opener script current, launch agent installed, desk model/effort pin (sonnet / high), last line of the opener log, 0.45 leftovers, and how the desk's skill listing was trimmed (`desk skill listing: ...`, plus the attachment/section names seen this session; names only). Lines starting `FIX` need `fix` |
| `fix` | creates the desk folder, installs `~/.lean-agent/bin/open-desk.sh` and the `com.lean-agent.desk` launch agent (macOS), trusts the desk folder by its real path, pins the desk to `sonnet` / effort `high` in `~/lean-agent-desk/.claude/settings.json` (other keys kept; config.json `desk.model` / `desk.effort` override) |
| `migrate` | one-time 0.45 -> 1.0 conversion, then `fix`. Idempotent: a second run says "already migrated" |

## Login opener

At login the opener waits (up to 10 minutes) for the Claude app, never launches it, then runs `claude --desktop` in the
desk folder. If the desk did not open: run `check`, read the "last opener run" line, then `fix`. No Claude app running
means nothing is opened; that is by design.

## What migrate does (design section 4)

- Kept as is: `projects.json`, handovers, reviews, passes, `memory/`, `todo.json`, `worktrees.json`, `config.json`, `ledger.jsonl`.
- Open goals without a thread and open questions to the desk become `goals.json` / `questions.jsonl`; the old files are archived. Open 0.45 questions to the desk are recorded and closed at migration (no thread can answer them), so they do not show in the pane.
- **Every open 0.45 thread is closed.** Nothing is carried over; a readable list is kept in `~/.lean-agent/legacy-0.45/closed-threads.md`.
- Recipes become `<project>/skills/<name>/SKILL.md`. Cards move to `legacy-0.45/`; tell the user which projects to
  re-learn (the `learn` skill) and offer to run it.
- Old service files, windows, caps, update files and locks move to `legacy-0.45/`; the old `com.lean-agent.up` service is
  unloaded; the old `lean-agent` command shim is removed (1.0 has no CLI); folders are trusted by real path.

After `migrate`, tell the user: quit any hosted 0.45 desk, and open Claude once so the opener finds it at the next login.
