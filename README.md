# lean-agent

Keep Claude Code agents running on fewer tokens.

`lean-agent` is a Claude Code plugin (works in the CLI and the **Claude Desktop Code tab**) plus a
small launcher for long-running agents you drive from your phone with **Remote Control**.

| Piece | What it does |
|---|---|
| **Output squeezer** (PostToolUse hook) | Shrinks noisy Bash output (test runs, builds, installs, logs) to the head, the tail and every error-looking line, collapses repeated lines and progress bars, and saves the full output to a file Claude can grep if it needs more. |
| **Budget guard** (PreToolUse hook) | Tracks tokens used by the session *and its subagents*. At 80% it nudges Claude to wrap up; at 100% it blocks further tool calls and tells Claude to summarise and stop. |
| **`/lean-agent:budget`** skill + `lean-budget` command | Per-model breakdown of input, cache write, cache read and output tokens. |
| **`/lean-agent:lean-mode`** skill | Frugal working rules: search before reading, read line ranges, quiet commands, delegate bulk work to a small model, keep a `PROGRESS.md` for resumable long runs. |
| **`lean-agent up`** launcher | Starts `claude remote-control` with cheap defaults (subagents on Haiku, earlier auto-compaction, smaller tool output limits, a session budget). |

Example of what Claude sees for a 10.8 KB test log with one failure:

```
[lean-agent: output squeezed 10,806 -> 280 chars. Full output: ~/.claude/plugins/data/…/toolu_….log (grep it or Read with offset/limit if you need more)]
1
2
…
… [1985 lines omitted] …
1999
2000
ERROR: boom at step 7
1
…
```

## Install

Requirements: Claude Code (CLI or Claude Desktop), `python3` on PATH. No other dependencies.

**Claude Desktop (Code tab):** click **+** next to the prompt box → **Plugins** → **Add plugin**, add the
marketplace `mcmadsen/lean-agent`, then install `lean-agent`.

**CLI:**

```sh
claude plugin marketplace add mcmadsen/lean-agent
claude plugin install lean-agent@lean-agent
```

or, after cloning this repo, `./bin/lean-agent install`.

Try it for one session without installing: `claude --plugin-dir ./plugins/lean-agent`.

## Long-running agents with Remote Control

```sh
git clone https://github.com/mcmadsen/lean-agent && export PATH="$PWD/lean-agent/bin:$PATH"
lean-agent install
lean-agent up ~/code/my-project --budget 3000000 --model sonnet --permission-mode acceptEdits
```

Then open the Claude app (or claude.ai/code), pick the session named `lean: my-project`, and give it work.
The agent runs on your machine with your files, you steer it from anywhere, and the budget guard
stops it before it burns through your usage.

`lean-agent up` options: `--budget N`, `--model M`, `--subagent-model M` (default `haiku`), `--name NAME`,
`--permission-mode MODE`, `--worktree` (each remote session gets its own git worktree).

## Configuration

Everything is environment variables. `lean-agent up` sets them for you; for Claude Desktop or plain
`claude`, put them in the `env` block of `~/.claude/settings.json` (`lean-agent env --json` prints one).

| Variable | Default | Meaning |
|---|---|---|
| `LEAN_AGENT_BUDGET` | unset (track only) | Per-session budget in **weighted tokens** (see below). `up` defaults it to 2,000,000. |
| `LEAN_AGENT_WARN_PCT` | `80` | Nudge Claude to wrap up at this percentage. |
| `LEAN_AGENT_SQUEEZE` | on | `0` disables the output squeezer. |
| `LEAN_AGENT_SQUEEZE_OVER` | `6000` | Only squeeze Bash output longer than this many characters. |
| `LEAN_AGENT_SQUEEZE_TO` | `4000` | Target size after squeezing. |

Put `LEAN_RAW=1` anywhere in a command (e.g. `LEAN_RAW=1 npm test`) to get its raw output once.

Claude Code settings that `up` also sets (all are standard Claude Code env vars):
`CLAUDE_CODE_SUBAGENT_MODEL=haiku`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70`,
`BASH_MAX_OUTPUT_LENGTH=20000`, `MAX_MCP_OUTPUT_TOKENS=10000`.

### Weighted tokens

Token kinds cost very different amounts, so the budget counts them in input-token equivalents using the
usual API price ratios:

```
weighted = input + 1.25 × cache_write + 0.1 × cache_read + 5 × output
```

A budget of 2,000,000 weighted tokens costs about what 2M uncached input tokens would on the session's
model. Run `lean-budget` (or `/lean-agent:budget`) to see the breakdown.

## How it works and limits

- The squeezer uses the PostToolUse `updatedToolOutput` field, so it only changes what Claude *sees*. The
  command already ran and the full output is kept in `~/.claude/plugins/data/<plugin>/outputs/` for 2 days.
- Very large outputs (above `BASH_MAX_OUTPUT_LENGTH`, 30,000 chars by default) are already moved to a file
  by Claude Code itself, so lean-agent saves most in the 6K to 30K range, which would otherwise go into
  context in full on every later turn.
- Squeezing is heuristic. If Claude needs a line that was cut, it can grep the saved log, and `LEAN_RAW=1`
  turns squeezing off for one command.
- Token usage is read from Claude Code's session transcripts (`~/.claude/projects/…/*.jsonl`). That format
  is internal to Claude Code and not a public API, so a future release could break the budget guard. If it
  does, the guard fails open (it never blocks because of a parse error).
- The budget is checked before each tool call, so a single long reply with no tool calls can overshoot it.

## Development

```sh
python3 tests/test_hooks.py          # unit tests for both hooks and the report
claude plugin validate .             # marketplace manifest
claude plugin validate plugins/lean-agent
```

## License

MIT
