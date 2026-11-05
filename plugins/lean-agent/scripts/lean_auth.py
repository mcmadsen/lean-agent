"""Sign-in for the service: a long-lived Claude Code token (`claude setup-token`) kept in the OS keychain or a 0600 file
and passed to every claude spawn as CLAUDE_CODE_OAUTH_TOKEN (environment only, never a command line, log or ledger).

Also the auth-failure state: detect() recognises the sign-in failure lines, mark_broken() records it once and opens one
waiting item (kind "auth"), mark_ok() closes it. While broken, the service pauses its chases, stuck restarts and starts."""
import datetime
import json
import os
import re
import subprocess
import sys
import time

import lean_common

ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN"
SERVICE, ACCOUNT = "lean-agent", "claude-oauth-token"
TOKEN_RE = re.compile(r"sk-ant-oat\d*-[A-Za-z0-9_\-]{20,}")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]")
LIFETIME_DAYS = 365
WARN_DAYS = 30
CHECK_EVERY = 600  # seconds between `claude auth status` checks while auth is broken
FAIL_RE = re.compile(r"needs to sign in again|OAuth token has expired|Invalid API key|"
                     r"authentication_error|Please run /login|run /login", re.I)


def host():
    import socket
    return socket.gethostname()


def fix_line():
    return (f"Claude Code needs a new sign-in: run `lean-agent login` in a terminal on {host()} "
            "(one browser step; the token then lasts ~1 year)")


# ---------------------------------------------------------------- store
def backend():
    """keychain (macOS) or file; LEAN_AGENT_TOKEN_BACKEND=file|keychain overrides (tests use file)."""
    b = os.environ.get("LEAN_AGENT_TOKEN_BACKEND")
    if b in ("file", "keychain"):
        return b
    return "keychain" if sys.platform == "darwin" else "file"


def _file():
    return lean_common.lean_home("secrets", ACCOUNT)


def _meta():
    return lean_common.lean_home("login.json")


def load():
    """The stored token, or ''."""
    if backend() == "keychain":
        try:
            r = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
                               capture_output=True, text=True, timeout=20)
            return r.stdout.strip() if r.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            return ""
    try:
        with open(_file()) as fh:
            return fh.read().strip()
    except OSError:
        return ""


def store(token):
    """Keep `token` (keychain or 0600 file) and record only the creation date. Raises OSError on failure."""
    if backend() == "keychain":
        # `security -i` reads its commands from stdin: the token never appears in an argument list
        quoted = '"' + token.replace("\\", "\\\\").replace('"', '\\"') + '"'
        r = subprocess.run(["security", "-i"], input=f"add-generic-password -U -s {SERVICE} -a {ACCOUNT} -w {quoted}\n",
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0 or "error" in (r.stderr or "").lower():
            raise OSError("keychain write failed: " + (r.stderr or "").replace(token, "***").strip())
    else:
        d = os.path.dirname(_file())
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
        fd = os.open(_file(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(token + "\n")
        os.chmod(_file(), 0o600)
    os.makedirs(os.path.dirname(_meta()), exist_ok=True)  # the keychain path never made the home folder
    lean_common.write_json_atomic(_meta(), {"created": datetime.datetime.now().isoformat(timespec="seconds"),
                                            "backend": backend()})


def forget():
    """Remove the stored token. True when there was one."""
    had = bool(load())
    if backend() == "keychain":
        subprocess.run(["security", "delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], capture_output=True, timeout=20)
    else:
        try:
            os.remove(_file())
        except OSError:
            pass
    try:
        os.remove(_meta())
    except OSError:
        pass
    return had


def created():
    try:
        return datetime.datetime.fromisoformat(str(lean_common.read_json(_meta(), {}).get("created")))
    except ValueError:
        return None


def age_days(now=None):
    c = created()
    return None if c is None else ((now or datetime.datetime.now()) - c).days


def days_left(now=None):
    a = age_days(now)
    return None if a is None else LIFETIME_DAYS - a


def apply_env(env):
    """Set CLAUDE_CODE_OAUTH_TOKEN in `env` from the store (read now, so a new login reaches new spawns). Returns env."""
    tok = load()
    if tok:
        env[ENV_VAR] = tok
    return env


def mask(text):
    """`text` with any token (stored or token-shaped) hidden."""
    text = TOKEN_RE.sub("sk-ant-oat…(hidden)", str(text))
    tok = os.environ.get(ENV_VAR)
    return text.replace(tok, "(hidden)") if tok else text


def masked(value):
    return "(hidden)" if value else ""


# ---------------------------------------------------------------- capture
def extract(text):
    """The token in terminal output (colour codes removed), or ''."""
    m = TOKEN_RE.findall(ANSI_RE.sub("", text or ""))
    return m[-1] if m else ""


def run_setup_token(claude, out=None):
    """Run `claude setup-token` in a pty (the user's keys go to it, its screen is mirrored with the token hidden);
    returns (token or '', exit code)."""
    import pty
    import select
    import struct
    import fcntl
    import termios
    out = out or sys.stdout
    env = {k: v for k, v in os.environ.items() if k != ENV_VAR}
    master, slave = pty.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))  # wide: a long token is not wrapped
    proc = subprocess.Popen([claude, "setup-token"], env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True,
                            start_new_session=True)
    os.close(slave)
    buf = b""
    fds = [master]
    tty = False
    try:
        tty = sys.stdin.isatty()
    except (ValueError, OSError):
        pass
    if tty:
        fds.append(sys.stdin.fileno())
    try:
        while True:
            try:
                ready, _, _ = select.select(fds, [], [], 0.5)
            except (OSError, ValueError):
                break
            if master in ready:
                try:
                    raw = os.read(master, 8192)
                except OSError:
                    break
                if not raw:
                    break
                buf += raw
                try:
                    out.write(mask(raw.decode("utf-8", "replace")))
                    out.flush()
                except (OSError, ValueError):
                    pass
            elif tty and sys.stdin.fileno() in ready:
                try:
                    data = os.read(sys.stdin.fileno(), 4096)
                except OSError:
                    data = b""
                if data:
                    os.write(master, data)
            elif proc.poll() is not None:
                break
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    finally:
        try:
            os.close(master)
        except OSError:
            pass
    return extract(buf.decode("utf-8", "replace")), proc.returncode


def auth_status(claude=None):
    """`claude auth status --json` as a dict ({} when it cannot be read)."""
    claude = claude or os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    try:
        r = subprocess.run([claude, "auth", "status", "--json"], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
        data = json.loads(r.stdout)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {}


def status_lines(claude=None):
    tok = bool(load())
    a, left = age_days(), days_left()
    if tok:
        line = f"stored token: yes ({backend()})"
        if a is not None:
            line += f", {a} days old, about {max(left, 0)} days left" + (" — renew soon with `lean-agent login`" if left <= WARN_DAYS else "")
    else:
        line = "stored token: no"
    st = auth_status(claude)
    cl = ("claude auth: loggedIn=" + str(st.get("loggedIn")) + f", authMethod={st.get('authMethod')}") if st else "claude auth: status unavailable"
    return [line, cl]


# ---------------------------------------------------------------- failure state
def _state_path():
    return lean_common.lean_home("auth-state.json")


def state():
    return lean_common.read_json(_state_path(), {}) or {}


def is_broken():
    return bool(state().get("broken"))


STRUCT_RE = re.compile(r'authentication_error|"status"\s*:\s*401|API Error: 401', re.I)


def structured(text):
    """A structured authentication error (401 / authentication_error) in a worker's stream-json or stderr."""
    return bool(STRUCT_RE.search(text or ""))


def confirmed(claude=None):
    """True only when `claude auth status --json` (with the stored token in its environment) says not logged in."""
    claude = claude or os.environ.get("LEAN_AGENT_CLAUDE") or "claude"
    env = apply_env(dict(os.environ))
    try:
        r = subprocess.run([claude, "auth", "status", "--json"], capture_output=True, text=True, timeout=30,
                           stdin=subprocess.DEVNULL, env=env)
        data = json.loads(r.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        return False
    return isinstance(data, dict) and data.get("loggedIn") is False


def detect(text):
    return bool(FAIL_RE.search(ANSI_RE.sub("", text or "")))


def mark_broken(source="", is_structured=False):
    """Record the failure. True the first time only (the caller shows the one line); opens one waiting item. Free text
    (a hint) only counts when `claude auth status` confirms the sign-in is gone; a structured error counts by itself."""
    st = state()
    if st.get("broken"):
        return False
    if not is_structured and not confirmed():
        return False
    import lean_waiting
    wid = ""
    try:
        wid = lean_waiting.add(fix_line(), kind="auth")
    except Exception:  # noqa: BLE001 - the state matters more than the item
        pass
    wid = wid.get("id") if isinstance(wid, dict) else (wid or "")
    os.makedirs(lean_common.lean_home(), exist_ok=True)
    lean_common.write_json_atomic(_state_path(), {"broken": True, "since": time.time(), "source": source,
                                                  "waiting": wid, "checked": time.time()})
    try:
        import lean_log
        lean_log.log("warn", "auth", f"sign-in failed ({source}); chases and restarts paused")
    except Exception:  # noqa: BLE001
        pass
    return True


def mark_ok(why=""):
    """Auth works again: close the waiting item, resume. True when it was broken."""
    st = state()
    if not st.get("broken"):
        return False
    import lean_waiting
    try:
        if st.get("waiting"):
            lean_waiting.done(st["waiting"])
        else:
            for i in lean_waiting.open_items():
                if i.get("kind") == "auth":
                    lean_waiting.done(i["id"])
    except Exception:  # noqa: BLE001
        pass
    try:
        os.remove(_state_path())
    except OSError:
        pass
    try:
        import lean_log
        lean_log.log("info", "auth", f"sign-in works again ({why}); chases and restarts resumed")
    except Exception:  # noqa: BLE001
        pass
    return True


def recheck(now=None, claude=None):
    """While broken, at most every CHECK_EVERY seconds: `claude auth status --json`; auth counts as restored when it says
    loggedIn and a new token was stored since the failure. Returns True when it closed the failure."""
    st = state()
    if not st.get("broken"):
        return False
    now = now if now is not None else time.time()
    if now - float(st.get("checked") or 0) < CHECK_EVERY:
        return False
    st["checked"] = now
    lean_common.write_json_atomic(_state_path(), st)
    c = created()
    renewed = c is not None and c.timestamp() > float(st.get("since") or 0)
    if renewed and auth_status(claude).get("loggedIn"):
        return mark_ok("new token stored")
    return False
