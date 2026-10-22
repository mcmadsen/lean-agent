// A thread with the orchestrator (dash_chat.py): one per task, plus "main". Messages, tool calls, permission prompts
// and Claude's multiple-choice questions, answered right here.
const chat={sentAt:0,key:null,cursor:0,events:new Map(),status:"idle",alive:false,timer:null,choices:{},drafts:{},svc:null,skew:0,workStart:0,confirm:false,html:""};
// a little Markdown: code blocks, inline code, bold, links, lists, paragraphs (after escaping everything)
function md(text){
  const parts=String(text||"").split(/```[\w-]*\n?/);
  return parts.map((p,i)=>{
    if(i%2)return `<pre>${esc(p.replace(/\n$/,""))}</pre>`;
    let h=esc(p).replace(/`([^`\n]+)`/g,"<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g,"<b>$1</b>")
      .replace(/(https?:\/\/[^\s<)]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');
    h=h.replace(/(^|\n)((?:[-*] .*(?:\n|$))+)/g,(m,a,list)=>a+"<ul>"+list.trim().split("\n").map(l=>`<li>${l.replace(/^[-*] /,"")}</li>`).join("")+"</ul>");
    return h.split(/\n{2,}/).map(x=>x.trim()?`<p>${x.replace(/\n/g,"<br>")}</p>`:"").join("");
  }).join("");
}
const hhmm=ts=>String(ts||"").slice(11,16);
const svcNow=()=>chat.svc||(typeof S!=="undefined"&&S&&S.service)||null;
const fallback=()=>{const v=svcNow();return !!(v&&!v.up)};  // the server says no service: each task has its own thread (not the page's reconnecting state)
const appName=()=>rcState()==="off"?"terminal":"Claude app";
const rcState=()=>{const v=svcNow();return v&&v.up?(v.remote_control===true?"on":v.remote_control===false?"off":"unknown"):"unknown"};
const aboutChip=key=>`<span class="chip tone-run">About ${esc(aboutLabel(key))}</span>`;
const aboutOf=e=>chat.key==="main"&&e.about?aboutChip(e.about):"";  // a task's own thread says it in the header
const WANTS={Bash:"run a command",Read:"read a file",Glob:"read a file",Grep:"read a file",NotebookRead:"read a file",Edit:"edit a file",MultiEdit:"edit a file",Write:"edit a file",NotebookEdit:"edit a file"};
const wants=n=>"The orchestrator wants to "+(WANTS[n]||"use "+esc(n));
const answeredIn=e=>`Answered in the ${e.where==="app"?"Claude app":"dashboard"} · ${hhmm(e.answered_at||e.ts)}`;
function questionHtml(e){
  const open=e.state==="pending",n=e.questions.length,ch=chat.choices[e.rid]||{};
  const hd=`<div class="hd"><span class="chip ${open?"tone-warn":e.state==="denied"?"tone-mute":"tone-ok"}">${open?"question":e.state==="denied"?"skipped":"answered"}</span>${aboutOf(e)}<span class="mono mute small">${n} question${n>1?"s":""}${open&&chat.service?" · also answerable in the Claude app":""}</span></div>`;
  if(!open)return `<div class="perm settled" role="group" aria-label="Question from the orchestrator">${hd}${e.questions.map(q=>`<div class="small"><span class="mute">${esc(q.question)}</span> ${e.answers&&e.answers[q.question]?`<b>${esc(e.answers[q.question])}</b>`:""}</div>`).join("")}<div class="mono mute small">${e.state==="expired"?"No longer waiting":esc(answeredIn(e))}</div></div>`;
  const qs=e.questions.map((q,qi)=>`<fieldset class="qf"><legend>${esc(q.header?q.header+": ":"")}${esc(q.question)}${q.multi?' <span class="mute">Pick any</span>':""}</legend>`
    +q.options.map((o,oi)=>{const id=`q-${e.rid}-${qi}-${oi}`;
      return `<label class="optl" for="${esc(id)}"><input type="${q.multi?"checkbox":"radio"}" name="q-${esc(e.rid)}-${qi}" id="${esc(id)}" data-rid="${esc(e.rid)}" data-q="${qi}" data-o="${oi}"${(ch[qi]||[]).includes(oi)?" checked":""}><span>${esc(o.label)}${o.description?`<small>${esc(o.description)}</small>`:""}</span></label>`}).join("")+"</fieldset>").join("");
  const done=e.questions.every((q,qi)=>(ch[qi]||[]).length);
  return `<div class="perm" role="group" aria-label="Question from the orchestrator">${hd}${qs}<div class="acts"><button type="button" class="btn primary" data-act="answers" data-rid="${esc(e.rid)}"${done?"":" disabled"}>Send answers</button><button type="button" class="btn" data-act="skip" data-rid="${esc(e.rid)}">Skip</button></div></div>`;
}
function permHtml(e){
  if(e.questions&&e.questions.length)return questionHtml(e);
  const label=`Permission request: ${e.name}`;
  if(e.state==="pending"){
    const rid=esc(e.rid),b=(extra,cls,t,title)=>`<button type="button" class="btn ${cls}" data-act="perm" data-rid="${rid}" ${extra}${title?` title="${esc(title)}"`:""}>${t}</button>`;
    const rule=(e.always_rule||[]).map(r=>`<code>${esc(r)}</code>`).join(", "),always=e.can_always&&rule;  // only with a rule Claude Code suggested
    return `<div class="perm" role="group" aria-label="${esc(label)}"><div class="hd"><span class="chip tone-warn">permission</span>${aboutOf(e)}${e.deadline?`<span class="mono mute small" data-deadline="${e.deadline}" data-wait="${e.wait||300}"></span>`:""}</div>${e.deadline?`<div class="pbar" aria-hidden="true"><i></i></div>`:""}`
      +`<div class="pl">${wants(e.name)}</div><pre>${esc(e.text)}</pre>${e.description?`<div class="small mute">${esc(e.description)}</div>`:""}`
      +`<div class="acts">${b('data-allow="1"',"primary","Allow")}${always?b('data-allow="1" data-always="1"',"","Always allow"):""}${b('data-allow="0"',"","Deny")}</div>`
      +(always?`<div class="small mute">Always allow adds the rule ${rule}</div>`:"")+"</div>";
  }
  if(e.state==="in_app")return `<div class="perm warn" role="group" aria-label="${esc(label)}"><div class="hd"><span class="chip tone-warn">waiting in the ${appName()}</span>${aboutOf(e)}</div><div class="pl">The dashboard did not answer in time. Now waiting in the ${appName()}.</div><pre>${esc(e.name)}: ${esc(e.text)}</pre></div>`;
  const ok=/^(allowed|always|answered)$/.test(e.state),word=e.state==="always"?"allowed":e.state==="denied"?"denied":e.state==="expired"?"expired":e.state;
  return `<div class="perm settled compact" role="group" aria-label="${esc(label)}"><span class="chip ${ok?"tone-ok":e.state==="denied"?"tone-bad":"tone-mute"}">${esc(word)}</span>${aboutOf(e)}<span class="mono small perm-t">${esc(e.name)} · ${esc(e.text)}</span><span class="mono mute small">${e.state==="expired"?"No longer waiting (the conversation restarted)":esc(answeredIn(e))}</span></div>`;
}
const secs=t=>(Date.now()-Date.parse(t))/1000;
function drawChat(){
  const box=$("msgs"),atEnd=box.scrollHeight-box.scrollTop-box.clientHeight<80;
  const evs=[...chat.events.values()].sort((a,b)=>a.i-b.i);
  let h=typeof contextCard==="function"?contextCard():"",ai=null;  // consecutive replies and tool calls share one block
  const flush=()=>{if(ai){h+=`<div class="ai"><div class="av" aria-hidden="true">O</div><div class="body"><div class="who">Orchestrator · ${esc(hhmm(ai.ts))}${ai.about?" "+aboutChip(ai.about):""}</div>${ai.parts.join("")}</div></div>`;ai=null}};
  for(const e of evs){
    if(e.kind==="tool"&&e.name==="AskUserQuestion")continue;  // its question card says it all
    if(e.kind==="assistant"||e.kind==="tool"||e.kind==="permission"){
      const card=e.kind==="permission"&&(e.state==="pending"||e.state==="in_app"||(e.questions&&e.questions.length));
      if(card)flush();
      if(!card)ai=ai||{ts:e.ts,parts:[],about:chat.key==="main"?e.about:null};
      if(e.kind==="assistant")ai.parts.push(`<div class="md">${md(e.text)}</div>`);
      else if(e.kind==="tool")ai.parts.push(`<details class="tool"><summary><span class="dot ${e.state==="running"?"dot-run":e.state==="done"?"dot-ok":"dot-bad"}" aria-hidden="true"></span><b>${esc(e.name)}</b><span class="x">${esc(e.text)}</span></summary>${e.output?`<pre>${esc(e.output)}</pre>`:""}</details>`);
      else if(card)h+=permHtml(e);
      else ai.parts.push(permHtml(e));
      continue;
    }
    flush();
    if(e.kind==="user")h+=`<div class="me"><div class="bub"><div class="who">You · ${esc(hhmm(e.ts))}${aboutOf(e)}${e.from_app&&chat.service&&!fallback()?` <span class="chip tone-mute">${rcState()==="off"?"from the terminal":"from the app"}</span>`:""}</div><div class="md">${md(e.text)}</div></div></div>`;
    else if(e.kind==="result")h+=`<div class="sysl">${e.error?"stopped with an error":"done"}${e.seconds?" · "+e.seconds+" s":""}${e.cost!=null?" · $"+Number(e.cost).toFixed(2):""}</div>`;
    else h+=`<div class="sysl${e.kind==="error"?" bad":""}">${esc(e.text)}</div>`;
  }
  flush();
  if(!evs.length)h+=`<div class="sysl">${chat.key==="main"?"Talk to lean-agent here: ask for work, answer its questions, approve what it wants to run.":"This thread is about the task above; your first message brings that context along."}</div>`;
  for(const r of ((typeof S!=="undefined"&&S&&S.running)||[]).filter(r=>chat.key==="main"||String(r.todo)===String(chat.key)))  // one compact line per running worker
    h+=`<div class="wline"><span class="dot dot-run" aria-hidden="true"></span><span class="mono">running · ${r.todo!=null?"#"+esc(r.todo):"lookup"} · ${esc(r.model||"?")} / ${esc(r.effort||"default")} · ${r.turns||0} turns · ${dur(secs(r.started)||0)}</span><button type="button" class="btn sm" data-act="run-stop" data-id="${esc(r.run)}" aria-label="Stop run ${esc(r.run)}">Stop run</button></div>`;
  if(h!==chat.html){  // redraw only when something changed, keeping the focus and caret of a form in the stream
    const a=document.activeElement,fid=a&&box.contains(a)?a.id:"",sel=a&&a.selectionStart!=null?[a.selectionStart,a.selectionEnd]:null;
    chat.html=h;box.innerHTML=h;
    const f=fid&&document.getElementById(fid);if(f){f.focus();if(sel&&f.setSelectionRange)try{f.setSelectionRange(sel[0],sel[1])}catch(e){}}
    if(atEnd)box.scrollTop=box.scrollHeight;
  }
  const waiting=evs.some(e=>e.kind==="permission"&&e.state==="pending");
  const np=evs.filter(e=>e.kind==="permission"&&e.state==="pending").length;  // the phone's Chat tab shows it while another tab is open
  $("m-chat").textContent=np||"";$("m-chat").title=np?`${np} waiting for you in Chat`:"";
  $("cstat").textContent=waiting?"waits for you":chat.status==="working"?"working…":chat.alive?"ready":"idle";
  $("cstat").className="chip "+(waiting?"tone-warn":chat.status==="working"?"tone-run":"tone-mute");
  drawWorking();drawClear();
  if(typeof drawHeader==="function"&&chat.headSig!==chat.service+"|"+rcState()+"|"+fallback()){chat.headSig=chat.service+"|"+rcState()+"|"+fallback();drawHeader();if(S&&S.plan)drawPlanBox(S)}
  if(typeof drawBanners==="function")drawBanners();
  tick();
}
function drawWorking(){
  const w=$("working"),on=chat.status==="working";
  w.hidden=!on;
  if(!on){chat.workStart=0;w.innerHTML="";return}
  if(!chat.workStart){const u=[...chat.events.values()].filter(e=>e.kind==="user").pop(),t=u?Date.parse(u.ts):NaN;chat.workStart=Date.now()-t<36e5&&Date.now()>=t?t:Date.now()}
  if(!w.firstChild)w.innerHTML=`<span class="dot dot-run" aria-hidden="true"></span><span>Orchestrator is working</span><span class="mono mute" aria-hidden="true">· <span data-since="${chat.workStart}"></span></span><span class="hspace"></span><button type="button" class="btn sm" data-act="interrupt">Interrupt</button>`;
  else w.querySelector("[data-since]").dataset.since=chat.workStart;
}
function drawClear(){
  const b=$("clearbox"),task=typeof taskLabel==="function"?taskLabel():"";
  const fb=fallback();
  $("cnew").textContent=fb?"Clear thread…":chat.service?"Clear session…":"New thread";
  if(!chat.confirm){b.hidden=true;b.innerHTML="";return}
  if(b.firstChild)return;
  b.hidden=false;
  b.innerHTML=`<div class="clearbox" role="alert"><span>${fb?`Clear this thread? Only ${chat.key==="main"?"the orchestrator":"this task's"} thread is cleared; nothing else is touched.`:chat.service?`Clear the whole session? This clears the conversation in the dashboard, the Claude app and the terminal${task?", not only "+esc(task):""}.`:"Start this thread over? The old conversation stays in Claude Code's history."}</span><span class="acts"><button type="button" class="btn sm danger" data-act="clear-yes">${fb?"Clear thread":chat.service?"Clear session":"Start over"}</button><button type="button" class="btn sm" data-act="clear-no" id="clear-no">Cancel</button></span></div>`;
  $("clear-no").focus();
}
function tick(){
  const now=Date.now();
  for(const el of document.querySelectorAll("[data-since]")){const s=Math.max(0,Math.round((now-el.dataset.since)/1000));el.textContent=dur(s)}
  for(const el of document.querySelectorAll("[data-deadline]")){  // the server's deadline on the server's clock; "waiting in the app" only when the server says so
    const left=el.dataset.deadline-(now-(chat.skew||0))/1000,s=Math.max(0,Math.ceil(left)),bar=el.closest(".perm").querySelector(".pbar i");
    el.textContent=left>0?`Moves to the ${appName()} in ${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`:`moving to the ${appName()}…`;
    if(bar)bar.style.width=Math.max(0,Math.min(100,left/el.dataset.wait*100))+"%"}
}
setInterval(tick,1000);
function openThread(key){
  if(chat.key===key)return drawChat();
  chat.key=key;chat.cursor=0;chat.events.clear();chat.status="idle";chat.html="";chat.confirm=false;chat.workStart=0;drawChat();pollChat();
}
async function pollChat(){
  clearTimeout(chat.timer);
  const key=chat.key;
  try{
    const r=await fetch(`/api/chat?thread=${encodeURIComponent(key)}&since=${chat.cursor}&t=${T}`);const s=await r.json();
    if(key!==chat.key)return;
    ui.offline=0;ui.lastOk=new Date();
    for(const e of s.events||[])chat.events.set(e.i,e);
    chat.cursor=Math.max(chat.cursor,s.cursor||0);chat.status=s.status;chat.alive=s.alive;chat.service=!!s.service;chat.svc=s.service_status||chat.svc;
    if(s.now)chat.skew=Date.now()-s.now*1000;
    chat.workStart=s.work_since?s.work_since*1000+(chat.skew||0):0;
    if(typeof S!=="undefined"){S=S||{};S.threads=s.threads||[];if(lastBoard)drawInbox(new Set())}
    drawChat();
  }catch(e){ui.offline=ui.offline||Date.now();$("cstat").textContent="offline";if(typeof drawBanners==="function")drawBanners()}
  const busy=chat.status==="working"||Date.now()-chat.sentAt<15000||[...chat.events.values()].some(e=>e.kind==="permission"&&e.state==="pending")
    ||((S&&S.threads)||[]).some(t=>t.status==="working");
  chat.timer=setTimeout(pollChat,busy?1200:5000);
}
async function sendChat(text){
  text=String(text||"").trim();if(!text)return;
  const c=typeof selected==="function"?selected():null;
  const r=await post("/api/chat",{thread:chat.key,text,title:c?c.title:undefined,context:c&&typeof contextText==="function"?contextText(c):undefined});
  if(!r.ok)alert("Couldn't send: "+(r.error||"unknown error"));
  chat.sentAt=Date.now();pollChat();  // "working" comes from the server, which knows when it is sure
}
const TEMPLATES={run:"Start a worker for: ",review:"Review the branch ",todo:"Add to the work queue: ",handoff:"Keep this for later: "};
$("cmds").addEventListener("click",e=>{const b=e.target.closest("[data-cmd]");if(!b)return;const i=$("chatin");i.value=TEMPLATES[b.dataset.cmd]+i.value;i.focus()});
$("chatform").addEventListener("submit",e=>{e.preventDefault();const i=$("chatin");const v=i.value;i.value="";sendChat(v)});
$("chatin").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();$("chatform").requestSubmit()}});
const evOf=rid=>[...chat.events.values()].find(x=>x.rid===rid);
const refresh=()=>{chat.html="";return pollChat()};
document.addEventListener("click",e=>{
  const a=e.target.closest("[data-act]");if(!a)return;
  const act=a.dataset.act,done=()=>{e.preventDefault();e.stopPropagation()};
  if(act==="perm"){done();post("/api/chat/answer",{thread:chat.key,rid:a.dataset.rid,allow:a.dataset.allow==="1",always:a.dataset.always==="1"}).then(pollChat)}
  else if(act==="answers"){done();const ev=evOf(a.dataset.rid),ch=chat.choices[a.dataset.rid]||{};if(!ev)return;
    const answers={};ev.questions.forEach((q,qi)=>{answers[q.question]=(ch[qi]||[]).map(i=>q.options[i].label).join(", ")});  // several picks: the labels joined by ", "
    post("/api/chat/answer",{thread:chat.key,rid:a.dataset.rid,allow:true,answers}).then(pollChat)}
  else if(act==="skip"){done();post("/api/chat/answer",{thread:chat.key,rid:a.dataset.rid,allow:false,message:"skipped"}).then(pollChat)}
  else if(act==="interrupt"){done();post("/api/chat/stop",{thread:chat.key}).then(pollChat)}
  else if(act==="clear-ask"){done();chat.confirm=true;drawClear()}
  else if(act==="clear-no"){done();chat.confirm=false;drawClear();$("cnew").focus()}
  else if(act==="clear-yes"){done();chat.confirm=false;drawClear();
    post("/api/chat/new",{thread:chat.service?"main":chat.key}).then(()=>{chat.events.clear();chat.cursor=0;refresh()})}  // one session: main clears it everywhere
  else if(act==="note-decide"){done();const c=selected(),i=$("dec-"+(c&&c.note));const v=i?i.value.trim():"";if(!v){if(i)i.focus();return}
    chat.drafts[c.note]="";sendChat(`Decision for hand-off note ${c.note} ("${c.text.replace(/"/g,"'")}"): ${v}`)}
},true);
document.addEventListener("change",e=>{
  const i=e.target.closest("input[data-rid]");if(!i)return;
  const ev=evOf(i.dataset.rid);if(!ev)return;
  const ch=chat.choices[i.dataset.rid]=chat.choices[i.dataset.rid]||{},qi=+i.dataset.q,oi=+i.dataset.o;
  if(ev.questions[qi].multi){const cur=new Set(ch[qi]||[]);i.checked?cur.add(oi):cur.delete(oi);ch[qi]=[...cur].sort((a,b)=>a-b)}else ch[qi]=[oi];
  const b=document.querySelector(`[data-act="answers"][data-rid="${CSS.escape(i.dataset.rid)}"]`);  // updated in place: no redraw under the user's hands
  if(b)b.disabled=!ev.questions.every((q,n)=>(ch[n]||[]).length);
  chat.html="";
});
document.addEventListener("input",e=>{const i=e.target.closest("[data-draft]");if(i){chat.drafts[i.dataset.draft]=i.value;chat.html=""}});
openThread(ui.sel);
