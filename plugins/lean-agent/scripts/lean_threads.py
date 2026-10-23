"""The thread registry (`lean-agent thread`): every message in the one service session belongs to a thread.

Task threads are tagged `About #N "title":`, free threads `Thread tN "title":`. The registry lives in
~/.lean-agent/threads.json (written atomically under a lock): the threads, the aliases left by merges (merged id ->
target id) and the overrides left by `thread move` (record kind+id -> thread; the ledger, review and push logs are
append-only, so a re-homed record is overridden here). Kept here, never in the transcript, so they survive /clear,
restarts and compaction.

Expiry is a filter in `list`, nothing is deleted: a task thread leaves the list 7 days after its todo is Done, a free
thread after 7 days without a message. The id `optimize` is reserved for the optimize suggestions.
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

try:
    import fcntl
except ImportError:  # not on Windows: no lock, the write is still atomic
    fcntl = None

EXPIRE_DAYS = 7
RESERVED = {"optimize": "Optimize"}
ID_RE = re.compile(r"^(#\d+|t\d+|optimize)$")


def lean_home(*parts):
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


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


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


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


def _todo_state(tid):
    """("done", epoch) | ("open", 0) for the todo `#N`; None when there is no such todo."""
    try:
        with open(lean_home("todo.json")) as fh:
            items = json.load(fh).get("items") or []
    except (OSError, ValueError, AttributeError):
        return None
    for t in items:
        if isinstance(t, dict) and f"#{t.get('id')}" == tid:
            return ("done", _epoch(t.get("done_at"))) if t.get("status") == "done" else ("open", 0)
    return None


def expired(t, now=None):
    """A task thread 7 days after its todo is Done, a free one (or a task without a todo) after 7 days without a message."""
    now = time.time() if now is None else now
    limit = EXPIRE_DAYS * 86400
    if t["id"] in RESERVED:
        return False
    state = _todo_state(t["id"]) if t.get("kind") == "task" else None
    if state:
        return state[0] == "done" and now - state[1] > limit
    return bool(t.get("last_message")) and now - _epoch(t["last_message"]) > limit


def threads(now=None, include_expired=False):
    """The threads to show: merged ones are left out (they show under their target), expired ones filtered."""
    data = load()
    if "optimize" not in data["threads"]:
        data["threads"]["optimize"] = {"id": "optimize", "title": RESERVED["optimize"], "created": None,
                                       "last_message": None, "kind": "free"}
    tops = {k: dict(t) for k, t in data["threads"].items() if k not in data["aliases"]}
    for src, dst in data["aliases"].items():  # the target's last message counts its merged threads' too (before expiry)
        tgt = tops.get(resolve(dst, data["aliases"]))
        s = data["threads"].get(src) or {}
        if tgt and s.get("last_message") and (not tgt.get("last_message") or _epoch(s["last_message"]) > _epoch(tgt["last_message"])):
            tgt["last_message"] = s["last_message"]
    out = [t for t in tops.values() if include_expired or not expired(t, now)]
    return sorted(out, key=lambda t: (t.get("last_message") or "", t["id"]), reverse=True)


# ------------------------------------------------------------------ automatic threads (the prompt hook)

MATCH_THRESHOLD = 0.4  # share of the prompt's (idf-weighted) words found in a thread, after the recency boost
REQUESTS_KEPT = 20
REQUEST_CHARS = 300
STOP = set("""the a an and or but if then else for to of in on at by with from into onto about as is are was were be been
being do does did done have has had it its this that these those there here we you i me my our your they them he she
can could would should will shall may might must not no yes ok okay please just also so very more most some any all
what which who whom how why when where than too lets let get got make made use using new need want like again still
now thanks thank hello hey hi""".split())
EXPLICIT_RE = re.compile(r"(?<![\w/&])(?:#(\d+)|[tT](\d+))\b")


def stem(w):
    for suffix in ("ing", "ed", "es", "s"):
        if len(w) > len(suffix) + 3 and w.endswith(suffix):
            return w[:-len(suffix)]
    return w


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


def route(prompt, session=None, now=None):
    """Assign a user prompt to a thread without any model call; stores the request and the current-thread state.
    Returns (thread id, how, context line) with how in explicit|guessed|new."""
    text = " ".join(str(prompt or "").split())
    now_s = now_iso()
    m = EXPLICIT_RE.search(text)
    with _locked() as data:
        tid, how = None, None
        if m:
            cand = resolve(f"#{int(m.group(1))}" if m.group(1) else f"t{int(m.group(2))}", data["aliases"])
            if cand in data["threads"] or cand.startswith("#"):
                tid, how = cand, "explicit"
                _ensure(data, tid, title_from(text), create=True)
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
            elif not words(text) and cur and cur in data["threads"] and not data["threads"][cur].get("closed") \
                    and cur not in data["aliases"]:
                tid, how = cur, "guessed"  # "yes, go ahead": no content words, it continues the last topic
        if tid is None:
            nums = [int(k[1:]) for k in data["threads"] if re.fullmatch(r"t\d+", k)]
            tid, how = f"t{max(nums, default=0) + 1}", "new"
            data["threads"][tid] = {"id": tid, "title": title_from(text), "created": now_s, "last_message": now_s, "kind": "free"}
        t = data["threads"][tid]
        t["last_message"] = now_s
        t.setdefault("requests", []).append({"ts": now_s, "text": text[:REQUEST_CHARS]})
        del t["requests"][:-REQUESTS_KEPT]
        title = t["title"]
    set_current(tid, session)
    if how == "new":
        line = f'New thread {tid} "{title}"'
    elif how == "guessed":
        line = f'Thread {tid} "{title}" (guessed; wrong? lean-agent thread move tN)'
    else:
        line = f'Thread {tid} "{title}"'
    return tid, how, line


# ------------------------------------------------------------------ show the work (`now`, `thread show`)

IDLE_DAYS = 7  # `now` closes an open thread with no activity for this long (LEAN_AGENT_THREAD_IDLE_DAYS or config thread_idle_days)
NOW_LINES = 25
KINDS = ['request', 'run', 'review', 'todo', 'note', 'doc', 'push']


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


def _json(p, default):
    try:
        with open(p) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


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


def events(data=None):
    """{thread id: [(epoch, ts, kind, text)]} in time order: requests, runs, reviews, todos, notes, documents, pushes.
    A record's thread follows `thread move` overrides, then merges; records without a thread are left out."""
    data = data or load()
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
    todo = _json(lean_home("todo.json"), {})
    for t in (todo.get("items") if isinstance(todo, dict) else None) or []:
        if isinstance(t, dict):
            add(t.get("thread"), t.get("created"), "todo", f"#{t.get('id')} {t.get('status')} {t.get('text')}")
    notes = _json(lean_home("handoff-notes.json"), [])
    for n in notes if isinstance(notes, list) else []:
        if isinstance(n, dict):
            m = re.match(r"^artifact: (\S+) (.*)$", n.get("text") or "")
            if m:
                add(n.get("thread"), n.get("ts"), "doc", f"{m.group(2)} {m.group(1)}")
            else:
                add(n.get("thread"), n.get("ts"), "note", f"{n.get('kind') or 'note'}: {n.get('text')}")
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
        m = _json(f, {})
        try:
            os.kill(int(m.get("pid")), 0)
        except (OSError, ValueError, TypeError):
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


def autoclose(data, evs, running, now=None):
    """Close (never delete) the open threads idle longer than idle_days(); returns their ids. Caller saves."""
    now = time.time() if now is None else now
    gone = []
    for tid, t in data["threads"].items():
        if t.get("closed") or tid in data["aliases"] or tid in RESERVED or running.get(tid):
            continue
        last = max([_epoch(t.get("last_message") or t.get("created"))] + [e[0] for e in evs.get(tid, [])])
        if now - last > idle_days() * 86400:
            t["closed"], t["auto_closed"] = now_iso(), True
            gone.append(tid)
    return gone


def now_text(now=None, close_idle=True, max_lines=NOW_LINES):
    """Open threads by last activity: id, title, state, last action and age (<= max_lines lines)."""
    with _locked() as data:
        evs = events(data)
        running = _running_by_thread(data)
        closed = autoclose(data, evs, running, now) if close_idle else []
        rows = []
        for tid, t in data["threads"].items():
            if t.get("closed") or tid in data["aliases"] or tid in RESERVED:
                continue
            ev = evs.get(tid, [])
            last_ts = max([t.get("last_message") or t.get("created") or ""] + [e[1] for e in ev])
            act = next((e for e in reversed(ev) if e[2] != "request"), None) or (ev[-1] if ev else None)
            rows.append((_epoch(last_ts), last_ts, tid, t, act, _state(tid, ev, running, data)))
    rows.sort(key=lambda r: (r[0], r[2]), reverse=True)
    lines = [f"Open threads ({len(rows)}), latest first:"] if rows else ["No open threads."]
    for _, last_ts, tid, t, act, state in rows[:max_lines - 2]:
        lines.append(f"{tid:<4} {one_line(t['title'], 40):<40} {state:<22} {age(last_ts, now):>4}  "
                     + (f"{act[2]}: {one_line(act[3].split(' ', 1)[-1] if act[2] in ('run', 'review') else act[3], 60)}" if act else "-"))
    if len(rows) > max_lines - 2:
        lines.append(f"... and {len(rows) - max_lines + 2} older (lean-agent thread list)")
    if closed:
        lines.append(f"Closed as idle (> {idle_days():g} days): {', '.join(closed)} (lean-agent thread reopen tN)")
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


def _retag(path, items_of, thread, new, since, aliases, ts_key):
    """Rewrite, under the file's lock, the thread of the entries of `thread` from `since` on."""
    with lean_common.file_lock(path):
        doc = _json(path, None)
        items = items_of(doc)
        hit = [e for e in items if isinstance(e, dict) and _tagged(e.get("thread"), thread, aliases) and _epoch(e.get(ts_key)) >= since]
        for e in hit:
            e["thread"] = new
        if hit:
            lean_common.write_json_atomic(path, doc)


def move_latest(tid, session=None):
    """Wrong thread: the latest request of this session goes to `tid`, `tid` becomes the current thread, and what the old
    thread recorded since that request is re-homed: the append-only logs through the overrides, todo.json and the hand-off
    notes in place. Returns (old thread, new thread)."""
    tid = norm(tid)
    st = _json(state_path(), {})
    rec = ((st.get("sessions") or {}).get(session or "") or st.get("latest") or {}) if isinstance(st, dict) else {}
    if not rec.get("thread"):
        raise ValueError("no current thread to move a request out of")
    with _locked() as data:
        old, tid = resolve(rec["thread"], data["aliases"]), resolve(tid, data["aliases"])
        if old == tid:
            raise ValueError(f"the latest request is in {tid} already")
        reqs = (data["threads"].get(old) or {}).get("requests") or []
        if not reqs:
            raise ValueError(f"{old} has no request to move")
        req = reqs.pop()
        since = _epoch(req["ts"])
        dst = _ensure(data, tid, title_from(req["text"]))
        dst.pop("closed", None)
        dst.pop("auto_closed", None)
        dst.setdefault("requests", []).append(req)
        dst["requests"].sort(key=lambda r: _epoch(r.get("ts")))
        dst["last_message"] = max([dst.get("last_message") or "", req["ts"]], key=_epoch)
        src = data["threads"][old]
        src["last_message"] = reqs[-1]["ts"] if reqs else src.get("created")
        for kind, key, r in _log_records():
            if data["overrides"].get(key) is None and _tagged(r.get("thread"), old, data["aliases"]) and _epoch(r.get("ts")) >= since:
                data["overrides"][key] = tid
            elif data["overrides"].get(key) == old and _epoch(r.get("ts")) >= since:
                data["overrides"][key] = tid
        _retag(lean_home("todo.json"), lambda d: (d.get("items") if isinstance(d, dict) else None) or [], old, tid, since,
               data["aliases"], "created")
        _retag(lean_home("handoff-notes.json"), lambda d: d if isinstance(d, list) else [], old, tid, since, data["aliases"], "ts")
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
        elif action == "merge" and len(args) != 2 or action in ("unmerge", "move") and len(args) != 1:
            raise ValueError({"merge": "usage: lean-agent thread merge tB tA", "move": "usage: lean-agent thread move tN",
                              "unmerge": "usage: lean-agent thread unmerge tB"}[action])
        elif action == "merge":
            merge(*args)
            out(f"{norm(args[0])} -> {resolve(norm(args[1]))}")
        elif action == "unmerge":
            unmerge(args[0])
            out(f"{norm(args[0])} is its own thread again")
        elif action == "move":
            old, new_ = move_latest(args[0])
            out(f"the latest request moved from {old} to {new_}")
        else:
            raise ValueError("usage: lean-agent thread new|list|show|close|reopen|merge|unmerge|move")
    except ValueError as e:
        out(f"lean-agent: {e}")
        return 1
    return 0
