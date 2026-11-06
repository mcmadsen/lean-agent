"""`lean-agent pr`: PR status per thread. Known state from lean-agent's own records (no network), live state from one
read-only haiku helper (role pr-status), cached per PR in <home>/pr-cache.json. Pure logic here; lean_agent.py gathers the
records and starts the helper."""
import json
import os
import re
import time

import lean_common

CACHE_MINUTES = 10
FETCH_CAP_SECONDS = 180
ROLE = "pr-status"
AZ_CMDS = ["az repos pr show", "az repos pr list", "az repos pr policy list", "az devops invoke --http-method get"]
GH_CMDS = ["gh pr view", "gh pr list", "gh pr checks", "gh api --method GET"]
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


def save_live(rows, now=None):
    """Store the helper's per-PR rows ({pr, project, ...}) with the time."""
    now = time.time() if now is None else now
    path = cache_path()
    with lean_common.file_lock(path):
        cache = load_cache()
        for r in rows:
            cache[key(r.get("project") or "", r["pr"])] = dict(r, fetched=now)
        lean_common.write_json_atomic(path, cache)


def live_of(project, pr, cache=None):
    return (cache if cache is not None else load_cache()).get(key(project, str(pr)))


def age_text(fetched, now=None):
    s = max(0, (time.time() if now is None else now) - float(fetched or 0))
    return f"{int(s // 3600)}h" if s >= 3600 else f"{int(s // 60)}m" if s >= 60 else "now"


def fresh(live, now=None):
    return bool(live) and (time.time() if now is None else now) - float(live.get("fetched") or 0) < cache_minutes() * 60


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


def prompt(entries):
    """The helper's rule: which PRs, how to read each, what to answer."""
    lines = []
    for e in entries:
        how = ("`az repos pr show --id N`, `az repos pr policy list --id N`, and the comment threads with "
               "`az devops invoke --http-method get --area git --resource pullRequestThreads --route-parameters project=<project> "
               "repositoryId=<repo> pullRequestId=N`" if e["flavour"] == "az" else
               "`gh pr view N --json state,isDraft,title,author,baseRefName,mergeable,reviewDecision,reviews,statusCheckRollup` and the "
               "review threads with `gh api --method GET repos/<owner>/<repo>/pulls/N/comments`")
        lines.append(f"- PR {e['pr']} (project dir {e['path']}, remote {e.get('remote') or '?'}): {how}")
    return (
        "You report the live state of pull requests. You are strictly read-only: only the listed show/list/GET commands; never "
        "comment, vote, approve, complete, abandon or change anything. Run `git -C <dir> remote get-url origin` if you need "
        "the organisation/repository. Be quick: at most one or two commands per PR.\nPRs:\n" + "\n".join(lines) + "\n"
        "Answer with one line exactly like this (valid JSON, one line) before the LEAN-FEEDBACK line; one object per PR, "
        "threads = only ACTIVE (unresolved) comment threads, at most 15 per PR, gist <= 90 chars, kind human or bot "
        "(bot = a build, policy or service account):\n"
        'LEAN-PR {"prs": [{"pr": "N", "status": "active|completed|abandoned", "isDraft": false, "title": "...", "author": "...", '
        '"target": "main", "merge": "succeeded|conflicts|queued|unknown", "reviewers": [{"name": "...", "vote": "approved|suggestions|waiting|rejected|none"}], '
        '"ci": "passed|failed|running|none|unknown", "threads": [{"id": "1", "author": "...", "file": "path", "line": 0, "gist": "...", "kind": "human|bot"}]}]}\n')


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
    return render([HEAD] + [(e["pr"], short(e.get("title") or "-", 40), known_state(e), review_text(e), push_text(e), next_step(e, None))
                            for e in entries])


def live_table(entries, cache, now=None):
    rows = [("PR", "Title", "Live state", "Next")]
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache)
        rows.append((e["pr"], short((lv or {}).get("title") or e.get("title") or "-", 40), live_text(lv, now), next_step(e, lv)))
    return render(rows)


def comments_text(entries, cache):
    out = []
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache)
        ts = open_threads(lv)
        if not ts:
            continue
        out.append(f"Open comments, PR {e['pr']}:")
        for t in ts:
            where = f"{t.get('file')}:{t.get('line')}" if t.get("file") else "general"
            out.append(f"  #{t.get('id')} {t.get('author') or '?'} [{t.get('kind') or 'human'}] {where} - {short(t.get('gist'), 90)}")
    return "\n".join(out)


def list_table(entries, cache, now=None):
    return render([("Thread", "PR", "Known state", "Live state", "Next")] + [
        (e.get("thread") or "-", e["pr"], known_state(e), live_text(live_of(e["project"], e["pr"], cache), now),
         next_step(e, live_of(e["project"], e["pr"], cache))) for e in entries])


def report_line(tid, entries, cache):
    parts = []
    for e in entries:
        lv = live_of(e["project"], e["pr"], cache)
        parts.append(f"PR {e['pr']}: {live_text(lv, with_age=False)}; next: {next_step(e, lv)}")
    return f"PR status {tid or ''}: " + " | ".join(parts)
