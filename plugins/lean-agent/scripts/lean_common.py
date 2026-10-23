"""Small helpers shared by lean_agent, dashboard, dash_chat and dash_service (stdlib only, so any of them can import it)."""
import contextlib
import datetime
import glob
import json
import os
import uuid

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_COMPACT_WINDOW = 100000  # the orchestrator's CLAUDE_CODE_AUTO_COMPACT_WINDOW
DEFAULT_COMPACT_PCT = 70  # ...and its CLAUDE_AUTOCOMPACT_PCT_OVERRIDE


def thread_key(tid):
    """The chat key of a thread id: `#12` -> `12`, `t3` stays."""
    tid = str(tid or "")
    return tid[1:] if tid.startswith("#") else tid


def compaction_point(window, pct):
    """Tokens at which Claude Code compacts: the percentage of the window, but never past the window minus its
    fixed autocompact buffer (LEAN_AGENT_COMPACT_BUFFER, default 33,000)."""
    # Claude Code's /context panel shows a 33k autocompact buffer on a 100k window, i.e. compaction at ~67k
    # (the percentage alone would say 70k).
    try:
        buffer = int(os.environ.get("LEAN_AGENT_COMPACT_BUFFER") or 33000)
    except ValueError:
        buffer = 33000
    return int(min(window * pct / 100, window - buffer))


def read_json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


@contextlib.contextmanager
def file_lock(path):
    """Exclusive advisory lock on `path` + '.lock' (read-modify-write of a shared json file)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path + ".lock", "a") as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl:
                fcntl.flock(lock, fcntl.LOCK_UN)


def write_json_atomic(path, data):
    tmp = f"{path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


COLLECTED_CUTOFF = "_cutoff"  # collected.json key: runs recorded before it count as collected (legacy ledger)


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def seed_collected(lean_home):
    """The collected.json of this home: created on first use with a cutoff (now), so ledger entries from before it
    (a ledger older than collected.json) count as collected without writing all their ids."""
    path = os.path.join(lean_home, "collected.json")
    done = read_json(path, None)
    if not isinstance(done, dict):
        with file_lock(path):
            done = read_json(path, None)
            if not isinstance(done, dict):
                done = {COLLECTED_CUTOFF: _now()}
                write_json_atomic(path, done)
    return done


def mark_collected_ids(lean_home, run_ids):
    """Record in collected.json that these runs' results were shown to someone."""
    ids = [r for r in run_ids if r]
    if not ids:
        return
    seed_collected(lean_home)
    path = os.path.join(lean_home, "collected.json")
    with file_lock(path):
        done = read_json(path, {})
        done.update({r: _now() for r in ids})
        write_json_atomic(path, done)


def uncollected_ids(lean_home, live_ids=()):
    """Ids of the finished ordinary (non-role) runs in the ledger whose result was never printed to anyone
    (not in collected.json, recorded after its cutoff), oldest first. The first call without a collected.json seeds
    the cutoff, so a ledger from before this existed isn't reported as waiting. A resumed run counts once, by its
    latest ledger entry."""
    done = seed_collected(lean_home)
    cutoff = done.get(COLLECTED_CUTOFF) or ""
    latest = {}
    try:
        with open(os.path.join(lean_home, "ledger.jsonl")) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("id") and not r.get("role"):
                    latest.pop(r["id"], None)  # keeps the order of the latest entries
                    latest[r["id"]] = r
    except OSError:
        pass
    return [i for i, r in latest.items() if i not in done and i not in live_ids and (r.get("ts") or "") >= cutoff]


def running_runs(lean_home):
    """[(run id, marker)] of the runs in progress, oldest first: running/*.json whose process is alive."""
    out = []
    for f in glob.glob(os.path.join(lean_home, "running", "*.json")):
        try:
            with open(f) as fh:
                m = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(m, dict) and m.get("pid") and pid_alive(m["pid"]):
            out.append((m.get("run") or os.path.basename(f)[:-5], m))
    return sorted(out, key=lambda x: (x[1].get("started") or "", x[0]))


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def plugin_version():
    try:
        with open(os.path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")) as fh:
            return json.load(fh).get("version") or "?"
    except (OSError, ValueError, AttributeError):
        return "?"


def tool_summary(name, inp):
    """One line for a tool call: the command, the file, the pattern ..."""
    inp = inp if isinstance(inp, dict) else {}
    for k in ("command", "file_path", "pattern", "url", "path", "query", "description", "prompt"):
        if inp.get(k):
            return " ".join(str(inp[k]).split())[:300]
    return " ".join(json.dumps(inp)[:200].split())


def questions_of(inp):
    """A multiple-choice question from Claude (AskUserQuestion), for the page to show as buttons."""
    out = []
    for q in (inp or {}).get("questions") or []:
        if isinstance(q, dict) and q.get("question"):
            out.append({"question": q["question"], "header": q.get("header"), "multi": bool(q.get("multiSelect")),
                        "options": [{"label": o.get("label"), "description": o.get("description")}
                                    for o in q.get("options") or [] if isinstance(o, dict) and o.get("label")]})
    return out


def stored_advice(directory, thread):
    """The advice `lean-agent advise` stored in `directory`, oldest first: {ts, thread, project, request, text}
    (only those of the chat thread `thread`)."""
    out = []
    for f in sorted(glob.glob(os.path.join(directory, "*.json"))):
        try:
            with open(f) as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and d.get("text") and d.get("thread") == thread:
            out.append(d)
    return out
