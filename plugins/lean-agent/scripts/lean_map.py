"""The live map: an in-memory event ring fed by the service, the snapshot built from it (`map` socket op), and the SVG
drawing of a snapshot (pure function). Nothing here writes a file per event."""
import collections
import html
import json
import os
import threading
import time

RING_SECONDS = 300
RING_MAX = 400
FADE = 30  # seconds without traffic before an edge is idle
MAX_THREADS = 12
MAX_WORKERS = 3  # placed per parent
ENDED_S = 600  # an ended worker stays on the map this long
STARTED = time.time()

COLORS = {"message": "#2EC4B6", "report": "#F2A541", "request": "#7AA2F7", "idle": "#5B6475", "bad": "#F07167"}
BG, CARD, BORDER, TEXT, MUTED = "#0F1217", "#1A1F27", "#2A313C", "#E6E9EF", "#9AA3B2"

_lock = threading.Lock()
_ring = collections.deque(maxlen=RING_MAX)
_reqs = collections.deque(maxlen=2000)  # (ts, op) of socket requests, last minute
_state = {"ms": None, "cpu": (time.monotonic(), time.process_time(), 0.0)}


def record(kind, frm, to, label, node=None, dir=None, text=None, now=None, meta=None):
    """One event: kind message|report|request, from/to node ids; `text`+`node`+`dir` also list it under `moving`."""
    with _lock:
        _ring.append({"ts": now or time.time(), "kind": kind, "from": frm, "to": to, "label": label,
                      "node": node, "dir": dir, "text": text, "meta": meta})


_seen_runs = collections.OrderedDict()


def run_ended(rid, thread, status, now=None):
    """A run finished (done / failed / timed out / stopped): worker -> thread 'result'."""
    ok = str(status or "").lower() in ("done", "ok", "success", "finished", "completed")
    record("report", "run:" + rid, thread, "result", node="run:" + rid, dir="from", text="result ready", now=now,
           meta={"thread": thread, "state": "done" if ok else "dead", "status": str(status or "")})


def run_started(rid, thread, model="", now=None):
    """A run marker appeared for a thread: thread -> worker 'task' (once per run)."""
    if rid in _seen_runs:
        return
    _seen_runs[rid] = 1
    while len(_seen_runs) > 500:
        _seen_runs.popitem(last=False)
    record("message", thread, "run:" + rid, "task", now=now, meta={"thread": thread, "state": "alive", "model": model})


def record_request(op, ms, now=None):
    """A socket request served (count per minute, last latency). `pending` is the hooks' question."""
    now = now or time.time()
    with _lock:
        if op != "map":  # a map request times the snapshot itself, not the socket
            _state["ms"] = ms
        _reqs.append((now, op))
        if op == "pending":
            _ring.append({"ts": now, "kind": "request", "from": "hooks", "to": "service", "label": f"pending? {ms:.0f} ms",
                          "node": None, "dir": None, "text": None})


def events(now=None, span=RING_SECONDS):
    now = now or time.time()
    with _lock:
        return [e for e in _ring if now - e["ts"] <= span]


def ring_size():
    return len(_ring)


def reset():
    with _lock:
        _ring.clear()
        _reqs.clear()
        _track.clear()
        _hcache.clear()


def _age(t, now):
    return round(max(0.0, now - t), 1)


def _dur(s):
    s = int(s)
    return f"{s} s" if s < 90 else f"{s // 60} min" if s < 5400 else f"{s // 3600} h"


def _num(v, d):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else d


def select(nodes):
    """Which nodes get drawn (shared by the SVG and the live page): open threads ranked active/mid-turn, undelivered, then
    most recent, at most MAX_THREADS; workers alive/orphaned or ended in the last ENDED_S, at most MAX_WORKERS per parent
    (parent-less = under the front desk). -> {"placed": [ids], "more": number of threads/workers left out}."""
    def trank(n):
        st = n.get("state")
        return (0 if st == "active" or n.get("mid") else 1 if st == "undelivered" or n.get("undelivered") else 2,
                _num(n.get("idle_s"), 1e9), len(n["id"]), n["id"])
    th = sorted([n for n in nodes if n.get("kind") == "thread" and n.get("state") != "closed" and not n.get("closed")], key=trank)
    keep = th[:MAX_THREADS]
    more = len(th) - len(keep)
    ids = {n["id"] for n in keep}
    by = {}
    for n in nodes:
        if n.get("kind") != "worker":
            continue
        p = n.get("parent")
        if p in (None, "", "main"):
            p = "main"
        elif p not in ids:
            continue
        alive = n.get("state") in ("alive", "orphaned")
        age = _num(n.get("ended_s"), _num(n.get("age_s"), 0))
        if alive or age <= ENDED_S:
            by.setdefault(p, []).append((0 if alive else 1, age, n["id"]))
    placed = ["service", "main", "hooks"] + [n["id"] for n in keep]
    for p, ws in by.items():
        ws.sort()
        placed += [w[2] for w in ws[:MAX_WORKERS]]
        more += max(0, len(ws) - MAX_WORKERS)
    return {"placed": placed, "more": more}


def build(ctx, now=None):
    """Snapshot (contract v1) from plain data. ctx: service{pid,version,threads,up_s,cpu_pct,socket_ms}, paused, inbox,
    threads[{id,title,state,idle_s,mid,undelivered}], runs[{id,thread,model,age_s,progress_s,alive,done,orphaned}],
    desk_idle_s. Hidden items are already left out by the caller."""
    now = now or time.time()
    ev = events(now)
    sv = dict(ctx.get("service") or {})
    sv["up"] = True
    reqs = [t for t, op in list(_reqs) if now - t <= 60 and op == "pending"]
    nodes = [{"id": "service", "kind": "service", "label": "Service socket", "state": "active",
              "detail": f"{sv.get('socket_ms', 0)} ms · {sv.get('threads', 0)} threads"},
             {"id": "main", "kind": "desk", "label": "Front desk", "state": "idle" if ctx.get("desk_idle_s", 0) > 5 else "active",
              "detail": f"idle {_dur(ctx.get('desk_idle_s', 0))}"}]
    for t in ctx.get("threads") or []:
        n = {"id": t["id"], "kind": "thread", "label": t.get("title") or t["id"], "state": t["state"], "detail": t.get("detail") or t["state"],
             "idle_s": t.get("idle_s", 0), "mid": bool(t.get("mid"))}
        if t.get("project"):
            n["project"] = t["project"]
        nodes.append(n)
    for r in ctx.get("runs") or []:
        st = "done" if r.get("done") else "orphaned" if r.get("orphaned") else "alive" if r.get("alive", True) else "dead"
        nodes.append({"id": "run:" + r["id"], "kind": "worker", "parent": r.get("thread"), "label": "run " + r["id"].split("-")[-1],
                      "model": r.get("model") or "", "state": st, "age_s": r.get("age_s", 0), "ended_s": r.get("ended_s"), "progress_s": r.get("progress_s"),
                      "detail": f"{_dur(r.get('age_s', 0))} · progress {_dur(r.get('progress_s', 0))} ago"})
        if r.get("project"):
            nodes[-1]["project"] = r["project"]
    have = {n["id"] for n in nodes}
    tids = {n["id"] for n in nodes if n["kind"] == "thread"}
    for e in sorted(ev, key=lambda e: e["ts"]):  # runs the ring knows (just ended or started) but the live list no longer / not yet shows
        m = e.get("meta")
        node = e["from"] if e["from"].startswith("run:") else e["to"] if e["to"].startswith("run:") else None
        if m and node and node not in have and m.get("thread") in tids:
            have.add(node)
            nodes.append({"id": node, "kind": "worker", "parent": m["thread"], "label": "run " + node.split("-")[-1],
                          "model": m.get("model") or "", "state": m["state"], "age_s": 0, "ended_s": _age(e["ts"], now),
                          "detail": m.get("status") or ("done" if m["state"] == "done" else "ended")})
    nodes.append({"id": "hooks", "kind": "hooks", "label": "Hooks", "state": "active" if reqs else "idle", "detail": f"{len(reqs)} a min", "per_min": len(reqs)})
    sel = select(nodes)
    ids = set(sel["placed"]) & {n["id"] for n in nodes}  # edges only between placed nodes
    newest = {}
    for e in ev:
        if e["from"] in ids and e["to"] in ids:
            k = (e["from"], e["to"], e["kind"])
            if k not in newest or e["ts"] >= newest[k]["ts"]:
                newest[k] = e
    edges, busy = [], set()
    for (f, to, kd), e in sorted(newest.items(), key=lambda x: -x[1]["ts"]):
        a = _age(e["ts"], now)
        if a <= FADE:
            edges.append({"from": f, "to": to, "kind": kd, "age_s": a, "label": e["label"]})
            busy.update((f, to))
    for t in ctx.get("threads") or []:
        if t["id"] not in ids:
            continue
        if t.get("undelivered"):
            edges.append({"from": "service", "to": t["id"], "kind": "message", "age_s": t.get("idle_s", 0), "label": "undelivered", "bad": True})
        elif t["id"] not in busy:
            edges.append({"from": "service", "to": t["id"], "kind": "idle", "age_s": t.get("idle_s", 0), "label": "idle"})
    if "main" not in busy:
        edges.append({"from": "main", "to": "service", "kind": "idle", "age_s": ctx.get("desk_idle_s", 0), "label": "idle"})
    for n in nodes:
        if n["kind"] == "worker" and n["id"] in ids and n["id"] not in busy and n["parent"] in ids:
            edges.append({"from": n["id"], "to": n["parent"], "kind": "idle" if n["state"] != "done" else "report",
                          "age_s": 0, "label": "done" if n["state"] == "done" else "idle"})
    moving = [{"dir": e["dir"], "node": e["node"], "text": e["text"], "age_s": _age(e["ts"], now)}
              for e in sorted(ev, key=lambda e: -e["ts"]) if e.get("text") and e.get("node")][:8]
    extra = activity_parts(ctx, nodes, sel["placed"], ev, now)
    try:
        import usage
        extra["plan"] = usage.plan_report(now)
    except Exception:
        pass
    for k, fn in (("projects", lambda: project_rows(ctx, nodes, extra)), ("alerts", lambda: alerts(ctx, nodes, extra, now))):
        try:
            extra[k] = fn()
        except Exception:
            extra[k] = []
    return {"v": 1, "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)), "service": sv, "paused": bool(ctx.get("paused")),
            "inbox": int(ctx.get("inbox") or 0), "nodes": nodes, "edges": edges, "moving": moving,
            "placed": sel["placed"], "more": sel["more"], **extra}


def activity_parts(ctx, nodes, placed, ev, now):
    """Adds "activity" (and, on workers, "stats") to the placed nodes; -> {"totals", "feed"}. Never raises: the map renders
    without any of it."""
    try:
        import lean_activity as act
        placed = set(placed)
        workdirs = {"run:" + r["id"]: r for r in ctx.get("runs") or []}
        per = {}
        errs = 0
        recent = 0
        for n in nodes:
            nid = n["id"]
            if nid not in placed or n["kind"] == "service":
                continue
            if n["kind"] == "worker":
                r = workdirs.get(nid) or {}
                a, st = act.read_run(r.get("workdir"), now) if r.get("workdir") else (None, None)
                if st:
                    n["stats"] = dict(st, branch=st.get("branch") or r.get("branch"))
                evs = None
            else:
                evs = act.node_events(nid)
                a = act.summarize(evs, now, act.node_now(nid, now))
            if a:
                n["activity"] = a
                errs += a["errors"]
                if evs is None:
                    evs = [{"ts": e["ts"], "tool": e["tool"], "target": e["target"], "ok": e["ok"]} for e in a["recent"]]
                recent += sum(1 for e in evs if now - e["ts"] <= 60)
                per[nid] = evs
        rows = ctx.get("rows") or []
        visible = {n["id"] for n in nodes}
        return {"totals": act.totals(rows, ctx.get("home") or "", per_min=recent, errors=errs),
                "feed": act.feed_items(per, ev, rows, now, visible)}
    except Exception:
        return {}


# ---------------------------------------------------------------- projects and alerts
PROJECTS_MAX = 12
ALERTS_MAX = 20
DEFAULTS = {"stuck_warn_min": 10, "stuck_bad_min": 30, "no_progress_warn_min": 10, "no_progress_bad_min": 30,
            "undelivered_bad_min": 2, "errors_n": 5, "errors_window_min": 10, "daily_budget_usd": None,
            "service_ms": 200, "service_cpu_pct": 80, "service_for_s": 60}
_track = {}  # condition key -> first-seen epoch (undelivered, service)
_cfgc = {"sig": None, "v": {}}


def map_config(home=None):
    """The map.* thresholds: config.json {"map": {key: value}} over DEFAULTS (cached while the file is unchanged)."""
    try:
        import lean_common
        p = lean_common.lean_home("config.json") if home is None else os.path.join(home, "config.json")
        st = os.stat(p)
        sig = (p, st.st_mtime_ns, st.st_size)
        if _cfgc["sig"] != sig:
            with open(p) as fh:
                d = json.load(fh)
            m = d.get("map") if isinstance(d, dict) else None
            _cfgc.update(sig=sig, v=m if isinstance(m, dict) else {})
    except (OSError, ValueError, ImportError):
        _cfgc.update(sig=None, v={})
    out = dict(DEFAULTS)
    for k, v in _cfgc["v"].items():
        if k in out and (v is None or (isinstance(v, (int, float)) and not isinstance(v, bool))):
            out[k] = v
    return out


def project_rows(ctx, nodes, extra):
    """Per project: open threads, alive workers, today's cost/tokens, failed tool calls (30 min). usd desc, max 12."""
    import lean_activity as act
    per = {}

    def row(slug):
        return per.setdefault(slug, {"slug": slug, "threads": 0, "workers": 0, "usd_today": 0.0, "tokens_today": 0, "errors_30m": 0})
    for n in nodes:
        slug = n.get("project")
        if not slug:
            continue
        if n["kind"] == "thread" and n.get("state") != "closed":
            row(slug)["threads"] += 1
        elif n["kind"] == "worker" and n.get("state") in ("alive", "orphaned"):
            row(slug)["workers"] += 1
        if n["kind"] in ("thread", "worker"):
            row(slug)["errors_30m"] += int((n.get("activity") or {}).get("errors") or 0)
    import usage
    for r in ctx.get("rows") or []:
        slug = r.get("project")
        if not slug:
            continue
        u = r.get("usage") if isinstance(r.get("usage"), dict) else {}
        u = {k: _num(v, 0) for k, v in u.items()}
        c = r.get("cost_usd")
        x = row(slug)
        x["usd_today"] += c if isinstance(c, (int, float)) else usage.estimate_usd(u, r.get("model"))
        x["tokens_today"] += int(_num(r.get("weighted"), 0) or usage.weighted(u))
    out = sorted(per.values(), key=lambda x: (-x["usd_today"], x["slug"]))[:PROJECTS_MAX]
    for x in out:
        x["usd_today"] = round(x["usd_today"], 2)
    return out


def alerts(ctx, nodes, extra, now):
    """Active alerts, newest first, max 20 (ids stable per condition). Thresholds: map_config()."""
    import lean_activity as act
    cfg = map_config(ctx.get("home") or None)
    out = []

    def add(kind, node, level, text, since):
        out.append({"id": f"{kind}:{node}" if node else kind, "level": level, "node": node, "kind": kind, "text": text, "since": int(since)})
    thr = {t["id"]: t for t in ctx.get("threads") or []}
    for tid, t in thr.items():
        if t.get("mid"):
            evs = act.node_events(tid)
            quiet = now - evs[-1]["ts"] if evs else _num(t.get("idle_s"), 0)
            m = quiet / 60.0
            if m > cfg["stuck_warn_min"]:
                add("stuck", tid, "bad" if m > cfg["stuck_bad_min"] else "warn",
                    f"{tid} mid-turn with no tool activity for {_dur(quiet)}", now - quiet)
    seen = set()
    for t in thr.values():
        if t.get("undelivered") and not t.get("mid"):
            k = "undelivered:" + t["id"]
            seen.add(k)
            first = _track.setdefault(k, now - _num(t.get("undelivered_s"), 0))
            if now - first > cfg["undelivered_bad_min"] * 60:
                add("undelivered", t["id"], "bad", f"{t['id']} has a message undelivered for {_dur(now - first)}", first)
    for r in ctx.get("runs") or []:
        if r.get("done") or r.get("orphaned") or not r.get("alive", True):
            continue
        m = _num(r.get("progress_s"), 0) / 60.0
        if m > cfg["no_progress_warn_min"]:
            add("no_progress", "run:" + r["id"], "bad" if m > cfg["no_progress_bad_min"] else "warn",
                f"run {r['id'].split('-')[-1]} alive with no progress for {_dur(m * 60)}", now - m * 60)
    win = cfg["errors_window_min"] * 60
    for n in nodes:
        if n["kind"] not in ("thread", "worker"):
            continue
        if n["kind"] == "worker":
            evs = [{"ts": e["ts"], "ok": e["ok"]} for e in ((n.get("activity") or {}).get("recent") or [])]
        else:
            evs = act.node_events(n["id"])
        bad = [e["ts"] for e in evs if not e.get("ok", True) and now - e["ts"] <= win]
        if len(bad) >= cfg["errors_n"]:
            add("errors", n["id"], "warn", f"{n['id']}: {len(bad)} failed tool calls in {_dur(win)}", min(bad))
    usd = (extra.get("totals") or {}).get("usd_today")
    lim = cfg["daily_budget_usd"]
    if lim and usd is not None and usd >= 0.8 * lim:
        day0 = _ts_day0(now)
        add("budget", None, "bad" if usd >= lim else "warn", f"today's cost ${usd:.2f} of ${lim:g} budget ({int(100 * usd / lim)} %)", day0)
    try:
        plan = extra.get("plan") or {}
        wins = plan.get("windows") or []
        top = max(wins, key=lambda w: w["pct"]) if wins else None
        rejected = plan.get("status") == "rejected"
        for w in wins:
            lvl = "bad" if w["pct"] >= 95 or (rejected and w is top) else "warn" if w["pct"] >= 80 else None
            if lvl:
                import usage
                when = f" - resets {usage.fmt_reset(w['resets_at'], now)} (in {_dur(w['resets_at'] - now)})" if w.get("resets_at") else ""
                add("plan", w["name"], lvl, f"{w['label']} limit {w['pct']:.0f} %{when}", plan.get("as_of") or now)
        if rejected and not wins:
            add("plan", "limit", "bad", "plan limit reached", plan.get("as_of") or now)
    except Exception:
        pass
    sv = ctx.get("service") or {}
    over = _num(sv.get("socket_ms"), 0) > cfg["service_ms"] or _num(sv.get("cpu_pct"), 0) > cfg["service_cpu_pct"]
    if over:
        seen.add("service")
        first = _track.setdefault("service", now)
        if now - first >= cfg["service_for_s"]:
            why = f"socket {sv.get('socket_ms')} ms" if _num(sv.get("socket_ms"), 0) > cfg["service_ms"] else f"CPU {sv.get('cpu_pct')} %"
            add("service", None, "warn", f"service slow: {why} for {_dur(now - first)}", first)
    for k in [k for k in _track if k not in seen]:
        _track.pop(k, None)
    out.sort(key=lambda a: (-a["since"], a["id"]))
    return out[:ALERTS_MAX]


def _ts_day0(now):
    lt = time.localtime(now)
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))


# ---------------------------------------------------------------- private projects: the one choke point
_pn = {"key": None, "t": float("-inf"), "ids": frozenset()}


def private_nodes():
    """Node ids (threads "tN", runs "run:<id>") of hidden private projects, from the thread registry, the ledger (two days)
    and the running runs. Empty while private mode is shown. Cached 2 s."""
    try:
        import lean_private
        if not (lean_private.hidden() and lean_private.private_slugs()):
            return frozenset()
        mono = time.monotonic()
        with _lock:
            if _pn["key"] == 1 and mono - _pn["t"] < 2.0:
                return _pn["ids"]
        import lean_activity
        import lean_common
        import lean_threads
        ids = set()
        for tid in ((lean_threads.load_ro() or {}).get("threads") or {}):
            if lean_private.hides(thread=tid):
                ids.add(tid)
        home = lean_common.lean_home()
        since = time.strftime("%Y-%m-%dT00:00:00", time.localtime(time.time() - 2 * 86400))
        for r in lean_activity.ledger_since(home, since):
            if r.get("id") and (lean_private.hides(r) or (r.get("project") and lean_private.hides(project=r.get("project")))):
                ids.add("run:" + str(r["id"]))
                if r.get("thread"):
                    ids.add(str(r["thread"]))
        for rid, m in lean_common.running_runs(home):
            if lean_private.hides(thread=m.get("thread") or None) or (m.get("project") and lean_private.hides(project=m.get("project"))):
                ids.add("run:" + str(rid))
        ids = frozenset(ids)
        with _lock:
            _pn.update(key=1, t=mono, ids=ids)
        return ids
    except Exception:
        return frozenset()


def _is_private_text(*texts):
    try:
        import lean_private
        return any(t and lean_private.mentions_private(t) for t in texts)
    except Exception:
        return False


def redact(snap):
    """Every map output (snapshot, SVG, alerts, feed, ...) goes through here right before it leaves: while private mode is off
    it drops the nodes of private projects (and what hangs off them: children, edges, moving texts, feed lines, alerts, project
    rows, activity entries) plus free text that names a private project. Returns snap itself when nothing is hidden."""
    try:
        import lean_private
        if not isinstance(snap, dict) or not (lean_private.hidden() and lean_private.private_slugs()):
            return snap
    except Exception:
        return snap
    priv = set(private_nodes())
    txt = _is_private_text
    drop = set()
    for n in snap.get("nodes") or []:
        if n.get("kind") in ("service", "desk", "hooks") or n.get("id") in ("service", "main", "hooks"):
            continue
        if (n.get("id") in priv or n.get("parent") in priv or lean_private.hides(project=n.get("project") or None)
                or txt(n.get("title"), n.get("label"))):
            drop.add(n.get("id"))
    for n in snap.get("nodes") or []:  # children of a dropped thread
        if n.get("parent") in drop:
            drop.add(n.get("id"))
    out = dict(snap)
    out["nodes"] = []
    for n in snap.get("nodes") or []:
        if n.get("id") in drop:
            continue
        a = n.get("activity")
        if isinstance(a, dict) and isinstance(a.get("recent"), list):
            n = dict(n, activity=dict(a, recent=[e for e in a["recent"] if not txt(e.get("target"))]))
            if txt(((a.get("now") or {}).get("target"))):
                n["activity"]["now"] = None
        out["nodes"].append(n)
    bad = drop | priv
    if "edges" in snap:
        out["edges"] = [e for e in snap["edges"] if e.get("from") not in bad and e.get("to") not in bad and not txt(e.get("label"))]
    if "moving" in snap:
        out["moving"] = [m for m in snap["moving"] if m.get("node") not in bad and not txt(m.get("text"))]
    if "placed" in snap:
        out["placed"] = [i for i in snap["placed"] if i not in drop]
    if "feed" in snap:
        out["feed"] = [f for f in snap["feed"] if f.get("node") not in bad and not txt(f.get("text"))]
    if "alerts" in snap:
        out["alerts"] = [a for a in snap["alerts"] if a.get("node") not in bad and not txt(a.get("text"))]
    if "projects" in snap:
        out["projects"] = [p for p in snap["projects"] if not lean_private.hides(project=p.get("slug"))]
    return out


def _hidden_now():
    try:
        import lean_private
        return bool(lean_private.hidden() and lean_private.private_slugs())
    except Exception:
        return False


def redact_events(events):
    """/replay items: dropped when their node or ends are private or their target names a private project."""
    if not _hidden_now():
        return events
    bad = private_nodes()
    return [e for e in events if e.get("node") not in bad and e.get("from") not in bad and e.get("to") not in bad
            and not _is_private_text(e.get("target"))]


# ---------------------------------------------------------------- history
HIST_TTL = 60.0
_hcache = {}


def _row_usd(r, usage):
    u = r.get("usage") if isinstance(r.get("usage"), dict) else {}
    u = {k: _num(v, 0) for k, v in u.items()}
    c = r.get("cost_usd")
    return (c if isinstance(c, (int, float)) and not isinstance(c, bool) else usage.estimate_usd(u, r.get("model"))), u


def history(home, days=14, now=None, rows=None):
    """/history: per-day totals (oldest first, empty days zero), the last week's top threads and tools. Hidden private
    projects are left out. `rows` (tests) replaces the ledger read."""
    import lean_activity as act
    import usage
    now = now or time.time()
    days = max(1, min(90, int(days)))
    base = _ts_day0(now)
    dates = [time.strftime("%Y-%m-%d", time.localtime(base - i * 86400 + 43200)) for i in range(days - 1, -1, -1)]
    since = dates[0] + "T00:00:00"
    wk = time.strftime("%Y-%m-%dT00:00:00", time.localtime(base - 6 * 86400 + 43200))
    if rows is None:
        rows = act.ledger_since(home, since)
    per = {d: {"date": d, "usd": 0.0, "tokens": 0, "saved": 0, "runs": 0, "cache_read": 0, "ctx": 0, "by_model": {}, "by_project": {}} for d in dates}
    threads = {}
    try:
        import lean_private
        hides = lean_private.hides
    except Exception:
        hides = lambda *a, **k: False  # noqa: E731
    for r in rows:
        d = str(r.get("ts") or "")[:10]
        x = per.get(d)
        if x is None or hides(r) or (r.get("project") and hides(project=r.get("project"))):
            continue
        usd, u = _row_usd(r, usage)
        x["usd"] += usd
        x["tokens"] += int(_num(r.get("weighted"), 0) or usage.weighted(u))
        try:
            x["saved"] += act.run_saved(r, home)
        except Exception:
            pass
        x["runs"] += 1
        x["cache_read"] += u.get("cache_read_input_tokens", 0)
        x["ctx"] += usage.context_tokens(u)
        fam = act._family(r.get("model")) or "other"
        x["by_model"][fam] = x["by_model"].get(fam, 0.0) + usd
        proj = r.get("project") or "other"
        x["by_project"][proj] = x["by_project"].get(proj, 0.0) + usd
        tag = str(r.get("thread") or "")
        if tag and str(r.get("ts") or "") >= wk:
            tag = "t" + tag.lstrip("#t") if tag.lstrip("#t").isdigit() else tag
            t = threads.setdefault(tag, {"node": tag, "title": tag, "usd": 0.0, "tokens": 0})
            t["usd"] += usd
            t["tokens"] += int(_num(r.get("weighted"), 0) or usage.weighted(u))
    out = []
    for d in dates:
        x = per[d]
        out.append({"date": d, "usd": round(x["usd"], 2), "tokens": x["tokens"], "saved": x["saved"], "runs": x["runs"],
                    "cache_read_ratio": round(x["cache_read"] / x["ctx"], 2) if x["ctx"] else 0,
                    "by_model": {k: round(v, 2) for k, v in sorted(x["by_model"].items(), key=lambda kv: -kv[1])},
                    "by_project": {k: round(v, 2) for k, v in sorted(x["by_project"].items(), key=lambda kv: -kv[1])}})
    top = sorted(threads.values(), key=lambda t: (-t["usd"], t["node"]))[:10]
    try:
        import lean_threads
        reg = (lean_threads.load_ro() or {}).get("threads") or {}
        for t in top:
            t["title"] = (reg.get(t["node"]) or {}).get("title") or t["node"]
    except Exception:
        pass
    for t in top:
        t["usd"] = round(t["usd"], 2)
    try:
        plan = usage.plan_history(now)
    except Exception:
        plan = []
    return {"days": out, "top_threads": top, "tools_7d": act.tools_week(now, skip=private_nodes()), "plan": plan}


def history_cached(home, days=14, now=None):
    """history(), cached 60 s per (home, days); nothing is computed until asked."""
    try:
        import lean_private
        key = (home, int(days), lean_private.hidden())
    except Exception:
        key = (home, int(days), None)
    mono = time.monotonic()
    with _lock:
        c = _hcache.get(key)
        if c and mono - c[0] < HIST_TTL:
            return c[1]
    h = history(home, days, now)
    with _lock:
        _hcache[key] = (mono, h)
    return h


def alerts_now():
    """Current alerts of the running service (for `map --alerts` and doctor)."""
    return snapshot_now().get("alerts") or []


def down_snapshot(inbox=0, now=None):
    return {"v": 1, "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now or time.time())), "service": {"up": False},
            "nodes": [], "edges": [], "moving": [], "inbox": inbox}


def _cpu():
    t0, c0, last = _state["cpu"]
    t1, c1 = time.monotonic(), time.process_time()
    if t1 - t0 >= 1.0:
        last = round(100.0 * (c1 - c0) / (t1 - t0), 1)
        _state["cpu"] = (t1, c1, last)
    return last


THREAD_TTL = 8.0  # seconds a thread's liveness/turn state is reused
RUNS_TTL = 4.0
BUDGET_S = 0.06  # time the liveness probes may take per snapshot; stale entries refresh over the next snapshots
_tcache = {}
_rcache = [0.0, []]


def _thread_state(tid, ss, lean_private):
    alive = ss.alive_thread(tid)
    pend = ss.spool_pending(tid)
    mid = alive and ss.mid_turn(tid)
    try:
        idle = int(ss._quiet_secs(ss.session_transcript(tid))) if alive else 0
    except Exception:
        idle = 0
    t = {"idle_s": idle, "mid": bool(mid)}
    if pend and not mid:
        why = ss.delivery_reason(tid) or "not delivered yet"
        t.update(state="undelivered", undelivered=True, detail=str(why)[:80])
    elif mid:
        t.update(state="active", detail="mid-turn")
    elif alive:
        t.update(state="idle", detail=f"idle {_dur(idle)}")
    else:
        t.update(state="parked", detail="parked")
    return t


def service_context(now=None):
    """The ctx of the running service, from memory and the cached liveness helpers (hidden items left out)."""
    import lean_common
    import lean_private
    import lean_threads
    import service_session as ss
    now = now or time.time()
    data = lean_threads.load_ro()
    threads = []
    mono = time.monotonic()
    deadline = mono + BUDGET_S
    items = [(tid, rec) for tid, rec in sorted((data.get("threads") or {}).items(), key=lambda x: (len(x[0]), x[0]))
             if not (tid == "main" or not tid.startswith("t") or rec.get("closed") or lean_private.hides(thread=tid))]
    for tid, rec in items:
        c = _tcache.get(tid)
        if (not c or mono - c[0] > THREAD_TTL) and time.monotonic() < deadline:
            try:
                c = (mono, _thread_state(tid, ss, lean_private))
            except Exception:
                c = c or (mono, {"idle_s": 0, "mid": False, "state": "parked", "detail": "parked"})
            _tcache[tid] = c
        elif not c:  # over budget, never probed: shown parked until a later snapshot probes it
            c = (mono, {"idle_s": 10 ** 6, "mid": False, "state": "parked", "detail": "parked"})
        threads.append(dict(c[1], id=tid, title=rec.get("title") or tid, project=rec.get("project") or None))
    for tid in [k for k in _tcache if k not in {t["id"] for t in threads}]:
        _tcache.pop(tid, None)
    runs = []
    try:
        if mono - _rcache[0] > RUNS_TTL:
            _rcache[:] = [mono, lean_common.running_runs(lean_common.lean_home())]
        for rid, m in _rcache[1]:
            tid = m.get("thread") or ""
            if lean_private.hides(thread=tid or None) or (m.get("project") and lean_private.hides(project=m.get("project"))):
                continue
            st = m.get("started")
            try:
                age = now - (time.mktime(time.strptime(st[:19], "%Y-%m-%dT%H:%M:%S")) if isinstance(st, str) else float(st))
            except Exception:
                age = 0
            if tid and rid not in _seen_runs and age < 120:
                run_started(rid, tid, m.get("model") or "")
            elif rid not in _seen_runs:
                _seen_runs[rid] = 1  # already running when the map first looked: not a new task
            runs.append({"id": rid, "thread": tid, "model": m.get("model"), "project": m.get("project"), "age_s": age, "workdir": m.get("workdir"), "branch": m.get("branch"),
                         "progress_s": max(0, now - (m.get("last_progress") or now)), "orphaned": bool(m.get("orphaned"))})
    except Exception:
        pass
    try:
        inbox = len((ss._load(ss.reports_path()).get("items") or []))
    except Exception:
        inbox = 0
    desk = [e["ts"] for e in events(now) if e["from"] == "main" or e["to"] == "main"]
    rows = []
    try:
        import lean_activity
        rows = [r for r in lean_activity.ledger_today(lean_common.lean_home())
                if not (lean_private.hides(r) or (r.get("project") and lean_private.hides(project=r.get("project"))))]
    except Exception:
        pass
    rr = [r for r in runs if r["thread"] in {t["id"] for t in threads}]
    for t in threads:  # a thread without its own project tag takes the project of its runs
        if not t.get("project"):
            ps = collections.Counter(r["project"] for r in rr if r["thread"] == t["id"] and r.get("project"))
            t["project"] = ps.most_common(1)[0][0] if ps else None
    return {"rows": rows, "home": lean_common.lean_home(), "service": {"pid": os.getpid(), "version": ctx_version(), "socket_ms": round(_state["ms"] or 0.0, 1), "cpu_pct": _cpu(),
                        "threads": threading.active_count(), "up_s": int(now - STARTED)},
            "paused": _paused(), "inbox": inbox, "threads": threads,
            "runs": rr, "desk_idle_s": int(now - max(desk)) if desk else 3600}


VERSION = ""


def ctx_version():
    return VERSION


def _paused():
    try:
        import lean_goals
        return bool(lean_goals.paused())
    except Exception:
        return False


def snapshot_now():
    return redact(build(service_context()))


def inbox_from_files():
    try:
        import service_session as ss
        return len((ss._load(ss.reports_path()).get("items") or []))
    except Exception:
        return 0


def fetch(timeout=1.0):
    """One snapshot through the service socket, else the service-not-running one. Never raises."""
    try:
        import lean_sock
        r = lean_sock.call("map", timeout=timeout)
        if r and r.get("ok") and isinstance(r.get("map"), dict):
            return redact(r["map"])
    except Exception:
        pass
    return down_snapshot(inbox_from_files())


def signature(snap):
    """What a --watch line compares: the shape of the map, not the clocks."""
    return json.dumps([snap.get("service", {}).get("up"), snap.get("paused"), snap.get("inbox"),
                       [(n["id"], n["state"]) for n in snap.get("nodes", [])],
                       [(e["from"], e["to"], e["kind"], e["label"]) for e in snap.get("edges", [])],
                       [(m["node"], m["text"]) for m in snap.get("moving", [])],
                       [(n["id"], (n.get("activity") or {}).get("last_ts"), ((n.get("activity") or {}).get("now") or {}).get("tool"))
                        for n in snap.get("nodes", []) if n.get("activity")]])


def watch(out, fetcher=fetch, interval=0.5, stop=None, sleep=time.sleep):
    """One JSON snapshot per line whenever the map changes, at most 2 per second."""
    last = None
    while not (stop and stop()):
        snap = fetcher()
        sig = signature(snap)
        if sig != last:
            last = sig
            out.write(json.dumps(snap) + "\n")
            out.flush()
        sleep(interval)


# ------------------------------------------------------------------ drawing
def _e(s):
    return html.escape(str(s), quote=True)


def _clip(s, n):
    s = str(s)
    return s if len(s) <= n else s[:n - 1] + "…"


def layout(snap, width, height, mini=False):
    """{node id: (cx, cy, w, h)} for the placed nodes only (see select): service centre, desk left, threads in a column
    right (sorted by id), workers right of their thread (at most MAX_WORKERS), front-desk workers under the desk, hooks
    below the service. Returns (pos, number left out)."""
    nodes = snap.get("nodes", [])
    sel = {"placed": snap["placed"], "more": snap.get("more", 0)} if isinstance(snap.get("placed"), list) else select(nodes)
    ok = set(sel["placed"])
    th = sorted([n for n in nodes if n["kind"] == "thread" and n["id"] in ok], key=lambda n: (len(n["id"]), n["id"]))
    nw, nh = (92, 30) if mini else (170, 46)
    pos = {}
    top, bottom = 40, height - 40
    step = (bottom - top) / max(1, len(th))
    xt = width * 0.60
    for i, n in enumerate(th):
        pos[n["id"]] = (xt, top + step * (i + 0.5), nw, nh)
    xw = width * 0.86
    byp = {}
    for n in nodes:
        if n["kind"] == "worker" and n["id"] in ok:
            byp.setdefault(n.get("parent") if n.get("parent") in pos else "main", []).append(n)
    ww, wh = nw * 0.8, nh * 0.7
    cy = height / 2
    for p, ws in byp.items():
        ws = ws[:MAX_WORKERS]
        if p == "main":
            for j, w in enumerate(ws):
                pos[w["id"]] = (width * 0.08 + nw / 2, cy + nh + 14 + j * (wh + 6) + wh / 2, ww, wh)
            continue
        py = pos[p][1]
        gap = min(wh + 4, step / max(1, len(ws)))
        for j, w in enumerate(ws):
            pos[w["id"]] = (xw, py + (j - (len(ws) - 1) / 2) * gap, ww, min(wh, gap - 1) if len(ws) > 1 else wh)
    pos["service"] = (width * 0.32, cy, nw, nh + 10)
    pos["main"] = (width * 0.08 + nw / 2, cy, nw, nh)
    pos["hooks"] = (width * 0.32, min(height - 30, cy + height * 0.28), nw, nh)
    return pos, int(sel.get("more") or 0)


def svg(snap, width=1200, height=700, mini=False):
    """The snapshot as one standalone SVG document (no script, no external references)."""
    snap = redact(snap)
    width, height = int(width or 1200), int(height or 700)
    if mini:
        width, height = int(width or 480), int(height or 320)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
           f'font-family="Inter, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">',
           f'<rect width="{width}" height="{height}" fill="{BG}"/>', "<defs>"]
    for k, c in COLORS.items():
        out.append(f'<marker id="a-{k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
                   f'<path d="M0 0L10 5L0 10z" fill="{c}"/></marker>')
    out.append("</defs>")
    if not snap.get("service", {}).get("up") or not snap.get("nodes"):
        out.append(f'<text x="{width / 2}" y="{height / 2}" fill="{MUTED}" font-size="18" text-anchor="middle">'
                   f'Service not running · inbox {int(snap.get("inbox") or 0)}</text></svg>')
        return "\n".join(out)
    pos, more = layout(snap, width, height, mini)
    nodes = {n["id"]: n for n in snap["nodes"]}

    def edge_pt(a, b):
        ax, ay, aw, ah = pos[a]
        bx, by, bw, bh = pos[b]
        dx, dy = bx - ax, by - ay
        def clip(cx, cy, w, h, sx, sy):
            tx = (w / 2) / abs(sx) if sx else 1e9
            ty = (h / 2) / abs(sy) if sy else 1e9
            t = min(tx, ty)
            return cx + sx * t, cy + sy * t
        return clip(ax, ay, aw, ah, dx, dy), clip(bx, by, bw, bh, -dx, -dy)

    for ed in snap.get("edges", []):
        if ed["from"] not in pos or ed["to"] not in pos:
            continue
        kind = "bad" if ed.get("bad") else ed["kind"] if ed["kind"] in COLORS else "idle"
        (x1, y1), (x2, y2) = edge_pt(ed["from"], ed["to"])
        col = COLORS[kind]
        dash = ' stroke-dasharray="6 5"' if kind == "idle" else ""
        op = 0.35 if kind == "idle" else max(0.35, 1 - ed.get("age_s", 0) / 300) if kind != "bad" else 1
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{col}" stroke-width="{1 if kind == "idle" else 2}"{dash} '
                   f'opacity="{op:.2f}" marker-end="url(#a-{kind})" data-kind="{kind}"/>')
        if not mini and ed.get("label") and kind != "idle":
            out.append(f'<text x="{(x1 + x2) / 2:.1f}" y="{(y1 + y2) / 2 - 4:.1f}" fill="{MUTED}" font-size="10" text-anchor="middle">{_e(_clip(ed["label"], 28))}</text>')
    for nid, (cx, cy, w, h) in pos.items():
        n = nodes.get(nid)
        if not n:
            continue
        st = n["state"]
        stroke = {"active": COLORS["message"], "alive": COLORS["message"], "undelivered": COLORS["bad"], "dead": COLORS["bad"],
                  "orphaned": COLORS["report"], "done": COLORS["report"]}.get(st, BORDER)
        dash = ' stroke-dasharray="5 4"' if st in ("idle", "parked", "orphaned") else ""
        sw = 2.5 if st in ("active", "alive", "undelivered") else 1.5
        x, y = cx - w / 2, cy - h / 2
        if mini:
            out.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{h / 2 + 2:.1f}" fill="{CARD}" stroke="{stroke}" stroke-width="{sw}"{dash} data-node="{_e(nid)}"/>')
            out.append(f'<text x="{cx:.1f}" y="{cy + 3:.1f}" fill="{TEXT}" font-size="9" text-anchor="middle" font-family="JetBrains Mono, ui-monospace, Menlo, monospace">{_e(_clip(nid.split(":")[-1][-6:], 6))}</text>')
            continue
        out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="8" fill="{CARD}" stroke="{stroke}" stroke-width="{sw}"{dash} data-node="{_e(nid)}"/>')
        mono = "JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
        idtxt = nid if n["kind"] in ("thread",) else ""
        out.append(f'<text x="{x + 8:.1f}" y="{y + 16:.1f}" fill="{TEXT}" font-size="12" font-weight="600">{_e(_clip(n["label"], int(w / 7.2)))}</text>')
        out.append(f'<text x="{x + 8:.1f}" y="{y + 31:.1f}" fill="{MUTED}" font-size="10">{_e(_clip(n.get("detail") or st, int(w / 5.6)))}</text>')
        if idtxt:
            out.append(f'<text x="{x + w - 6:.1f}" y="{y + 14:.1f}" fill="{MUTED}" font-size="9" text-anchor="end" font-family="{mono}">{_e(idtxt)}</text>')
    if more > 0:
        out.append(f'<text x="{width * 0.60:.1f}" y="{height - 12}" fill="{MUTED}" font-size="12" text-anchor="middle">+{more} more</text>')
    if not mini:
        mv = snap.get("moving", [])[:5]
        for i, m in enumerate(mv):
            out.append(f'<text x="14" y="{height - 14 - 14 * i}" fill="{COLORS["message"] if m["dir"] == "to" else COLORS["report"]}" font-size="11">'
                       f'{_e(m["node"])} · {_e(m["text"])} · {_dur(m["age_s"])} ago</text>')
        out.append(f'<text x="14" y="20" fill="{MUTED}" font-size="12">inbox {int(snap.get("inbox") or 0)}{" · paused" if snap.get("paused") else ""}</text>')
    out.append("</svg>")
    return "\n".join(out)
