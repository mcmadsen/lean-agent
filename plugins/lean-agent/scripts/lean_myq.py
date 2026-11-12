"""The user's own questions and their answers, captured deterministically (no model).

Store: <home>/my-questions.json, entries {id "uN" (shown as qN), ts, text, target "main"|"tN", status open|answered|dropped,
answer (capped), answer_ref, answered_ts}. Captured by the front desk's prompt hook (an `a21 <question>` shortcut, or a
question to the front desk itself), answered by the target thread's next report or by the front desk's reply."""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lean_common
import lean_private

ANSWER_CHARS = 4000
STALE_MIN = 30
QUESTION_WORDS = ("how", "why", "what", "where", "when", "which", "who", "can", "could", "is", "are", "do", "does")
QUESTION_MAX = 400
_WORD_RE = re.compile(r"^(?:" + "|".join(QUESTION_WORDS) + r")\b", re.I)


def path():
    return lean_common.lean_home("my-questions.json")


def _load():
    d = lean_common.read_json(path(), {})
    items = d.get("items") if isinstance(d, dict) else None
    return [x for x in items if isinstance(x, dict)] if isinstance(items, list) else []


def _save(items):
    os.makedirs(lean_common.lean_home(), exist_ok=True)
    lean_common.write_json_atomic(path(), {"items": items[-500:]})


def qn(item):
    return "q" + str(item.get("id") or "u0")[1:]


def parse_id(text):
    m = re.fullmatch(r"\s*[qu]?(\d+)\s*", str(text or ""), re.I)
    return "u" + str(int(m.group(1))) if m else ""


def is_question(text):
    """A front-desk message that is a question: ends with "?" or starts with a question word; short-ish; one message."""
    t = " ".join(str(text or "").split())
    if not t or len(t) > QUESTION_MAX or t == "?" or t.startswith("/"):
        return False
    return t.endswith("?") or bool(_WORD_RE.match(t))


def add(text, target="main", now=None):
    """Record a question once: the same text to the same target still open within 10 minutes is not recorded again.
    Returns the entry."""
    now = time.time() if now is None else now
    text = str(text or "").strip()
    if not text:
        return None
    with lean_common.file_lock(path()):
        items = _load()
        for x in reversed(items):
            if x.get("text") == text and x.get("target") == target and x.get("status") == "open" and now - float(x.get("ts") or 0) < 600:
                return x
        n = max([int(str(x.get("id") or "u0")[1:] or 0) for x in items] + [0]) + 1
        e = {"id": f"u{n}", "ts": now, "text": text, "target": target, "status": "open", "answer": "", "answer_ref": "", "answered_ts": 0}
        items.append(e)
        _save(items)
    return e


def _answer(items, e, text, ref, now):
    e.update(status="answered", answer=str(text or "").strip()[:ANSWER_CHARS], answer_ref=ref, answered_ts=now, answer_read=False)
    e.pop("reminded", None)
    e.pop("announced", None)
    e.pop("note", None)


def thread_report(tid, kind, text, now=None):
    """A report of thread `tid` answers its open questions asked before now. A counter-question (kind question) keeps them
    open and says so. Returns the entries changed."""
    now = time.time() if now is None else now
    out = []
    with lean_common.file_lock(path()):
        items = _load()
        for x in items:
            if x.get("status") != "open" or x.get("target") != tid or float(x.get("ts") or 0) > now:
                continue
            if kind == "question":
                x["note"] = f"{tid} asked back: " + " ".join(str(text or "").split())[:200]
            elif kind in ("done", "needs-you", "blocked"):
                _answer(items, x, text, f"{kind} report of {tid}", now)
            else:
                continue
            out.append(x)
        if out:
            _save(items)
    return out


def main_reply(text, now=None):
    """The front desk's visible reply of the turn answers its latest open question."""
    now = time.time() if now is None else now
    text = str(text or "").strip()
    if not text:
        return None
    with lean_common.file_lock(path()):
        items = _load()
        for x in reversed(items):
            if x.get("target") == "main" and x.get("status") == "open":
                _answer(items, x, text, "front desk reply", now)
                _save(items)
                return x
    return None


def _words(text):
    return {w for w in re.findall(r"\w+", str(text or "").lower()) if len(w) > 2}


def retarget(tid, text, now=None):
    """The front desk handed a thread (`thread send|new|answer`) a message in the turn of its own latest open `main`
    question: that question now belongs to the thread (status stays open) and the front desk's reply no longer answers
    it. Matches when the message carries the question (containment, or most of its words); else a single fresh open
    question (under 5 minutes) is taken to be the turn's routed message. Only in the front desk's session."""
    if os.environ.get("LEAN_AGENT_SESSION_ROLE") != "main":
        return None
    now = time.time() if now is None else now
    msg = " ".join(str(text or "").lower().split())
    with lean_common.file_lock(path()):
        items = _load()
        opens = [x for x in items if x.get("target") == "main" and x.get("status") == "open" and now - float(x.get("ts") or 0) < 1800]
        hit = None
        for x in reversed(opens):
            q = " ".join(str(x.get("text") or "").lower().split())
            qw = _words(q)
            if q and (q in msg or (msg and msg in q) or (qw and len(qw & _words(msg)) / len(qw) >= 0.6)):
                hit = x
                break
        if not hit and len(opens) == 1 and now - float(opens[0].get("ts") or 0) < 300:
            hit = opens[0]
        if hit:
            hit["target"] = tid
            hit["note"] = f"sent to {tid} by the front desk"
            _save(items)
        return hit


def due(now=None):
    """One stale, not recently nudged open question per thread (any thread, goal or not)."""
    now = time.time() if now is None else now
    lim = stale_minutes() * 60
    out = {}
    for x in _load():
        t = x.get("target")
        if x.get("status") == "open" and t and t != "main" and t not in out and now - float(x.get("ts") or 0) >= lim \
                and now - float(x.get("nudged") or 0) >= lim:
            out[t] = x
    return list(out.values())


def drop(num, now=None):
    i = parse_id(num)
    with lean_common.file_lock(path()):
        items = _load()
        for x in items:
            if x.get("id") == i and x.get("status") == "open":
                x["status"] = "dropped"
                _save(items)
                return x
    return None


def stale_minutes():
    for v in (os.environ.get("LEAN_AGENT_MYQ_STALE"), (lean_common.read_json(lean_common.lean_home("config.json"), {}) or {}).get("myq-stale-minutes"),
              (lean_common.read_json(lean_common.lean_home("config.json"), {}) or {}).get("myq_stale_minutes")):
        try:
            if v is not None and float(v) > 0:
                return float(v)
        except (TypeError, ValueError):
            pass
    return STALE_MIN


def stale(tid, now=None, minutes=None, nudgeable=False):
    """The oldest open question for thread `tid` older than the stale limit (config myq-stale-minutes), else None. With
    `nudgeable`, one that was nudged less than a stale period ago does not count."""
    now = time.time() if now is None else now
    lim = (stale_minutes() if minutes is None else minutes) * 60
    for x in _load():
        if x.get("status") == "open" and x.get("target") == tid and now - float(x.get("ts") or 0) >= lim:
            if nudgeable and now - float(x.get("nudged") or 0) < lim:
                continue
            return x
    return None


def mark_nudged(num, now=None):
    now = time.time() if now is None else now
    with lean_common.file_lock(path()):
        items = _load()
        for x in items:
            if x.get("id") == num:
                x["nudged"] = now
        _save(items)


REMIND_MIN = 10
BLOCK_MAX = 5


def _unread(items):
    """Answered and not yet acknowledged; an answer without the flag (from before 0.45.55) counts as read."""
    return sorted((x for x in items if x.get("status") == "answered" and x.get("answer_read") is False
                   and not lean_private.hides(thread=x.get("target"))), key=lambda x: float(x.get("answered_ts") or 0))


def unread():
    return _unread(_load())


def header(now=None):
    u = unread()
    return f"{len(u)} unread answer{'s' if len(u) != 1 else ''} ({', '.join(qn(x) for x in u)})" if u else ""


def block(now=None):
    """The front desk's first lines while answers are unread: one line per answer (max 5), before any table."""
    u = unread()
    if not u:
        return ""
    lines = ["ANSWERS FOR YOU (start your reply with these lines, before any table, never inside one; "
             "put the line '" + header() + "' above any summary/status table):"]
    for x in u[-BLOCK_MAX:][::-1]:
        t = x.get("target") if x.get("target") != "main" else "front desk"
        a = _cell(x.get("answer"), 200)
        lines.append(f"{qn(x)} ({t}): {a} \u00b7 ack {qn(x)} when read")
    if len(u) > BLOCK_MAX:
        lines.append(f"+{len(u) - BLOCK_MAX} more: q unread")
    lines.append("When the user says ack / ack N, run `lean-agent myq ack` (all) or `lean-agent myq ack qN ...`.")
    return "\n".join(lines)


def fresh_unannounced():
    return any(not x.get("announced") for x in unread())


def mark_announced():
    with lean_common.file_lock(path()):
        items = _load()
        for x in _unread(items):
            x["announced"] = True
        _save(items)


def ack(nums=None, now=None):
    """Mark answers read: the given numbers, or all unread when `nums` is empty/None. Returns the entries changed."""
    ids = {parse_id(n) for n in (nums or [])}
    ids.discard("")
    out = []
    with lean_common.file_lock(path()):
        items = _load()
        for x in items:
            if x.get("status") == "answered" and x.get("answer_read") is False and (not nums or x.get("id") in ids):
                x["answer_read"] = True
                out.append(x)
        if out:
            _save(items)
    return out


def reminder(now=None):
    """ONE reminder line for answers unread for 10 minutes; each question is reminded once, ever."""
    now = time.time() if now is None else now
    with lean_common.file_lock(path()):
        items = _load()
        due = [x for x in _unread(items) if not x.get("reminded") and now - float(x.get("answered_ts") or 0) >= REMIND_MIN * 60]
        if not due:
            return ""
        for x in due:
            x["reminded"] = now
        _save(items)
    return "Reminder: unread answers for the user: " + ", ".join(qn(x) for x in due) + " (ack when read)."


def unread_text():
    u = unread()
    if not u:
        return "No unread answers."
    return "\n\n".join(f"{qn(x)} to {x.get('target')}: {x.get('text')}\nAnswer: {x.get('answer')}" for x in u)


def _age(ts, now):
    s = max(0, int(now - float(ts or 0)))
    return f"{s // 86400}d" if s >= 172800 else f"{s // 3600}h" if s >= 3600 else f"{s // 60}m"


def _cell(text, n):
    t = " ".join(str(text or "").split())
    return t if len(t) <= n else t[:n - 1].rstrip() + "…"


def stale_label(x, now=None):
    now = time.time() if now is None else now
    return f"your question {qn(x)} unanswered ({int((now - float(x.get('ts') or 0)) // 60)}m)"


def select(open_only=False, thread=None):
    items = [x for x in _load() if not lean_private.hides(thread=x.get("target"))]
    if open_only:
        items = [x for x in items if x.get("status") == "open"]
    if thread:
        items = [x for x in items if x.get("target") == thread]
    return sorted(items, key=lambda x: (x.get("status") != "open", -float(x.get("ts") or 0)))


def table(open_only=False, thread=None, now=None):
    now = time.time() if now is None else now
    rows = select(open_only, thread)
    pre = ""
    if not open_only and not thread and unread():
        pre = header() + "\n\n" + unread_text() + "\n\n"
    if not rows:
        return "No questions" + (" open" if open_only else "") + (f" for {thread}" if thread else "") + " recorded."
    out = ["| # | When | To | Status | Question | Answer |", "|---|---|---|---|---|---|"]
    for x in rows:
        ans = _cell(x.get("answer"), 60) or (_cell(x.get("note"), 60) if x.get("note") else "")
        out.append(f"| {qn(x)} | {_age(x.get('ts'), now)} ago | {x.get('target')} | {x.get('status')} | "
                   f"{_cell(x.get('text'), 50).replace('|', '/')} | {ans.replace('|', '/')} |")
    return pre + "\n".join(out)


def show(num, now=None):
    now = time.time() if now is None else now
    i = parse_id(num)
    for x in _load():
        if x.get("id") == i:
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(float(x.get("ts") or 0)))
            lines = [f"{qn(x)} to {x.get('target')} ({x.get('status')}), asked {when} ({_age(x.get('ts'), now)} ago)", "", "Question:", x.get("text") or ""]
            if x.get("answer"):
                at = time.strftime("%Y-%m-%d %H:%M", time.localtime(float(x.get("answered_ts") or 0)))
                lines += ["", f"Answer ({at}, source: {x.get('answer_ref') or '-'}):", x["answer"]]
            else:
                lines += ["", "No answer yet." + (f" {x['note']}" if x.get("note") else "")]
            return "\n".join(lines)
    return f"No question {num} recorded."
