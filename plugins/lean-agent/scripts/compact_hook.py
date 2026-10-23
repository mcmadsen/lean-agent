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
import lean_common  # noqa: E402
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


SHA = re.compile(r"^[0-9a-f]{7,40}$")


def run_branch(r, worktrees):
    """The branch a run worked on: the reviewed ref, or its worktree's ref (not the worktree's folder name)."""
    ref = (r.get("review_meta") or {}).get("ref")
    if not ref and r.get("worktree"):
        ref = ((worktrees.get(r.get("project")) or {}).get(r["worktree"]) or {}).get("ref") or r["worktree"]
    ref = (ref or "").replace("origin/", "", 1)
    return "" if SHA.match(ref) else ref  # a bare commit says nothing to the next session


def touched_items(runs):
    """Tracker items, PRs and branches that recent runs worked on: "PR 512 (feature/x)", "SHOP-77", "#40"."""
    try:
        with open(os.path.join(usage.lean_home(), "worktrees.json")) as fh:
            worktrees = json.load(fh)
    except (OSError, ValueError):
        worktrees = {}
    found = []
    for r in runs:
        text = str(r.get("task", ""))
        prs = REF_WORDS.findall(text)
        branch = run_branch(r, worktrees)
        if prs and branch:
            found += [f"PR {n} ({branch})" for n in prs]
        else:
            found += [f"PR {n}" for n in prs] + ([branch] if branch else [])
        found += [f"#{n}" for n in REF_HASH.findall(text) if n not in prs] + REF_KEY.findall(text)
    # "PR 512" and the bare branch add nothing once "PR 512 (branch)" is there
    return [x for x in dict.fromkeys(found)
            if not any(y.startswith(x + " (") or y.endswith(f" ({x})") for y in found)]


def _slug(text, limit=40):  # as lean-agent names memory cards (mem-<slug>)
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(slug) > limit:
        cut = slug[:limit + 1].rfind("-")
        slug = slug[:cut if cut > limit // 2 else limit]
    return slug.strip("-") or "card"


def _words(text):
    return {w for w in re.findall(r"[a-z0-9]{4,}", text.lower())}


def standing_rules(limit=10, runs=()):
    """Feedback and user memories, without near-duplicates, best first: ones whose card is core or protected,
    then ones about the current work (words shared with recent runs), then the most used, then the newest."""
    home = usage.lean_home()
    try:
        mems = lean_memory.read_all(lean_memory.store_dir(home))
    except OSError:
        return []
    flagged, used = set(), {}
    for f in glob.glob(os.path.join(home, "library", "*", "cards.json")):
        try:
            with open(f) as fh:
                cards = json.load(fh)
        except (OSError, ValueError):
            continue
        for c in cards if isinstance(cards, list) else []:
            if str(c.get("id", "")).startswith("mem-"):
                if c.get("core") or c.get("protected") or c.get("core_types"):
                    flagged.add(c["id"])
                used[c["id"]] = used.get(c["id"], 0) + int(c.get("used") or 0)
    work = set().union(*(_words(str(r.get("task", ""))) for r in runs)) if runs else set()
    rules = [m for m in mems if m["type"] in ("feedback", "user")]
    rules.sort(key=lambda m: m.get("modified") or "", reverse=True)
    rules.sort(key=lambda m: (("mem-" + _slug(m["stem"])) not in flagged, -len(_words(m["body"]) & work),
                              -used.get("mem-" + _slug(m["stem"]), 0)))
    out, seen = [], []
    for m in rules:
        w = _words(m["body"])
        if any(w and len(w & s) / len(w | s) >= 0.7 for s in seen):
            continue  # the same rule saved twice (e.g. a "-2" copy)
        seen.append(w)
        out.append(" ".join(m["body"].split())[:200])
        if len(out) >= limit:
            break
    return out


GOAL = re.compile(r"(?im)^\s*(?:goal|task)\s*:\s*(.+)$")


def run_line(r):
    """What a run was about in one line: its result's first sentence, else the task's Goal line, else the task."""
    head = " ".join(str(r.get("result_head") or "").split())
    if head:
        m = re.match(r"(.{20,160}?[.!?])(\s|$)", head)
        return (m.group(1) if m else head[:120])
    m = GOAL.search(str(r.get("task", "")))
    return " ".join((m.group(1) if m else str(r.get("task", ""))).split())[:100]


def handoff(hours=RECENT_HOURS):
    """The hand-off note: what a new or compacted orchestrator session needs, from lean-agent's records."""
    home = usage.lean_home()
    now = datetime.datetime.now()
    lines = [f"lean-agent hand-off ({now:%Y-%m-%d %H:%M}; from lean-agent's records, not the transcript; "
             "any run again: `lean-agent runs --show <id>`)"]
    pace, _ = usage.week_pace()
    if pace:
        lines.append(pace.capitalize())
    try:
        with open(os.path.join(home, "todo.json")) as fh:
            todo = [t for t in json.load(fh).get("items") or [] if t.get("status") != "done"]
    except (OSError, ValueError):
        todo = []
    if todo:
        todo.sort(key=lambda t: (t.get("status") != "doing", {"high": 0, "low": 2}.get(t.get("prio"), 1),
                                 t.get("due") or "9999", t.get("id", 0)))
        lines.append(f"Work queue ({len(todo)} open; `lean-agent todo next` picks the next):")
        lines += [f"  #{t['id']} {'[doing] ' if t.get('status') == 'doing' else ''}{t['text'][:100]}"
                  + (f" ({t['ref']})" if t.get("ref") else "") for t in todo[:10]]
    notes = load_notes()
    if any(n.get("kind") != "checkpoint" for n in notes):  # checkpoints show in `brief`, not here; numbers stay
        lines.append("Open items and pending decisions:")
        lines += [f"  {i}. {n.get('text', '')}" for i, n in enumerate(notes, 1) if n.get("kind") != "checkpoint"]
    runs = read_jsonl(os.path.join(home, "ledger.jsonl"))
    rules = standing_rules(runs=recent(runs, hours))
    if rules:
        lines.append("Standing rules (memory):")
        lines += [f"  - {r}" for r in rules]
    live = lean_common.running_runs(home)
    running = [f"{rid} {m.get('model', '')} {m.get('project', '')}: {m.get('task', '')[:80]}" for rid, m in live]
    live_ids = {rid for rid, _ in live}
    waiting = lean_common.uncollected_ids(home, live_ids)
    if running or waiting:
        lines.append("Running now: " + ("; ".join(running) if running else "none")
                     + (f". Finished, not collected: {', '.join(waiting)}" if waiting else "")
                     + ". They survive a clear; collect with `lean-agent runs --wait all`")
    shown = recent(runs, hours)[-10:] or runs[-3:]
    if shown:
        lines.append("Recent runs:")
    for r in shown:
        lines.append(f"  - {r.get('id')} {r.get('status')} {r.get('model')} {r.get('project')}"
                     + (f" ({r['role']})" if r.get("role") else "") + f": {run_line(r)}"
                     + (f" [details: {r['details']}]" if r.get("details") else ""))
    sched = [r for r in read_jsonl(os.path.join(home, "scheduled.jsonl"), 50)
             if str(r.get("ts", "")) >= (datetime.datetime.now() - datetime.timedelta(hours=hours)).isoformat()]
    if sched:
        lines.append("Scheduled jobs that ran:")
        lines += [f"  #{r.get('id')} lean-agent {' '.join(r.get('args') or [])}: exit {r.get('rc')}: "
                  f"{str(r.get('first', ''))[:100]} (full: {r.get('output')})" for r in sched[-6:]]
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
    lines.append("The orchestrator rules are unchanged: `lean-agent guide` if unsure. Keep your own state with "
                 "`lean-agent handoff --note TEXT --kind fyi` (close with `--done N`); anything the user wants kept is "
                 "`lean-agent remember`.")
    return "\n".join(lines)


BRIEF_MORE = "… (more: lean-agent brief)"
CHECKPOINT_CAP = 2000  # characters of the checkpoint kept in a capped brief; the rest of the cap is the hand-off


def cut_lines(text, limit):
    """`text` cut to at most `limit` characters at a line boundary (a single longer line is cut mid-line)."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    nl = cut.rfind("\n")
    return (cut[:nl] if nl > 0 else cut).rstrip()


def threads_summary(lines=6):
    """The open threads in a few lines (`lean-agent now`, without closing idle ones), so a fresh session knows the topics."""
    try:
        import lean_threads
        text = lean_threads.now_text(close_idle=False, max_lines=lines)
    except Exception:  # a broken registry must not break the brief
        return ""
    return "" if text.startswith("No open") else text + "\nFull list: lean-agent now; one topic: lean-agent thread show tN"


def brief(cap=None):
    """What a fresh orchestrator session starts from: the latest checkpoint (its soft state), then the hand-off.
    With `cap`, the checkpoint gets up to CHECKPOINT_CAP characters and the hand-off the rest."""
    cps = [n for n in load_notes() if n.get("kind") == "checkpoint"]
    head, more = "", False
    if cps:
        body = str(cps[-1].get("text", ""))
        if cap:
            shown = cut_lines(body, CHECKPOINT_CAP)
            more = shown != body
            body = shown
        head = f"Checkpoint of {str(cps[-1].get('ts', ''))[:16].replace('T', ' ')} (your own soft state before the clear; continue from it):\n{body}\n\n"
    rest = handoff()
    topics = threads_summary()
    if topics:
        head += topics + "\n\n"
    if cap:
        room = max(0, cap - len(head) - len(BRIEF_MORE) - 1)
        shown = cut_lines(rest, room)
        more = more or shown != rest
        rest = shown
    return head + rest + (("\n" + BRIEF_MORE) if more else "")


def has_recent_work(hours=RECENT_HOURS):
    home = usage.lean_home()
    runs = read_jsonl(os.path.join(home, "ledger.jsonl"), 50)
    return bool(load_notes() or recent(runs, hours) or os.path.exists(os.path.join(home, "todo.json")))


def count_compaction(session_id):
    """How many times this conversation has compacted (counted at each SessionStart after a compaction)."""
    path = os.path.join(usage.lean_home(), "compactions.json")
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = {}
    data[session_id] = data.get(session_id, 0) + 1
    data = dict(list(data.items())[-50:])
    try:
        with open(path, "w") as fh:
            json.dump(data, fh)
    except OSError:
        pass
    return data[session_id]


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
        if source == "clear" and os.environ.get("LEAN_AGENT_SERVICE_SESSION") == "1":
            return 0  # session_hook adds the brief (checkpoint first) there
        if source == "compact" or (source in ("startup", "clear") and has_recent_work()):
            text = handoff()
            if source == "compact" and count_compaction(event.get("session_id") or "?") >= 2:
                text += ("\nThis conversation has now compacted more than once. At the next good stopping point "
                         "(a topic done, no worker running), save open items with `lean-agent checkpoint` or "
                         "`lean-agent remember`, and suggest the user starts a fresh conversation (/clear): this "
                         "note carries everything over, and a fresh one is cheaper on every call.")
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never break compaction
        print(f"lean-agent compact hook error: {exc}", file=sys.stderr)
        sys.exit(0)
