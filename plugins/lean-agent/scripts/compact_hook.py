#!/usr/bin/env python3
"""Compaction hooks for lean-agent's own (orchestrator) sessions; no effect anywhere else.

    compact_hook.py pre    PreCompact: what the summary must keep (its stdout becomes the compact instructions)
    compact_hook.py post   SessionStart after a compaction: a short state digest from lean-agent's own records,
                           so the orchestrator doesn't rebuild it from memory
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import usage  # noqa: E402

KEEP = """\
This is the lean-agent orchestrator. Its records (runs, reviews, cards, memory) live outside the conversation,
so the summary can be short. Keep, exactly:
- the user's current goals and open requests, in their words;
- every approval the user gave for an outward action (send, post, push, merge, vote, move), word for word,
  and what it covered; and what the user declined;
- runs still in progress or waiting for an answer (run ids and what each is for), PRs and branches being worked on;
- review findings not yet fixed, and decisions (declined findings, chosen models, budgets);
- facts the user stated that aren't saved anywhere else.
Drop: worker answers and command output (`lean-agent runs --show <id>` prints any run again), file contents,
the orchestrator guide (`lean-agent guide`), and finished side tasks. Don't repeat card or memory text.
"""


def in_lean_home(event):
    cwd = os.path.realpath(event.get("cwd") or os.getcwd())
    home = os.path.realpath(usage.lean_home())
    return cwd == home or cwd.startswith(home + os.sep)


def read_jsonl(path, tail=400):
    try:
        with open(path) as fh:
            lines = fh.readlines()[-tail:]
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def digest():
    home = usage.lean_home()
    lines = ["lean-agent state after compaction (from its records; details: `lean-agent runs --show <id>`):"]
    running = []
    rdir = os.path.join(home, "running")
    for f in sorted(os.listdir(rdir)) if os.path.isdir(rdir) else []:
        try:
            with open(os.path.join(rdir, f)) as fh:
                m = json.load(fh)
            os.kill(int(m.get("pid", 0)), 0)
            running.append(f"{m.get('run', '?')} {m.get('model', '')} {m.get('project', '')}: {m.get('task', '')[:80]}")
        except (OSError, ValueError, TypeError):
            continue
    if running:
        lines.append("Running now: " + "; ".join(running))
    runs = read_jsonl(os.path.join(home, "ledger.jsonl"))
    for r in runs[-6:]:
        lines.append(f"- {r.get('id')} {r.get('status')} {r.get('model')} {r.get('project')}"
                     + (f" ({r['role']})" if r.get("role") else "") + f": {str(r.get('task', ''))[:90]}")
    latest = {}
    rev_dir = os.path.join(home, "reviews")
    for f in sorted(os.listdir(rev_dir)) if os.path.isdir(rev_dir) else []:
        if f.endswith(".jsonl") and "." not in f[:-6]:
            for r in read_jsonl(os.path.join(rev_dir, f), 200):
                latest[(f[:-6], r.get("ref"))] = r
    if latest:
        lines.append("Latest reviews: " + "; ".join(
            f"{p} {ref or 'working tree'} @ {str(r.get('head', ''))[:10]} {r.get('verdict')}"
            f" ({sum(1 for x in r.get('findings') or [] if x.get('severity') in ('blocker', 'major'))} blocking)"
            for (p, ref), r in list(latest.items())[-5:]))
    lines.append("Rules are unchanged: re-read them with `lean-agent guide` if unsure.")
    return "\n".join(lines)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        event = json.load(sys.stdin)
    except ValueError:
        event = {}
    if not in_lean_home(event):
        return 0
    if mode == "pre":
        sys.stdout.write(KEEP)
    elif mode == "post" and event.get("source", "compact") == "compact":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": digest()}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never break compaction
        print(f"lean-agent compact hook error: {exc}", file=sys.stderr)
        sys.exit(0)
