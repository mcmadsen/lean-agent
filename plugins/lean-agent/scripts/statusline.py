#!/usr/bin/env python3
"""The orchestrator's status line in Claude Code (statusLine in the lean-agent home's settings).

    ctx 34k/67k · week 48% on pace · 2 running · 3 todo · next Mon 08:45

Claude Code runs it after each message with the session as JSON on stdin; it reads only small files and the end
of the transcript, so it stays fast. Any error prints a plain "lean-agent" instead of breaking the line.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import lean_common  # noqa: E402
import usage  # noqa: E402


def last_context(transcript):
    """The context size of the latest API call, from the end of the transcript."""
    try:
        with open(transcript, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 400000))
            tail = fh.read().decode("utf-8", "replace").splitlines()
    except (OSError, TypeError):
        return 0
    for line in reversed(tail):
        if '"usage"' not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        m = e.get("message") if isinstance(e, dict) and e.get("type") == "assistant" else None
        u = m.get("usage") if isinstance(m, dict) else None
        if isinstance(u, dict):
            return usage.context_tokens(u)
    return 0


def k(n):
    return f"{n / 1000:.0f}k" if n >= 1000 else str(n)


def line(event):
    import lean_schedule
    import budget_hook
    home = usage.lean_home()
    parts = []
    ctx = last_context(event.get("transcript_path"))
    compact_at = budget_hook.compaction_point()
    if ctx:
        parts.append(f"ctx {k(ctx)}/{k(compact_at)}" if compact_at else f"ctx {k(ctx)}")
    pace, ahead = usage.week_pace()
    if pace:
        pct = pace.split("%")[0].split()[-1]
        parts.append(f"week {pct}% " + ("ahead of pace" if ahead else "on pace"))
    running = 0
    rdir = os.path.join(home, "running")
    for f in os.listdir(rdir) if os.path.isdir(rdir) else []:
        try:
            with open(os.path.join(rdir, f)) as fh:
                alive = lean_common.pid_alive(json.load(fh).get("pid"))
        except (OSError, ValueError, AttributeError):
            continue
        running += 1 if alive else 0
    if running:
        parts.append(f"{running} running")
    try:
        with open(os.path.join(home, "todo.json")) as fh:
            todo = sum(1 for t in json.load(fh).get("items") or [] if t.get("status") != "done")
    except (OSError, ValueError):
        todo = 0
    if todo:
        parts.append(f"{todo} todo")
    try:
        nexts = [lean_schedule.next_run(j) for j in lean_schedule.jobs() if j.get("enabled", True)]
        nexts = [n for n in nexts if n]
    except (ValueError, KeyError, TypeError):
        nexts = []
    if nexts:
        parts.append(f"next job {min(nexts):%a %H:%M}")
    return "lean-agent · " + " · ".join(parts) if parts else "lean-agent"


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        event = {}
    try:
        print(line(event if isinstance(event, dict) else {}))
    except Exception:  # a status line must never fail loudly
        print("lean-agent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
