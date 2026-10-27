#!/usr/bin/env python3
"""Minimal stdio MCP server that answers as the anonymous identity unless a PAT is in its environment.
Writes the names of the environment variables it was started with to the file in FAKE_AUTH_ENVLOG."""
import json, os, sys
if os.environ.get("FAKE_AUTH_ENVLOG"):
    with open(os.environ["FAKE_AUTH_ENVLOG"], "w") as fh:
        json.dump(sorted(os.environ), fh)
TOOLS = [{"name": "create_item", "description": "Create an item.", "inputSchema": {"type": "object"}},
         {"name": "list_projects", "description": "List the projects.", "inputSchema": {"type": "object"}}]
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if "id" not in msg:
        continue
    m = msg.get("method")
    if m == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "tracker", "version": "1"}}
    elif m == "tools/list":
        r = {"tools": TOOLS}
    elif m == "tools/call":
        if os.environ.get("TRACKER_PAT"):
            r = {"content": [{"type": "text", "text": "Projects: alpha, beta"}]}
        else:
            r = {"isError": True, "content": [{"type": "text", "text": "The anonymous identity is not authorized to list projects."}]}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "no method"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": r}), flush=True)
