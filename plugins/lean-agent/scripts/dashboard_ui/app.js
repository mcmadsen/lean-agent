// lean-agent workspace: what needs you (left), a thread per task with the orchestrator (center), live work (right).
const T=new URLSearchParams(location.search).get("t")||"";
const V="__PAGE_VERSION__";  // the server's page changed (lean-agent sync): load the new one
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const k=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1000?(n/1000).toFixed(n>=10000?0:1)+"k":String(n||0);
const when=s=>s?s.slice(5,16).replace("T"," "):"";
const ago=t=>{if(!t)return"";const m=Math.max(0,Math.round((Date.now()-Date.parse(t))/60000));return m<1?"now":m<60?m+" min":m<1440?Math.round(m/60)+" h":Math.round(m/1440)+" d"};
const verdict=v=>({approve:"approved","changes-requested":"changes requested","needs-checks":"needs checks"})[v]||v||"";
const tone=st=>st==="done"||st==="merged"||st==="approve"?"tone-ok":/fail|error|stopped|changes/.test(st||"")?"tone-bad":/needs|await|partial|gap/.test(st||"")?"tone-warn":/running|doing|open/.test(st||"")?"tone-run":"tone-mute";
const store={get(k,d){try{const v=localStorage.getItem(k);return v===null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
function meter(p,warnAt,badAt){const c=p>=badAt?"bad":p>=warnAt?"warn":"";return `<div class="meter ${c}"><div style="width:${Math.min(100,Math.max(0,p))}%"></div></div>`}
function post(path,body){return fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-Lean-Agent-Token":T},body:JSON.stringify(body||{})}).then(r=>r.json().catch(()=>({ok:false,error:"HTTP "+r.status})))}

// theme: follows the system unless you pick light or dark (remembered in this browser)
function setTheme(t){if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else delete document.documentElement.dataset.theme;
  $("theme").textContent="Theme: "+(t||"auto");store.set("la-theme",t||null)}
setTheme(store.get("la-theme",null));
$("theme").onclick=()=>{const cur=document.documentElement.dataset.theme||"";setTheme({"":"light",light:"dark",dark:""}[cur])};

// a run's answer or details, over the page
async function show(id,details){
  const r=await fetch(`/run/${encodeURIComponent(id)}?t=${T}${details?"&details=1":""}`);
  $("vtitle").textContent=`run ${id}${details?" · details":""}`;$("vbody").textContent=await r.text();
  $("vdet").onclick=e=>{e.preventDefault();show(id,!details)};$("vdet").textContent=details?"answer":"details";$("view").style.display="block";}
function closeView(){$("view").style.display="none"}

// state
let S=null,lastBoard=null;
const ui={sel:store.get("la-thread","main"),tab:store.get("la-tab","board"),filter:"all",q:"",more:{}};
const cardsBy=()=>new Map(((lastBoard&&lastBoard.cards)||[]).map(c=>[String(c.id),c]));
const threadKey=id=>id==="main"?"main":String(id).replace(/[^A-Za-z0-9_.-]/g,"_").replace(/^[^A-Za-z0-9]/,"t").slice(0,80);
// what changed since you last looked: kept per browser; a change stays marked for 10 minutes of looking
const SEEN_FOR=10*60*1000;
function changedSet(cards){
  let seen=store.get("la-board-seen",null);const first=!seen;seen=seen||{};const now=Date.now(),looking=document.visibilityState!=="hidden",out=new Set();
  for(const c of cards){const was=seen[c.id];
    if(first||(was&&was.sig===c.sig)){seen[c.id]={sig:c.sig};continue}
    const since=(was&&was.since)||now;seen[c.id]={sig:(was||{}).sig,since};
    if(looking&&now-since>SEEN_FOR)seen[c.id]={sig:c.sig};else out.add(String(c.id))}
  for(const id of Object.keys(seen))if(!cards.some(c=>String(c.id)===id))delete seen[id];
  store.set("la-board-seen",seen);return out;
}
const matches=c=>{const f=$("bfilter").value;if(f&&c.project&&c.project!==f)return false;
  if(!ui.q)return true;return [c.title,c.text,c.ref,c.project,c.why,(c.runs||[]).join(" ")].join(" ").toLowerCase().includes(ui.q)};

// LEFT: needs you
function groupOf(c){
  if(c.kind==="run"||(c.kind==="item"&&c.last_run&&/needs|await/.test(c.last_run.status)))return "runs";
  if(c.kind==="note"||/gap/.test(c.why||""))return "decisions";
  return "prs";
}
function rowMeta(c){
  if(c.kind==="run")return `${(c.runs||[])[0]||""} · ${ago((c.last_run||{}).ts)}`;
  if(c.kind==="note")return `note ${c.note} · ${ago(c.done_at)} ago`;
  if(c.kind==="item"&&c.last_run)return `#${c.id} · ${c.last_run.id} · ${ago(c.last_run.ts)}`;
  return c.why||c.ref||c.project||"";
}
function drawInbox(changed){
  const thr=new Map(((S&&S.threads)||[]).map(t=>[t.key,t]));
  const wait=((lastBoard&&lastBoard.cards)||[]).filter(c=>c.column==="Waiting on you"&&matches(c));
  const groups={runs:[],decisions:[],prs:[]};for(const c of wait)groups[groupOf(c)].push(c);
  const shown=new Set(wait.map(c=>threadKey(c.id)));
  const other=[...thr.values()].filter(t=>t.key!=="main"&&!shown.has(t.key)&&t.last&&(!ui.q||(t.title||"").toLowerCase().includes(ui.q)));
  const n={all:wait.length,runs:groups.runs.length,decisions:groups.decisions.length,prs:groups.prs.length,threads:other.length};
  $("ifilters").innerHTML=[["all","All"],["runs","Runs"],["decisions","Decisions"],["prs","PRs"],["threads","Threads"]]
    .filter(([f])=>f==="all"||n[f]).map(([f,l])=>`<button type="button" class="pill${ui.filter===f?" on":""}" data-act="ifilter" data-f="${f}">${l} ${n[f]}</button>`).join("");
  $("n-inbox").textContent=`${wait.length} open`;$("m-inbox").textContent=wait.length||"";
  const dot=(c,t)=>t&&t.waiting?"dot-warn":t&&t.status==="working"?"dot-run":c.kind==="pr"&&/ready/.test(c.why||"")?"dot-ok":c.kind==="note"?"dot-run":/merged|approved/.test(c.why||"")?"dot-ok":"dot-warn";
  const row=(id,title,meta,d,ch)=>`<button type="button" class="row${threadKey(id)===ui.sel?" sel":""}${ch?" changed":""}" data-act="select" data-card="${esc(id)}"><span class="t">${esc(title)}</span><span class="m"><span class="dot ${d}" aria-hidden="true"></span><span>${esc(meta)}</span></span></button>`;
  const main=thr.get("main");
  let h=row("main","Orchestrator",main&&main.last?`${main.waiting?"waits for your OK · ":main.status==="working"?"working · ":""}${ago(main.last.ts)}`:"the general thread",main&&main.waiting?"dot-warn":main&&main.status==="working"?"dot-run":"dot-mute");
  const sec=(key,label,list)=>{if(!list.length||(ui.filter!=="all"&&ui.filter!==key))return"";
    return `<div class="grp"><span>${label}</span><span>${list.length}</span></div>`+list.map(c=>row(c.id,c.title,rowMeta(c),dot(c,thr.get(threadKey(c.id))),changed.has(String(c.id)))).join("")};
  h+=sec("runs","Run questions",groups.runs)+sec("decisions","Decisions",groups.decisions)+sec("prs","PRs and reviews",groups.prs);
  if(other.length&&(ui.filter==="all"||ui.filter==="threads"))h+=`<div class="grp"><span>Other threads</span><span>${other.length}</span></div>`
    +other.map(t=>row(t.key,t.title,`${t.status==="working"?"working · ":""}${ago(t.last.ts)}`,t.waiting?"dot-warn":t.status==="working"?"dot-run":"dot-mute",false)).join("");
  if(!wait.length&&ui.filter==="all")h+=`<div class="empty">Nothing waits on you.</div>`;
  $("inbox").innerHTML=h;
}

// CENTER: the selected thread (chat.js draws the messages)
function selected(){const c=cardsBy().get(String(ui.sel));if(c)return c;
  if(ui.sel==="main")return null;const t=((S&&S.threads)||[]).find(t=>t.key===ui.sel);return t?{id:ui.sel,title:t.title,kind:"thread"}:null}
function contextText(c){
  if(!c)return "";
  const bits=[c.kind==="item"?`work item #${c.id} "${c.text}"`:c.kind==="run"?`a run that asks: "${c.text}"`:c.kind==="note"?`hand-off note ${c.note}: "${c.text}"`:`${c.title}`];
  if(c.project)bits.push(`project ${c.project}`);if(c.ref)bits.push(`ref ${c.ref}`);
  if((c.runs||[]).length)bits.push(`runs ${c.runs.join(", ")}`);if(c.why)bits.push(`status: ${c.why}`);
  if(c.pr&&c.pr.number)bits.push(`PR ${c.pr.number}`);if(c.link)bits.push(c.link);
  return bits.join("; ");
}
function drawHeader(){
  const c=selected();
  $("ttitle").textContent=c?c.title:"Conversation with the orchestrator";
  $("tsub").textContent=c?`Thread with the orchestrator · context: ${[c.kind==="item"?"#"+c.id:"",(c.runs||[])[0]?"run "+c.runs[0]:"",c.ref||"",c.project||""].filter(Boolean).join(" · ")||c.kind}`:"The general thread: ask for work, answer questions, approve what it wants to run";
  $("handled").hidden=!c||c.kind==="thread";
  $("handled").textContent=c&&c.kind==="item"&&c.column!=="Done"?"Done…":c&&c.kind==="note"?"Close note":"Mark handled";
  $("ctxpills").innerHTML=(c?`<button type="button" class="pill" data-act="select" data-card="main" aria-label="Back to the general thread">${esc(c.kind==="item"?"#"+c.id:c.kind==="run"?"run "+(c.runs||[])[0]:c.kind==="note"?"note "+c.note:c.title.slice(0,30))} ×</button>`:"")
    +($("bfilter").value?`<span class="pill">${esc($("bfilter").value)}</span>`:"");
}
function contextCard(){
  const c=selected();if(!c||c.kind==="thread")return "";
  const chip=c.kind==="run"?["run asks","tone-warn"]:c.kind==="note"?[c.note_kind==="decision"?"decision":"note","tone-run"]:c.kind==="pr"?["pull request","tone-run"]:c.kind==="review"?["review","tone-run"]:c.kind==="epic"?["epic","tone-ok"]:[c.column||"item",tone(c.column==="Done"?"done":c.column==="Waiting on you"?"needs":"open")];
  const lr=c.last_run;
  const meta=[c.kind==="item"?"#"+c.id:"",lr?`${lr.status} · ${when(lr.ts)}`:"",c.ref||"",c.project||""].filter(Boolean).join(" · ");
  const body=c.kind==="run"||c.kind==="note"?c.text:[c.rest||(c.title!==c.text?c.text:""),c.why,c.result?"result: "+c.result:""].filter(Boolean).join("\n");
  const runs=(c.runs||[]).map(id=>`<a data-run="${esc(id)}" href="#">${esc(id)}</a>`).join(" ");
  return `<section class="qcard" aria-label="What this thread is about"><div class="hd"><span class="chip ${chip[1]}">${esc(chip[0])}</span>${c.link?`<a href="${esc(c.link)}" target="_blank" rel="noopener" class="mono">open ↗</a>`:""}<span class="mono mute">${esc(meta)}</span></div>`
    +(body?`<p>${esc(body)}</p>`:"")+(runs?`<div class="mono small">${runs}</div>`:"")+`<div class="acts">${cardButtons(c)}</div></section>`;
}
function cardButtons(c){
  const b=(act,label,primary)=>`<button type="button" class="btn sm${primary?" primary":""}" data-act="${act}" data-card="${esc(c.id)}">${label}</button>`;
  const a=[];
  if(c.kind==="item"&&c.column!=="Done"){if(c.column==="Open")a.push(b("start","Start"));a.push(b("done","Done…"))}
  else if(c.kind==="item")a.push(b("reopen","Reopen"));
  if(c.kind==="note")a.push(b("close-note","Close note"));
  if(c.kind==="epic")a.push(b("epic-next","Start next",true));
  if(c.kind==="run"||c.kind==="pr"||c.kind==="review"||c.column==="Waiting on you")a.push(b("dismiss","Mark handled"));
  return a.join("");
}
function select(id){
  ui.sel=threadKey(id);store.set("la-thread",ui.sel);
  document.body.dataset.pane="chat";
  drawHeader();drawInbox(new Set());if(typeof openThread==="function")openThread(ui.sel);
}

// RIGHT: running now, board / runs / schedule, plan usage
function drawLive(s){
  const rows=s.running.map(r=>`<div class="lrun"><div class="hd"><span class="chip tone-run">running</span><b class="mono">${esc(r.model||"?")} / ${esc(r.effort||"default")}</b><span>${r.todo!=null?"#"+esc(r.todo):"lookup"} · ${esc(r.project||"")}${r.role?" · "+esc(r.role):""}</span></div>
    <p title="${esc(r.task)}">${esc(String(r.task||"").split("\n")[0])}</p>
    <div class="ft"><span>${ago(r.started)}${r.turns?" · "+r.turns+" turns":""}</span><span class="acts"><button type="button" class="btn sm" data-run="${esc(r.run)}">Open</button><button type="button" class="btn sm" data-act="run-stop" data-id="${esc(r.run)}">Stop</button></span></div></div>`)
   .concat((s.finished||[]).filter(f=>!s.running.some(r=>r.run===f.id)).map(f=>`<div class="lrun"><div class="hd"><span class="chip ${tone(f.status)}">${esc(f.status)}</span><b class="mono">${esc(f.model||"")}</b><span>${f.todo!=null?"#"+esc(f.todo):"lookup"} · finished ${when(f.ts).slice(6)}</span></div><p>${esc(f.task)}</p></div>`));
  $("live").innerHTML=rows.length?rows.join(""):`<span class="mute small">Nothing running${s.last_finished?" · the last run finished "+when(s.last_finished):""}.</span>`;
  $("n-live").textContent=s.running.length||"";
}
function drawBoard(b,changed){
  const cards=b.cards.filter(matches);
  const groups=[["In progress",c=>c.column==="In progress","card"],["Open",c=>c.column==="Open","card"],["In review",c=>c.column==="In review","line"],
    ["Done · 7 days",c=>c.column==="Done","line"],["Notes",c=>c.column==="Notes","line"]];
  let h="";
  for(const [label,pick,style] of groups){
    const list=cards.filter(pick);if(!list.length)continue;
    const lim=ui.more[label]?999:style==="card"?6:4;
    h+=`<div class="grp"><span>${label}</span><span>${list.length}</span></div>`;
    for(const c of list.slice(0,lim)){
      const ch=changed.has(String(c.id));
      const st=c.live&&c.live.length?"running":c.kind==="pr"?(c.pr&&c.pr.ci?"CI "+c.pr.ci:"PR"):c.kind==="epic"?`${c.epic.done}/${c.epic.total}`
        :c.column==="Done"?(c.result==="merged"?"merged":"done"):c.review?verdict(c.review.verdict):c.kind==="item"?(c.column==="In progress"?"doing":"open"):c.kind;
      if(style==="card"){
        const meta=[c.prio!=="normal"?c.prio:"",c.last_run&&!(c.live&&c.live.length)?"last run "+c.last_run.status:c.runs&&c.runs.length?c.runs.length+" run"+(c.runs.length>1?"s":""):"",c.notes?c.notes+" note"+(c.notes>1?"s":""):"",c.project||""].filter(Boolean).join(" · ");
        h+=`<article class="card${ch?" changed":""}"><div class="t"><span class="id">${c.kind==="item"?"#"+esc(c.id):""}</span><a data-act="select" data-card="${esc(c.id)}" href="#">${esc(c.title)}</a></div>
          ${c.kind==="epic"?meter(Math.round(c.epic.done*100/Math.max(1,c.epic.total)),101,101)+`<div class="mt">${esc(c.rest)}</div>`:""}
          <div class="mt"><span class="chip ${tone(st)}">${esc(st)}</span><span>${esc(meta)}</span></div>${c.kind!=="lookup"?`<div class="acts">${cardButtons(c)}</div>`:""}</article>`;
      }else h+=`<div class="line clickable" data-act="select" data-card="${esc(c.id)}"><span class="t">${esc(c.kind==="item"?"#"+c.id+" ":"")}${esc(c.title)}</span><span class="chip ${tone(st)}">${esc(st)}</span></div>`;
    }
    if(list.length>lim)h+=`<button type="button" class="more" data-act="more" data-g="${esc(label)}">${list.length-lim} more</button>`;
  }
  $("board").innerHTML=h||'<div class="empty">No work queued yet. Add an item, or ask the orchestrator to keep your work in the queue.</div>';
  $("n-board").textContent=cards.filter(c=>c.column!=="Done").length||"";
}
function drawRuns(s){
  $("runs").innerHTML=s.runs.map(r=>`<div class="runrow" data-run="${esc(r.id)}"><div class="top"><span>${esc(r.id)}</span><span class="mute">${r.cost!=null?"$"+r.cost.toFixed(2):k(r.units)}</span></div>
    <div class="acts"><span class="chip tone-mute">${esc(r.model||"")}</span><span class="chip ${tone(r.status)}">${esc((r.status||"").split(":")[0])}${r.passes>1?" · "+r.passes+" passes":""}</span>${r.role?`<span class="chip tone-mute">${esc(r.role)}</span>`:""}</div>
    <div class="h">${esc(r.head)}</div></div>`).join("")||'<div class="empty">No runs yet.</div>';
  $("n-runs").textContent=s.runs.length||"";
}
function drawSchedule(s){
  const upd=(s.scheduled_results||[]).find(r=>/sync/.test((r.args||[]).join(" "))&&/(\d+\.\d+\.\d+)\s*(?:->|→)\s*(\d+\.\d+\.\d+)/.test(r.first||""));
  $("sched").innerHTML=(upd?`<div class="update"><span>${esc(upd.first)}</span><button type="button" class="btn sm" data-act="sync">Sync</button></div>`:"")
    +s.schedule.map(j=>`<article class="card"><div class="t"><span class="mono">#${j.id} ${esc(j.cmd)}</span></div><div class="mt"><span class="chip tone-mute">${esc(j.when)}</span><span>${j.enabled?(j.next?"next "+when(j.next):""):"paused"} · ${j.last?"last "+when(j.last):"never ran yet"}</span></div></article>`).join("")
    +`<div class="mono mute small" style="padding:4px">${esc(s.schedule_runner||"")}</div>`
    +((s.scheduled_results||[]).length?`<div class="grp"><span>Recent results</span><span>${s.scheduled_results.length}</span></div>`+s.scheduled_results.slice(0,5).map(r=>`<div class="line"><span class="t">#${r.id} ${esc(r.first)}</span><span class="chip ${r.rc?"tone-bad":"tone-ok"}">exit ${r.rc}</span></div>`).join(""):"");
  const same=p=>String(p.to||"").replace(/^origin\//,"")===p.branch;
  $("pushes").innerHTML=s.pushes.length?`<div class="grp"><span>Pushes</span><span>${s.pushes.length}</span></div>`+s.pushes.map(p=>`<div class="mono mute small" style="padding:2px 4px">${esc(p.branch)}${same(p)?"":" → "+esc(p.to)} · ${p.count} push${p.count>1?"es":""}${p.failed?` · ${p.failed} failed`:""} · last ${when(p.ts)}</div>`).join(""):"";
  $("n-sched").textContent=s.schedule.length||"";
}
function drawPlanBox(s){
  const wk=s.plan.seven_day,ses=s.plan.five_hour,hm=t=>new Date(t*1000).toTimeString().slice(0,5),dhm=t=>new Date(t*1000).toLocaleDateString(undefined,{weekday:"short"})+" "+hm(t);
  const ok=p=>p&&Number.isFinite(p.pct),tone=p=>p>95?" bad":p>80?" warn":"";
  const gone=wk&&wk.resets_at?Math.max(0,Math.min(100,100-(wk.resets_at-Date.now()/1000)*100/(7*86400))):null;
  const item=(cls,full,cmp,right,pct,tick,aria)=>`<span class="u-item ${cls}"><span class="u-l"><span><span class="u-full">${full}</span><span class="u-cmp">${cmp}</span></span>${right}</span><span class="u-bar${tone(pct)}" role="img" aria-label="${aria}"><i style="width:${Math.min(100,Math.max(0,pct))}%"></i>${tick!=null?`<b style="left:${tick}%"></b>`:""}</span></span>`;
  let h="";
  if(ok(wk)){const p=Math.round(wk.pct),g=gone!=null?Math.round(gone):null;
    h+=item("u-wk",`Week ${p}%${wk.resets_at?" · resets "+dhm(wk.resets_at):""}`,`Week ${p}%${wk.resets_at?" · "+dhm(wk.resets_at):""}`,
      s.pace?`<span class="u-pace ${s.ahead?"tone-warn":"tone-ok"}">${s.ahead?"ahead of pace":"on pace"}</span>`:"",wk.pct,g,
      `Week: ${p} percent of plan used${g!=null?`, ${g} percent of the week gone`:""}`)}
  if(ok(ses)){const p=Math.round(ses.pct);
    h+=item("u-ses",`Session ${p}%${ses.resets_at?" · ends "+hm(ses.resets_at):""}`,`Session ${p}%${ses.resets_at?" · "+hm(ses.resets_at):""}`,'<span class="u-full">5 h window</span>',ses.pct,null,`Session: ${p} percent of the 5 hour window used`)}
  const w=s.week;
  if(h&&w)h+=`<span class="u-tot">${w.runs} runs · $${w.cost} · ${s.todo_done_week} todos done</span>`;
  $("ustrip").innerHTML=h;$("ustrip").hidden=!h;
  const c=s.context;
  $("ctxmeter").innerHTML=c&&c.calls?`<div class="meter" role="img" aria-label="Orchestrator context ${k(c.now)} of ${k(c.compact_at)} before compaction"><div style="width:${Math.min(100,c.now*100/c.compact_at)}%"></div></div>${k(c.now)} / ${k(c.compact_at)}`:"";
}
function setTab(t){ui.tab=t;store.set("la-tab",t);
  for(const b of document.querySelectorAll("#tabs .seg")){const on=b.dataset.tab===t;b.classList.toggle("on",on);b.setAttribute("aria-pressed",on)}
  $("c-board").hidden=t!=="board";$("c-runs").hidden=t!=="runs";$("c-sched").hidden=t!=="schedule";}

// the week's graph (the plan's own numbers: week % against on-pace, 5-hour session windows)
let lastPlan=null,planPts=[],planX=null;
const hm=t=>new Date(t*1000).toTimeString().slice(0,5), dhm=t=>new Date(t*1000).toLocaleDateString(undefined,{weekday:"short"})+" "+hm(t);
function drawPlan(s){
  const box=$("planchart"),now=Date.now()/1000,H=210,W=Math.max(280,box.clientWidth||900),L=34,R=74,Tp=18,B=22;
  const pts=(s.plan_history||[]).slice();const cur={t:now};
  if(s.plan.five_hour)cur.five_hour=[s.plan.five_hour.pct,s.plan.five_hour.resets_at];
  if(s.plan.seven_day)cur.seven_day=[s.plan.seven_day.pct,s.plan.seven_day.resets_at];
  if(!pts.length&&(cur.five_hour||cur.seven_day))pts.push(cur);
  if(!pts.length){box.innerHTML='<span class="mute">No plan numbers yet: they come with every worker run, and the graph fills in from then on.</span>';return}
  const wr=(cur.seven_day&&cur.seven_day[1])||Math.max(0,...pts.map(p=>p.seven_day?p.seven_day[1]||0:0));
  const end=wr&&wr>now?wr:now,start=end-7*86400;
  const x=t=>L+(Math.min(end,Math.max(start,t))-start)/(end-start)*(W-L-R),y=p=>Tp+(1-Math.min(100,p)/100)*(H-Tp-B);
  let g="";
  for(const p of [0,25,50,75,100])g+=`<line x1="${L}" x2="${W-R}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line)"/><text x="${L-6}" y="${y(p)+4}" text-anchor="end">${p}%</text>`;
  g+=`<text x="${x(start)}" y="${H-6}">${dhm(start)}</text><text x="${x(end)}" y="${H-6}" text-anchor="end">${wr&&wr>now?"resets ":""}${dhm(end)}</text>`;
  const d0=new Date(start*1000);d0.setHours(24,0,0,0);
  for(let d=d0.getTime()/1000;d<end;d+=86400){const xd=x(d);g+=`<line x1="${xd}" x2="${xd}" y1="${Tp}" y2="${H-B}" stroke="var(--line)" stroke-dasharray="2 3"/>`;
    if(x(d+43200)<W-R-60&&x(d+43200)>L+60)g+=`<text x="${x(d+43200)}" y="${H-6}" text-anchor="middle">${new Date(d*1000).toLocaleDateString(undefined,{weekday:"short"})}</text>`}
  const resets=[...new Set(pts.filter(p=>p.five_hour&&p.five_hour[1]).map(p=>p.five_hour[1]))];
  for(const r of resets){if(r<start)continue;const a=x(r-5*3600),b=x(r),live=r>now;
    g+=`<rect x="${a+1}" y="${Tp}" width="${Math.max(1,b-a-2)}" height="${H-Tp-B}" fill="var(--s2)" opacity="${live?.2:.09}"/>`;
    if(live)g+=`<text x="${Math.min(b,W-R)}" y="${Tp-5}" text-anchor="middle">session ends ${hm(r)}</text>`}
  g+=`<line x1="${x(start)}" y1="${y(0)}" x2="${x(end)}" y2="${y(100)}" stroke="var(--muted)" stroke-dasharray="4 4" stroke-opacity=".7"/>`;
  const path=(list,key)=>list.length?`<polyline fill="none" stroke="var(--${key==="seven_day"?"s1":"s2"})" stroke-width="2" stroke-linejoin="round" points="${list.map(p=>x(p.t).toFixed(1)+","+y(p[key][0]).toFixed(1)).join(" ")}"/>`:"";
  const sorted=pts.concat(pts.length&&pts[pts.length-1].t<now-60&&(cur.five_hour||cur.seven_day)?[cur]:[]).sort((a,b)=>a.t-b.t);
  for(const r of resets)g+=path(sorted.filter(p=>p.five_hour&&p.five_hour[1]===r&&p.t>=r-5*3600),"five_hour");
  g+=path(sorted.filter(p=>p.seven_day&&p.t>=start),"seven_day");
  const xn=x(now);g+=`<line x1="${xn}" x2="${xn}" y1="${Tp}" y2="${H-B}" stroke="var(--ink)" stroke-opacity=".35"/>`;
  const lastOf=key=>[...sorted].reverse().find(p=>p[key]&&(key!=="five_hour"||!p[key][1]||p[key][1]>now));
  const labels=[["seven_day","week"],["five_hour","session"]].map(([key,name])=>{const p=lastOf(key);return p&&{key,name,v:p[key][0],px:x(p.t),py:y(p[key][0])}}).filter(Boolean);
  if(labels.length===2&&Math.abs(labels[0].py-labels[1].py)<13){const [a,b]=labels[0].py<=labels[1].py?labels:[labels[1],labels[0]];b.ly=a.py+13;}
  for(const l of labels)g+=`<circle cx="${l.px}" cy="${l.py}" r="4" fill="var(--${l.key==="seven_day"?"s1":"s2"})" stroke="var(--surface)" stroke-width="2"/><text class="lbl" x="${l.px+8}" y="${(l.ly||l.py)+4}">${l.name} ${Math.round(l.v)}%</text>`;
  g+=`<line id="pcross" y1="${Tp}" y2="${H-B}" stroke="var(--ink)" stroke-opacity=".5" visibility="hidden"/><rect id="phit" x="${L}" y="0" width="${W-L-R}" height="${H}" fill="transparent"/>`;
  const few=(s.plan_history||[]).length<6;
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Plan usage this week: week and session window percent over time">${g}</svg>`
    +(few?`<div class="mute small">The history starts ${pts.length?dhm(pts[0].t):"now"}: each worker run adds the plan's numbers, so the lines fill in as you work.</div>`:"");
  planPts=sorted;planX=x;
  const hit=$("phit"),tip=$("ptip"),cross=$("pcross");
  hit.addEventListener("mousemove",e=>{const r=box.getBoundingClientRect(),mx=e.clientX-r.left;
    const p=planPts.reduce((a,b)=>Math.abs(planX(b.t)-mx)<Math.abs(planX(a.t)-mx)?b:a);
    cross.setAttribute("x1",planX(p.t));cross.setAttribute("x2",planX(p.t));cross.setAttribute("visibility","visible");
    tip.innerHTML=`<b>${dhm(p.t)}</b><br>${p.seven_day?`week ${p.seven_day[0]}%`:""}${p.five_hour?`${p.seven_day?" · ":""}session ${p.five_hour[0]}%${p.five_hour[1]?" (ends "+hm(p.five_hour[1])+")":""}`:""}`;
    tip.style.display="block";tip.style.left=Math.min(planX(p.t)+10,W-tip.offsetWidth)+"px";tip.style.top="8px"});
  hit.addEventListener("mouseleave",()=>{tip.style.display="none";cross.setAttribute("visibility","hidden")});
}

// actions
function askText(title,hint,value,extra){
  return new Promise(res=>{const d=$("ask");$("asktitle").textContent=title;$("askhint").textContent=hint||"";
    $("askextra").innerHTML=extra||"";$("asktext").value=value||"";
    d.onclose=()=>res(d.returnValue==="ok"?{text:$("asktext").value.trim()}:null);d.returnValue="";d.showModal();$("asktext").focus()});
}
async function act(body){const r=await post("/api/action",body);if(!r.ok)alert(r.output||r.error||"didn't work");load();return r.ok}
async function onAct(el){
  const what=el.dataset.act,c=cardsBy().get(String(el.dataset.card))||{},title=c.title||"";
  if(what==="select")return select(el.dataset.card);
  if(what==="start")return act({do:"todo-start",id:c.id});
  if(what==="reopen")return act({do:"todo-reopen",id:c.id});
  if(what==="done"){const r=await askText(`Done: #${c.id} ${title}`,"The outcome in one line (it's shown on the Done card), e.g. merged as PR 512");if(r)act({do:"todo-done",id:c.id,result:r.text})}
  if(what==="close-note")return act({do:"note-done",n:c.note});
  if(what==="dismiss")return act({do:"dismiss",id:String(c.id),sig:c.sig});
  if(what==="epic-next"){const name=title.split(":")[0].replace(/^Epic /,"");select(c.id);sendChat(`Start the next ready item of epic ${name} (lean-agent todo next --epic ${name}).`)}
  if(what==="run-stop"){if(confirm(`Stop run ${el.dataset.id}?`))act({do:"run-stop",run:el.dataset.id})}
  if(what==="sync"){if(confirm("Update lean-agent now (lean-agent sync)?"))act({do:"sync"})}
  if(what==="ifilter"){ui.filter=el.dataset.f;drawInbox(new Set())}
  if(what==="more"){ui.more[el.dataset.g]=1;drawBoard(lastBoard,new Set())}
  if(what==="add")addItem();
  if(what==="add-note")addNote();
  if(what==="plan-graph"){$("graph").showModal();if(S)drawPlan(S)}
  if(what==="close-graph")$("graph").close();
  if(what==="close-view")closeView();
}
$("handled").onclick=()=>{const c=selected();if(!c)return;onAct({dataset:{act:c.kind==="item"&&c.column!=="Done"?"done":c.kind==="note"?"close-note":"dismiss",card:String(c.id)}})};
async function addItem(){
  const projects=(lastBoard&&lastBoard.projects)||[];
  const r=await askText("Add to the work queue","A short title first, details after a colon","",
    `<select id="addproj" aria-label="Project"><option value="">project…</option>${projects.map(p=>`<option${p===$("bfilter").value?" selected":""}>${esc(p)}</option>`).join("")}</select>`
    +`<select id="addprio" aria-label="Priority"><option value="">priority</option><option>high</option><option>low</option></select><input id="addref" aria-label="Ref" placeholder="ref: PR 512, branch, work item">`);
  if(r&&r.text)act({do:"todo-add",text:r.text,project:$("addproj").value,prio:$("addprio").value,ref:$("addref").value});
}
async function addNote(){
  const r=await askText("Add a hand-off note","Something lean-agent should keep in mind: a decision you're waiting on, a reminder","",
    `<select id="notekind" aria-label="Kind"><option value="reminder">reminder</option><option value="decision">decision (for you)</option><option value="fyi">fyi</option></select>`);
  if(r&&r.text)act({do:"note-add",text:r.text,kind:$("notekind").value});
}
document.addEventListener("click",e=>{
  const run=e.target.closest("[data-run]");if(run){e.preventDefault();show(run.dataset.run);return}
  const a=e.target.closest("[data-act]");if(a){e.preventDefault();onAct(a);return}
  const tab=e.target.closest("[data-tab]");if(tab)return setTab(tab.dataset.tab);
  const pane=e.target.closest("[data-pane]");if(pane){document.body.dataset.pane=pane.dataset.pane;for(const b of document.querySelectorAll("#mtabs .seg"))b.classList.toggle("on",b===pane)}
});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape")closeView();
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();$("q").focus()}
});
$("q").addEventListener("input",()=>{ui.q=$("q").value.trim().toLowerCase();if(lastBoard){drawInbox(new Set());drawBoard(lastBoard,new Set())}});
$("bfilter").addEventListener("change",()=>{store.set("la-board-project",$("bfilter").value);if(lastBoard){drawInbox(new Set());drawBoard(lastBoard,new Set());drawHeader()}});
window.addEventListener("resize",()=>{if(S&&$("graph").open)drawPlan(S)});

async function load(){
  let s;try{const r=await fetch(`/api/state?t=${T}`);if(!r.ok)throw new Error(r.status);s=await r.json()}
  catch(e){$("stamp").innerHTML=`<span class="dot dot-bad" aria-hidden="true"></span>offline`;$("stamp").title="can't reach lean-agent: is `lean-agent up` or `lean-agent dashboard` running?";return}
  if(s.page_version&&s.page_version!==V){location.reload();return}
  S=Object.assign(S||{},s);lastBoard=s.board;
  $("stamp").innerHTML=`<span class="dot dot-ok" aria-hidden="true"></span>live ${s.now.slice(11,16)}`;
  const f=$("bfilter"),cur=f.value||store.get("la-board-project","");
  f.innerHTML='<option value="">All projects</option>'+s.board.projects.map(p=>`<option${p===cur?" selected":""}>${esc(p)}</option>`).join("");
  const changed=changedSet(s.board.cards);
  drawInbox(changed);drawHeader();drawLive(s);drawBoard(s.board,changed);drawRuns(s);drawSchedule(s);drawPlanBox(s);
  if($("graph").open)drawPlan(s);
}
document.body.dataset.pane="chat";
setTab(ui.tab);
load();setInterval(load,15000);
