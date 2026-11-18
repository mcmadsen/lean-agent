---
name: scripts
description: Scripts over models - propose, audit, adopt, list and reuse small scripts through the lean_script tool, so counting, summing, aggregating, transforming, diffing and validating never needs a model reading the data. Use when you wrote a script that worked, before writing a new one, or for "which scripts do we have".
---

# Scripts over models

If a simple script can do the job instead of a model, run the script. Any script a session fabricates is audited and judged
before anyone reuses it. Look first: adopted scripts are recipe skills named `lean-agent-script-<name>` (synced into the
checkout by `lean_rules` `sync`; their `run:` line is the command), and `lean_script` `list` shows every candidate and
adopted script with its verdict and use count.

| action | who | input | effect |
|---|---|---|---|
| `propose` | thread | `path` (absolute), `name`, `purpose`, `run`, `inputs`, `outputs`, `project?` (default this thread's, or `global`) | the mod copies the script into `~/.lean-agent/scripts/candidates/<name>/` with `meta.json` (purpose, run, author, project, created, sha256). It never executes it. Secrets in the text refuse the proposal |
| `audit` | thread, desk | `name` | thread: returns the auditor brief; start ONE `lean-agent:auditor` with it. The mod records the verdict from the auditor's `LEAN-AUDIT` line when the Agent call returns (`report` = that line, only if the mod said it could not read it). Desk: starts a thread that does this |
| `list` / `show` | thread, desk | `name` for show | candidates, adopted, verdicts, uses |
| `retire` | thread, desk | `name`, `reason?` | moves it to `scripts/retired/`; its skill goes at the next `sync` |
| `decide` | desk only | `name`, `verdict` adopt or reject, `reason`, `confirm?` | the user overrides a verdict; logged in `scripts/decisions.jsonl` |

`run` is the command with `{script}` where the script's path goes and an interpreter first, e.g. `python3 {script} <ledger.jsonl>`;
no `;`, `&`, `|`, redirects or substitution. `outputs` lists every file it writes (`stdout` if it only prints).

Verdicts (`adopt`, `adapt` with the concrete changes, `reject` with the reason) are enforced by the mod, not the auditor: a
script that uses the network, deletes or overwrites, writes outside its declared outputs, hardcodes paths/ids/names (a home path
or an email in the text is found by a scan), or is right only for its original data is never `adopt` (`adapt`); one with a secret
is `reject`. `adapt`: fix the script, then propose it again under the same name. `adopt` moves it to `~/.lean-agent/scripts/<name>/`
(global) or `~/.lean-agent/<project>/scripts/<name>/` and writes its recipe skill.

`decide` adopt over an audit that said otherwise needs `confirm: true`, only after the user was told what they override; a
script with a secret or a hardcoded home path or email is never adopted, even by the user. A script that was never audited
cannot be adopted by `decide`.

A script about lean-agent's own data (`~/.lean-agent` files: ledger, reports, rules stats) is also filed in `feedback.jsonl`
as a "candidate for lean-agent core", so the maintainers can move it into the mod.

The mod nudges once per file: when a thread's Bash ran a script it wrote this session from a scratch place (`/tmp`, a scratchpad,
its own folder) and nothing proposed it, the next prompt carries "you ran <file>; if it is reusable, lean_script propose it".
