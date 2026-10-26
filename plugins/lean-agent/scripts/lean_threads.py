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
import time

import lean_common
from lean_common import now_iso, stem

try:
    import fcntl
except ImportError:  # not on Windows: no lock, the write is still atomic
    fcntl = None

RESERVED = {"optimize": "Optimize"}
ID_RE = re.compile(r"^(#\d+|t\d+|optimize)$")


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
            fcntl.flock(lock, fcntl.LOCK_EX)
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
    t = data["threads"].get(tid)
    if t is None:
        if kind_of(tid) == "free" and tid not in RESERVED and not create:
            raise ValueError(f"no such thread {tid} (create it with: lean-agent thread new \"title\")")
        t = data["threads"][tid] = {"id": tid, "title": title or RESERVED.get(tid) or tid, "created": ts or now_iso(),
                                    "last_message": None, "kind": kind_of(tid)}
    elif title and (t.get("title") in (None, "", tid)):
        t["title"] = title
    return t


def new(title):
    title = " ".join(str(title or "").replace('"', "'").split())[:80]
    if not title:
        raise ValueError("a thread needs a title")
    with _locked() as data:
        nums = [int(k[1:]) for k in data["threads"] if re.fullmatch(r"t\d+", k)]
        tid = f"t{max(nums, default=0) + 1}"
        data["threads"][tid] = {"id": tid, "title": title, "created": now_iso(), "last_message": now_iso(), "kind": "free"}
    return tid


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
    if state == "closed" and not t.get("session_id"):
        return []
    return [f'  session: {state}' + (f' \u2014 Remote Control "{name}"' if name else "")]


def session_threads():
    """Ids of the threads whose session the service keeps running, oldest first."""
    ts = load()["threads"]
    return sorted((k for k, t in ts.items() if t.get("session_on")), key=lambda k: int(k[1:]) if k[1:].isdigit() else 0)


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


def threads(now=None, include_expired=False):
    """The threads to show: merged ones are left out (they show under their target), expired ones filtered."""
    data, todos, days = load(), _todo_map(), idle_days()
    now = time.time() if now is None else now
    if "optimize" not in data["threads"]:
        data["threads"]["optimize"] = {"id": "optimize", "title": RESERVED["optimize"], "created": None,
                                       "last_message": None, "kind": "free"}
    tops = {k: dict(t) for k, t in data["threads"].items() if k not in data["aliases"]}
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
EXPLICIT_RE = re.compile(r"(?<![\w/&])(?:#(\d+)|[tT](\d+))\b")


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


def score_threads(prompt, now=None, current=None, data=None):
    """[(score, thread id)] best first for the open threads. Prompt words are weighted by rarity across the threads (idf);
    the score is the weighted share of the prompt's words the thread has (title words count 2x), times a recency
    boost (up to +30%, fading over a day) and +0.1 for the thread the last prompt went to."""
    data = data or load()
    now = time.time() if now is None else now
    pw = words(prompt)
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
        sc = min(1.0, got) * (1 + 0.3 * math.exp(-age_h / 24)) + (0.1 if t["id"] == current else 0)
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
    text = " ".join(str(prompt or "").split())
    now_s = now_iso() if now is None else datetime.datetime.fromtimestamp(now).isoformat(timespec="seconds")
    with _locked() as data:
        t = data["threads"].get(tid)
        if t is None:
            return False
        t["last_message"] = now_s
        data["next_request"] = int(data.get("next_request") or 0) + 1
        t.setdefault("requests", []).append({"id": f"r{data['next_request']}", "ts": now_s, "text": text[:REQUEST_CHARS]})
        del t["requests"][:-REQUESTS_KEPT]
    set_current(tid, session)
    return True


def advise(prompt, session=None, now=None):
    """The main session is the front desk: what the orchestrator should do with a user prompt, in one line. A status
    question is answered there (`now`); a prompt that belongs to an open thread is handed to its session; anything else
    is a new topic for a new thread session. Matched requests are stored under their thread; a new topic creates nothing
    (`thread new` does). Returns (thread id or None, line)."""
    text = " ".join(str(prompt or "").split())
    if is_status_question(text) and not EXPLICIT_RE.search(text):
        return None, "Status question \u2014 answer it here: lean-agent now"
    tid, how, _ = route(text, session, now, create=False)
    if tid is None:
        return None, 'New topic \u2014 start it: lean-agent thread new "<title>" --prompt-file -'
    t = load()["threads"].get(tid) or {}
    title = t.get("title") or tid
    if t.get("session_on"):
        return tid, f'Belongs to {tid} "{title}" \u2014 hand it over: lean-agent thread send {tid} --prompt-file -'
    return tid, f'Belongs to {tid} "{title}" \u2014 hand it over (this starts its session): lean-agent thread send {tid} --prompt-file -'


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
        t.setdefault("requests", []).append({"id": rid, "ts": now_s, "text": text[:REQUEST_CHARS]})
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

NOTIFICATION_RE = re.compile(r"<task-notification|\btask-id\b|Background command .{0,2000}?\b(?:completed|failed|was stopped)\b", re.S)
SYSTEM_PROMPT_RE = re.compile(r"\s*<(?:system-reminder|task-notification|command-|local-command|hook)", re.I)
RUN_ID_RE = re.compile(r"\b\d{4}-\d{6}-[0-9a-f]{4}\b")
OUTPUT_FILE_RE = re.compile(r"<output-file>\s*([^<\s][^<]*?)\s*</output-file>|output[- ]file[:=]\s*(\S+)", re.I)
OUTPUT_READ = 200_000


def is_notification(prompt):
    """A prompt Claude Code (or a hook) wrote, not the user: a background-task notification or a system-tagged message."""
    text = str(prompt or "")
    return bool(NOTIFICATION_RE.search(text) or SYSTEM_PROMPT_RE.match(text))


def thread_of_run(rec, data=None):
    """The thread of a ledger/running record: a `thread move` override, else its tag (merges followed); None if untagged."""
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


def events(data=None, todos=None):
    """{thread id: [(epoch, ts, kind, text)]} in time order: requests, runs, reviews, todos, notes, documents, pushes.
    A record's thread follows `thread move` overrides, then merges; records without a thread are left out."""
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
        out.setdefault(tid, []).append((_epoch(ts), str(ts), kind, one_line(text, 160)))

    for tid, t in data["threads"].items():
        for r in t.get("requests") or []:
            add(tid, r.get("ts"), "request", r.get("text"))
    for kind, key, r in _log_records():
        if kind == "run":
            what = (r.get("result_head") or "").strip().splitlines()
            text = (f"{r.get('id')} {r.get('model') or '?'} {r.get('status') or '?'} {r.get('project') or ''}: "
                    f"{one_line(what[0] if what else r.get('task'), 90)}")
        elif kind == "review":
            text = (f"{r.get('run')} {r['_slug']} {r.get('verdict')}, {len(r.get('findings') or [])} findings"
                    + (f", {len(r.get('gaps') or [])} gaps" if r.get("gaps") else ""))
        else:
            text = (f"{r.get('project')} {r.get('branch')} -> {r.get('to')} {str(r.get('sha') or '')[:8]}"
                    + ("" if r.get("ok", True) else " FAILED"))
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


def _running_by_thread(data):
    out = {}
    home = lean_home()
    for f in glob.glob(os.path.join(home, "running", "*.json")):
        m = lean_common.read_json(f, {})
        if not lean_common.pid_alive(m.get("pid")):
            continue
        if m.get("thread"):
            tid = resolve(m["thread"], data["aliases"])
            out[tid] = out.get(tid, 0) + 1
    return out


def _state(tid, evs, running, data):
    parts = []
    if running.get(tid):
        parts.append(f"{running[tid]} running")
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
        running = _running_by_thread(data)
        closed = autoclose(data, evs, running, todos, days, now) if close_idle else []
        rows = []
        for tid, t in data["threads"].items():
            if t.get("closed") or tid in data["aliases"] or tid in RESERVED:
                continue
            ev = evs.get(tid, [])
            last_ts = max([t.get("last_message") or t.get("created") or ""] + [e[1] for e in ev])
            act = next((e for e in reversed(ev) if e[2] != "request"), None) or (ev[-1] if ev else None)
            rows.append((_epoch(last_ts), last_ts, tid, t, act, _state(tid, ev, running, data),
                         session_lines(tid, t) + _details(tid, ev, data, todos, live, waiting, now)))
    rows.sort(key=lambda r: (r[0], r[2]), reverse=True)
    lines = [f"Open threads ({len(rows)}), latest first:"] if rows else ["No open threads."]
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
    return "\n".join(lines)


def show_text(tid, all_=False, limit=40):
    tid = resolve(norm(tid))
    data = load()
    t = data["threads"].get(tid)
    if t is None:
        raise ValueError(f"no such thread {tid}")
    ev = events(data).get(tid, [])
    head = f'{tid} "{t.get("title")}"' + (" [closed]" if t.get("closed") else "")
    merged = sorted(s for s, d in data["aliases"].items() if resolve(d, data["aliases"]) == tid)
    if merged:
        head += f" (includes {', '.join(merged)})"
    lines = [head]
    shown = ev if all_ or len(ev) <= limit else ev[-limit:]
    if len(shown) < len(ev):
        lines.append(f"... {len(ev) - len(shown)} earlier (lean-agent thread show {tid} --all)")
    lines += [f"{ts[:16].replace('T', ' ')}  {kind:<8} {text}" for _, ts, kind, text in shown]
    if not ev:
        lines.append("(nothing recorded yet)")
    return "\n".join(lines)


def set_closed(tid, closed):
    tid = resolve(norm(tid))
    with _locked() as data:
        t = data["threads"].get(tid)
        if t is None:
            raise ValueError(f"no such thread {tid}")
        if closed:
            t["closed"] = now_iso()
        else:
            t.pop("closed", None)
            t.pop("auto_closed", None)
            t["last_message"] = now_iso()  # reopened: counts as activity, or the next `now` would close it again
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
            ids = [a for a in args if not a.startswith("--")]
            if len(ids) != 1:
                raise ValueError("usage: lean-agent thread show tN [--all]")
            out(show_text(ids[0], "--all" in args))
        elif action in ("close", "reopen"):
            if len(args) != 1:
                raise ValueError(f"usage: lean-agent thread {action} tN")
            out(f"{set_closed(args[0], action == 'close')} {'closed' if action == 'close' else 'open again'}")
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
            raise ValueError("usage: lean-agent thread new|list|show|close|reopen|merge|unmerge|move")
    except ValueError as e:
        out(f"lean-agent: {e}")
        return 1
    return 0
