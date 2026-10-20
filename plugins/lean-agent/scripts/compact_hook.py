#!/usr/bin/env python3
"""Compaction and hand-off hooks for lean-agent's own (orchestrator) sessions; no effect anywhere else.

    compact_hook.py pre    PreCompact: what the summary must keep (its stdout becomes the compact instructions)
    compact_hook.py post   SessionStart: after a compaction, and when a new session starts while there is recent
                           work, the hand-off note (standing rules, open items, runs, items touched) built from
                           lean-agent's own records, so the orchestrator starts from facts, not the transcript
"""
import datetime
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import usage  # noqa: E402
import lean_memory  # noqa: E402

RECENT_HOURS = 12
REF_WORDS = re.compile(r"\b(?:PR|pull request|work item|issue|ticket|bug|story)\s*#?\s*(\d{2,})\b", re.I)
REF_KEY = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d+\b")  # PROJ-123
REF_HASH = re.compile(r"(?<![\w/&])#(\d{2,})\b")

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


def notes_path():
    return os.path.join(usage.lean_home(), "handoff-notes.json")


def load_notes():
    try:
        with open(notes_path()) as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def recent(runs, hours):
    cutoff = (datetime.datetime.now() - datetime.timedelta(hours=hours)).isoformat(timespec="seconds")
    return [r for r in runs if str(r.get("ts", "")) >= cutoff]


def touched_items(runs):
    """Tracker items, PRs and branches that recent runs worked on, from their tasks and review refs."""
    found = []
    for r in runs:
        text = str(r.get("task", ""))
        found += [f"#{n}" for n in REF_WORDS.findall(text) + REF_HASH.findall(text)] + REF_KEY.findall(text)
        ref = (r.get("review_meta") or {}).get("ref") or r.get("worktree")
        if ref:
            found.append(ref)
    return list(dict.fromkeys(found))


def standing_rules(limit=12):
    """Global feedback and user memories: the rules every session follows."""
    try:
        mems = lean_memory.read_all(lean_memory.store_dir(usage.lean_home()))
    except OSError:
        return []
    rules = [m for m in mems if m["type"] in ("feedback", "user") and m["scope"] == lean_memory.GLOBAL]
    return [" ".join(m["body"].split())[:200] for m in rules[:limit]]


def handoff(hours=RECENT_HOURS):
    """The hand-off note: what a new or compacted orchestrator session needs, from lean-agent's records."""
    home = usage.lean_home()
    now = datetime.datetime.now()
    lines = [f"lean-agent hand-off ({now:%Y-%m-%d %H:%M}; from lean-agent's records, not the transcript; "
             "any run again: `lean-agent runs --show <id>`)"]
    notes = load_notes()
    if notes:
        lines.append("Open items and pending decisions:")
        lines += [f"  {i}. {n.get('text', '')}" for i, n in enumerate(notes, 1)]
    rules = standing_rules()
    if rules:
        lines.append("Standing rules (memory):")
        lines += [f"  - {r}" for r in rules]
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
    shown = recent(runs, hours)[-10:] or runs[-3:]
    if shown:
        lines.append("Recent runs:")
    for r in shown:
        lines.append(f"  - {r.get('id')} {r.get('status')} {r.get('model')} {r.get('project')}"
                     + (f" ({r['role']})" if r.get("role") else "") + f": {' '.join(str(r.get('task', '')).split())[:90]}"
                     + (f" [details: {r['details']}]" if r.get("details") else ""))
    items = touched_items(recent(runs, hours))
    if items:
        lines.append("Items and branches touched: " + ", ".join(items[:20]))
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
    lines.append("The orchestrator rules are unchanged: `lean-agent guide` if unsure. Add open items with "
                 "`lean-agent handoff --note TEXT`, close them with `--done N`.")
    return "\n".join(lines)


def has_recent_work(hours=RECENT_HOURS):
    runs = read_jsonl(os.path.join(usage.lean_home(), "ledger.jsonl"), 50)
    return bool(load_notes() or recent(runs, hours))


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
    elif mode == "post":
        source = event.get("source", "compact")
        if source == "compact" or (source in ("startup", "clear") and has_recent_work()):
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": handoff()}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never break compaction
        print(f"lean-agent compact hook error: {exc}", file=sys.stderr)
        sys.exit(0)
