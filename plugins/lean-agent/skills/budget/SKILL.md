---
name: budget
description: Show today's lean-agent spend against the daily cap and set caps. Use when the user asks about remaining budget or wants to change a cap.
argument-hint: [show | cap <usd>]
roles: desk, thread
---

Today's spend is the sum of `usd` for today in `~/.lean-agent/ledger.jsonl`, per `role` (desk, thread, plain). Caps live in
`~/.lean-agent/config.json`: `{"dailyCapUsd": {"desk": 5, "thread": 20}, "workerCapUsd": 2, "workerCaps": {"worker-opus": 4}}` (a `workerCaps` key may be `worker-opus` or `lean-agent:worker-opus`).
Past a cap the next model request is refused with a notice; a worker past its cap ends and reports what is left.
Alerts are on by default and never refuse anything: `{"budget": {"daily": 25, "threadDaily": 15}}` (USD, both the defaults; `"off"`
turns one off). The desk gets a notice and a toast at 50% and 80% of `budget.daily` (once a day per level: today's spend, the top 3
threads by cost and their models) and when one thread passes `budget.threadDaily`; the chaser also asks a stale thread over it what the
spend bought. When the user asks "what did today cost", say the alert levels next to the caps.
Show spend against each cap that is set (desk and thread: Read). To change a cap, thread: edit that file; desk: it has no Edit/Write, so tell the user the line to put in `config.json` or `send` it to a thread. There is no plan-window percentage (no verified source).
