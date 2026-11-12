"""`lean-agent poll`: wait for something without a model. A detached process runs an allow-listed command every
interval and stops when the output matches --until (done) or --fail, the command fails N times in a row, or the
timeout passes; then ONE report goes to the thread (or the main session) through the normal report queue.

Records: <home>/polls/<id>.json (state), <id>.out (last output). A read-only worker, or a thread, may only poll commands
that pass readonly_hook (the worker's own --allow-cmd list); `--shell` is main's alone."""
import argparse
import datetime
import json
import os
import re
import shlex
import subprocess
import sys
import time

import lean_common
import readonly_hook

HERE = os.path.dirname(os.path.abspath(__file__))
META = re.compile(r"^(\|\|?|&&?|;|[0-9&]?>>?(&[0-9])?|<)$|`|\$\(|\n")


def pdir(*parts):
    return lean_common.lean_home("polls", *parts)


def load(pid):
    return lean_common.read_json(pdir(pid + ".json"), None)


def save(rec):
    os.makedirs(pdir(), exist_ok=True)
    lean_common.write_json_atomic(pdir(rec["id"] + ".json"), rec)


def all_polls():
    out = []
    try:
        names = sorted(os.listdir(pdir()))
    except OSError:
        return out
    for n in names:
        if n.endswith(".json"):
            r = lean_common.read_json(pdir(n), None)
            if isinstance(r, dict) and r.get("id"):
                out.append(r)
    return out


def context():
    """("ro", cfg) for a read-only worker, ("thread", cfg) inside a thread, else ("main", None)."""
    cfgp = os.environ.get("LEAN_AGENT_RO_CFG")
    if cfgp:
        cfg = lean_common.read_json(cfgp, None)
        if isinstance(cfg, dict) and cfg.get("project"):
            return "ro", cfg
        return "ro", {"project": os.getcwd(), "allow_cmd": []}
    tag = os.environ.get("LEAN_AGENT_THREAD")
    if tag and tag.lower() != "none":
        return "thread", {"project": os.getcwd(), "allow_cmd": []}
    return "main", None


def refuse(cmd, shell):
    """None when this context may poll the command, else the reason."""
    kind, cfg = context()
    if shell:
        return "--shell is for the main session only" if kind != "main" else None
    text = " ".join(shlex.quote(c) for c in cmd)
    if any(META.search(t) for t in cmd):
        return "shell metacharacters (| & ; < > $ ` ...) need --shell (main session only)"
    if kind == "main":
        return None
    if kind == "thread":  # only what main/the user configured widens it, never the thread itself
        cfg = dict(cfg, allow_cmd=config_allow(os.getcwd()))
    try:
        if cmd and os.path.basename(cmd[0]) == "lean-agent" and cmd[1:2] == ["poll"]:
            return "a poll cannot start a poll"
        decision, why, seg = readonly_hook.decide({"tool_name": "Bash", "tool_input": {"command": text}, "cwd": os.getcwd()}, cfg)
    except Exception as e:  # noqa: BLE001
        return f"cannot check the command: {e}"
    return None if decision == "allow" else f"not allowed here: {seg} ({why})"


def config_allow(cwd):
    """The prefixes main granted threads with `lean-agent config poll-allow`: global ("*") and for the project holding cwd."""
    cfg = lean_common.read_json(lean_common.lean_home("config.json"), {})
    table = cfg.get("poll_allow") if isinstance(cfg, dict) else None
    out = []
    for key, vals in (table.items() if isinstance(table, dict) else []):
        if key == "*" or readonly_hook.inside(cwd, key):
            out += [v for v in vals if isinstance(v, str)]
    return out


def fmt_age(secs):
    secs = int(secs)
    return f"{secs // 3600}h{secs % 3600 // 60}m" if secs >= 3600 else (f"{secs // 60}m" if secs >= 60 else f"{secs}s")


def last_line(text, rx=None):
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if rx:
        for l in reversed(lines):
            if rx.search(l):
                return l[:200]
    return lines[-1][:200] if lines else "(no output)"


def run_once(rec):
    try:
        if rec.get("shell"):
            p = subprocess.run(rec["command_text"], shell=True, capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
        else:
            p = subprocess.run(rec["command"], capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "command timed out after 5m"
    except OSError as e:
        return 127, str(e)


def finish(rec, status, line):
    started = rec["started"]
    rec.update(status=status, ended=time.time(), result=line)
    word = {"done": "done", "failed": "failed", "timeout": "timeout"}.get(status, status)
    text = f"poll {rec['name']}: {word} after {fmt_age(rec['ended'] - started)}: {line} (output: {pdir(rec['id'] + '.out')})"
    try:
        import service_session
        tid = rec.get("thread") or "poll"
        service_session.queue_report(tid, "done" if status == "done" else ("blocked" if rec.get("thread") else "job-failed"),
                                     text, force=True, waiting=False)
    except Exception:  # noqa: BLE001
        pass
    save(rec)  # after the report is queued: whoever sees the final state finds the report
    return text


def worker(pid):
    rec = load(pid)
    if not rec or rec.get("status") != "running":
        return 1
    rec["pid"] = os.getpid()
    save(rec)
    until = re.compile(rec["until"]) if rec.get("until") else None
    fail = re.compile(rec["fail"]) if rec.get("fail") else None
    bad = 0
    while True:
        cur = load(pid)
        if not cur or cur.get("status") != "running":
            return 0  # stopped
        try:
            import lean_load
            if time.time() - rec["started"] < rec["timeout"] and lean_load.overloaded():  # an overloaded machine is not asked more often
                time.sleep(max(30, rec["every"] * 4))
                continue
        except ImportError:
            pass
        rc, out = run_once(rec)
        with open(pdir(pid + ".out"), "w") as fh:
            fh.write(out)
        rec["runs"] = rec.get("runs", 0) + 1
        rec["last_check"] = time.time()
        if fail and fail.search(out):
            finish(rec, "failed", last_line(out, fail))
            return 0
        if until and until.search(out) and rc == 0:
            finish(rec, "done", last_line(out, until))
            return 0
        if not until and rc == 0:
            finish(rec, "done", last_line(out))  # no pattern: the command succeeding is done
            return 0
        bad = bad + 1 if rc != 0 else 0
        if bad >= rec["errors"]:
            finish(rec, "failed", f"exit {rc} {bad} times in a row: {last_line(out)}")
            return 0
        save(rec)
        if time.time() + rec["every"] - rec["started"] > rec["timeout"]:
            finish(rec, "timeout", f"not done within {fmt_age(rec['timeout'])}; last: {last_line(out)}")
            return 0
        time.sleep(rec["every"])


def show(rec):
    out = pdir(rec["id"] + ".out")
    state = rec["status"]
    if state == "running" and not lean_common.pid_alive(rec.get("pid")) and time.time() - rec["started"] > 30:
        state = "lost (process gone)"
    print(f"{rec['id']}  {state}  {rec['name']}  runs={rec.get('runs', 0)}  every {fmt_age(rec['every'])}  "
          f"age {fmt_age((rec.get('ended') or time.time()) - rec['started'])}  thread={rec.get('thread') or 'main'}")
    print(f"  command: {rec['command_text']}")
    if rec.get("until"):
        print(f"  until: {rec['until']}" + (f"   fail: {rec['fail']}" if rec.get("fail") else ""))
    if rec.get("result"):
        print(f"  result: {rec['result']}")
    print(f"  output: {out}")


def main(argv):
    argv = list(argv)
    cmd = []
    if "--" in argv:
        i = argv.index("--")
        argv, cmd = argv[:i], argv[i + 1:]
    ap = argparse.ArgumentParser(prog="lean-agent poll", description="Run a command every interval, with no model, until its output matches.")
    ap.add_argument("--every", default="2m")
    ap.add_argument("--timeout", default="2h")
    ap.add_argument("--until")
    ap.add_argument("--fail")
    ap.add_argument("--errors", type=int, default=3, help="stop after this many non-zero exits in a row")
    ap.add_argument("--thread")
    ap.add_argument("--name")
    ap.add_argument("--shell", action="store_true")
    ap.add_argument("--allow-cmd", action="append", default=[])
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--stop", metavar="ID")
    ap.add_argument("--show", metavar="ID")
    ap.add_argument("--worker", metavar="ID", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    if a.worker:
        return worker(a.worker)
    if a.list:
        rows = all_polls()
        for r in rows:
            print(f"{r['id']}  {r['status']}  {r['name']}  {r.get('result', '')[:80]}")
        if not rows:
            print("no polls")
        return 0
    for flag, fn in ((a.show, "show"), (a.stop, "stop")):
        if flag:
            rec = load(flag)
            if not rec:
                print(f"no poll {flag}")
                return 1
            if fn == "show":
                show(rec)
            elif rec["status"] != "running":
                print(f"poll {flag} is already {rec['status']}")
            else:
                rec.update(status="stopped", ended=time.time(), result="stopped")
                save(rec)
                if lean_common.pid_alive(rec.get("pid")):
                    try:
                        os.kill(rec["pid"], 15)
                    except OSError:
                        pass
                print(f"stopped poll {flag}")
            return 0
    if not cmd:
        print("usage: lean-agent poll [--every 2m] [--timeout 2h] [--until REGEX] [--fail REGEX] [--thread tN] [--name TEXT] -- <command...>\n"
              "       lean-agent poll --list | --stop ID | --show ID")
        return 2
    try:
        every, timeout = lean_common.parse_duration(a.every), lean_common.parse_duration(a.timeout)
        for rx in (a.until, a.fail):
            if rx:
                re.compile(rx)
    except (ValueError, re.error) as e:
        print(f"poll: {e}")
        return 2
    if a.allow_cmd and context()[0] != "main":
        print("refused: --allow-cmd cannot widen a poll from a worker or thread; the user grants prefixes with "
              "`lean-agent config poll-allow <prefix>...`")
        return 2
    why = refuse(cmd, a.shell)
    if why:
        print(f"refused: {why}")
        return 2
    kind, _ = context()
    from lean_threads import resolve_tag
    tag = resolve_tag(a.thread) if (a.thread or kind != "main") else None
    pid = datetime.datetime.now().strftime("%m%d-%H%M%S") + "-" + os.urandom(2).hex()
    text = " ".join(cmd)
    rec = {"id": pid, "name": a.name or text[:40], "command": cmd, "command_text": text, "shell": a.shell,
           "every": max(0.1, every), "timeout": timeout, "until": a.until, "fail": a.fail, "errors": max(1, a.errors),
           "thread": tag, "started": time.time(), "status": "running", "runs": 0}
    save(rec)
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "--worker", pid], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                     cwd=os.getcwd(), env=dict(os.environ))
    print(f"poll {pid} started: {text} every {fmt_age(rec['every'])}, up to {fmt_age(timeout)}; "
          f"reported to {tag or 'main'} when done (lean-agent poll --show {pid})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
