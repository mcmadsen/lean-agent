"""Private projects, global switch (0.45.53): `lean-agent private off` hides every private project and its items
(threads, sessions, runs, goals, waiting items, reports); `private on` (the default) shows them again. Nothing is ever
deleted. Stdlib + lean_common only, so every script can import it."""
import json
import os
import time

import lean_common

HELD_MSG = "private projects are hidden: lean-agent private on"
STOPPED_BY = "stopped by private off"


_CACHE = {}  # (path, builder) -> (signature, value): re-parsed only when the file's mtime/size/inode change (also in persistent processes)


def _sig(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size, st.st_ino)


def _cached(path, build):  # keyed by (path, builder): one file can feed several indexes
    """build(path) memoized per process, invalidated by the file's stat signature. Treat the value as read-only."""
    sig = _sig(path)
    key = (path, build)
    hit = _CACHE.get(key)
    if hit is not None and hit[0] == sig:
        return hit[1]
    val = build(path)
    if _sig(path) == sig:  # a file changing while it was read is not cached
        _CACHE[key] = (sig, val)
    else:
        _CACHE.pop(key, None)
    return val


def _read_json(path):
    return lean_common.read_json(path, {})


def _json(path):
    return _cached(path, _read_json)


def hidden():
    """True while private mode is off (private projects and their items are not shown)."""
    cfg = _json(lean_common.lean_home("config.json"))
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


def _private_set(path):
    projs = lean_common.read_json(path, {})
    return frozenset(k for k, v in (projs.items() if isinstance(projs, dict) else []) if isinstance(v, dict) and v.get("private"))


def private_slugs():
    return set(_cached(lean_common.lean_home("projects.json"), _private_set))


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


def _ledger_index(path):
    idx = {}
    for r in _jsonl(path):
        if r.get("thread") and r.get("project"):
            idx.setdefault(r["thread"], set()).add(r["project"])
    return idx


def _worktree_index(path):
    idx = {}
    wts = lean_common.read_json(path, {})
    for slug, entries in (wts.items() if isinstance(wts, dict) else []):
        for e in (entries.values() if isinstance(entries, dict) else []):
            if isinstance(e, dict) and e.get("thread"):
                idx.setdefault(e["thread"], set()).add(slug)
    return idx


def thread_projects(tid, data=None):
    """The projects a thread's runs and worktrees are in (not its own tag). The ledger and worktrees are parsed once
    per file change (not per call)."""
    out = set(_cached(lean_common.lean_home("ledger.jsonl"), _ledger_index).get(tid, ()))
    out |= _cached(lean_common.lean_home("worktrees.json"), _worktree_index).get(tid, set())
    return out


def thread_is_private(tid, data=None, priv=None):
    """A thread is private when its project tag is private, or when it has runs/worktrees and all are in private projects."""
    priv = private_slugs() if priv is None else priv
    if not priv or not tid:
        return False
    if data is None:
        data = _json(lean_common.lean_home("threads.json"))
    data = data if isinstance(data, dict) else {}
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
    """The private project a message clearly mentions (its name as a whole word, or a path inside its repo), else None."""
    import re
    low = str(text or "").lower()
    hit = next((p for p in sorted(private_slugs()) if re.search(r"(?<![\w-])" + re.escape(p.lower()) + r"(?![\w-])", low)), None)
    if hit:
        return hit
    projs = _json(lean_common.lean_home("projects.json"))
    for slug in sorted(private_slugs()):
        base = os.path.realpath((projs.get(slug) or {}).get("path") or "")
        if not base:
            continue
        for w in re.findall(r"[~/][^\s\"'`,;()]+", str(text or "")):
            real = os.path.realpath(os.path.expanduser(w))
            if real == base or real.startswith(base + os.sep):
                return slug
    return None


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
