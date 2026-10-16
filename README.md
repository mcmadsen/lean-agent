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

That gap is paid on *every* turn of *every* worker. A real run, "add `multiply()` to calc.py with a test",
took a Sonnet worker 3 turns, **9.4K weighted tokens and $0.02**. It followed the two cards it was given (type
hints, docstrings, the test command) and never saw the rest.

## Install

Requirements: Claude Code 2.1.300+ (CLI or Claude Desktop) and `python3`. No other dependencies.

```sh
git clone https://github.com/mcmadsen/lean-agent
export PATH="$PWD/lean-agent/bin:$PATH"     # add to your shell profile
lean-agent install                          # installs the plugin, creates ~/.lean-agent/home
```

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

`up` options: `--model` (default `sonnet`), `--name`, `--budget` (orchestrator session, weighted tokens),
`--daily-budget` (all workers per day), `--permission-mode`.

### Commands the orchestrator uses (you can too)

| Command | |
|---|---|
| `lean-agent projects` / `learn <path> [--name n]` | Register a project, or refresh its cards after CLAUDE.md changes. Card stats survive. |
| `lean-agent cards <project>` | Cards with size and hit rate (`used/sent`). `*` = core. |
| `lean-agent suggest <project> "<task>"` | Core cards plus best matches by keyword overlap × past usefulness, within a token cap. |
| `lean-agent run -p <project> -m <model> --why "..." [--cards a,b \| auto] [--read-only] [--max-usd X] [--max-turns N] "<task>"` | Run an isolated worker. Model and reason are **required**. |
| `lean-agent run --resume <run-id> "<follow-up>"` | Continue a worker's session (cheap: its context is cached). |
| `lean-agent card show\|add\|rm\|core <project> <id>` | Inspect or edit cards; `add` creates *note* cards from what workers had to discover. |
| `lean-agent optimize <project> [--apply]` | Promote/demote core cards, archive dead ones, flag big cards to trim, list recent context gaps. |
| `lean-agent stats [--today] [--project p]` | Runs, success rate, avg/total weighted tokens and cost per model. |

## How learning works

1. `learn` splits each `CLAUDE.md` (root, `.claude/`, nested up to 3 levels), `.claude/rules/*.md` and each
   `.claude/skills/*/SKILL.md` into **cards** at `#`/`##` headings.
2. Every worker ends with a `LEAN-FEEDBACK {...}` line: status, cards `used`, cards `unneeded`, and context
   that was `missing`. lean-agent strips that line and records it.
3. `optimize` uses the counts: ≥80% used → **core** (sent automatically), core <40% → demoted, ≤20% used and
   marked unneeded → **archived**. Big, often-used cards are flagged for rewriting shorter.
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

## Budgets

All budgets are in **weighted tokens**, input-token equivalents using the usual API price ratios:
`input + 1.25×cache_write + 0.1×cache_read + 5×output`.

| Variable | Default | |
|---|---|---|
| `LEAN_AGENT_BUDGET` | `up`: 1,000,000 | Orchestrator session budget, enforced by a PreToolUse hook (warns at `LEAN_AGENT_WARN_PCT`, default 80%, then blocks tool calls). |
| `LEAN_AGENT_DAILY_BUDGET` | off | `run` refuses new workers once today's ledger total reaches it. |
| `LEAN_AGENT_RUN_MAX_USD` | `3.0` | Default `--max-usd` per worker (`claude --max-budget-usd`). |
| `LEAN_AGENT_MAX_TURNS` | `40` | Default `--max-turns` per worker. |
| `LEAN_AGENT_WORKER_PERMISSION_MODE` | `acceptEdits` | Worker permission mode. |
| `LEAN_AGENT_WORKER_BASH_OUTPUT` | `12000` | `BASH_MAX_OUTPUT_LENGTH` for workers. |
| `LEAN_AGENT_RESULT_CHARS` | `2500` | Max worker summary printed back to the orchestrator (full result is saved). |
| `LEAN_AGENT_HOME` | `~/.lean-agent` | Where everything lives. |

## The plugin

Installing the plugin also gives any Claude Code session (not just the orchestrator):

- **Output squeezer:** a PostToolUse hook that shrinks noisy Bash output (6K to 30K chars) to the head, the tail
  and the error lines, and saves the full log for grep. Opt out per command with `LEAN_RAW=1`, or entirely
  with `LEAN_AGENT_SQUEEZE=0`. (Workers run in safe mode, so hooks don't run there. They get a smaller
  `BASH_MAX_OUTPUT_LENGTH` and frugal-command instructions instead.)
- **Budget guard:** the session budget above.
- Skills `/lean-agent:budget` (token breakdown for the session) and `/lean-agent:lean-mode` (frugal working rules).
- `lean-agent` on the Bash PATH.

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
