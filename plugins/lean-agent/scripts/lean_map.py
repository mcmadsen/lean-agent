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


def _age(t, now):
    return round(max(0.0, now - t), 1)


def _dur(s):
    s = int(s)
    return f"{s} s" if s < 90 else f"{s // 60} min" if s < 5400 else f"{s // 3600} h"


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
        n = {"id": t["id"], "kind": "thread", "label": t.get("title") or t["id"], "state": t["state"], "detail": t.get("detail") or t["state"]}
        nodes.append(n)
    for r in ctx.get("runs") or []:
        st = "done" if r.get("done") else "orphaned" if r.get("orphaned") else "alive" if r.get("alive", True) else "dead"
        nodes.append({"id": "run:" + r["id"], "kind": "worker", "parent": r.get("thread"), "label": "run " + r["id"].split("-")[-1],
                      "model": r.get("model") or "", "state": st,
                      "detail": f"{_dur(r.get('age_s', 0))} · progress {_dur(r.get('progress_s', 0))} ago"})
    have = {n["id"] for n in nodes}
    tids = {n["id"] for n in nodes if n["kind"] == "thread"}
    for e in sorted(ev, key=lambda e: e["ts"]):  # runs the ring knows (just ended or started) but the live list no longer / not yet shows
        m = e.get("meta")
        node = e["from"] if e["from"].startswith("run:") else e["to"] if e["to"].startswith("run:") else None
        if m and node and node not in have and m.get("thread") in tids:
            have.add(node)
            nodes.append({"id": node, "kind": "worker", "parent": m["thread"], "label": "run " + node.split("-")[-1],
                          "model": m.get("model") or "", "state": m["state"],
                          "detail": m.get("status") or ("done" if m["state"] == "done" else "ended")})
    nodes.append({"id": "hooks", "kind": "hooks", "label": "Hooks", "state": "active" if reqs else "idle", "detail": f"{len(reqs)} a min"})
    ids = {n["id"] for n in nodes}
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
        if t.get("undelivered"):
            edges.append({"from": "service", "to": t["id"], "kind": "message", "age_s": t.get("idle_s", 0), "label": "undelivered", "bad": True})
        elif t["id"] not in busy:
            edges.append({"from": "service", "to": t["id"], "kind": "idle", "age_s": t.get("idle_s", 0), "label": "idle"})
    if "main" not in busy:
        edges.append({"from": "main", "to": "service", "kind": "idle", "age_s": ctx.get("desk_idle_s", 0), "label": "idle"})
    for n in nodes:
        if n["kind"] == "worker" and ("run:" + n["id"][4:]) not in busy and n["parent"] in ids:
            edges.append({"from": n["id"], "to": n["parent"], "kind": "idle" if n["state"] != "done" else "report",
                          "age_s": 0, "label": "done" if n["state"] == "done" else "idle"})
    moving = [{"dir": e["dir"], "node": e["node"], "text": e["text"], "age_s": _age(e["ts"], now)}
              for e in sorted(ev, key=lambda e: -e["ts"]) if e.get("text") and e.get("node")][:8]
    return {"v": 1, "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)), "service": sv, "paused": bool(ctx.get("paused")),
            "inbox": int(ctx.get("inbox") or 0), "nodes": nodes, "edges": edges, "moving": moving}


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


def service_context(now=None):
    """The ctx of the running service, from memory and the cached liveness helpers (hidden items left out)."""
    import lean_common
    import lean_private
    import lean_threads
    import service_session as ss
    now = now or time.time()
    data = lean_threads.load_ro()
    threads = []
    for tid, rec in sorted((data.get("threads") or {}).items(), key=lambda x: (len(x[0]), x[0])):
        if tid == "main" or not tid.startswith("t") or lean_private.hides(thread=tid):
            continue
        alive = ss.alive_thread(tid)
        pend = ss.spool_pending(tid)
        mid = alive and ss.mid_turn(tid)
        try:
            idle = int(ss._quiet_secs(ss.session_transcript(tid))) if alive else 0
        except Exception:
            idle = 0
        t = {"id": tid, "title": rec.get("title") or tid, "idle_s": idle, "mid": bool(mid)}
        if pend and not mid:
            why = ss.delivery_reason(tid) or "not delivered yet"
            t.update(state="undelivered", undelivered=True, detail=str(why)[:80])
        elif mid:
            t.update(state="active", detail="mid-turn")
        elif alive:
            t.update(state="idle", detail=f"idle {_dur(idle)}")
        else:
            t.update(state="parked", detail="parked")
        threads.append(t)
    runs = []
    try:
        for rid, m in lean_common.running_runs(lean_common.lean_home()):
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
            runs.append({"id": rid, "thread": tid, "model": m.get("model"), "age_s": age,
                         "progress_s": max(0, now - (m.get("last_progress") or now)), "orphaned": bool(m.get("orphaned"))})
    except Exception:
        pass
    try:
        inbox = len((ss._load(ss.reports_path()).get("items") or []))
    except Exception:
        inbox = 0
    desk = [e["ts"] for e in events(now) if e["from"] == "main" or e["to"] == "main"]
    return {"service": {"pid": os.getpid(), "version": ctx_version(), "socket_ms": round(_state["ms"] or 0.0, 1), "cpu_pct": _cpu(),
                        "threads": threading.active_count(), "up_s": int(now - STARTED)},
            "paused": _paused(), "inbox": inbox, "threads": threads,
            "runs": [r for r in runs if r["thread"] in {t["id"] for t in threads}], "desk_idle_s": int(now - max(desk)) if desk else 3600}


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
    return build(service_context())


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
            return r["map"]
    except Exception:
        pass
    return down_snapshot(inbox_from_files())


def signature(snap):
    """What a --watch line compares: the shape of the map, not the clocks."""
    return json.dumps([snap.get("service", {}).get("up"), snap.get("paused"), snap.get("inbox"),
                       [(n["id"], n["state"]) for n in snap.get("nodes", [])],
                       [(e["from"], e["to"], e["kind"], e["label"]) for e in snap.get("edges", [])],
                       [(m["node"], m["text"]) for m in snap.get("moving", [])]])


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
    """{node id: (cx, cy, w, h)}: service centre, desk left, threads in a column right (sorted by id), workers right of
    their thread, hooks below the service. Threads beyond MAX_THREADS are not placed."""
    nodes = snap.get("nodes", [])
    th = sorted([n for n in nodes if n["kind"] == "thread"], key=lambda n: (len(n["id"]), n["id"]))[:MAX_THREADS]
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
        if n["kind"] == "worker" and n.get("parent") in pos:
            byp.setdefault(n["parent"], []).append(n)
    for p, ws in byp.items():
        py = pos[p][1]
        ww = nw * 0.8
        for j, w in enumerate(ws[:3]):
            pos[w["id"]] = (xw, py + (j - (min(len(ws), 3) - 1) / 2) * min(step, nh * 0.9) / max(1, min(len(ws), 3)) * 1.0, ww, nh * 0.7)
    cy = height / 2
    pos["service"] = (width * 0.32, cy, nw, nh + 10)
    pos["main"] = (width * 0.08 + nw / 2, cy, nw, nh)
    pos["hooks"] = (width * 0.32, min(height - 30, cy + height * 0.28), nw, nh)
    return pos, len([n for n in nodes if n["kind"] == "thread"]) - len(th)


def svg(snap, width=1200, height=700, mini=False):
    """The snapshot as one standalone SVG document (no script, no external references)."""
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
        op = max(0.35, 1 - ed.get("age_s", 0) / 300) if kind not in ("idle", "bad") else 1
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{col}" stroke-width="2"{dash} '
                   f'opacity="{op:.2f}" marker-end="url(#a-{kind})" data-kind="{kind}"/>')
        if not mini and ed.get("label"):
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
