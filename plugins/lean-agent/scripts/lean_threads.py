"""The thread registry (`lean-agent thread`): every message in the one service session belongs to a thread.

Task threads are tagged `About #N "title":`, free threads `Thread tN "title":`. The registry lives in
~/.lean-agent/threads.json (written atomically under a lock): the threads, the aliases left by merges (merged id ->
target id) and the overrides left by `thread move` (record kind+id -> thread; the ledger, review and push logs are
append-only, so a re-homed record is overridden here). Kept here, never in the transcript, so they survive /clear,
restarts and compaction.

Expiry is a filter in `list`, nothing is deleted: the one idle rule (idle()) applies to `list` and `now`.
The id `optimize` is reserved.
"""
import contextlib
import glob
import datetime
import json
import math
import os
import re
import shlex
import time

import lean_common
import lean_private
from lean_common import now_iso, stem

try:
    import fcntl
except ImportError:  # not on Windows: no lock, the write is still atomic
    fcntl = None

RESERVED = {"optimize": "Optimize"}
ID_RE = re.compile(r"^(#[1-9]\d*|t[1-9]\d*|optimize)$")  # never #0 / t0


lean_home = lean_common.lean_home


def path():
    return lean_home("threads.json")


def _migrate():
    """The registry used to live in chat/ (named for the removed dashboard): move it, and its lock file, up once."""
    old = lean_home("chat", "threads.json")
    if os.path.exists(old) and not os.path.exists(path()):
        try:
            os.makedirs(os.path.dirname(path()), exist_ok=True)
            os.replace(old, path())
            if os.path.exists(old + ".lock"):
                os.remove(old + ".lock")
        except OSError:
            pass


def norm(tid):
    """`10`, `#10`, `t3`, `T3` -> the canonical id; ValueError for anything else."""
    t = str(tid or "").strip().strip(".")
    if t.isdigit():
        t = "#" + str(int(t))
    elif re.fullmatch(r"#\d+", t):
        t = "#" + str(int(t[1:]))
    elif re.fullmatch(r"[tT]\d+", t):
        t = "t" + str(int(t[1:]))
    t = t.lower() if t.lower() == "optimize" else t
    if not ID_RE.match(t):
        raise ValueError(f"bad thread id {tid!r} (use #N for a task, tN for another topic)")
    return t


def is_zero_id(tid):
    """True for an id that is empty, 0, #0 or t0 (a misparse; never a real thread)."""
    return not re.sub(r"[#tT0\s.]", "", str(tid or "")) and not re.fullmatch(r"optimize|main", str(tid or "").strip().lower())


def add_main_note(text):
    """One line for main (shown with its notes)."""
    with _locked() as data:
        main = data["threads"].setdefault("main", {"id": "main", "title": "main", "created": now_iso(), "last_message": None, "kind": "free"})
        main.setdefault("notes", []).append(str(text)[:500])


def session_refusal(tid, data=None):
    """"" when a session may run for this thread id; else why not: invalid/zero id, no record, or closed."""
    try:
        if is_zero_id(tid):
            raise ValueError("zero id")
        key = norm(tid)
    except ValueError:
        return f"invalid thread id {str(tid)!r}"
    data = data if data is not None else load()
    key = data.get("aliases", {}).get(key, key)
    t = data["threads"].get(key)
    if t is None:
        return f"no thread record for {key}"
    if t.get("closed"):
        return f"thread {key} is closed"
    if lean_private.hidden() and lean_private.thread_is_private(key, data):
        return f"thread {key} is private: {lean_private.HELD_MSG}"
    return ""


def orphan_reason(tid):
    """Why a thread session has no thread (invalid id, no record); "" for a real thread (open or closed)."""
    why = session_refusal(tid)
    return "" if not why or why.endswith("is closed") else why


def close_zero_threads():
    """Close threads with an empty/zero id (#0, t0, 0): kept as closed, their text attached to main as a note, spool dropped.
    One threads write. Returns the closed ids."""
    done = []
    with _locked() as data:
        for tid in [k for k in data["threads"] if is_zero_id(k)]:
            t = data["threads"][tid]
            if t.get("closed") and t.get("zero_closed"):
                continue
            texts = [str(r.get("text") or "") for r in t.get("requests") or [] if isinstance(r, dict)]
            main = data["threads"].setdefault("main", {"id": "main", "title": "main", "created": now_iso(), "last_message": None, "kind": "free"})
            main.setdefault("notes", []).append(f"closed misparsed thread {tid!r} ({t.get('title')}): " + " | ".join(texts)[:2000])
            t["closed"] = now_iso()
            t.pop("session_on", None)
            t["zero_closed"] = True
            done.append(tid)
    return done


def kind_of(tid):
    return "task" if tid.startswith("#") else "free"


def _epoch(ts):
    try:
        return datetime.datetime.fromisoformat(str(ts)).timestamp()
    except ValueError:
        return 0.0


def _empty():
    return {"threads": {}, "aliases": {}, "overrides": {}}


def load():
    _migrate()
    try:
        with open(path()) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        data = _empty()
    for k in ("threads", "aliases", "overrides"):
        if not isinstance(data.get(k), dict):
            data[k] = {}
    return data


@contextlib.contextmanager
def _locked():
    """Read-modify-write: hold the lock from load to the atomic replace; yields the data to change."""
    os.makedirs(os.path.dirname(path()), exist_ok=True)
    _migrate()
    with open(path() + ".lock", "a") as lock:
        if fcntl:
            lock = lean_common.flock_waiting(lock, fcntl.LOCK_EX, "threads.json", path() + ".lock")
            try:
                lock.truncate(0)
                lock.write(f"{os.getpid()}\n")
                lock.flush()
            except OSError:
                pass
        data = load()
        before = json.dumps(data, sort_keys=True)
        yield data
        if json.dumps(data, sort_keys=True) == before:
            return  # nothing changed: no write
        tmp = f"{path()}.{os.getpid()}.tmp"
        with open(tmp, "w") as fh:
            json.dump(data, fh, indent=1)
        os.replace(tmp, path())


def resolve(tid, aliases=None):
    """Follow merges to the thread that now carries `tid` (the id itself when it was never merged)."""
    aliases = load()["aliases"] if aliases is None else aliases
    seen = set()
    while tid in aliases and tid not in seen:
        seen.add(tid)
        tid = aliases[tid]
    return tid


def _ensure(data, tid, title=None, ts=None, create=False):
    if is_zero_id(tid):
        raise ValueError(f"bad thread id {tid!r}")
    t = data["threads"].get(tid)
    if t is None:
        if kind_of(tid) == "free" and tid not in RESERVED and not create:
            raise ValueError(f"no such thread {tid} (create it with: lean-agent thread new \"title\")")
        t = data["threads"][tid] = {"id": tid, "title": title or RESERVED.get(tid) or tid, "created": ts or now_iso(),
                                    "last_message": None, "kind": kind_of(tid)}
    elif title and (t.get("title") in (None, "", tid)):
        t["title"] = title
    return t


def new(title, text=None):
    """Create a thread. `text` (its first message) is stored at once as the thread's first request, marked undelivered
    until the thread's session has received it (pin), so `thread show` has it whatever happens to the delivery."""
    title = " ".join(str(title or "").replace('"', "'").split())[:80]
    if not title:
        raise ValueError("a thread needs a title")
    with _locked() as data:
        nums = [int(k[1:]) for k in data["threads"] if re.fullmatch(r"t\d+", k)]
        tid = f"t{max(nums, default=0) + 1}"
        data["threads"][tid] = {"id": tid, "title": title, "created": now_iso(), "last_message": now_iso(), "kind": "free"}
        body = _request_text(text)
        if body:
            data["next_request"] = int(data.get("next_request") or 0) + 1
            data["threads"][tid]["requests"] = [{"id": f"r{data['next_request']}", "ts": now_iso(), "text": body, "undelivered": True}]
    return tid


GOAL_START_MIN = 3  # minutes a request may stay unstarted before it is redelivered / nudged (config goal-start-minutes)


def start_minutes():
    for v in (os.environ.get("LEAN_AGENT_GOAL_START"), (lean_common.read_json(lean_common.lean_home("config.json"), {}) or {}).get("goal_start_minutes")):
        try:
            if v is not None and float(v) > 0:
                return float(v)
        except (TypeError, ValueError):
            pass
    return GOAL_START_MIN


def unstarted_request(t, evs, now, min_secs=0, turns=None):
    """The thread's request that was never started, or None: the oldest one never delivered to the session (undelivered
    True), else the newest delivered one when nothing but requests happened after it (no run, note, todo, push or report).
    {id, text, since, undelivered}. Only requests that are at least `min_secs` old count."""
    reqs = [r for r in t.get("requests") or [] if isinstance(r, dict)]
    rep = t.get("report") if isinstance(t.get("report"), dict) else {}
    rep_ts = _epoch(rep.get("ts")) if rep.get("text") else 0
    pick = next((r for r in reqs if r.get("undelivered")), None)
    if pick is None and reqs and reqs[-1].get("delivered_ts") and not is_status_question(reqs[-1].get("text")):
        pick = reqs[-1]
    if pick is None:
        return None
    since = _epoch(pick.get("ts"))
    if pick.get("handled_ts") or answered_after(t, evs, since, rep_ts, turns):
        return None  # the thread already produced a turn after it (any reply, "no action needed" included)
    if not pick.get("undelivered") and (rep_ts >= since or any(e[2] != "request" and e[0] >= since for e in evs or [])):
        return None
    if now - since < min_secs:
        return None
    return {"id": pick.get("id"), "text": pick.get("text") or "", "since": since, "undelivered": bool(pick.get("undelivered")),
            "redelivered": bool(pick.get("redelivered_ts"))}


def turns_map():
    """thread-turns.json read once (pass it as `turns` to answered_after / unstarted_request when looping over threads)."""
    data = lean_common.read_json(lean_home("thread-turns.json"), {})
    return data if isinstance(data, dict) else {}


def answered_after(t, evs, since, rep_ts=None, turns=None):
    """True when the thread replied after a request made at `since` (epoch): its report, or a turn end recorded by the
    service that produced a report."""
    if rep_ts is None:
        rep = t.get("report") if isinstance(t.get("report"), dict) else {}
        rep_ts = _epoch(rep.get("ts")) if rep.get("text") else 0
    if rep_ts and rep_ts >= since:
        return True
    tid = t.get("id")
    rec = (turns_map() if turns is None else turns).get(tid) if tid else None
    return bool(rec and rec.get("reported") and float(rec.get("ts") or 0) >= since)


def mark_handled(tid, rid=None):
    """Record that the thread handled its request `rid` (default: every request it answered): never redelivered."""
    changed = []
    with _locked() as data:
        t = data["threads"].get(tid) or {}
        for r in t.get("requests") or []:
            if isinstance(r, dict) and not r.get("handled_ts") and (rid is None or r.get("id") == rid):
                r["handled_ts"] = now_iso()
                r.pop("undelivered", None)
                changed.append(r.get("id"))
    return changed


def mark_handled_many(by_thread):
    """{tid: set(request ids)} marked handled in ONE locked write. Returns [(tid, rid)] that changed."""
    changed = []
    if not by_thread:
        return changed
    with _locked() as data:
        for tid, rids in by_thread.items():
            for r in (data["threads"].get(tid) or {}).get("requests") or []:
                if isinstance(r, dict) and not r.get("handled_ts") and r.get("id") in rids:
                    r["handled_ts"] = now_iso()
                    r.pop("undelivered", None)
                    changed.append((tid, r.get("id")))
    return changed


def request_seen(tid, text, since=0):
    """True when the thread's session has taken the message `text` (its prompt hook stored it as delivered at or after
    `since`, an epoch), i.e. the user turn started."""
    want = _request_text(text)
    t = load()["threads"].get(tid) or {}
    return any(_request_text(r.get("text")) == want and not r.get("undelivered") and r.get("delivered_ts")
               and _epoch(r.get("delivered_ts")) >= since - 1 for r in t.get("requests") or [] if isinstance(r, dict))


def request_started(tid, rid):
    """True when request `rid` of the thread is no longer undelivered (or is gone): never deliver it again."""
    t = load()["threads"].get(tid) or {}
    r = next((r for r in t.get("requests") or [] if isinstance(r, dict) and r.get("id") == rid), None)
    return r is None or not r.get("undelivered")


def mark_redelivered(tid, rid):
    """Record that the service redelivered request `rid` by itself; False when it already did (or the request is gone)."""
    with _locked() as data:
        r = next((r for r in (data["threads"].get(tid) or {}).get("requests") or [] if isinstance(r, dict) and r.get("id") == rid), None)
        if r is None or r.get("redelivered_ts") or not r.get("undelivered"):
            return False
        r["redelivered_ts"] = now_iso()
        return True


def _request_text(prompt):
    prompt = str(prompt or "")
    if BRIEF_END in prompt:
        prompt = prompt.split(BRIEF_END, 1)[1]
    return " ".join(prompt.split())[:REQUEST_CHARS]


def discard(tid):
    """Remove a thread that was just created and never got a request (a failed `thread new`)."""
    with _locked() as data:
        t = data["threads"].get(tid)
        if t is not None and not t.get("requests"):
            del data["threads"][tid]


def set_session(tid, **fields):
    """Record a thread's own Remote Control session in the registry: session_id (what --resume continues) and session_on
    (the service hosts it). A None value removes the field."""
    tid = resolve(norm(tid))
    with _locked() as data:
        t = data["threads"].get(tid)
        if t is None:
            raise ValueError(f"no such thread {tid}")
        for k, v in fields.items():
            if v is None:
                t.pop(k, None)
            else:
                t[k] = v
        if fields.get("session_on"):
            t["session_on_at"] = time.time()  # when its session was started: a session newer than the live snapshot is restored too
    return tid


def session_state(tid, t=None):
    """"running" when the service hosts the thread's session now, "closed" otherwise, with its Remote Control name."""
    t = t if t is not None else load()["threads"].get(tid) or {}
    if not t.get("session_on"):
        return "closed", None
    try:
        import service_session
        rec = service_session.session_rec(tid)
        name = rec.get("name") or service_session.thread_session_name(tid, t.get("title"))
        return ("running" if rec.get("pid") else "closed"), name
    except Exception:
        return "closed", None


def session_lines(tid, t):
    """The `now` line for a thread's own session: running or closed, with its Remote Control name ([] for a thread that never had one)."""
    state, name = session_state(tid, t)
    un = next((r for r in t.get("requests") or [] if isinstance(r, dict) and r.get("undelivered")), None)
    if un and time.time() - _epoch(un.get("ts")) >= 60:
        return [f"  request {un.get('id')}: not started ({int((time.time() - _epoch(un.get('ts'))) // 60)}m), retrying"]
    if state == "closed" and not t.get("session_id"):
        return []
    if state == "closed" and t.get("parked_by") in ("idle", "user-stop"):
        return ["  session: idle, session stopped (thread open; the next message starts it again)"]
    return [f'  session: {state}' + (f' \u2014 Remote Control "{name}"' if name else "")]


def session_threads_by_activity():
    """Ids of the threads whose session the service keeps running, most recently active first (ties: newest id)."""
    data = load()
    evs = events(data)
    num = lambda k: int(k[1:]) if k[1:].isdigit() else 0
    last = lambda k: max((e[0] for e in evs.get(k, [])), default=0)
    return sorted(session_threads(), key=lambda k: (last(k), num(k)), reverse=True)


def session_threads():
    """Ids of the threads whose session the service keeps running, oldest first."""
    data = load()
    ts = data["threads"]
    return sorted((k for k, t in ts.items() if t.get("session_on") and not session_refusal(k, data)), key=lambda k: int(k[1:]) if k[1:].isdigit() else 0)


def merge(src, dst):
    src, dst = norm(src), norm(dst)
    if src == dst:
        raise ValueError("can't merge a thread into itself")
    if src in RESERVED:
        raise ValueError(f"{src} is reserved and can't be merged away")
    with _locked() as data:
        _ensure(data, src)
        _ensure(data, dst)
        if resolve(dst, data["aliases"]) == src:
            raise ValueError(f"merging {src} into {dst} would make a cycle ({dst} already leads to {src})")
        data["aliases"][src] = dst
        data["threads"][src]["merged_into"] = dst
        data["threads"][src]["merged_at"] = now_iso()


def unmerge(src):
    src = norm(src)
    with _locked() as data:
        if src not in data["aliases"]:
            raise ValueError(f"{src} isn't merged into anything")
        del data["aliases"][src]
        if src in data["threads"]:
            data["threads"][src].pop("merged_into", None)
            data["threads"][src].pop("merged_at", None)


def _todo_map():
    """{"#N": todo item} from todo.json (read once per call by the callers)."""
    doc = lean_common.read_json(lean_home("todo.json"), {})
    return {f"#{t.get('id')}": t for t in (doc.get("items") if isinstance(doc, dict) else None) or [] if isinstance(t, dict)}


def idle(tid, t, last, todos, days, now):
    """The one idle rule, for `list` and `now`: a task whose todo is open is never idle, one whose todo is done is idle
    `days` after the later of its done_at and its last activity (a done todo without done_at: its last activity); any other thread `days` after its last activity (`last`, an epoch; 0 when it has none)."""
    if tid in RESERVED:
        return False
    item = todos.get(tid) if t.get("kind") == "task" else None
    if item:
        if item.get("status") != "done":
            return False
        last = max(_epoch(item.get("done_at")), last)
    return bool(last) and now - last > days * 86400


def hidden_threads(data):
    """Ids of the threads hidden by `private off` (empty while private mode is on)."""
    if not lean_private.hidden():
        return set()
    ps = lean_private.private_slugs()
    return {k for k in data["threads"] if lean_private.thread_is_private(k, data, ps)}


def threads(now=None, include_expired=False):
    """The threads to show: merged ones are left out (they show under their target), expired ones filtered."""
    data, todos, days = load(), _todo_map(), idle_days()
    now = time.time() if now is None else now
    if "optimize" not in data["threads"]:
        data["threads"]["optimize"] = {"id": "optimize", "title": RESERVED["optimize"], "created": None,
                                       "last_message": None, "kind": "free"}
    hid = hidden_threads(data)
    tops = {k: dict(t) for k, t in data["threads"].items() if k not in data["aliases"] and k not in hid}
    for src, dst in data["aliases"].items():  # the target's last message counts its merged threads' too (before expiry)
        tgt = tops.get(resolve(dst, data["aliases"]))
        s = data["threads"].get(src) or {}
        if tgt and s.get("last_message") and (not tgt.get("last_message") or _epoch(s["last_message"]) > _epoch(tgt["last_message"])):
            tgt["last_message"] = s["last_message"]
    out = [t for t in tops.values()
           if include_expired or not idle(t["id"], t, _epoch(t.get("last_message")), todos, days, now)]
    return sorted(out, key=lambda t: (t.get("last_message") or "", t["id"]), reverse=True)


# ------------------------------------------------------------------ automatic threads (the prompt hook)

MATCH_THRESHOLD = 0.4  # share of the prompt's (idf-weighted) words found in a thread, after the recency boost
REQUESTS_KEPT = 20
CONFIDENT_MARGIN = 0.15  # a guess is uncertain when the best thread beats the second by less than this ...
CONFIDENT_SCORE = 0.55   # ... or scores below this (the match threshold is MATCH_THRESHOLD)
REQUEST_CHARS = 300
BRIEF_END = "[end of brief]"  # closes the brief a thread session's first message starts with; the prompt follows
STOP = set("""the a an and or but if then else for to of in on at by with from into onto about as is are was were be been
being do does did done have has had it its this that these those there here we you i me my our your they them he she
can could would should will shall may might must not no yes ok okay please just also so very more most some any all
what which who whom how why when where than too lets let get got make made use using new need want like again still
now thanks thank hello hey hi""".split())
MYQ_RE = re.compile(r"^q(?:\s+(open|unread)|\s+t(\d+)|\s*(\d+))?\s*[.!]?$", re.I)  # q | q open | q t21 | q12: the user's own questions
ACK_RE = re.compile(r"^ack(?:\s+(?:q?\d+(?:[\s,]+q?\d+)*))?\s*[.!]?$", re.I)  # ack | ack 35 | ack q35 | ack 34 35
ASK_RE = re.compile(r"^(?:ask\s+t?|a)(\d+)(?:\s+(.*))?$", re.I | re.S)
FILES_RE = re.compile(r"^(?:files?\s+t?|f)(\d+)(?:\s+(\d+))?$", re.I)
SHORTCUT_RE = re.compile(r"^(?:please\s+)?(?:((?:show\s+)?more)|(?:s|summary|show)\s*t?(\d+))\s*[.!?]?$", re.I)
_NUMS = r"t?\d+(?:[\s,]+(?:x\s*)?t?\d+)*"
CLOSE_RE = re.compile(rf"^(?:please\s+)?x\s*(?:(all)(?:\s+(?:but|except)\s+({_NUMS}))?|idle\s+(\d+(?:\.\d+)?\s*[smhd]?)|({_NUMS}))(\s+force)?\s*[.!]?$", re.I)
STOP_RE = re.compile(rf"^(?:please\s+)?stop\s*(?:(idle)(?:\s+(\d+(?:\.\d+)?\s*[smhd]?))?|({_NUMS}))(\s+force)?\s*[.!]?$", re.I)
PRIVATE_RE = re.compile(r"^(?:please\s+)?private\s+(on|off|status)\s*[.!]?$", re.I)
REOPEN_RE = re.compile(r"^(?:please\s+)?o\s*t?(\d+)\s*[.!]?$", re.I)
PR_RE = re.compile(r"^pr\s*t?(\d+)(?:\s+(c|comments|ci|diff|fix|reply|review))?$", re.I)
PR_LIST_RE = re.compile(r"^pr\s+(list|mine|stale|find)(?:\s+(.+))?$", re.I)
PR_FLAGS = {"c": " --comments", "comments": " --comments", "ci": " --ci", "diff": " --diff", "": ""}
PR_WORK = {
    "fix": "Fix the open review comments on your PR(s) with a worker; then send one consolidated final report with the proposed push",
    "reply": "Draft replies to the open comments on your PR(s); report the drafts; post nothing until the user approves",
    "review": "Run a review of your PR's latest head; report the verdict with the vote question",
}
EXPLICIT_RE = re.compile(r"(?<![\w/&])(?:#(?!0+\b)(\d+)|[tT](?!0+\b)(\d+))\b")  # #0 / t0 are never thread ids


def words(text):
    """The content words of a text: lowercase, 3+ letters, no stop words, crudely stemmed."""
    return {stem(w) for w in re.findall(r"[a-z0-9][a-z0-9_-]{2,}", str(text or "").lower()) if w not in STOP}


def title_from(prompt):
    """A thread title from a prompt: its first line's first 8 content-ish words."""
    line = next((l for l in str(prompt).splitlines() if l.strip()), "")
    ws = [w for w in re.sub(r"[^\w#'./+-]+", " ", line).split() if w.lower() not in STOP or len(w) > 3][:8]
    return " ".join(ws)[:80] or "untitled"


def _doc(t, data):
    """Title words count double; merged-in threads' titles and the recent request texts add to the thread's words."""
    title = words(t.get("title"))
    for src, dst in data["aliases"].items():
        if resolve(dst, data["aliases"]) == t["id"]:
            title |= words((data["threads"].get(src) or {}).get("title"))
    body = set()
    for r in (t.get("requests") or [])[-8:]:
        body |= words(r.get("text"))
    return title, body


def score_threads(prompt, now=None, current=None, data=None, recency=True, drop=()):
    """[(score, thread id)] best first for the open threads. Prompt words are weighted by rarity across the threads (idf);
    the score is the weighted share of the prompt's words the thread has (title words count 2x), times a recency
    boost (up to +30%, fading over a day) and +0.1 for the thread the last prompt went to."""
    data = data or load()
    now = time.time() if now is None else now
    pw = words(prompt) - set(drop)
    if not pw:
        return []
    open_ = [t for k, t in data["threads"].items() if k not in data["aliases"] and k not in RESERVED and not t.get("closed")]
    docs = {t["id"]: _doc(t, data) for t in open_}
    df = {w: sum(1 for ti, bo in docs.values() if w in ti or w in bo) for w in pw}
    idf = {w: math.log(1 + (len(open_) + 1) / (1 + df[w])) for w in pw}
    total = sum(idf.values())
    out = []
    for t in open_:
        ti, bo = docs[t["id"]]
        shared = [w for w in pw if w in ti or w in bo]
        if not shared or (len(shared) < 2 and len(pw) > 2):
            continue  # one shared word out of a long prompt is a coincidence
        got = sum(idf[w] * (2.0 if w in ti else 1.0) for w in shared) / total
        age_h = max(0.0, now - _epoch(t.get("last_message") or t.get("created"))) / 3600
        sc = min(1.0, got) * (1 + 0.3 * math.exp(-age_h / 24)) + (0.1 if t["id"] == current else 0) if recency \
            else min(1.0, got) + 0.01 * math.exp(-age_h / 24)  # routing hint: recency only breaks a tie
        out.append((sc, t["id"]))
    return sorted(out, reverse=True)


def state_path():
    return lean_home("current-thread.json")


def current(session=None, max_age_h=24):
    """The thread the orchestrator's latest prompt went to: this session's, else the latest one (a worker command has no
    session id), if it is recent. None when there is none."""
    try:
        with open(state_path()) as fh:
            st = json.load(fh)
    except (OSError, ValueError):
        return None
    rec = (st.get("sessions") or {}).get(session or "") or st.get("latest") or {}
    if not rec.get("thread") or time.time() - _epoch(rec.get("ts")) > max_age_h * 3600:
        return None
    tid = resolve(rec["thread"])
    t = load()["threads"].get(tid) or {}
    return None if t.get("closed") else tid


def set_current(tid, session=None):
    rec = {"thread": tid, "ts": now_iso()}
    try:
        with open(state_path()) as fh:
            st = json.load(fh)
    except (OSError, ValueError):
        st = {}
    st.setdefault("sessions", {})
    if session:
        st["sessions"][session] = rec
        if len(st["sessions"]) > 20:
            for k in sorted(st["sessions"], key=lambda k: st["sessions"][k].get("ts", ""))[:-20]:
                del st["sessions"][k]
    st["latest"] = rec
    tmp = f"{state_path()}.{os.getpid()}.tmp"
    os.makedirs(os.path.dirname(state_path()), exist_ok=True)
    with open(tmp, "w") as fh:
        json.dump(st, fh, indent=1)
    os.replace(tmp, state_path())


def resolve_tag(value=None):
    """The thread a command records: `--thread` (`none` opts out), else LEAN_AGENT_THREAD (set for workers), else the
    orchestrator's current thread. Returns a canonical id or None."""
    value = value if value is not None else os.environ.get("LEAN_AGENT_THREAD")
    if value is not None and str(value).strip():
        if str(value).strip().lower() == "none":
            return None
        try:
            return resolve(norm(value))
        except ValueError:
            return None
    if os.environ.get("LEAN_AGENT_SESSION_ROLE") == "main":  # the front desk records as itself, never on a thread
        return None
    return current()


def _uncertain(ranked, tid, cur):
    """Whether a guessed thread should come with a "wrong? move it" hint: not for a continuation of the current thread,
    but when the best score is below CONFIDENT_SCORE or beats the second best by less than CONFIDENT_MARGIN."""
    if tid == cur or not ranked:
        return False
    second = ranked[1][0] if len(ranked) > 1 else 0.0
    return ranked[0][0] < CONFIDENT_SCORE or ranked[0][0] - second < CONFIDENT_MARGIN


STATUS_RE = re.compile(r"\b(status|progress|what(?:'s| is| are) (?:running|going on|happening|open|left)|how(?:'s| is| are) (?:it|things|the \w+) going|"
                       r"where are we|any news|update me|what are we (?:doing|working on))\b", re.I)
STATUS_MAX = 120  # characters: a longer message is a request, not a status question


def is_status_question(text):
    text = " ".join(str(text or "").split())
    return len(text) <= STATUS_MAX and bool(STATUS_RE.search(text))


def pinned_thread():
    """The thread this process is the session of (LEAN_AGENT_SESSION_ROLE=thread and LEAN_AGENT_THREAD), else None."""
    tid = os.environ.get("LEAN_AGENT_THREAD") or ""
    return tid if os.environ.get("LEAN_AGENT_SESSION_ROLE") == "thread" and tid else None


def pin(tid, prompt, session=None, now=None):
    """A prompt in a thread session belongs to that thread, whatever it says: stores the request, makes the thread current."""
    text = _request_text(prompt)  # the first message of a started thread: brief, then the user's prompt; only that is a request
    now_s = now_iso() if now is None else datetime.datetime.fromtimestamp(now).isoformat(timespec="seconds")
    with _locked() as data:
        t = data["threads"].get(tid)
        if t is None:
            return False
        t["last_message"] = now_s
        have = [r for r in t.get("requests") or [] if _request_text(r.get("text")) == text]
        if text and have:
            # stored already (the front desk handed it over, or `thread new` at creation): the session has it now
            r = next((r for r in have if r.get("undelivered")), None)
            if r is not None:
                r.pop("undelivered", None)
                r["delivered_ts"] = now_s
        elif text:
            data["next_request"] = int(data.get("next_request") or 0) + 1
            t.setdefault("requests", []).append({"id": f"r{data['next_request']}", "ts": now_s, "text": text, "delivered_ts": now_s})
            del t["requests"][:-REQUESTS_KEPT]
    set_current(tid, session)
    return True


GENERIC = {stem(w) for w in """review reviews pr prs pull request requests check checks fix fixes test tests testing quick look
task tasks thread threads work item items bug status issue change changes update run job please""".split()}
FRONT_DESK_JOBS = (
    ("feedback", re.compile(r"\bfeedback\b", re.I)),
    ("budget", re.compile(r"\b(?:budget|savings?|usage|limits?|quota|spend(?:ing)?)\b", re.I)),
    ("memory", re.compile(r"\b(?:remember|memor(?:y|ies))\b", re.I)),
    ("schedule", re.compile(r"\b(?:schedules?|scheduled|scheduling)\b", re.I)),
    ("threads overview", re.compile(r"\b(?:(?:all|my|open|list(?: of)?) threads|threads (?:overview|list|status)|overview of (?:the )?threads|status of all)\b", re.I)),
    ("goals", re.compile(r"\b(?:goals?|how are we (?:doing|on)\b|status of (?:everything|all)|what(?:'s| is) open|overview|where are we)\b", re.I)),
    ("maintenance", re.compile(r"^\s*(?:please\s+)?(?:lean-agent\s+)?(?:sync|update|restart|clear)(?:\s+(?:the\s+)?(?:plugin|lean-agent|front desk|session|context|templates?|everything))?\s*[.!?]?\s*$", re.I)),
)
NEW_WORDS_RE = re.compile(r"\b(?:new (?:thread|topic)|separate thread|start (?:a )?(?:new|fresh) (?:thread|topic))\b", re.I)
SAME_WORDS_RE = re.compile(r"\b(?:resume|continue|same|that|this|existing|old) (?:that |the |this )?(?:thread|topic)\b|\b(?:resume|continue)\b", re.I)
SEND_TAIL = "lean-agent thread send {t} --prompt-file -"
NEW_TAIL = 'lean-agent thread new "<title>" --prompt-file -'


def _tid_of(tag, data):
    try:
        return resolve(norm(tag), data["aliases"])
    except (ValueError, TypeError, AttributeError, KeyError):
        return None


def _tail_jsonl(path, tail=3000):
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


def thread_owner_index(data):
    """What each thread owns, from the same records `lean-agent find` searches: {tid: {"own": [(text, is_ref)],
    "mention": [text], "runs": [run ids], "todos": [todo ids]}}. Owned: the thread's title and ref(s), the refs and text
    of its linked todos, the task/branch/worktree/ref of its runs, its reviews' pr/ref/branch, its pushed branches.
    Mentioned: request and report texts, todo notes, handoff notes."""
    idx = {}

    def slot(tag):
        tid = _tid_of(tag, data) if tag else None
        if not tid or tid not in data["threads"]:
            return None
        return idx.setdefault(tid, {"own": [], "mention": [], "runs": [], "todos": []})
    for k, t in data["threads"].items():
        if k in data["aliases"] or k in RESERVED:
            continue
        sl = slot(k)
        sl["own"].append((t.get("title"), False))
        for key in ("ref", "refs", "branch", "pr"):
            v = t.get(key)
            for x in (v if isinstance(v, list) else [v]):
                if x:
                    sl["own"].append((str(x), True))
        sl["mention"] += [str(r.get("text")) for r in t.get("requests") or []]
        sl["mention"] += [str(r.get("text")) for r in t.get("reports") or [] if isinstance(r, dict)]
    for src, dst in data["aliases"].items():  # merged-in threads count for the thread they were merged into
        sl, st = slot(dst), data["threads"].get(src) or {}
        if sl is not None:
            sl["own"].append((st.get("title"), False))
            sl["mention"] += [str(r.get("text")) for r in st.get("requests") or []]
    todo = lean_common.read_json(lean_home("todo.json"), {})
    for t in (todo.get("items") or []) if isinstance(todo, dict) else []:
        sl = slot(t.get("thread")) if isinstance(t, dict) else None
        if sl is not None:
            sl["own"] += [(t.get("ref"), True), (t.get("text"), False)]
            sl["mention"] += [str(n) for n in t.get("notes") or []]
            sl["todos"].append(str(t.get("id")))
    for r in _tail_jsonl(lean_home("ledger.jsonl")):
        sl = slot(r.get("thread"))
        if sl is not None:
            sl["own"] += [(r.get("ref"), True), (r.get("branch"), True), (r.get("worktree"), True),
                          (str(r.get("task") or "").split("\n")[0], False)]
            sl["runs"].append(str(r.get("id")))
    for r in _tail_jsonl(lean_home("pushes.jsonl")):
        sl = slot(r.get("thread"))
        if sl is not None:
            sl["own"].append((r.get("branch"), True))
    for f in glob.glob(lean_home("reviews", "*.jsonl")):
        if f.endswith((".declined.jsonl", ".threads.jsonl")):
            continue
        for r in _tail_jsonl(f, 500):
            sl = slot(r.get("thread"))
            if sl is not None:
                sl["own"] += [(r.get("pr"), True), (r.get("ref"), True), (r.get("branch"), True), (r.get("goal"), False)]
    notes = lean_common.read_json(lean_home("handoff-notes.json"), [])
    for n in notes if isinstance(notes, list) else []:
        sl = slot(n.get("thread")) if isinstance(n, dict) else None
        if sl is not None:
            sl["mention"].append(str(n.get("text")))
    return idx


def reference_owners(refs, data, idx=None):
    """[(kind, value, owners, mentioners)] per reference: thread ids owning it and thread ids that only mention it."""
    import lean_find
    idx = thread_owner_index(data) if idx is None else idx
    out = []
    for kind, value in refs:
        own, men = [], []
        for tid, sl in idx.items():
            if kind == "run":
                hit = value in sl["runs"]
            elif kind == "todo":
                hit = value in sl["todos"]
            else:
                hit = any(lean_find.reference_in(kind, value, x, ir) for x, ir in sl["own"])
            if hit:
                own.append(tid)
            elif kind not in ("run", "todo") and any(lean_find.reference_in(kind, value, x, True) for x in sl["mention"]):
                men.append(tid)
        out.append((kind, value, own, men))
    return out


def _closed(data, tid):
    return bool((data["threads"].get(tid) or {}).get("closed"))


def _tids(text, data):
    """The existing thread ids in a shortcut's number list ("21 x22, t30"), in order, without repeats."""
    out = []
    for n in re.findall(r"\d+", text or ""):
        tid = resolve(f"t{int(n)}", data["aliases"])
        if tid in data["threads"] and tid not in out:
            out.append(tid)
    return out


def _send(tid, data):
    if (data["threads"].get(tid) or {}).get("session_on"):
        return f"hand it over: {SEND_TAIL.format(t=tid)}"
    return f"hand it over (this starts its session): {SEND_TAIL.format(t=tid)}"


def decide(text, data, session=None, now=None, idx=None):
    """Where a front-desk prompt goes, no model call. Order: explicit references (thread id, PR, work item, branch, run,
    todo) against what threads own; the user's words (new topic / that thread); front-desk jobs; topic similarity, only
    with a clear margin. Returns (thread id or None, line, kind), kind in thread|new|unsure|job|status."""
    import lean_find
    text = " ".join(str(text or "").split())
    low = text.lower().rstrip("?!. ") if text != "?" else "?"
    if text == "?" or low in ("shortcuts", "help"):
        return None, "Front desk job (shortcuts) \u2014 no thread: lean-agent shortcuts", "job"
    if low in ("goals", "waiting"):
        return None, f"Front desk job ({low}) \u2014 no thread: lean-agent {low}", "job"
    pv = PRIVATE_RE.match(low)
    if pv:
        return None, f"Front desk job (private shortcut) \u2014 no thread: lean-agent private {pv.group(1)}", "job"
    if lean_private.hidden():  # private projects are hidden: never route to one
        ps = lean_private.private_slugs()
        hid = {k for k in data["threads"] if lean_private.thread_is_private(k, data, ps)}
        if any(resolve(f"#{int(m.group(1))}" if m.group(1) else f"t{int(m.group(2))}", data["aliases"]) in hid
               for m in EXPLICIT_RE.finditer(text)) or lean_private.mentions_private(text):
            return None, lean_private.HELD_MSG, "unsure"
        data = {**data, "threads": {k: v for k, v in data["threads"].items() if k not in hid},
                "aliases": {k: v for k, v in data["aliases"].items() if v not in hid}}
        idx = None
    ak = ACK_RE.match(text)
    if ak:
        nums = " ".join("q" + n for n in re.findall(r"\d+", text))
        return None, "Front desk job (acknowledge answers) \u2014 no thread: lean-agent myq ack" + (f" {nums}" if nums else ""), "job"
    qm = MYQ_RE.match(text)
    if qm:
        if (qm.group(1) or "").lower() == "unread":
            return None, "Front desk job (my questions shortcut) \u2014 no thread: lean-agent myq unread", "job"
        if qm.group(1):
            return None, "Front desk job (my questions shortcut) \u2014 no thread: lean-agent myq --open", "job"
        if qm.group(2):
            return None, f"Front desk job (my questions shortcut) \u2014 no thread: lean-agent myq --thread t{int(qm.group(2))}", "job"
        if qm.group(3):
            return None, f"Front desk job (my questions shortcut) \u2014 no thread: lean-agent myq {int(qm.group(3))}", "job"
        return None, "Front desk job (my questions shortcut) \u2014 no thread: lean-agent myq", "job"
    am = ASK_RE.match(text)
    if am:
        tid = resolve(f"t{int(am.group(1))}", data["aliases"])
        if tid in data["threads"]:
            q = (am.group(2) or "").strip()
            if not q:
                return None, f"Front desk job (ask shortcut) \u2014 no thread: no question given; ask the user what to ask {tid}", "job"
            return None, f"Front desk job (ask shortcut) \u2014 no thread: send the question to {tid} unchanged: lean-agent thread send {tid} {_dq(q)}", "job"
    fm = FILES_RE.match(text)
    if fm:
        tid = resolve(f"t{int(fm.group(1))}", data["aliases"])
        if tid in data["threads"]:
            if fm.group(2):
                return None, f"Front desk job (files shortcut) \u2014 no thread: lean-agent thread files {tid} --show {fm.group(2)}", "job"
            return None, f"Front desk job (files shortcut) \u2014 no thread: lean-agent thread files {tid}", "job"
    sc = SHORTCUT_RE.match(text)
    if sc and not sc.group(1):
        tid = resolve(f"t{int(sc.group(2))}", data["aliases"])
        if tid in data["threads"]:
            return None, f"Front desk job (summary shortcut) \u2014 no thread: lean-agent thread show {tid}", "job"
    elif sc:
        return None, "Front desk job (show more shortcut) \u2014 no thread: lean-agent now --all", "job"
    cm = CLOSE_RE.match(text)
    if cm:
        force = " --force" if cm.group(5) else ""
        if cm.group(1):
            ex = _tids(cm.group(2), data)
            cmd = "--all" + (" --except " + " ".join(ex) if ex else "")
        elif cm.group(3):
            cmd = "--idle " + cm.group(3).replace(" ", "").lower()
        else:
            ids = _tids(cm.group(4), data)
            cmd = " ".join(ids)
        if cmd:
            return None, f"Front desk job (close shortcut) \u2014 no thread: lean-agent thread close {cmd}{force}", "job"
    sm = STOP_RE.match(text)
    if sm:
        force = " --force" if sm.group(4) else ""
        if sm.group(1):
            cmd = "--idle" + (" " + sm.group(2).replace(" ", "").lower() if sm.group(2) else "")
        else:
            cmd = " ".join(_tids(sm.group(3), data))
        if cmd:
            return None, f"Front desk job (stop shortcut: stops the session only, the thread stays open) \u2014 no thread: lean-agent thread stop {cmd}{force}", "job"
    om = REOPEN_RE.match(text)
    if om:
        tid = resolve(f"t{int(om.group(1))}", data["aliases"])
        if tid in data["threads"]:
            return None, f"Front desk job (reopen shortcut) \u2014 no thread: lean-agent thread reopen {tid} --resume-old", "job"
    pm = PR_RE.match(low)
    if pm:
        tid = resolve(f"t{int(pm.group(1))}", data["aliases"])
        if tid in data["threads"]:
            act = (pm.group(2) or "").lower()
            if act in PR_WORK:
                return None, (f"Front desk job (pr {act} shortcut) \u2014 no thread: send the task to {tid} unchanged: "
                              f"lean-agent thread send {tid} {_dq(PR_WORK[act])}"), "job"
            return None, f"Front desk job (pr shortcut) \u2014 no thread: lean-agent pr {tid}{PR_FLAGS[act]}", "job"
    pl = PR_LIST_RE.match(low)
    if pl:
        what, rest = pl.group(1), (pl.group(2) or "").strip()
        orig = text.split(None, 2)[2] if what == "find" and len(text.split(None, 2)) > 2 else rest
        if what in ("list", "mine") and not rest:
            return None, f"Front desk job (pr {what} shortcut) \u2014 no thread: lean-agent pr {what}", "job"
        if what == "stale" and (not rest or re.fullmatch(r"\d+(\.\d+)?", rest)):
            return None, f"Front desk job (pr stale shortcut) \u2014 no thread: lean-agent pr stale" + (f" --days {rest}" if rest else ""), "job"
        if what == "find" and rest:
            return None, f"Front desk job (pr find shortcut) \u2014 no thread: lean-agent pr find {_dq(orig)}", "job"
    ids = list(EXPLICIT_RE.finditer(text))
    for m in ids:  # a thread id: tN, or a small #N
        cand = resolve(f"#{int(m.group(1))}" if m.group(1) else f"t{int(m.group(2))}", data["aliases"])
        if cand in data["threads"] or (cand.startswith("#") and int(m.group(1)) < 100):
            return cand, f"Belongs to {cand} (named in the message) \u2014 {_send(cand, data)}", "thread"
    refs = lean_find.prompt_references(text)
    results = reference_owners(refs, data, idx) if refs else []
    owned = []
    for k, v, own, men in results:
        if own and k != "num":
            owned.append((k, v, [o for o in own if not _closed(data, o)] or own, men))
    label = lean_find.reference_label
    if owned:
        tids = []
        for k, v, own, men in owned:
            tids += [o for o in own if o not in tids]
        k, v, own, men = owned[0]
        if len(tids) == 1:
            tid = tids[0]
            extra = [x for x in men if x != tid]
            why = ("closed; " if _closed(data, tid) else "") + f"owns {label(k, v)}" + (f"; also mentioned in {', '.join(extra)}" if extra else "")
            return tid, f"Belongs to {tid} ({why}) \u2014 {_send(tid, data)}", "thread"
        extra = [x for x in men if x not in tids]
        return None, f"Unsure: {label(k, v)} is owned by {', '.join(t + (' (closed)' if _closed(data, t) else '') for t in tids)}" \
            + (f", also mentioned in {', '.join(extra)}" if extra else "") + " \u2014 ask which one", "unsure"
    for k, v, own, men in results:  # a bare number counts as a reference only when a thread owns it as an id reference
        if k == "num" and own:
            cands = [o for o in own if not _closed(data, o)] or own
            tid = max(cands, key=lambda o: _epoch(data["threads"][o].get("last_message") or data["threads"][o].get("created")))
            return tid, f"Belongs to {tid} (owns {v}" + (f"; most recent of {', '.join(cands)}" if len(cands) > 1 else "") + f") \u2014 {_send(tid, data)}", "thread"
    ment = [(k, v, men) for k, v, own, men in results if men and k != "num"]
    if ment:
        k, v, men = ment[0]
        return None, f"Unsure: {label(k, v)} has no thread, only mentioned in {', '.join(men)} \u2014 new topic unless it follows up there", "unsure"
    if NEW_WORDS_RE.search(text):
        return None, f"New topic (you asked for a new thread) \u2014 start it: {NEW_TAIL}", "new"
    if is_status_question(text) and not ids:
        return None, "Status question \u2014 answer it here: lean-agent now", "status"
    for name, rx in FRONT_DESK_JOBS:
        if rx.search(text):
            tip = ": lean-agent goals / lean-agent now" if name == "goals" else ""
            return None, f"Front desk job ({name}) \u2014 do it here, no thread{tip}", "job"
    cur = None
    try:
        with open(state_path()) as fh:
            st = json.load(fh)
        cur = ((st.get("sessions") or {}).get(session or "") or st.get("latest") or {}).get("thread")
    except (OSError, ValueError):
        pass
    cur = resolve(cur, data["aliases"]) if cur else None
    cur_open = bool(cur and cur in data["threads"] and not _closed(data, cur))
    if SAME_WORDS_RE.search(text) and cur_open:
        return cur, f"Belongs to {cur} (you said to continue; the last thread) \u2014 {_send(cur, data)}", "thread"
    ranked = score_threads(text, now, cur, data, recency=False, drop=GENERIC)
    if ranked and ranked[0][0] >= MATCH_THRESHOLD:
        top = ranked[0][1]
        if len(ranked) == 1 or ranked[0][0] - ranked[1][0] >= CONFIDENT_MARGIN:
            return top, f"Belongs to {top} (title: {str(data['threads'][top].get('title'))[:40]}) \u2014 {_send(top, data)}", "thread"
        s2 = ranked[1][1]
        sh = sorted((words(text) & (_doc(data["threads"][top], data)[0] | _doc(data["threads"][s2], data)[0])) - GENERIC)
        return None, f"Unsure: {top} or {s2} ({', '.join(sh[:3]) or 'similar topic'}) \u2014 ask, or start a new thread", "unsure"
    if not words(text) and cur_open:
        return cur, f"Belongs to {cur} (continues the last topic) \u2014 {_send(cur, data)}", "thread"
    nolink = [label(k, v) for k, v, own, men in results if k != "num" and not own and not men]
    if nolink:
        return None, f"New topic ({nolink[0]} has no thread) \u2014 start it: {NEW_TAIL}", "new"
    return None, f"New topic \u2014 start it: {NEW_TAIL}", "new"


def advise(prompt, session=None, now=None):
    """The main session is the front desk: what the orchestrator should do with a user prompt, in one line saying why
    (see decide). A matched request is stored under its thread; a new topic creates nothing (`thread new` does).
    Returns (thread id or None, line)."""
    text = " ".join(str(prompt or "").split())
    data = load()
    tid, line, kind = decide(text, data, session, now)
    if kind == "thread" and tid:
        if tid in data["threads"]:
            pin(tid, text, session, now)
        else:
            route(text, session, now, create=False)  # a small #N names a thread that route creates
    return tid, line


ID_REF_RE = re.compile(r"(\bPR\s*#?|[A-Za-z]+-?#|#|(?<![\w.-]))(\d{3,})\b", re.I)  # 4711, #4711, PR 4711, AB#4711
BRANCH_RE = re.compile(r"\b((?:feature|bugfix|hotfix|release)/[\w.-]+)", re.I)


def prompt_ids(text):
    """The strong identifiers in a prompt: numbers with 3+ digits (also as #123, PR 123, AB#123) and branch names."""
    explicit, bare = prompt_refs(text)
    return explicit | bare


def prompt_refs(text):
    """(explicit, bare): ids written as #123, PR 123, AB#123 or a branch name, and bare 3+ digit numbers (ports, HTTP
    codes, years), which only count against a thread whose history holds the number as an id reference."""
    explicit, bare = set(), set()
    for m in ID_REF_RE.finditer(text):
        (explicit if m.group(1) else bare).add(m.group(2))
    return explicit | {m.group(1).lower() for m in BRANCH_RE.finditer(text)}, bare - explicit


def _bare_ref_pat(i):
    """A number as an id reference in thread history: #N, PR N, AB#N, a ticket key (ABC-N, upper case), or inside a branch name (feature/N-...); not 'case N' prose or
    word-N fragments like sha-256."""
    return re.compile(r"(?:#|\bPR\s*|(?-i:\b[A-Z][A-Z0-9]+-)|\b(?:feature|bugfix|hotfix|release)/(?:[\w.]*-)?)"
                      + re.escape(i) + r"(?![\w])", re.I)


def id_thread(text, data):
    """The open thread whose stored requests, runs, notes, pushes or branch mention an id of the prompt; with several, the
    one with the most recent mention. A prompt about a release PR goes to a thread whose title or branch says release.
    None when no such strong signal exists."""
    open_ = {k for k, t in data["threads"].items() if k not in data["aliases"] and k not in RESERVED and not t.get("closed")}
    explicit, bare = prompt_refs(text)
    best, best_ts = None, -1.0
    if explicit or bare:
        pats = [re.compile(r"(?<![\w.])" + re.escape(i) + r"(?![\w])", re.I) for i in explicit]
        pats += [_bare_ref_pat(i) for i in bare]
        for tid, evs in events(data, full=True).items():
            if tid not in open_:
                continue
            for ep, _, _, ev_text in evs:
                if ep > best_ts and any(p.search(ev_text) for p in pats):
                    best, best_ts = tid, ep
            for r in data["threads"][tid].get("requests") or []:  # the full stored text, not the shortened event line
                if _epoch(r.get("ts")) > best_ts and any(p.search(str(r.get("text"))) for p in pats):
                    best, best_ts = tid, _epoch(r.get("ts"))
        if best:
            return best
    w = words(text)
    if "release" in {x.rstrip("s") for x in w} and (re.search(r"\bPRs?\b|pull request", text, re.I)):
        evs = events(data)
        cands = [k for k in open_ if "release" in str(data["threads"][k].get("title")).lower()
                 or any(e[2] == "push" and "release" in e[3].lower() for e in evs.get(k, []))]
        if cands:
            return max(cands, key=lambda k: _epoch(data["threads"][k].get("last_message") or data["threads"][k].get("created")))
    return None


def route(prompt, session=None, now=None, create=True):
    """Assign a user prompt to a thread without any model call; stores the request (with a short id, rN) and the
    current-thread state. Returns (thread id, how, context line) with how in explicit|guessed|new; the line carries the
    request id and the move hint only when the guess is uncertain (see _uncertain). With create=False a new topic
    creates no thread and stores nothing: it returns (None, "new", "")."""
    text = " ".join(str(prompt or "").split())
    now_s = now_iso() if now is None else datetime.datetime.fromtimestamp(now).isoformat(timespec="seconds")
    m = EXPLICIT_RE.search(text)
    with _locked() as data:
        tid, how, unsure = None, None, False
        if m:
            cand = resolve(f"#{int(m.group(1))}" if m.group(1) else f"t{int(m.group(2))}", data["aliases"])
            if cand in data["threads"] or cand.startswith("#"):
                tid, how = cand, "explicit"
                _ensure(data, tid, title_from(text), create=True)
                data["threads"][tid].pop("closed", None)  # naming a closed thread reopens it
                data["threads"][tid].pop("auto_closed", None)
        if tid is None:
            tid = id_thread(text, data)
            how = "guessed" if tid else None
        if tid is None:
            cur = None
            try:
                with open(state_path()) as fh:
                    st = json.load(fh)
                cur = ((st.get("sessions") or {}).get(session or "") or st.get("latest") or {}).get("thread")
            except (OSError, ValueError):
                pass
            ranked = score_threads(text, now, cur, data)
            if ranked and ranked[0][0] >= MATCH_THRESHOLD:
                tid, how = ranked[0][1], "guessed"
                unsure = _uncertain(ranked, tid, cur)
            elif not words(text) and cur and cur in data["threads"] and not data["threads"][cur].get("closed") \
                    and cur not in data["aliases"]:
                tid, how = cur, "guessed"  # "yes, go ahead": no content words, it continues the last topic
        if tid is None and not create:
            return None, "new", ""
        if tid is None:
            nums = [int(k[1:]) for k in data["threads"] if re.fullmatch(r"t\d+", k)]
            tid, how = f"t{max(nums, default=0) + 1}", "new"
            data["threads"][tid] = {"id": tid, "title": title_from(text), "created": now_s, "last_message": now_s, "kind": "free"}
        t = data["threads"][tid]
        t["last_message"] = now_s
        data["next_request"] = int(data.get("next_request") or 0) + 1
        rid = f"r{data['next_request']}"
        t.setdefault("requests", []).append({"id": rid, "ts": now_s, "text": text[:REQUEST_CHARS], "undelivered": True})
        del t["requests"][:-REQUESTS_KEPT]
        title = t["title"]
    set_current(tid, session)
    if how == "new":
        line = f'New thread {tid} "{title}"'
    elif how == "guessed" and unsure:
        line = f'Thread {tid} "{title}" ({rid}, guessed \u2014 wrong? lean-agent thread move {rid} tN)'
    else:
        line = f'Thread {tid} "{title}"'
    return tid, how, line


# ------------------------------------------------------------------ notifications and runs

NOTIFICATION_RE = re.compile(r"\s*(?:<task-notification|Background command .{0,2000}?\b(?:completed|failed|was stopped)\b)", re.S)
SYSTEM_PROMPT_RE = re.compile(r"\s*<(?:system-reminder|task-notification|command-|local-command|hook)", re.I)
RUN_ID_RE = re.compile(r"\b\d{4}-\d{6}-[0-9a-f]{4}\b")
OUTPUT_FILE_RE = re.compile(r"<output-file>\s*([^<\s][^<]*?)\s*</output-file>|output[- ]file[:=]\s*(\S+)", re.I)
OUTPUT_READ = 200_000


REPORTS_RE = re.compile(r"\s*<thread-reports>(.*?)</thread-reports>", re.S)
REPORTS_KEPT = 5  # reports kept per thread; the latest is shown
REPORT_LINE_RE = re.compile(r"^\[(t\d+) (done|blocked|needs-you|question)\] (.+)$", re.M)


def is_reports(prompt):
    """A message the service typed into the main session: the reports of finished thread turns."""
    return bool(REPORTS_RE.match(str(prompt or "")))


def store_reports(prompt):
    """Attach each report line to the thread it names (never guessed, no thread created) as the thread's latest report;
    returns the ids stored."""
    m = REPORTS_RE.match(str(prompt or ""))
    if not m:
        return []
    got = {}
    for tid, kind, text in REPORT_LINE_RE.findall(m.group(1)):
        got.setdefault(tid, []).append({"kind": kind, "text": text.strip(), "ts": now_iso()})
    with _locked() as data:
        for tid, reps in got.items():
            t = data["threads"].get(resolve(tid, data["aliases"]))
            if t is not None:
                old = t.get("reports") if isinstance(t.get("reports"), list) else []
                t["reports"] = (old + reps)[-REPORTS_KEPT:]
                t["report"] = t["reports"][-1]  # `now` shows the latest
                for r in t.get("requests") or []:  # the thread reported: its earlier requests are handled (hook hand-over included)
                    if isinstance(r, dict) and not r.get("handled_ts") and _epoch(r.get("ts")) <= _epoch(reps[-1]["ts"]):
                        r["handled_ts"] = now_iso()
                        r.pop("undelivered", None)
    return sorted(got)


QUESTION_CHARS = 600


def open_questions(t):
    qs = t.get("questions") if isinstance(t.get("questions"), list) else []
    return [q for q in qs if isinstance(q, dict) and not q.get("answered")]


def _qnorm(text):
    return " ".join("".join(c if c.isalnum() else " " for c in str(text or "").lower()).split())


def ask(tid, text, options=None, info=None, kind=""):
    """Record an open question on thread `tid` (status "waiting on main"); returns its id qN. The same question
    (normalised text) asked again while open is merged into the open one (count + 1; `info["merged"]` is set)."""
    text = " ".join(str(text or "").split())
    if not text:
        raise ValueError('usage: lean-agent thread ask "<question>" [--options "a|b|c"]')
    opts = [o.strip() for o in str(options or "").split("|") if o.strip()]
    with _locked() as data:
        t = data["threads"].get(resolve(tid, data["aliases"]))
        if t is None:
            raise ValueError(f"no such thread {tid}")
        qs = t["questions"] = t.get("questions") if isinstance(t.get("questions"), list) else []
        same = next((q for q in qs if not q.get("answered") and _qnorm(q.get("text")) == _qnorm(text[:QUESTION_CHARS])), None)
        if same is not None:
            same["count"] = int(same.get("count") or 1) + 1
            if info is not None:
                info["merged"] = True
            return same["id"]
        qid = "q%d" % (1 + max([int(q["id"][1:]) for q in qs if str(q.get("id", "")).startswith("q") and q["id"][1:].isdigit()] + [0]))
        qs.append({"id": qid, "text": text[:QUESTION_CHARS], "options": opts, "ts": now_iso(), **({"kind": kind} if kind else {})})
    return qid


def open_permission(tid, qid=None):
    """The open permission question `qid` of thread `tid` (default: the only open question, if it is one), else None."""
    try:
        data = load()
        t = data["threads"].get(resolve(norm(tid), data["aliases"])) or {}
    except ValueError:
        return None
    opened = open_questions(t)
    q = next((x for x in opened if x["id"] == qid), None) if qid else opened[0] if len(opened) == 1 else None
    return q if q and q.get("kind") == "permission" else None


def answer(tid, qid, text):
    """Close question `qid` (default: the only open one) of thread `tid`; returns (tid, the question record)."""
    with _locked() as data:
        tid = resolve(norm(tid), data["aliases"])
        t = data["threads"].get(tid)
        if t is None:
            raise ValueError(f"no such thread {tid}")
        opened = open_questions(t)
        if qid:
            q = next((x for x in opened if x["id"] == qid), None)
            if q is None:
                raise ValueError(f"{tid} has no open question {qid}" + (f" (open: {', '.join(x['id'] for x in opened)})" if opened else ""))
        elif len(opened) == 1:
            q = opened[0]
        else:
            raise ValueError(f"{tid} has " + (f"{len(opened)} open questions ({', '.join(x['id'] for x in opened)}): name one" if opened else "no open question"))
        q["answered"] = now_iso()
        q["answer"] = str(text or "")[:QUESTION_CHARS]
        return tid, dict(q)


def reopen_question(tid, qid):
    with _locked() as data:
        for q in (data["threads"].get(tid) or {}).get("questions") or []:
            if q.get("id") == qid:
                q.pop("answered", None)
                q.pop("answer", None)


def question_lines(t, now=None):
    return [f'  waiting on you: {q["id"]} "{one_line(q["text"], 100)}" {age(q.get("ts"), now)}' for q in open_questions(t)]


def report_lines(t, now=None):
    r = t.get("report")
    if not isinstance(r, dict) or not r.get("text"):
        return []
    return [f"  report ({age(r.get('ts'), now)} ago) {r.get('kind')}: {one_line(r['text'], 120)}"]


def is_notification(prompt):
    """A prompt Claude Code (or a hook) wrote, not the user: a background-task notification or a system-tagged message."""
    text = str(prompt or "")
    return bool(NOTIFICATION_RE.match(text) or SYSTEM_PROMPT_RE.match(text))


def thread_of_run(rec, data=None):
    """The thread of a ledger/running record: a `thread move` override, else its tag (merges followed); None if untagged."""
    if rec.get("role") in lean_common.INTERNAL_ROLES:
        return None  # helper runs are never a thread's work, even when an old row carries a tag
    data = data or load()
    tid = data["overrides"].get(f"run:{rec.get('id') or rec.get('run')}") or rec.get("thread")
    if not tid or str(tid).lower() == "none":
        return None
    try:
        return resolve(norm(tid), data["aliases"])
    except ValueError:
        return None


def _read_tail(p, n=OUTPUT_READ):
    """The first and last n/2 bytes of a file (all of it when small)."""
    try:
        with open(p, "rb") as fh:
            raw = fh.read(n // 2 + 1)
            if len(raw) > n // 2:
                fh.seek(0, 2)
                fh.seek(max(n // 2, fh.tell() - n // 2))
                raw = raw[:n // 2] + b"\n" + fh.read()
        return raw.decode("utf-8", "replace")
    except OSError:
        return ""


def run_of_notification(text):
    """The lean-agent run a background-task notification is about: a run id in the notification or in its output file
    (`run <id> started`), else the run whose task text is inside the notification's command. None if there is none."""
    text = str(text or "")
    known = {r.get("id"): r for r in _jsonl(lean_home("ledger.jsonl")) if r.get("id")}
    for f in glob.glob(lean_home("running", "*.json")):
        m = lean_common.read_json(f, {})
        if isinstance(m, dict) and m.get("run"):
            known.setdefault(m["run"], dict(m, id=m["run"]))
    blobs = [text]
    for mo in OUTPUT_FILE_RE.finditer(text):
        blobs.append(_read_tail(os.path.expanduser(mo.group(1) or mo.group(2))))
    for blob in blobs:
        started = re.findall(r"\brun (\d{4}-\d{6}-[0-9a-f]{4}) started", blob)
        for rid in reversed(started):
            if rid in known:
                return known[rid]
        for rid in RUN_ID_RE.findall(blob):
            if rid in known:
                return known[rid]
    flat = " ".join(text.split())
    for rec in sorted(known.values(), key=lambda r: str(r.get("ts") or r.get("started") or ""), reverse=True):
        task = " ".join(str(rec.get("task") or "").split())[:60]
        if len(task) >= 12 and task in flat:
            return rec
    return None


def notification_line(prompt):
    """The context line for a notification prompt: the thread of the run it is about, or "" (no run found: it stays with
    the current thread, silently). Creates no thread, stores no request, changes no current thread."""
    rec = run_of_notification(prompt)
    if not rec:
        return ""
    data = load()
    tid = thread_of_run(rec, data)
    t = data["threads"].get(tid) if tid else None
    return f'Thread {tid} "{t.get("title")}" (this run\'s)' if t and not t.get("closed") else ""


# ------------------------------------------------------------------ show the work (`now`, `thread show`)

IDLE_DAYS = 7  # `now` closes an open thread with no activity for this long (LEAN_AGENT_THREAD_IDLE_DAYS or config thread_idle_days)
NOW_LINES = 30
KINDS = ['request', 'run', 'review', 'todo', 'note', 'handover', 'push']


def idle_days():
    for v in (os.environ.get("LEAN_AGENT_THREAD_IDLE_DAYS"), _config().get("thread_idle_days")):
        try:
            if v is not None and float(v) > 0:
                return float(v)
        except (TypeError, ValueError):
            pass
    return IDLE_DAYS


def _config():
    try:
        with open(lean_home("config.json")) as fh:
            c = json.load(fh)
        return c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        return {}


def _jsonl(p):
    out = []
    try:
        with open(p) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict):
                    out.append(r)
    except OSError:
        pass
    return out


def one_line(text, n=90):
    t = " ".join(str(text or "").split())
    return t if len(t) <= n else t[:n - 1] + "…"


def _log_records():
    """(kind, key, record) of the append-only logs: runs, reviews, pushes. The key names the record in the overrides."""
    for r in _jsonl(lean_home("ledger.jsonl")):
        yield "run", f"run:{r.get('id')}", r
    rdir = lean_home("reviews")
    for f in sorted(os.listdir(rdir)) if os.path.isdir(rdir) else []:
        if f.endswith(".jsonl"):
            for r in _jsonl(os.path.join(rdir, f)):
                yield "review", f"review:{f[:-6]}:{r.get('run')}:{r.get('ts')}", dict(r, _slug=f[:-6])
    for r in _jsonl(lean_home("pushes.jsonl")):
        yield "push", f"push:{r.get('ts')}:{r.get('branch')}", r


def events(data=None, todos=None, full=False):
    """{thread id: [(epoch, ts, kind, text)]} in time order: requests, runs, reviews, todos, notes, documents, pushes.
    A record's thread follows `thread move` overrides, then merges; records without a thread are left out. `full` keeps
    the whole note text and adds run tasks, branches and worktrees (the routing index)."""
    data = data or load()
    todos = _todo_map() if todos is None else todos
    out = {}

    def add(tid, ts, kind, text, key=None):
        tid = data["overrides"].get(key) or tid
        if not tid or not ts:
            return
        try:
            tid = resolve(norm(tid), data["aliases"])
        except ValueError:
            return
        out.setdefault(tid, []).append((_epoch(ts), str(ts), kind, one_line(text, 100000 if full else 160)))

    for tid, t in data["threads"].items():
        for r in t.get("requests") or []:
            add(tid, r.get("ts"), "request", r.get("text"))
    for kind, key, r in _log_records():
        if kind == "run" and r.get("role") in lean_common.INTERNAL_ROLES:
            continue  # a helper run is never a thread's work
        if kind == "run":
            what = (r.get("result_head") or "").strip().splitlines()
            text = (f"{r.get('id')} {r.get('model') or '?'} {r.get('status') or '?'} {r.get('project') or ''}: "
                    f"{one_line(what[0] if what else r.get('task'), 90)}")
            if full:
                text += f" {r.get('task') or ''} {r.get('branch') or ''} {r.get('worktree') or ''}"
        elif kind == "review":
            text = (f"{r.get('run')} {r['_slug']} {r.get('verdict')}, {len(r.get('findings') or [])} findings"
                    + (f", {len(r.get('gaps') or [])} gaps" if r.get("gaps") else ""))
        else:
            text = (f"{r.get('project')} {r.get('branch')} -> {r.get('to')} {str(r.get('sha') or '')[:8]}"
                    + ("" if r.get("ok", True) else " FAILED"))
            if full:
                text += f" {r.get('worktree') or ''}"
        add(r.get("thread"), r.get("ts"), kind, text, key)
    for t in todos.values():
        add(t.get("thread"), t.get("created"), "todo", f"#{t.get('id')} {t.get('status')} {t.get('text')}")
    notes = lean_common.read_json(lean_home("handoff-notes.json"), [])
    for n in notes if isinstance(notes, list) else []:
        if isinstance(n, dict):
            add(n.get("thread"), n.get("ts"), "note", f"{n.get('kind') or 'note'}: {n.get('text')}")
    hs = lean_common.read_json(lean_home("handovers.json"), [])
    for h in hs if isinstance(hs, list) else []:
        if isinstance(h, dict):
            add(h.get("thread"), h.get("ts"), "handover", str(h.get("path")))
    for v in out.values():
        v.sort(key=lambda e: (e[0], KINDS.index(e[2])))  # same second: the order the work happens in
    return out


def age(ts, now=None):
    s = max(0, (time.time() if now is None else now) - _epoch(ts))
    return f"{int(s // 86400)}d" if s >= 86400 * 2 else f"{int(s // 3600)}h" if s >= 3600 else f"{int(s // 60)}m"


def running_by_thread(data):
    """{thread id: [run ids]} of the live runs tagged with each thread."""
    out = {}
    home = lean_home()
    for f in glob.glob(os.path.join(home, "running", "*.json")):
        m = lean_common.read_json(f, {})
        if not lean_common.pid_alive(m.get("pid")):
            continue
        if m.get("thread") and m.get("role") not in lean_common.INTERNAL_ROLES:
            tid = resolve(m["thread"], data["aliases"])
            out.setdefault(tid, []).append(m.get("run") or os.path.basename(f)[:-5])
    return out


def _state(tid, evs, running, data):
    parts = []
    if running.get(tid):
        parts.append(f"{len(running[tid])} running")
    latest = {}
    for _, _, kind, text in evs:
        if kind == "review":
            latest[text.split()[1]] = text
    gaps = sum(1 for t in latest.values() if t.split()[2].rstrip(",") != "approve")
    if gaps:
        parts.append(f"{gaps} review open")
    todos = {}
    for _, _, kind, text in evs:
        if kind == "todo":
            todos[text.split()[0]] = text.split()[1]
    n = sum(1 for s in todos.values() if s != "done")
    if n:
        parts.append(f"{n} todo open")
    return ", ".join(parts) or "idle"


def autoclose(data, evs, running, todos, days, now):
    """Close (never delete) the open threads that are idle (see idle()); returns their ids. Caller saves."""
    gone = []
    for tid, t in data["threads"].items():
        if t.get("closed") or tid in data["aliases"] or running.get(tid):
            continue
        last = max([_epoch(t.get("last_message") or t.get("created"))] + [e[0] for e in evs.get(tid, [])])
        if idle(tid, t, last, todos, days, now):
            t["closed"], t["auto_closed"] = now_iso(), True
            t.pop("session_on", None)
            gone.append(tid)
    return gone


def elapsed(ts, now=None):
    s = max(0, int((time.time() if now is None else now) - _epoch(ts)))
    return f"{s // 3600}h{s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60}m{s % 60:02d}s"


def _details(tid, ev, data, todos, live, waiting, now):
    """The parallel work of one thread, one indented line each: runs in progress (id, model, elapsed, task), finished runs
    nobody collected yet, reviews with open findings or gaps, the next open todo."""
    out = []
    for rid, m in live:
        if thread_of_run(dict(m, id=rid), data) == tid:
            out.append(f"  running {rid} {m.get('model') or '?'} {elapsed(m.get('started'), now)}: {one_line(m.get('task'), 60)}")
    for rid, m in lean_common.lost_runs(lean_home()):
        if thread_of_run(dict(m, id=rid), data) == tid:
            out.append(f"  lost {rid} {m.get('model') or '?'} since {elapsed(m.get('started'), now)}: its supervisor died "
                       f"(lean-agent runs --stop {rid} closes it)")
    for r in waiting:
        if thread_of_run(r, data) == tid:
            out.append(f"  done, not collected {r['id']} {r.get('model') or '?'} {r.get('status') or '?'}: "
                       f"{one_line(r.get('task') or r.get('result_head'), 50)}")
    latest = {}
    for _, _, kind, text in ev:
        if kind == "review":
            latest[text.split()[1]] = text
    for text in latest.values():
        w = text.split()
        if w[2].rstrip(",") != "approve":
            out.append(f"  review open {w[0]} {w[1]}: {w[2].rstrip(',')} {' '.join(w[3:5])}")
    nxt = sorted((int(t.get("id") or 0), t) for k, t in todos.items()
                 if t.get("status") != "done" and t.get("thread") and _resolved(t["thread"], data) == tid)
    if nxt:
        out.append(f"  next todo #{nxt[0][1].get('id')}: {one_line(nxt[0][1].get('text'), 60)}")
    return out


def _resolved(tag, data):
    try:
        return resolve(norm(tag), data["aliases"])
    except ValueError:
        return None


def now_text(now=None, close_idle=True, max_lines=NOW_LINES):
    """Open threads by last activity (<= max_lines lines): a row per thread with its id, title, state, last action and
    age, and under it what runs in parallel for it: running runs, finished-but-uncollected runs, open review, next todo."""
    now = time.time() if now is None else now
    days, todos = idle_days(), _todo_map()
    live = lean_common.running_runs(lean_home())
    live_ids = {rid for rid, _ in live}
    ledger = {r["id"]: r for r in _jsonl(lean_home("ledger.jsonl")) if r.get("id")}
    waiting = [ledger[i] for i in lean_common.uncollected_ids(lean_home(), live_ids) if i in ledger]
    with _locked() as data:
        evs = events(data, todos)
        running = running_by_thread(data)
        closed = autoclose(data, evs, running, todos, days, now) if close_idle else []
        rows = []
        hid = hidden_threads(data)
        for tid, t in data["threads"].items():
            if t.get("closed") or tid in data["aliases"] or tid in RESERVED or tid in hid:
                continue
            ev = evs.get(tid, [])
            last_ts = max([t.get("last_message") or t.get("created") or ""] + [e[1] for e in ev])
            act = next((e for e in reversed(ev) if e[2] != "request"), None) or (ev[-1] if ev else None)
            rows.append((_epoch(last_ts), last_ts, tid, t, act, _state(tid, ev, running, data),
                         session_lines(tid, t) + question_lines(t, now) + report_lines(t, now) + _details(tid, ev, data, todos, live, waiting, now)))
    rows.sort(key=lambda r: (r[0], r[2]), reverse=True)
    lines = [f"Open threads ({len(rows)}), latest first:"] if rows else ["No open threads."]
    if lean_private.hidden():
        lines.insert(0, "(private projects hidden)")
    budget = max_lines - 2  # header and the footer line
    shown = 0
    for _, last_ts, tid, t, act, state, det in rows:
        if budget < 1:
            break
        lines.append(f"{tid:<4} {one_line(t['title'], 40):<40} {state:<22} {age(last_ts, now):>4}  "
                     + (f"{act[2]}: {one_line(act[3].split(' ', 1)[-1] if act[2] in ('run', 'review') else act[3], 60)}" if act else "-"))
        budget -= 1
        shown += 1
        keep = max(0, min(len(det), budget - (len(rows) - shown)))  # one row each for the threads still to come
        if keep < len(det):
            keep = max(0, keep - 1)  # room for the "... more" line
        lines += det[:keep]
        budget -= keep
        if keep < len(det):
            lines.append(f"  ... {len(det) - keep} more for {tid} (lean-agent thread show {tid})")
            budget -= 1
    if shown < len(rows):
        lines.append(f"... and {len(rows) - shown} older (lean-agent thread list)")
    if closed:
        lines.append(f"Closed as idle (> {days:g} days): {', '.join(closed)} (lean-agent thread reopen tN)")
        _closed_hooks(closed)
    return "\n".join(lines)


SHORT_LINES = 12
SHORT_DONE_HOURS = 24  # a done report counts as recent this long; older, the thread is idle


SHORT_ROWS = 10
WAIT_NEEDS = {"review": "vote", "question": "answer", "permission": "approve", "push": "push/post?", "auth": "sign in", "other": "your call"}


def _dq(text):
    """`text` as one double-quoted shell word."""
    return '"' + re.sub(r'(["\\$`])', r"\\\1", text) + '"'


def show_code(tid):
    """The reply shortcut that shows a thread's summary: t21 -> s21."""
    return "s" + str(tid).lstrip("t#")


def _files_path():
    return lean_home("files.json")


def record_file(path, kind, thread=None):
    """Remember a file lean-agent wrote for the user: path, size, time, thread (resolve_tag; the front desk is "main"), kind."""
    try:
        path = os.path.abspath(os.path.expanduser(str(path)))
        tid = resolve_tag(thread) if thread is not None else resolve_tag()
        rec = {"path": path, "kind": kind, "thread": tid or "main", "ts": now_iso(),
               "size": os.path.getsize(path) if os.path.exists(path) else 0}
        reg = _files_path()
        with lean_common.file_lock(reg):
            recs = lean_common.read_json(reg, [])
            recs = [r for r in recs if isinstance(r, dict) and not (r.get("path") == path and r.get("thread") == rec["thread"])] if isinstance(recs, list) else []
            recs.append(rec)
            lean_common.write_json_atomic(reg, recs[-500:])
    except Exception:  # a bookkeeping failure never fails the command that wrote the file
        pass


def thread_files(tid):
    """The files made for thread `tid`, oldest first: recorded ones plus (older) handovers of the thread. Each:
    {path, kind, ts, size, gone}."""
    tid = resolve(norm(tid)) if tid != "main" else "main"
    recs = lean_common.read_json(_files_path(), [])
    out = {r["path"]: dict(r) for r in recs if isinstance(r, dict) and r.get("thread") == tid and r.get("path")}
    hs = lean_common.read_json(lean_home("handovers.json"), [])
    for h in hs if isinstance(hs, list) else []:
        if isinstance(h, dict) and h.get("thread") == tid and h.get("path") and h["path"] not in out:
            out[h["path"]] = {"path": h["path"], "kind": "handover", "ts": h.get("ts") or ""}
    rows = []
    for r in out.values():
        r["gone"] = not os.path.exists(r["path"])
        if not r["gone"]:
            r["size"] = os.path.getsize(r["path"])
        rows.append(r)
    rows.sort(key=lambda r: r.get("ts") or "")
    return rows


def _size(n):
    return f"{n} B" if n < 1024 else f"{max(1, round(n / 1024))} KB" if n < 1024 * 1024 else f"{n / 1048576:.1f} MB"


def files_text(tid):
    rows = thread_files(tid)
    if not rows:
        return f"No files recorded for {tid}."
    lines = []
    for i, r in enumerate(rows, 1):
        path = r["path"]
        shown = lean_common.display_path(path)
        ts = str(r.get("ts") or "")[:16].replace("T", " ")
        lines.append(f"{i}. {shown} \u00b7 " + ("(gone)" if r["gone"] else _size(r.get("size", 0))) + f" \u00b7 {ts} \u00b7 {r.get('kind', 'file')}")
    return "\n".join(lines)


SHOW_LINES, SHOW_CHARS = 200, 12000


def file_show(tid, n):
    """(text, ok) for file number n of the thread: Markdown/text only, capped; a missing or binary file is refused with its path."""
    rows = thread_files(tid)
    if not str(n).isdigit() or not 1 <= int(n) <= len(rows):
        return f"no file {n} for {tid} (lean-agent thread files {tid})", False
    r = rows[int(n) - 1]
    path = r["path"]
    if r["gone"]:
        return f"{path} is gone", False
    try:
        raw = open(path, "rb").read(SHOW_CHARS * 4 + 1)
        if b"\0" in raw[:4096]:
            raise UnicodeDecodeError("utf-8", b"", 0, 1, "binary")
        text = raw.decode("utf-8", "ignore")
    except (OSError, UnicodeDecodeError):
        return f"not a text file, open it: {path}", False
    full = open(path, encoding="utf-8", errors="ignore").read()
    lines = full.splitlines()
    cut = "\n".join(lines[:SHOW_LINES])
    if len(cut) > SHOW_CHARS:
        cut = cut[:SHOW_CHARS]
        cut = cut[:cut.rfind("\n")] if "\n" in cut else cut
    kept = len(cut.splitlines())
    if kept < len(lines):
        cut += f"\n\u2026 ({len(lines) - kept} more lines; open {path})"
    return cut, True


def _cell(text, n):
    return one_line(text, n).replace("|", "/")


SHORT_UNSTARTED_HOURS = 12  # an unstarted request older than this is no longer shown as "not started"


def _stale_myq(tid, now):
    try:
        import lean_myq
        return lean_myq.stale(tid, now)
    except Exception:
        return None


def _myq_label(mq, now):
    import lean_myq
    return lean_myq.stale_label(mq, now)


def short_text(now=None, max_lines=SHORT_ROWS, all_=False):
    """`now --short`, the front desk's status: ONE table (Thread | What | State | Needs | Next | Show). Every thread that
    needs something (open question or permission, waiting item, report awaiting the user, blocked) comes first, most
    urgent (oldest) first; then every thread with a running worker; then recent done and idle ones. At most `max_lines`
    rows (all with all_), the rest counted in a last line. Read-only: never closes idle threads."""
    import lean_waiting
    now = time.time() if now is None else now
    todos = _todo_map()
    started = {rid: m.get("started") for rid, m in lean_common.running_runs(lean_home())}
    try:
        waits = [i for i in lean_waiting._load() if not i.get("answered_at") and i.get("thread")]
    except Exception:
        waits = []
    with _locked() as data:
        evs = events(data, todos)
        running = running_by_thread(data)
        rows = []
        hid = hidden_threads(data)
        for tid, t in data["threads"].items():
            if t.get("closed") or tid in data["aliases"] or tid in RESERVED or tid in hid:
                continue
            last = max([_epoch(t.get("last_message") or t.get("created"))] + [e[0] for e in evs.get(tid, [])])
            rep = t.get("report") if isinstance(t.get("report"), dict) and t["report"].get("text") else None
            rep_ts = _epoch(rep.get("ts")) if rep else 0
            oq = open_questions(t)
            wi = [i for i in waits if resolve(i.get("thread"), data["aliases"]) == tid]
            run = f"running {age(_iso_of(started.get(sorted(running[tid])[0]), last), now)}" if running.get(tid) else ""
            if (ud := undelivered_label(tid, now)):
                row = (-1, now - undelivered_age(tid, now), tid, ud, "message not delivered yet", f"wake {tid}")
            elif oq:
                ts = oq[0].get("ts")
                row = (-1, _epoch(ts), tid, "needs you " + age(ts, now),
                       f"waiting on you: {oq[0]['id']} " + _cell(oq[0]["text"], 40), f"answer {oq[0]['id']}")
            elif wi:
                w = min(wi, key=lambda i: _epoch(i.get("created") or i.get("ts")))
                row = (0, _epoch(w.get("created") or w.get("ts")), tid, "waiting " + age(w.get("created") or w.get("ts"), now),
                       _cell(w.get("summary"), 40), WAIT_NEEDS.get(w.get("kind"), "your call"))
            elif (mq := _stale_myq(tid, now)):
                row = (0, float(mq.get("ts") or 0), tid, _myq_label(mq, now), _cell(mq["text"], 40), "answer it")
            elif rep and rep.get("kind") in ("needs-you", "blocked") and rep_ts >= last - 5:
                label = "needs you" if rep["kind"] == "needs-you" else "blocked"
                row = (0, rep_ts, tid, f"{label} {age(rep['ts'], now)}", _cell(rep["text"], 40), "your call" if label == "needs you" else "unblock it")
            elif running.get(tid):
                row = (1, -last, tid, run, "", "wait for the run")
            elif (un := unstarted_request(t, evs.get(tid), now, start_minutes() * 60)) and now - un["since"] < SHORT_UNSTARTED_HOURS * 3600:
                row = (0, un["since"], tid, f"idle {age(_iso_of(None, last), now)}", f"not started ({int((now - un['since']) // 60)}m), retrying",
                       "redeliver it" if un["undelivered"] else "start it")
            elif rep and rep.get("kind") == "done" and now - rep_ts < SHORT_DONE_HOURS * 3600:
                row = (2, -rep_ts, tid, f"done {age(rep['ts'], now)}", _cell(rep["text"], 40), "nothing")
            else:
                row = (3, -last, tid, f"idle {age(_iso_of(None, last), now)}", "", "nothing")
            if row[0] == 0 and run:  # (a thread waiting on an answer never shows as running: row[0] is -1)
                row = row[:3] + (row[3] + ", " + run,) + row[4:]
            rows.append(row + (_cell(t.get("title"), 28),))
    note = ["(private projects hidden)", ""] if lean_private.hidden() else []
    if not rows:
        return "\n".join(note + ["No open threads."])
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    shown = rows if all_ else rows[:max_lines]
    lines = note + ["| Thread | What | State | Needs | Next | Show |", "|---|---|---|---|---|---|"]
    for pr, _, tid, state, needs, nxt, title in shown:
        c = show_code(tid)
        cell = f"**{c}** \u00b7 a{c[1:]}" + (f" \u00b7 f{c[1:]}" if thread_files(tid) else "")
        lines.append(f"| {tid} | {title} | {state} | {needs} | {nxt} | {cell} |")
    if len(rows) > len(shown):
        lines.append(f"\n+{len(rows) - len(shown)} more threads \u2014 reply **more**")
    return "\n".join(lines)


def _iso_of(ts, fallback_epoch):
    """`ts` if it is a timestamp, else the ISO time of the epoch `fallback_epoch`."""
    return ts or datetime.datetime.fromtimestamp(fallback_epoch).isoformat(timespec="seconds")


SHOW_TAIL = 5          # `thread show` default: the latest entries
SHOW_REPORT_CHARS = 800  # `thread show` default: the latest report, cut here (--full for all of it)


def queued_messages(tid):
    """How many messages for thread `tid` wait in the delivery spool."""
    try:
        return sum(1 for n in os.listdir(os.path.join(lean_home("thread-inbox"), tid)) if n.endswith((".json", ".sending", ".injected")))
    except OSError:
        return 0


UNDELIVERED_AFTER = 60  # seconds a queued message may wait before it counts as undelivered (a needs-attention state)


def undelivered_age(tid, now=None):
    """Seconds the oldest message queued for thread `tid` has waited (0 when none). The spool file name starts with the queue time."""
    now = time.time() if now is None else now
    oldest = None
    try:
        for n in os.listdir(os.path.join(lean_home("thread-inbox"), tid)):
            if n.endswith((".json", ".sending", ".injected")) and n[:20].isdigit():
                ts = int(n[:20]) / 1e9
                oldest = ts if oldest is None else min(oldest, ts)
    except OSError:
        return 0
    return max(0, now - oldest) if oldest is not None else 0


def undelivered_label(tid, now=None):
    """"undelivered message (Nm)" when thread `tid` has had a message queued for over a minute, else ''."""
    age_s = undelivered_age(tid, now)
    return f"undelivered message ({max(1, int(age_s // 60))}m)" if age_s >= UNDELIVERED_AFTER else ""


def no_nudge(t):
    """True for a thread nobody wants chased or nudged: closed by the user, or parked by the user. A thread parked by
    idle-stop or the session cap still gets its spooled message (it wakes and delivers it)."""
    if not isinstance(t, dict):
        return False
    if t.get("parked"):
        return t.get("parked_by") not in ("idle", "cap")
    return bool(t.get("closed"))


def undelivered_threads(now=None, min_secs=UNDELIVERED_AFTER):
    """[(thread id, age seconds)] of the threads with a message queued for at least `min_secs`, oldest first. Closed and
    user-parked threads are skipped."""
    try:
        names = os.listdir(lean_home("thread-inbox"))
    except OSError:
        return []
    data_ = load()
    threads_ = data_["threads"]
    hid = hidden_threads(data_)
    out = [(t, a) for t in names if t not in hid and not t.endswith(".lock") and not no_nudge(threads_.get(t)) and (a := undelivered_age(t, now)) and a >= min_secs]
    return sorted(out, key=lambda x: -x[1])


def spool_messages(tid):
    """[(id, file name, {text, rid, ts})] of the messages queued for `tid` and not being sent right now. The id is the
    short hex part of the file name."""
    d = os.path.join(lean_home("thread-inbox"), tid)
    out = []
    try:
        names = sorted(n for n in os.listdir(d) if n.endswith(".json"))
    except OSError:
        return out
    for n in names:
        rec = lean_common.read_json(os.path.join(d, n), {}) or {}
        out.append((n[:-5].split("-", 1)[-1], n, rec if isinstance(rec, dict) else {}))
    return out


def discard_spool_many(tids, handled=None):
    """Drop every queued message of the threads `tids` and mark their requests handled in ONE locked write.
    `handled` ({tid: request ids}) are marked handled in the same write. Returns [(tid, id, text)]."""
    got = []
    rids = {}
    for tid in tids:
        tid = resolve(norm(tid))
        for mid, name, rec in spool_messages(tid):
            try:
                os.remove(os.path.join(lean_home("thread-inbox"), tid, name))
            except OSError:
                continue
            got.append((tid, mid, str(rec.get("text") or "")))
            if rec.get("rid"):
                rids.setdefault(tid, set()).add(rec.get("rid"))
        rids.setdefault(tid, set())
    with _locked() as data:
        for tid, ids in rids.items():
            for r in (data["threads"].get(tid) or {}).get("requests") or []:
                if isinstance(r, dict) and not r.get("handled_ts") and (r.get("id") in ids or r.get("undelivered")):
                    r["handled_ts"] = now_iso()
                    r["discarded"] = True
                    r.pop("undelivered", None)
        for tid, ids in (handled or {}).items():
            for r in (data["threads"].get(tid) or {}).get("requests") or []:
                if isinstance(r, dict) and not r.get("handled_ts") and r.get("id") in ids:
                    r["handled_ts"] = now_iso()
                    r.pop("undelivered", None)
    return got


def discard_spool(tid, ids=None):
    """Drop the undelivered spooled messages of `tid` (`ids`: only those; None: all) and mark the requests they carry
    handled. Returns [(id, text)] of what was discarded."""
    tid = resolve(norm(tid))
    got = []
    for mid, name, rec in spool_messages(tid):
        if ids is not None and not any(mid.startswith(i) or name.startswith(i) for i in ids):
            continue
        try:
            os.remove(os.path.join(lean_home("thread-inbox"), tid, name))
        except OSError:
            continue
        got.append((mid, str(rec.get("text") or ""), rec.get("rid")))
    with _locked() as data:
        t = data["threads"].get(tid) or {}
        rids = {g[2] for g in got if g[2]}
        for r in t.get("requests") or []:
            if isinstance(r, dict) and not r.get("handled_ts") and (r.get("id") in rids or (ids is None and r.get("undelivered"))):
                r["handled_ts"] = now_iso()
                r["discarded"] = True
                r.pop("undelivered", None)
    return [(m, x) for m, x, _ in got]


def discard_line(tid, n):
    return f"{tid} closed: {n} queued message{'s' if n != 1 else ''} discarded"


def queued_note(tid):
    n = queued_messages(tid)
    label = undelivered_label(tid)
    return (f"{n} message{'s' if n != 1 else ''} queued for delivery" + (f" - {label}" if label else "")) if n else ""


def show_text(tid, all_=False, limit=40, report_chars=None):
    tid = resolve(norm(tid))
    data = load()
    t = data["threads"].get(tid)
    if t is None:
        raise ValueError(f"no such thread {tid}")
    if tid in hidden_threads(data):
        return f"{tid}: hidden: private ({lean_private.HELD_MSG})"
    ev = events(data).get(tid, [])
    head = f'{tid} "{t.get("title")}"' + (" [closed]" if t.get("closed") else "")
    merged = sorted(s for s, d in data["aliases"].items() if resolve(d, data["aliases"]) == tid)
    if merged:
        head += f" (includes {', '.join(merged)})"
    lines = [head] + ([queued_note(tid)] if queued_note(tid) else []) + [
        f"  queued {m}: {str(rec.get('text') or '')[:60]!r} (lean-agent thread discard {tid} {m})" for m, _, rec in spool_messages(tid)] + [l.strip() for l in question_lines(t)]
    shown = ev if all_ or len(ev) <= limit else ev[-limit:]
    if len(shown) < len(ev):
        lines.append(f"... {len(ev) - len(shown)} earlier (lean-agent thread show {tid} --all)")
    rids = {(str(r.get("ts")), one_line(r.get("text"), 160)): r.get("id") for tt, th in data["threads"].items() if resolve(tt, data["aliases"]) == tid for r in th.get("requests") or [] if r.get("id")}
    lines += [f"{ts[:16].replace('T', ' ')}  {(rids[(ts, text)] + '  ' if kind == 'request' and (ts, text) in rids else '') + f'{kind:<8}'} {text}"
              for _, ts, kind, text in shown]
    if not ev:
        lines.append("(nothing recorded yet)")
    last = {}
    for src in [tid] + merged:
        e = (lean_common.read_json(lean_home("last-reports.json"), {}) or {}).get(src)
        if isinstance(e, dict) and e.get("text") and e.get("ts", 0) >= last.get("ts", 0):
            last = e
    if last:
        when = datetime.datetime.fromtimestamp(last["ts"]).strftime("%Y-%m-%d %H:%M")
        body = last["text"].strip()
        if report_chars and len(body) > report_chars:
            body = body[:report_chars].rsplit(" ", 1)[0] + f" \u2026 (cut; `lean-agent thread show {tid} --full` for all)"
        lines += ["", f"Last report ({last.get('kind')}, {when}):", body]
    return "\n".join(lines)


ON_CLOSE = []  # callbacks(list of thread ids), called after threads were closed (set by lean_agent)


def _drop_goals(tids):
    """Closed threads drop their open goals (reason "thread closed"); a reopen does not revive them."""
    import lean_goals
    _closed_hooks.goals = {}
    try:
        _closed_hooks.goals = lean_goals.drop_for_threads(tids)
    except Exception:
        pass


def goal_line(tid):
    n = (getattr(_closed_hooks, "goals", None) or {}).get(lean_goals_tid(tid), 0)
    return f"{tid} closed: {n} goal{'s' * (n != 1)} dropped" if n else ""


def lean_goals_tid(tid):
    import lean_goals
    return lean_goals._tid(tid)


def _closed_hooks(tids):
    _drop_goals(tids)
    for fn in ON_CLOSE:
        try:
            fn(list(tids))
        except Exception:
            pass


def set_closed(tid, closed):
    tid = resolve(norm(tid))
    with _locked() as data:
        t = data["threads"].get(tid)
        if t is None:
            raise ValueError(f"no such thread {tid}")
        if closed:
            t["closed"] = now_iso()
            t.pop("session_on", None)
        else:
            t.pop("closed", None)
            t.pop("auto_closed", None)
            t["last_message"] = now_iso()  # reopened: counts as activity, or the next `now` would close it again
    if closed:
        _closed_hooks([tid])
        set_closed.discarded = len(discard_spool(tid))
    return tid


def _tagged(tag, thread, aliases):
    try:
        return bool(tag) and resolve(norm(tag), aliases) == thread
    except ValueError:
        return False


def _retag(path, items_of, thread, new, since, aliases, ts_key, until=float("inf")):
    """Rewrite, under the file's lock, the thread of the entries of `thread` from `since` up to (not including) `until`."""
    with lean_common.file_lock(path):
        doc = lean_common.read_json(path, None)
        items = items_of(doc)
        hit = [e for e in items if isinstance(e, dict) and _tagged(e.get("thread"), thread, aliases) and since <= _epoch(e.get(ts_key)) < until]
        for e in hit:
            e["thread"] = new
        if hit:
            lean_common.write_json_atomic(path, doc)


def cli_session():
    """The session a CLI call belongs to: LEAN_AGENT_SESSION, else the service session the hook records in up.json
    (when the hook has routed a prompt for it); None means the latest request of any session."""
    sid = os.environ.get("LEAN_AGENT_SESSION")
    if not sid:
        sid = lean_common.read_json(lean_home("up.json"), {}).get("session_id")
    st = lean_common.read_json(state_path(), {})
    return sid if sid and sid in ((st.get("sessions") or {}) if isinstance(st, dict) else {}) else None


def move_latest(tid, session=None, ref=None):
    """Wrong thread: a request goes to `tid` and what its old thread recorded since is re-homed: the append-only logs
    through the overrides, todo.json and the hand-off notes in place. `ref` names the request: an id (`r12`), a thread
    (its latest request), or None for the latest request of this session (else the latest one recorded, only when under
    24 h old; `tid` then becomes the current thread). The work moved is what the old thread recorded from that request
    until its next request. Returns (old thread, new thread)."""
    tid = norm(tid)
    st = lean_common.read_json(state_path(), {})
    rec = ((st.get("sessions") or {}).get(session or "") or st.get("latest") or {}) if isinstance(st, dict) else {}
    if ref is None:
        if not rec.get("thread"):
            raise ValueError("no current thread to move a request out of")
        if rec.get("ts") and time.time() - _epoch(rec["ts"]) > 24 * 3600:
            raise ValueError("nothing recent to move (the latest request is over 24 h old)")
    with _locked() as data:
        tid = resolve(tid, data["aliases"])
        if ref is None:
            old = resolve(rec["thread"], data["aliases"])
        elif re.fullmatch(r"r\d+", str(ref)):
            old = next((k for k, t in data["threads"].items() if any(r.get("id") == ref for r in t.get("requests") or [])), None)
            if old is None:
                raise ValueError(f"no request {ref} (the last {REQUESTS_KEPT} of each thread are kept)")
        else:
            old = resolve(norm(ref), data["aliases"])
        if old == tid:
            raise ValueError(f"the request is in {tid} already" if ref else f"the latest request is in {tid} already")
        reqs = (data["threads"].get(old) or {}).get("requests") or []
        if not reqs:
            raise ValueError(f"{old} has no request to move")
        i = next((i for i, r in enumerate(reqs) if r.get("id") == ref), len(reqs) - 1) if ref and ref[0] == "r" else len(reqs) - 1
        req = reqs.pop(i)
        since = _epoch(req["ts"])
        until = _epoch(reqs[i]["ts"]) if i < len(reqs) else float("inf")  # up to the old thread's next request
        newest = all(since >= _epoch(r.get("ts")) for t in data["threads"].values() for r in t.get("requests") or [])
        dst = _ensure(data, tid, title_from(req["text"]))
        dst.pop("closed", None)
        dst.pop("auto_closed", None)
        dst.setdefault("requests", []).append(req)
        dst["requests"].sort(key=lambda r: _epoch(r.get("ts")))
        dst["last_message"] = max([dst.get("last_message") or "", req["ts"]], key=_epoch)
        src = data["threads"][old]
        if i >= len(reqs):
            src["last_message"] = reqs[-1]["ts"] if reqs else src.get("created")
        for kind, key, r in _log_records():
            if since <= _epoch(r.get("ts")) < until and (data["overrides"].get(key) == old or (
                    data["overrides"].get(key) is None and _tagged(r.get("thread"), old, data["aliases"]))):
                data["overrides"][key] = tid
        for path_, items_of, ts_key in ((lean_home("todo.json"), lambda d: (d.get("items") if isinstance(d, dict) else None) or [], "created"),
                                        (lean_home("handoff-notes.json"), lambda d: d if isinstance(d, list) else [], "ts"),
                                        (lean_home("handovers.json"), lambda d: d if isinstance(d, list) else [], "ts")):
            _retag(path_, items_of, old, tid, since, data["aliases"], ts_key, until)
    if ref is None or newest:
        set_current(tid, session)
    return old, tid


# ------------------------------------------------------------------ the CLI

def cli(action, args, as_json=False, out=print):
    """`lean-agent thread <action> ...`; returns the exit code."""
    try:
        if action == "new":
            if len(args) != 1:
                raise ValueError('usage: lean-agent thread new "title"')
            out(new(args[0]))
        elif action == "list":
            items = threads()
            if as_json:
                out(json.dumps(items, indent=1))
            for t in ([] if as_json else items):
                out(f"{t['id']:<9}{t['kind']:<6}{(t.get('last_message') or '-'):<21}{t['title']}" + (" [closed]" if t.get("closed") else ""))
        elif action == "show":
            tail = None
            if "--tail" in args:
                k = args.index("--tail")
                if k + 1 >= len(args) or not args[k + 1].isdigit():
                    raise ValueError("usage: lean-agent thread show tN [--full] [--tail N]")
                tail = int(args[k + 1])
                args = args[:k] + args[k + 2:]
            ids = [a for a in args if not a.startswith("--")]
            if len(ids) != 1:
                raise ValueError("usage: lean-agent thread show tN [--full] [--tail N]")
            full = "--full" in args or "--all" in args
            if full:
                out(show_text(ids[0], True))
            else:  # short by default: state, open questions, the last few entries, the latest report cut
                out(show_text(ids[0], False, tail if tail is not None else SHOW_TAIL, SHOW_REPORT_CHARS))
        elif action in ("close", "reopen"):
            if len(args) != 1:
                raise ValueError(f"usage: lean-agent thread {action} tN")
            out(f"{set_closed(args[0], action == 'close')} {'closed' if action == 'close' else 'open again'}")
            if action == "close" and getattr(set_closed, "discarded", 0):
                out(discard_line(resolve(norm(args[0])), set_closed.discarded))
            if action == "close" and goal_line(resolve(norm(args[0]))):
                out(goal_line(resolve(norm(args[0]))))
        elif action == "discard":
            ids = [a for a in args[1:] if not a.startswith("--")]
            if not args or args[0].startswith("--") or (not ids and "--all" not in args):
                raise ValueError("usage: lean-agent thread discard tN [msg-id ...|--all]")
            tid = resolve(norm(args[0]))
            if tid not in load()["threads"]:
                raise ValueError(f"no such thread {tid}")
            gone = discard_spool(tid, None if "--all" in args else ids)
            for mid, text in gone:
                out(f"{tid}: discarded {mid} {text[:60]!r}")
            if not gone:
                out(f"{tid}: no queued message to discard")
        elif action == "merge" and len(args) != 2 or action == "unmerge" and len(args) != 1 or action == "move" and len(args) not in (1, 2):
            raise ValueError({"merge": "usage: lean-agent thread merge tB tA", "move": "usage: lean-agent thread move [rN|tM] tN",
                              "unmerge": "usage: lean-agent thread unmerge tB"}[action])
        elif action == "merge":
            merge(*args)
            out(f"{norm(args[0])} -> {resolve(norm(args[1]))}")
        elif action == "unmerge":
            unmerge(args[0])
            out(f"{norm(args[0])} is its own thread again")
        elif action == "move":
            old, new_ = move_latest(args[-1], cli_session(), args[0] if len(args) == 2 else None)
            out(f"{'the latest request' if len(args) == 1 else args[0]} moved from {old} to {new_}")
        else:
            raise ValueError("usage: lean-agent thread new|list|show|close|reopen|discard|merge|unmerge|move")
    except ValueError as e:
        out(f"lean-agent: {e}")
        return 1
    return 0
