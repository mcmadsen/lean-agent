"""lean-agent's local dashboard: one page on http://127.0.0.1:<port>/?t=<token> that refreshes itself.

It shows what lean-agent's own files say (runs, the work queue, scheduled jobs, reviews, pushes, plan pace, the
orchestrator's context), and it's where you talk to the orchestrator (dash_chat.py) and change the work queue. It
listens on 127.0.0.1 only and answers only requests with its token and a local Host header; changes (POST) need the
token in a header and the page's own origin. `lean-agent up` starts it in the background; `lean-agent
dashboard` runs it on its own. The port and token are kept in ~/.lean-agent/dashboard.json, so a tab you opened
(e.g. in Claude Desktop's built-in browser) keeps working after a restart.
"""
import datetime
import glob
import html
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import usage  # noqa: E402
import lean_schedule  # noqa: E402
import prs  # noqa: E402

DEFAULT_PORT = 8765


def home(*parts):
    return os.path.join(usage.lean_home(), *parts)


def _json(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def _jsonl(path, tail=2000):
    try:
        with open(path) as fh:
            lines = fh.readlines()[-tail:]
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def settings():
    """{"port", "token"}: kept, so the dashboard's address doesn't change between restarts."""
    path = home("dashboard.json")
    cur = _json(path, {})
    if not cur.get("token"):
        cur = {"port": cur.get("port") or DEFAULT_PORT, "token": secrets.token_urlsafe(16)}
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump(cur, fh)
    return cur


def url(cfg=None):
    cfg = cfg or settings()
    return f"http://127.0.0.1:{cfg['port']}/?t={cfg['token']}"


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _service_status():
    sys.path.insert(0, HERE)
    import dash_chat
    return dash_chat.service_status()


def cause_key(text):
    """A run's reason with the parts that differ per run (ids, numbers, paths, quoted names) left out, so runs
    blocked by the same thing (an authorization error, say) compare equal."""
    t = " ".join(str(text or "").split()).lower()[:400]
    t = re.sub(r"https?://\S+|(?:[a-z]:)?[\\/][\w.\-/\\]+|\b[0-9a-f]{7,}\b|\d+", " ", t)
    t = re.sub(r"[`'\"]", "", t)
    return " ".join(re.sub(r"[^a-z ]", " ", t).split())[:90]


def orchestrator_context():
    """The latest orchestrator conversation: context now, the compaction point, calls."""
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    h = home("home")
    found = []
    for d in dict.fromkeys([h, os.path.realpath(h)]):
        found += glob.glob(os.path.join(cfg, "projects", re.sub(r"[^A-Za-z0-9]", "-", d), "*.jsonl"))
    if not found:
        return {}
    path = max(found, key=os.path.getmtime)
    series = usage.context_series(path)
    window = int(os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") or 100000)
    pct = float(os.environ.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE") or 70)
    compact_at = int(min((window - 4000) * pct / 100, window - 17000))
    return {"now": series[-1][1] if series else 0, "calls": len(series), "compact_at": compact_at,
            "trend": [c for _, c in series[-60:]],
            "updated": datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")}


def open_gaps(slug, review):
    """Known gaps of a review the user hasn't acknowledged yet (lean-agent review decline <project> g<n>)."""
    gaps = review.get("gaps") or []
    if not gaps:
        return 0
    acked = [d.get("gap", "") for d in _jsonl(home("reviews", slug + ".declined.jsonl")) if d.get("gap")]
    words = lambda t: set(re.findall(r"[a-z0-9]{3,}", str(t).lower()))
    def acked_gap(g):
        w = words(g.get("what"))
        return any(w and len(w & words(a)) / max(1, len(w | words(a))) >= 0.3 for a in acked)
    return sum(1 for g in gaps if not acked_gap(g))


def schedule_runner():
    """Who runs due scheduled jobs, and when it was last seen."""
    try:
        age = int((time.time() - os.path.getmtime(home("scheduled", ".timer"))) / 60)
    except OSError:
        age = None
    if age is not None and age < 15:
        return f"the `lean-agent up` timer (seen {age} min ago) runs due jobs every 5 minutes"
    return ("no `lean-agent up` timer seen" + (f" for {age} min" if age is not None else "")
            + ": jobs run only while `lean-agent up` (or the service) runs, or at the orchestrator's next tool call")


COLUMNS = ("Waiting on you", "In review", "In progress", "Open", "Done", "Notes")
WAITING = ("needs-input", "awaiting-confirmation")
MEANING = {"done": "answered", "partial": "stopped early with a partial answer", "failed": "failed",
           "needs-input": "asks you something", "awaiting-confirmation": "waits for your go-ahead",
           "stopped": "was stopped"}
DECISION_RE = re.compile(r"\b(decid\w*|decision|your (word|call|go|answer)|user'?s? (word|call|decision|go|answer)|"
                         r"awaiting (the )?user|waiting on (the )?user|needs? (the )?user|ask (the )?user)\b", re.I)


def _ref_key(ref):
    return re.sub(r"[^a-z0-9]", "", str(ref or "").lower())


def _same_ref(a, b):
    """A todo's ref and a review's ref name the same thing ("PR 512" and "pr-512", a branch with or without its
    remote, a work item number and a branch named after it): equal once punctuation is gone, one ends with the
    other, or they share a number of 3+ digits."""
    ka, kb = _ref_key(a), _ref_key(b)
    if not ka or not kb:
        return False
    short, long_ = sorted((ka, kb), key=len)
    if ka == kb or (len(short) >= 4 and long_.endswith(short)):
        return True
    nums = lambda t: set(re.findall(r"(?<!\d)\d{3,}(?!\d)", str(t)))
    return bool(nums(a) & nums(b))


_BRANCH = {}


def branch_state(path, ref, head, base=None):
    """"merged" (the reviewed commit is in the base branch), "gone" (no such branch any more) or None, from the
    project's git as of its last fetch (nothing is fetched). Cached for 5 minutes."""
    import subprocess
    if not path or not ref or not os.path.isdir(path):
        return None
    key = (path, ref, head, base)
    hit = _BRANCH.get(key)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    def git(*args):
        try:
            return subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, timeout=5).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return None
    if not git("rev-parse", "--git-dir"):
        _BRANCH[key] = (time.time(), None)
        return None  # not a git checkout (any more): nothing to say
    state = None
    names = [ref] + ([] if ref.startswith("origin/") else [f"origin/{ref}"])
    exists = [n for n in names if git("rev-parse", "--verify", "--quiet", n + "^{commit}")]
    bases = [b for b in [base, "origin/HEAD", "origin/main", "origin/master", "origin/develop"] if b]
    if head and git("cat-file", "-e", f"{head}^{{commit}}"):
        for b in bases:
            if b.split("/")[-1] != ref.split("/")[-1] and git("merge-base", "--is-ancestor", head, b):
                state = "merged"
                break
    if not state and not exists:
        state = "gone"
    _BRANCH[key] = (time.time(), state)
    return state


def short_title(text, limit=90):
    """(title, rest): the first clause of a long item text as its title, the rest as detail."""
    t = " ".join(str(text or "").split())
    if len(t) <= limit:
        return t, ""
    m = next((m for m in re.finditer(r"(?<=\S)(: |; | - | — |\. )", t[:limit + 1]) if m.start() >= 12), None)
    if m:
        return t[:m.start()], t[m.end():]
    cut = t.rfind(" ", 0, limit)
    return t[:cut if cut > 30 else limit] + "…", t


def _count_history(slug):
    out = []
    for h in _jsonl(home("counts", f"{slug}.jsonl"), 5000):
        out.append(h)
    return out


def _run_info(r):
    if not r:
        return None
    st = str(r.get("status") or "").split(":")[0]
    return {"id": r.get("id"), "status": st, "ts": r.get("ts"), "role": r.get("role"),
            "meaning": MEANING.get(st, st)}


def board(todo, ledger, running, reviews, now=None, prs=None, notes=(), epics=None):
    """What the user should look at, as columns. Waiting on you: things only the user can do (a PR that's ready
    for their merge or vote, PR comments waiting on their reply, a run that asks or waits for a go-ahead, a
    decision note), each with the action and where to do it. In review: one card per pull request (CI, review at
    its tip, comments), and reviewed branches without a PR. In progress / Open: the work queue, with the runs on
    it. Done: the last 7 days, items of one ref grouped. Notes: reminders. View only."""
    import hashlib
    sys.path.insert(0, HERE)
    import prs as prs_mod
    now = now or datetime.datetime.now()
    week_ago = (now - datetime.timedelta(days=7)).isoformat()
    recent = (now - datetime.timedelta(days=3)).isoformat()
    sig = lambda *x: hashlib.sha1(json.dumps(x, default=str, sort_keys=True).encode()).hexdigest()[:10]
    latest = {}
    for r in ledger:
        latest[r.get("id")] = r  # a resumed run: its last pass
    runs_of = {}
    for r in latest.values():
        if r.get("todo") is not None:
            runs_of.setdefault(r["todo"], []).append(r)
    ids = {t.get("id") for t in todo}
    live = {}
    for m in running:
        if m.get("todo") in ids:
            live.setdefault(m["todo"], []).append(m)
    by_ref = {}
    for r in reviews:
        if r.get("ref") and r["ref"] != "working tree":
            by_ref.setdefault((r["project"], r["ref"].replace("origin/", "", 1)), []).append(r)

    def card(**kw):
        c = {"kind": "item", "project": None, "ref": None, "prio": "normal", "due": None, "notes": 0, "why": None,
             "action": None, "link": None, "result": None, "live": [], "runs": [], "last_run": None,
             "done_at": None, "review": None, "pr": None, "items": [], "rest": ""}
        c.update(kw)
        c["title"], rest = (" ".join(str(c.get("text") or "").split()), "") if c["kind"] in ("run", "note") \
            else short_title(c.get("text"))
        c["rest"] = c["rest"] or rest
        c["sig"] = sig({k: v for k, v in c.items() if k not in ("live", "sig")}, bool(c["live"]))
        return c

    def review_at(project, branch, head=None):
        """The review that counts for a branch: at `head` (a PR's tip) if there is one there, else the latest."""
        recs = sorted(by_ref.get((project, branch)) or [], key=lambda r: r.get("ts") or "")
        if not recs:
            return None
        at = [r for r in recs if head and r.get("full_head", "").startswith(head[:10])] if head else []
        pool = at or [r for r in recs if r.get("full_head") == recs[-1].get("full_head")]
        decided = [r for r in pool if r.get("verdict") in ("approve", "changes-requested")]
        r = (decided or pool)[-1]
        return dict({k: r.get(k) for k in ("verdict", "gaps", "blocking", "ts", "ref", "branch", "run", "head")},
                    stale=bool(head and not at))

    cards, used_refs, pr_items = [], set(), {}
    # pull requests
    for key, pr in sorted((prs or {}).items()):
        if not isinstance(pr, dict) or "#" not in key or not pr.get("number") or pr.get("error"):
            continue
        if pr.get("state") == "closed" or (pr.get("fetched") or "") < week_ago:
            continue
        slug, num = pr.get("project"), pr["number"]
        branch = pr.get("branch") or ""
        linked = [t for t in todo if t.get("project") in (slug, None) and t.get("ref") and
                  (prs_mod.pr_number(t["ref"]) == num or (branch and _same_ref(t["ref"], branch)))]
        for t in linked:
            pr_items[t["id"]] = num
        used_refs.add((slug, branch))
        rv = review_at(slug, branch, pr.get("head"))
        merged = pr.get("state") == "merged" or (rv and rv.get("branch") == "merged")
        why = action = None
        if merged:
            col = "Done"
        elif pr.get("waiting"):
            w = pr["waiting"][-1]
            col = "Waiting on you"
            n = len(pr["waiting"])
            why = (f"{n} comment{'s wait' if n > 1 else ' waits'} for your reply · "
                   f"{w.get('author')}: {w.get('text')}")
            action = "answer on the PR"
        elif pr.get("ci") == "failing":
            col, why = "In review", "CI is failing"
        elif pr.get("draft"):
            col, why = "In review", "draft"
        elif rv and rv.get("verdict") == "approve" and not rv.get("gaps") and not rv.get("stale") \
                and pr.get("ci") in ("passing", None) and not pr.get("my_vote"):
            col = "Waiting on you"
            why = "ready: review approved at the tip" + (", CI green" if pr.get("ci") == "passing" else "")
            action = "merge or vote on the PR"
        else:
            col = "In review"
            if rv and rv.get("gaps"):
                why = f"{rv['gaps']} known gap{'s' if rv['gaps'] > 1 else ''} to answer"
                action = f"lean-agent review --status {slug} --head {branch}"
        cards.append(card(id=f"pr-{slug}-{num}", kind="pr", text=f"PR {num} · {pr.get('title') or branch}",
                          project=slug, ref=branch, column=col, why=why, action=action, link=pr.get("url"),
                          review=rv, items=[t["id"] for t in linked],
                          done_at=pr.get("fetched") if merged else None, result="merged" if merged else None,
                          pr={k: pr.get(k) for k in ("number", "state", "draft", "ci", "approval", "my_vote",
                                                     "comments", "last_comment", "fetched")}))
    # the work queue
    done_groups = {}
    for t in todo:
        if t.get("status") == "done" and (t.get("done_at") or "") < week_ago:
            continue
        tid = t.get("id")
        runs = sorted(runs_of.get(tid) or [], key=lambda r: r.get("ts") or "")
        last = _run_info(runs[-1]) if runs else None
        rv = None
        if t.get("ref") and tid not in pr_items and t.get("status") != "done":
            hits = [(p, b) for (p, b) in by_ref if (not t.get("project") or p == t["project"]) and _same_ref(t["ref"], b)]
            hits = [review_at(p, b) for p, b in hits]
            hits = [h for h in hits if h and h.get("branch") != "gone"]
            rv = max(hits, key=lambda r: r["ts"] or "") if hits else None
            if rv:
                used_refs.add((t.get("project"), rv["ref"].replace("origin/", "", 1)))
        result = t.get("result") or ((t.get("notes") or [None])[-1] if t.get("status") == "done" else None)
        why = action = None
        if t.get("status") == "done":
            col = "Done"
        elif live.get(tid):
            col = "In progress"  # what runs now wins over how an earlier pass ended
        elif last and last["status"] in WAITING and (last["ts"] or "") >= recent:
            col, why = "Waiting on you", "the run " + last["meaning"]
            action = f"answer it in the orchestrator (read it: lean-agent runs --show {last['id']})"
        elif rv and rv.get("branch") == "merged":
            col, why = "Waiting on you", "merged: close the item"
            action = f'lean-agent todo done {tid} "<result>"'
        elif rv and rv.get("gaps"):
            col, why = "Waiting on you", f"{rv['gaps']} known gap{'s' if rv['gaps'] > 1 else ''} to answer"
            action = f"lean-agent review --status {t.get('project')} --head {rv['ref']}"
        elif rv:
            col = "In review"
        elif t.get("status") == "doing" or runs:
            col = "In progress"
        else:
            col = "Open"
        c = card(id=tid, text=t.get("text"), project=t.get("project"), ref=t.get("ref"), prio=t.get("prio") or "normal",
                 due=t.get("due"), notes=len(t.get("notes") or []), column=col, why=why, action=action, result=result,
                 live=live.get(tid) or [], runs=[r.get("id") for r in runs][-4:], last_run=last,
                 done_at=t.get("done_at"), review=rv if col != "Done" else None,
                 pr=({"number": pr_items[tid]} if tid in pr_items else None))
        if t.get("epic") and col == "Open":
            continue  # waiting its turn: the epic's card stands for it
        if col == "Done" and t.get("epic"):
            done_groups.setdefault((t.get("project"), "epic: " + t["epic"]), []).append(c)
        elif col == "Done":
            gkey = (t.get("project"), pr_items.get(tid) or prs_mod.pr_number(t.get("ref")) or
                    (re.findall(r"(?<!\d)\d{3,}(?!\d)", str(t.get("ref") or "")) or [_ref_key(t.get("ref"))])[0] or tid)
            done_groups.setdefault(gkey, []).append(c)
        else:
            cards.append(c)
    for gkey, group in done_groups.items():
        group.sort(key=lambda c: c["done_at"] or "")
        prc = next((c for c in cards if c["kind"] == "pr" and c["column"] == "Done" and c["project"] == gkey[0]
                    and c["pr"]["number"] == gkey[1]), None)
        if len(group) == 1 and not prc:
            cards.append(group[0])
            continue
        if prc:
            cards.remove(prc)
        label = prc["text"] if prc else (str(gkey[1]) if str(gkey[1]).startswith("epic: ") else
                                          group[-1]["ref"] or f"#{group[-1]['id']}")
        cards.append(card(id="g-" + "-".join(str(c["id"]) for c in group), kind="group",
                          text=f"{label}: {len(group)} item{'s' if len(group) > 1 else ''} done"
                               + (" · merged" if prc else ""),
                          project=gkey[0], ref=group[-1]["ref"], column="Done", link=prc and prc["link"],
                          done_at=max(c["done_at"] or "" for c in group + ([prc] if prc else [])),
                          result=group[-1]["result"], items=[{"id": c["id"], "title": c["title"], "result": c["result"]}
                                                              for c in reversed(group)]))
    # epics: one card each, with progress and what's next
    for name in sorted({t["epic"] for t in todo if t.get("epic")}):
        items = [t for t in todo if t.get("epic") == name]
        status = {t["id"]: t["status"] for t in todo}
        open_ = [t for t in items if t["status"] != "done"]
        if not open_:
            continue
        ready = [t for t in open_ if all(status.get(x) == "done" for x in t.get("after") or [])]
        busy = any(t["status"] == "doing" or live.get(t["id"]) for t in open_)
        nxt = next((t for t in sorted(ready, key=lambda t: (t["status"] != "open", t["id"])) if t["status"] == "open"), None)
        meta = (epics or {}).get(name) or {}
        progress = []
        for cname in meta.get("counts") or []:
            hist = [h for h in _count_history(meta.get("project") or items[0].get("project")) if h.get("name") == cname]
            if hist:
                progress.append(f"{cname} {hist[0]['total']} → {hist[-1]['total']}" if hist[0]["total"] != hist[-1]["total"]
                                else f"{cname} {hist[-1]['total']}")
        done_n = len(items) - len(open_)
        cards.append(card(id=f"e-{name}", kind="epic", text=f"Epic {name}: {done_n}/{len(items)} done",
                          project=items[0].get("project"), column="In progress" if busy or done_n else "Open",
                          why=None, rest=" · ".join([f"{len(ready)} ready", f"{len(open_) - len(ready)} waiting on others"]
                                                    + progress),
                          action=(f"next: #{nxt['id']} {short_title(nxt['text'])[0]} (lean-agent todo next --epic {name})"
                                  if nxt else None),
                          epic={"done": done_n, "total": len(items), "ready": len(ready), "progress": progress}))
    # reviewed branches without a PR or an item
    for (slug, branch), recs in by_ref.items():
        if (slug, branch) in used_refs or any(_same_ref(branch, b) for p, b in used_refs if p == slug):
            continue
        rv = review_at(slug, branch)
        if not rv or rv.get("branch") or (rv.get("ts") or "") < week_ago:
            continue
        ok = rv.get("verdict") == "approve"
        col = "Waiting on you" if ok or rv.get("gaps") else "In review"
        why = (f"{rv['gaps']} known gap{'s' if rv['gaps'] > 1 else ''} to answer" if rv.get("gaps")
               else "approved, no pull request yet" if ok else None)
        cards.append(card(id=f"v-{slug}-{branch}", kind="review", text=f"branch {branch}", project=slug, ref=branch,
                          column=col, why=why, action=("open a pull request, or merge" if ok and not rv.get("gaps")
                                                       else f"lean-agent review --status {slug} --head {branch}"
                                                       if rv.get("gaps") else None),
                          review=rv, runs=[rv["run"]] if rv.get("run") else []))
    # runs that stopped to ask, which no item card already shows
    shown = {c["last_run"]["id"] for c in cards if c.get("last_run") and c["column"] == "Waiting on you"}
    for r in latest.values():
        st = str(r.get("status") or "").split(":")[0]
        if st not in WAITING or (r.get("ts") or "") < recent or r.get("id") in shown:
            continue
        if r.get("todo") in ids and next((t for t in todo if t["id"] == r["todo"]), {}).get("status") == "done":
            continue
        if r.get("todo") in live:
            continue
        head = next((l.strip() for l in str(r.get("result_head") or r.get("task") or "").splitlines() if l.strip()), "")
        cards.append(card(id=f"q-{r.get('id')}", kind="run", text=head[:300], project=r.get("project"),
                          column="Waiting on you", why="the run " + MEANING[st],
                          action=f"answer it in the orchestrator (read it: lean-agent runs --show {r.get('id')})",
                          runs=[r.get("id")], last_run=_run_info(r)))
    # running runs no item names
    for m in running:
        if m.get("todo") not in ids:
            cards.append(card(id=f"r-{m.get('run')}", kind="lookup", text=str(m.get("task") or "").strip()[:300],
                              project=m.get("project"), column="In progress", live=[m], runs=[m.get("run")]))
    # hand-off notes
    for i, n in enumerate(notes, 1):
        kind = n.get("kind") or ("decision" if DECISION_RE.search(str(n.get("text") or "")) else "reminder")
        cards.append(card(id=f"n{i}", kind="note", note=i, note_kind=kind, text=str(n.get("text") or ""),
                          column="Waiting on you" if kind == "decision" else "Notes", done_at=n.get("ts"),
                          why="decide or answer" if kind == "decision" else None,
                          action=f"tell the orchestrator; it closes the note (lean-agent handoff --done {i})"))
    prio = {"high": 0, "low": 2}
    order = {"note": 2, "run": 1}
    done = sorted((c for c in cards if c["column"] == "Done"), key=lambda c: (c["done_at"] or "", str(c["id"])),
                  reverse=True)
    rest = sorted((c for c in cards if c["column"] != "Done"),
                  key=lambda c: (c["kind"] != "pr", order.get(c["kind"], 0), prio.get(c["prio"], 1), c["due"] or "9999",
                                 str(c["id"]).zfill(8)))
    cards = rest + done
    for c in cards:  # run questions blocked by the same thing share a cause (the inbox groups them)
        lr = c.get("last_run")
        if c["column"] == "Waiting on you" and lr and c["kind"] in ("run", "item") and lr.get("status") in WAITING:
            head = c["text"] if c["kind"] == "run" else (latest.get(lr["id"]) or {}).get("result_head") or ""
            line = next((l.strip() for l in str(head).splitlines() if l.strip()), "")
            c["cause"] = cause_key(line)
            c["cause_label"] = line[:110]
            c["todo"] = c["id"] if c["kind"] == "item" else (latest.get(lr["id"]) or {}).get("todo")
    gone = _json(home("dismissed.json"), {})
    cards = [c for c in cards if not (str(c["id"]) in gone and gone[str(c["id"])].get("sig") in ("", c["sig"]))
             and not any(f"run:{r}" in gone for r in ([c["last_run"]["id"]] if c.get("last_run") and c["column"] ==
                                                       "Waiting on you" and c["kind"] in ("run", "item") else []))]
    return {"columns": list(COLUMNS), "cards": cards,
            "projects": sorted({c["project"] for c in cards if c["project"]})}

def review_rows(week_ago):
    """(every review of the last 300 per project, newest first, each with its branch's state; the review that
    counts per branch). A branch's state ("merged", "gone") is looked up once, for its newest review."""
    paths = {slug: (v or {}).get("path") for slug, v in _json(home("projects.json"), {}).items() if isinstance(v, dict)}
    rows, newest = [], {}
    for f in glob.glob(home("reviews", "*.jsonl")):
        slug = os.path.basename(f)[:-6]
        if "." in slug:
            continue
        for r in _jsonl(f, 300):
            row = {"project": slug, "ref": r.get("ref") or "working tree", "verdict": r.get("verdict"),
                   "ts": r.get("ts"), "run": r.get("run"), "head": str(r.get("head", ""))[:10],
                   "full_head": r.get("head") or "", "gaps": open_gaps(slug, r), "branch": None,
                   "blocking": sum(1 for x in r.get("findings") or [] if x.get("severity") in ("blocker", "major"))}
            rows.append((row, r))
            newest[(slug, row["ref"])] = (row, r)
    for (slug, ref), (row, r) in newest.items():
        if r.get("ref") and str(r.get("ts", "")) >= week_ago:
            state = branch_state(paths.get(slug), r.get("ref"), r.get("head"), r.get("base"))
            for other, _ in rows:
                if other["project"] == slug and other["ref"] == ref:
                    other["branch"] = state
    rows = sorted((row for row, _ in rows), key=lambda r: r["ts"] or "", reverse=True)
    counting = []
    for key in newest:
        same = [r for r in rows if (r["project"], r["ref"]) == key]
        tip = [r for r in same if r["full_head"] == same[0]["full_head"]]
        decided = [r for r in tip if r["verdict"] in ("approve", "changes-requested")]
        counting.append((decided or tip)[0])
    counting.sort(key=lambda r: r["ts"] or "", reverse=True)
    return rows, counting


def poll_inputs():
    """What the PR poller needs: the work queue, the reviews (with branch states) and the project paths."""
    week_ago = (datetime.datetime.now() - datetime.timedelta(days=7)).isoformat()
    paths = {slug: (v or {}).get("path") for slug, v in _json(home("projects.json"), {}).items() if isinstance(v, dict)}
    return _json(home("todo.json"), {}).get("items") or [], review_rows(week_ago)[1], paths


def state():
    now = datetime.datetime.now()
    week_ago = (now - datetime.timedelta(days=7)).isoformat()
    ledger = _jsonl(home("ledger.jsonl"))
    running = []
    for f in glob.glob(home("running", "*.json")):
        m = _json(f, {})
        if _alive(m.get("pid")):
            steps = _jsonl(os.path.join(m.get("workdir") or home("work", str(m.get("run"))), "progress.jsonl"), 1)
            running.append(dict({k: m.get(k) for k in ("run", "started", "model", "effort", "role", "project", "task",
                                                         "todo")}, turns=steps[-1].get("turn") if steps else 0))
    merged = {}  # one row per run: a resumed run (a follow-up, the reviewer sent back) adds a pass
    for r in ledger[-200:]:
        m = merged.get(r.get("id"))
        if m:
            m.update(ts=r.get("ts"), status=r.get("status"), passes=m["passes"] + 1,
                     units=m["units"] + (r.get("units") or 0), cost=(m["cost"] or 0) + (r.get("cost_usd") or 0),
                     head=" ".join(str(r.get("result_head") or m["head"]).split())[:160])
        else:
            merged[r.get("id")] = {"id": r.get("id"), "ts": r.get("ts"), "status": r.get("status"), "model": r.get("model"),
                                   "project": r.get("project"), "role": r.get("role"), "units": r.get("units") or 0,
                                   "cost": r.get("cost_usd"), "turns": r.get("turns"), "passes": 1,
                                   "head": " ".join(str(r.get("result_head") or r.get("task") or "").split())[:160]}
    runs = sorted(merged.values(), key=lambda r: r["ts"] or "", reverse=True)[:25]
    week = [r for r in ledger if str(r.get("ts", "")) >= week_ago]
    todo = _json(home("todo.json"), {}).get("items") or []
    open_todo = sorted([t for t in todo if t.get("status") != "done"],
                       key=lambda t: (t.get("status") != "doing", {"high": 0, "low": 2}.get(t.get("prio"), 1),
                                      t.get("due") or "9999", t.get("id", 0)))
    jobs = []
    for j in lean_schedule.jobs():
        try:
            nxt = lean_schedule.next_run(j) if j.get("enabled", True) else None
        except (ValueError, KeyError, TypeError):
            nxt = None
        jobs.append({"id": j.get("id"), "when": j.get("when"), "cmd": " ".join(j.get("args") or []),
                     "next": nxt.isoformat(timespec="minutes") if nxt else None, "last": j.get("last"),
                     "enabled": j.get("enabled", True)})
    all_reviews, latest_reviews = review_rows(week_ago)
    pushes = {}
    for p_ in _jsonl(home("pushes.jsonl"), 300):
        if p_.get("ts", "") < week_ago:
            continue
        g = pushes.setdefault((p_.get("branch"), p_.get("to")), {"branch": p_.get("branch"), "to": p_.get("to"),
                                                                "count": 0, "failed": 0})
        g["count"] += 1
        g["failed"] += 0 if p_.get("ok") else 1
        g.update(ts=p_.get("ts"), ok=p_.get("ok"))
    real, age = usage.plan_usage()
    pace, ahead = usage.week_pace()
    return {
        "now": now.isoformat(timespec="seconds"),
        "pace": pace, "ahead": ahead, "plan_history": usage.plan_history(8),
        "plan": {k: v for k, v in (real or {}).items() if k in ("five_hour", "seven_day")}, "plan_age_min": age,
        "running": running, "runs": runs,
        "week": {"runs": len(week), "done": sum(r.get("status") == "done" for r in week),
                 "units": sum(r.get("units", 0) for r in week), "cost": round(sum(r.get("cost_usd") or 0 for r in week), 2)},
        "board": board(todo, ledger, running, all_reviews, now, prs.cache(), _json(home("handoff-notes.json"), []),
                       _json(home("todo.json"), {}).get("epics") or {}),
        "finished": [{"id": r.get("id"), "status": str(r.get("status") or "").split(":")[0], "ts": r.get("ts"),
                      "model": r.get("model"), "project": r.get("project"), "todo": r.get("todo"),
                      "task": " ".join(str(r.get("task") or "").split())[:160]}
                     for r in ledger[-20:] if (r.get("ts") or "") >= (now - datetime.timedelta(minutes=3)).isoformat()],
        "last_finished": (ledger[-1].get("ts") if ledger else None),
        "pr_errors": sorted({f"{k}: {v if isinstance(v, str) else v.get('error')}" for k, v in prs.cache().items()
                             if (isinstance(v, str)) or (isinstance(v, dict) and v.get("error"))})[:5],
        "todo": open_todo[:30], "todo_done_week": sum(1 for t in todo if t.get("status") == "done"
                                                      and (t.get("done_at") or "") >= week_ago),
        "schedule": jobs, "scheduled_results": lean_schedule.results_since(week_ago)[-10:][::-1],
        "schedule_runner": schedule_runner(),
        "reviews": [r for r in latest_reviews if not r["branch"]][:12],
        "pushes": sorted(pushes.values(), key=lambda g: g["ts"] or "", reverse=True)[:10],
        "context": orchestrator_context(),
        "service": _service_status(),
        "notes": _json(home("handoff-notes.json"), []),
    }


def running_text(run_id):
    """A run that's still running: its task and its progress so far (it isn't in the ledger until it ends)."""
    m = next((x for x in (_json(f, {}) for f in glob.glob(home("running", "*.json"))) if x.get("run") == run_id), None)
    if not m:
        return None
    workdir = m.get("workdir") or home("work", run_id)
    steps = _jsonl(os.path.join(workdir, "progress.jsonl"), 400)
    started = str(m.get("started", ""))[11:19]
    head = (f"running since {started} · {m.get('model')} · {m.get('project')}"
            + (f" · {m['role']}" if m.get("role") else "")
            + (f" · {steps[-1]['turn']} turns so far, context now ~{steps[-1]['ctx']:,}" if steps else " · starting")
            + ("" if _alive(m.get("pid")) else " · (its process is gone: it may have been stopped)"))
    lines = [head, "", "Task:", str(m.get("task", ""))[:2000], "", f"Latest steps ({len(steps)} turns):" if steps else ""]
    for st in steps[-40:]:
        for x in st.get("steps") or ["(thinking)"]:
            lines.append(f"  {st.get('turn'):>3}  {x}")
    lines.append("\n(click the run again to refresh; its answer shows here when it's done)")
    return "\n".join(lines)


def run_text(run_id, details=False):
    """A run's saved summary (or its details file), for the run view; a running run shows its progress."""
    r = next((x for x in reversed(_jsonl(home("ledger.jsonl"))) if x.get("id") == run_id), None)
    if not r:
        return running_text(run_id)
    if not r.get("workdir"):
        return None
    pattern = "details-*.md" if details else "summary-*.txt"
    files = sorted(glob.glob(os.path.join(r["workdir"], pattern)),
                   key=lambda f: int(re.sub(r"\D", "", os.path.basename(f)) or 0))
    if not files:
        return "(nothing saved for this run)"
    with open(files[-1], errors="replace") as fh:
        return fh.read()


UI_DIR = os.path.join(HERE, "dashboard_ui")
UI_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8"}


def ui_file(name):
    with open(os.path.join(UI_DIR, name), encoding="utf-8") as fh:
        return fh.read()


PAGE = ui_file("index.html")  # the page; its style.css and app.js are served from /ui/


def write_launch_config(cfg=None):
    """The Claude desktop app's preview config in the orchestrator home (.claude/launch.json): an entry for the
    already running dashboard (url and port only; a localhost preview URL can't carry the token). Other entries
    are kept. Returns the file's path."""
    cfg = cfg or settings()
    path = home("home", ".claude", "launch.json")
    data = _json(path, {})
    if not isinstance(data, dict):
        data = {}
    data.setdefault("version", "0.0.1")
    entries = [c for c in data.get("configurations") or [] if isinstance(c, dict) and c.get("name") != "lean-agent dashboard"]
    entries.append({"name": "lean-agent dashboard", "url": f"http://localhost:{cfg['port']}", "port": cfg["port"]})
    data["configurations"] = entries
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
    return path


def browser_same_origin(headers):
    """A request a browser made from the dashboard page itself, or typed into its address bar (Sec-Fetch-Site),
    not from another website and not from a non-browser program."""
    return (headers.get("Sec-Fetch-Site") or "") in ("same-origin", "none")


WATCHED = ("dashboard.py", "usage.py", "lean_schedule.py", "prs.py", "dashboard_ui/index.html", "dashboard_ui/app.js",
           "dashboard_ui/style.css", "dashboard_ui/chat.js")
_LIVE = {"stamp": None, "mod": None}
_LIVE_LOCK = threading.Lock()


def code_stamp():
    return tuple(os.path.getmtime(os.path.join(HERE, f)) for f in WATCHED if os.path.exists(os.path.join(HERE, f)))


def live():
    """This module as it is on disk now. `lean-agent sync` updates the files the running server was started from;
    when they change, the page, the state and their helpers are loaded again, so no restart is needed."""
    import importlib
    import importlib.util
    with _LIVE_LOCK:
        stamp = code_stamp()
        if _LIVE["mod"] is None:
            _LIVE.update(stamp=stamp, mod=sys.modules[__name__])
        elif stamp != _LIVE["stamp"]:
            try:
                importlib.reload(usage)
                importlib.reload(lean_schedule)
                importlib.reload(prs)
                spec = importlib.util.spec_from_file_location(f"lean_agent_dashboard_{int(time.time())}",
                                                              os.path.join(HERE, "dashboard.py"))
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                _LIVE.update(stamp=stamp, mod=mod)
            except Exception:  # a half-written file during a pull: keep serving what works, try again next time
                pass
        return _LIVE["mod"]


def page_version():
    """Changes when the page or its script or style changes: open tabs reload then."""
    import hashlib
    return hashlib.sha1("".join(ui_file(n) for n in sorted(os.listdir(UI_DIR)) if not n.startswith("."))
                        .encode()).hexdigest()[:10]


FORBIDDEN = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,
initial-scale=1"><title>lean-agent dashboard</title><style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",
sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;color:#1d2127;background:#f6f7f9}code{background:#e3e6ea;
padding:1px 5px;border-radius:4px}@media (prefers-color-scheme:dark){body{color:#e7eaee;background:#14171c}code{background:
#2b313a}}</style></head><body><h1 style="font-size:20px">lean-agent dashboard</h1><p>This address needs the dashboard's
token. Open the link that <code>lean-agent dashboard --url</code> prints (it ends in <code>?t=...</code>); it stays the
same between restarts, so you can bookmark it.</p><p>For the Claude desktop app's preview, where a link can't carry the
token: <code>lean-agent dashboard --preview on</code>.</p></body></html>"""


def _j(code, obj):
    return code, json.dumps(obj), "application/json"


def api_get(path, q):
    """(status, body, content type) for the page's GET requests (token already checked)."""
    if path == "/api/state":
        return _j(200, dict(state(), page_version=page_version()))
    if path == "/api/chat":
        import dash_chat
        try:
            since = int((q.get("since") or ["0"])[0])
            return _j(200, dict(dash_chat.chat((q.get("thread") or ["main"])[0]).snapshot(since),
                                threads=dash_chat.threads()))
        except ValueError as e:
            return _j(400, {"ok": False, "error": str(e)})
    m = re.fullmatch(r"/run/([\w-]+)", path)
    if m:
        text = run_text(m.group(1), details=bool(q.get("details")))
        return (200 if text is not None else 404), text or "no such run", "text/plain; charset=utf-8"
    return 404, "not found", "text/plain; charset=utf-8"


def run_action(body):
    """A work-queue or hand-off note change from the page, through the CLI (same rules as everywhere)."""
    import subprocess
    do = body.get("do")
    num = lambda k: str(int(body.get(k)))
    text = lambda k: " ".join(str(body.get(k) or "").split())[:2000]
    try:
        if do == "todo-add":
            if not text("text"):
                return _j(400, {"ok": False, "error": "what? (text)"})
            args = ["todo", "add", text("text")]
            for k, flag in (("project", "-p"), ("ref", "--ref"), ("prio", "--prio"), ("due", "--due"), ("epic", "--epic")):
                if text(k):
                    args += [flag, text(k)]
        elif do in ("todo-start", "todo-reopen", "todo-rm"):
            args = ["todo", do.split("-")[1], num("id")]
        elif do == "todo-done":
            args = ["todo", "done", num("id")] + ([text("result")] if text("result") else [])
        elif do == "todo-edit":
            args = ["todo", "edit", num("id"), text("text")]
        elif do == "todo-note":
            args = ["todo", "note", num("id"), text("text")]
        elif do == "note-add":
            args = ["handoff", "--note", text("text")] + (["--kind", body["kind"]] if body.get("kind") in
                                                          ("decision", "reminder", "fyi") else [])
        elif do == "note-done":
            args = ["handoff", "--done", num("n")]
        elif do == "note-edit":  # the CLI has no edit: rewrite the note's text in place
            notes = _json(home("handoff-notes.json"), [])
            n = int(body.get("n"))
            if not text("text") or not 1 <= n <= len(notes) or not isinstance(notes[n - 1], dict):
                return _j(400, {"ok": False, "error": "no such note, or no text"})
            notes[n - 1]["text"] = text("text")
            with open(home("handoff-notes.json"), "w") as fh:
                json.dump(notes, fh)
            return _j(200, {"ok": True, "output": f"note {n} updated"})
        elif do == "dismiss":  # "Mark handled": hidden until the card changes
            d = _json(home("dismissed.json"), {})
            d[str(body.get("id"))[:200]] = {"sig": str(body.get("sig") or ""), "ts": datetime.datetime.now().isoformat(timespec="seconds")}
            os.makedirs(home(), exist_ok=True)
            with open(home("dismissed.json"), "w") as fh:
                json.dump(d, fh)
            return _j(200, {"ok": True})
        elif do == "run-stop":
            import signal
            run = str(body.get("run") or "")
            m = next((x for x in (_json(f, {}) for f in glob.glob(home("running", "*.json"))) if x.get("run") == run), None)
            if not m or not _alive(m.get("pid")):
                return _j(400, {"ok": False, "error": f"run {run} isn't running"})
            os.kill(int(m["pid"]), signal.SIGTERM)
            return _j(200, {"ok": True, "output": f"stopped run {run}"})
        elif do == "sync":
            args = ["sync"]
        else:
            return _j(400, {"ok": False, "error": f"unknown action {do!r}"})
    except (TypeError, ValueError):
        return _j(400, {"ok": False, "error": "a number is missing"})
    p = subprocess.run([sys.executable, os.path.join(HERE, "lean_agent.py"), *args], capture_output=True, text=True,
                       timeout=600 if do == "sync" else 60, stdin=subprocess.DEVNULL, env=dict(os.environ, LEAN_AGENT_BRIEF="1"))
    out = (p.stdout + p.stderr).strip()
    return _j(200 if p.returncode == 0 else 400, {"ok": p.returncode == 0, "output": out[-1000:]})


def api_post(path, body):
    if path == "/api/action":
        return run_action(body)
    if path.startswith("/api/chat"):
        import dash_chat
        try:
            c = dash_chat.chat(body.get("thread") or "main")
        except ValueError as e:
            return _j(400, {"ok": False, "error": str(e)})
        if path == "/api/chat":
            return _j(200, c.send(body.get("text"), str(body.get("context") or "")[:3000] or None,
                                  str(body.get("title") or "")[:200] or None))
        if path == "/api/chat/answer":
            answers = body.get("answers")
            answers = {str(k): str(v) for k, v in answers.items()} if isinstance(answers, dict) else None
            return _j(200, c.answer(str(body.get("rid")), bool(body.get("allow")), bool(body.get("always")),
                                    body.get("message"), answers))
        if path == "/api/chat/stop":
            return _j(200, c.interrupt())
        if path == "/api/chat/new":
            return _j(200, c.new())
    return _j(404, {"ok": False, "error": "not found"})


class Handler(BaseHTTPRequestHandler):
    token = ""
    preview = False  # the preview's bare address: no token needed for the browser's own requests

    def log_message(self, *args):  # quiet
        pass

    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost", "[::1]"):
            return self._send(403, "lean-agent dashboard: local requests only")
        u = urlparse(self.path)
        q = parse_qs(u.query)
        m = re.fullmatch(r"/ui/([\w-]+\.(?:js|css))", u.path)
        if m:  # the page's own code (it's in the repository, nothing private): no token needed
            mod = live()
            try:
                return self._send(200, mod.ui_file(m.group(1)).replace("__PAGE_VERSION__", mod.page_version()),
                                  UI_TYPES[os.path.splitext(m.group(1))[1]])
            except OSError:
                return self._send(404, "not found")
        if not secrets.compare_digest((q.get("t") or [""])[0], self.token) and not (
                self.preview and browser_same_origin(self.headers)):
            return self._send(403, getattr(live(), "FORBIDDEN", FORBIDDEN), "text/html; charset=utf-8")
        mod = live()
        if u.path == "/":
            return self._send(200, mod.PAGE.replace("__PAGE_VERSION__", mod.page_version()), "text/html; charset=utf-8")
        return self._send(*mod.api_get(u.path, q))

    def do_POST(self):
        """Changes from the page (messages to the orchestrator, work-queue actions): the token in a header (a
        form on another site can't set one), the page's own origin, and JSON."""
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost", "[::1]"):
            return self._send(403, "lean-agent dashboard: local requests only")
        token_ok = secrets.compare_digest(self.headers.get("X-Lean-Agent-Token") or "", self.token)
        origin = self.headers.get("Origin")
        same = (self.headers.get("Sec-Fetch-Site") or "same-origin") == "same-origin" and (
            not origin or urlparse(origin).hostname in ("127.0.0.1", "localhost", "::1"))
        if not same or not (token_ok or self.preview):
            return self._send(403, json.dumps({"ok": False, "error": "not allowed"}), "application/json")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(n, 200000)) or b"{}") if n else {}
        except ValueError:
            return self._send(400, json.dumps({"ok": False, "error": "bad JSON"}), "application/json")
        return self._send(*live().api_post(urlparse(self.path).path, body if isinstance(body, dict) else {}))


def make_server(port=None):
    cfg = settings()
    port = port or cfg["port"]
    Handler.token = cfg["token"]
    Handler.preview = bool(cfg.get("preview"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    if port != cfg.get("port"):
        cfg["port"] = port
        with open(home("dashboard.json"), "w") as fh:
            json.dump(cfg, fh)
    return server


def start_background(port=None):
    """Serve in a daemon thread (from `lean-agent up`); returns the URL, or None if the port is taken."""
    try:
        server = make_server(port)
    except OSError:
        return None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    start_poller()
    return url()


def start_poller():
    """Poll the pull requests the board shows, in the background (LEAN_AGENT_PR_POLL minutes; 0 = off)."""
    if prs.poll_every() > 0:
        threading.Thread(target=prs.poller, args=(lambda: live().poll_inputs(),), daemon=True).start()


def serve(port=None):
    server = make_server(port)
    start_poller()
    print(f"lean-agent dashboard: {url()}  (Ctrl-C stops it)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(serve(int(sys.argv[1]) if len(sys.argv) > 1 else None))
