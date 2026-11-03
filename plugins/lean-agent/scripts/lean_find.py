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


# ------------------------------------------------------------------ references in a prompt (thread routing)

_PR_WORD = r"(?:pr|pull\s*requests?|pullrequests?|pull|mr|merge\s*requests?)"
_ITEM_WORD = (r"(?:\b(?!(?:pr|mr)\s*-?#)[A-Za-z]{1,10}-?#|(?-i:\b[A-Z]{2,10}-)|\bwork\s*items?[\s#:]*|"
              r"\b(?:bug|task|item|ticket|issue|story)[\s#:]*)")
_PROMPT_REFS = (
    ("pr", re.compile(r"(?:\b" + _PR_WORD + r"[\s#:/_-]*|(?<![A-Za-z0-9])!|/pull/)(\d{1,9})(?!\d)", re.I)),
    ("item", re.compile(_ITEM_WORD + r"(\d{1,9})(?!\d)", re.I)),
    ("hash", re.compile(r"(?<![\w&/])#(\d{3,9})(?!\d)")),
    ("run", re.compile(r"\b(\d{4}-\d{6}-[0-9a-f]{4})\b")),
    ("todo", re.compile(r"\b(?:todo|to-do)\s*#?(\d{1,6})(?!\d)", re.I)),
    ("branch", re.compile(r"\b((?:feature|bugfix|hotfix|release|fix|chore|users?)/[\w.-]+)", re.I)),
    ("num", re.compile(r"(?<![\w.#!/-])(\d{4,9})(?![\w.-])")),
)


def prompt_references(text):
    """[(kind, value)] the identifiers a prompt names: pr, item (AB#1, work item 1, bug 1, task 1), hash (#1234: PR or item),
    run, todo, branch, and bare 4+ digit numbers (num; weak). A number is listed once, under its strongest kind."""
    text = str(text or "")
    out, seen_num = [], set()
    for kind, rx in _PROMPT_REFS:
        for m in rx.finditer(text):
            v = m.group(1)
            if kind in ("pr", "item", "hash", "num"):
                if v in seen_num:
                    continue
                seen_num.add(v)
            if (kind, v.lower()) not in [(k, x.lower()) for k, x in out]:
                out.append((kind, v))
    return out


def reference_in(kind, value, text, is_ref=False):
    """Whether a record field (free text, or a ref/branch field when is_ref) names the reference. A number in a ref field
    matches either kind unless the field spells out the other one (a PR is not a work item with the same number)."""
    text = str(text or "")
    if not text:
        return False
    if kind in ("run", "todo"):
        return False
    if kind == "branch":
        return value.lower() in text.lower()
    n = value
    pr = re.search(r"(?:\b" + _PR_WORD + r"[\s#:/_-]*|(?<![A-Za-z0-9])[!#]|/pull/)" + n + r"(?!\d)", text, re.I)
    item = re.search(_ITEM_WORD + n + r"(?!\d)", text, re.I) and not pr
    if kind == "pr":
        return bool(pr or (is_ref and not item and ref_rx(n).search(text)))
    if kind == "item":
        return bool(item or (is_ref and not pr and ref_rx(n).search(text)))
    return bool(pr or item or (is_ref and ref_rx(n).search(text)))  # hash / num


def reference_label(kind, value):
    return {"pr": f"PR {value}", "item": f"work item {value}", "hash": f"#{value}", "run": f"run {value}",
            "todo": f"todo #{value}"}.get(kind, value)
