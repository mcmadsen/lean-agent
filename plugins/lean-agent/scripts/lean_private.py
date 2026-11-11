"""Private projects, global switch (0.45.53): `lean-agent private off` hides every private project and its items
(threads, sessions, runs, goals, waiting items, reports); `private on` (the default) shows them again. Nothing is ever
deleted. Stdlib + lean_common only, so every script can import it."""
import json
import os
import time

import lean_common

HELD_MSG = "private projects are hidden: lean-agent private on"
STOPPED_BY = "stopped by private off"


def hidden():
    """True while private mode is off (private projects and their items are not shown)."""
    cfg = lean_common.read_json(lean_common.lean_home("config.json"), {})
    return isinstance(cfg, dict) and cfg.get("private") == "off"


def set_hidden(off):
    path = lean_common.lean_home("config.json")
    cfg = lean_common.read_json(path, {})
    cfg = cfg if isinstance(cfg, dict) else {}
    if off:
        cfg["private"] = "off"
    else:
        cfg.pop("private", None)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lean_common.write_json_atomic(path, cfg)


def private_slugs():
    projs = lean_common.read_json(lean_common.lean_home("projects.json"), {})
    return {k for k, v in (projs.items() if isinstance(projs, dict) else []) if isinstance(v, dict) and v.get("private")}


def _jsonl(path, tail=5000):
    out = []
    try:
        with open(path) as fh:
            for line in fh.readlines()[-tail:]:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict):
                    out.append(r)
    except OSError:
        pass
    return out


def thread_projects(tid, data=None):
    """The projects a thread's runs and worktrees are in (not its own tag)."""
    out = set()
    for r in _jsonl(lean_common.lean_home("ledger.jsonl")):
        if r.get("thread") == tid and r.get("project"):
            out.add(r["project"])
    wts = lean_common.read_json(lean_common.lean_home("worktrees.json"), {})
    for slug, entries in (wts.items() if isinstance(wts, dict) else []):
        for e in (entries.values() if isinstance(entries, dict) else []):
            if isinstance(e, dict) and e.get("thread") == tid:
                out.add(slug)
    return out


def thread_is_private(tid, data=None, priv=None):
    """A thread is private when its project tag is private, or when it has runs/worktrees and all are in private projects."""
    priv = private_slugs() if priv is None else priv
    if not priv or not tid:
        return False
    if data is None:
        data = lean_common.read_json(lean_common.lean_home("threads.json"), {})
    t = (data.get("threads") or {}).get((data.get("aliases") or {}).get(tid, tid)) or {}
    if t.get("project") in priv:
        return True
    projs = thread_projects(t.get("id") or tid, data)
    return bool(projs) and projs <= priv


def is_private_item(item=None, project=None, thread=None, ref=None, data=None):
    """True when the item belongs to a private project (whatever the switch says; see `hides`): an explicit `project`, a
    record with a "project" (run, worktree, thread tag), a "thread" that is private, or a goal `ref` naming a private project."""
    priv = private_slugs()
    if not priv:
        return False
    item = item if isinstance(item, dict) else {}
    project = project or item.get("project")
    thread = thread or item.get("thread") or (item.get("id") if str(item.get("id") or "").startswith("t") and "title" in item else None)
    if project and project in priv:
        return True
    if thread and thread_is_private(thread, data, priv):
        return True
    ref = ref or item.get("ref")
    return bool(ref) and any(str(ref).startswith(p + "#") or str(ref).startswith(p + ":") for p in priv)


def hides(item=None, **kw):
    """is_private_item while private mode is off: what listings leave out."""
    return hidden() and is_private_item(item, **kw)


def mentions_private(text):
    """The private project a message clearly mentions (its name as a whole word), else None."""
    import re
    low = str(text or "").lower()
    return next((p for p in sorted(private_slugs()) if re.search(r"(?<![\w-])" + re.escape(p.lower()) + r"(?![\w-])", low)), None)


def stopped_path():
    return lean_common.lean_home("private-stopped.json")


def read_stopped():
    d = lean_common.read_json(stopped_path(), [])
    return [str(x) for x in d] if isinstance(d, list) else []


def write_stopped(ids):
    lean_common.write_json_atomic(stopped_path(), sorted(set(ids)))


def clean_threads(rows, key=None):
    """`rows` without the hidden ones (key: row -> thread id or item)."""
    if not hidden():
        return rows
    return [r for r in rows if not is_private_item(r if key is None else None, thread=key(r) if key else None)]
