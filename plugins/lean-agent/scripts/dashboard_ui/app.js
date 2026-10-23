// lean-agent workspace: Chat, Inbox and Todos on the left, the open thread on the right.
const T=new URLSearchParams(location.search).get("t")||"";
const V="__PAGE_VERSION__";  // the server's page changed (lean-agent sync): load the new one
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const k=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1000?(n/1000).toFixed(n>=10000?0:1)+"k":String(n||0);
const when=s=>s?s.slice(5,16).replace("T"," "):"";
const dur=s=>{s=Math.max(0,Math.round(s));if(s<60)return s+" s";const m=Math.floor(s/60);if(m<60)return m+" min";const h=Math.floor(m/60);if(h<24)return h+" h"+(m%60?" "+m%60+" min":"");const d=Math.floor(h/24);return d+" d"+(h%24?" "+h%24+" h":"")};
const ago=t=>{if(!t)return"";const s=(Date.now()-Date.parse(t))/1000;return s<60?"now":dur(s)};
const verdict=v=>({approve:"approved","changes-requested":"changes requested","needs-checks":"needs checks"})[v]||v||"";
const tone=st=>st==="done"||st==="merged"||st==="approve"?"tone-ok":/fail|error|stopped|changes/.test(st||"")?"tone-bad":/needs|await|partial|gap/.test(st||"")?"tone-warn":/running|doing|open/.test(st||"")?"tone-run":"tone-mute";
const store={get(k,d){try{const v=localStorage.getItem(k);return v===null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
function meter(p,warnAt,badAt){const c=p>=badAt?"bad":p>=warnAt?"warn":"";return `<div class="meter ${c}"><div style="width:${Math.min(100,Math.max(0,p))}%"></div></div>`}
function post(path,body){return fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-Lean-Agent-Token":T},body:JSON.stringify(body||{})}).then(r=>r.json().catch(()=>({ok:false,error:"HTTP "+r.status})))}

// theme: follows the system unless you pick light or dark (remembered in this browser)
let themeNow="";
function setTheme(t){if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else delete document.documentElement.dataset.theme;
  themeNow=t||"";store.set("la-theme",t||null)}
setTheme(store.get("la-theme",null));

// a run's answer or details, over the page
async function show(id,details){
  const r=await fetch(`/run/${encodeURIComponent(id)}?t=${T}${details?"&details=1":""}`);
  $("vtitle").textContent=`run ${id}${details?" · details":""}`;$("vbody").textContent=await r.text();
  $("vdet").onclick=e=>{e.preventDefault();show(id,!details)};$("vdet").textContent=details?"answer":"details";$("view").style.display="block";}
function closeView(){$("view").style.display="none"}

// state
let S=null,lastBoard=null;
const ui={sel:(t=>/^\d+$/.test(t)?"#"+t:/^(main|optimize|t\d+|#\d+)$/.test(t)?t:"main")(store.get("la-thread","main")),cardId:null,tab:store.get("la-ltab","chat"),
  open:{},sg:{},sgConfirm:null,offline:0,lastOk:null,now:"",bannerHtml:null,threads:[],doneOpen:false,changed:new Set(),html:{},sheet:null,badge:null,runsAll:false,merge:null,picks:[],target:null};
const threadKey=id=>id==="main"?"main":String(id).replace(/^#/,"");  // the chat key of a thread id: `#12` -> `12`, `t3` stays
function aboutLabel(key){const c=cardsBy().get(String(key));
  if(c)return c.kind==="item"?"#"+c.id:c.kind==="run"?"run "+(c.runs||[])[0]:c.kind==="note"?"note "+c.note:c.title.slice(0,30);
  return /^\d+$/.test(String(key))?"#"+key:String(key)}
const taskLabel=()=>ui.sel!=="main"?aboutLabel(ui.sel):"";
const cardsBy=()=>new Map(((lastBoard&&lastBoard.cards)||[]).map(c=>[String(c.id),c]));

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
const matches=c=>{const f=$("bfilter").value;return !(f&&c.project&&c.project!==f)};
const put=(id,h)=>{if(ui.html[id]!==h){ui.html[id]=h;$(id).innerHTML=h}};  // redraw a region only when it changed (keeps focus and scroll)

// optimize suggestions: one entry each at the bottom of Needs you. ui.sg keeps what you just did to one:
// gone (hidden at once), rej (rejected, with Undo for 10 s) or err (it failed, so the row is back with the error)
// <suggestions>
const SUG_TITLE={archive:"Archive card",core:"Make core card",uncore:"Take out of core card",trim:"Shorten card"};
function sugItems(c){
  const o=c.optimize||{},it=(x,r)=>Object.assign({key:c.project+"|"+x.id,project:c.project,id:x.id},r);
  return (o.suggestions||[]).map(x=>it(x,{kind:x.kind,title:`${SUG_TITLE[x.kind]||x.kind} ${x.card}`,meta:x.meta||x.reason||"",act:x.kind==="trim"?"":"apply"}))
    .concat((o.drafts||[]).map(d=>it(d,{kind:"draft",title:`Accept draft ${d.kind==="card"?"card":"preset"} ${d.name||d.title}`,meta:d.summary||"",act:"accept"})));
}
function sugGroups(optCards,sg,match){  // per project: the rows to draw, and the ones still open (not hidden, not rejected)
  const by=new Map(),all=[].concat(...optCards.map(sugItems)),have=new Set(all.map(x=>x.key));
  for(const k of Object.keys(sg))if(sg[k].st==="rej"&&sg[k].item&&!have.has(k))all.push(sg[k].item);  // the server has dropped a rejected one: it stays until Undo runs out
  for(const x of all)if(match(x)&&(sg[x.key]||{}).st!=="gone"){if(!by.has(x.project))by.set(x.project,[]);by.get(x.project).push(x)}
  return [...by].map(([project,rows])=>({project,rows,open:rows.filter(x=>(sg[x.key]||{}).st!=="rej")}));
}
// </suggestions>
const isPhone=()=>window.matchMedia("(max-width:900px)").matches;
function sugRowHtml(x){
  const s=ui.sg[x.key]||{},ids=`data-slug="${esc(x.project)}" data-id="${esc(x.id)}"`;
  const err=s.err?`<div class="serr" role="alert">${esc(s.err)}</div>`:"";
  if(s.st==="rej")return `<div class="srow rejd"><span class="t">${esc(x.title)}</span><span class="m">Rejected · <button type="button" class="undo" data-act="opt-undo" ${ids}>Undo</button></span>${err}</div>`;
  return `<div class="srow"><span class="t">${esc(x.title)}</span><span class="m">${esc(x.meta)}</span><div class="acts">`
    +(x.act?`<button type="button" class="btn sm primary" data-act="opt-${x.act}" ${ids}>${x.act==="accept"?"Accept":"Apply"}</button>`:"")
    +`<button type="button" class="btn sm" data-act="opt-reject" ${ids}>Reject</button></div>${err}</div>`;
}
function sugGroupHtml(g,many){
  const n=g.open.length,slug=esc(g.project),m=g.open.filter(x=>x.act).length;  // m: exactly the rows drawn, and what Apply all sends
  let h=`<section class="qcard sugs" role="group" aria-label="Optimize suggestions for ${slug}"><div class="hd"><span class="chip tone-run">optimize</span><span class="mono mute small">${n} suggestion${n===1?"":"s"}${many?" · "+slug:""}</span></div>`+g.rows.map(sugRowHtml).join("");
  if(ui.sgConfirm===g.project)h+=`<div class="clearbox" role="alert"><span>Apply all ${m} for ${slug}? Card changes are made now; archived cards can be restored with <code>card unarchive</code>.</span><span class="acts"><button type="button" class="btn sm primary" data-act="opt-all-yes" data-slug="${slug}">Apply all ${m}</button><button type="button" class="btn sm" data-act="opt-all-no" data-slug="${slug}">Cancel</button></span></div>`;
  else if(n)h+=`<div class="acts sact">${m?`<button type="button" class="btn sm primary" data-act="opt-all-ask" data-slug="${slug}">Apply all ${m}</button>`:""}<button type="button" class="btn sm" data-act="opt-ask" data-slug="${slug}">Ask the orchestrator</button></div>`;
  return h+"</section>";
}
const sugCard=slug=>((lastBoard&&lastBoard.cards)||[]).find(c=>c.kind==="optimize"&&c.project===slug);
const sugMatch=x=>{const pf=$("bfilter").value;return !pf||x.project===pf};
const sugShown=slug=>{const g=sugGroups(((lastBoard&&lastBoard.cards)||[]).filter(c=>c.kind==="optimize"&&c.project===slug),ui.sg,sugMatch)[0];return g?g.open.filter(x=>x.act):[]};
const sugLive=slug=>{const c=sugCard(slug);return c?sugItems(c).filter(x=>!["gone","rej"].includes((ui.sg[x.key]||{}).st)):[]};
function sugRej(key,err){  // rejected: shown with Undo for 10 s, then the row leaves
  const old=ui.sg[key]||{},item=old.item||sugItems(sugCard(key.split("|")[0])||{}).find(x=>x.key===key);
  clearTimeout(old.timer);
  ui.sg[key]={st:"rej",err,item,timer:setTimeout(()=>{if((ui.sg[key]||{}).st==="rej"){ui.sg[key]={st:"gone"};redraw()}},10000)};
}
const sugPending={};  // key -> the reject POST still on its way: Undo queues behind it
async function sugRun(slug,id,what){  // what: apply, accept, reject or undo
  const key=slug+"|"+id;clearTimeout((ui.sg[key]||{}).timer);
  if(what==="undo"&&sugPending[key])await sugPending[key];
  if(what==="reject")sugRej(key);else if(what!=="undo")ui.sg[key]={st:"gone"};
  redraw();
  const req=post("/api/action",{do:what==="undo"?"optimize-unreject":"optimize-"+what,project:slug,ids:id}).catch(e=>({ok:false,error:String(e)}));
  if(what==="reject")sugPending[key]=req.then(()=>{delete sugPending[key]});
  const r=await req;
  if(!r.ok){const err=r.output||r.error||"didn't work";if(what==="undo")sugRej(key,err);else{clearTimeout(ui.sg[key].timer);ui.sg[key]={st:"err",err}}redraw();return}
  if(what==="undo"){delete ui.sg[key];return load()}
  await load();if(what!=="reject"){delete ui.sg[key];redraw()}
}
async function sugApplyAll(slug){
  const items=sugShown(slug);if(!items.length)return;
  for(const x of items)ui.sg[x.key]={st:"gone"};
  redraw();
  const r=await post("/api/action",{do:"optimize-apply-all",project:slug,apply:items.filter(x=>x.act==="apply").map(x=>x.id).join(","),ids:items.filter(x=>x.act==="accept").map(x=>x.id).join(",")}).catch(e=>({ok:false,error:String(e)}));
  if(!r.ok){const err=r.output||r.error||"didn't work";for(const x of items)ui.sg[x.key]={st:"err",err};redraw();return}
  await load();for(const x of items)delete ui.sg[x.key];redraw();
}
function sugAsk(slug){
  const items=sugLive(slug);if(!items.length)return;
  select("optimize");
  sendChat(`Optimize suggests ${items.length} change${items.length===1?"":"s"} for project ${slug}:\n`+items.map((x,i)=>`${i+1}. ${x.title} (${x.meta}) [${x.id}]`).join("\n")
    +`\nAsk me which of these to apply, using AskUserQuestion. Then run lean-agent optimize ${slug} --apply <ids> for the card changes and --accept <ids> for the drafts, and --reject <ids> for the ones I turn down.`);
}
function sugPrune(cards){  // hidden rows the server no longer lists are done
  const live=new Set(cards.filter(c=>c.kind==="optimize").flatMap(c=>sugItems(c).map(x=>x.key)));
  for(const k of Object.keys(ui.sg))if(["gone","err"].includes(ui.sg[k].st)&&!live.has(k))delete ui.sg[k];
}
function sameItem(list){const t=list.map(c=>c.todo);return t[0]!=null&&t.every(x=>String(x)===String(t[0]))?t[0]:null}

// LEFT: Chat (all threads), Inbox (what waits for you) and Todos (open work), one flat list each
const agoS=t=>{const a=ago(t);return a==="now"?a:a?a+" ago":""};
const plural=(n,w)=>`${n} ${w}${n===1?"":"s"}`;
const threadName=id=>/^#/.test(id)?id:((ui.threads.find(t=>t.id===id)||{}).title||(id==="main"?"Main":id==="optimize"?"Optimize":id));
const sugCount=()=>sugGroups(((lastBoard&&lastBoard.cards)||[]).filter(c=>c.kind==="optimize"&&c.column==="Waiting on you"),ui.sg,sugMatch).reduce((a,g)=>a+g.open.length,0);
function threadMeta(t){
  const n=t.id==="optimize"?sugCount():0;
  return [n?plural(n,"suggestion"):t.messages?plural(t.messages,"message"):"no messages yet",agoS(t.last_message)].filter(Boolean).join(" · ");
}
function threadRow(t,box){  // box: a checkbox in front (the phone's pick-to-merge list)
  const tag=/^#/.test(t.id)?t.id:"",title=t.title&&t.title!==t.id?t.title:"";
  const btn=`<button type="button" class="row${t.id===ui.sel?" sel":""}" data-act="select" data-thread="${esc(t.id)}"><span class="t">${tag?`<span class="id mono">${esc(tag)}</span> `:""}${esc(title||t.id)}</span>`
    +`<span class="m"><span>${esc(threadMeta(t))}</span>${t.waiting?'<span class="dot dot-warn" role="img" aria-label="waits for you"></span>':""}</span></button>`;
  if(!box)return btn;
  const can=t.id!=="main"&&t.id!=="optimize",on=(ui.picks||[]).includes(t.id);
  return `<div class="trow">${can?`<label class="pick"><input type="checkbox" data-pick="${esc(t.id)}"${on?" checked":""} aria-label="Pick ${esc(tag||title||t.id)} to merge"></label>`:'<span class="pick"></span>'}${btn}</div>`;
}
function listedThreads(){  // Main is always there; Optimize only while it has suggestions or messages
  const l=ui.threads.filter(t=>t.id!=="optimize"||t.messages||sugCount()||t.id===ui.sel);
  return l.some(t=>t.id==="main")?l:[{id:"main",title:"Main",kind:"main",messages:0,waiting:false}].concat(l);
}
const threadListHtml=box=>{const l=listedThreads();return l.length?l.map(t=>threadRow(t,box)).join(""):'<div class="empty">No threads yet. Ask Claude anything, or start one with +.</div>'};
const askHtml=id=>`<form class="ask" data-ask><label class="sr" for="${id}">Ask Claude anything</label><input type="text" id="${id}" autocomplete="off" placeholder="Ask Claude anything"><button type="submit" class="btn primary">Ask</button></form>`;
const cardThread=c=>c.kind==="item"?"#"+c.id:c.todo!=null?"#"+c.todo:"main";
const dotOf=c=>c.kind==="pr"&&/ready/.test(c.why||"")?"dot-ok":c.kind==="note"?"dot-run":/merged|approved/.test(c.why||"")?"dot-ok":"dot-warn";
function inboxRow(c,thread,age,ch,cls){
  return `<button type="button" class="row inrow${ch?" changed":""}${cls?" "+cls:""}" data-act="open-card" data-card="${esc(c.id)}" data-thread="${esc(thread)}"><span class="t"><span class="dot ${dotOf(c)}" aria-hidden="true"></span>${esc(c.title)}</span>`
    +`<span class="m"><span>${esc(threadName(thread))}</span>${age?`<span>${esc(age)}</span>`:""}</span></button>`;
}
const cardAge=c=>ago((c.last_run||{}).ts||c.done_at||"");
function drawInbox(changed){  // the number of rows
  const cards=(lastBoard&&lastBoard.cards)||[],pf=$("bfilter").value;
  const wait=cards.filter(c=>c.column==="Waiting on you"&&c.kind!=="optimize"&&matches(c));
  const sgs=sugGroups(cards.filter(c=>c.kind==="optimize"&&c.column==="Waiting on you"&&(!pf||c.project===pf)),ui.sg,sugMatch);
  const nSug=sgs.reduce((a,g)=>a+g.open.length,0);
  // runs blocked by the same cause (the same authorization error, say) are one row
  const blocked=c=>c.cause&&(c.kind==="run"||(c.kind==="item"&&c.last_run&&/needs|await/.test(c.last_run.status)));
  const byCause=new Map();for(const c of wait)if(blocked(c)){if(!byCause.has(c.cause))byCause.set(c.cause,[]);byCause.get(c.cause).push(c)}
  const seen=new Set();let h="",n=0;
  const grow=(cause,group)=>{const open=!!ui.open[cause],item=sameItem(group),newest=group.reduce((a,c)=>((c.last_run||{}).ts||"")>a?(c.last_run||{}).ts:a,""),label=group[0].cause_label||cause;
    return `<button type="button" class="row grow inrow" aria-expanded="${open}" data-act="cause" data-cause="${esc(cause)}"><span class="t"><span class="dot dot-warn" aria-hidden="true"></span>${group.length} runs blocked: ${esc(label)}</span>`
      +`<span class="m"><span>${esc(item!=null?"#"+item:"Main")}</span><span>${esc(ago(newest))}</span></span>`
      +`<svg class="chev${open?" open":""}" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>`
      +(open?`<div class="kids" role="group" aria-label="Runs blocked: ${esc(label)}">${group.map(c=>inboxRow(c,cardThread(c),cardAge(c),changed.has(String(c.id)),"kid")).join("")}</div>`:"")};
  for(const c of wait){const g=blocked(c)&&byCause.get(c.cause);
    if(g&&g.length>1){if(seen.has(c.cause))continue;seen.add(c.cause);h+=grow(c.cause,g)}
    else h+=inboxRow(c,cardThread(c),cardAge(c),changed.has(String(c.id)));
    n++}
  if(nSug){n++;h+=`<button type="button" class="row inrow" data-act="select" data-thread="optimize"><span class="t"><span class="dot dot-warn" aria-hidden="true"></span>${plural(nSug,"optimize suggestion")}</span><span class="m"><span>Optimize</span></span></button>`}
  put("inbox",h||`<div class="empty2"><b>Nothing needs you</b><span>Run questions, decisions and PR comments that wait for your reply show up here.</span></div>`);
  return n;
}
const TODO_RANK={"In progress":0,"Waiting on you":1,"In review":2,"Open":3};
function todoStatus(c){
  return c.live&&c.live.length?"running":c.column==="Done"?(c.result==="merged"?"merged":"done"):c.column==="Waiting on you"?"needs you"
    :c.column==="In review"?(c.review&&verdict(c.review.verdict))||"in review":c.column==="In progress"?"doing":"open";
}
function todoRow(c){
  const st=todoStatus(c),run=c.live&&c.live.length,
    meta=[c.prio!=="normal"?c.prio:"",c.project||"",c.last_run&&!run?"last run "+c.last_run.status:c.runs&&c.runs.length?plural(c.runs.length,"run"):"",c.notes?plural(c.notes,"note"):""].filter(Boolean).join(" · ");
  return `<button type="button" class="row todorow" data-act="open-card" data-card="${esc(c.id)}" data-thread="#${esc(c.id)}"><span class="t"><span class="id mono">#${esc(c.id)}</span> ${esc(c.title)}</span>`
    +`<span class="m"><span class="chip ${tone(st)}">${esc(st)}</span><span>${esc(meta||"no activity yet")}</span></span></button>`;
}
function drawTodos(){  // the number of open todos
  const items=((lastBoard&&lastBoard.cards)||[]).filter(c=>c.kind==="item"&&matches(c));
  const open=items.filter(c=>c.column!=="Done").sort((a,b)=>(TODO_RANK[a.column]??9)-(TODO_RANK[b.column]??9)),done=items.filter(c=>c.column==="Done");
  let h=open.map(todoRow).join("");
  if(done.length)h+=`<button type="button" class="row grow" aria-expanded="${ui.doneOpen}" data-act="done-toggle"><span class="t">Done in the last 7 days</span><span class="m"><span>${done.length}</span></span>`
    +`<svg class="chev${ui.doneOpen?" open":""}" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>`
    +(ui.doneOpen?`<div class="kids">${done.map(todoRow).join("")}</div>`:"");
  put("todos",h||`<div class="empty2"><b>No todos yet</b><span>Add one with /todo in a thread and it appears here.</span></div>`);
  return open.length;
}
function drawLeft(changed){
  if(changed)ui.changed=changed;
  put("threads",threadListHtml());
  const nIn=drawInbox(ui.changed),nTodo=drawTodos(),nWait=ui.threads.filter(t=>t.waiting).length;
  $("n-chat").textContent=$("m-chat").textContent=nWait||"";$("n-chat").title=nWait?plural(nWait,"thread")+" waiting for you":"";
  $("n-inbox").textContent=$("m-inbox").textContent=nIn||"";$("n-todos").textContent=$("m-todos").textContent=nTodo||"";
}
const redraw=()=>{drawLeft();if(typeof drawChat==="function")drawChat()};
async function loadThreads(){
  try{const r=await fetch(`/api/threads?t=${T}`);if(!r.ok)return;const s=await r.json();ui.threads=s.threads||[];
    if(s.service_status&&typeof chat!=="undefined")chat.svc=s.service_status}catch(e){return}
  drawLeft();if(typeof drawHeader==="function")drawHeader();if(typeof drawChat==="function")drawChat();
}
function setTab(t){ui.tab=t;store.set("la-ltab",t);document.body.dataset.tab=t;
  for(const b of document.querySelectorAll("[data-ltab]")){const on=b.dataset.ltab===t;b.classList.toggle("on",on);b.setAttribute("aria-pressed",on)}
  for(const n of ["chat","inbox","todos"])$("l-"+n).hidden=n!==t}
// the thread switcher (phone) and the move picker: one sheet
function openSheet(mode,mid,from){
  const move=mode==="move";ui.sheet={mode,mid};
  $("sheet-t").textContent=move?"Move message to":"Threads";
  $("sheetbody").innerHTML=move?`<div class="rows">${ui.threads.filter(t=>t.id!=="main"&&t.id!==from).map(t=>`<button type="button" class="row" data-act="move-to" data-to="${esc(t.id)}"><span class="t">${/^#/.test(t.id)?`<span class="id mono">${esc(t.id)}</span> `:""}${esc(t.title||t.id)}</span></button>`).join("")||'<div class="empty">No other thread to move it to.</div>'}</div>`
    :`<div class="thr-top">${askHtml("ask-s")}<button type="button" class="btn tnew" data-act="new-thread" aria-label="New thread">+</button></div><div class="hint mono">No thread picked: Claude chooses one, or starts a new one.</div><fieldset class="picks"><legend>Pick two or more</legend><div class="rows" id="pickrows">${threadListHtml(true)}</div></fieldset>`;
  $("mergesum").innerHTML=move?"":mergeSummaryHtml();
  if(!$("sheet").open)$("sheet").showModal();
}
// merging threads: the phone ticks two or more in the threads sheet, the desktop picks one in the open thread's header
const pickTargets=()=>{const l=listedThreads().map(t=>t.id),p=(ui.picks||[]).filter(id=>l.includes(id));return p.sort((a,b)=>l.indexOf(a)-l.indexOf(b))};
const mergeTarget=()=>{const p=pickTargets();return p.includes(ui.target)?ui.target:p[0]};
const mergeName=id=>/^#/.test(id)?id:threadName(id);
function mergeSummary(){  // null until two are ticked
  const p=pickTargets(),to=mergeTarget();if(p.length<2)return null;
  const names=p.map(mergeName),list=names.length===2?names.join(" and "):names.slice(0,-1).join(", ")+" and "+names[names.length-1];
  return {ids:p,to,text:`Merge ${list} into one thread`,keeps:`Keeps the title of ${mergeName(to)}`,button:`Merge ${p.length} threads`};
}
function mergeSummaryHtml(){
  const m=mergeSummary();if(!m)return"";
  return `<div class="mergesum"><div class="mst">${esc(m.text)}</div><div class="msk mono"><span>${esc(m.keeps)}</span><button type="button" class="link" data-act="merge-change">Change</button></div>`
    +`<div class="msn">Messages are ordered by time. Open questions and prompts move along.</div><div class="acts"><button type="button" class="btn primary" data-act="merge-go">${esc(m.button)}</button><button type="button" class="btn" data-act="merge-cancel">Cancel</button></div></div>`;
}
async function mergeThreads(ids,to){  // every other thread into `to`, one after the other
  for(const from of ids.filter(id=>id!==to)){
    const r=await post("/api/thread/merge",{from,into:to});
    if(!r.ok){alert("Couldn't merge "+from+": "+(r.error||"unknown error"));return false}
  }
  return true;
}
async function mergeGo(ids,to){
  if(!await mergeThreads(ids,to)){loadThreads();return}
  ui.picks=[];ui.target=null;ui.merge=null;closeSheet();
  await loadThreads();select(to);refresh();
}
async function unmergeThread(from){
  const r=await post("/api/thread/unmerge",{from});
  if(!r.ok)alert("Couldn't unmerge: "+(r.error||"unknown error"));
  await loadThreads();return refresh();
}
function mergePick(){  // desktop: the thread picked to merge into the open one (the first until you pick)
  const m=ui.merge,others=ui.threads.filter(t=>t.id!=="main"&&t.id!=="optimize"&&t.id!==ui.sel);
  return {others,pick:m&&m.pick&&others.some(t=>t.id===m.pick)?m.pick:(others[0]||{}).id};
}
const mergeOpenGo=()=>{const {pick}=mergePick();return pick?mergeGo([pick,ui.sel],ui.sel):undefined};
function mergeBoxHtml(){  // desktop: pick the thread to merge into the open one
  if(!ui.merge)return"";
  const {others,pick}=mergePick();
  return `<section class="mergebox" role="dialog" aria-label="Merge threads"><div class="mgt">Merge into ${esc(mergeName(ui.sel))}</div><fieldset><legend class="mono">Pick the thread to merge in</legend>`
    +(others.map(t=>`<label class="mgl"><input type="radio" name="mg" data-merge-pick="${esc(t.id)}"${t.id===pick?" checked":""}><span>${/^#/.test(t.id)?`<span class="id mono">${esc(t.id)}</span> `:""}${esc(t.title&&t.title!==t.id?t.title:t.id)}</span><span class="mute">· ${esc(plural(t.messages||0,"message"))}</span></label>`).join("")||'<div class="empty">No other thread to merge in.</div>')
    +`</fieldset><div class="msn">Messages are ordered by time and keep the title of ${esc(mergeName(ui.sel))}. Open questions and prompts move along.</div>`
    +`<div class="acts"><button type="button" class="btn primary" data-act="merge-do"${pick?"":" disabled"}>Merge 2 threads</button><button type="button" class="btn" data-act="merge-cancel">Cancel</button></div></section>`;
}
function closeSheet(){const d=$("sheet");if(d&&d.open)d.close();ui.sheet=null}
async function newThread(){
  closeSheet();
  const r=await askText("New thread","A short title for the thread","");
  if(!r||!r.text)return;
  const res=await post("/api/thread/new",{title:r.text});
  if(!res.ok){alert(res.error||"didn't work");return}
  await loadThreads();select(res.id);
}
async function moveMessage(mid,to){
  closeSheet();
  const r=await post("/api/thread/move",{message:mid,to});
  if(!r.ok)alert("Couldn't move: "+(r.error||"unknown error"));
  refresh();loadThreads();
}
async function ask(text){  // "Ask Claude anything": no thread, so Claude routes it (in fallback it goes to main)
  text=String(text||"").trim();if(!text)return;
  closeSheet();select("main");await sendChat(text,null);
}
// the routing line under a message Claude placed in a thread, with Move
function routeText(r){
  if(!r)return"";
  if(r.title)return `Started a new thread: ${r.title}`;
  if(!r.target)return r.text||"";
  return (r.also||[]).length?`Routed to ${r.target}. Also close: ${r.also.join(", ")}`:`Routed to ${r.target} by Claude`;
}
function routeHtml(e){
  const t=routeText(e.routing);if(!t)return"";
  return `<div class="route mono"><span>${esc(t)}</span>${e.mid?`<button type="button" class="btn sm" data-act="move" data-mid="${esc(e.mid)}" data-from="${esc(e.thread||"")}" aria-label="Move this message to another thread">Move</button>`:""}</div>`;
}

function syncNotice(s){  // the newest sync record, if it says an update is available and this version isn't there yet
  const verGE=(a,b)=>{const x=String(a).split(".").map(Number),y=String(b).split(".").map(Number);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return(x[i]||0)>(y[i]||0)}return true};
  const last=(s.scheduled_results||[]).find(r=>/sync/.test((r.args||[]).join(" ")));
  const m=last&&/(\d+\.\d+\.\d+)\s*(?:->|→)\s*(\d+\.\d+\.\d+)/.exec(last.first||"");
  return m&&!(s.version&&verGE(s.version,m[2]))?last:null;
}
function schedHtml(s){
  const upd=syncNotice(s);
  const kept=store.get("la-syncmsg","");if(kept){ui.syncMsg=kept;store.set("la-syncmsg","")}
  return (upd?`<div class="update"><span>${esc(upd.first)}</span><button type="button" class="btn sm" data-act="sync"${ui.syncing?" disabled":""}>${ui.syncing?"Syncing…":"Sync"}</button></div>`:"")
    +(ui.syncMsg?`<div class="mono mute small" role="status" style="padding:4px">${esc(ui.syncMsg)}</div>`:"")
    +((s.optimize||[]).length?`<div class="grp"><span>Optimize</span><span>${s.optimize.length}</span></div>`+s.optimize.map(o=>`<div class="line"><span class="t">${esc(o.project)}${o.ts?" · last "+when(o.ts):" · never ran"}${o.left?" · "+o.left+" to decide":""}</span><button type="button" class="btn sm" data-act="opt-run" data-slug="${esc(o.project)}"${o.running?" disabled":""}>${o.running?"running":"Run optimize"}</button></div>`).join(""):"")
    +s.schedule.map(j=>`<article class="card"><div class="t"><span class="mono">#${j.id} ${esc(j.cmd)}</span></div><div class="mt"><span class="chip tone-mute">${esc(j.when)}</span><span>${j.enabled?(j.next?"next "+when(j.next):""):"paused"} · ${j.last?"last "+when(j.last):"never ran yet"}</span></div></article>`).join("")
    +`<div class="mono mute small" style="padding:4px">${esc(s.schedule_runner||"")}</div>`
    +((s.scheduled_results||[]).length?`<div class="grp"><span>Recent results</span><span>${s.scheduled_results.length}</span></div>`+s.scheduled_results.slice(0,5).map(r=>`<div class="line"><span class="t">#${r.id} ${esc(r.first)}</span><span class="chip ${r.rc?"tone-bad":"tone-ok"}">exit ${r.rc}</span></div>`).join(""):"");
}
// the bottom badges: each toggles a sheet (a popover over the bar on the desktop, a bottom sheet on the phone)
const BADGES=[["runs","Runs"],["schedule","Schedule"],["notes","Notes"],["context","Context"]];
const noteCards=()=>((lastBoard&&lastBoard.cards)||[]).filter(c=>c.kind==="note");
function runList(){  // workers still running first (a run is in the ledger only once it ends), then the recent runs
  const st=S||{},have=new Set((st.runs||[]).map(r=>r.id)),live=new Map((st.running||[]).map(r=>[r.run,r]));
  return (st.running||[]).filter(r=>!have.has(r.run)).map(r=>({id:r.run,todo:r.todo,model:r.model,effort:r.effort,status:"running",units:0,live:r}))
    .concat((st.runs||[]).map(r=>live.has(r.id)?Object.assign({},r,{live:live.get(r.id)}):r));
}
function badgeCount(key){
  const st=S||{};
  if(key==="runs")return runList().length;
  if(key==="schedule")return (st.schedule||[]).length;
  if(key==="notes")return noteCards().length;
  return st.context&&st.context.calls?k(st.context.now):"";
}
const badgesHtml=()=>BADGES.map(([key,label])=>{const n=badgeCount(key),on=ui.badge===key;
  return `<button type="button" class="bb${on?" on":""}" data-act="badge" data-badge="${key}" aria-pressed="${on}" aria-expanded="${on}">${label}${n!==""&&n!=null?" "+esc(n):""}</button>`}).join("");
function runRowHtml(r){
  const lv=r.live,st=lv?`running · ${plural(lv.turns||0,"turn")}`:(r.status||"").split(":")[0]+(r.passes>1?" · "+r.passes+" passes":""),
    cost=r.cost!=null?"$"+r.cost.toFixed(2):r.units?k(r.units):"",model=[r.model,r.effort].filter(Boolean).join(" / ");
  return `<div class="runrow${lv?" isrun":""}" data-run="${esc(r.id)}"><div class="rt"><span class="rid mono">${esc(r.id)}</span><span class="rc mono">${esc([r.todo!=null?"#"+r.todo:"",cost].filter(Boolean).join(" · "))}</span></div>`
    +`<div class="rt"><span class="rchips">${model?`<span class="chip tone-mute">${esc(model)}</span>`:""}<span class="chip ${lv?"tone-run":tone(r.status)}">${esc(st)}</span></span>`
    +(lv?`<button type="button" class="stopb" data-act="run-stop" data-id="${esc(r.id)}" aria-label="Stop run ${esc(r.id)}">Stop run</button>`:"")+`</div></div>`;
}
function runsHtml(){
  const rs=runList(),list=ui.runsAll?rs:rs.slice(0,7),st=S||{};
  const same=p=>String(p.to||"").replace(/^origin\//,"")===p.branch,pushes=st.pushes||[];
  return `<div class="runs">${list.map(runRowHtml).join("")||'<div class="empty">No runs yet.</div>'}`
    +(rs.length>7?`<button type="button" class="more" data-act="runs-all">${ui.runsAll?"Show fewer runs":"Show all "+rs.length+" runs"}</button>`:"")+"</div>"
    +(pushes.length?`<div class="desk"><div class="grp"><span>Pushes</span><span>${pushes.length}</span></div>`+pushes.map(p=>`<div class="mono mute small" style="padding:2px 4px">${esc(p.branch)}${same(p)?"":" → "+esc(p.to)} · ${p.count} push${p.count>1?"es":""}${p.failed?` · ${p.failed} failed`:""} · last ${when(p.ts)}</div>`).join("")+"</div>":"");
}
function notesHtml(){
  const ns=noteCards();
  return (ns.map(c=>{const age=agoS(c.done_at);
    return `<div class="nrow"><button type="button" class="ntext" data-act="open-card" data-card="${esc(c.id)}" data-thread="${esc(cardThread(c))}"><span class="t">${esc(c.text)}</span><span class="m mono">${esc([c.note_kind||"note",threadName(cardThread(c)),age].filter(Boolean).join(" · "))}</span></button>`
      +`<button type="button" class="btn sm" data-act="close-note" data-card="${esc(c.id)}" aria-label="Close note ${c.note}">Close</button></div>`}).join("")||'<div class="empty">No hand-off notes.</div>')
    +`<div class="bact"><button type="button" class="btn sm" data-act="add-note">+ Note</button></div>`;
}
function contextHtml(){
  const c=(S||{}).context,whole=typeof chat!=="undefined"&&chat.service?" · whole session":"";
  return (c&&c.calls?`<div class="ctxmeter mono"><span>Orchestrator context · compacts at about ${k(c.compact_at)}${whole?` <span class="mute">${esc(whole.slice(3))}</span>`:""}</span><div class="meter thin${c.now>=c.compact_at*.9?" warn":""}" role="img" aria-label="Orchestrator context${whole}: ${k(c.now)} of ${k(c.compact_at)} before compaction"><div style="width:${Math.min(100,c.now*100/c.compact_at)}%"></div></div></div>`
    :'<div class="empty">No context numbers yet.</div>')
    +`<div class="bact">${typeof clearHtml==="function"?clearHtml():""}</div>`
    +`<div class="bact"><button type="button" class="btn sm" data-act="theme">Theme: ${esc(themeNow||"auto")}</button><button type="button" class="btn sm" data-act="add">+ Add item</button></div>`;
}
const BADGE_TITLE={runs:"Runs",schedule:"Schedule",notes:"Notes",context:"Context"};
function sheetHtml(key){
  const st=S||{},n=badgeCount(key),body=key==="runs"?runsHtml():key==="schedule"?schedHtml(st):key==="notes"?notesHtml():contextHtml();
  return `<div class="bhandle" aria-hidden="true"></div><div class="bhd"><h2>${BADGE_TITLE[key]}${n!==""?` <span class="mono mute">${esc(n)}</span>`:""}</h2><button type="button" class="bclose" data-act="close-badge" aria-label="Close ${BADGE_TITLE[key].toLowerCase()}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"/></svg></button></div><div class="bbody">${body}</div>`;
}
function drawSheet(){
  if(!ui.badge||!S){$("bwrap").hidden=true;return}
  $("bsheet").setAttribute&&$("bsheet").setAttribute("aria-label",BADGE_TITLE[ui.badge]);
  put("bsheet",sheetHtml(ui.badge));$("bwrap").hidden=false;
}
function drawBadges(){put("badges",badgesHtml());drawSheet()}
function toggleBadge(key){
  ui.badge=ui.badge===key?null:key;ui.runsAll=false;
  drawBadges();
  if(typeof document!=="undefined"&&document.querySelector){const b=document.querySelector(`[data-badge="${key}"]`);if(b)b.focus()}
}
function closeBadge(){if(ui.badge)toggleBadge(ui.badge)}

// CENTER: the open thread (chat.js draws the messages)
function selected(){
  const cards=cardsBy(),m=/^#(\d+)$/.exec(ui.sel);
  const c=(ui.cardId&&cards.get(String(ui.cardId)))||(m&&cards.get(m[1]));if(c)return c;
  if(ui.sel==="main")return null;const t=ui.threads.find(t=>t.id===ui.sel);return t?{id:ui.sel,title:t.title,kind:"thread"}:null;
}
function threadLabel(){const c=selected();return /^#/.test(ui.sel)?ui.sel+(c&&c.title?" · "+c.title:""):threadName(ui.sel)}
function contextText(c){
  if(!c)return "";
  const bits=[c.kind==="item"?`work item #${c.id} "${c.text}"`:c.kind==="run"?`a run that asks: "${c.text}"`:c.kind==="note"?`hand-off note ${c.note}: "${c.text}"`:`${c.title}`];
  if(c.project)bits.push(`project ${c.project}`);if(c.ref)bits.push(`ref ${c.ref}`);
  if((c.runs||[]).length)bits.push(`runs ${c.runs.join(", ")}`);if(c.why)bits.push(`status: ${c.why}`);
  if(c.pr&&c.pr.number)bits.push(`PR ${c.pr.number}`);if(c.link)bits.push(c.link);
  return bits.join("; ");
}
function drawHeader(){
  const c=selected(),service=!!(typeof chat!=="undefined"&&chat.service),rc=typeof rcState==="function"?rcState():"unknown",proj=$("bfilter").value;
  const fb=inFallback(),shared=fb?"not shared":rc==="on"?"also open in the Claude app":rc==="off"?"dashboard only":"";
  const label=threadLabel(),to=/^#/.test(ui.sel)?ui.sel:threadName(ui.sel);
  $("ttitle").textContent=label;$("tbar-t").textContent=label;
  $("tsub").textContent=[ui.sel==="main"&&!fb?"Whole session":"",shared].filter(Boolean).join(" · ");
  $("chatin").placeholder="Message "+to;$("chatin").setAttribute("aria-label","Message "+to);
  const rcEl=$("rc"),svc=(typeof chat!=="undefined"&&chat.svc)||(S&&S.service)||null;
  rcEl.hidden=fb||!(service||(svc&&svc.configured));
  rcEl.textContent="Remote Control "+rc;rcEl.className="chip "+(rc==="on"?"tone-ok":rc==="off"?"tone-warn":"tone-mute");
  rcEl.title=rc==="on"?"This session is also open in the Claude app":rc==="off"?"Dashboard only: the Claude app does not see this session":"Can't tell whether Remote Control is on";
  const canMerge=!fb&&/^(#\d+|t\d+)$/.test(ui.sel);
  $("merge").hidden=!canMerge;if(!canMerge)ui.merge=null;drawMerge();
  $("handled").hidden=!c||c.kind==="thread"||c.kind==="note";
  $("handled").textContent=c&&c.kind==="item"&&c.column!=="Done"?"Done…":"Mark handled";
  $("ctxpills").innerHTML=proj?`<span class="cpill"><span>${esc(proj)}</span><button type="button" class="x" data-act="clear-project" aria-label="Remove project: ${esc(proj)}">×</button></span>`:"";
}
function drawMerge(){const h=mergeBoxHtml();$("mergebox").hidden=!h;put("mergebox",h)}
function optimizeHtml(){  // the Optimize thread: the v0.31.1 Apply / Reject cards
  const pf=$("bfilter").value,cards=((lastBoard&&lastBoard.cards)||[]).filter(c=>c.kind==="optimize"&&c.column==="Waiting on you"&&(!pf||c.project===pf));
  const gs=sugGroups(cards,ui.sg,sugMatch);
  return gs.map(g=>sugGroupHtml(g,gs.length>1)).join("")||`<div class="sysl">No optimize suggestions are waiting.</div>`;
}
function reviewLines(c){  // review branches show inside the todo's thread
  const cards=((lastBoard&&lastBoard.cards)||[]).filter(x=>x.kind==="review"&&c.ref&&x.ref===c.ref&&x.project===c.project);
  const out=cards.map(x=>`review of ${x.ref}: ${verdict(x.review&&x.review.verdict)||x.why||"in review"}`);
  if(!out.length&&c.review)out.push("review: "+(verdict(c.review.verdict)||"in review"));
  return out;
}
function contextCard(){
  if(ui.sel==="optimize")return optimizeHtml();
  const c=selected();if(!c||c.kind==="thread")return "";
  if(c.kind==="note"){
    const dec=c.note_kind==="decision",age=ago(c.done_at);
    return `<section class="qcard" aria-label="Hand-off note ${c.note}"><div class="hd"><span class="chip tone-run">hand-off · ${esc(c.note_kind||"note")}</span><span class="chip tone-mute">note ${c.note}${age?" · "+(age==="now"?age:age+" ago"):""}</span></div><p>${esc(c.text)}</p>`
      +`<label class="sr" for="dec-${c.note}">Your ${dec?"decision":"reply"} for note ${c.note}</label><textarea class="dec" id="dec-${c.note}" rows="2" data-draft="${c.note}" placeholder="${dec?"Your decision":"Your reply"}">${esc(chat.drafts[c.note]||"")}</textarea>`
      +`<div class="acts"><button type="button" class="btn sm primary" data-act="note-decide">${dec?"Send decision":"Send reply"}</button><button type="button" class="btn sm" data-act="note-edit" data-card="${esc(c.id)}">Edit note</button><button type="button" class="btn sm" data-act="close-note" data-card="${esc(c.id)}">Close note</button></div><div class="mono mute small">Sends this as a message to the orchestrator</div></section>`;
  }
  const chip=c.kind==="run"?["run asks","tone-warn"]:c.kind==="pr"?["pull request","tone-run"]:c.kind==="review"?["review","tone-run"]:c.kind==="epic"?["epic","tone-ok"]:[c.column||"item",tone(c.column==="Done"?"done":c.column==="Waiting on you"?"needs":"open")];
  const lr=c.last_run;
  const meta=[c.kind==="item"?"#"+c.id:"",lr?`${lr.status} · ${when(lr.ts)}`:"",c.ref||"",c.project||""].filter(Boolean).join(" · ");
  const body=c.kind==="run"?c.text:[c.rest||(c.title!==c.text?c.text:""),c.why,c.result?"result: "+c.result:""].filter(Boolean).join("\n");
  const revs=c.kind==="item"?reviewLines(c):[],runs=(c.runs||[]).map(id=>`<a data-run="${esc(id)}" href="#">${esc(id)}</a>`).join(" ");
  return `<section class="qcard" aria-label="What this thread is about"><div class="hd"><span class="chip ${chip[1]}">${esc(chip[0])}</span>${c.link?`<a href="${esc(c.link)}" target="_blank" rel="noopener" class="mono">open ↗</a>`:""}<span class="mono mute">${esc(meta)}</span></div>`
    +(body?`<p>${esc(body)}</p>`:"")+(revs.length?`<div class="mono small">${revs.map(esc).join("<br>")}</div>`:"")+(runs?`<div class="mono small">${runs}</div>`:"")+`<div class="acts">${cardButtons(c,true)}</div></section>`;
}
function cardButtons(c,full){
  const b=(act,label,primary)=>`<button type="button" class="btn sm${primary?" primary":""}" data-act="${act}" data-card="${esc(c.id)}">${label}</button>`;
  const a=[];
  if(c.kind==="item"&&c.column!=="Done"){if(c.column==="Open")a.push(b("start","Start"));a.push(b("done","Done…"))}
  else if(c.kind==="item")a.push(b("reopen","Reopen"));
  if(c.kind==="note")a.push(b("close-note","Close note"));
  if(full&&c.kind==="item")a.push(b("edit","Edit"));
  if(c.kind==="epic")a.push(b("epic-next","Start next",true));
  if(c.kind==="run"||c.kind==="pr"||c.kind==="review"||c.column==="Waiting on you")a.push(b("dismiss","Mark handled"));
  return a.join("");
}
function cardActs(c){  // a board card's buttons, plus Stop run while a worker runs on it
  const stop=c.live&&c.live.length?`<button type="button" class="btn sm" data-act="run-stop" data-id="${esc(c.live[0].run)}" aria-label="Stop run ${esc(c.live[0].run)}">Stop run</button>`:"";
  const h=(c.kind!=="lookup"?cardButtons(c):"")+stop;return h?`<div class="acts">${h}</div>`:"";
}
function select(id,cardId){
  ui.sel=id||"main";ui.cardId=cardId||null;store.set("la-thread",ui.sel);
  if(isPhone())setTab("chat");
  closeSheet();if(ui.badge)closeBadge();ui.merge=null;drawHeader();drawLeft();if(typeof openThread==="function")openThread(threadKey(ui.sel));
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
  $("mustrip").innerHTML=h;$("mustrip").hidden=!h;
  drawBadges();
}

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
async function optRun(slug){
  const r=await post("/api/action",{do:"optimize-run",project:slug});
  if(!r.ok)alert(r.output||r.error||"didn't work");
  load();
}
async function doSync(){
  if(ui.syncing||!confirm("Update lean-agent now (lean-agent sync)?"))return;
  ui.syncing=true;ui.syncMsg="";drawSheet();
  const before=S.version;let r;
  try{r=await post("/api/action",{do:"sync"})}catch(e){r={ok:false,output:String(e)}}
  ui.syncing=false;
  const line=(r.output||r.error||"").split("\n").map(l=>l.trim()).filter(Boolean).pop()||"";
  ui.syncMsg=r.ok?(r.version&&r.version!==before?`Updated to ${r.version}`:line||"Already up to date"):`Sync failed: ${line||"no output"}`;
  if(r.page&&r.page!==V){store.set("la-syncmsg",ui.syncMsg);location.reload();return}
  load();
}
async function onAct(el){
  const what=el.dataset.act,c=cardsBy().get(String(el.dataset.card))||{},title=c.title||"";
  if(what==="select")return select(el.dataset.thread);
  if(what==="open-card")return select(el.dataset.thread,el.dataset.card);
  if(what==="start")return act({do:"todo-start",id:c.id});
  if(what==="reopen")return act({do:"todo-reopen",id:c.id});
  if(what==="done"){const r=await askText(`Done: #${c.id} ${title}`,"The outcome in one line (it's shown on the Done card), e.g. merged as PR 512");if(r)act({do:"todo-done",id:c.id,result:r.text})}
  if(what==="close-note")return act({do:"note-done",n:c.note});
  if(what==="dismiss")return act({do:"dismiss",id:String(c.id),sig:c.sig});
  if(what==="epic-next"){const name=title.split(":")[0].replace(/^Epic /,"");select("main");sendChat(`Start the next ready item of epic ${name} (lean-agent todo next --epic ${name}).`)}
  if(what==="run-stop"){if(confirm(`Stop run ${el.dataset.id}?`))act({do:"run-stop",run:el.dataset.id})}
  if(what==="sync")return doSync();
  if(what==="opt-run")return optRun(el.dataset.slug);
  if(what==="opt-apply"||what==="opt-accept"||what==="opt-reject"||what==="opt-undo")return sugRun(el.dataset.slug,el.dataset.id,what.slice(4));
  if(what==="opt-all-ask"){ui.sgConfirm=el.dataset.slug;return redraw()}
  if(what==="opt-all-no"){ui.sgConfirm=null;return redraw()}
  if(what==="opt-all-yes"){ui.sgConfirm=null;return sugApplyAll(el.dataset.slug)}
  if(what==="opt-ask")return sugAsk(el.dataset.slug);
  if(what==="clear-project"){$("bfilter").value="";$("bfilter").dispatchEvent(new Event("change"));return}
  if(what==="cause"){ui.open[el.dataset.cause]=!ui.open[el.dataset.cause];return drawLeft()}
  if(what==="done-toggle"){ui.doneOpen=!ui.doneOpen;return drawLeft()}
  if(what==="sheet")return openSheet("switch");
  if(what==="close-sheet")return closeSheet();
  if(what==="new-thread")return newThread();
  if(what==="move")return openSheet("move",el.dataset.mid,el.dataset.from);
  if(what==="move-to")return moveMessage(ui.sheet&&ui.sheet.mid,el.dataset.to);
  if(what==="badge")return toggleBadge(el.dataset.badge);
  if(what==="close-badge")return closeBadge();
  if(what==="runs-all"){ui.runsAll=!ui.runsAll;return drawSheet()}
  if(what==="theme"){setTheme({"":"light",light:"dark",dark:""}[themeNow]);return drawSheet()}
  if(what==="merge-open"){ui.merge={pick:null};return drawMerge()}
  if(what==="merge-cancel"){ui.merge=null;ui.picks=[];ui.target=null;if(ui.sheet&&ui.sheet.mode==="switch")openSheet("switch");return drawMerge()}
  if(what==="merge-change"){const p=pickTargets();ui.target=p[(p.indexOf(mergeTarget())+1)%p.length];$("mergesum").innerHTML=mergeSummaryHtml();return}
  if(what==="merge-go"){const m=mergeSummary();if(m)return mergeGo(m.ids,m.to);return}
  if(what==="merge-do")return mergeOpenGo();
  if(what==="unmerge")return unmergeThread(el.dataset.from);
  if(what==="edit"){const r=await askText(`Edit #${c.id}`,"The item's text",c.text);if(r&&r.text)act({do:"todo-edit",id:c.id,text:r.text})}
  if(what==="note-edit"){const r=await askText(`Edit note ${c.note}`,"The note's text",c.text);if(r&&r.text)act({do:"note-edit",n:c.note,text:r.text})}
  if(what==="add"){closeBadge();addItem()}
  if(what==="add-note"){closeBadge();addNote()}
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
  const a=e.target.closest("[data-act]");if(a){e.preventDefault();onAct(a);return}
  const run=e.target.closest("[data-run]");if(run){e.preventDefault();if(ui.badge)closeBadge();show(run.dataset.run);return}
  const tab=e.target.closest("[data-ltab]");if(tab)setTab(tab.dataset.ltab)
});
document.addEventListener("submit",e=>{
  const f=e.target.closest("form[data-ask]");if(!f)return;
  e.preventDefault();const i=f.querySelector("input"),v=i.value;i.value="";ask(v);
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeView();closeBadge()}});
document.addEventListener("change",e=>{
  const p=e.target.closest("[data-pick]");
  if(p){const on=new Set(ui.picks||[]);p.checked?on.add(p.dataset.pick):on.delete(p.dataset.pick);ui.picks=[...on];$("mergesum").innerHTML=mergeSummaryHtml();return}
  const m=e.target.closest("[data-merge-pick]");if(m&&ui.merge)ui.merge.pick=m.dataset.mergePick;
});
$("mproj").addEventListener("change",()=>{$("bfilter").value=$("mproj").value;$("bfilter").dispatchEvent(new Event("change"))});
$("bfilter").addEventListener("change",()=>{store.set("la-board-project",$("bfilter").value);$("mproj").value=$("bfilter").value;if(lastBoard){drawLeft();drawHeader();if(typeof drawChat==="function")drawChat()}});
window.matchMedia("(max-width:900px)").addEventListener("change",()=>{drawLeft()});
window.addEventListener("resize",()=>{if(S&&$("graph").open)drawPlan(S)});

async function load(){
  let s;try{const r=await fetch(`/api/state?t=${T}`);if(!r.ok)throw new Error(r.status);s=await r.json()}
  catch(e){ui.offline=ui.offline||Date.now();drawBanners();setStamp(`<span class="dot dot-bad" aria-hidden="true"></span>offline`,"can't reach lean-agent: is `lean-agent up` or `lean-agent dashboard` running?");return}
  if(s.page_version&&s.page_version!==V){location.reload();return}
  S=Object.assign(S||{},s);lastBoard=s.board;ui.offline=0;ui.lastOk=new Date();ui.now=s.now.slice(11,16);
  drawStamp();
  const f=$("bfilter"),cur=f.value||store.get("la-board-project","");
  f.innerHTML=$("mproj").innerHTML='<option value="">All projects</option>'+s.board.projects.map(p=>`<option${p===cur?" selected":""}>${esc(p)}</option>`).join("");
  $("mproj").value=f.value;
  const changed=changedSet(s.board.cards);sugPrune(s.board.cards);
  loadThreads();
  drawLeft(changed);drawHeader();drawBanners();if(typeof drawChat==="function")drawChat();drawBadges();drawPlanBox(s);
  if($("graph").open)drawPlan(s);
}
const inFallback=()=>typeof fallback==="function"&&fallback();  // chat.js loads after this file
function drawBanners(){  // connection state at the top of the center pane
  const svc=(typeof chat!=="undefined"&&chat.svc)||(S&&S.service)||null,at=ui.lastOk?ui.lastOk.toTimeString().slice(0,8):"";
  let h="";
  if(ui.offline)h=`<div class="banner warn" role="status">Dashboard reconnecting. Showing data from ${at}.</div>`;
  else if(inFallback())h=`<div class="banner warn" role="status">lean-agent service not running: each task has its own thread. Start it with <code>lean-agent up</code>.</div>`;
  else if(svc&&svc.up&&svc.remote_control===false)h=`<div class="banner" role="status">Remote Control is off: dashboard only. Messages typed here will not appear in the Claude app.</div>`;
  if(h!==ui.bannerHtml){ui.bannerHtml=h;$("banners").innerHTML=h}
  drawStamp();
}
function drawStamp(){  // the top-left dot: live, no service (the server's word) or offline (this page can't reach the server)
  if(ui.offline||!ui.now)return;
  const fb=inFallback();
  setStamp(`<span class="dot ${fb?"dot-warn":"dot-ok"}" aria-hidden="true"></span>${fb?"no service":"live "+ui.now}`,fb?"lean-agent service not running: each task has its own thread":"");
}
function setStamp(h,title){for(const id of ["stamp","mstamp"]){$(id).innerHTML=h;$(id).title=title}}
setTab(ui.tab);
load();setInterval(load,15000);
