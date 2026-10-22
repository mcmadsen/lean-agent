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
chat/service.json.
"""
import datetime
import json
import os
import re
import time

MAX_EVENTS = 2000
FRESH_SECS = 20  # a dashboard tab polled this recently counts as someone looking
WORKING_SECS = 60  # no transcript change for this long and no tool running: not shown as working
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
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh)
    os.replace(tmp, path)


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


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

def tool_summary(name, inp):
    inp = inp if isinstance(inp, dict) else {}
    for k in ("command", "file_path", "pattern", "url", "path", "query", "description", "prompt"):
        if inp.get(k):
            return " ".join(str(inp[k]).split())[:300]
    return " ".join(json.dumps(inp)[:200].split())


def suggestion_rules(suggestions):
    """What "Always allow" will allow, as rules like `Bash(git status:*)` (empty when the suggestion has no rule)."""
    out = []
    for s in suggestions or []:
        for r in (s.get("rules") or []) if isinstance(s, dict) else []:
            if isinstance(r, dict) and r.get("toolName"):
                out.append(r["toolName"] + (f"({r['ruleContent']})" if r.get("ruleContent") else ""))
    return out[:5]


def questions_of(inp):
    out = []
    for q in (inp or {}).get("questions") or []:
        if isinstance(q, dict) and q.get("question"):
            out.append({"question": q["question"], "header": q.get("header"), "multi": bool(q.get("multiSelect")),
                        "options": [{"label": o.get("label"), "description": o.get("description")}
                                    for o in q.get("options") or [] if isinstance(o, dict) and o.get("label")]})
    return out


class Model:
    """The events of the service session's transcript, as the page renders them."""

    def __init__(self):
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
        mine = set()  # sessions the dashboard's own stream-json threads wrote in the same folder
        for p in [chat_dir("session.json")] + [chat_dir("threads", k, "session.json") for k in _listdir(chat_dir("threads"))]:
            sid = _load(p).get("session_id")
            if sid:
                mine.add(sid)
        best, best_m = base, -1.0
        for n in _listdir(d):
            p = os.path.join(d, n)
            if not n.endswith(".jsonl") or n[:-6] in mine:
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            if st.st_size > 0 and st.st_mtime >= started and st.st_mtime > best_m:
                best, best_m = p, st.st_mtime
        return best

    def refresh(self):
        up = _load(lean_home("up.json"))
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
        self._sends()
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

    def waiting(self, key):
        return any(e["kind"] == "permission" and e["state"] == "pending" for e in self._mine(key))

    def last(self, key):
        e = next((e for e in reversed(self._mine(key)) if e["kind"] in ("assistant", "user")), None)
        if not e:
            return None
        return {"kind": e["kind"], "text": str((e.get("raw") if key != "main" and e["kind"] == "user" and e.get("raw")
                                                else e.get("text")) or "")[:160], "ts": e["ts"]}

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


def _listdir(d):
    try:
        return os.listdir(d)
    except OSError:
        return []


_MODEL = {}


def model():
    """The transcript model for this lean-agent home, brought up to date."""
    m = _MODEL.get(lean_home())
    if m is None:
        m = _MODEL[lean_home()] = Model()
    m.refresh()
    return m
