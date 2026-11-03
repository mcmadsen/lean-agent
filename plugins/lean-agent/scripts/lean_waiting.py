"""What waits on the user, kept in <home>/waiting.json so the front desk does not depend on its memory.

An entry: {id, kind: review|question|permission|other, thread, ref, summary, options, created, asked_at, answered_at}.
Entries are added by lean-agent itself (a finished review whose verdict needs a vote or posting, `thread ask`, a thread's
needs-you report) or with `lean-agent waiting add`. The Stop hook of the front desk reads them: an open entry not yet asked
with AskUserQuestion sends the turn back once."""
import time

import lean_common

KINDS = ("review", "question", "permission", "other")
DEFAULT_OPTIONS = {
    "review": ["Approve", "Approve with suggestions (post the nit)", "Wait for author", "No vote"],
    "question": ["Other"],
    "permission": ["Yes", "No"],
    "other": [],
}
KEEP = 100


def path():
    return lean_common.lean_home("waiting.json")


def _load():
    data = lean_common.read_json(path(), {})
    items = data.get("items") if isinstance(data, dict) else None
    return [i for i in items or [] if isinstance(i, dict)]


def add(summary, kind="other", options=None, thread="", ref=""):
    """Record one waiting item (an open item with the same kind, thread and summary is not added twice); returns its id."""
    kind = kind if kind in KINDS else "other"
    summary = " ".join(str(summary or "").split())[:300]
    opts = [str(o).strip() for o in (options if options is not None else DEFAULT_OPTIONS[kind]) if str(o).strip()]
    with lean_common.file_lock(path()):
        items = _load()
        for i in items:
            if not i.get("answered_at") and (i.get("kind"), i.get("thread"), i.get("summary")) == (kind, thread or "", summary):
                return i["id"]
        nid = "w%d" % (max([int(str(i.get("id", "w0"))[1:] or 0) for i in items if str(i.get("id", "")).startswith("w")] + [0]) + 1)
        items.append({"id": nid, "kind": kind, "thread": thread or "", "ref": ref or "", "summary": summary, "options": opts,
                      "created": lean_common.now_iso(), "asked_at": "", "answered_at": ""})
        lean_common.write_json_atomic(path(), {"items": items[-KEEP:]})
    return nid


def open_items():
    return [i for i in _load() if not i.get("answered_at")]


def unasked():
    return [i for i in open_items() if not i.get("asked_at")]


def _mark(field, ids, answer=None):
    done = []
    with lean_common.file_lock(path()):
        items = _load()
        for i in items:
            if i.get("answered_at") or (ids is not None and i.get("id") not in ids):
                continue
            i[field] = lean_common.now_iso()
            if answer is not None:
                i["answer"] = answer
            done.append(i["id"])
        if done:
            lean_common.write_json_atomic(path(), {"items": items})
    return done


def mark_asked(ids=None):
    """Set asked_at on the open items `ids` (all open items when None)."""
    return _mark("asked_at", ids)


def done(wid, answer=None):
    return bool(_mark("answered_at", {wid}, answer))


def line(i):
    opts = " | ".join(i.get("options") or [])
    return (f"{i['id']} {i.get('kind')}" + (f" {i['thread']}" if i.get("thread") else "") + (f" {i['ref']}" if i.get("ref") else "")
            + f": {i.get('summary')}" + (f" [options: {opts}]" if opts else "") + ("" if i.get("asked_at") else " (not asked yet)"))


def text():
    """The open items for `waiting` and the top of `now`, or ''."""
    items = open_items()
    return "\n".join(["Waiting on you:"] + ["  " + line(i) for i in items]) if items else ""
