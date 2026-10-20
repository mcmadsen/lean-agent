#!/usr/bin/env python3
"""PostToolUse hook for MCP tools in lean-agent workers: trim big results before the model reads them.

Drops links, URLs, avatars, descriptors and empty values, turns identities into names, and with
LEAN_AGENT_MCP_FIELDS=a,b.c keeps only those fields (plus ids) per item. The full result is saved to a file
whose path goes at the top. Results under LEAN_AGENT_MCP_TRIM_OVER chars (default 3000) are left alone.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lean_json  # noqa: E402
import lean_log  # noqa: E402


def blocks_of(resp):
    """(the list of content blocks, a function to put trimmed blocks back in the same shape)."""
    if isinstance(resp, list):
        return resp, lambda b: b
    if isinstance(resp, dict) and isinstance(resp.get("content"), list):
        return resp["content"], lambda b: dict(resp, content=b)
    return None, None


def trim_text(text, fields):
    try:
        data = json.loads(text)
    except ValueError:
        return None
    items = lean_json.main_list(data)
    keep_ids = ["id", "ID", "key", "number", "url_id"]
    if fields:
        wanted = [f.strip() for f in fields.split(",") if f.strip()]
        wanted += [k for k in keep_ids if k not in wanted]
        out = [lean_json.pick(lean_json.compact(x, 1), wanted) if isinstance(x, dict) else x for x in items]
    else:
        out = [lean_json.compact(x, 1) for x in items]
    if isinstance(data, dict) and len(items) == 1 and items[0] is data:
        out = out[0]
    elif isinstance(data, dict):  # {"count": 30, "value": [...]}: keep the small top-level values too
        key = next((k for k, v in data.items() if v is items), None)
        out = dict({k: v for k, v in data.items() if not isinstance(v, (list, dict))}, **{key or "items": out})
    return json.dumps(out, ensure_ascii=False, separators=(",", ":"))


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if not str(event.get("tool_name", "")).startswith("mcp__"):
        return 0
    resp = event.get("tool_response")
    blocks, rebuild = blocks_of(resp)
    if blocks is None:
        return 0
    over = int(os.environ.get("LEAN_AGENT_MCP_TRIM_OVER") or 3000)
    original = sum(len(b.get("text", "")) for b in blocks if isinstance(b, dict))
    if original <= over:
        return 0
    fields = os.environ.get("LEAN_AGENT_MCP_FIELDS", "")
    new_blocks, changed = [], False
    for b in blocks:
        if isinstance(b, dict) and b.get("type") == "text" and len(b.get("text", "")) > over:
            t = trim_text(b["text"], fields)
            if t is not None and len(t) < len(b["text"]):
                new_blocks.append(dict(b, text=t))
                changed = True
                continue
        new_blocks.append(b)
    if not changed:
        return 0
    path = lean_log.verbose_path(str(event.get("tool_name"))[:60].replace("/", "_") + ".json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(resp, fh)
    after = sum(len(b.get("text", "")) for b in new_blocks if isinstance(b, dict))
    note = {"type": "text", "text": f"[lean-agent: trimmed {original:,} -> {after:,} chars"
                                    + (f" (fields {fields})" if fields else "") + f"; full result: {path}]"}
    lean_log.record_saving("mcp-trim", original, after)
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                             "updatedToolOutput": rebuild([note] + new_blocks)}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never break a worker over trimming
        print(f"lean-agent mcp trim hook error: {exc}", file=sys.stderr)
        sys.exit(0)
