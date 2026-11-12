"""Big-home fixture shared by the perf test and the profiling script: 150 threads x 30 requests, 2000 ledger rows,
300 work dirs, 200 goals, 100 questions, 20 live transcripts, big reports/delivered files."""
import json
import os
import time

import lean_threads


def build(tmp, nthreads=150, nreq=30, ledger=2000, work=300, goals=200, questions=100, live=20):
    old = lean_threads.datetime.datetime.fromtimestamp(time.time() - 7200).isoformat(timespec="seconds")
    threads = {}
    for i in range(1, nthreads + 1):
        tid = f"t{i}"
        open_ = i % 4 == 0
        t = {"id": tid, "name": f"n{i}", "closed": None if open_ else old,
             "report": {"kind": "done", "text": "ok", "ts": lean_threads.now_iso()},
             "requests": [{"id": f"r{j}", "text": f"req {j} " + "x" * 200, "ts": old, "handled_ts": time.time()} for j in range(nreq)],
             "questions": []}
        if i <= questions:
            t["questions"].append({"id": "q1", "text": "which one?", "ts": old, "kind": "ask"})
        threads[tid] = t
    os.makedirs(tmp, exist_ok=True)
    with open(lean_threads.path(), "w") as fh:
        json.dump({"threads": threads, "aliases": {}, "overrides": {}}, fh)
    with open(os.path.join(tmp, "ledger.jsonl"), "w") as fh:
        for i in range(ledger):
            fh.write(json.dumps({"id": f"2026-{i:06d}-abcd", "ts": old, "status": "done", "task": "x" * 150}) + "\n")
    for i in range(work):
        d = os.path.join(tmp, "work", f"2026-{i:06d}-abcd")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "summary-1.txt"), "w") as fh:
            fh.write("s")
    with open(os.path.join(tmp, "goals.json"), "w") as fh:
        json.dump([{"id": f"g{i}", "text": "goal", "threads": [f"t{i % nthreads + 1}"]} for i in range(goals)], fh)
    for name in ("reports.json", "delivered-items.json", "report-states.json"):
        with open(os.path.join(tmp, name), "w") as fh:
            json.dump({f"k{i}": {"ts": time.time(), "text": "y" * 200} for i in range(3000)}, fh)
    tdir = os.path.join(tmp, "transcripts")
    os.makedirs(tdir, exist_ok=True)
    paths = []
    for i in range(live):
        p = os.path.join(tdir, f"s{i}.jsonl")
        with open(p, "w") as fh:
            for j in range(600):
                fh.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "z" * 700}],
                                                                     "usage": {"input_tokens": 100, "output_tokens": 5}}}) + "\n")
        paths.append(p)
    return paths
