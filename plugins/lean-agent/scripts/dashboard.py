"""lean-agent's local dashboard: one page on http://127.0.0.1:<port>/?t=<token> that refreshes itself.

It shows what lean-agent's own files say (runs, the work queue, scheduled jobs, reviews, pushes, plan pace, the
orchestrator's context) and nothing else. It listens on 127.0.0.1 only, answers only requests that carry its token
and a local Host header, and never changes anything. `lean-agent up` starts it in the background; `lean-agent
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


def _run_info(r):
    if not r:
        return None
    st = str(r.get("status") or "").split(":")[0]
    return {"id": r.get("id"), "status": st, "ts": r.get("ts"), "role": r.get("role"),
            "meaning": MEANING.get(st, st)}


def board(todo, ledger, running, reviews, now=None, prs=None, notes=()):
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
        if col == "Done":
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
        label = prc["text"] if prc else (group[-1]["ref"] or f"#{group[-1]['id']}")
        cards.append(card(id="g-" + "-".join(str(c["id"]) for c in group), kind="group",
                          text=f"{label}: {len(group)} item{'s' if len(group) > 1 else ''} done"
                               + (" · merged" if prc else ""),
                          project=gkey[0], ref=group[-1]["ref"], column="Done", link=prc and prc["link"],
                          done_at=max(c["done_at"] or "" for c in group + ([prc] if prc else [])),
                          result=group[-1]["result"], items=[{"id": c["id"], "title": c["title"], "result": c["result"]}
                                                              for c in reversed(group)]))
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
        "board": board(todo, ledger, running, all_reviews, now, prs.cache(), _json(home("handoff-notes.json"), [])),
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


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>lean-agent</title>
<style>
:root{--s1:#2a78d6;--s2:#eb6834;--bg:#f6f7f9;--card:#fff;--fg:#1d2127;--mute:#69717d;--line:#e3e6ea;--ok:#1f8f4e;--warn:#b26a00;--bad:#c4323b;--accent:#3559c7;--bar:#dfe4ec}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--s1:#3987e5;--s2:#d95926;--bg:#14171c;--card:#1c2027;--fg:#e7eaee;--mute:#9aa3ae;--line:#2b313a;--ok:#4cc27e;--warn:#e0a03a;--bad:#ee6b72;--accent:#8aa6ff;--bar:#2b313a;color-scheme:dark}}
:root[data-theme=dark]{--s1:#3987e5;--s2:#d95926;--bg:#14171c;--card:#1c2027;--fg:#e7eaee;--mute:#9aa3ae;--line:#2b313a;--ok:#4cc27e;--warn:#e0a03a;--bad:#ee6b72;--accent:#8aa6ff;--bar:#2b313a;color-scheme:dark}
:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
#theme{margin-left:auto;font:inherit;font-size:12px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 10px;cursor:pointer}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:16px 20px 4px}
h1{font-size:18px;margin:0}header .mute{font-size:12px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;padding:12px 20px 24px}
details.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0;overflow-x:auto}
details.card>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::before{content:"\25B8";color:var(--mute);font-size:11px;transition:transform .15s}
details.card[open]>summary::before{transform:rotate(90deg)}
details.card[open]>summary{margin-bottom:8px}
.count{color:var(--mute);font-weight:400;text-transform:none;letter-spacing:0}
.full{grid-column:1/-1}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:0}
.mute{color:var(--mute)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:4px 6px 4px 0;border-top:1px solid var(--line);vertical-align:top}
tr:first-child td{border-top:none}td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.meter{height:8px;background:var(--bar);border-radius:4px;overflow:hidden;margin:4px 0 2px}.meter>div{height:100%;background:var(--accent)}
.meter.warn>div{background:var(--warn)}.meter.bad>div{background:var(--bad)}
.big{font-size:22px;font-weight:600}.row{display:flex;gap:18px;flex-wrap:wrap}
a{color:var(--accent);text-decoration:none;cursor:pointer}a:hover{text-decoration:underline}
pre{white-space:pre-wrap;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;max-height:70vh;overflow:auto}
#view{position:fixed;inset:5vh 5vw;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;display:none;box-shadow:0 10px 40px rgba(0,0,0,.25)}
#view .bar{display:flex;justify-content:space-between;margin-bottom:8px}
svg{display:block;width:100%;height:46px}
td.id{white-space:nowrap}td.head{min-width:10em}.wide2{grid-column:span 2}
.board{display:grid;grid-template-columns:repeat(var(--cols,5),minmax(200px,1fr));gap:10px;overflow-x:auto;padding-bottom:4px}
.col{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;min-width:0}
.col h3{font-size:12px;margin:0 0 8px;color:var(--mute);font-weight:600;display:flex;justify-content:space-between}
.tc{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:13px}
.tc.p-high{border-left-color:var(--bad)}.tc.note{border-left-style:dashed;border-left-color:var(--mute)}.tc.p-low{border-left-color:var(--line)}
.tc.changed{box-shadow:0 0 0 2px var(--warn);background:color-mix(in srgb,var(--warn) 9%,var(--card))}
.tc .title{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tc .why{font-size:12px;color:var(--warn);margin-top:4px}.tc .act{font-size:12px;margin-top:3px;color:var(--mute)}
.tc .act code{font-size:11px}.tc .rest{font-size:12px;color:var(--mute);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tc.k-pr{border-left-color:var(--s1)}.tc.k-note{border-left-style:dashed;border-left-color:var(--mute)}.tc.k-note .title,.tc.k-run .title{-webkit-line-clamp:unset;display:block}
.tc.k-group details{font-size:12px;margin-top:4px}.tc.k-group li{margin:2px 0}.col.wait{border-color:var(--warn)}
.live{display:flex;flex-direction:column;gap:4px;font-size:13px}.live .row{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}
.live .task{flex:1 1 240px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tc .result{font-size:12px;margin-top:4px}
.tc .meta{font-size:12px;color:var(--mute);margin-top:4px;display:flex;flex-wrap:wrap;gap:4px 8px}
.badge{font-size:11px;border-radius:9px;padding:0 6px;border:1px solid currentColor;white-space:nowrap}
.badge.live{color:var(--ok)}.tc .badge{white-space:normal;display:inline-block}.badge.new{color:var(--warn)}
#bfilter{font:inherit;font-size:12px;margin-left:auto;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px}
.plan{display:flex;gap:18px;align-items:flex-start}.plan .stats{flex:0 0 210px}.plan .chart{flex:1;min-width:0;position:relative}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--mute);margin-bottom:2px}
.legend i{display:inline-block;width:14px;height:0;border-top:2px solid;vertical-align:middle;margin-right:5px}
.legend i.band{height:10px;border:none;background:var(--s2);opacity:.18}
#planchart svg{height:auto}#planchart text{font-size:11px;fill:var(--mute)}#planchart text.lbl{fill:var(--fg);font-weight:600}
#ptip{position:absolute;pointer-events:none;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;display:none;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.12)}
@media (max-width:640px){.plan{flex-direction:column}.plan .stats{flex:none}.hide-s{display:none}.wide2{grid-column:auto}main{padding:10px 12px 20px;gap:10px}}
</style></head><body>
<header><h1>lean-agent</h1><span class="mute" id="stamp"></span><button id="theme" type="button" title="switch theme"></button></header>
<main>
 <details class="card full" id="c-live" open><summary><h2>Running now <span class="count" id="n-live"></span></h2></summary><div id="live"></div></details>
 <details class="card full" id="c-board" open><summary><h2>Board <span class="count" id="n-board"></span></h2></summary><div style="display:flex;margin-bottom:8px"><select id="bfilter"><option value="">all projects</option></select></div><div id="board"></div><div class="mute" id="bnote" style="margin-top:4px;font-size:12px"></div></details>
 <details class="card full" id="c-plan" open><summary><h2>Plan usage</h2></summary><div class="plan"><div class="stats"><div id="pace"></div><div id="weekstats" class="mute" style="margin-top:6px"></div></div>
  <div class="chart"><div class="legend"><span><i style="border-color:var(--s1)"></i>week</span><span><i style="border-color:var(--s2)"></i>session</span><span><i class="band"></i>session window (5 h, ends at its right edge)</span><span><i style="border-top-style:dashed;border-color:var(--mute)"></i>on pace</span></div><div id="planchart"></div><div id="ptip"></div></div></div></details>
 <details class="card" id="c-ctx" open><summary><h2>Orchestrator context</h2></summary><div id="ctx"></div></details>
 <details class="card" id="c-sched" open><summary><h2>Scheduled <span class="count" id="n-sched"></span></h2></summary><div id="sched"></div></details>
 <details class="card" id="c-pushes" open><summary><h2>Pushes <span class="count" id="n-pushes"></span></h2></summary><div id="pushes"></div></details>
 <details class="card full" id="c-runs"><summary><h2>Recent runs <span class="count" id="n-runs"></span></h2></summary><div id="runs"></div></details>
</main>
<div id="view"><div class="bar"><b id="vtitle"></b><span><a id="vdet">details</a> · <a onclick="closeView()">close</a></span></div><pre id="vbody"></pre></div>
<script>
const T=new URLSearchParams(location.search).get("t")||"";
const V="__PAGE_VERSION__";  // the server's page changed (lean-agent sync): load the new one
const $=id=>document.getElementById(id);
// theme: follows the system unless you pick light or dark (remembered in this browser)
function setTheme(t){if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else delete document.documentElement.dataset.theme;
  $("theme").textContent="theme: "+(t||"auto");try{t?localStorage.setItem("la-theme",t):localStorage.removeItem("la-theme")}catch(e){}}
{let t=null;try{t=localStorage.getItem("la-theme")}catch(e){}setTheme(t)}
$("theme").onclick=()=>{const cur=document.documentElement.dataset.theme||"";setTheme({"":"light",light:"dark",dark:""}[cur])};
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const k=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1000?(n/1000).toFixed(n>=10000?0:1)+"k":String(n||0);
const when=s=>s?s.slice(5,16).replace("T"," "):"";
const cls=st=>st==="done"?"ok":/fail|error|stopped/.test(st||"")?"bad":/needs|await|partial/.test(st||"")?"warn":"mute";
function meter(p,warnAt,badAt){const c=p>=badAt?"bad":p>=warnAt?"warn":"";return `<div class="meter ${c}"><div style="width:${Math.min(100,p)}%"></div></div>`}
function table(rows,empty){return rows.length?`<table>${rows.join("")}</table>`:`<span class="mute">${empty||"none"}</span>`}
async function show(id,details){
  const r=await fetch(`/run/${encodeURIComponent(id)}?t=${T}${details?"&details=1":""}`);
  $("vtitle").textContent=`run ${id}${details?" · details":""}`;$("vbody").textContent=await r.text();
  $("vdet").onclick=()=>show(id,!details);$("vdet").textContent=details?"answer":"details";$("view").style.display="block";}
function closeView(){$("view").style.display="none"}
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeView()});
// the board highlights cards that changed since you last looked (kept in this browser; a changed card stays
// highlighted for 10 minutes of looking, then counts as seen)
const SEEN_FOR=10*60*1000;
function seenMap(){try{return JSON.parse(localStorage.getItem("la-board-seen")||"null")}catch(e){return null}}
function saveSeen(m){try{localStorage.setItem("la-board-seen",JSON.stringify(m))}catch(e){}}
let lastBoard=null;
const verdict=v=>({approve:"approved","changes-requested":"changes requested","needs-checks":"needs checks"})[v]||v||"";
const ago=t=>{if(!t)return"";const m=Math.max(0,Math.round((Date.now()-Date.parse(t))/60000));return m<60?m+" min":m<1440?Math.round(m/60)+" h":Math.round(m/1440)+" d"};
function drawLive(s){
  const rows=s.running.map(r=>`<div class="row"><a class="badge live" onclick="show('${esc(r.run)}')">running</a><b>${esc(r.model||"?")} / ${esc(r.effort||"default")}</b><span>${esc(r.project||"")}</span><span class="mute">${r.todo!=null?"#"+esc(r.todo):"lookup"}${r.role?" · "+esc(r.role):""}</span><span class="task" title="${esc(r.task)}">${esc(String(r.task||"").split("\n")[0])}</span><span class="mute">${ago(r.started)}${r.turns?" · "+r.turns+" turns":""}</span></div>`)
   .concat((s.finished||[]).filter(f=>!s.running.some(r=>r.run===f.id)).map(f=>`<div class="row"><a class="badge" onclick="show('${esc(f.id)}')">${esc(f.status)}</a><b>${esc(f.model||"")}</b><span>${esc(f.project||"")}</span><span class="mute">${f.todo!=null?"#"+esc(f.todo):"lookup"}</span><span class="task">${esc(f.task)}</span><span class="mute">finished ${when(f.ts).slice(6)}</span></div>`));
  $("live").innerHTML=rows.length?`<div class="live">${rows.join("")}</div>`:`<span class="mute">Nothing running${s.last_finished?" · the last run finished "+when(s.last_finished):""}.</span>`;
  $("n-live").textContent=s.running.length?`· ${s.running.length}`:"";
}
function cardHtml(c,hi){
  const lr=c.last_run,rv=c.review,pr=c.pr;
  const badges=c.live.map(r=>`<a class="badge live" onclick="show('${esc(r.run)}')" title="run ${esc(r.run)}">running · ${esc(r.model||"?")} / ${esc(r.effort||"default")}${r.role?" · "+esc(r.role):""}${r.turns?" · "+r.turns+" turns":""}</a> `).join("")+(hi?`<span class="badge new">${esc(hi)}</span> `:"");
  const label=c.kind==="note"?`note ${c.note}${c.note_kind&&c.note_kind!=="reminder"?" · "+c.note_kind:""}${c.done_at?" · "+ago(c.done_at)+" ago":""}:`:c.kind==="item"?"#"+c.id:c.kind==="lookup"?"lookup:":c.kind==="run"?"run asks:":"";
  const title=c.link?`<a href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.title)}</a>`:esc(c.title);
  let h=`<div class="tc p-${esc(c.prio)} k-${esc(c.kind)}${hi?" changed":""}"><div>${badges}<span class="title" title="${esc(c.text)}"><span class="mute">${esc(label)}</span> ${title}</span></div>`;
  if(c.rest&&c.kind!=="note")h+=`<div class="rest" title="${esc(c.text)}">${esc(c.rest)}</div>`;
  if(c.why)h+=`<div class="why">${esc(c.why)}</div>`;
  if(c.action)h+=`<div class="act">→ ${/^lean-agent /.test(c.action)?`<code>${esc(c.action)}</code>`:esc(c.action)}</div>`;
  if(c.result&&c.kind!=="group")h+=`<div class="result"><span class="ok">result:</span> ${esc(c.result.length>160?c.result.slice(0,160)+"…":c.result)}</div>`;
  if(pr&&c.kind==="pr")h+=`<div class="meta">${pr.ci?`<span class="${pr.ci==="passing"?"ok":pr.ci==="failing"?"bad":"warn"}">CI ${esc(pr.ci)}</span>`:""}${pr.approval?`<span>${esc(pr.approval)}</span>`:""}${pr.my_vote?`<span>your vote: ${esc(pr.my_vote)}</span>`:""}${pr.comments?`<span>${pr.comments} thread${pr.comments>1?"s":""}${pr.last_comment?", last "+when(pr.last_comment):""}</span>`:""}<span title="checked ${esc(pr.fetched||"")}">checked ${ago(pr.fetched)} ago</span></div>`;
  else if(pr)h+=`<div class="meta"><span>on PR ${esc(pr.number)}</span></div>`;
  const m=[c.project,c.kind!=="pr"&&c.kind!=="review"?c.ref:"",c.prio!=="normal"?c.prio:"",c.due?"due "+c.due:"",c.notes?c.notes+" note"+(c.notes>1?"s":""):""].filter(Boolean);
  if(m.length)h+=`<div class="meta">${m.map(x=>`<span class="${x==="high"?"bad":""}">${esc(x)}</span>`).join("")}</div>`;
  if(c.runs.length&&c.kind!=="lookup")h+=`<div class="meta">${c.runs.map(id=>`<a onclick="show('${esc(id)}')">${esc(id)}</a>`).join(" ")}${lr&&!c.live.length?` <span class="${cls(lr.status)}" title="${esc(lr.meaning)}">${esc(lr.status)} · ${esc(when(lr.ts).slice(6))}</span>${c.column!=="Waiting on you"?` <span class="mute">${esc(lr.meaning)}</span>`:""}`:""}</div>`;
  if(rv&&c.column!=="Done")h+=`<div class="meta"><span class="${rv.verdict==="approve"?(rv.gaps?"warn":"ok"):"bad"}">review: ${esc(verdict(rv.verdict))}</span>${rv.stale?`<span class="warn">older than the tip</span>`:""}${rv.blocking?`<span>${rv.blocking} blocking</span>`:""}<span class="mute">${esc(when(rv.ts))}</span></div>`;
  if(c.kind==="group")h+=`<details><summary class="mute">${c.items.length} items · latest: ${esc(c.result||"")}</summary><ul style="padding-left:16px;margin:4px 0">${c.items.map(x=>`<li><span class="mute">#${esc(x.id)}</span> ${esc(x.title)}${x.result?` <span class="ok">→ ${esc(x.result)}</span>`:""}</li>`).join("")}</ul></details>`;
  return h+"</div>";
}
function drawBoard(b){
  if(!b)return;lastBoard=b;
  const f=$("bfilter"),cur=f.value;
  f.innerHTML='<option value="">all projects</option>'+b.projects.map(p=>`<option${p===cur?" selected":""}>${esc(p)}</option>`).join("");
  let seen=seenMap();const first=!seen;seen=seen||{};const now=Date.now(),looking=document.visibilityState!=="hidden";
  const cards=b.cards.filter(c=>!f.value||!c.project||c.project===f.value);let changed=0;
  const cols=b.columns.filter(col=>col==="Waiting on you"||cards.some(c=>c.column===col));
  const html=cols.map(col=>{const cs=cards.filter(c=>c.column===col);return `<div class="col${col==="Waiting on you"&&cs.length?" wait":""}"><h3><span>${esc(col==="Done"?"Done (7 days)":col)}</span><span>${cs.length||""}</span></h3>${cs.map(c=>{
    const was=seen[c.id];let hi="";
    if(first||(was&&was.sig===c.sig)){seen[c.id]={sig:c.sig,col:c.column}}
    else{const since=(was&&was.since)||now;seen[c.id]=Object.assign({},was||{},{since});
      if(looking&&now-since>SEEN_FOR)seen[c.id]={sig:c.sig,col:c.column};else{hi=was?(was.col&&was.col!==c.column?"moved from "+was.col:"changed"):"new";changed++}}
    return cardHtml(c,hi)}).join("")||(col==="Waiting on you"?'<span class="mute" style="font-size:12px">nothing waits on you</span>':"")}</div>`}).join("");
  for(const id of Object.keys(seen))if(!b.cards.some(c=>String(c.id)===id))delete seen[id];
  saveSeen(seen);
  $("board").innerHTML=b.cards.length?`<div class="board" style="--cols:${cols.length}">${html}</div>`:'<span class="mute">No work queued yet: items from <code>lean-agent todo</code> show here, with the runs (<code>run --todo N</code>), pull requests and reviews of their ref.</span>';
  $("n-board").textContent=(cards.length?`· ${cards.length}`:"")+(changed?` · ${changed} changed`:"");
}
$("bfilter").addEventListener("change",()=>{try{localStorage.setItem("la-board-project",$("bfilter").value)}catch(e){};drawBoard(lastBoard)});
// the plan's own numbers over the current week: the week % against the on-pace line, and each 5-hour session
// window (a band from its start to its end) with the session % inside it
let lastPlan=null,planPts=[],planX=null;
function drawPlan(s){
  const box=$("planchart"),now=Date.now()/1000,H=190,W=Math.max(280,box.clientWidth||600),L=34,R=74,T=18,B=22;
  const pts=(s.plan_history||[]).slice();const cur={t:now};
  if(s.plan.five_hour)cur.five_hour=[s.plan.five_hour.pct,s.plan.five_hour.resets_at];
  if(s.plan.seven_day)cur.seven_day=[s.plan.seven_day.pct,s.plan.seven_day.resets_at];
  if(!pts.length&&(cur.five_hour||cur.seven_day))pts.push(cur);
  if(!pts.length){box.innerHTML='<span class="mute">No plan numbers yet: they come with every worker run (or <code>lean-agent limits --refresh</code>), and the graph fills in from then on.</span>';return}
  const wr=(cur.seven_day&&cur.seven_day[1])||Math.max(0,...pts.map(p=>p.seven_day?p.seven_day[1]||0:0));
  const end=wr&&wr>now?wr:now,start=end-7*86400;
  const x=t=>L+(Math.min(end,Math.max(start,t))-start)/(end-start)*(W-L-R),y=p=>T+(1-Math.min(100,p)/100)*(H-T-B);
  let g="";
  for(const p of [0,25,50,75,100])g+=`<line x1="${L}" x2="${W-R}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line)"/><text x="${L-6}" y="${y(p)+4}" text-anchor="end">${p}%</text>`;
  const d0=new Date(start*1000);d0.setHours(24,0,0,0);
  for(let d=d0.getTime()/1000;d<end;d+=86400){const xd=x(d);g+=`<line x1="${xd}" x2="${xd}" y1="${T}" y2="${H-B}" stroke="var(--line)" stroke-dasharray="2 3"/>`;
    if(x(d+43200)<W-R-60&&x(d+43200)>L+60)g+=`<text x="${x(d+43200)}" y="${H-6}" text-anchor="middle">${new Date(d*1000).toLocaleDateString(undefined,{weekday:"short"})}</text>`}
  g+=`<text x="${x(start)}" y="${H-6}">${dhm(start)}</text><text x="${x(end)}" y="${H-6}" text-anchor="end">${wr&&wr>now?"resets ":""}${dhm(end)}</text>`;
  const resets=[...new Set(pts.filter(p=>p.five_hour&&p.five_hour[1]).map(p=>p.five_hour[1]))];
  for(const r of resets){if(r<start)continue;const a=x(r-5*3600),b=x(r),live=r>now;
    g+=`<rect x="${a+1}" y="${T}" width="${Math.max(1,b-a-2)}" height="${H-T-B}" fill="var(--s2)" opacity="${live?.2:.09}"/>`;
    if(live)g+=`<text x="${Math.min(b,W-R)}" y="${T-5}" text-anchor="middle">session ends ${hm(r)}</text>`}
  g+=`<line x1="${x(start)}" y1="${y(0)}" x2="${x(end)}" y2="${y(100)}" stroke="var(--mute)" stroke-dasharray="4 4" stroke-opacity=".7"/>`;
  const path=(list,key)=>list.length?`<polyline fill="none" stroke="var(--${key==="seven_day"?"s1":"s2"})" stroke-width="2" stroke-linejoin="round" points="${list.map(p=>x(p.t).toFixed(1)+","+y(p[key][0]).toFixed(1)).join(" ")}"/>`:"";
  const sorted=pts.concat(pts.length&&pts[pts.length-1].t<now-60&&(cur.five_hour||cur.seven_day)?[cur]:[]).sort((a,b)=>a.t-b.t);
  for(const r of resets)g+=path(sorted.filter(p=>p.five_hour&&p.five_hour[1]===r&&p.t>=r-5*3600),"five_hour");
  g+=path(sorted.filter(p=>p.seven_day&&p.t>=start),"seven_day");
  const xn=x(now);g+=`<line x1="${xn}" x2="${xn}" y1="${T}" y2="${H-B}" stroke="var(--fg)" stroke-opacity=".35"/>`;
  const lastOf=key=>[...sorted].reverse().find(p=>p[key]&&(key!=="five_hour"||!p[key][1]||p[key][1]>now));
  const labels=[["seven_day","week"],["five_hour","session"]].map(([key,name])=>{const p=lastOf(key);return p&&{key,name,v:p[key][0],px:x(p.t),py:y(p[key][0])}}).filter(Boolean);
  if(labels.length===2&&Math.abs(labels[0].py-labels[1].py)<13){const [a,b]=labels[0].py<=labels[1].py?labels:[labels[1],labels[0]];b.ly=a.py+13;}
  for(const l of labels)g+=`<circle cx="${l.px}" cy="${l.py}" r="4" fill="var(--${l.key==="seven_day"?"s1":"s2"})" stroke="var(--card)" stroke-width="2"/><text class="lbl" x="${l.px+8}" y="${(l.ly||l.py)+4}">${l.name} ${Math.round(l.v)}%</text>`;
  g+=`<line id="pcross" y1="${T}" y2="${H-B}" stroke="var(--fg)" stroke-opacity=".5" visibility="hidden"/><rect id="phit" x="${L}" y="0" width="${W-L-R}" height="${H}" fill="transparent"/>`;
  const few=(s.plan_history||[]).length<6;
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Plan usage this week: week and session window percent over time">${g}</svg>`
    +(few?`<div class="mute" style="font-size:12px">The history starts ${pts.length?dhm(pts[0].t):"now"}: each worker run adds the plan's numbers as Claude reports them, so the lines fill in as you work.</div>`:"");
  planPts=sorted;planX=x;
  const hit=$("phit"),tip=$("ptip"),cross=$("pcross");
  hit.addEventListener("mousemove",e=>{const r=box.getBoundingClientRect(),mx=e.clientX-r.left;
    const p=planPts.reduce((a,b)=>Math.abs(planX(b.t)-mx)<Math.abs(planX(a.t)-mx)?b:a);
    cross.setAttribute("x1",planX(p.t));cross.setAttribute("x2",planX(p.t));cross.setAttribute("visibility","visible");
    tip.innerHTML=`<b>${dhm(p.t)}</b><br>${p.seven_day?`week ${p.seven_day[0]}%`:""}${p.five_hour?`${p.seven_day?" · ":""}session ${p.five_hour[0]}%${p.five_hour[1]?" (ends "+hm(p.five_hour[1])+")":""}`:""}`;
    tip.style.display="block";tip.style.left=Math.min(planX(p.t)+10,W-tip.offsetWidth)+"px";tip.style.top=(box.offsetTop+8)+"px"});
  hit.addEventListener("mouseleave",()=>{tip.style.display="none";cross.setAttribute("visibility","hidden")});
}
const hm=t=>new Date(t*1000).toTimeString().slice(0,5), dhm=t=>new Date(t*1000).toLocaleDateString(undefined,{weekday:"short"})+" "+hm(t);
window.addEventListener("resize",()=>{if(lastPlan)drawPlan(lastPlan)});
async function load(){
  let s;try{const r=await fetch(`/api/state?t=${T}`);if(!r.ok)throw new Error(r.status);s=await r.json()}
  catch(e){$("stamp").textContent="can't reach lean-agent ("+e.message+"): is `lean-agent up` or `lean-agent dashboard` running?";return}
  if(s.page_version&&s.page_version!==V){location.reload();return}
  $("stamp").textContent="updated "+s.now.slice(11,19)+" · refreshes every 15 s";
  const wk=s.plan.seven_day, ses=s.plan.five_hour;
  $("pace").innerHTML=(wk?`<div class="big">${Math.round(wk.pct)}%</div><div class="mute">of your weekly plan${wk.resets_at?" · resets "+dhm(wk.resets_at):""}</div>${meter(wk.pct,70,90)}`:'<span class="mute">plan usage not seen yet (it comes with every worker run)</span>')
    +(s.pace?`<div class="${s.ahead?"warn":"ok"}">${esc(s.pace)}</div>`:"")
    +(ses?`<div class="${ses.pct>=70?"warn":"mute"}" style="margin-top:6px">session window ${Math.round(ses.pct)}%`
      +(ses.resets_at?` · ends ${hm(ses.resets_at)}`:"")+(ses.pct>=70?" · prefer haiku and small steps until then":"")
      +`</div>${meter(ses.pct,70,90)}`:"");
  $("weekstats").innerHTML=`${s.week.runs} runs (${s.week.done} done) · ${k(s.week.units)} sonnet-eq · $${s.week.cost} · ${s.todo_done_week} todos done`;
  lastPlan=s;drawPlan(s);
  const c=s.context;
  if(c&&c.calls){const p=Math.round(c.now*100/c.compact_at),max=Math.max(...c.trend,c.compact_at),w=c.trend.length;
    const pts=c.trend.map((v,i)=>`${(i/(Math.max(1,w-1))*100).toFixed(1)},${(46-v/max*44).toFixed(1)}`).join(" ");
    $("ctx").innerHTML=`<div class="big">${k(c.now)} <span class="mute" style="font-size:14px">/ ${k(c.compact_at)} before compaction</span></div>${meter(p,70,85)}
      <svg viewBox="0 0 100 46" preserveAspectRatio="none"><line x1="0" x2="100" y1="${(46-c.compact_at/max*44).toFixed(1)}" y2="${(46-c.compact_at/max*44).toFixed(1)}" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/><polyline fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts}"/></svg>
      <div class="mute">${c.calls} calls in the latest conversation · last ${when(c.updated)}</div>`}
  else $("ctx").innerHTML='<span class="mute">no orchestrator conversation yet</span>';
  if(lastBoard===null){try{const p=localStorage.getItem("la-board-project");if(p)$("bfilter").innerHTML=`<option value="">all projects</option><option selected>${esc(p)}</option>`}catch(e){}}
  drawBoard(s.board);
  $("bnote").textContent="View only: cards follow the work queue (lean-agent todo, run --todo N), pull requests (polled with gh / az every few minutes), reviews and hand-off notes. Hover for full text. Highlighted: changed since you last looked."
    +(s.pr_errors&&s.pr_errors.length?" PR polling: "+s.pr_errors.join("; "):"");
  drawLive(s);
  $("runs").innerHTML=table(s.runs.map(r=>`<tr><td class="id"><a onclick="show('${esc(r.id)}')">${esc(r.id)}</a></td><td class="${cls(r.status)}" title="${esc(r.status)}">${esc((r.status||"").split(":")[0])}</td><td class="hide-s">${esc(r.model)}</td><td class="hide-s">${esc(r.project)}${r.role?` <span class="mute">${esc(r.role)}</span>`:""}</td><td class="head">${r.passes>1?`<span class="mute">${r.passes} passes</span> `:""}${esc(r.head)}</td><td class="n">${k(r.units)}</td><td class="n mute hide-s">${r.cost!=null?"$"+r.cost.toFixed(2):""}</td></tr>`));
  $("sched").innerHTML=table(s.schedule.map(j=>`<tr><td class="mute">#${j.id}</td><td>${esc(j.when)}</td><td><code>${esc(j.cmd)}</code></td><td class="n mute">${j.enabled?(j.next?"next "+when(j.next):""):"paused"}<br>${j.last?"last "+when(j.last):"never ran yet"}</td></tr>`))
    +`<div class="mute" style="margin-top:6px">${esc(s.schedule_runner||"")}</div>`
    +(s.scheduled_results.length?'<div class="mute" style="margin-top:8px">Recent results</div>'+table(s.scheduled_results.map(r=>`<tr><td class="mute">#${r.id}</td><td class="${r.rc?"bad":"ok"}">exit ${r.rc}</td><td>${esc(r.first)}</td><td class="n mute">${when(r.ts)}</td></tr>`)):"");
  const same=p=>String(p.to||"").replace(/^origin\//,"")===p.branch;
  $("pushes").innerHTML=table(s.pushes.map(p=>`<tr><td>${esc(p.branch)}${same(p)?"":" → "+esc(p.to)}</td><td class="n">${p.count} push${p.count>1?"es":""}${p.failed?` <span class="bad">${p.failed} failed</span>`:""}</td><td class="n mute">last ${when(p.ts)}</td></tr>`),"none this week");
  const counts={runs:s.runs.length,sched:s.schedule.length,pushes:s.pushes.length};
  for(const [k2,n] of Object.entries(counts)) $("n-"+k2).textContent=n?`· ${n}`:"";
}
// each box remembers whether it's open, in this browser only (and works without storage)
for(const d of document.querySelectorAll("details.card")){
  try{const v=localStorage.getItem("la-open-"+d.id);if(v!==null)d.open=v==="1"}catch(e){}
  d.addEventListener("toggle",()=>{try{localStorage.setItem("la-open-"+d.id,d.open?"1":"0")}catch(e){}});
}
load();setInterval(load,15000);
</script></body></html>"""


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


WATCHED = ("dashboard.py", "usage.py", "lean_schedule.py", "prs.py")
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
    import hashlib
    return hashlib.sha1(PAGE.encode()).hexdigest()[:10]


FORBIDDEN = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,
initial-scale=1"><title>lean-agent dashboard</title><style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",
sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;color:#1d2127;background:#f6f7f9}code{background:#e3e6ea;
padding:1px 5px;border-radius:4px}@media (prefers-color-scheme:dark){body{color:#e7eaee;background:#14171c}code{background:
#2b313a}}</style></head><body><h1 style="font-size:20px">lean-agent dashboard</h1><p>This address needs the dashboard's
token. Open the link that <code>lean-agent dashboard --url</code> prints (it ends in <code>?t=...</code>); it stays the
same between restarts, so you can bookmark it.</p><p>For the Claude desktop app's preview, where a link can't carry the
token: <code>lean-agent dashboard --preview on</code>.</p></body></html>"""


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
        if not secrets.compare_digest((q.get("t") or [""])[0], self.token) and not (
                self.preview and browser_same_origin(self.headers)):
            return self._send(403, getattr(live(), "FORBIDDEN", FORBIDDEN), "text/html; charset=utf-8")
        mod = live()
        if u.path == "/":
            return self._send(200, mod.PAGE.replace("__PAGE_VERSION__", mod.page_version()), "text/html; charset=utf-8")
        if u.path == "/api/state":
            return self._send(200, json.dumps(dict(mod.state(), page_version=mod.page_version())), "application/json")
        m = re.fullmatch(r"/run/([\w-]+)", u.path)
        if m:
            text = mod.run_text(m.group(1), details=bool(q.get("details")))
            return self._send(200 if text is not None else 404, text or "no such run")
        return self._send(404, "not found")


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
