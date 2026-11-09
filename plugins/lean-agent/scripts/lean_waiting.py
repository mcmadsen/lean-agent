"""What waits on the user, kept in <home>/waiting.json so the front desk does not depend on its memory.

An entry: {id, kind: review|question|permission|other, thread, ref, summary, options, created, asked_at, answered_at}.
Entries are added by lean-agent itself (a finished review whose verdict needs a vote or posting, `thread ask`, a thread's
needs-you report) or with `lean-agent waiting add`. The Stop hook of the front desk reads them: an open entry not yet asked
with AskUserQuestion sends the turn back once."""
import datetime
import time

import lean_common

KINDS = ("review", "question", "permission", "push", "auth", "other")
DEFAULT_OPTIONS = {
    "review": ["Approve", "Approve with suggestions (post the nit)", "Wait for author", "No vote"],
    "question": ["Other"],
    "permission": ["Yes", "No"],
    "push": ["Push", "Push and post", "Post only", "Hold"],
    "auth": ["Signed in"],
    "other": [],
}
KEEP = 100
RECENT_MIN = 30  # minutes: a question answered or asked this recently is not raised or asked again


def path():
    return lean_common.lean_home("waiting.json")


def _load():
    data = lean_common.read_json(path(), {})
    items = data.get("items") if isinstance(data, dict) else None
    return [i for i in items or [] if isinstance(i, dict)]


def norm(text):
    """Question text compared for de-duplication: case, punctuation and spacing ignored."""
    return " ".join("".join(c if c.isalnum() else " " for c in str(text or "").lower()).split())


def _within(iso, minutes):
    try:
        return (datetime.datetime.now() - datetime.datetime.fromisoformat(str(iso))).total_seconds() <= minutes * 60
    except ValueError:
        return False


def add(summary, kind="other", options=None, thread="", ref="", qid=""):
    """Record one waiting item; an open item with the same kind, thread and normalised summary is not added twice
    (its count goes up instead); returns its id."""
    kind = kind if kind in KINDS else "other"
    summary = " ".join(str(summary or "").split())[:300]
    opts = [str(o).strip() for o in (options if options is not None else DEFAULT_OPTIONS[kind]) if str(o).strip()]
    with lean_common.file_lock(path()):
        items = _load()
        if kind == "push" and ref:  # one push question per goal: a newer report of the same ref replaces the open one
            for i in items:
                if not i.get("answered_at") and i.get("kind") == "push" and norm(i.get("ref")) == norm(ref):
                    i.update(summary=summary, options=opts, thread=thread or i.get("thread", ""))
                    i["count"] = int(i.get("count") or 1) + 1
                    lean_common.write_json_atomic(path(), {"items": items})
                    return i["id"]
        for i in items:
            if not i.get("answered_at") and (i.get("kind"), i.get("thread"), norm(i.get("summary"))) == (kind, thread or "", norm(summary)):
                i["count"] = int(i.get("count") or 1) + 1
                lean_common.write_json_atomic(path(), {"items": items})
                return i["id"]
        for i in items:  # answered a moment ago: the same question reported again is the stale copy of that one
            if kind != "auth" and i.get("answered_at") and (i.get("kind"), i.get("thread"), norm(i.get("summary"))) == (kind, thread or "", norm(summary)) \
                    and _within(i["answered_at"], RECENT_MIN):
                return i["id"]
        nid = "w%d" % (max([int(str(i.get("id", "w0"))[1:] or 0) for i in items if str(i.get("id", "")).startswith("w")] + [0]) + 1)
        items.append({"id": nid, "kind": kind, "thread": thread or "", "ref": ref or "", "summary": summary, "options": opts, "qid": qid or "", "count": 1,
                      "created": lean_common.now_iso(), "asked_at": "", "answered_at": ""})
        lean_common.write_json_atomic(path(), {"items": items[-KEEP:]})
    return nid


def open_items():
    return [i for i in _load() if not i.get("answered_at")]


def unasked():
    """Open items the hook still has to ask: not asked, or asked so long ago that no answer came is not assumed here."""
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
    if field == "answered_at":
        for i in items:
            if i["id"] in done and i.get("kind") == "push" and i.get("thread"):
                try:  # the goal behind a push question is the thread's again
                    import lean_goals
                    lean_goals.answered(i["thread"])
                except Exception:
                    pass
    return done


def close_for(thread, qids, answer=None):
    """Mark done the open items of `thread` raised by one of the question ids `qids`; returns their ids."""
    ids = set()
    with lean_common.file_lock(path()):
        items = _load()
        for i in items:
            if not i.get("answered_at") and i.get("thread") == thread and i.get("qid") in qids:
                ids.add(i["id"])
    return _mark("answered_at", ids, answer) if ids else []


def recent(minutes=RECENT_MIN):
    """Items asked or answered within the last `minutes`: the Stop hook does not send the turn back for these."""
    return [i for i in _load() if _within(i.get("answered_at") or "", minutes) or _within(i.get("asked_at") or "", minutes)]


def answered_by(questions, answer):
    """The user answered AskUserQuestion `questions` (texts) with `answer`: the open items they cover (by id or by
    summary; when none can be matched, every open one) are marked asked and answered. Returns their ids."""
    blob = norm(" ".join(questions))
    opened = open_items()
    hit = [i["id"] for i in opened if norm(i.get("id")) in blob.split() or (norm(i.get("summary"))[:40] and norm(i.get("summary"))[:40] in blob)]
    ids = set(hit or [i["id"] for i in opened])
    _mark("asked_at", ids)
    return _mark("answered_at", ids, answer)


def mark_asked(ids=None):
    """Set asked_at on the open items `ids` (all open items when None)."""
    return _mark("asked_at", ids)


def mark_repushed(wid):
    """Remember that open item `wid` was pushed to main a second time (done once per item)."""
    return _mark("repushed", {wid})


def done(wid, answer=None):
    return bool(_mark("answered_at", {wid}, answer))


def line(i):
    opts = " | ".join(i.get("options") or [])
    return (f"{i['id']} {i.get('kind')}" + (f" {i['thread']}" if i.get("thread") else "") + (f" {i['ref']}" if i.get("ref") else "")
            + f": {i.get('summary')}" + (f" [options: {opts}]" if opts else "") + (f" (reported {i['count']}x)" if int(i.get("count") or 1) > 1 else "") + ("" if i.get("asked_at") else " (not asked yet)"))


def text():
    """The open items for `waiting` and the top of `now`, or ''."""
    items = open_items()
    return "\n".join(["Waiting on you:"] + ["  " + line(i) for i in items]) if items else ""
