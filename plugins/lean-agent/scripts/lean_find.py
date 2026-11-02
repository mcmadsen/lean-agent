"""One search across the local records (no model): matching rules shared by `find`, `todo list --ref`,
`thread list --pr/--item/--grep` and `runs --pr/--item/--grep`."""
import re

LIMIT = 15
TYPES = ("todo", "thread", "run", "memory", "handover", "review")
_PR_WORDS = re.compile(r"^\s*(?:pr|pull\s*request|pullrequest|mr|merge\s*request|item|#|!)[\s#!:/_-]*(\d+)\s*$", re.I)


def number_of(query):
    """The number a query names ('4711', 'PR 4711', '!4711', '#4711'), else None."""
    q = str(query or "").strip()
    if q.isdigit():
        return q
    m = _PR_WORDS.match(q)
    return m.group(1) if m else None


def pr_rx(n):
    """A PR number as written in free text: 'PR 12', '!12', '#12', 'pullrequest/12', 'pull/12', 'merge request 12'."""
    return re.compile(r"(?:\b(?:pr|pull\s*requests?|pullrequests?|pull|mr|merge\s*requests?)[\s#:/_-]*|[!#]|/pull/)" + n + r"(?!\d)", re.I)


def ref_rx(n):
    """A number inside a ref or branch name: 'PR 12', '12', 'feature/12-login', 'fix-12', 'pullrequest/12'."""
    return re.compile(r"(?<!\d)" + n + r"(?!\d)")


def matcher(query, pr=False, item=False):
    """match(text, ref=False) -> the matching span (start, end) or None. A number query matches any whole number (so also
    'PR 12', '!12', 'pullrequest/12', 'feature/12-x'); with pr=/item= only the PR / work-item spellings in free text; other queries are case-insensitive substrings."""
    n = number_of(query)
    if n:
        strong, loose = pr_rx(n), ref_rx(n)
        itemrx = re.compile(r"(?:[#!-]|\bitem\s*)" + n + r"(?!\d)", re.I)  # '#12', 'AB-12', 'item 12'

        def match(text, ref=False):
            rx = loose if ref or not (pr or item) else strong if pr else itemrx
            m = rx.search(str(text or ""))
            return m.span() if m else None
        return match
    needle = str(query or "").lower()

    def match(text, ref=False):
        i = str(text or "").lower().find(needle)
        return (i, i + len(needle)) if needle and i >= 0 else None
    return match


def first_hit(match, fields):
    """(field name, one-line snippet) of the first field that matches; fields are (name, text, is_ref)."""
    for name, text, is_ref in fields:
        text = " ".join(str(text or "").split())
        span = match(text, is_ref)
        if span:
            lo = max(0, span[0] - 30)
            out = text[lo:lo + 100]
            return name, ("..." if lo else "") + out + ("..." if lo + 100 < len(text) else "")
    return None


def table(rows, show_all=False):
    """rows: dicts with type, id, date, state, match, open; newest first. Compact table, at most LIMIT rows."""
    rows = sorted(rows, key=lambda r: r.get("date") or "", reverse=True)
    shown = rows if show_all else rows[:LIMIT]
    cells = [("Type", "Id", "Date", "State", "Match", "Open")]
    cells += [(r["type"], str(r["id"]), (r.get("date") or "")[:10], r.get("state") or "", r.get("match") or "", r["open"])
              for r in shown]
    w = [max(len(c[i]) for c in cells) for i in range(4)]
    lines = ["  |  ".join([c[i].ljust(w[i]) for i in range(4)] + [c[4], c[5]]) for c in cells]
    if len(rows) > len(shown):
        lines.append(f"{len(rows) - len(shown)} more: --all")
    return "\n".join(lines)
