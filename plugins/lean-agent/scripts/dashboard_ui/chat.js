// A thread with the orchestrator (dash_chat.py): one per task, plus "main". Messages, tool calls, permission prompts
// and Claude's multiple-choice questions, answered right here.
const chat={key:null,cursor:0,events:new Map(),status:"idle",alive:false,timer:null,choices:{}};
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
function permHtml(e){
  const open=e.state==="pending",settled={allowed:"allowed",always:"allowed (always)",answered:"answered",denied:"declined",expired:"no longer waiting (the conversation restarted)"}[e.state]||e.state;
  if(e.questions&&e.questions.length){  // Claude asks you to choose
    return `<div class="perm${open?"":" settled"}">${e.questions.map((q,qi)=>`<div><div class="who">${esc(q.header||"Question")}</div><div class="md"><p>${esc(q.question)}</p></div>
      ${open?`<div class="opts">${q.options.map((o,oi)=>`<button type="button" class="opt${oi===0?" primary":""}" data-act="choose" data-rid="${esc(e.rid)}" data-q="${qi}" data-o="${oi}">${esc(o.label)}${o.description?`<small>${esc(o.description)}</small>`:""}</button>`).join("")}</div>`
        :`<div class="mono mute small">${esc(e.answers&&e.answers[q.question]?"you chose: "+e.answers[q.question]:settled)}</div>`}</div>`).join("")}</div>`;
  }
  return `<div class="perm${open?"":" settled"}"><div class="who">Claude wants to use ${esc(e.name)}${e.description?`: ${esc(e.description)}`:""}</div><pre>${esc(e.text)}</pre>`
    +(open?`<div class="acts"><button type="button" class="btn sm primary" data-act="perm" data-rid="${esc(e.rid)}" data-allow="1">Allow</button>${e.can_always?`<button type="button" class="btn sm" data-act="perm" data-rid="${esc(e.rid)}" data-allow="1" data-always="1">Always allow</button>`:""}<button type="button" class="btn sm" data-act="perm" data-rid="${esc(e.rid)}" data-allow="0">Deny</button></div>`
      :`<div class="mono mute small">${esc(settled)}</div>`)+"</div>";
}
function drawChat(){
  const box=$("msgs"),atEnd=box.scrollHeight-box.scrollTop-box.clientHeight<80;
  const evs=[...chat.events.values()].sort((a,b)=>a.i-b.i);
  let h=typeof contextCard==="function"?contextCard():"",ai=null;  // consecutive replies and tool calls share one block
  const flush=()=>{if(ai){h+=`<div class="ai"><div class="av" aria-hidden="true">O</div><div class="body"><div class="who">Orchestrator · ${esc(hhmm(ai.ts))}</div>${ai.parts.join("")}</div></div>`;ai=null}};
  for(const e of evs){
    if(e.kind==="tool"&&e.name==="AskUserQuestion")continue;  // its question card says it all
    if(e.kind==="assistant"||e.kind==="tool"||e.kind==="permission"){
      ai=ai||{ts:e.ts,parts:[]};
      if(e.kind==="assistant")ai.parts.push(`<div class="md">${md(e.text)}</div>`);
      else if(e.kind==="tool")ai.parts.push(`<details class="tool"><summary><span class="dot ${e.state==="running"?"dot-run":e.state==="done"?"dot-ok":"dot-bad"}" aria-hidden="true"></span><b>${esc(e.name)}</b><span class="x">${esc(e.text)}</span></summary>${e.output?`<pre>${esc(e.output)}</pre>`:""}</details>`);
      else ai.parts.push(permHtml(e));
      continue;
    }
    flush();
    if(e.kind==="user")h+=`<div class="me"><div class="bub"><div class="who">You · ${esc(hhmm(e.ts))}</div><div class="md">${md(e.text)}</div></div></div>`;
    else if(e.kind==="result")h+=`<div class="sysl">${e.error?"stopped with an error":"done"}${e.seconds?" · "+e.seconds+" s":""}${e.cost!=null?" · $"+Number(e.cost).toFixed(2):""}</div>`;
    else h+=`<div class="sysl${e.kind==="error"?" bad":""}">${esc(e.text)}</div>`;
  }
  flush();
  if(!evs.length)h+=`<div class="sysl">${chat.key==="main"?"Talk to lean-agent here: ask for work, answer its questions, approve what it wants to run.":"This thread is about the task above; your first message brings that context along."}</div>`;
  const running=(typeof S!=="undefined"&&S&&S.running)||[];
  if(running.length)h+=`<div class="sysl"><span class="dot dot-run" aria-hidden="true"></span>Also running: ${running.map(r=>`${r.todo!=null?"#"+esc(r.todo):"lookup"} ${esc(String(r.task||"").split("\n")[0].slice(0,50))} · ${r.turns||0} turns`).join(" · ")}</div>`;
  box.innerHTML=h;
  if(atEnd)box.scrollTop=box.scrollHeight;
  const waiting=evs.some(e=>e.kind==="permission"&&e.state==="pending");
  $("cstat").textContent=waiting?"waits for you":chat.status==="working"?"working…":chat.alive?"ready":"idle";
  $("cstat").className="chip "+(waiting?"tone-warn":chat.status==="working"?"tone-run":"tone-mute");
  $("cstop").hidden=chat.status!=="working";
}
function openThread(key){
  if(chat.key===key)return drawChat();
  chat.key=key;chat.cursor=0;chat.events.clear();chat.status="idle";drawChat();pollChat();
}
async function pollChat(){
  clearTimeout(chat.timer);
  const key=chat.key;
  try{
    const r=await fetch(`/api/chat?thread=${encodeURIComponent(key)}&since=${chat.cursor}&t=${T}`);const s=await r.json();
    if(key!==chat.key)return;
    for(const e of s.events||[])chat.events.set(e.i,e);
    chat.cursor=Math.max(chat.cursor,s.cursor||0);chat.status=s.status;chat.alive=s.alive;
    if(typeof S!=="undefined"){S=S||{};S.threads=s.threads||[];if(lastBoard)drawInbox(new Set())}
    drawChat();
  }catch(e){$("cstat").textContent="offline"}
  const busy=chat.status==="working"||[...chat.events.values()].some(e=>e.kind==="permission"&&e.state==="pending")
    ||((S&&S.threads)||[]).some(t=>t.status==="working");
  chat.timer=setTimeout(pollChat,busy?1200:5000);
}
async function sendChat(text){
  text=String(text||"").trim();if(!text)return;
  const c=typeof selected==="function"?selected():null;
  const r=await post("/api/chat",{thread:chat.key,text,title:c?c.title:undefined,context:c&&typeof contextText==="function"?contextText(c):undefined});
  if(!r.ok)alert("Couldn't send: "+(r.error||"unknown error"));
  chat.status="working";drawChat();pollChat();
}
const TEMPLATES={run:"Start a worker for: ",review:"Review the branch ",todo:"Add to the work queue: ",handoff:"Keep this for later: "};
$("cmds").addEventListener("click",e=>{const b=e.target.closest("[data-cmd]");if(!b)return;const i=$("chatin");i.value=TEMPLATES[b.dataset.cmd]+i.value;i.focus()});
$("chatform").addEventListener("submit",e=>{e.preventDefault();const i=$("chatin");const v=i.value;i.value="";sendChat(v)});
$("chatin").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();$("chatform").requestSubmit()}});
$("cstop").addEventListener("click",()=>post("/api/chat/stop",{thread:chat.key}).then(pollChat));
$("cnew").addEventListener("click",()=>{if(confirm("Start this thread over? The old conversation stays in Claude Code's history."))post("/api/chat/new",{thread:chat.key}).then(()=>{chat.events.clear();chat.cursor=0;pollChat()})});
document.addEventListener("click",e=>{
  const p=e.target.closest('[data-act="perm"]');
  if(p){e.preventDefault();e.stopPropagation();post("/api/chat/answer",{thread:chat.key,rid:p.dataset.rid,allow:p.dataset.allow==="1",always:p.dataset.always==="1"}).then(pollChat);return}
  const o=e.target.closest('[data-act="choose"]');
  if(o){e.preventDefault();e.stopPropagation();
    const ev=[...chat.events.values()].find(x=>x.rid===o.dataset.rid);if(!ev)return;
    const q=ev.questions[+o.dataset.q];const answers=chat.choices[o.dataset.rid]=chat.choices[o.dataset.rid]||{};
    answers[q.question]=q.options[+o.dataset.o].label;
    for(const b of document.querySelectorAll(`[data-act="choose"][data-rid="${CSS.escape(o.dataset.rid)}"][data-q="${o.dataset.q}"]`))b.classList.toggle("primary",b===o);
    if(Object.keys(answers).length>=ev.questions.length)post("/api/chat/answer",{thread:chat.key,rid:o.dataset.rid,allow:true,answers}).then(pollChat)}
},true);
openThread(ui.sel);
