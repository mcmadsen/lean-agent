"""The dashboard's side of the one service session (service_session.py, hosted by `lean-agent up`).

Instead of its own Claude Code processes, the dashboard types into the orchestrator session through the bridge and
reads what happened from that session's transcript JSONL (incrementally, by byte offset), so the Claude app and the
dashboard show the same conversation. Every message belongs to a thread: dashboard messages arrive tagged (`About #N
"title": ...` for a task thread, `Thread tN "title": ...` for another topic); the sends are remembered
(chat/service_sends.jsonl) so the transcript's user turns can be matched back to the thread they came from. An untagged
turn takes the thread of the first tag in the reply that follows (and the reply may lift a routing line, see
`parse_reply`). A thread's view is its own user turns plus the assistant and tool events that follow, until the next
user turn; merges (aliases) and per-message moves come from the registry (lean_threads.py); "main" shows everything.

Permission prompts: the PermissionRequest hook (permission_hook.py) hands a request to the dashboard as a file in
chat/perm/ while a dashboard tab is polling (chat/dash-poll is touched on every poll); the page's answer is written
beside it and the hook returns it to Claude Code. /clear inside the session starts a new transcript with a new id:
the SessionStart hook (session_hook.py) records the current one in chat/service.json (any source: startup, resume,
clear, compact), and the dashboard follows it (a record older than the session `up` started is ignored).
"""
import datetime
import functools
import json
import math
import os
import re
import threading
import time

import lean_threads
from lean_common import pid_alive, questions_of, thread_key, tool_summary  # noqa: F401

MAX_EVENTS = 2000
FRESH_SECS = 20  # a dashboard tab polled this recently counts as someone looking
WORKING_SECS = 60  # no transcript change for this long and no tool running: not shown as working
QUIET_SECS = 8   # a transcript untouched this long after an assistant text: the turn is over
TAG_RE = re.compile(r'^\s*(?:About\s+(#\d+)|Thread\s+(t\d+|optimize))\b(?:\s*"([^"\n]*)")?\s*:?')  # the thread tag a text starts with
_ID = r"(?:#\d+|t\d+)"
ROUTED_RE = re.compile(rf"Routed to ({_ID})\.(?: Also close: ({_ID}(?:, {_ID})*)\.)?")
STARTED_RE = re.compile(r"Started a new thread: (.+)\.")
MOVE_RE = re.compile(r"^Move message to (#?\d+|[tT]\d+|optimize)\b(?: \(([^)]+)\))?")
MERGE_RE = re.compile(r"^Merge thread (\S+) into ([^\s.]+?)\.?(?: \[op (\w+)\])?\s*$")
UNMERGE_RE = re.compile(r"^Unmerge thread ([^\s.]+?)\.?(?: \[op (\w+)\])?\s*$")
OP_RE = re.compile(r" \[op (\w+)\]\s*$")


def canon(key):
    """A thread key as the registry spells it (`12` -> `#12`); "main", None and keys of other forms stay as they are."""
    if key in (None, "main"):
        return key
    try:
        return lean_threads.norm(key)
    except ValueError:
        return str(key)


def legacy_key(tid):
    """What the page's `about` carries: the task number without `#`, or the thread id."""
    return thread_key(tid)


def parse_reply(text):
    """(thread, title, routing, shown) of an assistant text: the thread tag it starts with, and the routing line
    (`Routed to #N.`, `Routed to #N. Also close: #M.`, `Started a new thread: <title>.`) when that is exactly its first
    line after the tag; `shown` is the text without that line."""
    m = TAG_RE.match(text)
    tid = (m.group(1) or m.group(2)) if m else None
    prefix = text[:m.end()] if m else ""
    rest = text[m.end():] if m else text
    body = rest.lstrip()
    line, _, after = body.partition("\n")
    line = line.strip()
    routing = None
    r = ROUTED_RE.fullmatch(line)
    if r:
        routing = {"text": line, "target": r.group(1), "also": r.group(2).split(", ") if r.group(2) else []}
    elif STARTED_RE.fullmatch(line):
        routing = {"text": line, "target": tid, "also": [], "title": STARTED_RE.fullmatch(line).group(1)}
    if not routing:
        return tid, (m.group(3) if m else None), None, text
    after = after.strip()
    shown = (prefix.rstrip() + ("\n" if after else "") + after).strip() if prefix.strip() else after
    return tid, (m.group(3) if m else None), routing, shown


def lean_home(*parts):
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


def chat_dir(*parts):
    return lean_home("chat", *parts)


def _load(path, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {} if default is None else default


def _epoch(ts):
    try:
        return datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


# ------------------------------------------------------------------ dashboard presence and permission files

def touch_poll():
    try:
        os.makedirs(chat_dir(), exist_ok=True)
        with open(chat_dir("dash-poll"), "w") as fh:
            fh.write(str(time.time()))
    except OSError:
        pass


def dashboard_fresh(secs=FRESH_SECS):
    try:
        return time.time() - os.stat(chat_dir("dash-poll")).st_mtime < secs
    except OSError:
        return False


def perm_dir():
    return chat_dir("perm")


def write_json(path, obj):
    # not lean_agent.save_json: that module is the whole CLI, and the permission hook must start fast
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh)
    os.replace(tmp, path)


def service_session_ids():
    """The ids the hook accepts as the service session: the one `up` started and the one the dashboard follows."""
    ids = set()
    up = _load(lean_home("up.json"))
    if up.get("session_id"):
        ids.add(up["session_id"])
    cur = _load(chat_dir("service.json"))
    if cur.get("session_id"):
        ids.add(cur["session_id"])
    return ids


# ------------------------------------------------------------------ the transcript model

def suggestion_rules(suggestions):
    """What "Always allow" will allow, as rules like `Bash(git status:*)` (empty when the suggestion has no rule)."""
    out = []
    for s in suggestions or []:
        for r in (s.get("rules") or []) if isinstance(s, dict) else []:
            if isinstance(r, dict) and r.get("toolName"):
                out.append(r["toolName"] + (f"({r['ruleContent']})" if r.get("ruleContent") else ""))
    return out[:5]


def _locked(fn):
    """Handler threads (and Chat.summary) call the model under different locks: serialise them on the model's own."""
    @functools.wraps(fn)
    def run(self, *a, **kw):
        with self.lock:
            return fn(self, *a, **kw)
    return run


class Model:
    """The events of the service session's transcript, as the page renders them."""

    def __init__(self):
        self.lock = threading.RLock()
        self.events = []
        self.turns = {0: {"thread": None, "open": False, "ts": 0}}
        self.turn = 0
        self.counter = 0
        self.path = None
        self.offset = 0
        self.sid = None
        self.tools = {}
        self.sends = {}
        self.send_log = []
        self.sends_size = -1
        self.last_kind = None  # what the transcript's last record was: "user", "tool", "text", "done"
        self.perms = {}
        self.reg = {"aliases": {}, "moves": {}}
        self.reg_stamp = None
        self.touched = {}  # thread id -> (title, last message time), written to the registry after a refresh

    # --- following the right transcript
    def _pick(self, up):
        """The transcript the hook last recorded when it is another session than `up` started and its file exists
        (a /clear started it); `up`'s transcript otherwise."""
        base = up.get("transcript")
        if not base:
            return None
        rec = _load(chat_dir("service.json"))
        try:
            started = time.mktime(time.strptime(up.get("session_started", ""), "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            started = 0
        ts = rec.get("ts")
        try:
            stale = not isinstance(ts, (int, float)) or isinstance(ts, bool) or not math.isfinite(ts) or ts < started
        except (OverflowError, TypeError, ValueError):
            stale = True
        if stale:  # corrupt, or left by a previous run
            return base
        path = rec.get("transcript_path")
        if rec.get("session_id") and rec.get("session_id") != up.get("session_id") and path and os.path.isfile(path):
            return path
        return base

    def _registry(self):
        """The registry's aliases and moves; a change re-sends the events, as their threads may differ now."""
        try:
            st = os.stat(lean_threads.path())
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            stamp = None
        if stamp == self.reg_stamp:
            return
        self.reg_stamp = stamp
        data = lean_threads.load()
        reg = {"aliases": data["aliases"], "moves": data["moves"]}
        if reg != self.reg:
            self.reg = reg
            for e in self.events:
                self._update(e)

    def _thread(self, turn):
        """The thread a turn is shown under: its per-message move, else its tag, followed through the merges."""
        t = self.turns.get(turn) or {}
        raw = self.reg["moves"].get(t.get("mid")) or t.get("thread")
        return lean_threads.resolve(raw, self.reg["aliases"]) if raw else None

    def _touch(self, tid, title, ts):
        if tid and tid != "main" and lean_threads.ID_RE.match(tid):
            old = self.touched.get(tid, (None, 0))
            self.touched[tid] = (title or old[0], max(old[1], ts or 0))

    def _flush_touched(self):
        todo, self.touched = self.touched, {}
        for tid, (title, ts) in todo.items():
            try:
                lean_threads.touch(tid, title, datetime.datetime.fromtimestamp(ts).isoformat(timespec="seconds") if ts else None)
            except (OSError, ValueError):
                pass

    @_locked
    def refresh(self):
        up = _load(lean_home("up.json"))
        self._sends()
        self._registry()
        path = self._pick(up)
        if not path:
            return
        if path != self.path:
            first = self.path is None
            self.path, self.offset, self.tools = path, 0, {}
            self.sid = os.path.basename(path)[:-6]
            if not first:
                self._add(kind="note", text="new conversation")
                self.turn = max(self.turns) + 1
                self.turns[self.turn] = {"thread": None, "open": False, "ts": time.time()}
        try:
            size = os.path.getsize(path)
        except OSError:  # not written yet
            size = 0
        if size < self.offset:  # rewritten: read it again
            self.offset, self.events, self.tools = 0, [], {}
        if size > self.offset:
            with open(path, "rb") as fh:
                fh.seek(self.offset)
                data = fh.read(size - self.offset)
            end = data.rfind(b"\n") + 1  # a half-written last line waits for the next read
            self.offset += end
            for line in data[:end].splitlines():
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    self._record(rec)
            del self.events[:-MAX_EVENTS]
        self._scan_perms()
        if self.touched:
            self._flush_touched()
            self._registry()

    def _sends(self):
        p = chat_dir("service_sends.jsonl")
        try:
            size = os.path.getsize(p)
        except OSError:
            return
        if size == self.sends_size:
            return
        self.sends_size = size
        self.sends, self.send_log = {}, []
        try:
            with open(p) as fh:
                for line in fh:
                    try:
                        s = json.loads(line)
                        self.sends[str(s["sent"]).strip()] = s
                        self.send_log.append(s)
                    except (ValueError, KeyError):
                        pass
        except OSError:
            pass

    # --- records to events
    def _add(self, **e):
        self.counter += 1
        e = dict(e, i=self.counter, turn=self.turn)
        e.setdefault("ts", datetime.datetime.now().isoformat(timespec="seconds"))
        self.events.append(e)
        return e

    def _update(self, e, **kw):
        self.counter += 1
        e.update(kw, changed=self.counter)

    def _ts(self, rec):
        t = rec.get("timestamp")
        if t:
            try:
                return datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00")).astimezone().replace(
                    tzinfo=None).isoformat(timespec="seconds")
            except ValueError:
                pass
        return datetime.datetime.now().isoformat(timespec="seconds")

    def _close(self, rec, error=False):
        t = self.turns[self.turn]
        if not t["open"]:
            return
        t["open"] = False
        for e in list(self.tools.values()):
            self._update(e, state="stopped")
        self.tools.clear()
        secs = rec.get("durationMs")
        self._add(kind="result", cost=None, turns=None, error=error, seconds=round((secs or 0) / 1000), ts=self._ts(rec))
        self.last_kind = "done"

    def _user_turn(self, text, rec):
        text = text.strip()
        if not text:
            return
        if text.startswith("[Request interrupted by user"):
            t = self.turns[self.turn]
            if t["open"]:
                t["open"] = False
                for e in list(self.tools.values()):
                    self._update(e, state="stopped")
                self.tools.clear()
            self._add(kind="note", text="stopped by you", ts=self._ts(rec))
            self.last_kind = "done"
            return
        if text.startswith(("<command-", "<local-command", "Caveat: The messages below")):
            return  # slash-command bookkeeping, not something anyone typed
        sent = self.sends.get(text)
        key = canon(sent.get("key")) if sent and sent.get("key") != "main" else None
        title = None
        op = None
        if not key:
            m = TAG_RE.match(text)
            if m:
                key, title = m.group(1) or m.group(2), m.group(3)
            op, key = self._thread_op(text, rec, sent) or (None, key)
        self.turn = max(self.turns) + 1
        self.turns[self.turn] = {"thread": key, "open": True, "ts": _epoch(rec.get("timestamp")), "untagged": key is None,
                                 "mid": rec.get("uuid")}
        self._touch(key, title, self.turns[self.turn]["ts"])
        self._add(kind="user", text=(sent or {}).get("shown") or text, raw=(sent or {}).get("raw"), mid=rec.get("uuid"),
                  from_app=sent is None, ts=self._ts(rec), at=self.turns[self.turn]["ts"], **({"op": op} if op else {}))
        self.last_kind = "user"

    def _thread_op(self, text, rec, sent):
        """The dashboard's `Move message to`, `Merge thread` and `Unmerge thread` messages: (op, thread they show
        under), each applied to the registry once, in transcript order, keyed by its op id, else its record id (the API applies
        them too, so an op id already applied is skipped)."""
        op = None
        if m := MOVE_RE.match(text):
            om = OP_RE.search(text)
            op = {"type": "move", "to": canon(m.group(1)), "message": m.group(2), "id": om and om.group(1)}
            thread = op["to"]
        elif m := MERGE_RE.match(text):
            op = {"type": "merge", "from": canon(m.group(1)), "into": canon(m.group(2)), "id": m.group(3)}
            thread = op["into"]
        elif m := UNMERGE_RE.match(text):
            op = {"type": "unmerge", "from": canon(m.group(1)), "id": m.group(2)}
            thread = op["from"]
        else:
            return None
        once = rec.get("uuid") or f"{rec.get('timestamp')}:{text}"
        if op["id"] or lean_threads.mark_once(once):  # an op id is deduplicated by the registry itself
            try:
                if op["type"] == "move" and op["message"]:
                    lean_threads.move(op["message"], op["to"], op["id"])
                elif op["type"] == "merge":
                    lean_threads.merge(op["from"], op["into"], op["id"])
                elif op["type"] == "unmerge":
                    lean_threads.unmerge(op["from"], op["id"])
            except ValueError:
                pass
            self.reg_stamp = None
            self._registry()
        return op, thread

    def _attach_reply(self, text):
        """The first assistant text after an untagged user turn that starts with a thread tag (or carries a routing line)
        moves the pair to that thread; returns the text to show, without the routing line."""
        t = self.turns[self.turn]
        if not t.get("untagged") or t["thread"]:
            return text
        tid, title, routing, shown = parse_reply(text)
        tid = tid or (routing and routing["target"])
        if not tid:
            return text
        t.pop("untagged", None)
        t["thread"] = tid
        self._touch(tid, title or (routing or {}).get("title"), t["ts"])
        for e in self.events:
            if e["turn"] == self.turn and e["kind"] == "user":
                self._update(e, **({"routing": dict(routing, target=lean_threads.resolve(routing["target"], self.reg["aliases"]) if routing["target"] else None)} if routing else {}))
        return shown

    def _record(self, rec):
        if rec.get("isSidechain"):
            return
        t = rec.get("type")
        msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        if t == "user":
            if rec.get("isMeta"):
                return
            c = msg.get("content")
            if isinstance(c, str):
                self._user_turn(c, rec)
            for b in c if isinstance(c, list) else []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "tool_result" and b.get("tool_use_id") in self.tools:
                    out = b.get("content")
                    if isinstance(out, list):
                        out = " ".join(str(x.get("text", "")) for x in out if isinstance(x, dict))
                    self._update(self.tools.pop(b["tool_use_id"]), state="error" if b.get("is_error") else "done",
                                 output=" ".join(str(out or "").split())[:400])
                    self.last_kind = "tool"
                elif b.get("type") == "text":
                    self._user_turn(str(b.get("text") or ""), rec)
        elif t == "assistant":
            if not self.turns[self.turn]["open"] and self.turn:
                self.turns[self.turn]["open"] = True  # an assistant reply with no user turn of ours: a queued or hook turn
            for b in msg.get("content") or [] if isinstance(msg.get("content"), list) else []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and str(b.get("text") or "").strip():
                    shown = self._attach_reply(b["text"])
                    if shown.strip():
                        self._add(kind="assistant", text=shown, ts=self._ts(rec))
                    self.last_kind = "text"
                elif b.get("type") == "tool_use":
                    self._ran_in_app(b.get("name"), tool_summary(b.get("name"), b.get("input")), self._ts(rec))
                    self.tools[b.get("id")] = self._add(kind="tool", name=b.get("name"), state="running", ts=self._ts(rec),
                                                        text=tool_summary(b.get("name"), b.get("input")))
                    self.last_kind = "tool"
            if msg.get("stop_reason") == "end_turn" and not self.tools:
                self._close(rec)
        elif t == "system" and rec.get("subtype") == "turn_duration":
            self._close(rec)
        elif t == "system" and rec.get("subtype") == "compact_boundary":
            self._add(kind="note", text="the conversation was compacted", ts=self._ts(rec))

    # --- permission requests from the hook
    def _ran_in_app(self, name, text, ts):
        """A prompt the dashboard didn't answer in time moved to the app; when its tool runs, it was allowed there."""
        for e in self.perms.values():
            if e["state"] == "in_app" and e["name"] == name and e["text"] == text:
                self._update(e, state="allowed", where="app", answered_at=ts)
                return

    def _scan_perms(self):
        d = perm_dir()
        for n in _listdir(d):
            if not n.endswith(".json") or n.endswith((".answer.json", ".moved.json")):
                continue
            rid = n[:-5]
            req = _load(os.path.join(d, n))
            if not req or rid in self.perms:
                continue
            if req.get("session_id") and self.sid and req["session_id"] != self.sid:
                continue
            self.perms[rid] = self._add(
                kind="permission", rid=rid, name=req.get("tool_name"), state="pending",
                text=tool_summary(req.get("tool_name"), req.get("tool_input")),
                can_always=bool(suggestion_rules(req.get("permission_suggestions"))),  # no rule suggested: no button
                always_rule=suggestion_rules(req.get("permission_suggestions")),
                wait=float(req.get("wait") or 300),
                deadline=float(req.get("ts") or time.time()) + float(req.get("wait") or 300),  # epoch seconds
                description=None, questions=questions_of(req.get("tool_input")) if req.get("tool_name") == "AskUserQuestion" else None)
            self.perms[rid]["_req"] = req
        for rid, e in self.perms.items():
            if e["state"] == "pending":
                req = e["_req"]
                gone = not os.path.exists(os.path.join(d, rid + ".json"))
                moved = os.path.join(d, rid + ".moved.json")
                if os.path.exists(moved):  # the hook gave up waiting: Claude Code asks in the app now
                    self._update(e, state="in_app", where="app")
                    try:
                        os.remove(moved)
                    except OSError:
                        pass
                elif gone or not pid_alive(req.get("pid")) or time.time() - req.get("ts", 0) > req.get("wait", 300) + 30:
                    self._update(e, state="expired")

    @_locked
    def answer(self, rid, allow, always=False, message=None, answers=None):
        e = self.perms.get(rid)
        if not e or e["state"] != "pending":
            return {"ok": False, "error": "that prompt isn't waiting any more"}
        always = bool(always and e.get("can_always"))
        write_json(os.path.join(perm_dir(), rid + ".answer.json"),
                   {"allow": bool(allow), "always": always, "message": message, "answers": answers or None})
        self._update(e, state=("answered" if answers else "always" if always else "allowed") if allow else "denied",
                     answers=answers or None, where="dashboard",
                     answered_at=datetime.datetime.now().isoformat(timespec="seconds"))
        return {"ok": True}

    # --- views
    def _want(self, key):
        return lean_threads.resolve(canon(key), self.reg["aliases"])

    def _mine(self, key):
        if key == "main":
            return list(self.events)
        want = self._want(key)
        return [e for e in self.events if self._thread(e["turn"]) == want]

    @_locked
    def snapshot(self, key, since=0, fresh_at=0):
        self._registry()
        evs = self._mine(key)
        if fresh_at:
            evs = [e for e in evs if self.turns.get(e["turn"], {}).get("ts", 0) >= fresh_at]
        evs = evs[-600:]
        out = []
        for e in evs:
            if max(e["i"], e.get("changed", 0)) > since:
                c = {k: v for k, v in e.items() if k not in ("_req", "turn", "at", "raw")}
                th = self._thread(e["turn"])
                c["thread"] = th
                if th:
                    c["about"] = legacy_key(th)
                if key != "main" and e["kind"] == "user" and e.get("raw"):
                    c["text"] = e["raw"]
                out.append(c)
        cursor = max([max(e["i"], e.get("changed", 0)) for e in evs] or [0])
        return {"status": self.status(key), "work_since": self.work_since(key), "session": self.sid, "events": out, "cursor": cursor, "alive": True,
                "service": True, "now": time.time()}

    @_locked
    def waiting(self, key):
        return any(e["kind"] == "permission" and e["state"] == "pending" for e in self._mine(key))

    @_locked
    def last(self, key):
        e = next((e for e in reversed(self._mine(key)) if e["kind"] in ("assistant", "user")), None)
        if not e:
            return None
        return {"kind": e["kind"], "text": str((e.get("raw") if key != "main" and e["kind"] == "user" and e.get("raw")
                                                else e.get("text")) or "")[:160], "ts": e["ts"]}

    @_locked
    def status(self, key):
        """"working" only when sure: the thread's turn has no final reply and the transcript changed (or a tool is
        running) within WORKING_SECS. A turn that stopped without a reply is not shown as stuck."""
        t = self.turns.get(self.turn, {})
        if not t.get("open") or (key != "main" and self._thread(self.turn) != self._want(key)):
            return "idle"
        try:
            age = time.time() - os.stat(self.path).st_mtime
        except (OSError, TypeError, ValueError):
            return "idle"
        if self.last_kind == "text" and not self.tools and age > QUIET_SECS:
            return "idle"  # old transcripts carry no stop reason: quiet means finished
        return "working" if self.tools or age <= WORKING_SECS else "idle"

    @_locked
    def thread_summaries(self):
        """The threads to list (merges and expiry applied): id, title, kind, whether something waits for the user, the
        last message time and the number of messages."""
        self._registry()
        out = []
        for t in lean_threads.threads():
            evs = [e for e in self._mine(t["id"]) if e["kind"] in ("user", "assistant")]
            last = max([t.get("last_message") or ""] + [e["ts"] for e in evs])
            out.append({"id": t["id"], "title": t["title"], "kind": t["kind"], "waiting": self.waiting(t["id"]),
                        "last_message": last or None, "messages": len(evs)})
        return sorted(out, key=lambda t: (t["last_message"] or "", t["id"]), reverse=True)

    def work_since(self, key):
        """Epoch seconds the working turn began (0 when nothing is working)."""
        return self.turns.get(self.turn, {}).get("ts", 0) if self.status(key) == "working" else 0


def _listdir(d):
    try:
        return os.listdir(d)
    except OSError:
        return []


_MODEL = {}
_MODEL_LOCK = threading.Lock()


def model():
    """The transcript model for this lean-agent home, brought up to date."""
    with _MODEL_LOCK:
        m = _MODEL.get(lean_home())
        if m is None:
            m = _MODEL[lean_home()] = Model()
    m.refresh()
    return m
