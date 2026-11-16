#!/usr/bin/env osascript -l JavaScript
// lean-agent menu bar item (macOS, JXA). UNTESTED on a real Mac when written.
// Polls `lean-agent map --json` every 2 s (10 s while the service is down) and shows a status item with a badge;
// clicking opens a popover (WKWebView with a local HTML file + native buttons). No network, no third-party code.
// Only commands run: `lean-agent map ...`, `lean-agent menubar --install|--uninstall`, `open -a Claude`.
// Pause only stops this script's own polling (the view); it runs no command.
ObjC.import('Cocoa');
ObjC.import('WebKit');

var env = $.NSProcessInfo.processInfo.environment;
var BIN = ObjC.unwrap(env.objectForKey('LEAN_AGENT_BIN')) || 'lean-agent';
var DIR = ObjC.unwrap($.NSTemporaryDirectory()) + 'lean-agent-menubar/';
var PAGE = DIR + 'popover.html';
var TEAL = '#2EC4B6', AMBER = '#F2A541', RED = '#F07167';
var snap = {service: {up: false}, nodes: [], edges: [], moving: [], inbox: 0};
var viewPaused = false, busy = false, svgMini = '', loginOn = false;

// Run a command through NSTask (via /usr/bin/env so PATH is searched); returns stdout or ''.
function run(args) {
  var task = $.NSTask.alloc.init;
  var pipe = $.NSPipe.pipe;
  task.executableURL = $.NSURL.fileURLWithPath('/usr/bin/env');
  task.arguments = $(args);
  task.standardOutput = pipe;
  task.standardError = $.NSPipe.pipe;
  var err = $();
  if (!task.launchAndReturnError(err)) return '';
  // read before waiting, otherwise a full pipe would block the child
  var data = pipe.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
}
function spawn(args) {  // fire and forget
  var task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath('/usr/bin/env');
  task.arguments = $(args);
  task.launchAndReturnError($());
}

// Hub icon, drawn as a template image (the system tints it for light/dark menu bars).
function drawIcon(dim, struck) {
  var img = $.NSImage.alloc.initWithSize($.NSMakeSize(18, 18));
  img.lockFocus;
  $.NSColor.blackColor.set;
  var c = {x: 9, y: 9}, pts = [{x: 4, y: 14}, {x: 14, y: 14}, {x: 9, y: 3}];
  var path = $.NSBezierPath.bezierPath;
  path.lineWidth = 1.2;
  pts.forEach(function (p) { path.moveToPoint($.NSMakePoint(c.x, c.y)); path.lineToPoint($.NSMakePoint(p.x, p.y)); });
  path.stroke;
  function dot(p, r) {
    $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(p.x - r, p.y - r, 2 * r, 2 * r)).fill;
  }
  dot(c, 3);
  pts.forEach(function (p) { dot(p, 1.8); });
  if (struck) {
    var s = $.NSBezierPath.bezierPath;
    s.lineWidth = 1.5;
    s.moveToPoint($.NSMakePoint(1, 1)); s.lineToPoint($.NSMakePoint(17, 17)); s.stroke;
  }
  img.unlockFocus;
  img.template = true;  // template: monochrome, tinted by the system
  return img;
}

// Badge state from a snapshot: down > red > amber count > teal dot > quiet; paused dims.
function badge(s) {
  if (!s.service || !s.service.up) return {kind: 'down', text: ''};
  var bad = (s.nodes || []).some(function (n) { return n.state === 'undelivered'; }) ||
            (s.service.socket_ms || 0) > 500;
  if (bad) return {kind: 'red', text: '●'};
  if ((s.inbox || 0) > 0) return {kind: 'amber', text: String(s.inbox)};
  var recent = (s.moving || []).some(function (m) { return m.age_s <= 10; });
  if (recent) return {kind: 'teal', text: '●'};
  return {kind: 'quiet', text: ''};
}
function colored(text, hex) {
  var r = parseInt(hex.substr(1, 2), 16) / 255, g = parseInt(hex.substr(3, 2), 16) / 255, b = parseInt(hex.substr(5, 2), 16) / 255;
  var attrs = $({NSColor: $.NSColor.colorWithSRGBRedGreenBlueAlpha(r, g, b, 1)});
  return $.NSAttributedString.alloc.initWithStringAttributes(text, attrs);
}
function updateButton() {
  var b = badge(snap), btn = statusItem.button;
  btn.image = drawIcon(false, b.kind === 'down');
  btn.alphaValue = viewPaused ? 0.45 : 1.0;  // dimmed when the view is paused
  if (b.text) {
    btn.imagePosition = $.NSImageLeft;
    btn.attributedTitle = colored(' ' + b.text, {teal: TEAL, amber: AMBER, red: RED}[b.kind]);
  } else {
    btn.title = '';
  }
}

function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
function page() {
  var rows = (snap.moving || []).map(function (m) {
    var col = m.dir === 'to' ? TEAL : AMBER;
    return '<div class="row"><span style="color:' + col + '">' + (m.dir === 'to' ? '→' : '←') + '</span> ' +
      '<code>' + esc(m.node) + '</code> ' + esc(m.text) + ' <span class="m">' + Math.round(m.age_s) + ' s</span></div>';
  }).join('') || '<div class="m">Nothing moving.</div>';
  var up = snap.service && snap.service.up;
  return '<!doctype html><meta charset="utf-8"><style>' +
    'body{margin:0;padding:10px;background:#0F1217;color:#E6E9EF;font:12px Inter,-apple-system,sans-serif}' +
    'code{font-family:"JetBrains Mono",Menlo,monospace;font-size:11px}.m{color:#9AA3B2}' +
    'h4{margin:10px 0 4px;font-size:11px;color:#9AA3B2;font-weight:600;text-transform:uppercase}' +
    '.row{padding:2px 0}.card{background:#1A1F27;border:1px solid #2A313C;border-radius:8px;padding:6px 8px}' +
    'svg{width:100%;height:auto}</style>' +
    (up ? '' : '<div class="card" style="border-color:' + RED + '">Service is not running.</div>') +
    '<div>' + svgMini + '</div><h4>Moving now</h4>' + rows +
    '<h4>Inbox</h4><div class="card" style="color:' + ((snap.inbox || 0) > 0 ? AMBER : '#9AA3B2') + '">' +
    (snap.inbox || 0) + ' waiting</div>';
}
function writePage() {
  $.NSString.alloc.initWithUTF8String(page()).writeToFileAtomicallyEncodingError(PAGE, true, $.NSUTF8StringEncoding, $());
  webView.loadFileURLAllowingReadAccessToURL($.NSURL.fileURLWithPath(PAGE), $.NSURL.fileURLWithPath(DIR));
}

function poll() {
  if (busy) return;  // never overlap
  busy = true;
  try {
    var out = run([BIN, 'map', '--json']);
    try { snap = JSON.parse(out); } catch (e) { snap = {service: {up: false}, nodes: [], edges: [], moving: [], inbox: 0}; }
    updateButton();
    if (popover.shown) {
      svgMini = run([BIN, 'map', '--svg', '--mini']);
      writePage();
    }
  } finally { busy = false; }
  if (viewPaused) return;
  var up = snap.service && snap.service.up;
  timer.invalidate;
  timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(up ? 2 : 10, target, 'tick:', $(), false);
}

// Button target: JXA needs a registered ObjC subclass so AppKit can call selectors on it.
ObjC.registerSubclass({
  name: 'LeanAgentTarget',
  methods: {
    'tick:': {types: ['void', ['id']], implementation: function (t) { poll(); }},
    'toggle:': {types: ['void', ['id']], implementation: function (s) {
      if (popover.shown) { popover.close; return; }
      popover.showRelativeToRectOfViewPreferredEdge(statusItem.button.bounds, statusItem.button, $.NSMinYEdge);
      poll();
    }},
    'openMap:': {types: ['void', ['id']], implementation: function (s) { spawn([BIN, 'map', '--open']); }},
    'frontDesk:': {types: ['void', ['id']], implementation: function (s) { spawn(['open', '-a', 'Claude']); }},
    'pause:': {types: ['void', ['id']], implementation: function (s) {
      viewPaused = !viewPaused;
      pauseBtn.title = viewPaused ? 'Resume' : 'Pause';
      if (viewPaused) { timer.invalidate; updateButton(); } else { poll(); }
    }},
    'login:': {types: ['void', ['id']], implementation: function (s) {
      spawn([BIN, 'menubar', loginBox.state == $.NSControlStateValueOn ? '--install' : '--uninstall']);
    }}
  }
});

$.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(DIR, true, $(), $());
var app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);  // no Dock icon
var target = $.LeanAgentTarget.alloc.init;
var statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1);  // NSVariableStatusItemLength
statusItem.button.image = drawIcon(false, false);
statusItem.button.target = target;
statusItem.button.action = 'toggle:';

// Popover: web view on top, native buttons below.
var W = 340, H = 460;
var content = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
var webView = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 70, W, H - 70), $.WKWebViewConfiguration.alloc.init);
content.addSubview(webView);
function button(title, x, y, w, sel) {
  var b = $.NSButton.alloc.initWithFrame($.NSMakeRect(x, y, w, 24));
  b.title = title; b.bezelStyle = $.NSBezelStyleRounded; b.target = target; b.action = sel;
  content.addSubview(b);
  return b;
}
button('Open live map', 8, 40, 110, 'openMap:');
button('Front desk', 122, 40, 90, 'frontDesk:');
var pauseBtn = button('Pause', 216, 40, 80, 'pause:');
var loginBox = $.NSButton.checkboxWithTitleTargetAction('Start at login', target, 'login:');
loginBox.frame = $.NSMakeRect(8, 10, 160, 22);
loginBox.state = $.NSFileManager.defaultManager.fileExistsAtPath(
  ObjC.unwrap($.NSHomeDirectory()) + '/Library/LaunchAgents/com.lean-agent.menubar.plist') ? $.NSControlStateValueOn : $.NSControlStateValueOff;
content.addSubview(loginBox);
var vc = $.NSViewController.alloc.init;
vc.view = content;
var popover = $.NSPopover.alloc.init;
popover.contentSize = $.NSMakeSize(W, H);
popover.behavior = $.NSPopoverBehaviorTransient;
popover.contentViewController = vc;

var timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.1, target, 'tick:', $(), false);
app.run;
