"""Pull requests for the dashboard's board: their state, CI, approvals and comment threads, read with the git
host's own CLI (`gh` for GitHub, `az repos` for Azure DevOps), never an MCP server. Read only: nothing is posted,
voted or merged. The dashboard polls in the background (LEAN_AGENT_PR_POLL minutes, default 5; 0 turns it off)
and keeps the results in ~/.lean-agent/prs.json, so the page itself never waits on the network.

Which PRs: the ones the work queue names (`--ref "PR 512"` or a PR URL on an open item) and the open PR of each
branch reviewed in the last 7 days.
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import time

PR_RE = re.compile(r"(?:\bPR\s*#?|\bpull request\s*#?|/pull/|/pullrequest/)(\d+)", re.I)


def lean_home(*parts):
    return os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("LEAN_AGENT_HOME") or "~/.lean-agent")), *parts)


def _load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def cache():
    return _load(lean_home("prs.json"), {})


def pr_number(ref):
    m = PR_RE.search(str(ref or ""))
    return int(m.group(1)) if m else None


def _run(args, cwd, timeout=25):
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        return None, str(e)
    if p.returncode != 0:
        return None, (p.stderr or p.stdout).strip()[:300]
    return p.stdout, None


def _json_out(args, cwd):
    out, err = _run(args, cwd)
    if out is None:
        return None, err
    try:
        return json.loads(out or "null"), None
    except ValueError:
        return None, "unreadable output from " + args[0]


def remote(path):
    out, _ = _run(["git", "-C", path, "remote", "get-url", "origin"], path, 10)
    u = (out or "").strip()
    m = (re.match(r"^https?://(?:[^@/]+@)?dev\.azure\.com/([^/]+)/([^/]+)/_git/([^/?#]+)", u)
         or re.match(r"^(?:ssh://)?git@ssh\.dev\.azure\.com:(?:22/)?v3/([^/]+)/([^/]+)/([^/?#]+)", u))
    if m:
        return {"host": "azure", "org": m.group(1), "project": m.group(2), "repo": m.group(3)}
    m = (re.match(r"^https?://(?:[^@/]+@)?([^./]+)\.visualstudio\.com/(?:DefaultCollection/)?([^/]+)/_git/([^/?#]+)", u)
         or re.match(r"^(?:ssh://)?[^@]+@vs-ssh\.visualstudio\.com:(?:22/)?v3/([^/]+)/([^/]+)/([^/?#]+)", u))
    if m:
        return {"host": "azure", "org": m.group(1), "project": m.group(2), "repo": m.group(3)}
    if re.search(r"github\.com[/:]", u):
        return {"host": "github"}
    return {}


_ME = {}


def me(host, path, org=None):
    """The user's login on the host (to tell their comments and votes from other people's); cached."""
    key = (host, org)
    if key not in _ME:
        if host == "github":
            out, _ = _run(["gh", "api", "user", "-q", ".login"], path)
        else:
            out, _ = _run(["az", "account", "show", "--query", "user.name", "-o", "tsv"], path)
        _ME[key] = (out or "").strip().lower() or None
    return _ME[key]


def _ts(s):
    return str(s or "")[:19]


def github(path, number=None, branch=None):
    fields = ("number,title,url,headRefName,headRefOid,state,isDraft,reviewDecision,statusCheckRollup,"
              "reviews,comments,mergedAt")
    data, err = _json_out(["gh", "pr", "view", str(number or branch), "--json", fields], path)
    if not data:
        return {"error": err or "not found"}
    mine = me("github", path)
    checks = [c.get("conclusion") or c.get("state") or c.get("status") for c in data.get("statusCheckRollup") or []]
    checks = [str(c).upper() for c in checks if c]
    ci = (None if not checks else "failing" if any(c in ("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT") for c in checks)
          else "pending" if any(c in ("PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED") for c in checks) else "passing")
    events = [(_ts(c.get("createdAt")), (c.get("author") or {}).get("login", ""), c.get("body") or "")
              for c in data.get("comments") or []]
    events += [(_ts(r.get("submittedAt")), (r.get("author") or {}).get("login", ""), r.get("body") or "")
               for r in data.get("reviews") or [] if (r.get("body") or "").strip()]
    events.sort()
    my_last = max((t for t, who, _ in events if mine and who.lower() == mine), default="")
    waiting = [{"author": who, "text": " ".join(body.split())[:200], "ts": t} for t, who, body in events
               if t > my_last and who.lower() != (mine or "")]
    my_vote = next((r.get("state", "").lower() for r in reversed(data.get("reviews") or [])
                    if mine and (r.get("author") or {}).get("login", "").lower() == mine), None)
    state = {"OPEN": "open", "MERGED": "merged"}.get(str(data.get("state")).upper(), "closed")
    return {"number": data.get("number"), "title": data.get("title"), "url": data.get("url"),
            "branch": data.get("headRefName"), "head": data.get("headRefOid"), "state": state,
            "draft": bool(data.get("isDraft")), "ci": ci,
            "approval": {"APPROVED": "approved", "CHANGES_REQUESTED": "changes requested"}.get(data.get("reviewDecision")),
            "my_vote": my_vote, "waiting": waiting[-5:], "comments": len(events),
            "last_comment": events[-1][0] if events else None}


def azure(path, ident, number=None, branch=None):
    org = ["--org", f"https://dev.azure.com/{ident['org']}"]
    if not number:
        found, err = _json_out(["az", "repos", "pr", "list", "--source-branch", branch, "--status", "all",
                                "--repository", ident["repo"], "--project", ident["project"], "--top", "1",
                                "-o", "json"] + org, path)
        if not found:
            return {"error": err or "no pull request for " + str(branch)}
        number = found[0].get("pullRequestId")
    pr, err = _json_out(["az", "repos", "pr", "show", "--id", str(number), "-o", "json"] + org, path)
    if not pr:
        return {"error": err or "not found"}
    mine = me("azure", path, ident["org"])
    votes = {r.get("uniqueName", "").lower(): r.get("vote", 0) for r in pr.get("reviewers") or []}
    approval = ("changes requested" if any(v <= -5 for v in votes.values())
                else "approved" if votes and any(v >= 5 for v in votes.values()) else None)
    my_vote = {10: "approved", 5: "approved with suggestions", -5: "waiting for author", -10: "rejected"}.get(
        votes.get(mine or ""), None)
    policies, _ = _json_out(["az", "repos", "pr", "policy", "list", "--id", str(number), "-o", "json"] + org, path)
    states = [str((p.get("status") or "")).lower() for p in policies or []
              if "build" in json.dumps(p.get("configuration") or {}).lower()]
    ci = (None if not states else "failing" if "rejected" in states
          else "pending" if any(s in ("running", "queued") for s in states) else "passing")
    threads, _ = _json_out(["az", "devops", "invoke", "--area", "git", "--resource", "pullRequestThreads",
                            "--route-parameters", f"project={ident['project']}", f"repositoryId={ident['repo']}",
                            f"pullRequestId={number}", "--api-version", "7.0", "-o", "json"] + org, path)
    waiting, count, last = [], 0, None
    for t in (threads or {}).get("value") or [] if isinstance(threads, dict) else []:
        cs = [c for c in t.get("comments") or [] if c.get("commentType", "text") == "text" and not c.get("isDeleted")]
        if not cs or t.get("isDeleted"):
            continue
        count += 1
        end = cs[-1]
        last = max(last or "", _ts(end.get("publishedDate")))
        who = (end.get("author") or {}).get("uniqueName", "").lower()
        if str(t.get("status", "")).lower() in ("active", "pending", "1") and who != (mine or ""):
            waiting.append({"author": (end.get("author") or {}).get("displayName") or who,
                            "text": " ".join(str(end.get("content") or "").split())[:200],
                            "ts": _ts(end.get("publishedDate")), "thread": t.get("id")})
    status = str(pr.get("status", "")).lower()
    return {"number": pr.get("pullRequestId"), "title": pr.get("title"),
            "url": f"https://dev.azure.com/{ident['org']}/{ident['project']}/_git/{ident['repo']}/pullrequest/{number}",
            "branch": str(pr.get("sourceRefName") or "").replace("refs/heads/", ""),
            "head": (pr.get("lastMergeSourceCommit") or {}).get("commitId"),
            "state": {"active": "open", "completed": "merged"}.get(status, "closed"),
            "draft": bool(pr.get("isDraft")), "ci": ci, "approval": approval, "my_vote": my_vote,
            "waiting": sorted(waiting, key=lambda w: w["ts"])[-5:], "comments": count, "last_comment": last}


def fetch(path, number=None, branch=None):
    ident = remote(path)
    if ident.get("host") == "github" and shutil.which("gh"):
        return github(path, number, branch)
    if ident.get("host") == "azure" and shutil.which("az"):
        return azure(path, ident, number, branch)
    return {"error": "no CLI for this host (gh for GitHub, az with the Azure DevOps extension for Azure DevOps)"}


def targets(todo, reviews, paths, now=None):
    """[(slug, number or None, branch or None)]: PRs the open work names, and the branches reviewed lately."""
    now = now or datetime.datetime.now()
    week_ago = (now - datetime.timedelta(days=7)).isoformat()
    out = []
    for t in todo:
        n = pr_number(t.get("ref"))
        if n and t.get("status") != "done" and t.get("project") in paths:
            out.append((t["project"], n, None))
    for r in reviews:
        ref = str(r.get("ref") or "")
        if ref and ref != "working tree" and not r.get("branch") and (r.get("ts") or "") >= week_ago \
                and r.get("project") in paths:
            out.append((r["project"], None, ref.replace("origin/", "", 1)))
    return list(dict.fromkeys(out))


def poll(todo, reviews, paths):
    """Fetch every target and save the cache: {"<slug>#<number>": pr, "<slug>@<branch>": number or error}."""
    data = cache()
    by_number = {}
    week_ago = (datetime.datetime.now() - datetime.timedelta(days=7)).isoformat()
    again = [(v["project"], v["number"], None) for v in data.values()  # open ones seen lately: until they close
             if isinstance(v, dict) and v.get("state") == "open" and (v.get("fetched") or "") >= week_ago]
    for slug, number, branch in list(dict.fromkeys(targets(todo, reviews, paths) + again)):
        path = paths.get(slug)
        if not path or not os.path.isdir(path):
            continue
        if number is None and f"{slug}@{branch}" in data and isinstance(data[f"{slug}@{branch}"], int):
            number = data[f"{slug}@{branch}"]  # known already: one call instead of a search
        if number is not None and (slug, number) in by_number:
            continue
        pr = fetch(path, number, branch)
        pr["fetched"] = datetime.datetime.now().isoformat(timespec="seconds")
        if pr.get("number"):
            data[f"{slug}#{pr['number']}"] = dict(pr, project=slug)
            by_number[(slug, pr["number"])] = True
            if branch:
                data[f"{slug}@{branch}"] = pr["number"]
        elif number:
            data[f"{slug}#{number}"] = dict(pr, project=slug, number=number)
        else:
            data[f"{slug}@{branch}"] = pr.get("error")
    try:
        os.makedirs(lean_home(), exist_ok=True)
        tmp = lean_home(f"prs.json.{os.getpid()}.tmp")
        with open(tmp, "w") as fh:
            json.dump(data, fh, indent=1)
        os.replace(tmp, lean_home("prs.json"))
    except OSError:
        pass
    return data


def poll_every():
    try:
        return float(os.environ.get("LEAN_AGENT_PR_POLL") or 5)
    except ValueError:
        return 5.0


def poller(get_inputs, stop=None):
    """The dashboard's background loop: poll, then wait LEAN_AGENT_PR_POLL minutes."""
    while poll_every() > 0 and not (stop and stop.is_set()):
        try:
            poll(*get_inputs())
        except Exception:  # a hiccup in one poll must never stop the dashboard
            pass
        for _ in range(int(poll_every() * 60)):
            if stop and stop.is_set():
                return
            time.sleep(1)
