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
import push_guard

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


URL = re.compile(r"\b(?:https?|ssh|git)://\S+|\bgit@\S+:\S+")
NUMBERS = re.compile(r"(?i)(?:\b(?:pr|pull request|pull|work item|workitem|issue|ticket|task)\s*[#!]?\s*\d+|[#!]\d+)")
BRANCHISH = re.compile(r"\b(?:feature|bugfix|hotfix|release|fix|chore|users?)/[\w./-]+")


def _private_terms():
    """[(slug, [paths], [branch names])] of the private projects."""
    out = []
    for slug, v in push_guard._projects().items():
        if not (v or {}).get("private"):
            continue
        path = v.get("path") or ""
        paths = [x for x in {path, os.path.realpath(path) if path else "",
                             os.path.join(push_guard.lean_home(), "worktrees", slug)} if x]
        branches = []
        if path:
            try:
                import subprocess
                r = subprocess.run(["git", "-C", path, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
                                   capture_output=True, text=True, timeout=5)
                branches = [b for b in r.stdout.split() if b not in ("main", "master", "develop") and len(b) > 3]
            except Exception:
                pass
        out.append((slug, sorted(paths, key=len, reverse=True), branches))
    return out


def redact(text, terms=None):
    """`text` with private projects taken out: the name becomes "<private project>"; paths, and (when it mentions the
    project) URLs, branch names and PR/work-item numbers, become "<redacted>"."""
    text = str(text or "")
    for slug, paths, branches in _private_terms() if terms is None else terms:
        if slug.lower() not in text.lower() and not any(p in text for p in paths):
            continue
        for p in paths:
            text = text.replace(p, "<redacted>")
        for b in sorted(branches, key=len, reverse=True):
            text = text.replace(b, "<redacted>")
        text = URL.sub("<redacted>", text)
        text = BRANCHISH.sub("<redacted>", text)
        text = NUMBERS.sub("<redacted>", text)
        text = re.sub(re.escape(slug), "<private project>", text, flags=re.I)
    return text


def redact_item(item, terms=None):
    """(the item with private content redacted, whether anything changed)."""
    terms = _private_terms() if terms is None else terms
    if not terms:
        return item, False
    out = dict(item)
    for k in ("text", "repro"):
        out[k] = redact(item.get(k), terms)
    out["recent"] = [redact(c, terms) for c in item.get("recent") or []]
    return out, out != item


def scrub(text):
    """`text` without environment values (NAME=value -> NAME=), anything token-like and private projects."""
    text = ENV_ASSIGN.sub(lambda m: m.group(1) + "=", str(text or ""))
    return redact(SECRET.sub("<redacted>", text))


def thread():
    """The thread session recording this, else "main": the session's identity, not the thread tag of the request."""
    tid = os.environ.get("LEAN_AGENT_THREAD") or ""
    return tid if os.environ.get("LEAN_AGENT_SESSION_ROLE") == "thread" and tid else "main"


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


def is_pipe_error(exc):
    """A closed output pipe (BrokenPipeError, EPIPE), also as the cause of another exception: never a crash."""
    seen = 0
    while exc is not None and seen < 8:
        if isinstance(exc, BrokenPipeError) or (isinstance(exc, OSError) and exc.errno == 32):
            return True
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return False


def install_excepthooks():
    """sys.excepthook and threading.excepthook that stay silent about a closed pipe (a thread or exit handler that
    writes after main() returned) and delegate everything else to the previous hook."""
    import sys
    import threading
    prev_sys, prev_thr = sys.excepthook, threading.excepthook

    def sys_hook(etype, value, tb):
        if not is_pipe_error(value):
            prev_sys(etype, value, tb)

    def thread_hook(args):
        if not is_pipe_error(args.exc_value):
            prev_thr(args)
    sys.excepthook, threading.excepthook = sys_hook, thread_hook


def record_crash(argv, exc):
    """A `bug` entry for a command that ended in an uncaught exception. Never raises."""
    if is_pipe_error(exc):
        return
    try:
        line = f"{type(exc).__name__}: {' '.join(str(exc).split())[:200]}"
        cmd = scrub("lean-agent " + " ".join(argv))[:300]
        add(f"crash: {line}", kind="bug", severity="high", repro=cmd)
    except Exception:
        pass


def _since(items, since):
    return [i for i in items if str(i.get("ts", ""))[:10] >= since] if since else items


def _version_key(i):
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.\-+]", str(i.get("version", "")))[:4])


def list_items(include_all=False, kind=None, since=None):
    """Open items (not done) by default, all with include_all."""
    items = [i for i in _load() if (include_all or i.get("status") != "done") and (not kind or i.get("kind") == kind)]
    return [redact_item(i)[0] for i in _since(items, since)]


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
    terms, n_red, shown = _private_terms(), 0, []
    for i in chosen:
        r, changed = redact_item(i, terms)
        shown.append(r)
        marked = "<private project>" in json.dumps([r.get("text"), r.get("repro"), r.get("recent")])
        n_red += 1 if changed or marked else 0
    chosen = shown
    n_done = sum(1 for i in items if i.get("status") == "done")
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
             (f"- Items: {len(chosen) - sum(1 for i in chosen if i.get('status') == 'done')} open items, "
              f"{sum(1 for i in chosen if i.get('status') == 'done')} done (marked as such)" if include_all else
              f"- Items: {len(chosen)} open items ({n_done} done not included; --all to include)"), ""]
    if n_red:
        lines.insert(-1, f"- {n_red} items redacted (private projects)")
    titles = {"bug": "Bugs", "friction": "Friction", "idea": "Ideas", "praise": "Praise"}
    for kind in KINDS:
        group = sorted((i for i in chosen if i.get("kind") == kind),
                       key=lambda i: (tuple(-x for x in _version_key(i)), -SEVERITIES.index(i.get("severity", "normal")), i.get("ts", "")))
        if not group:
            continue
        lines += [f"## {titles[kind]}", ""]
        for i in group:
            lines += [f"### {i['id']} [{i.get('severity', 'normal')}]{' (done)' if i.get('status') == 'done' else ''} {i['text']}", "",
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
        if i["id"] in ids and i.get("status") != "done":
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
