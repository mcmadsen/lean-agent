"""The thread registry (`lean-agent thread`): every message in the one service session belongs to a thread.

Task threads are tagged `About #N "title":`, free threads `Thread tN "title":`. The registry lives in
~/.lean-agent/chat/threads.json (written atomically under a lock): the threads, the aliases left by merges (merged id ->
target id) and per-message moves. Aliases and moves are kept here, never in the transcript, so they survive /clear,
restarts and compaction.

Expiry is a filter in `list`, nothing is deleted: a task thread leaves the list 7 days after its todo is Done, a free
thread after 7 days without a message. The id `optimize` is reserved for the optimize suggestions.
"""
import contextlib
import datetime
import json
import os
import re
import time

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
    return lean_home("chat", "threads.json")


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
    return {"threads": {}, "aliases": {}, "moves": {}}


def load():
    try:
        with open(path()) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        data = _empty()
    for k in ("threads", "aliases", "moves"):
        if not isinstance(data.get(k), dict):
            data[k] = {}
    return data


@contextlib.contextmanager
def _locked():
    """Read-modify-write: hold the lock from load to the atomic replace; yields the data to change."""
    os.makedirs(os.path.dirname(path()), exist_ok=True)
    with open(path() + ".lock", "a") as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
        data = load()
        yield data
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


def touch(tid, title=None, ts=None):
    """A message was seen in `tid` (registered if the registry doesn't know it yet); returns the thread."""
    tid = norm(tid)
    with _locked() as data:
        t = _ensure(data, tid, title, ts, create=True)
        if not ts or not t.get("last_message") or _epoch(ts) >= _epoch(t["last_message"]):
            t["last_message"] = ts or now_iso()
        return dict(t)


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
    return resolve(dst, data["aliases"])


def unmerge(src):
    src = norm(src)
    with _locked() as data:
        if src not in data["aliases"]:
            raise ValueError(f"{src} isn't merged into anything")
        del data["aliases"][src]
        if src in data["threads"]:
            data["threads"][src].pop("merged_into", None)
            data["threads"][src].pop("merged_at", None)


def move(message_id, thread):
    thread = norm(thread)
    message_id = str(message_id or "").strip()
    if not message_id:
        raise ValueError("a message id is needed")
    with _locked() as data:
        _ensure(data, thread)
        data["moves"][message_id] = thread


def mark_once(key):
    """True the first time `key` is seen (a transcript record whose thread operation was applied); False after."""
    with _locked() as data:
        seen = data.setdefault("applied", [])
        if key in seen:
            return False
        seen.append(key)
        del seen[:-500]
        return True


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
                out(f"{t['id']:<9}{t['kind']:<6}{(t.get('last_message') or '-'):<21}{t['title']}")
        elif action in ("merge", "move") and len(args) != 2 or action == "unmerge" and len(args) != 1:
            raise ValueError({"merge": "usage: lean-agent thread merge tB tA", "move": "usage: lean-agent thread move <message-id> <thread>",
                              "unmerge": "usage: lean-agent thread unmerge tB"}[action])
        elif action == "merge":
            out(f"{norm(args[0])} -> {merge(*args)}")
        elif action == "unmerge":
            unmerge(args[0])
            out(f"{norm(args[0])} is its own thread again")
        elif action == "move":
            move(*args)
            out(f"{args[0]} -> {norm(args[1])}")
        else:
            raise ValueError("usage: lean-agent thread new|list|merge|unmerge|move")
    except ValueError as e:
        out(f"lean-agent: {e}")
        return 1
    return 0
