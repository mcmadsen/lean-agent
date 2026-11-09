"""`lean-agent pr`: PR status per thread. Known state from lean-agent's own records (no network), live state from one
read-only haiku helper (role pr-status), cached per PR in <home>/pr-cache.json. Pure logic here; lean_agent.py gathers the
records and starts the helper."""
import json
import os
import re
import time
import urllib.parse

import lean_common

CACHE_MINUTES = 10
FETCH_CAP_SECONDS = 180
ROLE = "pr-status"
AZ_CMDS = ["az repos pr show", "az repos pr list", "az repos pr policy list", "az devops invoke --http-method get", "az account show",
           "az devops user show", "az pipelines runs list", "az pipelines runs show"]
GH_CMDS = ["gh pr view", "gh pr list", "gh pr checks", "gh pr diff", "gh api --method GET", "gh api user", "gh run view", "gh run list"]
MODES = ("status", "comments", "ci", "diff")   # per-PR sections the helper can read
QUERIES = ("mine", "stale", "find")            # project-wide lists
HEAD = ("PR", "Title", "Known state", "Last review", "Last push", "Next")


def flavour_of(url):
    """'az' for Azure DevOps remotes, 'gh' for GitHub, '' otherwise."""
    u = str(url or "").lower()
    if "dev.azure.com" in u or "visualstudio.com" in u:
        return "az"
    if "github.com" in u:
        return "gh"
    return ""


def allow_cmds(flavours):
    out = []
    for f in sorted(set(flavours)):
        out += AZ_CMDS if f == "az" else GH_CMDS if f == "gh" else []
    return out


def cache_minutes():
    for v in (os.environ.get("LEAN_AGENT_PR_CACHE_MINUTES"), (lean_common.read_json(lean_common.lean_home("config.json"), {}) or {}).get("pr-cache-minutes"),
              (lean_common.read_json(lean_common.lean_home("config.json"), {}) or {}).get("pr_cache_minutes")):
        try:
            if v is not None and float(v) >= 0:
                return float(v)
        except (TypeError, ValueError):
            pass
    return CACHE_MINUTES


def cache_path():
    return lean_common.lean_home("pr-cache.json")


def load_cache():
    c = lean_common.read_json(cache_path(), {})
    return c if isinstance(c, dict) else {}


def key(project, pr):
    return f"{project}:{pr}"


def save_live(rows, now=None, section="status"):
    """Store the helper's per-PR rows ({pr, project, ...}) with the time; a section (comments, ci, diff) is stamped in `_t`."""
    now = time.time() if now is None else now
    path = cache_path()
    with lean_common.file_lock(path):
        cache = load_cache()
        for r in rows:
            k = key(r.get("project") or "", r["pr"])
            old = cache.get(k) or {}
            stamps = dict(old.get("_t") or {})
            if section == "status" and not any("text" in t for t in r.get("threads") or [] if isinstance(t, dict)):
                stamps.pop("comments", None)
            if section != "status":
                stamps[section] = now
            new = dict(old, **r)
            new.update(fetched=now, _t=stamps)
            cache[k] = new
        lean_common.write_json_atomic(path, cache)


def save_query(kind, project, rows, me="", now=None):
    now = time.time() if now is None else now
    path = cache_path()
    with lean_common.file_lock(path):
        cache = load_cache()
        cache[f"_q:{kind}:{project}"] = {"fetched": now, "rows": rows, "me": me}
        lean_common.write_json_atomic(path, cache)


def query_of(kind, project, cache=None):
    return (cache if cache is not None else load_cache()).get(f"_q:{kind}:{project}")


def live_of(project, pr, cache=None):
    return (cache if cache is not None else load_cache()).get(key(project, str(pr)))


def age_text(fetched, now=None):
    s = max(0, (time.time() if now is None else now) - float(fetched or 0))
    return f"{int(s // 3600)}h" if s >= 3600 else f"{int(s // 60)}m" if s >= 60 else "now"


def fresh(live, now=None, section=None):
    t = (live or {}).get("_t", {}).get(section) if section else (live or {}).get("fetched")
    return bool(live) and (time.time() if now is None else now) - float(t or 0) < cache_minutes() * 60


def parse_rows(text):
    """The helper's `LEAN-PR {"prs": [...]}` payload (dict or JSON text) as a list of rows that name a PR."""
    data = text
    if isinstance(text, str):
        try:
            data = json.loads(text)
        except ValueError:
            return []
    rows = (data or {}).get("prs") if isinstance(data, dict) else data
    out = []
    for r in rows or []:
        if isinstance(r, dict) and str(r.get("pr") or "").strip():
            out.append(dict(r, pr=str(r["pr"]).strip().lstrip("#!")))
    return out


ROW_JSON = ('{"pr": "N", "url": "web url of the PR", "status": "active|completed|abandoned", "isDraft": false, "title": "...", "author": "...", '
            '"target": "main", "merge": "succeeded|conflicts|queued|unknown", "reviewers": [{"name": "...", "vote": "approved|suggestions|waiting|rejected|none"}], '
            '"ci": "passed|failed|running|none|unknown", "threads": [{"id": "1", "author": "...", "file": "path", "line": 0, "gist": "<= 90 chars", '
            '"kind": "human|bot"%s}]%s}')
EXTRA = {
    "status": ("", ""),
    "comments": (', "text": "the comment, <= 400 chars", "created": "ISO time"', ""),
    "ci": ("", ', "checks": [{"name": "...", "state": "failed|running|queued|passed|approved|rejected|notapplicable", "kind": "policy|build", "link": "url"}], '
               '"build": {"result": "failed|succeeded|running|canceled|none", "link": "url to the log or run"}'),
    "diff": ("", ', "files": [{"path": "...", "added": 0, "deleted": 0}]'),
}
MODE_HELP = {
    "status": {"az": "", "gh": ""},
    "comments": {"az": "Also give every ACTIVE comment thread in full: the text (<= 400 chars), created time, file, line, author.",
                 "gh": "Also give every ACTIVE comment thread in full: the text (<= 400 chars), created time, file, line, author."},
    "ci": {"az": "Also list every policy evaluation and CI check with its state (`az repos pr policy list --id N`; `az pipelines runs list --branch <source branch> --top 1` "
                 "and `az pipelines runs show` for the latest build), and the latest build's result with the link to its log/run.",
           "gh": "Also list every CI check with its state (`gh pr checks N`), and the latest run's result with the link to its log (`gh run list --branch <source branch> --limit 1`)."},
    "diff": {"az": "Also list the changed files with added/deleted line counts against the target branch: prefer `git -C <dir> diff --numstat <target>...<source>` "
                   "with refs that already exist locally (try origin/<branch> too; you cannot fetch); else the PR's iteration changes (az devops invoke --http-method get "
                   "--area git --resource pullRequestIterationChanges; counts may then be 0).",
             "gh": "Also list the changed files with added/deleted line counts against the target branch: prefer `git -C <dir> diff --numstat <target>...<source>` "
                   "with refs that already exist locally (try origin/<branch> too; you cannot fetch); else `gh pr view N --json files` (has additions/deletions)."},
}


def prompt(entries, mode="status"):
    """The helper's rule: which PRs, how to read each, what to answer."""
    if mode in QUERIES:
        return query_prompt(entries[0], mode)
    lines = []
    for e in entries:
        how = ("`az repos pr show --id N`, `az repos pr policy list --id N`, and the comment threads with "
               "`az devops invoke --http-method get --area git --resource pullRequestThreads --route-parameters project=<project> "
               "repositoryId=<repo> pullRequestId=N`" if e["flavour"] == "az" else
               "`gh pr view N --json state,isDraft,title,author,baseRefName,mergeable,reviewDecision,reviews,statusCheckRollup,url` and the "
               "review threads with `gh api --method GET repos/<owner>/<repo>/pulls/N/comments`")
        lines.append(f"- PR {e['pr']} (project dir {e['path']}, remote {e.get('remote') or '?'}): {how}")
    ex = EXTRA.get(mode, EXTRA["status"])
    return (
        "You report the live state of pull requests. You are strictly read-only: only the listed show/list/GET commands; never "
        "comment, vote, approve, complete, abandon or change anything. Run `git -C <dir> remote get-url origin` if you need "
        "the organisation/repository. Be quick: at most one or two commands per PR. " + " ".join(sorted({MODE_HELP.get(mode, MODE_HELP["status"])[e["flavour"]] for e in entries if e.get("flavour") in ("az", "gh")})) + "\nPRs:\n" + "\n".join(lines) + "\n"
        "Answer with one line exactly like this (valid JSON, one line) before the LEAN-FEEDBACK line; one object per PR, "
        "threads = only ACTIVE (unresolved) comment threads, at most 15 per PR, gist <= 90 chars, kind human or bot "
        "(bot = a build, policy or service account):\n"
        'LEAN-PR {"prs": [' + ROW_JSON % ex + ']}\n')


QUERY_HELP = {
    "mine": {"az": "List the OPEN PRs where the signed-in user is a reviewer: `az repos pr list --status active --reviewer <me>`.",
             "gh": "List the OPEN PRs where the signed-in user is a reviewer: `gh pr list --search review-requested:@me`."},
    "stale": {"az": "List the signed-in user's OWN open PRs: `az repos pr list --status active --creator <me>`.",
              "gh": "List the signed-in user's OWN open PRs: `gh pr list --author @me --state open`."},
    "find": {"az": "List the project's open PRs (at most 100, newest first): `az repos pr list --status active --top 100`.",
             "gh": "List the project's open PRs (at most 100, newest first): `gh pr list --state open --limit 100 --json ...`."},
}
EXTRA_Q = {"mine": "Give `myVote` = the signed-in user's own vote on each (approved|suggestions|waiting|rejected|none).",
           "stale": "Give `updated` = the time of the PR's last activity (latest comment, push or vote; else its creation) as an ISO time.",
           "find": "Give author, reviewers with votes, source branch and the linked work item ids."}
ME_HELP = {"az": "Find who the signed-in user is: `az account show --query user.name` (or `az devops user show --user me`). ",
           "gh": "Find who the signed-in user is: `gh api user`. "}
QUERY_ROW = ('{"pr": "N", "url": "web url", "title": "...", "author": "...", "status": "active", "isDraft": false, "branch": "source branch", '
             '"reviewers": [{"name": "...", "vote": "approved|suggestions|waiting|rejected|none"}], "myVote": "none", "updated": "ISO time", "workItems": ["123"]}')


def query_prompt(e, kind):
    f = e.get("flavour") if e.get("flavour") in ("az", "gh") else "gh"
    who = ME_HELP[f] if kind != "find" else ""
    return (f"You list pull requests of one project. You are strictly read-only: only the listed show/list/GET commands; never comment, vote, approve, "
            f"complete, abandon or change anything. Project dir {e['path']}, remote {e.get('remote') or '?'} "
            f"({'Azure DevOps: use az repos/az devops' if f == 'az' else 'GitHub: use gh'}). " + who + QUERY_HELP[kind][f] + " " + EXTRA_Q[kind] +
            " Be quick: one or two commands.\n"
            'Answer with one line exactly like this (valid JSON, one line) before the LEAN-FEEDBACK line (me = the signed-in user\'s name or login):\n'
            'LEAN-PR {"me": "...", "prs": [' + QUERY_ROW + ']}\n')


def web_url(remote, pr):
    """The PR's web page from a git remote URL ('' when the host is not Azure DevOps or GitHub)."""
    u = str(remote or "").strip()
    q = lambda x: urllib.parse.quote(x, safe="")
    m = (re.match(r"^https?://(?:[^@/]+@)?dev\.azure\.com/([^/]+)/([^/]+)/_git/([^/?#]+)", u)
         or re.match(r"^(?:ssh://)?git@ssh\.dev\.azure\.com:(?:22/)?v3/([^/]+)/([^/]+)/([^/?#]+)", u)
         or re.match(r"^(?:ssh://)?[^@]+@vs-ssh\.visualstudio\.com:(?:22/)?v3/([^/]+)/([^/]+)/([^/?#]+)", u))
    if m:
        return f"https://dev.azure.com/{q(m.group(1))}/{q(urllib.parse.unquote(m.group(2)))}/_git/{q(urllib.parse.unquote(m.group(3)))}/pullrequest/{pr}"
    m = re.match(r"^https?://(?:[^@/]+@)?([^./]+)\.visualstudio\.com/(?:DefaultCollection/)?([^/]+)/_git/([^/?#]+)", u)
    if m:
        return f"https://{m.group(1)}.visualstudio.com/{q(urllib.parse.unquote(m.group(2)))}/_git/{q(urllib.parse.unquote(m.group(3)))}/pullrequest/{pr}"
    m = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?/?$", u)
    if m:
        return f"https://github.com/{m.group(1)}/{m.group(2)}/pull/{pr}"
    return ""


def link(pr, remote, live=None):
    """`[512](url)` (the URL the live data returned, else built from the remote), or the bare number."""
    url = (live or {}).get("url") or web_url(remote, pr)
    return f"[{pr}]({url})" if url else str(pr)


def iso_epoch(text):
    import datetime
    try:
        d = datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
        return (d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)).timestamp()
    except ValueError:
        return 0.0


def ago(iso, now=None):
    e = iso_epoch(iso)
    return age_text(e, now) + " ago" if e else "-"


def short(text, n):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[:n - 1] + "…"


def open_threads(live):
    return [t for t in (live or {}).get("threads") or [] if isinstance(t, dict)]


def known_state(e):
    """'goal active, 2 findings open' from the records (e: goal, review, push, report)."""
    parts = []
    g = e.get("goal")
    parts.append(f"goal {g['state']}" if g else "no goal")
    r = e.get("review")
    if r:
        n = len(r.get("findings") or [])
        parts.append(f"{n} finding{'s' if n != 1 else ''} open" if n else "no findings")
    if e.get("report"):
        parts.append("report: " + short(e["report"], 60))
    return ", ".join(parts)


def review_text(e):
    r = e.get("review")
    return f"{r.get('verdict') or '?'} ({len(r.get('findings') or [])} open) {str(r.get('ts') or '')[:16].replace('T', ' ')}".strip() if r else "-"


def push_text(e):
    p = e.get("push")
    return f"{str(p.get('sha') or '')[:8]} {str(p.get('ts') or '')[:16].replace('T', ' ')}".strip() if p else "-"


def live_text(live, now=None, with_age=True):
    if not live:
        return "-"
    st = live.get("status") or "?"
    parts = ["draft" if live.get("isDraft") and st == "active" else st]
    n = len(open_threads(live))
    parts.append(f"{n} open comment{'s' if n != 1 else ''}")
    if live.get("ci") not in (None, "", "none", "unknown"):
        parts.append("CI " + str(live["ci"]))
    if live.get("merge") not in (None, "", "succeeded", "unknown"):
        parts.append("merge " + str(live["merge"]))
    votes = [str(r.get("vote")) for r in live.get("reviewers") or [] if isinstance(r, dict) and r.get("vote") not in (None, "", "none")]
    if votes:
        parts.append("votes " + "/".join(votes[:4]))
    return ", ".join(parts) + (f" ({age_text(live.get('fetched'), now)} ago)" if with_age and live.get("fetched") else "")


def next_step(e, live):
    if live:
        st = live.get("status")
        if st == "completed":
            return "merged: close the goal"
        if st == "abandoned":
            return "abandoned: drop the goal"
        humans = [t for t in open_threads(live) if t.get("kind") != "bot"]
        if humans:
            return f"answer or fix {len(humans)} open comment{'s' if len(humans) != 1 else ''}"
        if live.get("ci") == "failed":
            return "fix the failing checks"
        if live.get("merge") == "conflicts":
            return "resolve the merge conflicts"
        if live.get("isDraft"):
            return "publish when ready"
        if any(isinstance(r, dict) and r.get("vote") == "rejected" for r in live.get("reviewers") or []):
            return "address the rejection"
        if not any(isinstance(r, dict) and r.get("vote") in ("approved", "suggestions") for r in live.get("reviewers") or []):
            return "wait for reviewers"
        return "ready to complete (ask the user)"
    r = e.get("review")
    if not r:
        return "review it"
    if r.get("findings"):
        return "fix the open findings"
    if not e.get("push"):
        return "push it"
    return "refresh live state (`pr --refresh`)"


def render(rows):
    w = [max(len(str(r[i])) for r in rows) for i in range(len(rows[0]))]
    return "\n".join("  ".join(str(c).ljust(w[i]) for i, c in enumerate(r)).rstrip() for r in rows)


def known_table(entries):
    return render([HEAD] + [(link(e["pr"], e.get("remote")), short(e.get("title") or "-", 40), known_state(e), review_text(e), push_text(e), next_step(e, None))
                            for e in entries])


def live_table(entries, cache, now=None):
    rows = [("PR", "Title", "Live state", "Next")]
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache)
        rows.append((link(e["pr"], e.get("remote"), lv), short((lv or {}).get("title") or e.get("title") or "-", 40), live_text(lv, now), next_step(e, lv)))
    return render(rows)


def comments_text(entries, cache):
    out = []
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache)
        ts = open_threads(lv)
        if not ts:
            continue
        out.append(f"Open comments, PR {link(e['pr'], e.get('remote'), lv)}:")
        for t in ts:
            where = f"{t.get('file')}:{t.get('line')}" if t.get("file") else "general"
            out.append(f"  #{t.get('id')} {t.get('author') or '?'} [{t.get('kind') or 'human'}] {where} - {short(t.get('gist'), 90)}")
    return "\n".join(out)


def list_table(entries, cache, now=None):
    return render([("Thread", "PR", "Known state", "Live state", "Next")] + [
        (e.get("thread") or "-", link(e["pr"], e.get("remote"), live_of(e["project"], e["pr"], cache)), known_state(e), live_text(live_of(e["project"], e["pr"], cache), now),
         next_step(e, live_of(e["project"], e["pr"], cache))) for e in entries])


def report_line(tid, entries, cache):
    parts = []
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache)
        parts.append(f"PR {e['pr']}: {live_text(lv, with_age=False)}; next: {next_step(e, lv)}")
    return f"PR status {tid or ''}: " + " | ".join(parts)


# -- the options: comments, ci, diff, and the project lists (mine, stale, find)
STATE_ORDER = {"failed": 0, "rejected": 0, "broken": 0, "running": 1, "queued": 1, "pending": 1, "waiting": 1}


def comments_full(entries, cache):
    out = []
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache)
        ts = open_threads(lv)
        out.append(f"PR {link(e['pr'], e.get('remote'), lv)}: " + (f"{len(ts)} active comment{'s' if len(ts) != 1 else ''}" if lv else "no live data"))
        for t in ts:
            where = f"{t.get('file')}:{t.get('line')}" if t.get("file") else "general"
            out.append(f"  #{t.get('id')} {t.get('author') or '?'} [{t.get('kind') or 'human'}] {where} · {ago(t.get('created'))}\n"
                       f"    {short(t.get('text') or t.get('gist'), 400)}")
    return "\n".join(out)


def ci_text(entries, cache):
    out = []
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache)
        checks = sorted([c for c in (lv or {}).get("checks") or [] if isinstance(c, dict)], key=lambda c: STATE_ORDER.get(str(c.get("state")).lower(), 2))
        out.append(f"PR {link(e['pr'], e.get('remote'), lv)}: " + (f"CI {lv.get('ci') or '?'}, {len(checks)} check{'s' if len(checks) != 1 else ''}" if lv else "no live data"))
        for c in checks:
            out.append(f"  {str(c.get('state') or '?'):<12} {c.get('kind') or '-':<7} {c.get('name') or '?'}" + (f"  {c['link']}" if c.get("link") else ""))
        b = (lv or {}).get("build")
        if isinstance(b, dict) and b.get("result"):
            out.append(f"  latest build: {b['result']}" + (f"  {b['link']}" if b.get("link") else ""))
    return "\n".join(out)


def diff_text(entries, cache):
    out = []
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache)
        files = [f for f in (lv or {}).get("files") or [] if isinstance(f, dict)]
        add = sum(int(f.get("added") or 0) for f in files)
        dele = sum(int(f.get("deleted") or 0) for f in files)
        out.append(f"PR {link(e['pr'], e.get('remote'), lv)}: " + (f"{len(files)} file{'s' if len(files) != 1 else ''}, +{add} -{dele}" if lv else "no live data")
                   + (f" vs {lv['target']}" if lv and lv.get("target") else ""))
        for f in files:
            out.append(f"  +{int(f.get('added') or 0):<5} -{int(f.get('deleted') or 0):<5} {f.get('path')}")
    return "\n".join(out)


def reviewers_text(r):
    return ", ".join(f"{x.get('name')}: {x.get('vote') or 'none'}" for x in r.get("reviewers") or [] if isinstance(x, dict)) or "-"


def is_me(name, me):
    n, m = str(name or "").lower(), str(me or "").lower()
    return bool(n and m and (n == m or m in n or n in m))


def filter_query(kind, rows, me="", days=3, text="", now=None):
    now = time.time() if now is None else now
    if kind == "mine":
        def my_vote(r):
            if r.get("myVote") is not None:
                return str(r["myVote"]).lower()
            return next((str(x.get("vote") or "none").lower() for x in r.get("reviewers") or [] if isinstance(x, dict) and is_me(x.get("name"), me)), "none")
        return [r for r in rows if not is_me(r.get("author"), me) and my_vote(r) in ("", "none", "waiting")]
    if kind == "stale":
        old = [r for r in rows if r.get("status", "active") == "active" and iso_epoch(r.get("updated")) and now - iso_epoch(r["updated"]) >= days * 86400]
        return sorted(old, key=lambda r: iso_epoch(r["updated"]))
    needle = str(text or "").lower().strip().lstrip("#!")
    ids = needle.lstrip("ab#")
    return [r for r in rows if needle and (needle in str(r.get("author") or "").lower() or needle in str(r.get("title") or "").lower()
                                           or needle in str(r.get("branch") or "").lower() or needle == str(r.get("pr"))
                                           or any(needle in str(x.get("name") or "").lower() for x in r.get("reviewers") or [] if isinstance(x, dict))
                                           or (ids.isdigit() and ids in [str(w).lstrip("ABab#-") for w in r.get("workItems") or []]))]


def find_known(text, entries, cache):
    """Rows (like the live ones) for known PRs whose refs, thread, goal, report or cached title name the text."""
    import lean_find
    match = lean_find.matcher(text)
    out = []
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache) or {}
        fields = [("pr", f"PR {e['pr']}", True), ("thread", e.get("thread") or "", False), ("goal", (e.get("goal") or {}).get("ref") or "", True),
                  ("title", lv.get("title") or "", False), ("branch", e.get("head") or "", True), ("report", e.get("report") or "", False)]
        if lean_find.first_hit(match, fields):
            out.append(dict(lv, pr=e["pr"], project=e["project"], remote=e.get("remote")))
    return out


def query_table(rows, remote, owners, age=""):
    """PR(link) | Title | Author | Reviewers/votes | Status | Thread; owners: {pr: thread}."""
    if not rows:
        return "No matching PRs."
    body = [("PR", "Title", "Author", "Reviewers/votes", "Status", "Thread")] + [
        (link(r["pr"], r.get("remote") or remote, r), short(r.get("title") or "-", 40), r.get("author") or "-", short(reviewers_text(r), 50),
         ("draft" if r.get("isDraft") else r.get("status") or "-") + (f" · updated {ago(r['updated'])}" if r.get("updated") else ""), owners.get(r["pr"]) or "-")
        for r in rows]
    return render(body) + (f"\n({age})" if age else "")


# ---- review context: the PR's title, description and linked work items, read-only, no model (cap ~3k chars)
CONTEXT_CAP = 3000
CONTEXT_SECONDS = 20


def _run(cmd, cwd, seconds=CONTEXT_SECONDS):
    """stdout of one read-only CLI call ('' on any failure); only commands from the allow lists are run."""
    import subprocess
    allowed = AZ_CMDS + GH_CMDS + ["az boards work-item show", "az repos pr work-item list"]
    if not any(" ".join(cmd).startswith(a) for a in allowed):
        return ""
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=seconds)
        return p.stdout if p.returncode == 0 else ""
    except Exception:
        return ""


def _json(text):
    try:
        return json.loads(text)
    except Exception:
        return None


def _clean(text, n):
    t = re.sub(r"<[^>]+>", " ", str(text or ""))  # Azure DevOps descriptions are often HTML
    return re.sub(r"\s+", " ", t).strip()[:n]


def format_context(title, description, items, cap=CONTEXT_CAP):
    """Compact text: 'PR title: ... | Description: ... | Work items: #1 title: description'."""
    parts = []
    if title:
        parts.append("PR title: " + _clean(title, 300))
    if description:
        parts.append("PR description: " + _clean(description, 1500))
    for i in (items or [])[:5]:
        parts.append(f"Work item {i.get('id', '?')}: {_clean(i.get('title'), 200)}"
                     + (f" - {_clean(i.get('description'), 600)}" if i.get("description") else ""))
    return "\n".join(parts)[:cap]


def fetch_context(flavour, pr, cwd, cached=None):
    """Title, description and linked work items/issues of a PR, via read-only `az`/`gh` calls; '' when unavailable.
    `cached` is the pr-cache row (its title is the fallback). Never raises."""
    try:
        pr = str(pr).strip().lstrip("#!")
        if not pr.isdigit():
            return ""
        title, desc, items = (cached or {}).get("title") or "", "", []
        if flavour == "gh":
            d = _json(_run(["gh", "pr", "view", pr, "--json", "title,body,closingIssuesReferences"], cwd)) or {}
            title, desc = d.get("title") or title, d.get("body") or ""
            for r in (d.get("closingIssuesReferences") or [])[:5]:
                n = r.get("number")
                i = _json(_run(["gh", "api", "--method", "GET", f"repos/{{owner}}/{{repo}}/issues/{n}"], cwd)) or {}
                items.append({"id": f"#{n}", "title": i.get("title") or "", "description": i.get("body") or ""})
        elif flavour == "az":
            d = _json(_run(["az", "repos", "pr", "show", "--id", pr, "--output", "json"], cwd)) or {}
            title, desc = d.get("title") or title, d.get("description") or ""
            wl = _json(_run(["az", "repos", "pr", "work-item", "list", "--id", pr, "--output", "json"], cwd)) or []
            for w in wl[:5]:
                wid = w.get("id")
                f = (_json(_run(["az", "boards", "work-item", "show", "--id", str(wid), "--output", "json"], cwd)) or {}).get("fields") or {}
                items.append({"id": f"#{wid}", "title": f.get("System.Title") or "", "description": f.get("System.Description") or ""})
        return format_context(title, desc, items)
    except Exception:
        return ""
