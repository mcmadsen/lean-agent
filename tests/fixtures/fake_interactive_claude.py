#!/usr/bin/env python3
"""A stand-in for an interactive `claude` session: reads its terminal, and for every bracketed-paste message
followed by Enter appends a user and an assistant record to the session's transcript JSONL (the real format).
A message with "use a tool" in it also makes a Bash tool call with its result; "/clear" starts a new transcript
with a new session id (as Claude Code does) and runs the SessionStart hook for it; a lone Escape appends the interruption record."""
import datetime
import json
import os
import re
import subprocess
import sys
import tty

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "plugins", "lean-agent", "scripts", "session_hook.py")
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
    rec.update(sessionId=sid, isSidechain=False, uuid=os.urandom(8).hex(), timestamp=datetime.datetime.utcnow().isoformat() + "Z")
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
        if text.strip() == "/clear":
            sid = os.urandom(8).hex() + "-fake-clear"
            transcript = os.path.join(tdir, sid + ".jsonl")
            # what Claude Code does on /clear: run the SessionStart hooks with the new session
            subprocess.run([sys.executable, HOOK], input=json.dumps({"session_id": sid, "transcript_path": transcript,
                           "source": "clear", "hook_event_name": "SessionStart", "cwd": os.getcwd()}), text=True, check=False)
            add({"type": "user", "isMeta": True, "message": {"role": "user", "content": "<command-name>/clear</command-name>"}})
            continue
        add({"type": "user", "message": {"role": "user", "content": text}})
        if "use a tool" in text:
            tid = "toolu_" + os.urandom(4).hex()
            add({"type": "assistant", "message": {"role": "assistant", "id": "msg_" + os.urandom(4).hex(),
                 "content": [{"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": "echo tool-ran"}}],
                 "stop_reason": "tool_use"}})
            add({"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tid, "content": "tool-ran", "is_error": False}]}})
        add({"type": "assistant", "message": {"role": "assistant", "id": "msg_" + os.urandom(4).hex(),
             "content": [{"type": "text", "text": "echo: " + text}], "stop_reason": "end_turn"}})
    if buf.endswith(b"\x1b"):  # a lone Escape is an interrupt
        add({"type": "user", "message": {"role": "user", "content": "[Request interrupted by user]"}})
        buf = b""
