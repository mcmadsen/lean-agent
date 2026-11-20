---
name: scripts
roles: desk, thread
description: Scripts over models - propose, audit, adopt, list and reuse small scripts through the lean_script tool, so counting, summing, aggregating, transforming, diffing and validating never needs a model reading the data. Use when you wrote a script that worked, before writing a new one, or for "which scripts do we have".
---

# Scripts over models

If a simple script can do the job instead of a model, run the script. Any script a session fabricates is audited and judged
before anyone reuses it. Look first: adopted scripts are recipe skills named `lean-agent-script-<name>` (synced into the
checkout by the mod at sync (thread: `lean_rules` `sync`); their `run:` line is the command), and `lean_script` `list` shows every candidate and
adopted script with its verdict and use count.

| action | who | input | effect |
|---|---|---|---|
| `propose` | thread | `path` (absolute), `name`, `purpose`, `run`, `inputs`, `outputs`, `project?` (default this thread's, or `global`) | the mod copies the script into `~/.lean-agent/scripts/candidates/<name>/` with `meta.json` (purpose, run, author, project, created, sha256). It never executes it. Secrets in the text refuse the proposal |
| `audit` | thread, desk | `name` | thread: returns the auditor brief; start ONE `lean-agent:auditor` with the block between the markers as its WHOLE prompt, unchanged: the guard refuses any other prompt for that agent, and the mod ignores a verdict from one. Run the auditor in the foreground: the mod records the verdict from the auditor's `LEAN-AUDIT` line when the Agent call returns, once per script content, and only when the line carries the sha256 of the stored text (the brief gives it). A background auditor returns before there is a verdict (the mod cannot see the later hand-back): then pass it on with `record-audit`. The reply says "Audit started; verdict not recorded yet" until a verdict exists. Desk: starts ONE thread that does this per script text (a second `audit` while it runs starts nothing and names the thread) |
| `record-audit` | thread, desk | `name`, `sha`, `verdict` adopt / adapt / reject, `network`, `deletes`, `secrets`, `generalises` (true or false, all required), `reads`, `writes`, `hardcoded`, `changes`, `reason` | the fields of a `LEAN-AUDIT` line whose auditor ran in the background, passed on by the audit thread (or the thread that started the auditor, or the desk). The mod checks it like a reply: the sha256 must be the stored text's, every flag answered, and its own rules apply on top (network, deletes, hardcoded values or a stray write are never `adopt`). A verdict passed on this way is recorded but **never adopts by itself**: a clean `adopt` waits for the desk (`audited`: the user's `decide` or the pane's Adopt); `adapt` and `reject` take effect as for a reply. It also needs the mod's own record that an auditor started with the exact brief for that text, so a verdict cannot be asserted for a script nobody audited. Copy what the auditor said; never invent or soften it |
| `list` / `show` | thread, desk | `name` for show | candidates, adopted, verdicts, uses (a thread sees its own project's scripts and the global ones; `diff` and `audit` follow the same rule) |
| `retire` | thread, desk | `name`, `reason?` | moves it to `scripts/retired/`; its skill goes at the next `sync` |
| `update` | thread, desk | `name`, a new file `path` or `edits: [{find, replace}]`, optional `purpose` / `run` | stores a pending version `vN` plus the diff against the current one (never run, never current). `audit` then gives the auditor the diff: it audits ONLY the change plus the checklist. On adopt `current` switches and `run` is overwritten: rule line and skill need no edit. A changed purpose or run line is shown in the verdict and needs the desk's `decide` |
| `rollback` | desk; thread with `reason` | `name`, `version?` | switches back to an audited version (default: the one before current) instantly, logged. Also restores `run` after a hand edit |
| `report-bad` | thread | `name`, `why` | the script's result was wrong: marked `needs-update` at once |
| `diff` | thread, desk | `name`, `a?`, `b?` | the change between two versions (default: before current and current, or current and the waiting update) |
| `decide` | desk only | `name`, `verdict` adopt or reject, `reason`, `confirm?` | the user overrides a verdict; logged in `scripts/decisions.jsonl`. When the store has no verdict, `decide` takes the last report of the audit thread that carries a `LEAN-AUDIT` line for this script text and says so ("verdict taken from the audit thread's report", logged); a verdict with the network flag still needs `confirm: true` after the user was told |

`run` is the command with `{script}` where the script's path goes and a bare interpreter first (python3, node, bash, sh, ruby,
perl ...), e.g. `python3 {script} <ledger.jsonl>`; no inline-code flags (`-c`, `-e`), quotes, `;`, `&`, `|`, redirects or
substitution. `outputs` lists every file it writes (`stdout` if it only prints); a catch-all entry (`/`, `~`, `*`, `..`) is refused.
`project` is this thread's own project or `global`. The mod keeps the store under a lock, one change at a time across sessions.

Verdicts (`adopt`, `adapt` with the concrete changes, `reject` with the reason) are enforced by the mod, not the auditor: a
script that uses the network, deletes or overwrites, writes outside its declared outputs, hardcodes paths/ids/names (a home path
or an email in the text is found by a scan), or is right only for its original data is never `adopt` (`adapt`); one with a secret
is `reject`. `adapt`: fix the script, then propose it again under the same name. `adopt` moves it to `~/.lean-agent/scripts/<name>/`
(global) or `~/.lean-agent/<project>/scripts/<name>/` and writes its recipe skill.

An `adopt` verdict adopts on its own ONLY when the mod's own checks prove the script clean: a run line on the allowlist, no secret or
privacy finding, no network or delete (the auditor's answer and the mod's text scan), no write outside its declared outputs (a
script declaring only stdout/stderr that opens a file for writing is caught), nothing hardcoded. When the auditor said adopt but one
of those fails (and it is not a secret, a privacy finding or a bad run line, which go back as `adapt`), the status becomes
`audited`: it is NOT adopted and waits for the desk. The pane's Scripts line lists it ("waits for you") with Adopt / Reject (two
presses, like Close); the desk's `decide` does the same (adopt over the mod's rules needs `confirm: true`). Both are logged as the
user's decision. An update waits the same way (a changed purpose or run line always does).

Versions: an adopted script keeps `scripts/<name>/v1/`, `v2/` ... (sha256, author, date and audit verdict per version in
`meta.json`) and a stable `scripts/<name>/run`, a copy of the current one; rule lines and skills always name `run`.
Rule lines: between `<!-- lean-agent:scripts -->` markers the mod writes one line per adopted script into the rule of its area
(by the paths in its inputs/outputs; else, or for a global script, `_project`), regenerated from the store at every sync, so
learn/trim rewrites lose nothing, the rule caps hold (overflow goes to `_project`, then one "N more scripts" pointer), and
retire removes the line. `_project` also carries once the line "Prefer scripts over model work ...".
Self-healing: a Bash run of an adopted script that fails is counted; two failures (or one `report-bad`) mark it `needs-update`
(the rule line says so, the next thread that uses it is nudged once to send a fix with `update`, the desk pane and `list` show
it). A script whose `run` or version file was edited by hand is `edited, unaudited`: never advertised as a skill, flagged in the
rule line, warned about on every thread run, and refused to subagents; `update` or `rollback` ends it. When a thread reports
`done` the report result asks once per session: could any step have been a script?

The mod also scans the text itself, whatever the auditor says: network tools or libraries and deleting or moving over files make
the verdict `adapt` at best. What the mod cannot re-derive (writes, "right on other data") is the auditor's judgement; the
user's `decide` is the human gate.

`decide` adopt over an audit that said otherwise needs `confirm: true`, only after the user was told what they override; a
script with a secret or a hardcoded home path or email is never adopted, even by the user. A script that was never audited
cannot be adopted by `decide` (an audit that was started and whose verdict is not recorded yet shows as "audited, waiting for the
verdict" in `show`; `decide` then uses the audit thread's report if there is one, else says the verdict has not arrived).

A script about lean-agent's own data (`~/.lean-agent` files: ledger, reports, rules stats) is also filed in `feedback.jsonl`
as a "candidate for lean-agent core", so the maintainers can move it into the mod.

The mod nudges once per file: when a thread's Bash ran a script it wrote this session from a scratch place (`/tmp`, a scratchpad,
its own folder) and nothing proposed it, the next prompt carries "you ran <file>; if it is reusable, lean_script propose it".
