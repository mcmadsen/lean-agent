"""The dashboard's conversation with the orchestrator: one Claude Code session in the orchestrator home, driven over
Claude Code's stream-json input/output (what the Agent SDK uses), so the dashboard can be the only place you talk to
lean-agent. Messages go in as user turns; text, tool calls and results come back as events; permission prompts
come back as `can_use_tool` requests the page answers (allow, always allow, deny); Stop interrupts the turn.

Threads: "main" is the general conversation; every task (a work item, a run that asks, a PR, a note) can have its
own thread, a separate session that starts with that task's context, so each stays small. A thread's session id
and events are kept (main: ~/.lean-agent/chat/; others: ~/.lean-agent/chat/threads/<key>/), so a restarted
dashboard resumes them; only LEAN_AGENT_CHAT_PROCS (default 3) keep a running process, the least recently used
idle one is stopped and resumed by its session id when it's used again. This is separate from a Remote
Control session started by `lean-agent up`: both run in the same orchestrator home, with the same rules.

When `lean-agent up` hosts the one service session and its bridge answers (service_session.py), none of that is
used: every thread types into that session and reads the shared transcript (dash_service.py), so the dashboard and
the Claude app show the same conversation. Without the bridge, everything above stays as it is.
"""
import datetime
import itertools
import json
import os
import re
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import dash_service  # noqa: E402
import lean_threads  # noqa: E402
from lean_common import questions_of, tool_summary  # noqa: E402
PARENT_SESSION_VARS = re.compile(r"^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|ENTRYPOINT|CHILD_SESSION|REMOTE\w*|"
                                 r"MESSAGING_\w+|SSE_PORT|WORKER_EPOCH|TEE_SDK_STDOUT|SESSION_ATTENDED|"
                                 r"SESSION_ACCESS_TOKEN|CONTAINER_ID))$")
DEFAULT_ENV = {
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "70",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100000", "BASH_MAX_OUTPUT_LENGTH": "20000", "MAX_MCP_OUTPUT_TOKENS": "10000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet", "LEAN_AGENT_BRIEF": "1", "LEAN_AGENT_ANSWER_LINES": "25",
}
MAX_EVENTS = 600
_SENDS_LOCK = threading.Lock()  # appends to service_sends.jsonl and its trimming never interleave
_BRIDGE = {"at": 0.0, "up": False}


def lean_home(*parts):
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def orchestrator_env():
    """The environment `lean-agent up` gives the orchestrator (its saved values win), without anything that would
    tie the session to a parent Claude Code session."""
    env = {k: v for k, v in os.environ.items() if not PARENT_SESSION_VARS.match(k)}
    saved = _load(lean_home("up.json"), {}).get("chat_env") or {}
    for k, v in dict(DEFAULT_ENV, **saved).items():
        env.setdefault(k, v) if k not in saved else env.__setitem__(k, v)
    env["PATH"] = os.path.join(os.path.dirname(HERE), "bin") + os.pathsep + env.get("PATH", "")
    try:
        import push_guard
        env = push_guard.git_env(env)
    except Exception:  # the guard is a safety net; the chat still works without it
        pass
    return env


def _questions(req):
    return questions_of(req.get("input"))


def _trim_sends(path, keep=500, limit=1000):
    """Keep the last `keep` lines once the log has grown past `limit`."""
    with _SENDS_LOCK:
        try:
            if os.path.getsize(path) < limit * 80:  # cheap check before counting lines
                return
            with open(path) as fh:
                lines = fh.readlines()
            if len(lines) > limit:
                tmp = path + ".tmp"
                with open(tmp, "w") as fh:
                    fh.writelines(lines[-keep:])
                os.replace(tmp, path)
        except OSError:
            pass


def service_up():
    """True when `lean-agent up`'s bridge answers (checked at most every few seconds)."""
    if time.time() - _BRIDGE["at"] > 3 or _BRIDGE.get("home") != lean_home():
        try:
            import service_session
            _BRIDGE.update(up=bool(service_session.supported() and os.path.exists(service_session.client_sock_path())
                                   and service_session.alive()))
        except Exception:
            _BRIDGE["up"] = False
        _BRIDGE.update(at=time.time(), home=lean_home())
    return _BRIDGE["up"]


def service_status():
    """What the page needs to know about the shared session: is the bridge answering, is Remote Control on
    (None when it can't be told), did `lean-agent up` ever run here (`configured`)."""
    up = service_up()
    info = _load(lean_home("up.json"), {})
    rc = info.get("remote_control")
    return {"up": up, "mode": "service" if up else "fallback", "configured": bool(info), "remote_control": bool(rc) if up and rc is not None else None}


def thread_id(key):
    """The registry's id for a chat key: `12` -> `#12`, `t3` stays."""
    return "#" + key if str(key).isdigit() else str(key)


def thread_key(tid):
    """The chat key for a thread id from the page: `#12` -> `12`, `t3` stays; ValueError for anything else."""
    tid = lean_threads.norm(tid)
    return tid[1:] if tid.startswith("#") else tid


def fixed_send(text):
    """Send one of the dashboard's fixed messages (move, merge, unmerge) into the session; the registry has been updated
    already, so the transcript's copy is marked as applied."""
    ds = service_up() and dash_service
    if not ds:
        return {"ok": True, "sent": False}
    import service_session
    os.makedirs(ds.chat_dir(), exist_ok=True)
    log = ds.chat_dir("service_sends.jsonl")
    with _SENDS_LOCK:
        with open(log, "a") as fh:
            fh.write(json.dumps({"key": "main", "sid": ds.model().sid, "sent": text, "shown": text, "raw": text, "applied": True,
                                 "ts": time.time()}) + "\n")
    _trim_sends(log)
    ok, err = service_session.send(text)
    return {"ok": ok, "sent": ok, **({"error": err} if err else {})}


def thread_move(message, to):
    try:
        to = lean_threads.norm(to)
        mid = str(message or "").strip()
        lean_threads.move(mid, to)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    ev = next((e for e in dash_service.model().events if e.get("mid") == mid and e["kind"] == "user"), None) if service_up() else None
    excerpt = " ".join(str((ev or {}).get("raw") or (ev or {}).get("text") or "").replace('"', "'").split())[:60]
    return fixed_send(f"Move message to {to} ({mid})" + (f': "{excerpt}"' if excerpt else ""))


def thread_merge(src, into):
    try:
        lean_threads.merge(src, into)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    return fixed_send(f"Merge thread {lean_threads.norm(src)} into {lean_threads.norm(into)}")


def thread_unmerge(src):
    try:
        lean_threads.unmerge(src)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    return fixed_send(f"Unmerge thread {lean_threads.norm(src)}")


def thread_list():
    """The threads (aliases and expiry applied): from the transcript model when the bridge answers, else the registry."""
    if service_up():
        return {"threads": dash_service.model().thread_summaries(), "service_status": service_status()}
    out = []
    for t in lean_threads.threads():
        c = _CHAT.get((lean_home(), thread_key(t["id"])))
        out.append({"id": t["id"], "title": t["title"], "kind": t["kind"], "waiting": bool(c and c.pending),
                    "last_message": t.get("last_message"),
                    "messages": len([e for e in c.events if e.get("kind") in ("user", "assistant")]) if c else 0})
    return {"threads": out, "service_status": service_status()}


def thread_dir(key):
    return lean_home("chat") if key == "main" else lean_home("chat", "threads", key)


class Chat:
    def __init__(self, cwd=None, claude=None, key="main"):
        self.key = key
        self.dir = thread_dir(key)
        self.meta = _load(os.path.join(self.dir, "thread.json"), {})
        self.used = time.time()
        self.cwd = cwd or lean_home("home")
        self.claude = claude or os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
        self.lock = threading.RLock()
        self.proc = None
        self.status = "idle"  # idle | working | starting
        self.ids = itertools.count(1)
        self.events = []
        self.pending = {}  # request_id -> permission event
        self.session = _load(os.path.join(self.dir, "session.json"), {}).get("session_id")
        for e in self._read_log():
            self.events.append(e)
        self.ids = itertools.count((self.events[-1]["i"] + 1) if self.events else 1)
        for e in self.events:  # prompts from a process that's gone can't be answered any more
            if e.get("kind") == "permission" and e.get("state") == "pending":
                e["state"] = "expired"

    # ------------------------------------------------------------------ events
    def _read_log(self):
        out = []
        try:
            with open(os.path.join(self.dir, "events.jsonl")) as fh:
                for line in fh.readlines()[-MAX_EVENTS:]:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
        except OSError:
            pass
        return out

    def _add(self, **e):
        with self.lock:
            e = dict(e, i=next(self.ids), ts=_now())
            self.events.append(e)
            del self.events[:-MAX_EVENTS]
            try:
                os.makedirs(self.dir, exist_ok=True)
                with open(os.path.join(self.dir, "events.jsonl"), "a") as fh:
                    fh.write(json.dumps(e) + "\n")
            except OSError:
                pass
            return e

    def _update(self, e, **kw):
        with self.lock:
            e.update(kw)
            e["changed"] = next(self.ids)
            try:
                with open(os.path.join(self.dir, "events.jsonl"), "a") as fh:
                    fh.write(json.dumps(e) + "\n")
            except OSError:
                pass

    # ----------------------------------------------------------- service mode (the shared session)
    def _service(self):
        """The transcript model when the bridge answers, else None (the stream-json threads below are used)."""
        if not service_up():
            return None
        return dash_service

    def _fresh_at(self):
        return float(self.meta.get("fresh_at") or 0)

    def _label(self):
        """The tag a dashboard message carries: `About #N "title": ` for a task, `Thread tN "title": ` for another topic."""
        tid = thread_id(self.key)
        reg = lean_threads.load()["threads"].get(tid) or {}
        title = " ".join(str(self.meta.get("title") or reg.get("title") or self.key).replace('"', "'").split())[:80]
        if re.fullmatch(r"t\d+|optimize", self.key):
            return f'Thread {self.key} "{title}": '
        return f'About {tid if self.key.isdigit() else self.key} "{title}": '

    def _service_send(self, ds, text, context):
        import service_session
        m = ds.model()
        shown = text if self.key == "main" else self._label() + text
        first = self.key != "main" and not any(
            s.get("key") == self.key and s.get("sid") == m.sid and float(s.get("ts") or 0) >= self._fresh_at()
            for s in m.send_log)
        prompt = f"[Dashboard thread about: {context}]\n\n{shown}" if first and context else shown
        os.makedirs(ds.chat_dir(), exist_ok=True)
        log = ds.chat_dir("service_sends.jsonl")
        with _SENDS_LOCK:
            with open(log, "a") as fh:
                fh.write(json.dumps({"key": self.key, "sid": m.sid, "sent": prompt, "shown": shown, "raw": text,
                                     "ts": time.time()}) + "\n")
        _trim_sends(log)
        ok, err = service_session.send(prompt)
        return {"ok": ok, **({"error": err} if err else {})}

    def snapshot(self, since=0):
        ds = self._service()
        if ds:
            ds.touch_poll()
            with self.lock:
                return dict(ds.model().snapshot(self.key, since, self._fresh_at()), service_status=service_status())
        with self.lock:
            seen = {}
            for e in self.events:  # an updated event appears again in the log: the newest copy wins
                seen[e["i"]] = e
            evs = [e for e in seen.values() if max(e["i"], e.get("changed", 0)) > since]
            last = max([max(e["i"], e.get("changed", 0)) for e in seen.values()] or [0])
            return {"status": self.status, "session": self.session, "events": sorted(evs, key=lambda e: e["i"]),
                    "cursor": last, "alive": bool(self.proc and self.proc.poll() is None), "service_status": service_status()}

    # ----------------------------------------------------------------- process
    def _write(self, obj):
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                return False
            try:
                self.proc.stdin.write(json.dumps(obj) + "\n")
                self.proc.stdin.flush()
                return True
            except (OSError, ValueError):
                return False

    def _start(self):
        cmd = [self.claude, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
               "--permission-prompt-tool", "stdio"]
        if self.session:
            cmd += ["--resume", self.session]
        os.makedirs(self.cwd, exist_ok=True)
        self.proc = subprocess.Popen(cmd, cwd=self.cwd, env=orchestrator_env(), stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()
        threading.Thread(target=self._read_err, args=(self.proc,), daemon=True).start()
        self._write({"type": "control_request", "request_id": "init", "request": {"subtype": "initialize"}})

    def _read_err(self, proc):
        tail = []
        for line in proc.stderr:
            tail = (tail + [line.rstrip()])[-8:]
        proc.wait()
        if proc.returncode not in (0, None, -15) and proc is self.proc:
            msg = " ".join(" ".join(tail).split())[-400:]
            if self.session and re.search(r"No conversation found|session.*not found", msg, re.I):
                self.session = None  # the session is gone (cleared elsewhere): the next message starts a new one
                self._save_session()
            self._add(kind="error", text=f"the orchestrator stopped (exit {proc.returncode})" + (f": {msg}" if msg else ""))
        with self.lock:
            if proc is self.proc:
                self.status = "idle"
                self.proc = None

    def _save_session(self):
        os.makedirs(self.dir, exist_ok=True)
        with open(os.path.join(self.dir, "session.json"), "w") as fh:
            json.dump({"session_id": self.session, "ts": _now()}, fh)

    def _read(self, proc):
        tools = {}
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            t = ev.get("type")
            if ev.get("session_id") and ev.get("session_id") != self.session and t in ("system", "result"):
                self.session = ev["session_id"]
                self._save_session()
            if t == "assistant":
                for c in (ev.get("message") or {}).get("content") or []:
                    if c.get("type") == "text" and str(c.get("text") or "").strip():
                        self._add(kind="assistant", text=c["text"])
                    elif c.get("type") == "tool_use":
                        tools[c.get("id")] = self._add(kind="tool", name=c.get("name"),
                                                       text=tool_summary(c.get("name"), c.get("input")), state="running")
            elif t == "user":
                for c in (ev.get("message") or {}).get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in tools:
                        out = c.get("content")
                        if isinstance(out, list):
                            out = " ".join(str(x.get("text", "")) for x in out if isinstance(x, dict))
                        self._update(tools.pop(c["tool_use_id"]), state="error" if c.get("is_error") else "done",
                                     output=" ".join(str(out or "").split())[:400])
            elif t == "control_request":
                req = ev.get("request") or {}
                if req.get("subtype") == "can_use_tool":
                    e = self._add(kind="permission", rid=ev.get("request_id"), name=req.get("display_name")
                                  or req.get("tool_name"), text=tool_summary(req.get("tool_name"), req.get("input")),
                                  description=req.get("description") or req.get("title"), state="pending",
                                  can_always=bool(dash_service.suggestion_rules(req.get("permission_suggestions"))),
                                  always_rule=dash_service.suggestion_rules(req.get("permission_suggestions")),
                                  questions=_questions(req) if req.get("tool_name") == "AskUserQuestion" else None)
                    with self.lock:
                        self.pending[ev.get("request_id")] = (e, req)
                else:  # nothing else is supported here: say so instead of leaving the session waiting
                    self._write({"type": "control_response", "response": {
                        "subtype": "error", "request_id": ev.get("request_id"), "error": "not supported by the dashboard"}})
            elif t == "result":
                with self.lock:
                    self.status = "idle"
                self._add(kind="result", cost=ev.get("total_cost_usd"), turns=ev.get("num_turns"),
                          error=bool(ev.get("is_error")), seconds=round((ev.get("duration_ms") or 0) / 1000))
                for e in tools.values():
                    self._update(e, state="stopped")
                tools.clear()
            elif t == "rate_limit_event":
                try:
                    import usage
                    usage.record_plan_usage(ev.get("rate_limit_info"))
                except Exception:
                    pass
            elif t == "system" and ev.get("subtype") == "compact_boundary":
                self._add(kind="note", text="the conversation was compacted")

    # ------------------------------------------------------------------ actions
    def send(self, text, context=None, title=None):
        text = str(text or "").strip()
        if not text:
            return {"ok": False, "error": "empty message"}
        self.used = time.time()
        if self.key != "main" and lean_threads.ID_RE.match(thread_id(self.key)):
            try:
                lean_threads.touch(thread_id(self.key), title)  # the thread exists from its first message on
            except (OSError, ValueError):
                pass
        if title or context:
            self.meta.update({k: v for k, v in (("title", title), ("context", context)) if v})
            self.meta.setdefault("created", _now())
            os.makedirs(self.dir, exist_ok=True)
            with open(os.path.join(self.dir, "thread.json"), "w") as fh:
                json.dump(self.meta, fh)
        ds = self._service()
        if ds:
            with self.lock:
                return self._service_send(ds, text, self.meta.get("context"))
        first = not any(e.get("kind") == "user" for e in self.events) or not self.session
        prompt = (f"[Dashboard thread about: {self.meta['context']}]\n\n{text}"
                  if first and self.meta.get("context") else text)  # the task's context, once per session
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                make_room(self)
                try:
                    self._start()
                except OSError as e:
                    self._add(kind="error", text=f"couldn't start claude: {e}")
                    return {"ok": False, "error": str(e)}
            self.status = "working"
            self._add(kind="user", text=text)
            ok = self._write({"type": "user", "message": {"role": "user", "content": prompt}})
        return {"ok": ok}

    def busy(self):
        return self.status == "working" or bool(self.pending)

    def summary(self):
        """For the thread list: status, the last message, whether something waits for the user."""
        ds = self._service()
        if ds:
            m = ds.model()
            snap = m.snapshot(self.key, 1 << 60, self._fresh_at())
            return {"key": self.key, "title": self.meta.get("title") or ("Orchestrator" if self.key == "main" else self.key),
                    "status": snap["status"], "waiting": m.waiting(self.key), "alive": True, "last": m.last(self.key),
                    "cursor": snap["cursor"]}
        with self.lock:
            last = next((e for e in reversed(self.events) if e.get("kind") in ("assistant", "user")), None)
            return {"key": self.key, "title": self.meta.get("title") or ("Orchestrator" if self.key == "main" else self.key),
                    "status": self.status, "waiting": bool(self.pending), "alive": bool(self.proc and self.proc.poll() is None),
                    "last": last and {"kind": last["kind"], "text": str(last.get("text") or "")[:160], "ts": last["ts"]},
                    "cursor": max([max(e["i"], e.get("changed", 0)) for e in self.events] or [0])}

    def answer(self, rid, allow, always=False, message=None, answers=None):
        ds = self._service()
        if ds:
            return ds.model().answer(rid, allow, always, message, answers)
        with self.lock:
            got = self.pending.pop(rid, None)
        if not got:
            return {"ok": False, "error": "that prompt isn't waiting any more"}
        e, req = got
        if allow:
            resp = {"behavior": "allow", "updatedInput": dict(req.get("input") or {},
                                                              **({"answers": answers} if answers else {}))}
            if always and dash_service.suggestion_rules(req.get("permission_suggestions")):
                resp["updatedPermissions"] = req["permission_suggestions"]
        else:
            resp = {"behavior": "deny", "message": message or "The user declined this in the dashboard."}
        ok = self._write({"type": "control_response", "response": {"subtype": "success", "request_id": rid,
                                                                     "response": resp}})
        self._update(e, state=("answered" if answers else "always" if always else "allowed") if allow else "denied",
                     answers=answers or None, where="dashboard", answered_at=_now())
        return {"ok": ok}

    def interrupt(self):
        if self._service():
            import service_session
            ok, err = service_session.keys("esc")  # the session notes the interruption in its transcript
            return {"ok": ok, **({"error": err} if err else {})}
        ok = self._write({"type": "control_request", "request_id": f"int-{time.time():.0f}",
                          "request": {"subtype": "interrupt"}})
        if ok:
            self._add(kind="note", text="stopped by you")
        return {"ok": ok}

    def new(self):
        if self._service():
            if self.key == "main":  # the whole session starts over, in the app too
                import service_session
                ok, err = service_session.send("/clear")
                if ok:  # remembered so the new transcript is known to be ours
                    os.makedirs(dash_service.chat_dir(), exist_ok=True)
                    with _SENDS_LOCK, open(dash_service.chat_dir("service_sends.jsonl"), "a") as fh:
                        fh.write(json.dumps({"key": "main", "sid": None, "sent": "/clear", "shown": "/clear", "raw": "/clear",
                                             "ts": time.time()}) + "\n")
                return {"ok": ok, **({"error": err} if err else {})}
            self.meta["fresh_at"] = time.time()  # a task thread shares the session: it just starts its view over
            os.makedirs(self.dir, exist_ok=True)
            with open(os.path.join(self.dir, "thread.json"), "w") as fh:
                json.dump(self.meta, fh)
            return {"ok": True}
        with self.lock:
            proc, self.proc = self.proc, None
            self.session = None
            self.pending.clear()
            self.status = "idle"
        if proc and proc.poll() is None:
            try:
                proc.stdin.close()
                proc.terminate()
            except OSError:
                pass
        self._save_session()
        self._add(kind="note", text="new conversation")
        return {"ok": True}

    def stop(self):
        with self.lock:
            proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            try:
                proc.stdin.close()
                proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                proc.kill()


_CHAT = {}
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")


def chat(key="main"):
    """The conversation of one thread (per lean-agent home): "main", or a task's card id."""
    key = str(key or "main")
    if not KEY_RE.match(key) or ".." in key:
        raise ValueError(f"bad thread {key!r}")
    k = (lean_home(), key)
    if k not in _CHAT:
        _CHAT[k] = Chat(key=key)
    return _CHAT[k]


def make_room(starting):
    """Keep at most LEAN_AGENT_CHAT_PROCS threads with a running process: stop the least recently used idle one."""
    try:
        limit = max(1, int(os.environ.get("LEAN_AGENT_CHAT_PROCS") or 3))
    except ValueError:
        limit = 3
    live = [c for (h, _), c in _CHAT.items() if h == lean_home() and c is not starting and c.proc and c.proc.poll() is None]
    for c in sorted(live, key=lambda c: c.used)[:max(0, len(live) - limit + 1)]:
        if not c.busy():
            c.stop()


def threads():
    """Every thread with saved events, newest first (they're loaded to answer)."""
    keys = ["main"]
    base = lean_home("chat", "threads")
    if os.path.isdir(base):
        keys += [k for k in os.listdir(base) if KEY_RE.match(k)]
    out = []
    for k in keys:
        try:
            out.append(chat(k).summary())
        except ValueError:
            continue
    rest = sorted((t for t in out if t["key"] != "main"), key=lambda t: (t["last"] or {}).get("ts") or "", reverse=True)
    return [t for t in out if t["key"] == "main"] + rest
