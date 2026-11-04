"""The goals the front desk owns, kept in <home>/goals.json so that following every deliverable to the end does not
depend on the model remembering it.

A goal: {id g<N>, ref, thread, target, state, next, last_activity, chased_at, chase_count, created}. State is active,
waiting-user (a final report proposes a push/post and the user has the question), stuck (chased 3 times without an
answer; the user has a question), done or dropped. Goals are created when a thread starts work on a reference, kept
fresh by thread reports and runs, and watched by `watchdog`, which the service runs every few minutes: it only sends
messages to threads (the thread does the work) and tells the front desk what it did."""
import datetime
import os
import re
import time

import lean_common
import lean_find
import lean_waiting

OPEN = ("active", "waiting-user", "stuck")
STATES = OPEN + ("done", "dropped")
DEFAULT_TARGET = "pushed+posted"
QUIET_MIN = 30        # minutes without activity before a thread is nudged (config goal-quiet)
MAX_CHASES = 3
KEEP = 200
PUSH_OPTIONS = ["Push", "Push and post", "Post only", "Hold"]
STUCK_OPTIONS = ["Restart the worker", "Ask for the final report", "Drop the goal", "Other"]


def path():
    return lean_common.lean_home("goals.json")


def _load():
    data = lean_common.read_json(path(), {})
    items = data.get("items") if isinstance(data, dict) else None
    return [g for g in items or [] if isinstance(g, dict)]


def _save(items):
    lean_common.write_json_atomic(path(), {"items": items[-KEEP:]})


def _epoch(iso):
    try:
        return datetime.datetime.fromisoformat(str(iso)).timestamp()
    except ValueError:
        return 0.0


def _iso(epoch):
    return datetime.datetime.fromtimestamp(epoch).isoformat(timespec="seconds")


def quiet_minutes():
    for v in (os.environ.get("LEAN_AGENT_GOAL_QUIET"), (lean_common.read_json(lean_common.lean_home("config.json"), {}) or {}).get("goal_quiet")):
        m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([mh]?)\s*", str(v or ""))
        if m and float(m.group(1)) > 0:
            return float(m.group(1)) * (60 if m.group(2) == "h" else 1)
    return QUIET_MIN


# -- references
def key_of(ref):
    """Same deliverable, same key: PR 512, #512 and !512 are one; work items and branches have their own."""
    for kind, v in lean_find.prompt_references(ref):
        if kind in ("pr", "hash", "num"):
            return "n" + v
        if kind == "item":
            return "i" + v
        if kind == "branch":
            return "b" + v.lower()
    return "t" + " ".join(str(ref or "").lower().split())


def ref_in(text, branches=False):
    """The first deliverable a text names (PR, work item, #number; a branch when asked), as a label, or ''."""
    for kind, v in lean_find.prompt_references(text):
        if kind in ("pr", "item", "hash") or (branches and kind == "branch"):
            return lean_find.reference_label(kind, v)
    return ""


# -- the store
def _find(items, ref, thread=None):
    k = key_of(ref)
    return next((g for g in items if g.get("state") in OPEN and key_of(g.get("ref")) == k and (thread is None or g.get("thread") in ("", thread))), None)


def _new_id(items):
    return "g%d" % (max([int(str(g.get("id", "g0"))[1:] or 0) for g in items if re.fullmatch(r"g\d+", str(g.get("id", "")))] + [0]) + 1)


def ensure(ref, thread, target=DEFAULT_TARGET, nxt=""):
    """The open goal for `ref` (created when none), owned by `thread`; its activity is now. Returns its id ('' without a ref)."""
    ref = " ".join(str(ref or "").split())[:120]
    if not ref:
        return ""
    now = lean_common.now_iso()
    with lean_common.file_lock(path()):
        items = _load()
        g = _find(items, ref)
        if g is None:
            g = {"id": _new_id(items), "ref": ref, "thread": thread or "", "target": target, "state": "active", "next": nxt,
                 "last_activity": now, "chased_at": "", "chase_count": 0, "created": now}
            items.append(g)
        else:
            if thread and g.get("thread") != thread:
                g["thread"] = thread
            g["last_activity"] = now
        _save(items)
    return g["id"]


def note_text(text, thread):
    """A thread was given work naming a PR/work item: that is a goal. Returns the goal id or ''."""
    ref = ref_in(text)
    return ensure(ref, thread) if ref and thread else ""


def touch(thread, reset=False):
    """A thread report or run: its open goals are active now (a report also clears the chase count)."""
    now = lean_common.now_iso()
    with lean_common.file_lock(path()):
        items = _load()
        hit = [g for g in items if g.get("thread") == thread and g.get("state") in OPEN]
        for g in hit:
            g["last_activity"] = now
            if reset:
                g["chase_count"] = 0
                if g["state"] == "stuck":
                    g["state"] = "active"
        if hit:
            _save(items)
    return [g["id"] for g in hit]


def _set(gid, **fields):
    with lean_common.file_lock(path()):
        items = _load()
        g = next((x for x in items if x.get("id") == gid), None)
        if g is None:
            return False
        g.update(fields)
        _save(items)
    return True


def add(ref, thread="", target=DEFAULT_TARGET):
    return ensure(ref, thread, target)


def done(gid):
    return _set(gid, state="done")


def drop(gid):
    return _set(gid, state="dropped")


def set_next(gid, text):
    return _set(gid, next=" ".join(str(text or "").split())[:200])


def open_goals():
    return [g for g in _load() if g.get("state") in OPEN]


def answered(thread):
    """The user answered the push/post question of a thread: its waiting goals are active again (done once the push or
    post happened, which the thread reports; `goal done` closes one by hand)."""
    with lean_common.file_lock(path()):
        items = _load()
        hit = [g for g in items if g.get("thread") == thread and g.get("state") == "waiting-user"]
        for g in hit:
            g["state"], g["last_activity"], g["answered_at"] = "active", lean_common.now_iso(), lean_common.now_iso()
        if hit:
            _save(items)
    return [g["id"] for g in hit]


def finished(thread, text):
    """A thread report says the push/post happened ('pushed', 'posted' ... as a done report after the user answered)."""
    if not re.search(r"\b(pushed|posted|merged|answered)\b", str(text or ""), re.I):
        return []
    with lean_common.file_lock(path()):
        items = _load()
        hit = [g for g in items if g.get("thread") == thread and g.get("state") == "active" and g.get("answered_at")]
        for g in hit:
            g["state"] = "done"
        if hit:
            _save(items)
    return [g["id"] for g in hit]


# -- the consolidated final report
FIELD_RE = re.compile(r"^\W*(ref|head(?: sha)?|review|checks|what'?s left|left|proposed action)\W*:\s*(.+)$", re.I | re.M)


def parse_final(text):
    """{ref, head, review, checks, left, action} of a consolidated final report (a `Ref:` and a `Proposed action:`
    line at least), else None."""
    got = {}
    for k, v in FIELD_RE.findall(str(text or "")):
        k = k.lower()
        k = {"head sha": "head", "what's left": "left", "whats left": "left", "proposed action": "action"}.get(k, k)
        got.setdefault(k, v.strip())
    return got if got.get("ref") and got.get("action") else None


def final_report(thread, text):
    """A thread's consolidated final report: the goal waits on the user, with ONE push question for it. Returns the
    waiting item id or ''."""
    rep = parse_final(text)
    if not rep:
        return ""
    gid = ensure(rep["ref"], thread)
    with lean_common.file_lock(path()):
        items = _load()
        for g in items:
            if g["id"] == gid:
                g["state"], g["next"] = "waiting-user", ("answer: " + rep["action"])[:200]
        _save(items)
    summary = f"{rep['ref']} ({thread}): proposed {rep['action']}" + "".join(
        f"; {k} {rep[k]}" for k in ("head", "review", "checks", "left") if rep.get(k))
    return lean_waiting.add(summary, "push", PUSH_OPTIONS, thread, rep["ref"])


# -- views
def quiet_text(g, now=None):
    now = time.time() if now is None else now
    s = max(0, now - (_epoch(g.get("last_activity")) or _epoch(g.get("created"))))
    return f"{int(s // 86400)}d" if s >= 86400 else f"{int(s // 3600)}h" if s >= 3600 else f"{int(s // 60)}m"


def table(now=None):
    goals = open_goals()
    if not goals:
        return ""
    rows = [("Goal", "Ref", "Thread", "State", "Quiet", "Next")] + [
        (g["id"], g.get("ref", ""), g.get("thread") or "-", g["state"] + (f" ({g['chase_count']} chases)" if g.get("chase_count") else ""),
         quiet_text(g, now), g.get("next") or f"target: {g.get('target')}") for g in goals]
    w = [max(len(r[i]) for r in rows) for i in range(5)]
    return "\n".join("  ".join(r[i].ljust(w[i]) for i in range(5)) + "  " + r[5] for r in rows)


def now_text(now=None):
    t = table(now)
    return ("Goals (the front desk owns them):\n" + t) if t else ""


# -- the watchdog
def limit_near():
    """The plan limit is near: no chase then (it would only spend what is left)."""
    try:
        import usage
        return bool(usage.session_pressure()[1] or usage.exhausted_window())
    except Exception:
        return False


def thread_info(tid, data=None):
    """What the watchdog needs of a thread: lost worker, running workers, an open question, last activity (epoch)."""
    import lean_threads
    data = data or lean_threads.load()
    t = data["threads"].get(tid) or {}
    lost = [(rid, m) for rid, m in lean_common.lost_runs(lean_common.lean_home()) if lean_threads.thread_of_run(m, data) == tid]
    last = lean_threads._epoch(t.get("last_message") or t.get("created"))
    try:
        for e in lean_threads.events(data, lean_threads._todo_map()).get(tid, []):
            last = max(last, lean_threads._epoch(e[1]))
    except Exception:
        pass
    return {"lost": lost, "running": lean_threads.running_by_thread(data).get(tid, []),
            "question": bool(lean_threads.open_questions(t)), "last": last}


def lost_message(run, ref):
    return (f"Your worker {run} for {ref} was lost. Resume it (`lean-agent run --resume {run} ...`) or restart it, "
            "then send ONE consolidated final report.")


def nudge_message(ref):
    return (f"Status check for {ref}: what is the state and the next step? If it is done, send ONE consolidated final report "
            "(Ref, head sha, review verdict + open findings, checks, what's left, proposed action).")


def watchdog(now, send, alive, info=thread_info, near=limit_near, log=None):
    """One pass over the active goals. `send(tid, text) -> (ok, err)` messages a thread (starting a parked one),
    `alive(tid)` says whether its session runs. Returns the digest lines (also logged)."""
    quiet = quiet_minutes() * 60
    digest = []
    with lean_common.file_lock(path()):
        items = _load()
        for g in items:
            if g.get("state") != "active" or not g.get("thread"):
                continue
            tid, ref = g["thread"], g.get("ref", "")
            i = info(tid)
            act = max(_epoch(g.get("last_activity")), _epoch(g.get("created")), i.get("last") or 0)
            since_chase = now - _epoch(g.get("chased_at")) if g.get("chased_at") else float("inf")
            lost = i.get("lost") or []
            if lost:
                due, why, msg = since_chase >= quiet, "worker lost", lost_message(lost[0][0], ref)
                how = "asked to resume"
            elif i.get("running") or i.get("question"):
                continue
            elif now - act >= quiet and since_chase >= quiet:
                parked = not alive(tid)
                due, why, msg = True, "session parked" if parked else "quiet", nudge_message(ref)
                how = "woken and asked for status" if parked else "asked for status"
            else:
                continue
            if not due:
                continue
            if near():
                if now - _epoch(g.get("limit_noted")) >= quiet:
                    g["limit_noted"] = _iso(now)
                    digest.append(f"no chase of {tid} ({ref}): plan limit is near")
                continue
            if int(g.get("chase_count") or 0) >= MAX_CHASES:
                g["state"], g["next"] = "stuck", f"stuck after {MAX_CHASES} chases"
                wid = lean_waiting.add(f"{tid} / {ref} is stuck after {MAX_CHASES} chases: what next?", "question", STUCK_OPTIONS, tid, ref)
                digest.append(f"{tid} ({ref}) is stuck after {MAX_CHASES} chases: asked the user ({wid})")
                continue
            try:
                ok, err = send(tid, msg)
            except Exception as exc:  # noqa: BLE001 - retried on a later pass
                ok, err = False, str(exc)
            if not ok:
                digest.append(f"chase of {tid} ({ref}) failed: {err}")
                continue
            g["chased_at"], g["chase_count"] = _iso(now), int(g.get("chase_count") or 0) + 1
            digest.append(f"chased {tid} ({ref}): {why} → {how}")
        if digest:
            _save(items)
    if log:
        for d in digest:
            log(d)
    return digest
