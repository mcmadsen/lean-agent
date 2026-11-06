"""The goals the front desk owns, kept in <home>/goals.json so that following every deliverable to the end does not
depend on the model remembering it.

A goal: {id g<N>, ref, thread, target, state, next, last_activity, chased_at, chase_count, created}. State is active,
waiting-user (a final report proposes a push/post and the user has the question), stuck (chased 3 times without an
answer; the user has a question), done or dropped. Goals are created when a thread starts work on a reference, kept
fresh by thread reports and runs, and watched by `watchdog`, which the service runs every few minutes: it only sends
messages to threads (the thread does the work) and tells the front desk what it did."""
import datetime
import glob
import json
import os
import re
import time

import lean_common
import lean_find
import lean_waiting

OPEN = ("active", "waiting-user", "stuck", "blocked")
STATES = OPEN + ("done", "dropped")
DEFAULT_TARGET = "pushed+posted"
QUIET_MIN = 30        # minutes without activity before a thread is nudged (config goal-quiet)
MAX_CHASES = 3
CHASER_PER_HOUR = 6   # haiku decisions (batches) per hour (config chaser_per_hour)
LOG_KEEP = 300
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


def drop(gid, why=""):
    f = {"state": "dropped"}
    if why:
        f["next"] = " ".join(str(why).split())[:200]
    return _set(gid, **f)


def block(gid, on):
    """Marked blocked: listed, never chased, until unblocked or its blocker (a goal id) is done."""
    on = " ".join(str(on or "").split())[:200]
    return _set(gid, state="blocked", blocked_on=on, next="blocked on: " + on)


def unblock(gid):
    g = next((x for x in _load() if x.get("id") == gid and x.get("state") == "blocked"), None)
    return bool(g) and _set(gid, state="active", blocked_on="", next="")


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


def last_text(g, now=None):
    """'chased 12m ago, chase: <why>' - the goal's last chase and the last decision with its reason."""
    parts = []
    if g.get("chased_at"):
        parts.append(f"chased {quiet_text({'last_activity': g['chased_at']}, now)} ago")
    if g.get("last_decision"):
        parts.append(f"{g['last_decision']}: {g.get('decision_why') or '-'}")
    return ", ".join(parts)


def table(now=None, detail=False):
    goals = open_goals()
    if not goals:
        return ""
    rows = [("Goal", "Ref", "Thread", "State", "Quiet", "Next")] + [
        (g["id"], g.get("ref", ""), g.get("thread") or "-", g["state"] + (f" ({g['chase_count']} chases)" if g.get("chase_count") else ""),
         quiet_text(g, now), (g.get("next") or f"target: {g.get('target')}") + (f"  [{last_text(g, now)}]" if detail and last_text(g, now) else ""))
        for g in goals]
    w = [max(len(r[i]) for r in rows) for i in range(5)]
    return "\n".join("  ".join(r[i].ljust(w[i]) for i in range(5)) + "  " + r[5] for r in rows)


def now_text(now=None):
    t = table(now)
    return ("Goals (the front desk owns them):\n" + t) if t else ""


# -- global pause, chase memory and the decision log
def _pause_path():
    return lean_common.lean_home("goals-pause.json")


def pause(until=None):
    """No chases at all until `until` (epoch) or until `resume()`."""
    lean_common.write_json_atomic(_pause_path(), {"until": until or 0, "since": lean_common.now_iso()})


def resume():
    try:
        os.remove(_pause_path())
        return True
    except OSError:
        return False


def read_pause_until():
    p = lean_common.read_json(_pause_path(), None)
    return (p or {}).get("until") or 0 if isinstance(p, dict) else 0


def paused(now=None):
    p = lean_common.read_json(_pause_path(), None)
    if not isinstance(p, dict):
        return False
    until = p.get("until") or 0
    return not until or (time.time() if now is None else now) < until


def parse_until(text, now=None):
    """'2h', '30m', 'HH:MM' or an ISO time -> epoch."""
    now = time.time() if now is None else now
    t = str(text or "").strip()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([mhd])", t)
    if m:
        return now + float(m.group(1)) * {"m": 60, "h": 3600, "d": 86400}[m.group(2)]
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", t)
    if m:
        d = datetime.datetime.fromtimestamp(now).replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        return d.timestamp() + (86400 if d.timestamp() <= now else 0)
    e = _epoch(t)
    if e:
        return e
    raise ValueError(f"cannot read the time {text!r} (2h, 30m, 18:00 or an ISO time)")


def _memory_path():
    return lean_common.lean_home("chase-memory.json")


def memory():
    m = lean_common.read_json(_memory_path(), {})
    m = m if isinstance(m, dict) else {}
    return {"runs": m.get("runs") if isinstance(m.get("runs"), dict) else {}, "goals": m.get("goals") if isinstance(m.get("goals"), dict) else {}}


def remember(kind, key, why):
    with lean_common.file_lock(_memory_path()):
        m = memory()
        m[kind][key] = {"why": why, "at": lean_common.now_iso()}
        for k in m:  # bounded
            if len(m[k]) > 500:
                m[k] = dict(list(m[k].items())[-500:])
        lean_common.write_json_atomic(_memory_path(), m)


def _log_path():
    return lean_common.lean_home("chase-log.jsonl")


def log_decision(now=None, **row):
    row = dict(ts=_iso(now) if now else lean_common.now_iso(), **row)
    with lean_common.file_lock(_log_path()):
        try:
            with open(_log_path()) as fh:
                lines = fh.read().splitlines()[-(LOG_KEEP - 1):]
        except OSError:
            lines = []
        lines.append(json.dumps(row))
        with open(_log_path(), "w") as fh:
            fh.write("\n".join(lines) + "\n")


def chase_log(n=30):
    out = []
    try:
        with open(_log_path()) as fh:
            for line in fh:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return out[-n:]


def chaser_calls_last_hour(now):
    return sum(1 for r in chase_log(LOG_KEEP) if r.get("call") and now - _epoch(r.get("ts")) < 3600)


def chaser_per_hour():
    for v in (os.environ.get("LEAN_AGENT_CHASER_PER_HOUR"), (lean_common.read_json(lean_common.lean_home("config.json"), {}) or {}).get("chaser_per_hour")):
        if str(v or "").strip().isdigit():
            return int(v)
    return CHASER_PER_HOUR


def log_text(n=30):
    rows = chase_log(n)
    if not rows:
        return "No chase decisions yet."
    out = []
    for r in rows:
        cost = f" ${r['cost']:.4f}" if isinstance(r.get("cost"), (int, float)) and r["cost"] else ""
        out.append(f"{r.get('ts', '')[5:16]}  {r.get('goal', '-'):4} {r.get('thread', '-'):5} {r.get('decision', '?'):10} "
                   f"{r.get('how', ''):6}{cost}  {r.get('ref', '')}: {r.get('why', '')}")
    return "\n".join(out)


# -- what threads say back: acknowledgements
RUN_ID_RE = re.compile(r"\b\d{4}-\d{4}-[0-9a-f]{4}\b")
SUPERSEDED_RE = re.compile(r"\b(supersed\w*|stale|ignor(?:e|ed|ing)|obsolete|abandon\w*|no longer (?:needed|relevant)|already (?:handled|done))\b", re.I)
DROPPED_RE = re.compile(r"\b(abandon\w*|closed|obsolete|dropped|no longer (?:needed|relevant)|won'?t (?:do|fix))\b", re.I)
DONE_RE = re.compile(r"\b(merged|completed|all done|is done|was done|nothing (?:is )?left|finished)\b", re.I)


def acknowledge(thread, text):
    """A thread report/reply: any reply to a chase acknowledges the chased run (never chased again); 'superseded', 'ignored',
    'abandoned' ... name run ids or the chased one; a goal the thread calls merged/done/abandoned/closed is closed here.
    Returns the closed goal ids."""
    text = str(text or "")
    if not thread or not text:
        return []
    closed = []
    with lean_common.file_lock(path()):
        items = _load()
        mine = [g for g in items if g.get("thread") == thread and g.get("state") in OPEN]
        for g in mine:
            if g.get("chased_at") and not g.get("replied_at"):
                g["replied_at"] = lean_common.now_iso()
                g["last_reply"] = " ".join(text.split())[:400]
                if g.get("chased_run"):
                    remember("runs", g["chased_run"], "chase answered")
            g["last_report"] = " ".join(text.split())[:600]
            named = [r for r in RUN_ID_RE.findall(text)]
            for r in named:
                if SUPERSEDED_RE.search(text):
                    remember("runs", r, "thread said superseded/ignored")
            ref_hit = key_of(g.get("ref")) in {key_of(r) for r in re.findall(r"(?:PR|pull request|#|work item)\s*#?\d+", text, re.I)} or \
                (len(mine) == 1 and not ref_in(text))
            if not ref_hit:
                continue
            if DROPPED_RE.search(text):
                g["state"], g["next"] = "dropped", "thread said abandoned/closed"
            elif DONE_RE.search(text) and not re.search(r"\b(not|n't|nothing)\s+(yet\s+)?(merged|done|finished|completed)", text, re.I):
                g["state"], g["next"] = "done", "thread said done/merged"
            else:
                continue
            g["last_decision"], g["decision_why"] = "drop" if g["state"] == "dropped" else "done", g["next"]
            remember("goals", g["id"], g["next"])
            closed.append(g["id"])
        if mine:
            _save(items)
    return closed


# -- the watchdog
def limit_near():
    """The plan limit is near: a plain nudge waits for the window (a lost worker is still woken)."""
    try:
        import usage
        return bool(usage.session_pressure()[1] or usage.exhausted_window())
    except Exception:
        return False


def _runs_of(tid, data):
    """[{id, started, task}] of the thread's ordinary runs: the ledger plus the running markers."""
    import lean_threads
    out, home = {}, lean_common.lean_home()
    try:
        with open(os.path.join(home, "ledger.jsonl")) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("id") and r.get("role") not in HELPER_ROLES and lean_threads.thread_of_run(r, data) == tid:
                    out[r["id"]] = {"id": r["id"], "started": r.get("started") or r.get("ts") or "", "task": str(r.get("task") or ""),
                                    "final": r.get("status") or r.get("outcome") or "done"}
    except OSError:
        pass
    return list(out.values())


HELPER_ROLES = ("chaser", "advisor", "librarian", "composer", "gap-decider", "tracker-discover", "review-learn", "reuse-check", "reviewer", "pr-status")


def thread_info(tid, data=None):
    """What the watchdog needs of a thread: lost workers (marker with a dead pid, no ledger row, none newer), running
    workers, an open question, a waiting item, last activity (epoch), and the thread's other runs."""
    import lean_threads
    data = data or lean_threads.load()
    t = data["threads"].get(tid) or {}
    settle_orphan_markers(data)
    lost = [(rid, m) for rid, m in lean_common.lost_runs(lean_common.lean_home())
            if m.get("pid") and lean_threads.thread_of_run(dict(m, id=rid), data) == tid and m.get("role") not in HELPER_ROLES]
    last = lean_threads._epoch(t.get("last_message") or t.get("created"))
    try:
        for e in lean_threads.events(data, lean_threads._todo_map()).get(tid, []):
            last = max(last, lean_threads._epoch(e[1]))
    except Exception:
        pass
    running = lean_threads.running_by_thread(data).get(tid, [])
    runs = _runs_of(tid, data)
    for rid in running:
        m = lean_common.read_json(lean_common.lean_home("running", rid + ".json"), {})
        runs.append({"id": rid, "started": m.get("started") or "", "task": str(m.get("task") or ""), "final": ""})
    try:
        waiting = [i for i in lean_waiting.open_items() if i.get("thread") == tid]
    except Exception:
        waiting = []
    return {"lost": lost, "running": running, "question": bool(lean_threads.open_questions(t)), "waiting": bool(waiting),
            "closed": bool(t.get("closed")), "last": last, "runs": runs}


def settle_orphan_markers(data=None):
    """Running markers whose process is gone and that have no ledger row (so `runs --show` / `run --resume` know no such
    run): when the thread has a newer run, or sent a final report after the marker started, the marker is dropped
    silently; otherwise a ledger row "lost (no record)" with the task head is recorded and the marker kept (flagged
    no_record) so `runs --show`, `runs --lost` and the chase can name it. Returns the number of markers dropped."""
    import lean_threads
    home_ = lean_common.lean_home()
    data = data or lean_threads.load()
    dropped = 0
    try:
        lost = lean_common.lost_runs(home_)
    except Exception:
        return 0
    reports = lean_common.read_json(os.path.join(home_, "last-reports.json"), {})
    for rid, m in lost:
        if m.get("no_record") or not isinstance(m, dict):
            continue
        tid = lean_threads.thread_of_run(dict(m, id=rid), data)
        started = str(m.get("started") or "")
        newer = bool(tid) and any(r.get("id") != rid and str(r.get("started") or "") > started
                                  for r in _runs_of(tid, data) + _markers_of(tid, data))
        rep = reports.get(tid) if tid else None
        final = bool(rep) and rep.get("kind") in ("done", "final") and float(rep.get("ts") or 0) > _epoch(started)
        marker = os.path.join(home_, "running", f"{os.path.basename(str(m.get('run') or rid))}.json")
        if newer or final:
            try:
                os.remove(marker)
                dropped += 1
            except OSError:
                pass
            continue
        row = {"id": rid, "ts": lean_common.now_iso(), "started": started, "project": m.get("project"),
               "model": m.get("model") or "?", "task": str(m.get("task") or "")[:300], "thread": m.get("thread"),
               "role": m.get("role"), "status": lean_common.LOST_NO_RECORD, "why": "lost", "turns": None, "seconds": None,
               "usage": {}, "units": 0, "cost_usd": None}
        try:
            with open(os.path.join(home_, "ledger.jsonl"), "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row) + "\n")
            m["no_record"] = True
            lean_common.write_json_atomic(marker, m)
        except OSError:
            pass
    return dropped


def _markers_of(tid, data):
    import lean_threads
    out = []
    for f in glob.glob(os.path.join(lean_common.lean_home(), "running", "*.json")):
        m = lean_common.read_json(f, {})
        if isinstance(m, dict) and m.get("role") not in HELPER_ROLES and lean_threads.thread_of_run(dict(m, id=m.get("run") or ""), data) == tid:
            out.append({"id": m.get("run") or "", "started": m.get("started") or ""})
    return out


def lost_message(run, ref, record_only=False):
    if record_only:
        return (f"Worker {run} ({ref}) left only a marker, no record; nothing to resume (`lean-agent runs --stop {run}` "
                "clears it). Check whether the work is done, then send ONE consolidated final report.")
    return (f"Worker {run} ({ref}) was lost. Resume it (`lean-agent run --resume {run} ...`) or restart it, "
            "then send ONE consolidated final report.")


def nudge_message(ref):
    return (f"Status check for {ref}: state and next step in one line? If done, send ONE consolidated final report "
            "(Ref, head sha, review verdict, checks, what's left, proposed action).")


def real_lost(lost, ref, runs):
    """The lost runs that are really lost for this goal: not acknowledged or chased for already, and no newer run of the
    thread for the same goal (a run on another ref does not count as a replacement)."""
    mem = memory()["runs"]
    out = []
    for rid, m in lost:
        if rid in mem and mem[rid].get("why") != "chased":
            continue
        started = str((m or {}).get("started") or "")
        newer = False
        for r in runs or []:
            if r.get("id") == rid or str(r.get("started") or "") <= started:
                continue
            other = ref_in(r.get("task") or "")
            if not other or key_of(other) == key_of(ref):
                newer = True
                break
        if not newer:
            out.append((rid, m))
    return out


def _context(g, i, kind, rid, now):
    return {"id": g["id"], "thread": g["thread"], "ref": g.get("ref", ""), "kind": kind, "run": rid,
            "quiet_min": int(max(0, now - max(_epoch(g.get("last_activity")), _epoch(g.get("created")), i.get("last") or 0)) // 60),
            "last_report": g.get("last_report", ""), "last_chase": g.get("last_chase_text", ""), "last_reply": g.get("last_reply", ""),
            "chases": int(g.get("chase_count") or 0),
            "runs": [f"{r.get('id')} {r.get('final') or 'running'}: {str(r.get('task'))[:80]}" for r in (i.get("runs") or [])[-4:]]}


def watchdog(now, send, alive, info=thread_info, near=limit_near, log=None, decide=None, is_paused=paused):
    """One pass over the active goals. `send(tid, text) -> (ok, err)` messages a thread (starting a parked one),
    `alive(tid)` says whether its session runs. `decide(contexts) -> {goal id: {action, message}, "_cost": usd}` (None: not ready yet, asked again next pass; {}: no decision) is the cheap
    model check for goals that still look quiet/lost after the deterministic pre-checks (None: chase them as before).
    Returns the digest lines (wakes and drops; also logged)."""
    if is_paused(now):
        return []
    quiet = quiet_minutes() * 60
    digest, cands, freed = [], [], False
    with lean_common.file_lock(path()):
        items = _load()
        finished = {x.get("id") for x in items if x.get("state") in ("done", "dropped")}
        for g in items:
            if g.get("state") == "blocked" and g.get("blocked_on") in finished:
                g["state"], g["blocked_on"], g["next"] = "active", "", ""
                freed = True
            if g.get("state") != "active" or not g.get("thread"):
                continue
            tid, ref = g["thread"], g.get("ref", "")
            if g["id"] in memory()["goals"]:
                g["state"] = "dropped"
                continue
            i = info(tid)
            act = max(_epoch(g.get("last_activity")), _epoch(g.get("created")), i.get("last") or 0)
            since_chase = now - _epoch(g.get("chased_at")) if g.get("chased_at") else float("inf")
            lost = real_lost(i.get("lost") or [], ref, i.get("runs"))
            if i.get("running") or i.get("question") or i.get("waiting") or i.get("closed"):
                continue
            if lost:
                kind, rid = "lost", lost[0][0]
            elif now - act >= quiet and since_chase >= quiet:
                kind, rid = "quiet", ""
            else:
                continue
            if kind == "lost" and since_chase < quiet:
                continue
            if now - _epoch(g.get("decided_at")) < quiet and _epoch(g.get("decided_at")) >= act and not g.get("pending_chase"):
                continue  # one decision per quiet period
            cands.append((g, i, kind, rid, _context(g, i, kind, rid, now)))
        # the cheap check: one batched helper call for the goals without a pending nudge
        decisions, cost, called, waiting_on_helper = {}, 0.0, False, False
        todo = [c for c in cands if not c[0].get("pending_chase")]
        if todo and decide is not None:
            if chaser_calls_last_hour(now) < chaser_per_hour():
                try:
                    got = decide([c[4] for c in todo])
                except Exception as exc:  # noqa: BLE001 - fall back to the plain rules
                    got = {}
                    if log:
                        log(f"chaser check failed: {exc}")
                if got is None:  # the helper is still running in the background: decide on a later tick
                    waiting_on_helper = True
                    got = {}
                cost = float(got.pop("_cost", 0) or 0) if isinstance(got, dict) else 0.0
                decisions, called = got if isinstance(got, dict) else {}, not waiting_on_helper
            else:
                decisions = {c[0]["id"]: {"action": "chase" if c[2] == "lost" else "defer", "message": "", "why": "chaser cap per hour"} for c in todo}
        for g, i, kind, rid, ctx in cands:
            tid, ref = g["thread"], g.get("ref", "")
            if waiting_on_helper and not g.get("pending_chase"):
                continue
            d = decisions.get(g["id"]) or {}
            action = str(d.get("action") or ("chase" if decide is None or kind == "lost" else "skip")).lower()
            if g.get("pending_chase"):
                action, d = "chase", {"message": g["pending_chase"], "why": "deferred nudge"}
            why = str(d.get("why") or d.get("message") or "")[:160]
            share = cost / max(1, len(todo))
            if called and not g.get("pending_chase"):
                log_decision(now, goal=g["id"], thread=tid, ref=ref, decision=action, why=why, cost=share, how="haiku",
                             call=(g is todo[0][0]))
            if action == "defer":  # the per-hour cap: no decision was made, ask again later
                g["last_decision"], g["decision_why"] = "defer", why
                continue
            g["last_decision"], g["decision_why"], g["decided_at"] = action, why or kind, _iso(now)
            if action == "skip":
                continue
            if action == "drop-goal":
                g["state"], g["next"] = "dropped", why or "dropped by the chase check"
                remember("goals", g["id"], g["next"])
                digest.append(f"dropped goal {g['id']} ({tid} / {ref}): {why or 'no longer needed'}")
                continue
            if action == "done-goal":
                g["state"], g["next"] = "done", why or "done"
                remember("goals", g["id"], g["next"])
                continue
            msg = str(d.get("message") or "").strip()
            if kind == "lost":
                msg = lost_message(rid, ref, bool(next((m for r_, m in (i.get("lost") or []) if r_ == rid), {}).get("no_record")))
                how = "asked to resume"
            else:
                msg = (msg[:240] if msg and action == "chase" else nudge_message(ref))
                parked = not alive(tid)
                how = "woken and asked for status" if parked else "asked for status"
            why_s = "worker lost" if kind == "lost" else ("session parked" if not alive(tid) else "quiet")
            if kind == "quiet" and near():
                g["pending_chase"], g["last_decision"] = msg, "defer"
                g["decision_why"] = "plan limit near: nudge waits"
                if now - _epoch(g.get("limit_noted")) >= quiet:
                    g["limit_noted"] = _iso(now)
                continue
            g.pop("pending_chase", None)
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
                g["decided_at"] = ""
                continue
            g["chased_at"], g["chase_count"] = _iso(now), int(g.get("chase_count") or 0) + 1
            g["last_chase_text"], g["chased_run"], g["replied_at"] = msg, rid, ""
            g["last_decision"], g["decision_why"] = "chase", why or why_s
            if rid:
                remember("runs", rid, "chased")
            log_decision(now, goal=g["id"], thread=tid, ref=ref, decision="chase", why=why or why_s, how="wake", cost=0)
            digest.append(f"chased {tid} ({ref}): {why_s} → {how}")
        if cands or digest or freed:
            _save(items)
    if log:
        for d in digest:
            log(d)
    return digest
