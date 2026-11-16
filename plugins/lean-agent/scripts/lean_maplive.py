"""The live map over a loopback WebSocket: read-only, token-gated, idle = zero work (snapshots are computed only while a page
is connected, at most every INTERVAL s, pushed only when their shape changed). Plus the self-contained page (`map --html`)."""
import base64
import collections
import hashlib
import hmac
import json
import os
import queue
import secrets
import select
import socket
import struct
import threading
import time
import urllib.parse

import lean_map

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_CLIENTS = 8
INTERVAL = 2.0
QUEUE_MAX = 32
MAX_FRAME = 1 << 16
HANDSHAKE_S = 5.0
POLL_S = 10.0  # a page that polled this recently counts as watching
PING_S = 25.0
FILE = "map-live.json"


def live_path(home):
    return os.path.join(home, FILE)


def event_nodes(op, req):
    """(from, to) node ids for a socket request, or None when the caller/target is unknown."""
    tid = str(req.get("thread") or "") if isinstance(req, dict) else ""
    if op in ("send", "wake") and tid:
        return "main", tid
    if op == "pending":
        return (tid, "service") if tid else ("main", "service")
    if op in ("map", "ping"):
        return None
    return "main", "service"


def _sha(snap):
    return hashlib.sha256(lean_map.signature(snap).encode()).hexdigest()


def frame(payload, op=1):
    b = payload if isinstance(payload, bytes) else payload.encode()
    n = len(b)
    head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else b"\x7e" + struct.pack(">H", n) if n < 65536 else b"\x7f" + struct.pack(">Q", n))
    return head + b


def parse_frames(buf):
    """-> (list of (opcode, payload), rest). Raises ValueError on an oversized or unmasked frame."""
    out = []
    while len(buf) >= 2:
        op, ln = buf[0] & 0x0F, buf[1] & 0x7F
        masked = buf[1] & 0x80
        i = 2
        if ln == 126:
            if len(buf) < 4:
                break
            ln, i = struct.unpack(">H", buf[2:4])[0], 4
        elif ln == 127:
            if len(buf) < 10:
                break
            ln, i = struct.unpack(">Q", buf[2:10])[0], 10
        if ln > MAX_FRAME or not masked:
            raise ValueError("bad frame")
        if len(buf) < i + 4 + ln:
            break
        key = buf[i:i + 4]
        data = bytes(b ^ key[j % 4] for j, b in enumerate(buf[i + 4:i + 4 + ln]))
        out.append((op, data))
        buf = buf[i + 4 + ln:]
    return out, buf


class Live:
    def __init__(self, snapshot, home, interval=INTERVAL, max_clients=MAX_CLIENTS):
        self.snapshot = snapshot
        self.home = home
        self.interval = interval
        self.max_clients = max_clients
        self.token = secrets.token_urlsafe(24)
        self.port = None
        self.lsock = None
        self.lock = threading.Lock()
        self.clients = []
        self.last = None  # (hash, message)
        self.wake = threading.Event()
        self.cache = None  # (monotonic, snapshot)
        self.svg_cache = {}  # (w, h, mini) -> (monotonic, svg)
        self.last_poll = 0.0
        self.stopped = threading.Event()

    def start(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 0))
        s.listen(16)
        s.settimeout(0.5)
        self.lsock, self.port = s, s.getsockname()[1]
        os.makedirs(self.home, exist_ok=True)
        p = live_path(self.home)
        tmp = p + f".{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump({"port": self.port, "token": self.token, "pid": os.getpid()}, fh)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
        threading.Thread(target=self._accept, daemon=True).start()
        threading.Thread(target=self._loop, daemon=True).start()
        return self

    def stop(self):
        self.stopped.set()
        self.wake.set()
        try:
            self.lsock.close()
        except Exception:
            pass
        with self.lock:
            for c in self.clients:
                c["q"].put(None) if not c["q"].full() else None
        try:
            os.unlink(live_path(self.home))
        except OSError:
            pass

    def get_snap(self):
        """The snapshot, computed at most every `interval` s however many clients ask; only ever called on demand."""
        with self.lock:
            c = self.cache
            if c and time.monotonic() - c[0] < self.interval * 0.9:
                return c[1]
        snap = self.snapshot()
        with self.lock:
            self.cache = (time.monotonic(), snap)
            self.svg_cache = {}
        return snap

    def get_svg(self, w, h, mini):
        key = (w, h, mini)
        snap = self.get_snap()
        with self.lock:
            c = self.svg_cache.get(key)
            if c and time.monotonic() - c[0] < self.interval:
                return c[1]
        out = lean_map.svg(snap, w, h, mini=mini)
        with self.lock:
            self.svg_cache[key] = (time.monotonic(), out)
        return out

    def watching(self):
        return bool(self.clients) or time.monotonic() - self.last_poll < POLL_S

    def _reply(self, conn, code, text, body=b"", ctype="text/plain; charset=utf-8", cors=False):
        head = [f"HTTP/1.1 {code} {text}", f"Content-Type: {ctype}", f"Content-Length: {len(body)}", "Connection: close",
                "Cache-Control: no-store", "Referrer-Policy: no-referrer", "X-Content-Type-Options: nosniff"]
        if cors:
            head.append("Access-Control-Allow-Origin: *")
        try:
            conn.sendall(("\r\n".join(head) + "\r\n\r\n").encode() + body)
        except OSError:
            pass

    def _route(self, conn, path, q):
        """Plain GET routes (token already checked): / (the page), /snap (JSON), /map.svg (the drawing)."""
        try:
            if path == "/snap":
                self.last_poll = time.monotonic()
                return self._reply(conn, 200, "OK", json.dumps(self.get_snap()).encode(), "application/json", cors=True)
            if path == "/map.svg":
                self.last_poll = time.monotonic()
                def dim(k, d):
                    try:
                        return max(100, min(2000, int((q.get(k) or [d])[0])))
                    except ValueError:
                        return d
                svg = self.get_svg(dim("w", 900), dim("h", 700), (q.get("mini") or ["0"])[0] == "1")
                return self._reply(conn, 200, "OK", svg.encode(), "image/svg+xml", cors=True)
            if path == "/":
                page = build_html(self.get_snap(), {"port": self.port, "token": self.token})
                return self._reply(conn, 200, "OK", page.encode(), "text/html; charset=utf-8")
            self._reply(conn, 404, "Not Found")
        except Exception:
            self._reply(conn, 500, "Error")

    # -- fan-out -------------------------------------------------------------------------------------------------------
    def _broadcast(self, msg):
        with self.lock:
            for c in self.clients:
                try:
                    c["q"].put_nowait(msg)
                except queue.Full:
                    pass  # a stuck page loses updates, never blocks the service

    def on_request(self, op, req):
        """Called by the service socket per request; cheap and never raises."""
        if not self.clients:
            return
        try:
            ft = event_nodes(op, req)
            if ft:
                self._broadcast(json.dumps({"type": "event", "from": ft[0], "to": ft[1], "op": str(op), "ts": time.time()}))
        except Exception:
            pass

    def _loop(self):
        while not self.stopped.is_set():
            if not self.clients:
                with self.lock:
                    self.last = None
                self.wake.wait()
                self.wake.clear()
                continue
            try:
                snap = self.get_snap()
                h = _sha(snap)
                if not self.last or self.last[0] != h:
                    msg = json.dumps({"type": "snapshot", **snap})
                    self.last = (h, msg)
                    self._broadcast(msg)
            except Exception:
                pass
            if self.stopped.wait(self.interval):
                break

    # -- connections ---------------------------------------------------------------------------------------------------
    def _accept(self):
        while not self.stopped.is_set():
            try:
                conn, _ = self.lsock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _handshake(self, conn, box):
        conn.settimeout(HANDSHAKE_S)
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < 8192:
            d = conn.recv(2048)
            if not d:
                return None
            buf += d
        head = buf.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
        parts = head[0].split(" ")
        if len(parts) != 3 or parts[0] != "GET":
            self._http(conn, 405, "Method Not Allowed")
            return None
        hdr = {}
        for ln in head[1:]:
            k, _, v = ln.partition(":")
            hdr[k.strip().lower()] = v.strip()
        u = urllib.parse.urlsplit(parts[1])
        tok = (urllib.parse.parse_qs(u.query).get("t") or [""])[0]
        if not hmac.compare_digest(tok.encode(), self.token.encode()):
            self._http(conn, 403, "Forbidden")
            return None
        key = hdr.get("sec-websocket-key")
        if hdr.get("upgrade", "").lower() != "websocket":
            self._route(conn, u.path or "/", urllib.parse.parse_qs(u.query))
            return None
        if "upgrade" not in hdr.get("connection", "").lower() or not key or hdr.get("sec-websocket-version") != "13":
            self._http(conn, 400, "Bad Request")
            return None
        with self.lock:
            if len(self.clients) >= self.max_clients:
                self._http(conn, 503, "Busy")
                return None
            box["c"] = {"q": queue.Queue(QUEUE_MAX)}
            self.clients.append(box["c"])
            if self.last:
                box["c"]["q"].put_nowait(self.last[1])
        acc = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
        conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {acc}\r\n\r\n").encode())
        return buf.split(b"\r\n\r\n", 1)[1]

    @staticmethod
    def _http(conn, code, text):
        try:
            conn.sendall(f"HTTP/1.1 {code} {text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
        except OSError:
            pass

    def _serve(self, conn):
        box = {}
        try:
            rest = self._handshake(conn, box)
            if rest is None:
                return
            c = box["c"]
            self.wake.set()
            conn.settimeout(5)
            buf, lastping = rest, time.monotonic()
            while not self.stopped.is_set():
                while True:
                    try:
                        m = c["q"].get_nowait()
                    except queue.Empty:
                        break
                    if m is None:
                        return
                    conn.sendall(frame(m))
                if time.monotonic() - lastping > PING_S:
                    conn.sendall(frame(b"", 9))
                    lastping = time.monotonic()
                if not buf and not select.select([conn], [], [], 0.25)[0]:
                    continue
                if not buf:
                    d = conn.recv(4096)
                    if not d:
                        return
                    buf = d
                frames, buf = parse_frames(buf)
                for op, data in frames:
                    if op == 8:
                        conn.sendall(frame(data[:2], 8))
                        return
                    if op == 9:
                        conn.sendall(frame(data, 10))
                    # text/binary from the page is ignored: read-only
        except (OSError, ValueError):
            pass
        finally:
            c = box.get("c")
            if c:
                with self.lock:
                    if c in self.clients:
                        self.clients.remove(c)
            try:
                conn.close()
            except OSError:
                pass


def endpoint(home):
    """{port, token, pid} of the running endpoint, or None."""
    try:
        with open(live_path(home)) as fh:
            d = json.load(fh)
        return d if isinstance(d.get("port"), int) and d.get("token") else None
    except (OSError, ValueError, AttributeError):
        return None


def is_up(home, timeout=0.5):
    d = endpoint(home)
    if not d:
        return False
    try:
        socket.create_connection(("127.0.0.1", d["port"]), timeout=timeout).close()
        return True
    except OSError:
        return False


# -- the page ----------------------------------------------------------------------------------------------------------------
CSS = """
:root{--bg:#F6F7F9;--card:#fff;--bd:#CBD2DC;--tx:#1B2230;--mu:#667085;--ok:#1B9E92;--rep:#C9821A;--req:#4A72D8;--bad:#D6453B;--idle:#98A2B3}
@media(prefers-color-scheme:dark){:root{--bg:#0F1217;--card:#1A1F27;--bd:#2A313C;--tx:#E6E9EF;--mu:#9AA3B2;--ok:#2EC4B6;--rep:#F2A541;--req:#7AA2F7;--bad:#F07167;--idle:#5B6475}}
html,body{margin:0;background:var(--bg);color:var(--tx);font:13px system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;align-items:center;gap:8px;padding:8px 10px;flex-wrap:wrap}
h1{font-size:14px;margin:0;flex:1}
#chip{border:1px solid var(--bd);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--mu)}
#chip.live{color:var(--ok);border-color:var(--ok)}#chip.re{color:var(--rep);border-color:var(--rep)}#chip.bad{color:var(--bad);border-color:var(--bad)}
#why{padding:0 10px 4px;color:var(--mu);font-size:11px}#why a{color:var(--req)}
#meta{padding:0 10px;color:var(--mu);font-size:12px}
#map{width:100%;max-width:640px;margin:0 auto;display:block}
svg{width:100%;height:auto;display:block}
text{fill:var(--tx);font-family:system-ui,sans-serif}.mu{fill:var(--mu)}
"""

JS = r"""
(function(){
var SNAP=JSON.parse(document.getElementById('snap').textContent),EP=JSON.parse(document.getElementById('ep').textContent);
var COL={message:'--ok',report:'--rep',request:'--req',idle:'--idle',bad:'--bad'};
var W=580,H=640,CX=W/2,CY=H/2,pulses=[],pos={},raf=0,ws=null,delay=1000,gotLive=false,stopped=false,fails=0;
var mode='',viol=[],codes=[],base=EP&&EP.port?'http://127.0.0.1:'+EP.port:'',tq=EP&&EP.token?'t='+encodeURIComponent(EP.token):'';
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function clip(s,n){s=String(s||'');return s.length>n?s.slice(0,n-1)+'…':s}
function chip(t,c){var e=$('chip');e.textContent=t;e.className=c||''}
function why(html){$('why').innerHTML=html||''}
function reason(){
  var p=[];if(viol.length)p.push('blocked by the preview: '+viol.map(esc).join(', '));
  if(codes.length)p.push(codes.map(esc).join(', '));return p.join(' · ')}
document.addEventListener('securitypolicyviolation',function(e){
  var u=String(e.blockedURI||'').split('?')[0];viol.push((e.violatedDirective||'?')+(u?' ('+u+')':''));if(viol.length>6)viol.shift();
  if(!mode)why(reason())});
function placedSet(s){var o={};(Array.isArray(s.placed)?s.placed:[]).forEach(function(i){o[i]=1});return o}
function layout(s){
  var p={},ns=s.nodes||[],ok=placedSet(s),th=ns.filter(function(n){return n.kind==='thread'&&ok[n.id]});
  th.sort(function(a,b){return a.id.length-b.id.length||(a.id<b.id?-1:a.id>b.id?1:0)});
  p.main=[CX,CY-16,104,30];p.service=[CX,CY+30,116,24];p.hooks=[CX-170,H-24,64,22];
  th.forEach(function(n,i){var a=-Math.PI/2+2*Math.PI*i/Math.max(1,th.length);n._a=a;p[n.id]=[CX+Math.cos(a)*170,CY+Math.sin(a)*205,92,30]});
  var by={};ns.forEach(function(n){if(n.kind!=='worker'||!ok[n.id])return;var k=(n.parent&&p[n.parent]&&n.parent!=='service'&&n.parent!=='hooks')?n.parent:'main';(by[k]=by[k]||[]).push(n)});
  Object.keys(by).forEach(function(k){var ws=by[k].slice(0,3);
    if(k==='main'){ws.forEach(function(w,j){p[w.id]=[CX+(j-(ws.length-1)/2)*52,CY+78+0,46,18]});return}
    var t=ns.filter(function(n){return n.id===k})[0],a0=(!t||t._a==null)?Math.PI/2:t._a;
    ws.forEach(function(w,j){var a=a0+(j-(ws.length-1)/2)*0.17;p[w.id]=[CX+Math.cos(a)*252,CY+Math.sin(a)*287,44,18]})});
  return p}
function clipPt(a,b){var dx=b[0]-a[0],dy=b[1]-a[1],t=Math.min(dx?a[2]/2/Math.abs(dx):1e9,dy?a[3]/2/Math.abs(dy):1e9);return[a[0]+dx*t,a[1]+dy*t]}
function render(){
  var s=SNAP,o=[];pos=layout(s);
  var byid={};(s.nodes||[]).forEach(function(n){byid[n.id]=n});
  o.push('<svg viewBox="0 0 '+W+' '+H+'"><defs>');
  Object.keys(COL).forEach(function(k){o.push('<marker id="a-'+k+'" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" style="fill:var('+COL[k]+')"/></marker>')});
  o.push('</defs>');
  if(!s.service||!s.service.up||!(s.nodes||[]).length){o.push('<text class="mu" x="'+CX+'" y="'+CY+'" text-anchor="middle" font-size="15">Service not running · inbox '+(s.inbox|0)+'</text></svg>');$('map').innerHTML=o.join('');return}
  (s.edges||[]).forEach(function(e){var a=pos[e.from],b=pos[e.to];if(!a||!b)return;
    var k=e.bad?'bad':COL[e.kind]?e.kind:'idle',p=clipPt(a,b),q=clipPt(b,a),op=k==='idle'?.35:k==='bad'?1:Math.max(.35,1-(e.age_s||0)/300);
    o.push('<line x1="'+p[0].toFixed(1)+'" y1="'+p[1].toFixed(1)+'" x2="'+q[0].toFixed(1)+'" y2="'+q[1].toFixed(1)+'" stroke-width="'+(k==='idle'?1:2)+'" style="stroke:var('+COL[k]+')" opacity="'+op+'"'+(k==='idle'?' stroke-dasharray="6 5"':'')+' marker-end="url(#a-'+k+')"/>')});
  Object.keys(pos).forEach(function(id){var n=byid[id];if(!n)return;var c=pos[id],st=n.state,
    sc={active:'--ok',alive:'--ok',undelivered:'--bad',dead:'--bad',orphaned:'--rep',done:'--rep'}[st]||'--bd',
    dash=(st==='idle'||st==='parked'||st==='orphaned')?' stroke-dasharray="5 4"':'';
    o.push('<rect x="'+(c[0]-c[2]/2)+'" y="'+(c[1]-c[3]/2)+'" width="'+c[2]+'" height="'+c[3]+'" rx="8" stroke-width="'+(st==='active'||st==='alive'?2.5:1.5)+'"'+dash+' style="fill:var(--card);stroke:var('+sc+')"/>');
    var big=c[3]>26,sm=c[2]<50;
    o.push('<text x="'+c[0]+'" y="'+(c[1]+(big?-1:3))+'" text-anchor="middle" font-size="'+(big?11:sm?8:9)+'" font-weight="600">'+esc(clip(n.label,Math.floor(c[2]/(big?6.6:sm?4.8:5.6))))+'</text>');
    if(big)o.push('<text class="mu" x="'+c[0]+'" y="'+(c[1]+11)+'" text-anchor="middle" font-size="9">'+esc(clip(n.detail,20))+'</text>')});
  if((s.more|0)>0)o.push('<text class="mu" x="'+(CX+170)+'" y="'+(H-20)+'" text-anchor="middle" font-size="12">+'+(s.more|0)+' more</text>');
  o.push('<g id="pl"></g></svg>');
  $('map').innerHTML=o.join('');
  $('meta').textContent='inbox '+(s.inbox|0)+(s.paused?' · paused':'')+' · '+(s.ts||'')}
function frame(){
  var now=performance.now(),g=$('pl'),h=[];
  pulses=pulses.filter(function(p){return now-p.t0<1100});
  pulses.forEach(function(p){var a=pos[p.f],b=pos[p.to];if(!a||!b)return;var u=(now-p.t0)/1100;
    h.push('<circle r="5" cx="'+(a[0]+(b[0]-a[0])*u).toFixed(1)+'" cy="'+(a[1]+(b[1]-a[1])*u).toFixed(1)+'" style="fill:var(--req)" opacity="'+(1-u*.4).toFixed(2)+'"/>')});
  if(g)g.innerHTML=h.join('');
  raf=pulses.length?requestAnimationFrame(frame):0}
function pulse(f,t){if(pulses.length>20)pulses.shift();pulses.push({f:f,to:t,t0:performance.now()});if(!raf)raf=requestAnimationFrame(frame)}
function up(m,t,c){mode=m;chip(t,c||'live');why(m==='socket'?'':reason())}
// transport 1: WebSocket
function connect(){
  if(stopped||mode&&mode!=='socket')return;
  var open=false;
  try{ws=new WebSocket('ws://127.0.0.1:'+EP.port+'/?'+tq)}catch(e){codes.push('WebSocket: '+esc(e&&e.name||'error'));return fallback('poll')}
  setTimeout(function(){if(!open&&!gotLive&&!mode){codes.push('WebSocket timeout');try{ws.close()}catch(e){}fallback('poll')}},5000);
  ws.onopen=function(){open=true;gotLive=true;fails=0;delay=1000;up('socket','live (socket)')};
  ws.onmessage=function(m){var d;try{d=JSON.parse(m.data)}catch(e){return}
    if(d.type==='snapshot'){SNAP=d;render()}else if(d.type==='event')pulse(d.from,d.to)};
  ws.onerror=function(){if(!open)codes.push('WebSocket error')};
  ws.onclose=function(ev){
    if(!open){codes.push('WebSocket closed '+(ev&&ev.code))}
    if(!gotLive)return fallback('poll');
    if(open)fails=0;else fails++;
    if(fails>=4){stopped=true;chip('service restarted - run lean-agent map --html again','bad');return}
    chip('reconnecting','re');setTimeout(connect,delay);delay=Math.min(15000,delay*2)}}
var tried={};
function fallback(next){
  if(stopped||tried[next])return;tried[next]=1;
  if(next==='poll')return pollFetch();
  if(next==='img')return pollImg();
  blocked()}
function blocked(){
  mode='none';chip('preview blocks live updates','bad');
  var l=base?' <a href="'+base+'/?'+tq+'" target="_blank" rel="noopener">Open in browser</a>':'';
  why((reason()||'no live transport worked')+(location.protocol==='file:'||!/^https?:/.test(location.protocol)?l:''))}
// transport 2: fetch polling
function pollFetch(){
  if(typeof fetch!=='function')return fallback('img');
  var okOnce=false,bad=0;
  function tick(){
    if(stopped||mode&&mode!=='poll')return;
    fetch(base+'/snap?'+tq,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){
      okOnce=true;bad=0;SNAP=d;render();if(mode!=='poll')up('poll','live (polling)');setTimeout(tick,2000)
    }).catch(function(e){
      if(!okOnce){codes.push('fetch failed');return fallback('img')}
      if(++bad>=5){chip('service not reachable','bad');why(reason())}else chip('reconnecting','re');
      setTimeout(tick,2000)})}
  tick()}
// transport 3: image polling (the server draws it)
function pollImg(){
  var n=0,okOnce=false,bad=0;
  function tick(){
    if(stopped||mode&&mode!=='img')return;
    var im=new Image();
    im.onload=function(){okOnce=true;bad=0;im.style.width='100%';im.style.height='auto';im.style.display='block';im.alt='live map';
      $('map').innerHTML='';$('map').appendChild(im);if(mode!=='img')up('img','live (image)');setTimeout(tick,2000)};
    im.onerror=function(){
      if(!okOnce){codes.push('image failed');return blocked()}
      if(++bad>=5){chip('service not reachable','bad');why(reason())}else chip('reconnecting','re');
      setTimeout(tick,2000)};
    im.src=base+'/map.svg?'+tq+'&w=900&h=700&n='+(++n)}
  tick()}
render();
if(EP&&EP.port){chip('connecting','re');connect()}else chip('snapshot (service not running)','bad');
})();
"""

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>lean-agent live map</title><style>%CSS%</style></head><body>
<header><h1>lean-agent map</h1><span id="chip">snapshot (service not running)</span></header>
<div id="why"></div><div id="meta"></div><div id="map"></div>
<script type="application/json" id="snap">%SNAP%</script>
<script type="application/json" id="ep">%EP%</script>
<script>%JS%</script></body></html>
"""


def _json_safe(o):
    return json.dumps(o).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def build_html(snap, ep):
    ep = {"port": ep["port"], "token": ep["token"]} if ep else {}
    return PAGE.replace("%CSS%", CSS).replace("%JS%", JS).replace("%SNAP%", _json_safe(snap)).replace("%EP%", _json_safe(ep))


def write_html(home, snap, out=None):
    """Writes the page (file 0600, default dir 0700) and returns its absolute path."""
    if out:
        p = os.path.abspath(os.path.expanduser(out))
        os.makedirs(os.path.dirname(p), exist_ok=True)
    else:
        d = os.path.join(home, "map")
        os.makedirs(d, exist_ok=True)
        os.chmod(d, 0o700)
        p = os.path.join(d, "live.html")
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(build_html(snap, endpoint(home)))
    os.chmod(p, 0o600)
    return p


PROBE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>lean-agent map probe</title>
<style>body{font:13px system-ui,-apple-system,sans-serif;margin:12px;background:#fff;color:#1B2230}
@media(prefers-color-scheme:dark){body{background:#0F1217;color:#E6E9EF}}
li{margin:3px 0;font-family:ui-monospace,Menlo,monospace}.ok{color:#1B9E92}.no{color:#D6453B}</style></head><body>
<h3>lean-agent map probe</h3><p>Send one screenshot of this page if the live map still does not update.</p>
<ul id="out"><li class="no">inline JS: FAIL (this line never changed)</li></ul>
<script type="application/json" id="ep">%EP%</script>
<script>
(function(){
var EP=JSON.parse(document.getElementById('ep').textContent),out=document.getElementById('out'),viol=[];
function row(t,ok){var l=document.createElement('li');l.className=ok===true?'ok':ok===false?'no':'';l.textContent=t;out.appendChild(l);return l}
function set(l,t,ok){l.textContent=t;l.className=ok?'ok':'no'}
out.innerHTML='';
row('inline JS: ok',true);
row('origin: '+location.origin+' | isSecureContext: '+window.isSecureContext+' | protocol: '+location.protocol);
var meta=document.querySelector('meta[http-equiv]'),m=null;
var all=document.getElementsByTagName('meta');for(var i=0;i<all.length;i++){if(/content-security-policy/i.test(all[i].getAttribute('http-equiv')||''))m=all[i]}
row('meta CSP present: '+(m?'yes ('+m.getAttribute('content')+')':'no'));
var vl=row('securitypolicyviolation: none so far');
document.addEventListener('securitypolicyviolation',function(e){
  viol.push(e.violatedDirective+' '+String(e.blockedURI||'').split('?')[0]);vl.textContent='securitypolicyviolation: '+viol.join(' ; ');vl.className='no'});
if(!EP.port){row('live endpoint: not running (start the service: lean-agent up)',false);return}
var base='http://127.0.0.1:'+EP.port,tq='t='+encodeURIComponent(EP.token);
var wl=row('WebSocket: testing...');
try{var w=new WebSocket('ws://127.0.0.1:'+EP.port+'/?'+tq),done=false;
  w.onopen=function(){done=true;set(wl,'WebSocket: open ok',true);w.close()};
  w.onerror=function(){if(!done)set(wl,'WebSocket: fail (error)',false)};
  w.onclose=function(e){if(!done){done=true;set(wl,'WebSocket: fail (code '+e.code+')',false)}};
  setTimeout(function(){if(!done){done=true;set(wl,'WebSocket: fail (timeout)',false)}},5000)
}catch(e){set(wl,'WebSocket: fail ('+e.name+')',false)}
var fl=row('fetch: testing...');
try{fetch(base+'/snap?'+tq,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(){set(fl,'fetch: ok',true)}).catch(function(e){set(fl,'fetch: fail ('+(e&&e.message)+')',false)})}catch(e){set(fl,'fetch: fail ('+e.name+')',false)}
var il=row('img: testing...'),im=new Image();
im.onload=function(){set(il,'img: ok',true)};im.onerror=function(){set(il,'img: fail',false)};
im.src=base+'/map.svg?'+tq+'&w=200&h=150&n=1';
})();
</script></body></html>
"""


def build_probe(ep):
    ep = {"port": ep["port"], "token": ep["token"]} if ep else {}
    return PROBE.replace("%EP%", _json_safe(ep))


def write_probe(home):
    """Writes <home>/map/probe.html (0600, dir 0700) and returns its absolute path."""
    d = os.path.join(home, "map")
    os.makedirs(d, exist_ok=True)
    os.chmod(d, 0o700)
    p = os.path.join(d, "probe.html")
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(build_probe(endpoint(home)))
    os.chmod(p, 0o600)
    return p
