#!/usr/bin/env python3
"""A stand-in for an interactive `claude` session: reads its terminal, and for every bracketed-paste message
followed by Enter appends a user and an assistant record to the session's transcript JSONL (the real format)."""
import datetime
import json
import os
import re
import sys
import tty

argv = sys.argv[1:]
sid = argv[argv.index("--session-id") + 1] if "--session-id" in argv else argv[argv.index("--resume") + 1]
cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
tdir = os.path.join(cfg, "projects", re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(os.getcwd())))
os.makedirs(tdir, exist_ok=True)
transcript = os.path.join(tdir, sid + ".jsonl")
with open(os.environ["FAKE_SESSION_LOG"], "a") as fh:
    fh.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "pid": os.getpid(),
                         "service": os.environ.get("LEAN_AGENT_SERVICE_SESSION"),
                         "leaked": os.environ.get("CLAUDECODE")}) + "\n")


def add(rec):
    rec.update(sessionId=sid, uuid=os.urandom(8).hex(), timestamp=datetime.datetime.utcnow().isoformat() + "Z")
    with open(transcript, "a") as fh:
        fh.write(json.dumps(rec) + "\n")


tty.setraw(0)
sys.stdout.write("fake claude ready\r\n")
sys.stdout.flush()
buf = b""
while True:
    chunk = os.read(0, 4096)
    if not chunk:
        break
    buf += chunk
    while True:
        m = re.search(rb"\x1b\[200~(.*?)\x1b\[201~\r", buf, re.S)
        if not m:
            break
        text = m.group(1).decode()
        buf = buf[m.end():]
        add({"type": "user", "message": {"role": "user", "content": text}})
        add({"type": "assistant", "message": {"role": "assistant", "id": "msg_" + os.urandom(4).hex(),
             "content": [{"type": "text", "text": "echo: " + text}], "stop_reason": "end_turn"}})
    if buf.endswith(b"\x1b"):  # a lone Escape is an interrupt
        add({"type": "user", "message": {"role": "user", "content": "[Request interrupted by user]"}})
        buf = b""
