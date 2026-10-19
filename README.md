# lean-agent

**An orchestrator for Claude Code that runs worker agents on as few tokens as possible.**

You talk to one lean-agent orchestrator, from your phone through Remote Control, the Claude Desktop app, or
a terminal. It never does project work itself. For each piece of work it decides:

- **which context** the worker needs, chosen from a library learned from your project's `CLAUDE.md`, rules and skills
- **which model** (Sonnet by default, Haiku for cheap read-only work, Opus only when it's worth it)
- **which tools and limits** (read-only or not, max turns, max $)

Then it starts an isolated worker. Workers report back which context they used and what was missing, and the
library tunes itself: cards that are always used become *core*, unused ones are archived, and recurring gaps become new cards.

```
 you ──▶ orchestrator  (~/.lean-agent/home, Sonnet, short playbook CLAUDE.md, session budget)
            │  lean-agent suggest / run / stats / optimize
            ├──▶ worker  sonnet  cards: testing, code-style      tools: all      ─┐
            ├──▶ worker  haiku   cards: (none)       --read-only tools: R/Glob/Grep├─▶ ledger + card stats
            └──▶ worker  sonnet  --resume <run>                                   ─┘
                     cwd ~/.lean-agent/work/<run>,  --add-dir <your project>
```

## Why workers are cheap

A normal Claude Code session in your project loads the project's `CLAUDE.md`, every skill (project, user,
plugins), your plugins' hooks, MCP servers and dozens of tool schemas, and resends all of it on every turn.
lean-agent workers run with:

```
claude -p --safe-mode --disable-slash-commands --tools Bash,Read,Edit,Write,Glob,Grep \
          --add-dir <project> --append-system-prompt-file <protocol + selected cards> \
          --model <chosen> --max-turns N --max-budget-usd X
```

from a scratch folder, not your project, so nothing project-level auto-loads. Measured on Claude Code 2.1.301:

| Same one-line prompt | Context per turn |
|---|---|
| Default session started in the project | ~36,000 tokens |
| lean-agent worker | **~8,100 tokens** |

That gap is paid on *every* turn of *every* worker.

End to end, a headless Sonnet orchestrator was given *"orders with a discount are charged too little, the discount
seems applied twice; fix it and add a regression test"* in a sample monorepo with API, web and infra
`CLAUDE.md` files. It ran `suggest`, started one Sonnet worker with just the `api-layout` and `api-testing`
cards (why: *"bug fix plus test, moderate reasoning"*), and reported back. The worker fixed the bug with a 2-line
diff and added a regression test that failed before the fix. Total: **$0.07** (orchestrator $0.036, worker $0.030). A real run, "add `multiply()` to calc.py with a test",
took a Sonnet worker 3 turns, **9.4K weighted tokens and $0.02**. It followed the two cards it was given (type
hints, docstrings, the test command) and never saw the rest.

## Install

Requirements: Claude Code 2.1.300+ (CLI or Claude Desktop) and `python3`. No other dependencies.

```sh
git clone https://github.com/mcmadsen/lean-agent ~/lean-agent
~/lean-agent/install          # puts `lean-agent` on your PATH, installs the plugin, creates ~/.lean-agent/home
# open a new terminal, then:
lean-agent trust              # once: accept Claude Code's trust dialog for the orchestrator folder
```

**Updating:** run `lean-agent sync` (or ask the orchestrator to). It:
- pulls the clone (fast-forward only, and never with local changes) and re-runs itself on the new code
- runs `claude plugin marketplace update` and `claude plugin update`
- regenerates the orchestrator guide and settings
- re-learns every project, keeping card stats, and refreshes the repo blocks.

You don't need to close Claude Desktop or restart `lean-agent up`. The installed plugin's hooks and in-session
`lean-agent` command hand over to your clone (`~/.lean-agent/source`), so pulled code takes effect immediately, and
each new orchestrator session reads the refreshed guide and settings. `sync` says when a restart *is* needed (only
if the server's own settings changed), and an open session can re-read the rules with `lean-agent guide`.

`./install` links `lean-agent` into `~/.local/bin` (`LEAN_AGENT_BIN_DIR` changes this) and, if that folder isn't on
your PATH, adds one marked line to your shell's startup file (`~/.zshrc`, `~/.bash_profile`/`~/.bashrc`, fish
config or `~/.profile`). Running it again changes nothing. `./install --no-plugin` skips the plugin, and
`./install --uninstall` removes the link and the PATH line but keeps `~/.lean-agent`. To update, run `git pull` in the
clone; the link points at it, so there's nothing to reinstall.

`trust` matters. Claude Code ignores a folder's permission rules until the folder is trusted, and Remote Control
never shows the trust dialog, so without it every `lean-agent` call the orchestrator makes waits for your approval.
`lean-agent trust` opens Claude once in the orchestrator home so you can accept the dialog.
`lean-agent trust --write-config` sets `hasTrustDialogAccepted` in `~/.claude.json` directly, after a backup.

The plugin can also be added in **Claude Desktop**: **+** next to the prompt → **Plugins** → **Add plugin** →
marketplace `mcmadsen/lean-agent`.

## Use

```sh
lean-agent learn ~/code/shop --name shop    # index CLAUDE.md files, .claude/rules, .claude/skills
lean-agent up                               # orchestrator via Remote Control (Sonnet)
```

Open the Claude app → Code → **lean-agent**, and ask for work: *"In shop, fix the flaky checkout test and add a
regression test."* The orchestrator follows its playbook (`~/.lean-agent/home/CLAUDE.md`): picks cards, picks
a model, runs workers, and reports back briefly.

Other ways to run the orchestrator:
- `lean-agent up --local`: interactive in your terminal
- Claude Desktop: open the folder `~/.lean-agent/home` in the Code tab (`lean-agent home` prints the path)

`up` options: `--model` (default `sonnet`, `default` = your own default model), `--name`, extra flags for
`claude remote-control` after `--` (e.g. `lean-agent up -- --debug --debug-file /tmp/rc.log`), `--budget` (orchestrator session, weighted tokens),
`--budget-5h` / `--budget-week` (see Budgets), `--permission-mode`.

### Commands the orchestrator uses (you can too)

| Command | |
|---|---|
| `lean-agent projects` / `learn <path> [--name n]` | Register a project, or refresh its cards after CLAUDE.md changes. Card stats survive. |
| `lean-agent cards <project> [filter]` | Cards with size and hit rate (`used/sent`). `*` = core. Filter by id, title or path, e.g. `cards shop infra`. |
| `lean-agent suggest <project> "<task>"` | Task type (read/change/browser), recommended model (from your `stats` per type, else defaults; Haiku when a budget is low), a gather/judge split hint, then core cards plus relevant cards with cost and reason, or an explicit "No relevant cards". |
| `lean-agent run <project> -m <model> --why "..." [--cards a,b \| auto] [--read-only] [--chrome[=tools]] [--mcp s:t] [--max-usd X] [--max-turns N] -- "<task>"` | Run an isolated worker. Model and reason are **required**. `--read-only` allows Read/Glob/Grep and read-only `git -C <project> show/log/grep/diff/blame/fetch`. |
| `lean-agent run --resume <run-id> "<follow-up>"` | Continue a worker's session (cheap: its context is cached). |
| `lean-agent card show\|add\|rm\|core <project> <id>` | Inspect or edit cards; `add` creates *note* cards from what workers had to discover. |
| `lean-agent optimize <project> [--apply]` | Promote/demote core cards, archive dead ones, flag big cards to trim, list recent context gaps. |
| `lean-agent stats [--today] [--project p]` | Runs, success rate, avg/total weighted tokens and cost per model. |

## MCP servers in workers

Workers get **no MCP servers** unless the orchestrator asks for them, and then only the tools it names:

```sh
lean-agent mcp list -p shop --probe        # servers from ~/.claude.json, <project>/.mcp.json, Claude Desktop
lean-agent mcp tools tickets               # per-tool cost of the tool definitions, biggest first
lean-agent run -p shop -m sonnet --why "triage needs tracker" --read-only \
    --mcp tickets:get_ticket "Fetch ticket T-42 and say which file is responsible"
```

- `--safe-mode` turns MCP off, so a run with `--mcp` uses `--setting-sources "" --strict-mcp-config
  --mcp-config <file>` instead. Measured: same 8,070-token baseline and the same isolation (no user or project
  CLAUDE.md, settings, plugins or hooks), plus exactly the chosen servers.
- `server:tool,tool` blocks every other tool of that server with `--disallowedTools`, which removes their
  definitions from context. Example server: all tools ~2,150 tokens per turn, only `get_ticket` ~90.
- `mcp tools` asks stdio servers for their tool list directly, with no model call. The estimates were
  within 5% of a real measurement. For HTTP servers, use `mcp tools <server> --measure` (two tiny Haiku calls).
- The config is copied into the run folder owner-only (`0600`) and **deleted when the run ends**, because MCP
  configs often contain tokens. Server names and tool-call counts go into the ledger; configs don't.
- **Presets:** `lean-agent mcp preset <server> <name> <tool,tool>` saves a named set, and
  `--mcp <server>:<name>` uses it. Every server whose tool list is known gets an automatic `read` preset
  (get/list/search/query/... tools). `run` prints each server's chosen tools and per-turn cost before it starts,
  e.g. `mcp: tracker 6/40 tools ~1,900 tok per turn (whole server ~18,800)`.
- lean-agent counts which MCP tools each worker called. `optimize` then suggests narrowing a server to the tools
  that get used, or dropping it.
- Not covered: claude.ai connectors (they aren't in a local config file). Remote OAuth servers are untested.

## The reviewer: a quality gate before every PR

Low token use shouldn't mean low quality. `lean-agent review <project>` runs a **reviewer / tech lead** on
everything since the branch point (merge base with `origin`'s default branch, or `--base`). That includes
uncommitted changes and new untracked files.

- **Sonnet at high effort, with adaptive thinking.** It's the one place where lean-agent spends tokens on purpose,
  and it isn't downgraded when a budget runs low (`LEAN_AGENT_REVIEW_MODEL` / `LEAN_AGENT_REVIEW_EFFORT` change it).
- **Read-only, enforced:** Read, Glob, Grep and read-only `git -C <repo> diff/show/log/blame...`. It can't edit, run
  tests or build. What needs running goes back to the orchestrator as `checks`.
- **Context:** cards are picked from the changed file paths, plus core cards for the `review` task type.
- **Output:** a structured verdict (`approve`, `changes-requested`, `needs-checks`), findings with severity
  (blocker/major/minor/nit), file:line, the issue, why it matters and a fix, plus the checks to delegate.
  It exits 0 only on approve.
- **Review a branch or PR without checking it out:** `review <project> --head <branch> [--base <branch>]` reviews
  `merge-base..branch` straight from git. The reviewer reads files with `git show <commit>:<path>`, `origin/*` refs
  are fetched first, and your working tree is never touched.
- **Re-review:** `review <project> --resume` continues the same reviewer session, which is cheap because its
  context is cached, and checks earlier findings first. `review <project> --status` exits 0 only if the
  *current* code (HEAD plus uncommitted changes) has an approve. With `--head <branch>` it checks that branch's
  tip instead, whatever is checked out. The guide and repo block make that a hard rule
  before any PR.

Measured on a sample repo: a planted float-money change with no tests got 3 majors. These were the float rounding
bug with a concrete failing input, missing tests (citing the project's memory about money tests) and a double-VAT
risk (citing another memory). After a worker fixed them, the re-review confirmed the fixes and caught a new problem:
the worker had committed `__pycache__/*.pyc`. Each review cost about $0.06 and 30 s.

## A lean orchestrator

The orchestrator's own fixed context is paid on every turn, so lean-agent writes `~/.lean-agent/home/.claude/settings.json`
to cut it. It:
- denies every tool except Bash, Read and the background-task tools. The built-in Agent and Workflow tools are gone,
  so "delegate with `lean-agent run`" is enforced, not just requested.
- disables bundled skills, synced claude.ai skills (`settings.local.json`) and claude.ai connectors
- disables your other plugins and your user-level MCP servers in this folder only
- excludes outside CLAUDE.md files (`~/.claude/CLAUDE.md`, `~/CLAUDE.md` and other parent folders), which also
  removes conflicting subagent or workflow guidance. Bring personal preferences in as lean-agent memories instead
  (`lean-agent memory import`, or `memory add --type user`).

Measured with a typical setup (many skills, a plugin, 39 tools): **~35,700 → ~6,600 tokens of fixed context per
orchestrator turn**, plus ~2,000 for the guide. Other keys in that file, such as `model`, are kept.
`LEAN_AGENT_ORCHESTRATOR_TRIM=0 lean-agent home` removes the trimming. This applies only to the orchestrator
home; your normal sessions in a repo are untouched.

## Rules in every repo, and `doctor`

The orchestrator's instructions come from one generated guide, `lean-agent guide`. It holds the hard rules, the
precedence rule, worked examples and a CLI reference generated from the CLI itself, and the test suite executes
every example in it, so it can't drift from the CLI. The orchestrator home's `CLAUDE.md` is that guide.

Sessions often start inside a project repo instead of the home, so `learn` also writes a compact, marked
**lean-agent block** into the repo's `CLAUDE.local.md`:

- **Personal:** `CLAUDE.local.md` is Claude Code's file for personal, uncommitted project instructions, and lean-agent
  adds it to `.git/info/exclude`.
- **AGENTS.md repos:** if the repo relies on `AGENTS.md`, the block goes into `.claude/rules/lean-agent.md`
  instead, because a `CLAUDE.local.md` would stop Claude reading `AGENTS.md`.
- **What it says:** delegate with `lean-agent run`, never the built-in Agent or Workflow tools for project work,
  at most 4 workers at a time, and these rules take precedence over `~/CLAUDE.md`.
- **Updating:** re-running replaces only the text between the markers, so your own notes in the file stay. `install`,
  `up` and `learn` refresh it. `lean-agent rules <project> [--off]` turns it on or off.

`lean-agent doctor [path]` checks:
- that the CLI is on PATH
- the guide and trust in the orchestrator home
- that the folder belongs to a learned project
- which instruction files load there, and whether the lean-agent rules are among them
- whether a file outside the repo (like `~/CLAUDE.md`) contradicts them
- the AGENTS.md trap

It exits 1 on problems. `doctor --fix` refreshes the guide and block, and adds a one-line marked precedence note to
contradicting files outside the repo. It never edits files tracked in your repo.

## Browser tasks (Claude in Chrome)

Workers can use your real, signed-in Chrome through the
[Claude in Chrome](https://code.claude.com/docs/en/chrome) extension, for example to draft a reply in Teams, Gmail or
a ticket system that has no MCP server:

```sh
lean-agent chrome check        # once: starts a tiny Haiku session with --chrome and records tools and token cost
lean-agent run proj -m sonnet --why "reply in Teams" --chrome --cards mem-recipe-teams-message \
    -- "Draft a reply to Alex's last message in Teams: 'Thanks, I'll look at it today.'"
```

- **How it's isolated:** a `--chrome` run swaps `--safe-mode` for `--setting-sources "" --strict-mcp-config --chrome`.
  You keep the same isolation, and the only extra tools are the browser's. `--chrome=navigate,find` narrows it
  further, removing the other browser tools from context. `chrome check` tests whether the strict setup exposes the
  browser on your machine. If it doesn't, check falls back to a setup without `--strict-mcp-config` that blocks your
  configured MCP servers instead.
- **Site permissions:** these come from the Claude extension's settings. A headless worker can't answer a site prompt,
  so allow the sites it should use (e.g. Teams) in the extension first.
- **Built-in recipe:** the `mem-recipe-teams-message` memory explains the Teams steps: new tab, search, verify the
  header, Shift+Enter for line breaks because Enter sends, then stop before sending.

### Draft first, send only on approval

Workers are told never to do outward actions that can't be undone (send or post a message, submit, publish, merge,
deploy, delete remote data) on their own. Instead they stop with status **`awaiting-confirmation`** and say exactly
what they would do. After the user approves, the orchestrator resumes the same worker with
`--allow-send "<what was approved>"`. If a target is ambiguous (two people called Alex, no matching chat), the worker
returns **`needs-input`** with the candidates instead of guessing. This is enforced by instruction, not
technically: lean-agent can't block a click on a web page's Send button, so the browser recipe and the playbook repeat
it. Review what workers do in your browser.

## Shared memory

lean-agent replaces Claude Code's auto memory (including a shared `autoMemoryDirectory` setup) as the one place
agents remember things:

```sh
lean-agent memory where            # lean-agent's store + the Claude auto-memory folders it found
lean-agent memory import           # copy them in (reads autoMemoryDirectory from settings.json, or --from DIR)
lean-agent memory list [-p shop]
lean-agent memory add "Never merge on Fridays" --type feedback        # global
lean-agent memory add "Staging DB resets nightly" -p shop             # project-only
lean-agent memory rm <name>
```

- **Same format as auto memory:** one topic file per memory with `type` (user, feedback, project, reference) and
  `scope` (`global` or a project) frontmatter, plus a `MEMORY.md` index. Default location is `~/.lean-agent/memory/`.
  Set `LEAN_AGENT_MEMORY_DIR` to a git repo to share it across machines or with a team.
- **Nothing is loaded on every turn.** Auto memory loads up to 25 KB of `MEMORY.md` into *every* session. lean-agent
  turns auto memory off for the orchestrator and workers (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). Memories become
  `mem-*` cards, so a worker only gets the ones its task needs. User and feedback memories are always candidates
  in `suggest`, and `optimize` archives the ones that are never used.
- **Agents write memory too:** the orchestrator saves anything you ask it to remember, and workers can add durable
  facts to the `remember` field of their feedback line. User and feedback memories become global; project and
  reference memories stay with that project. Duplicate text is skipped.
- **Migration:** `import` copies and never changes your files. Once you're happy, set `"autoMemoryEnabled": false`
  in `~/.claude/settings.json` and remove `autoMemoryDirectory`, so normal sessions stop loading `MEMORY.md`.

Tested end to end: three imported memories, then *"Remember: prices shown to customers are VAT-inclusive. Then add a
function that splits a total in cents across N people, with tests"*. The orchestrator saved the new memory scoped to
the project. The worker received the imported *"money tests use integer cents and cover rounding"* memory and wrote
exact-cent tests with 1-cent remainder cases.

## How learning works

1. `learn` splits each `CLAUDE.md` (root, any `dir/.claude/CLAUDE.md`, nested up to 5 levels), `CLAUDE.local.md`,
   `AGENTS.md` (only where a folder has no `CLAUDE.md`, as Claude Code does by default), `.claude/rules/*.md`
   and each `.claude/skills/*/SKILL.md` into **cards** at `#`/`##` headings. Shared memories are added as `mem-*` cards. Card ids are prefixed with the folder
   (`mobile-app-rules`, `admin-portal-app-rules`). Git worktrees (including Claude's `.claude/worktrees/`) and
   submodules are skipped, so agent checkouts don't duplicate cards.
2. Every worker ends with a `LEAN-FEEDBACK {...}` line: status, cards `used`, cards `unneeded`, and context
   that was `missing`. lean-agent strips that line and records it.
3. `optimize` works **per task type**. A card used in at least 80% of 5 or more runs of one type, and never marked
   unneeded, becomes **core for that type**: it's sent automatically to that type only. Core cards used in under 40%
   are demoted. Cards used in at most 20% and marked unneeded are **archived**, and big, often-used cards are flagged
   for rewriting shorter. Workers report a card as used only if it changed what they did.
   Relevance in `suggest`: words are weighted by how rare they are across your cards. A card needs a distinctive
   title word or several body words, cards over 800 tokens need a title match, and ranking divides by card size.
4. Recurring `missing` notes are turned into **note cards** by the orchestrator (`card add`). Notes survive
   re-learning.

Your project files are never modified by learning. Everything lives in `~/.lean-agent/`:

```
~/.lean-agent/
  home/                 orchestrator folder (CLAUDE.md playbook, .claude/settings.json)
  library/<project>/    cards.json, missing.jsonl
  work/<run-id>/        worker cwd, append.md (exact context sent), result.json
  ledger.jsonl          one line per run: model, why, cards, tokens, cost, status
  projects.json
```

### Which model runs the orchestrator

`claude remote-control` silently drops a `--model` flag, so remote sessions would start on your default model,
which may be the most expensive one. `up` therefore writes the model into `~/.lean-agent/home/.claude/settings.json`,
which those sessions do read. Token counts are similar across models, but price per token is not: Fable 5.1 costs
5× Sonnet 5.5 for input and output. The orchestrator only plans, picks cards and models, and reads short summaries,
and Sonnet handled that well in every test. Use `up --model default` to run it on your own default model instead.
You can also switch the model of a running session in the app.

## Budgets

### Plan windows (Claude Pro / Max)

Subscription plans limit usage per rolling **5-hour window** and per **week**, and budget in those same windows:

```sh
lean-agent limits                          # usage in both windows, lean-agent vs all Claude Code on this machine
lean-agent limits --5h 2000000 --week 15000000
lean-agent limits --off
```

- **What's counted:** usage comes from Claude Code's session logs on this machine, read incrementally and
  timestamped. That includes the orchestrator, every worker and their subagents.
- **Model-aware units:** **Sonnet-equivalent tokens**, which are weighted tokens scaled by the model's price
  relative to Sonnet 5.5. Haiku 5.5 counts 0.05×, Opus 5.5 2× and Fable 5.1 5×. Anthropic doesn't publish exactly
  how each model counts against plan limits, so price ratios are the proxy.
- **What the budgets limit:** budgets apply to lean-agent's own sessions. `limits` also shows all Claude Code
  usage on this machine, so you can compare it with `/usage`. Claude.ai chats and other machines are not visible.
- **Enforcement:** when a window's budget is used up, `run` refuses new workers and says when the window starts
  freeing up. The orchestrator's hook blocks its own tool calls the same way, but `lean-agent limits` and `stats`
  stay allowed so you can raise the budget from your phone. Your normal sessions are never blocked.
- **Calibrating:** work normally for a while, compare `limits` with `/usage`, then set the share of your plan you
  want agents to use. Windows here are rolling, which is slightly stricter than a window that resets 5 hours after
  your first message.
- Budgets are saved in `~/.lean-agent/limits.json`. The env vars `LEAN_AGENT_5H_BUDGET` and
  `LEAN_AGENT_WEEKLY_BUDGET` override them.

### Other limits

The session budget is in **weighted tokens**, input-token equivalents using the usual API price ratios:
`input + 1.25×cache_write + 0.1×cache_read + 5×output`.

| Variable | Default | |
|---|---|---|
| `LEAN_AGENT_BUDGET` | `up`: 1,000,000 | Orchestrator session budget, enforced by a PreToolUse hook (warns at `LEAN_AGENT_WARN_PCT`, default 80%, then blocks tool calls). |
| `LEAN_AGENT_RUN_MAX_USD` | `3.0` | Default `--max-usd` per worker (`claude --max-budget-usd`). |
| `LEAN_AGENT_MAX_TURNS` | `40` | Default `--max-turns` per worker. |
| `LEAN_AGENT_WORKER_PERMISSION_MODE` | `acceptEdits` | Worker permission mode. |
| `LEAN_AGENT_WORKER_BASH_OUTPUT` | `12000` | `BASH_MAX_OUTPUT_LENGTH` for workers. |
| `LEAN_AGENT_RESULT_CHARS` | `12000` | Max worker reply printed back to the orchestrator (workers lead with a summary; the full result is saved). |
| `LEAN_AGENT_HOME` | `~/.lean-agent` | Where everything lives. |

## The plugin

Installing the plugin also gives any Claude Code session (not just the orchestrator):

- **Output squeezer:** a PostToolUse hook that shrinks noisy Bash output (6K to 30K chars) to the head, the tail
  and the error lines, and saves the full log for grep. Reads (`cat`, `sed -n`, `head`, `grep`/`rg`,
  `git show/grep/diff/log/blame`) are never squeezed. Opt out per command with `LEAN_RAW=1`, or entirely
  with `LEAN_AGENT_SQUEEZE=0`. (Workers run in safe mode, so hooks don't run there. They get a smaller
  `BASH_MAX_OUTPUT_LENGTH` and frugal-command instructions instead.)
- **Budget guard:** the session budget above.
- Skills `/lean-agent:budget` (token breakdown for the session) and `/lean-agent:lean-mode` (frugal working rules).
- `lean-agent` on the Bash PATH.

## Troubleshooting Remote Control

`CCR v2 worker registration failed ... 404` on every start: when you stop `claude remote-control`, it keeps a
pointer so the next start can bring back the same session. If that session was archived or expired in the meantime,
the server answers "Session not found" and the worker registration fails, again on every start. Run
`lean-agent up --fresh` once to drop the pointer and start a new session. The server itself keeps working either way.
For other errors: `claude update`, then `claude auth logout && claude auth login`, then
`lean-agent up -- --debug --debug-file /tmp/rc.log` and look at the log. See also the [Remote Control troubleshooting docs](https://code.claude.com/docs/en/remote-control#troubleshooting).

## Caveats

- **Workers can run Bash without asking** (`--allowedTools` includes Bash, permission mode `acceptEdits`) in
  your project. Use a git repo, review diffs, use `--read-only` for investigation, or set
  `LEAN_AGENT_WORKER_PERMISSION_MODE` / `--tools` to restrict.
- Workers in safe mode get no MCP servers, hooks or plugins. If a task needs one, the orchestrator should
  do that step itself or you run it in a normal session.
- Your user-level `~/.claude/CLAUDE.md` and plugins still load in the **orchestrator** (Remote Control
  doesn't accept `--settings`/`--setting-sources`). Keep them small, or run the orchestrator under a
  separate `CLAUDE_CONFIG_DIR`.
- The session budget guard and `lean-agent budget` read Claude Code's transcript files, whose format is
  internal. Worker accounting uses the documented `--output-format json` result instead.
- Card selection is keyword-based plus learned hit rates. The orchestrator model makes the final call.

## Development

```sh
python3 tests/test_hooks.py           # squeeze + budget hooks
python3 tests/test_orchestrator.py    # CLI with a fake `claude` binary
claude plugin validate . && claude plugin validate plugins/lean-agent
```

## License

MIT
