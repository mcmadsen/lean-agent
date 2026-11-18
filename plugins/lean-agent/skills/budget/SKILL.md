---
name: budget
description: Show today's lean-agent spend against the daily cap and set caps. Use when the user asks about remaining budget or wants to change a cap.
---

Today's spend is the sum of `usd` for today in `~/.lean-agent/ledger.jsonl`, per `role` (desk, thread, plain). Caps live in
`~/.lean-agent/config.json`: `{"dailyCapUsd": {"desk": 5, "thread": 20}, "workerCapUsd": 2, "workerCaps": {"worker-opus": 4}}` (a `workerCaps` key may be `worker-opus` or `lean-agent:worker-opus`).
Past a cap the next model request is refused with a notice; a worker past its cap ends and reports what is left.
Show spend against each cap that is set; to change a cap, edit that file. There is no plan-window percentage (no verified source).
