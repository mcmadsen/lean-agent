"""Fixed reviewer passes: checklists that always run when a diff touches their trigger.

PASSES is the one table: name -> (path globs, diff regexes, checklist text). A pass is triggered when a changed
path matches a glob, when an added or removed diff line matches a regex, or when its detector (stale text) fires.
Only triggered passes put their checklist into the reviewer prompt; every pass is named in the review output
("<pass>: checked, N findings" / "checked, no finding", then a line listing the passes not triggered).
The reviewer tags each finding of a pass with "pass": "<name>"; the stale-text pass uses category "stale-text".
Projects can extend a pass by adding lines to its checklist in PASSES (an `extra` mapping of name -> lines is
accepted by checklist_text); wiring project cards or review lessons into `extra` is not done yet."""
import fnmatch
import re

PASSES = {
    "e2e-ci": (
        ("e2e/*", "*/e2e/*", "*.e2e.*", "*playwright.config.*", "*cypress.config.*", "cypress/*", "*/cypress/*",
         ".github/workflows/*", "*azure-pipelines*", "*Jenkinsfile*", "ci/*.yml", "*/ci/*.yml", "ci/*.yaml",
         "*/ci/*.yaml", "pipelines/*.yml", "*/pipelines/*.yml", "pipelines/*.yaml", "*/pipelines/*.yaml"),
        (),
        "fixtures or accounts shared by concurrent jobs (parallel runs, shards, matrix entries colliding); tests "
        "that can pass vacuously (empty baseline, assertions that never run, skipped steps); swallowed errors "
        "(catch without rethrow or log, `|| true`, continue-on-error); secrets or environment assumptions; "
        "retries hiding flakiness."),
    "logging": (
        (),
        (r"\b(?:log|logger|logging|console|LOG|LOGGER)\s*\.\s*(?:error|warn|warning|info|debug|trace|fatal|critical|exception)\b",
         r"\b(?:setLevel|LOG_LEVEL|log_level|logLevel)\b"),
        "evidence of real volumes by cause for a lowered level or a new log in a hot path; alerting or monitoring "
        "that depended on the old level; diagnostics lost by a removed log (cause, ids, stack)."),
    "flavours-flags": (
        ("*flavor*", "*flavour*", "*environments/*", "*/environments/*", "*feature*flag*", "*feature_toggle*",
         "*.env", "*.env.*", "*/.env*"),
        (r"\b(?:feature[_-]?flags?|isFeatureEnabled|flag_enabled|FEATURE_[A-Z_]+|flavou?r|buildFlavou?r)\b",),
        "every flavour or environment covered by the change; defaults per environment; removal path of each flag "
        "(who deletes it, what reads it after)."),
    "stale-text": (
        (),
        (),
        "comments, docstrings, test names, docs, README and config descriptions that mention a renamed symbol, a "
        "flipped default or changed behaviour and are now false; report each as category \"stale-text\" with "
        "file:line."),
}

_DEF = re.compile(r"^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|const|let|var|fn|func)\s+([A-Za-z_]\w*)")
_LIT = re.compile(r"\b(?:True|False|true|false)\b")


def _split(diff):
    """{file: (removed lines, added lines)} of a -U0 diff."""
    out, cur = {}, None
    for l in (diff or "").splitlines():
        if l.startswith("+++ "):
            cur = l[6:] if l.startswith("+++ b/") else l[4:]
            out.setdefault(cur, ([], []))
        elif l.startswith("--- "):
            continue
        elif cur and l.startswith("-"):
            out[cur][0].append(l[1:])
        elif cur and l.startswith("+"):
            out[cur][1].append(l[1:])
    return out


def stale_text_trigger(diff):
    """True when a definition was renamed or a boolean default was flipped (the text around it may now lie)."""
    for rem, add in _split(diff).values():
        rn = {m.group(1) for m in map(_DEF.match, rem) if m}
        an = {m.group(1) for m in map(_DEF.match, add) if m}
        if rn and an and rn != an and (rn - an):
            return True
        norm = lambda s: _LIT.sub("B", s).strip()
        if any(norm(r) == norm(a) and r.strip() != a.strip() and _LIT.search(r) for r in rem for a in add):
            return True
    return False


def triggered(names, diff):
    """Names of the passes this change triggers, in table order."""
    parts = _split(diff)
    lines = [l for rem, add in parts.values() for l in rem + add]
    hit = []
    for name, (globs, regexes, _) in PASSES.items():
        by_path = any(fnmatch.fnmatch(f, g) for g in globs for f in names)
        by_diff = any(re.search(rx, l) for rx in regexes for l in lines)
        if by_path or by_diff or (name == "stale-text" and stale_text_trigger(diff)):
            hit.append(name)
    return hit


def checklist_text(hit, extra=None):
    """Prompt text for the triggered passes only ('' when none)."""
    if not hit:
        return ""
    rows = []
    for n in hit:
        more = " ".join((extra or {}).get(n) or [])
        rows.append(f"- {n}: {PASSES[n][2]}" + (" " + more if more else ""))
    return ("Fixed passes triggered by this diff (check every item; tag each finding of a pass with \"pass\": "
            "\"<name>\"):\n" + "\n".join(rows))


def count_findings(name, findings):
    return sum(1 for f in findings if f.get("pass") == name or (name == "stale-text" and f.get("category") == "stale-text"))


def report_lines(hit, findings):
    """Output lines: one per triggered pass, then the passes not triggered."""
    out = []
    for n in hit:
        c = count_findings(n, findings)
        out.append(f"{n}: checked, " + (f"{c} finding{'s' if c != 1 else ''}" if c else "no finding"))
    rest = [n for n in PASSES if n not in hit]
    out.append("passes not triggered: " + (", ".join(rest) if rest else "none"))
    return out
