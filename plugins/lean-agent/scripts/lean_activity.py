"""What agents are DOING, for the live map: compact tool events (tool name + a short safe target, never arguments), the
per-session rings the service keeps, the worker run's activity file, and the snapshot parts built from them.

Privacy rule (`safe`): a file tool -> the file's basename; Bash -> the program name only; MCP -> "server · tool";
WebFetch -> the host; WebSearch -> "search"; Task/Agent -> the agent type. Nothing else ever leaves a tool call.
Hook side (`hook_send`) is stdlib only: one datagram-sized line to the service socket, fire-and-forget, 30 ms at most."""
import collections
import json
import os
import re
import socket
import threading
import time

WINDOW_S = 1800  # "last 30 min"
RING_MAX = 400  # events kept per node
NODES_MAX = 120  # nodes with a ring
INFLIGHT_MAX = 300
INFLIGHT_STALE_S = 900
RECENT_MAX = 20
TOP_MAX = 6
FEED_MAX = 30
FILE_TOOLS = {"Edit": "file_path", "Write": "file_path", "Read": "file_path", "MultiEdit": "file_path",
              "NotebookEdit": "notebook_path"}
SEND_TIMEOUT = 0.03
WORKER_EVENTS = 150  # events kept in a run's activity.json
WORKER_FLUSH_S = 1.0
ACTIVITY_FILE = "activity.json"

_lock = threading.Lock()
_rings = collections.OrderedDict()  # node -> deque of events {"ts","tool","target","ok","ms","file","mcp"}
_inflight = collections.OrderedDict()  # (node, tool_use_id) -> (ts, tool, target)


def _clean(s, n=60):
    return re.sub(r"[^\w .+@:·-]", "", str(s or "")).strip()[:n]


def _base(p):
    return os.path.basename(str(p or "").replace("\\", "/").rstrip("/"))


def safe(tool, inp):
    """-> (tool, target, mcp server or None) for one tool call: only a name and a short, non-sensitive target."""
    tool = str(tool or "")
    inp = inp if isinstance(inp, dict) else {}
    if tool.startswith("mcp__"):
        parts = tool.split("__", 2)
        server = _clean(parts[1], 40) if len(parts) > 1 else ""
        name = _clean(parts[2], 40) if len(parts) > 2 else ""
        return "MCP", f"{server} · {name}".strip(" ·"), server or None
    name = _clean(tool, 30)
    if tool in FILE_TOOLS:
        return name, _clean(_base(inp.get(FILE_TOOLS[tool])), 60), None
    if tool == "Bash":
        words = str(inp.get("command") or "").split()
        for w in words:
            if "=" in w.split("/")[0]:  # VAR=value prefix: never shown
                continue
            return name, _clean(_base(w.lstrip("(!{")), 30), None
        return name, "", None
    if tool == "WebFetch":
        m = re.match(r"^\s*(?:[a-z][a-z0-9+.-]*://)?(?:[^/@?#]*@)?([^/:?#\s]+)", str(inp.get("url") or ""), re.I)
        return name, _clean(m.group(1).lower(), 60) if m else "", None
    if tool == "WebSearch":
        return name, "search", None
    if tool in ("Task", "Agent"):
        return name, _clean(inp.get("subagent_type") or inp.get("agent_type") or "", 40), None
    return name, "", None


# ---------------------------------------------------------------- hook side
def node_of_env(env=None):
    """The map node of this session: a thread's id, "main" for the front desk, else None (not a hosted session)."""
    env = os.environ if env is None else env
    role = env.get("LEAN_AGENT_SESSION_ROLE")
    if role == "thread" and env.get("LEAN_AGENT_THREAD"):
        return env["LEAN_AGENT_THREAD"]
    return "main" if role == "main" else None


def hook_message(event, node=None, now=None):
    """The compact message for the service from a hook event (PreToolUse/PostToolUse/PostToolUseFailure), or None."""
    node = node or node_of_env()
    name = str(event.get("hook_event_name") or "")
    if not node or not event.get("tool_name") or name not in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
        return None
    tool, target, server = safe(event.get("tool_name"), event.get("tool_input"))
    msg = {"op": "tool", "node": node, "phase": "pre" if name == "PreToolUse" else "post", "id": _clean(event.get("tool_use_id"), 80),
           "tool": tool, "target": target, "mcp": server, "ts": now or time.time()}
    if msg["phase"] == "post":
        resp = event.get("tool_response")
        msg["ok"] = name != "PostToolUseFailure" and not (isinstance(resp, dict) and resp.get("is_error") is True)
    return msg


def hook_send(event, node=None):
    """Fire-and-forget to the service socket; never raises, never waits more than SEND_TIMEOUT; dropped when it is down."""
    s = None
    try:
        if os.environ.get("LEAN_AGENT_NO_SOCKET"):
            return False
        msg = hook_message(event, node)
        if not msg:
            return False
        import lean_sock
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(SEND_TIMEOUT)
        s.connect(lean_sock.path())
        s.sendall(json.dumps(msg).encode() + b"\n")
        return True
    except Exception:  # noqa: BLE001 - a hook never fails over this
        return False
    finally:
        if s is not None:
            try:
                s.close()
            except OSError:
                pass


# ---------------------------------------------------------------- service side
def reset():
    with _lock:
        _rings.clear()
        _inflight.clear()


def _ring(node):
    r = _rings.get(node)
    if r is None:
        r = _rings[node] = collections.deque(maxlen=RING_MAX)
        while len(_rings) > NODES_MAX:
            _rings.popitem(last=False)
    else:
        _rings.move_to_end(node)
    return r


def ingest(req, now=None):
    """The service's `tool` op: one pre/post message of a session into its ring. Never raises."""
    try:
        now = now or time.time()
        node = _clean(req.get("node"), 40)
        tool, target = _clean(req.get("tool"), 30), _clean(req.get("target"), 70)
        if not node or not tool:
            return False
        key = (node, str(req.get("id") or "")[:80])
        with _lock:
            if req.get("phase") == "pre":
                _inflight[key] = (now, tool, target)
                while len(_inflight) > INFLIGHT_MAX:
                    _inflight.popitem(last=False)
                return True
            t0 = _inflight.pop(key, None)
            ms = int((now - t0[0]) * 1000) if t0 else None
            _ring(node).append({"ts": now, "tool": tool, "target": target, "ok": bool(req.get("ok", True)), "ms": ms,
                                "mcp": _clean(req.get("mcp"), 40) or None})
        return True
    except Exception:  # noqa: BLE001
        return False


def node_events(node):
    with _lock:
        return list(_rings.get(node) or ())


def node_now(node, now):
    with _lock:
        cur = [v for (n, _i), v in _inflight.items() if n == node and now - v[0] < INFLIGHT_STALE_S]
    if not cur:
        return None
    ts, tool, target = max(cur)
    return {"tool": tool, "target": target, "since_s": round(max(0.0, now - ts), 1)}


def summarize(events, now, current=None):
    """The "activity" dict of a node from its events (any order) and its tool call in progress, or None when empty."""
    ev = sorted((e for e in events if now - e["ts"] <= WINDOW_S), key=lambda e: -e["ts"])
    if not ev and not current:
        return None
    counts = collections.Counter(e["tool"] for e in ev)
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_MAX]
    files = {e["target"] for e in ev if e["tool"] in FILE_TOOLS and e.get("target")}
    mcp = sorted({e["mcp"] for e in ev if e.get("mcp")})
    return {"now": current, "top": [[k, v] for k, v in top],
            "recent": [{"ts": round(e["ts"], 1), "tool": e["tool"], "target": e.get("target") or "", "ok": bool(e.get("ok", True)),
                        "ms": e.get("ms")} for e in ev[:RECENT_MAX]],
            "files": len(files), "errors": sum(1 for e in ev if not e.get("ok", True)), "mcp": mcp,
            "last_ts": round(ev[0]["ts"], 1) if ev else None}


# ---------------------------------------------------------------- worker runs
class RunTracker:
    """Reads a worker's stream-json events (tool_use / tool_result, usage) into compact events + stats, kept bounded in the
    run's activity.json (written at most once a second, atomically)."""

    def __init__(self, workdir, model="", max_turns=None, branch=None, now=None):
        self.workdir = workdir
        self.t0 = now or time.time()
        self.stats = {"turns": 0, "max_turns": max_turns, "tokens": 0, "usd": 0.0, "context": 0, "branch": branch,
                      "elapsed_s": 0, "model": _family(model)}
        self.events = collections.deque(maxlen=WORKER_EVENTS)
        self.pending = {}
        self.seen = set()
        self.final = False
        self.last_flush = 0.0

    def feed(self, ev, now=None):
        try:
            self._feed(ev, now or time.time())
        except Exception:  # noqa: BLE001 - the run is never hurt by its map data
            pass

    def _feed(self, ev, now):
        kind = ev.get("type")
        msg = ev.get("message") if isinstance(ev.get("message"), dict) else {}
        if kind == "system" and ev.get("model"):
            self.stats["model"] = _family(ev["model"])
        elif kind == "assistant":
            u = msg.get("usage")
            if isinstance(u, dict) and msg.get("id") not in self.seen:
                self.seen.add(msg.get("id"))
                self.stats["turns"] += 1
                ctx = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
                self.stats["context"] = ctx
                self.stats["tokens"] += int(ctx + int(u.get("output_tokens") or 0))
                self._usd(u)
            for c in msg.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    tool, target, server = safe(c.get("name"), c.get("input"))
                    self.pending[c.get("id")] = (now, tool, target, server)
                    if len(self.pending) > 100:
                        self.pending.pop(next(iter(self.pending)))
        elif kind == "user":
            for c in msg.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in self.pending:
                    ts, tool, target, server = self.pending.pop(c["tool_use_id"])
                    self.events.append({"ts": round(now, 2), "tool": tool, "target": target, "ok": not c.get("is_error"),
                                        "ms": int((now - ts) * 1000), "mcp": server})
        elif kind == "result":
            if isinstance(ev.get("total_cost_usd"), (int, float)):
                self.stats["usd"] = round(float(ev["total_cost_usd"]), 4)
                self.exact = True
            if isinstance(ev.get("num_turns"), int):
                self.stats["turns"] = ev["num_turns"]
            self.final = True
        self.flush(now, force=self.final)

    def _usd(self, u):
        if getattr(self, "exact", False):
            return
        try:
            import usage
            self.stats["usd"] = round(self.stats["usd"] + usage.estimate_usd(
                {k: int(u.get(k) or 0) for k in usage.FIELDS}, self.stats["model"]), 4)
        except Exception:  # noqa: BLE001
            pass

    def snapshot(self, now=None):
        now = now or time.time()
        cur = max(self.pending.values()) if self.pending else None
        return {"stats": dict(self.stats, elapsed_s=int(now - self.t0)),
                "now": {"tool": cur[1], "target": cur[2], "since": round(cur[0], 2)} if cur else None,
                "events": list(self.events)}

    def flush(self, now=None, force=False):
        now = now or time.time()
        if not force and now - self.last_flush < WORKER_FLUSH_S:
            return
        self.last_flush = now
        path = os.path.join(self.workdir or "", ACTIVITY_FILE)
        try:
            tmp = path + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(self.snapshot(now), fh, separators=(",", ":"))
            os.replace(tmp, path)
        except OSError:
            pass


def _family(model):
    m = str(model or "").lower()
    return next((f for f in ("haiku", "sonnet", "opus", "fable") if f in m), m[:30])


_wcache = {}


def read_run(workdir, now=None):
    """(activity dict or None, stats dict or None) of a run from its activity.json (re-read only when it changed)."""
    now = now or time.time()
    p = os.path.join(workdir or "", ACTIVITY_FILE)
    try:
        st = os.stat(p)
    except OSError:
        return None, None
    sig = (st.st_mtime_ns, st.st_size)
    hit = _wcache.get(p)
    if hit is None or hit[0] != sig:
        try:
            with open(p) as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return None, None
        if not isinstance(data, dict):
            return None, None
        hit = _wcache[p] = (sig, data)
        while len(_wcache) > 100:
            _wcache.pop(next(iter(_wcache)))
    data = hit[1]
    cur = data.get("now")
    current = {"tool": cur.get("tool"), "target": cur.get("target"), "since_s": round(max(0.0, now - float(cur.get("since") or now)), 1)} \
        if isinstance(cur, dict) else None
    evs = [e for e in data.get("events") or [] if isinstance(e, dict) and isinstance(e.get("ts"), (int, float)) and e.get("tool")]
    stats = data.get("stats") if isinstance(data.get("stats"), dict) else None
    if stats and isinstance(stats.get("elapsed_s"), (int, float)):
        stats = dict(stats, elapsed_s=int(stats["elapsed_s"] + max(0, now - st.st_mtime)))
    return summarize(evs, now, current), stats


# ---------------------------------------------------------------- totals and feed
_lcache = {"sig": None, "rows": []}


def _today_start():
    return time.strftime("%Y-%m-%dT00:00:00", time.localtime())


def ledger_today(home, max_bytes=2 << 20):
    """Today's ledger rows (read from the end of the file only), cached while the file is unchanged."""
    p = os.path.join(home, "ledger.jsonl")
    try:
        st = os.stat(p)
    except OSError:
        return []
    day = _today_start()
    sig = (st.st_mtime_ns, st.st_size, day)
    if _lcache["sig"] == sig:
        return _lcache["rows"]
    rows, pos, buf = [], st.st_size, b""
    try:
        with open(p, "rb") as fh:
            read = 0
            while pos > 0 and read < max_bytes:
                n = min(65536, pos)
                pos -= n
                fh.seek(pos)
                buf = fh.read(n) + buf
                read += n
                lines = buf.split(b"\n")
                buf = lines[0] if pos > 0 else b""
                done = False
                for line in reversed(lines[1:] if pos > 0 else lines):
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(r, dict):
                        continue
                    if str(r.get("ts") or "") < day:
                        done = True
                        break
                    rows.append(r)
                if done:
                    break
    except OSError:
        return []
    rows.reverse()
    _lcache.update(sig=sig, rows=rows)
    return rows


def ledger_since(home, since_iso, max_bytes=16 << 20):
    """Ledger rows with ts >= since_iso (read from the end of the file only), oldest first."""
    p = os.path.join(home, "ledger.jsonl")
    rows, buf = [], b""
    try:
        with open(p, "rb") as fh:
            pos = fh.seek(0, 2)
            start, read, done = pos, 0, False
            while pos > 0 and read < max_bytes and not done:
                n = min(1 << 20, pos)
                pos -= n
                fh.seek(pos)
                buf = fh.read(n) + buf
                read += n
                lines = buf.split(b"\n")
                buf = lines[0] if pos > 0 else b""
                for line in reversed(lines[1:] if pos > 0 else lines):
                    if not line.strip():
                        continue
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(r, dict):
                        continue
                    if str(r.get("ts") or "") < since_iso:
                        done = True
                        break
                    rows.append(r)
    except OSError:
        return []
    rows.reverse()
    return rows


def tools_week(now, top=10):
    """[[tool, count]] over the activity rings (what is still in memory, at most the last 7 days), most used first."""
    cnt = {}
    with _lock:
        rings = [list(r) for r in _rings.values()]
    for evs in rings:
        for e in evs:
            if now - e["ts"] <= 7 * 86400:
                cnt[e["tool"]] = cnt.get(e["tool"], 0) + 1
    return [[k, v] for k, v in sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))[:top]]


def _num(v, d=0):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else d


def _baseline(home, project, _c={}):
    p = os.path.join(home, "baselines.json")
    try:
        st = os.stat(p)
        sig = (st.st_mtime_ns, st.st_size)
        if _c.get("p") != (p, sig):
            with open(p) as fh:
                _c["d"] = json.load(fh)
            _c["p"] = (p, sig)
        b = (_c.get("d") or {}).get(project)
    except (OSError, ValueError, AttributeError):
        b = None
    if isinstance(b, dict):
        b = b.get("ctx")
    b = _num(b) if not isinstance(b, str) else (float(b) if re.match(r"^\d+(\.\d+)?$", b) else 0)
    return int(b) if b and b > 0 else 30000  # lean_agent.ASSUMED_BASELINE_CTX


def run_saved(r, home):
    """Sonnet-equivalent tokens a ledger row saved (lean_agent.run_savings: lean worker context + model choice)."""
    import usage
    u = r.get("usage")
    u = {k: _num(v) for k, v in u.items()} if isinstance(u, dict) else {}
    turns = max(1, int(_num(r.get("turns"), 1)))
    ctx = usage.context_tokens(u)
    extra = max(0, _baseline(home, r.get("project")) - ctx / turns)
    model = r.get("model") if isinstance(r.get("model"), str) else None
    rate = usage.model_rate(model)
    weighted = _num(r.get("weighted")) or usage.weighted(u)
    return int(extra * (1.25 + 0.1 * (turns - 1)) * rate) + int(weighted - weighted * rate)


def totals(rows, home, per_min=0.0, errors=0):
    import usage
    usd = tokens = saved = 0
    for r in rows:
        u = r.get("usage") if isinstance(r.get("usage"), dict) else {}
        u = {k: _num(v) for k, v in u.items()}
        cost = r.get("cost_usd")
        usd += cost if isinstance(cost, (int, float)) else usage.estimate_usd(u, r.get("model"))
        tokens += int(_num(r.get("weighted")) or usage.weighted(u))
        try:
            saved += run_saved(r, home)
        except Exception:  # noqa: BLE001
            pass
    return {"runs_today": len(rows), "usd_today": round(usd, 2), "tokens_today": int(tokens), "saved_today": int(saved),
            "tools_per_min": round(per_min, 1), "errors_30m": int(errors)}


def _ts_epoch(iso):
    try:
        return time.mktime(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, OverflowError):
        return 0.0


def feed_items(node_events_map, ring_events, rows, now, visible):
    """The feed, newest first, max FEED_MAX. node_events_map {node: [events]}; ring_events: lean_map ring events (messages,
    run ends); rows: today's ledger rows (already without hidden projects); only items of `visible` nodes."""
    items = []
    for node, evs in node_events_map.items():
        if node not in visible:
            continue
        for e in evs:
            if now - e["ts"] > WINDOW_S:
                continue
            ok = e.get("ok", True)
            text = f"{e['tool']} {e.get('target') or ''}".strip()
            items.append({"ts": round(e["ts"], 1), "node": node, "kind": "tool" if ok else "error",
                          "text": text if ok else text + " failed"})
    for e in ring_events:
        meta = e.get("meta") or {}
        if e.get("kind") == "report" and str(e.get("from", "")).startswith("run:"):
            node = e["from"]
            if node in visible or meta.get("thread") in visible:
                bad = meta.get("state") == "dead"
                items.append({"ts": round(e["ts"], 1), "node": node, "kind": "error" if bad else "run",
                              "text": "run " + ("failed" if bad else "finished")})
        elif e.get("label") == "task" and str(e.get("to", "")).startswith("run:"):
            items.append({"ts": round(e["ts"], 1), "node": e["to"], "kind": "run", "text": "run started"})
        elif e.get("text") and e.get("node") and e["node"] in visible:
            items.append({"ts": round(e["ts"], 1), "node": e["node"], "kind": "message", "text": _clean(e["text"], 80)})
    seen = {(i["node"], i["kind"], i["text"]) for i in items if i["kind"] in ("run", "error")}
    for r in rows:
        ts = _ts_epoch(r.get("ts"))
        if not ts or now - ts > WINDOW_S or not r.get("id"):
            continue
        node = "run:" + str(r["id"])
        bad = str(r.get("status") or "").lower() not in ("done", "awaiting-confirmation", "needs-input")
        key = (node, "error" if bad else "run", "run failed" if bad else "run finished")
        if key not in seen:
            items.append({"ts": round(ts, 1), "node": node, "kind": key[1], "text": key[2]})
    items.sort(key=lambda i: -i["ts"])
    return items[:FEED_MAX]
