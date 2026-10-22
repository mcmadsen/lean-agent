"""The dashboard's side of the one service session (service_session.py, hosted by `lean-agent up`).

Instead of its own Claude Code processes, the dashboard types into the orchestrator session through the bridge and
reads what happened from that session's transcript JSONL (incrementally, by byte offset), so the Claude app and the
dashboard show the same conversation. Dashboard messages arrive tagged (`About #N "title": ...` for a task thread);
the sends are remembered (chat/service_sends.jsonl) so the transcript's user turns can be matched back to the thread
they came from. A thread's view is its own user turns plus the assistant and tool events that follow, until the next
user turn; "main" shows everything.

Permission prompts: the PermissionRequest hook (permission_hook.py) hands a request to the dashboard as a file in
chat/perm/ while a dashboard tab is polling (chat/dash-poll is touched on every poll); the page's answer is written
beside it and the hook returns it to Claude Code. /clear inside the session starts a new transcript with a new id: the
newest transcript in the project folder written after the session started is followed and recorded in
chat/service.json, but only if it is ours: its first user record is the /clear command, or it was created within
30 s after a /clear the dashboard sent that no transcript has claimed yet.
"""
import datetime
import functools
import json
import os
import re
import threading
import time

from lean_common import pid_alive, questions_of, tool_summary  # noqa: F401

MAX_EVENTS = 2000
FRESH_SECS = 20  # a dashboard tab polled this recently counts as someone looking
WORKING_SECS = 60  # no transcript change for this long and no tool running: not shown as working
SCAN_SECS = 2  # the transcript folder is listed at most this often
MISS_SECS = 5  # a transcript with no user record yet is looked at again this often
LAZY_SECS = 600  # ...or whose first message is one we sent this soon after that /clear (Claude Code may create the file lazily)
CLEAR_SECS = 30  # a transcript created this soon after a /clear we sent is the one that /clear started
QUIET_SECS = 8   # a transcript untouched this long after an assistant text: the turn is over
TAG_RE = re.compile(r'^About (#?[A-Za-z0-9_.-]+) "')
ABOUT_REPLY_RE = re.compile(r'^\s*About #(\d+)\b')  # an untagged message answered "About #N: ..." belongs to task #N


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
        self._scan = {"at": 0.0, "dir": None, "files": []}
        self._first = {}  # transcript -> first user text, only for files in the current scan
        self._miss = {}  # transcript -> when it had no user record yet (looked at again after MISS_SECS)
        self._used_clears = set()

    # --- following the right transcript
    def _pick(self, up):
        base = up.get("transcript")
        if not base:
            return None
        d = os.path.dirname(base)
        try:
            started = time.mktime(time.strptime(up.get("session_started"), "%Y-%m-%dT%H:%M:%S")) - 2
        except (TypeError, ValueError):
            started = 0
        now = time.time()
        if now - self._scan["at"] >= SCAN_SECS or self._scan["dir"] != d:  # the folder and the threads' sessions: stat at most every 2 s
            mine = set()  # sessions the dashboard's own stream-json threads wrote in the same folder
            for p in [chat_dir("session.json")] + [chat_dir("threads", k, "session.json") for k in _listdir(chat_dir("threads"))]:
                sid = _load(p).get("session_id")
                if sid:
                    mine.add(sid)
            files = []
            for n in _listdir(d):
                if n.endswith(".jsonl") and n[:-6] not in mine:
                    try:
                        st = os.stat(os.path.join(d, n))
                    except OSError:
                        continue
                    if st.st_size > 0:
                        files.append((os.path.join(d, n), st.st_mtime))
            self._scan = {"at": now, "dir": d, "files": files}
            names = {p for p, _ in files}
            self._first = {p: t for p, t in self._first.items() if p in names}
            self._miss = {p: t for p, t in self._miss.items() if p in names}
        clears = sorted(float(s.get("ts") or 0) for s in self.send_log if str(s.get("sent")).strip() == "/clear")
        cands = [(p, m) for p, m in self._scan["files"] if m >= started]
        self._claim([p for p, _ in cands if p != base and p != self.path], clears)
        best, best_m = base, -1.0
        for p, mtime in cands:
            if mtime > best_m and (p == base or p == self.path or self._ours(p)):
                best, best_m = p, mtime
        return best

    def _look(self, p):
        """(first user text, creation epoch or None) of a transcript. "Created" is the first record's timestamp
        (file times move with every append), the file's birth time when no record has one."""
        info = self._first.get(p)
        if info is None and time.time() - self._miss.get(p, 0) >= MISS_SECS:
            info = _first_info(p)
            if info and info[0]:
                self._first[p] = info
            else:
                self._miss[p] = time.time()  # no user text yet: not looked at again for MISS_SECS
        first, born = info or ("", None)
        if born is None:
            try:
                born = getattr(os.stat(p), "st_birthtime", None)
            except OSError:
                pass
        return first or "", born

    def _ours(self, p):
        """A new transcript is followed when its first user record is the /clear command or it claimed one of our /clears."""
        first, _ = self._look(p)
        return first.lstrip().startswith("/clear") or "<command-name>/clear" in first or any(q == p for _, q in self._used_clears)

    def _claim(self, paths, clears):
        """Each /clear we sent is claimed by one transcript: the earliest-born one created within CLEAR_SECS after it,
        or, since Claude Code may create the file lazily, one whose first user record is a message we sent within
        LAZY_SECS after the /clear."""
        while True:
            taken = {c for c, _ in self._used_clears}
            claimed = {q for _, q in self._used_clears}
            found = []
            for p in paths:
                if p in claimed:
                    continue
                first, born = self._look(p)
                if born is None or first.lstrip().startswith("/clear") or "<command-name>/clear" in first:
                    continue
                for t in clears:
                    if t in taken:
                        continue
                    lazy = any(t < float(s.get("ts") or 0) <= t + LAZY_SECS and str(s.get("sent")).strip() == first.strip()
                               for s in self.send_log) if first.strip() else False
                    if t - 2 <= born <= t + CLEAR_SECS or (lazy and born >= t - 2):
                        found.append((born, t, p))
                        break
            if not found:
                return
            _, t, p = min(found)
            self._used_clears.add((t, p))

    @_locked
    def refresh(self):
        up = _load(lean_home("up.json"))
        self._sends()
        path = self._pick(up)
        if not path:
            return
        if path != self.path:
            first = self.path is None
            self.path, self.offset, self.tools = path, 0, {}
            self.sid = os.path.basename(path)[:-6]
            try:
                write_json(chat_dir("service.json"), {"transcript": path, "session_id": self.sid, "ts": time.time()})
            except OSError:
                pass
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
        key = sent.get("key") if sent and sent.get("key") != "main" else None
        self.turn = max(self.turns) + 1
        self.turns[self.turn] = {"thread": key, "open": True, "ts": _epoch(rec.get("timestamp")), "untagged": sent is None}
        self._add(kind="user", text=(sent or {}).get("shown") or text, raw=(sent or {}).get("raw"), thread=key,
                  from_app=sent is None, ts=self._ts(rec), at=self.turns[self.turn]["ts"])
        self.last_kind = "user"

    def _attach_reply(self, text):
        """The first assistant text after an untagged user turn starting `About #N` moves the pair to task #N's view."""
        t = self.turns[self.turn]
        if not t.pop("untagged", False) or t["thread"]:
            return
        m = ABOUT_REPLY_RE.match(text)
        if not m:
            return
        t["thread"] = m.group(1)
        for e in self.events:
            if e["turn"] == self.turn:
                self._update(e, thread=t["thread"] if e["kind"] == "user" else e.get("thread"))

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
                    self._attach_reply(b["text"])
                    self._add(kind="assistant", text=b["text"], ts=self._ts(rec))
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
    def _mine(self, key):
        if key == "main":
            return list(self.events)
        return [e for e in self.events if self.turns.get(e["turn"], {}).get("thread") == key]

    @_locked
    def snapshot(self, key, since=0, fresh_at=0):
        evs = self._mine(key)
        if fresh_at:
            evs = [e for e in evs if self.turns.get(e["turn"], {}).get("ts", 0) >= fresh_at]
        evs = evs[-600:]
        out = []
        for e in evs:
            if max(e["i"], e.get("changed", 0)) > since:
                c = {k: v for k, v in e.items() if k not in ("_req", "turn", "at", "raw")}
                about = self.turns.get(e["turn"], {}).get("thread")
                if about:
                    c["about"] = about
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
        if not t.get("open") or (key != "main" and t.get("thread") != key):
            return "idle"
        try:
            age = time.time() - os.stat(self.path).st_mtime
        except (OSError, TypeError, ValueError):
            return "idle"
        if self.last_kind == "text" and not self.tools and age > QUIET_SECS:
            return "idle"  # old transcripts carry no stop reason: quiet means finished
        return "working" if self.tools or age <= WORKING_SECS else "idle"

    def work_since(self, key):
        """Epoch seconds the working turn began (0 when nothing is working)."""
        return self.turns.get(self.turn, {}).get("ts", 0) if self.status(key) == "working" else 0


def _first_info(p):
    """(text of a transcript's first user record or "", epoch of its first timestamped record or None); None when unreadable."""
    text, stamp = "", None
    try:
        with open(p, errors="replace") as fh:
            for _ in range(50):
                line = fh.readline()
                if not line:
                    break
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict):
                    continue
                if stamp is None and isinstance(rec.get("timestamp"), str):
                    try:
                        stamp = datetime.datetime.fromisoformat(rec["timestamp"].replace("Z", "+00:00")).timestamp()
                    except ValueError:
                        pass
                if rec.get("type") == "user":
                    c = (rec.get("message") or {}).get("content")
                    text = c if isinstance(c, str) else json.dumps(c)
                    break
    except OSError:
        return None
    return text, stamp


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
