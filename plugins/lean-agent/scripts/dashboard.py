"""lean-agent's local dashboard: one page on http://127.0.0.1:<port>/?t=<token> that refreshes itself.

It shows what lean-agent's own files say (runs, the work queue, scheduled jobs, reviews, pushes, plan pace, the
orchestrator's context) and nothing else. It listens on 127.0.0.1 only, answers only requests that carry its token
and a local Host header, and never changes anything. `lean-agent up` starts it in the background; `lean-agent
dashboard` runs it on its own. The port and token are kept in ~/.lean-agent/dashboard.json, so a tab you opened
(e.g. in Claude Desktop's built-in browser) keeps working after a restart.
"""
import datetime
import glob
import html
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import usage  # noqa: E402
import lean_schedule  # noqa: E402

DEFAULT_PORT = 8765


def home(*parts):
    return os.path.join(usage.lean_home(), *parts)


def _json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def _jsonl(path, tail=2000):
    try:
        with open(path) as fh:
            lines = fh.readlines()[-tail:]
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def settings():
    """{"port", "token"}: kept, so the dashboard's address doesn't change between restarts."""
    path = home("dashboard.json")
    cur = _json(path, {})
    if not cur.get("token"):
        cur = {"port": cur.get("port") or DEFAULT_PORT, "token": secrets.token_urlsafe(16)}
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump(cur, fh)
    return cur


def url(cfg=None):
    cfg = cfg or settings()
    return f"http://127.0.0.1:{cfg['port']}/?t={cfg['token']}"


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def orchestrator_context():
    """The latest orchestrator conversation: context now, the compaction point, calls."""
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    h = home("home")
    found = []
    for d in dict.fromkeys([h, os.path.realpath(h)]):
        found += glob.glob(os.path.join(cfg, "projects", re.sub(r"[^A-Za-z0-9]", "-", d), "*.jsonl"))
    if not found:
        return {}
    path = max(found, key=os.path.getmtime)
    series = usage.context_series(path)
    window = int(os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") or 100000)
    pct = float(os.environ.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE") or 70)
    compact_at = int(min((window - 4000) * pct / 100, window - 17000))
    return {"now": series[-1][1] if series else 0, "calls": len(series), "compact_at": compact_at,
            "trend": [c for _, c in series[-60:]],
            "updated": datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")}


def state():
    now = datetime.datetime.now()
    week_ago = (now - datetime.timedelta(days=7)).isoformat()
    ledger = _jsonl(home("ledger.jsonl"))
    running = []
    for f in glob.glob(home("running", "*.json")):
        m = _json(f, {})
        if _alive(m.get("pid")):
            running.append({k: m.get(k) for k in ("run", "started", "model", "project", "task")})
    runs = [{"id": r.get("id"), "ts": r.get("ts"), "status": r.get("status"), "model": r.get("model"),
             "project": r.get("project"), "role": r.get("role"), "units": r.get("units", 0),
             "cost": r.get("cost_usd"), "turns": r.get("turns"),
             "head": " ".join(str(r.get("result_head") or r.get("task") or "").split())[:160]}
            for r in ledger[-25:]][::-1]
    week = [r for r in ledger if str(r.get("ts", "")) >= week_ago]
    todo = _json(home("todo.json"), {}).get("items") or []
    open_todo = sorted([t for t in todo if t.get("status") != "done"],
                       key=lambda t: (t.get("status") != "doing", {"high": 0, "low": 2}.get(t.get("prio"), 1),
                                      t.get("due") or "9999", t.get("id", 0)))
    jobs = []
    for j in lean_schedule.jobs():
        try:
            nxt = lean_schedule.next_run(j) if j.get("enabled", True) else None
        except (ValueError, KeyError, TypeError):
            nxt = None
        jobs.append({"id": j.get("id"), "when": j.get("when"), "cmd": " ".join(j.get("args") or []),
                     "next": nxt.isoformat(timespec="minutes") if nxt else None, "last": j.get("last"),
                     "enabled": j.get("enabled", True)})
    reviews = {}
    for f in glob.glob(home("reviews", "*.jsonl")):
        slug = os.path.basename(f)[:-6]
        if "." in slug:
            continue
        for r in _jsonl(f, 300):
            reviews[(slug, r.get("ref") or "working tree")] = r
    latest_reviews = sorted(({"project": p, "ref": ref, "verdict": r.get("verdict"), "ts": r.get("ts"),
                              "head": str(r.get("head", ""))[:10],
                              "blocking": sum(1 for x in r.get("findings") or [] if x.get("severity") in ("blocker", "major"))}
                             for (p, ref), r in reviews.items()), key=lambda r: r["ts"] or "", reverse=True)[:8]
    real, age = usage.plan_usage()
    pace, ahead = usage.week_pace()
    return {
        "now": now.isoformat(timespec="seconds"),
        "pace": pace, "ahead": ahead,
        "plan": {k: v for k, v in (real or {}).items() if k in ("five_hour", "seven_day")}, "plan_age_min": age,
        "running": running, "runs": runs,
        "week": {"runs": len(week), "done": sum(r.get("status") == "done" for r in week),
                 "units": sum(r.get("units", 0) for r in week), "cost": round(sum(r.get("cost_usd") or 0 for r in week), 2)},
        "todo": open_todo[:30], "todo_done_week": sum(1 for t in todo if t.get("status") == "done"
                                                      and (t.get("done_at") or "") >= week_ago),
        "schedule": jobs, "scheduled_results": lean_schedule.results_since(week_ago)[-10:][::-1],
        "reviews": latest_reviews,
        "pushes": [p for p in _jsonl(home("pushes.jsonl"), 50) if p.get("ts", "") >= week_ago][-8:][::-1],
        "context": orchestrator_context(),
        "notes": _json(home("handoff-notes.json"), []),
    }


def run_text(run_id, details=False):
    """A run's saved summary (or its details file), for the run view."""
    r = next((x for x in reversed(_jsonl(home("ledger.jsonl"))) if x.get("id") == run_id), None)
    if not r or not r.get("workdir"):
        return None
    pattern = "details-*.md" if details else "summary-*.txt"
    files = sorted(glob.glob(os.path.join(r["workdir"], pattern)),
                   key=lambda f: int(re.sub(r"\D", "", os.path.basename(f)) or 0))
    if not files:
        return "(nothing saved for this run)"
    with open(files[-1], errors="replace") as fh:
        return fh.read()


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>lean-agent</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2127;--mute:#69717d;--line:#e3e6ea;--ok:#1f8f4e;--warn:#b26a00;--bad:#c4323b;--accent:#3559c7;--bar:#dfe4ec}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1c2027;--fg:#e7eaee;--mute:#9aa3ae;--line:#2b313a;--ok:#4cc27e;--warn:#e0a03a;--bad:#ee6b72;--accent:#8aa6ff;--bar:#2b313a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:16px 20px 4px}
h1{font-size:18px;margin:0}header .mute{font-size:12px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;padding:12px 20px 24px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:0 0 8px}
.mute{color:var(--mute)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:4px 6px 4px 0;border-top:1px solid var(--line);vertical-align:top}
tr:first-child td{border-top:none}td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.meter{height:8px;background:var(--bar);border-radius:4px;overflow:hidden;margin:4px 0 2px}.meter>div{height:100%;background:var(--accent)}
.meter.warn>div{background:var(--warn)}.meter.bad>div{background:var(--bad)}
.big{font-size:22px;font-weight:600}.row{display:flex;gap:18px;flex-wrap:wrap}
a{color:var(--accent);text-decoration:none;cursor:pointer}a:hover{text-decoration:underline}
pre{white-space:pre-wrap;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;max-height:70vh;overflow:auto}
#view{position:fixed;inset:5vh 5vw;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;display:none;box-shadow:0 10px 40px rgba(0,0,0,.25)}
#view .bar{display:flex;justify-content:space-between;margin-bottom:8px}
svg{display:block;width:100%;height:46px}
section{overflow-x:auto}td.id{white-space:nowrap}td.head{min-width:10em}.wide2{grid-column:span 2}
@media (max-width:640px){.hide-s{display:none}.wide2{grid-column:auto}main{padding:10px 12px 20px;gap:10px}}
</style></head><body>
<header><h1>lean-agent</h1><span class="mute" id="stamp"></span></header>
<main>
 <section><h2>Week</h2><div id="pace"></div><div id="weekstats" class="mute"></div></section>
 <section><h2>Orchestrator context</h2><div id="ctx"></div></section>
 <section><h2>Running now</h2><div id="running"></div></section>
 <section class="wide2"><h2>Work queue</h2><div id="todo"></div></section>
 <section style="grid-column:1/-1"><h2>Recent runs</h2><div id="runs"></div></section>
 <section><h2>Scheduled</h2><div id="sched"></div></section>
 <section><h2>Reviews</h2><div id="reviews"></div></section>
 <section><h2>Pushes and notes</h2><div id="pushes"></div></section>
</main>
<div id="view"><div class="bar"><b id="vtitle"></b><span><a id="vdet">details</a> · <a onclick="closeView()">close</a></span></div><pre id="vbody"></pre></div>
<script>
const T=new URLSearchParams(location.search).get("t")||"";
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const k=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1000?(n/1000).toFixed(n>=10000?0:1)+"k":String(n||0);
const when=s=>s?s.slice(5,16).replace("T"," "):"";
const cls=st=>st==="done"?"ok":/fail|error|stopped/.test(st||"")?"bad":/needs|await|partial/.test(st||"")?"warn":"mute";
function meter(p,warnAt,badAt){const c=p>=badAt?"bad":p>=warnAt?"warn":"";return `<div class="meter ${c}"><div style="width:${Math.min(100,p)}%"></div></div>`}
function table(rows){return rows.length?`<table>${rows.join("")}</table>`:'<span class="mute">none</span>'}
async function show(id,details){
  const r=await fetch(`/run/${encodeURIComponent(id)}?t=${T}${details?"&details=1":""}`);
  $("vtitle").textContent=`run ${id}${details?" · details":""}`;$("vbody").textContent=await r.text();
  $("vdet").onclick=()=>show(id,!details);$("vdet").textContent=details?"answer":"details";$("view").style.display="block";}
function closeView(){$("view").style.display="none"}
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeView()});
async function load(){
  let s;try{const r=await fetch(`/api/state?t=${T}`);if(!r.ok)throw new Error(r.status);s=await r.json()}
  catch(e){$("stamp").textContent="can't reach lean-agent ("+e.message+"): is `lean-agent up` or `lean-agent dashboard` running?";return}
  $("stamp").textContent="updated "+s.now.slice(11,19)+" · refreshes every 15 s";
  const wk=s.plan.seven_day, ses=s.plan.five_hour;
  $("pace").innerHTML=(wk?`<div class="big">${Math.round(wk.pct)}%</div><div class="mute">of your weekly plan</div>${meter(wk.pct,70,90)}`:'<span class="mute">plan usage not seen yet (it comes with every worker run)</span>')
    +(s.pace?`<div class="${s.ahead?"warn":"ok"}">${esc(s.pace)}</div>`:"")
    +(ses?`<div class="mute" style="margin-top:6px">session window ${Math.round(ses.pct)}%</div>${meter(ses.pct,70,90)}`:"");
  $("weekstats").innerHTML=`${s.week.runs} runs (${s.week.done} done) · ${k(s.week.units)} sonnet-eq · $${s.week.cost} · ${s.todo_done_week} todos done`;
  const c=s.context;
  if(c&&c.calls){const p=Math.round(c.now*100/c.compact_at),max=Math.max(...c.trend,c.compact_at),w=c.trend.length;
    const pts=c.trend.map((v,i)=>`${(i/(Math.max(1,w-1))*100).toFixed(1)},${(46-v/max*44).toFixed(1)}`).join(" ");
    $("ctx").innerHTML=`<div class="big">${k(c.now)} <span class="mute" style="font-size:14px">/ ${k(c.compact_at)} before compaction</span></div>${meter(p,70,85)}
      <svg viewBox="0 0 100 46" preserveAspectRatio="none"><line x1="0" x2="100" y1="${(46-c.compact_at/max*44).toFixed(1)}" y2="${(46-c.compact_at/max*44).toFixed(1)}" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/><polyline fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts}"/></svg>
      <div class="mute">${c.calls} calls in the latest conversation · last ${when(c.updated)}</div>`}
  else $("ctx").innerHTML='<span class="mute">no orchestrator conversation yet</span>';
  $("running").innerHTML=table(s.running.map(r=>`<tr><td><a onclick="show('${esc(r.run)}')">${esc(r.run)}</a></td><td>${esc(r.model)}</td><td>${esc(r.project)}</td><td>${esc((r.task||"").slice(0,80))}</td></tr>`));
  $("todo").innerHTML=table(s.todo.map(t=>`<tr><td class="mute">#${t.id}</td><td>${t.status==="doing"?'<b class="warn">doing</b> ':""}${t.prio==="high"?'<b class="bad">high</b> ':""}${esc(t.text)}${t.ref?` <span class="mute">(${esc(t.ref)})</span>`:""}</td><td class="n mute">${esc(t.due||"")}</td></tr>`));
  $("runs").innerHTML=table(s.runs.map(r=>`<tr><td class="id"><a onclick="show('${esc(r.id)}')">${esc(r.id)}</a></td><td class="${cls(r.status)}" title="${esc(r.status)}">${esc((r.status||"").split(":")[0])}</td><td class="hide-s">${esc(r.model)}</td><td class="hide-s">${esc(r.project)}${r.role?` <span class="mute">${esc(r.role)}</span>`:""}</td><td class="head">${esc(r.head)}</td><td class="n">${k(r.units)}</td><td class="n mute hide-s">${r.cost!=null?"$"+r.cost.toFixed(2):""}</td></tr>`));
  $("sched").innerHTML=table(s.schedule.map(j=>`<tr><td class="mute">#${j.id}</td><td>${esc(j.when)}</td><td><code>${esc(j.cmd)}</code></td><td class="n mute">${j.enabled?(j.next?"next "+when(j.next):""):"paused"}</td></tr>`))
    +(s.scheduled_results.length?'<div class="mute" style="margin-top:8px">Recent results</div>'+table(s.scheduled_results.map(r=>`<tr><td class="mute">#${r.id}</td><td class="${r.rc?"bad":"ok"}">exit ${r.rc}</td><td>${esc(r.first)}</td><td class="n mute">${when(r.ts)}</td></tr>`)):"");
  $("reviews").innerHTML=table(s.reviews.map(r=>`<tr><td>${esc(r.project)}</td><td>${esc(r.ref)}</td><td class="${r.verdict==="approve"?"ok":"bad"}">${esc(r.verdict)}</td><td class="n">${r.blocking?r.blocking+" blocking":""}</td><td class="n mute">${when(r.ts)}</td></tr>`));
  $("pushes").innerHTML=table(s.pushes.map(p=>`<tr><td>${esc(p.branch)} → ${esc(p.to)}</td><td class="${p.ok?"ok":"bad"}">${p.ok?"pushed":"failed"}</td><td class="n mute">${when(p.ts)}</td></tr>`))
    +(s.notes.length?'<div class="mute" style="margin-top:8px">Hand-off notes</div>'+table(s.notes.map((n,i)=>`<tr><td class="mute">${i+1}.</td><td>${esc(n.text)}</td></tr>`)):"");
}
load();setInterval(load,15000);
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    token = ""

    def log_message(self, *args):  # quiet
        pass

    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost", "[::1]"):
            return self._send(403, "lean-agent dashboard: local requests only")
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not secrets.compare_digest((q.get("t") or [""])[0], self.token):
            return self._send(403, "lean-agent dashboard: open it with its address from `lean-agent dashboard --url`")
        if u.path == "/":
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if u.path == "/api/state":
            return self._send(200, json.dumps(state()), "application/json")
        m = re.fullmatch(r"/run/([\w-]+)", u.path)
        if m:
            text = run_text(m.group(1), details=bool(q.get("details")))
            return self._send(200 if text is not None else 404, text or "no such run")
        return self._send(404, "not found")


def make_server(port=None):
    cfg = settings()
    port = port or cfg["port"]
    Handler.token = cfg["token"]
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    if port != cfg.get("port"):
        cfg["port"] = port
        with open(home("dashboard.json"), "w") as fh:
            json.dump(cfg, fh)
    return server


def start_background(port=None):
    """Serve in a daemon thread (from `lean-agent up`); returns the URL, or None if the port is taken."""
    try:
        server = make_server(port)
    except OSError:
        return None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return url()


def serve(port=None):
    server = make_server(port)
    print(f"lean-agent dashboard: {url()}  (Ctrl-C stops it)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(serve(int(sys.argv[1]) if len(sys.argv) > 1 else None))
