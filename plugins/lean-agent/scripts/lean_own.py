"""Is a review of the user's own work? Then it ends in a one-line report and fixes, not a vote question."""
import json
import os
import re
import subprocess

import lean_common
import lean_pr
import lean_waiting


def _git(path, *args):
    p = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True)
    return p.stdout.strip() if p.returncode == 0 else None


def config():
    c = lean_common.read_json(lean_common.lean_home("config.json"), {})
    return c if isinstance(c, dict) else {}


def vote_own_on():
    return config().get("review_vote_own") == "on"


def my_emails(path):
    """Lower-cased emails that count as the user's: the worktree's and the global git user.email, plus
    `config attribution-emails`."""
    out = set()
    for e in (_git(path, "config", "user.email") if path else None,
              subprocess.run(["git", "config", "--global", "user.email"], capture_output=True, text=True).stdout.strip()):
        if e:
            out.add(e.lower())
    return out | {str(e).lower() for e in config().get("attribution_emails") or []}


def _bare(ref):
    return re.sub(r"^(refs/heads/|refs/remotes/)?(origin/)?", "", str(ref or ""))


def own_commits(root, base, head):
    """True when the branch's own commits (first parent, no merges: merged base commits don't count) are all the user's."""
    if not (root and base and head):
        return False
    mb = _git(root, "merge-base", base, head) or base
    out = _git(root, "log", "--first-parent", "--no-merges", "--format=%ae\t%ce", f"{mb}..{head}")
    mine = my_emails(root)
    rows = [l.split("\t") for l in (out or "").splitlines() if l.strip()]
    return bool(rows) and all(any(e.strip().lower() in mine for e in r) for r in rows)


def pr_by_me(root, ref, branch=""):
    """True when the pr-cache holds a PR of this branch (or `pr/N` ref) whose author is the user."""
    names = {n.lower() for n in my_emails(root)}
    for k in ("user.name",):
        n = _git(root, "config", k) if root else None
        if n:
            names.add(n.lower())
    names |= {e.split("@")[0] for e in list(names) if "@" in e}
    pr = (re.search(r"(\d+)$", str(ref)) or [None, ""])[1] if re.match(r"^(refs/)?(pull|pr)/", str(ref)) else ""
    want = {_bare(ref), _bare(branch)} - {""}
    for k, e in lean_pr.load_cache().items():
        if not isinstance(e, dict):
            continue
        if str(e.get("branch") or "") in want or (pr and str(e.get("pr") or k.rsplit(":", 1)[-1]) == pr):
            if any(lean_pr.is_me(e.get("author"), n) for n in names):
                return True
    return False


def is_own(root, ref="", head="", base="", for_push=False, branch="", author=""):
    """A review is of the user's own work when it was a pre-push review, the branch's own commits are the user's, or the
    PR's author (pr-cache or the review metadata) is the user."""
    if for_push:
        return True
    try:
        if author and any(lean_pr.is_me(author, n) for n in my_emails(root)):
            return True
        return own_commits(root, base, head or ref) or pr_by_me(root, ref, branch)
    except Exception:
        return False


def sweep():
    """Close the open review waiting items that are about the user's own work (unless review-vote-own is on)."""
    if vote_own_on():
        return []
    items = [i for i in lean_waiting.open_items() if i.get("kind") == "review" and i.get("ref")]
    if not items:
        return []
    projects = lean_common.read_json(lean_common.lean_home("projects.json"), {}) or {}
    rdir = lean_common.lean_home("reviews")
    latest = {}
    for slug in (f[:-6] for f in sorted(os.listdir(rdir)) if f.endswith(".jsonl")) if os.path.isdir(rdir) else []:
        try:
            with open(os.path.join(rdir, slug + ".jsonl")) as fh:
                for line in fh:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    for key in (r.get("ref"), r.get("branch")):
                        if key:
                            latest[str(key)] = (slug, r)
        except OSError:
            pass
    ids = []
    for i in items:
        hit = latest.get(str(i["ref"]))
        if not hit:
            continue
        slug, r = hit
        root = (projects.get(slug) or {}).get("path")
        if root and is_own(root, r.get("ref") or "", r.get("head") or "", r.get("base") or "", bool(r.get("for_push")), r.get("branch") or ""):
            ids.append(i["id"])
    return lean_waiting._mark("answered_at", set(ids), "own PR: no vote") if ids else []
