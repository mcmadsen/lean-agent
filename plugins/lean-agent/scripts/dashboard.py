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


def open_gaps(slug, review):
    """Known gaps of a review the user hasn't acknowledged yet (lean-agent review decline <project> g<n>)."""
    gaps = review.get("gaps") or []
    if not gaps:
        return 0
    acked = [d.get("gap", "") for d in _jsonl(home("reviews", slug + ".declined.jsonl")) if d.get("gap")]
    words = lambda t: set(re.findall(r"[a-z0-9]{3,}", str(t).lower()))
    def acked_gap(g):
        w = words(g.get("what"))
        return any(w and len(w & words(a)) / max(1, len(w | words(a))) >= 0.3 for a in acked)
    return sum(1 for g in gaps if not acked_gap(g))


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
                              "head": str(r.get("head", ""))[:10], "gaps": open_gaps(p, r),
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


def running_text(run_id):
    """A run that's still running: its task and its progress so far (it isn't in the ledger until it ends)."""
    m = next((x for x in (_json(f, {}) for f in glob.glob(home("running", "*.json"))) if x.get("run") == run_id), None)
    if not m:
        return None
    workdir = m.get("workdir") or home("work", run_id)
    steps = _jsonl(os.path.join(workdir, "progress.jsonl"), 400)
    started = str(m.get("started", ""))[11:19]
    head = (f"running since {started} · {m.get('model')} · {m.get('project')}"
            + (f" · {m['role']}" if m.get("role") else "")
            + (f" · {steps[-1]['turn']} turns so far, context now ~{steps[-1]['ctx']:,}" if steps else " · starting")
            + ("" if _alive(m.get("pid")) else " · (its process is gone: it may have been stopped)"))
    lines = [head, "", "Task:", str(m.get("task", ""))[:2000], "", f"Latest steps ({len(steps)} turns):" if steps else ""]
    for st in steps[-40:]:
        for x in st.get("steps") or ["(thinking)"]:
            lines.append(f"  {st.get('turn'):>3}  {x}")
    lines.append("\n(click the run again to refresh; its answer shows here when it's done)")
    return "\n".join(lines)


def run_text(run_id, details=False):
    """A run's saved summary (or its details file), for the run view; a running run shows its progress."""
    r = next((x for x in reversed(_jsonl(home("ledger.jsonl"))) if x.get("id") == run_id), None)
    if not r:
        return running_text(run_id)
    if not r.get("workdir"):
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
details.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0;overflow-x:auto}
details.card>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::before{content:"\25B8";color:var(--mute);font-size:11px;transition:transform .15s}
details.card[open]>summary::before{transform:rotate(90deg)}
details.card[open]>summary{margin-bottom:8px}
.count{color:var(--mute);font-weight:400;text-transform:none;letter-spacing:0}
.full{grid-column:1/-1}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:0}
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
td.id{white-space:nowrap}td.head{min-width:10em}.wide2{grid-column:span 2}
@media (max-width:640px){.hide-s{display:none}.wide2{grid-column:auto}main{padding:10px 12px 20px;gap:10px}}
</style></head><body>
<header><h1>lean-agent</h1><span class="mute" id="stamp"></span></header>
<main>
 <details class="card" id="c-week" open><summary><h2>Week</h2></summary><div id="pace"></div><div id="weekstats" class="mute"></div></details>
 <details class="card" id="c-ctx" open><summary><h2>Orchestrator context</h2></summary><div id="ctx"></div></details>
 <details class="card" id="c-running" open><summary><h2>Running now <span class="count" id="n-running"></span></h2></summary><div id="running"></div></details>
 <details class="card wide2" id="c-todo" open><summary><h2>Work queue <span class="count" id="n-todo"></span></h2></summary><div id="todo"></div></details>
 <details class="card" id="c-reviews" open><summary><h2>Reviews to act on <span class="count" id="n-reviews"></span></h2></summary><div id="reviews"></div></details>
 <details class="card full" id="c-runs"><summary><h2>Recent runs <span class="count" id="n-runs"></span></h2></summary><div id="runs"></div></details>
 <details class="card" id="c-sched" open><summary><h2>Scheduled <span class="count" id="n-sched"></span></h2></summary><div id="sched"></div></details>
 <details class="card" id="c-pushes" open><summary><h2>Pushes <span class="count" id="n-pushes"></span></h2></summary><div id="pushes"></div></details>
 <details class="card" id="c-notes" open><summary><h2>Hand-off notes <span class="count" id="n-notes"></span></h2></summary><div id="notes"></div></details>
 <details class="card full" id="c-approved"><summary><h2>Approved reviews <span class="count" id="n-approved"></span></h2></summary><div id="approved"></div></details>
</main>
<div id="view"><div class="bar"><b id="vtitle"></b><span><a id="vdet">details</a> · <a onclick="closeView()">close</a></span></div><pre id="vbody"></pre></div>
<script>
const T=new URLSearchParams(location.search).get("t")||"";
const V="__PAGE_VERSION__";  // the server's page changed (lean-agent sync): load the new one
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const k=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1000?(n/1000).toFixed(n>=10000?0:1)+"k":String(n||0);
const when=s=>s?s.slice(5,16).replace("T"," "):"";
const cls=st=>st==="done"?"ok":/fail|error|stopped/.test(st||"")?"bad":/needs|await|partial/.test(st||"")?"warn":"mute";
function meter(p,warnAt,badAt){const c=p>=badAt?"bad":p>=warnAt?"warn":"";return `<div class="meter ${c}"><div style="width:${Math.min(100,p)}%"></div></div>`}
function table(rows,empty){return rows.length?`<table>${rows.join("")}</table>`:`<span class="mute">${empty||"none"}</span>`}
async function show(id,details){
  const r=await fetch(`/run/${encodeURIComponent(id)}?t=${T}${details?"&details=1":""}`);
  $("vtitle").textContent=`run ${id}${details?" · details":""}`;$("vbody").textContent=await r.text();
  $("vdet").onclick=()=>show(id,!details);$("vdet").textContent=details?"answer":"details";$("view").style.display="block";}
function closeView(){$("view").style.display="none"}
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeView()});
async function load(){
  let s;try{const r=await fetch(`/api/state?t=${T}`);if(!r.ok)throw new Error(r.status);s=await r.json()}
  catch(e){$("stamp").textContent="can't reach lean-agent ("+e.message+"): is `lean-agent up` or `lean-agent dashboard` running?";return}
  if(s.page_version&&s.page_version!==V){location.reload();return}
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
  $("todo").innerHTML=table(s.todo.map(t=>`<tr><td class="mute">#${t.id}</td><td>${t.status==="doing"?'<b class="warn">doing</b> ':""}${t.prio==="high"?'<b class="bad">high</b> ':""}${esc(t.text)}${t.ref?` <span class="mute">(${esc(t.ref)})</span>`:""}</td><td class="n mute">${esc(t.due||"")}</td></tr>`),
    'Nothing open. Your requests and what is in progress go here: ask the orchestrator to keep your work in '
    +'the work queue, or add an item yourself with <code>lean-agent todo add "..." -p &lt;project&gt;</code>.'
    +(s.todo_done_week?` (${s.todo_done_week} done this week)`:""));
  $("runs").innerHTML=table(s.runs.map(r=>`<tr><td class="id"><a onclick="show('${esc(r.id)}')">${esc(r.id)}</a></td><td class="${cls(r.status)}" title="${esc(r.status)}">${esc((r.status||"").split(":")[0])}</td><td class="hide-s">${esc(r.model)}</td><td class="hide-s">${esc(r.project)}${r.role?` <span class="mute">${esc(r.role)}</span>`:""}</td><td class="head">${esc(r.head)}</td><td class="n">${k(r.units)}</td><td class="n mute hide-s">${r.cost!=null?"$"+r.cost.toFixed(2):""}</td></tr>`));
  $("sched").innerHTML=table(s.schedule.map(j=>`<tr><td class="mute">#${j.id}</td><td>${esc(j.when)}</td><td><code>${esc(j.cmd)}</code></td><td class="n mute">${j.enabled?(j.next?"next "+when(j.next):""):"paused"}</td></tr>`))
    +(s.scheduled_results.length?'<div class="mute" style="margin-top:8px">Recent results</div>'+table(s.scheduled_results.map(r=>`<tr><td class="mute">#${r.id}</td><td class="${r.rc?"bad":"ok"}">exit ${r.rc}</td><td>${esc(r.first)}</td><td class="n mute">${when(r.ts)}</td></tr>`)):"");
  const rev=r=>`<tr><td>${esc(r.ref)} <span class="mute">${esc(r.project)}</span></td><td class="${r.verdict==="approve"?"ok":"bad"}" title="${esc(r.verdict)}">${esc((r.verdict||"").split("-")[0])}</td><td class="n">${r.blocking?r.blocking+" blocking":""}${r.gaps?` ${r.gaps} gap${r.gaps>1?"s":""}`:""}</td><td class="n mute hide-s">${when(r.ts)}</td></tr>`;
  const act=s.reviews.filter(r=>r.verdict!=="approve"||r.gaps), ok=s.reviews.filter(r=>r.verdict==="approve"&&!r.gaps);
  $("reviews").innerHTML=table(act.map(rev),"nothing to act on");
  $("approved").innerHTML=table(ok.map(rev));
  $("pushes").innerHTML=table(s.pushes.map(p=>`<tr><td>${esc(p.branch)} → ${esc(p.to)}</td><td class="${p.ok?"ok":"bad"}">${p.ok?"pushed":"failed"}</td><td class="n mute">${when(p.ts)}</td></tr>`),"none this week");
  $("notes").innerHTML=table(s.notes.map((n,i)=>`<tr><td class="mute">${i+1}.</td><td>${esc(n.text)}</td></tr>`),
    'none (the orchestrator adds open items with <code>lean-agent handoff --note</code>)');
  const counts={running:s.running.length,todo:s.todo.length,reviews:act.length,runs:s.runs.length,sched:s.schedule.length,
    pushes:s.pushes.length,notes:s.notes.length,approved:ok.length};
  for(const [k2,n] of Object.entries(counts)) $("n-"+k2).textContent=n?`· ${n}`:"";
}
// each box remembers whether it's open, in this browser only (and works without storage)
for(const d of document.querySelectorAll("details.card")){
  try{const v=localStorage.getItem("la-open-"+d.id);if(v!==null)d.open=v==="1"}catch(e){}
  d.addEventListener("toggle",()=>{try{localStorage.setItem("la-open-"+d.id,d.open?"1":"0")}catch(e){}});
}
load();setInterval(load,15000);
</script></body></html>"""


def write_launch_config(cfg=None):
    """The Claude desktop app's preview config in the orchestrator home (.claude/launch.json): an entry for the
    already running dashboard (url and port only; a localhost preview URL can't carry the token). Other entries
    are kept. Returns the file's path."""
    cfg = cfg or settings()
    path = home("home", ".claude", "launch.json")
    data = _json(path, {})
    if not isinstance(data, dict):
        data = {}
    data.setdefault("version", "0.0.1")
    entries = [c for c in data.get("configurations") or [] if isinstance(c, dict) and c.get("name") != "lean-agent dashboard"]
    entries.append({"name": "lean-agent dashboard", "url": f"http://localhost:{cfg['port']}", "port": cfg["port"]})
    data["configurations"] = entries
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
    return path


def browser_same_origin(headers):
    """A request a browser made from the dashboard page itself, or typed into its address bar (Sec-Fetch-Site),
    not from another website and not from a non-browser program."""
    return (headers.get("Sec-Fetch-Site") or "") in ("same-origin", "none")


WATCHED = ("dashboard.py", "usage.py", "lean_schedule.py")
_LIVE = {"stamp": None, "mod": None}
_LIVE_LOCK = threading.Lock()


def code_stamp():
    return tuple(os.path.getmtime(os.path.join(HERE, f)) for f in WATCHED if os.path.exists(os.path.join(HERE, f)))


def live():
    """This module as it is on disk now. `lean-agent sync` updates the files the running server was started from;
    when they change, the page, the state and their helpers are loaded again, so no restart is needed."""
    import importlib
    import importlib.util
    with _LIVE_LOCK:
        stamp = code_stamp()
        if _LIVE["mod"] is None:
            _LIVE.update(stamp=stamp, mod=sys.modules[__name__])
        elif stamp != _LIVE["stamp"]:
            try:
                importlib.reload(usage)
                importlib.reload(lean_schedule)
                spec = importlib.util.spec_from_file_location(f"lean_agent_dashboard_{int(time.time())}",
                                                              os.path.join(HERE, "dashboard.py"))
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                _LIVE.update(stamp=stamp, mod=mod)
            except Exception:  # a half-written file during a pull: keep serving what works, try again next time
                pass
        return _LIVE["mod"]


def page_version():
    import hashlib
    return hashlib.sha1(PAGE.encode()).hexdigest()[:10]


class Handler(BaseHTTPRequestHandler):
    token = ""
    preview = False  # the preview's bare address: no token needed for the browser's own requests

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
        if not secrets.compare_digest((q.get("t") or [""])[0], self.token) and not (
                self.preview and browser_same_origin(self.headers)):
            return self._send(403, "lean-agent dashboard: open it with its address from `lean-agent dashboard --url`")
        mod = live()
        if u.path == "/":
            return self._send(200, mod.PAGE.replace("__PAGE_VERSION__", mod.page_version()), "text/html; charset=utf-8")
        if u.path == "/api/state":
            return self._send(200, json.dumps(dict(mod.state(), page_version=mod.page_version())), "application/json")
        m = re.fullmatch(r"/run/([\w-]+)", u.path)
        if m:
            text = mod.run_text(m.group(1), details=bool(q.get("details")))
            return self._send(200 if text is not None else 404, text or "no such run")
        return self._send(404, "not found")


def make_server(port=None):
    cfg = settings()
    port = port or cfg["port"]
    Handler.token = cfg["token"]
    Handler.preview = bool(cfg.get("preview"))
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
