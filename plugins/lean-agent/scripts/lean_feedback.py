"""Feedback about lean-agent itself (bugs, friction, ideas, praise), kept in <home>/feedback/feedback.jsonl.

A thread records one with `lean-agent feedback add`; a crashing command records a `bug` by itself. The front desk
exports the open ones as a Markdown file for the lean-agent developer. Only what was recorded goes into it."""
import datetime
import difflib
import json
import os
import re
import sys

import lean_common

KINDS = ("bug", "friction", "idea", "praise")
SEVERITIES = ("low", "normal", "high")
SIMILAR = 0.85  # text ratio from which two entries of one kind and version count as the same
RECENT_KEEP = 5
OFFER_THRESHOLD = 5
SECRET = re.compile(r"(?i)\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[a-z]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{15,}"
                    r"|AKIA[0-9A-Z]{12,}|Bearer\s+\S+)|\b[A-Za-z0-9+/_=-]{32,}\b")
ENV_ASSIGN = re.compile(r"\b([A-Z][A-Z0-9_]{2,})=(\S+)")


def folder(*parts):
    return lean_common.lean_home("feedback", *parts)


def scrub(text):
    """`text` without environment values (NAME=value -> NAME=) and anything token-like."""
    text = ENV_ASSIGN.sub(lambda m: m.group(1) + "=", str(text or ""))
    return SECRET.sub("<redacted>", text)


def thread():
    return os.environ.get("LEAN_AGENT_CALLER_THREAD") or "main"


def _load():
    items = []
    try:
        with open(folder("feedback.jsonl"), encoding="utf-8") as fh:
            for line in fh:
                try:
                    items.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return items


def _save(items):
    os.makedirs(folder(), exist_ok=True)
    tmp = folder("feedback.jsonl.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        for it in items:
            fh.write(json.dumps(it, ensure_ascii=False) + "\n")
    os.replace(tmp, folder("feedback.jsonl"))


def _norm(text):
    return " ".join(re.sub(r"\W+", " ", str(text).lower()).split())


def remember_command(argv):
    """Keeps the last few lean-agent commands of this thread (scrubbed), for the next feedback entry."""
    if not argv or argv[0] == "feedback":
        return
    path = folder("recent-%s.json" % re.sub(r"\W", "_", thread()))
    try:
        rows = lean_common.read_json(path, [])
        rows = (rows if isinstance(rows, list) else [])[-(RECENT_KEEP - 1):] + [scrub("lean-agent " + " ".join(argv))[:200]]
        os.makedirs(folder(), exist_ok=True)
        lean_common.write_json_atomic(path, rows)
    except OSError:
        pass


def recent():
    rows = lean_common.read_json(folder("recent-%s.json" % re.sub(r"\W", "_", thread())), [])
    return rows if isinstance(rows, list) else []


def add(text, kind="friction", severity="normal", repro="", commands=None):
    """Records one entry (or bumps the count of a near-duplicate). Returns (id, added)."""
    text, repro = scrub(" ".join(str(text).split())), scrub(repro or "")
    version = lean_common.plugin_version()
    with lean_common.file_lock(folder("feedback.jsonl")):
        items = _load()
        for it in items:
            if it.get("kind") == kind and it.get("version") == version and it.get("status") != "done" and \
                    difflib.SequenceMatcher(None, _norm(it.get("text")), _norm(text)).ratio() >= SIMILAR:
                it["count"] = it.get("count", 1) + 1
                if SEVERITIES.index(severity) > SEVERITIES.index(it.get("severity", "normal")):
                    it["severity"] = severity
                _save(items)
                return it["id"], False
        n = max([int(str(i.get("id", "f0"))[1:] or 0) for i in items] + [0]) + 1
        items.append({"id": f"f{n}", "ts": lean_common.now_iso(), "thread": thread(), "version": version, "kind": kind,
                      "severity": severity, "text": text, "repro": repro, "count": 1, "status": "open",
                      "recent": [scrub(c) for c in (recent() if commands is None else commands)][-RECENT_KEEP:]})
        _save(items)
        return f"f{n}", True


def record_crash(argv, exc):
    """A `bug` entry for a command that ended in an uncaught exception. Never raises."""
    try:
        line = f"{type(exc).__name__}: {' '.join(str(exc).split())[:200]}"
        cmd = scrub("lean-agent " + " ".join(argv))[:300]
        add(f"crash: {line}", kind="bug", severity="high", repro=cmd)
    except Exception:
        pass


def _since(items, since):
    return [i for i in items if str(i.get("ts", ""))[:10] >= since] if since else items


def list_items(open_only=False, kind=None, since=None):
    items = [i for i in _load() if (not open_only or i.get("status") == "open") and (not kind or i.get("kind") == kind)]
    return _since(items, since)


def table(items):
    rows = [("id", "kind", "sev", "count", "thread", "version", "text")] + \
        [(i["id"], i["kind"], i.get("severity", "normal"), str(i.get("count", 1)), i.get("thread", "main"),
          i.get("version", "?"), i["text"][:100]) for i in items]
    widths = [max(len(r[c]) for r in rows) for c in range(6)]
    return "\n".join(" | ".join([r[c].ljust(widths[c]) for c in range(6)] + [r[6]]) for r in rows)


def mark(fid, status):
    """Sets the status of fN ('done'), or removes it (None). Returns False when there is no such entry."""
    items = _load()
    hit = [i for i in items if i.get("id") == fid]
    if not hit:
        return False
    if status is None:
        items.remove(hit[0])
    else:
        hit[0]["status"] = status
    _save(items)
    return True


def counts():
    """(open, open high-severity) for `now`."""
    op = [i for i in _load() if i.get("status") == "open"]
    return len(op), sum(1 for i in op if i.get("severity") == "high")


def export(include_all=False, out=None, today=None):
    """Writes the Markdown file; returns (path, n)."""
    items = _load()
    chosen = [i for i in items if include_all or i.get("status") == "open"]
    today = today or datetime.date.today().isoformat()
    if not out:
        base = folder(f"feedback-{today}")
        out, n = base + ".md", 2
        while os.path.exists(out):
            out, n = f"{base}-{n}.md", n + 1
    dates = sorted(str(i.get("ts", ""))[:10] for i in chosen)
    versions = sorted({i.get("version", "?") for i in chosen}) or [lean_common.plugin_version()]
    lines = ["# Feedback for lean-agent", "",
             f"- Version: {', '.join(versions)}",
             f"- Dates: {dates[0]} to {dates[-1]}" if dates else f"- Dates: {today}",
             f"- Items: {len(chosen)}", ""]
    titles = {"bug": "Bugs", "friction": "Friction", "idea": "Ideas", "praise": "Praise"}
    for kind in KINDS:
        group = sorted((i for i in chosen if i.get("kind") == kind),
                       key=lambda i: (-SEVERITIES.index(i.get("severity", "normal")), i.get("ts", "")))
        if not group:
            continue
        lines += [f"## {titles[kind]}", ""]
        for i in group:
            lines += [f"### {i['id']} [{i.get('severity', 'normal')}] {i['text']}", "",
                      f"- Count: {i.get('count', 1)}", f"- Thread: {i.get('thread', 'main')}",
                      f"- Version: {i.get('version', '?')}"]
            if i.get("repro"):
                lines += ["- Repro:", "", "```", i["repro"], "```"]
            if i.get("recent"):
                lines += ["- Last commands:", "", "```", *i["recent"], "```"]
            lines.append("")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    ids = {i["id"] for i in chosen}
    name = os.path.basename(out)
    for i in items:
        if i["id"] in ids:
            i["status"], i["exported"] = "exported", name
    _save(items)
    return out, len(chosen)


def offer_due(now=None):
    """True when 5+ items are open (or a high-severity bug is) and no offer was made today; marks the offer."""
    items = [i for i in _load() if i.get("status") == "open"]
    if not (len(items) >= OFFER_THRESHOLD or any(i.get("kind") == "bug" and i.get("severity") == "high" for i in items)):
        return 0
    today = (now or datetime.date.today()).isoformat()
    marker = folder("last-offer")
    try:
        with open(marker) as fh:
            if fh.read().strip() == today:
                return 0
    except OSError:
        pass
    os.makedirs(folder(), exist_ok=True)
    with open(marker, "w") as fh:
        fh.write(today)
    return len(items)
