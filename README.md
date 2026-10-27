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

`up` runs **one** interactive orchestrator session (in a pseudo-terminal it owns, also under launchd or systemd), and
everything else shares it: the Claude app (Remote Control) and the terminal are views of the same
conversation. A restart of `up` continues the conversation (`--fresh` starts a new one). Other lean-agent processes
type into it through a local socket (`~/.lean-agent/session.sock`, or `/tmp/lean-agent-<uid>/<digest>.sock` when
that path is too long for a unix socket; mode 0600).

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
| `lean-agent run <project> ... --read-only --ref <branch>` | A read-only worker on a branch that isn't checked out: it's told to read with `git show <sha>:<path>` and search with `git grep ... <sha>`. Starting the same task again while it runs or right after it finished is refused (`--again` to run it anyway). |
| `lean-agent recipe add <project> <name> -m <model> --why "..." --task-file F [--read-only] [--mcp s:p] [--evidence "..."] [--apply-task-file F2 --apply-mcp s:p]` | Save a named recipe: a stored run with `{placeholders}`, evidence hints (strongest first) and an optional apply step. `lean-agent recipes` lists them. |
| `lean-agent do <project> <recipe> [key=value ...] [--apply [--allow-send "<approved>"]]` | Run a recipe in one command. `--apply` runs its apply step with the last check's answer as its plan (`--from <run-id>`, or `--fresh` to re-derive); outward changes stop with the list until the user approves them. A recipe saved with `--fields id,title,state` tells workers to fetch only those; with `--complete` every item must be listed (OK / change / unclear) or the run fails. |
| `lean-agent text-len <file> [-p project]` | Characters, words, lines, checked against limits named in the project's tracker notes (e.g. a description limit). |
| `lean-agent card shorten <project> <id> [--save]` | A shorter text for a card (one Haiku call); lists headings, `code`, paths, names and numbers that would be lost, and saves only if none are. |
| `lean-agent runs --running` | Runs in progress. Every run prints `run <id> started` first, so a background launch is visible. A run's work happens in a detached process, so killing the command (or a `/clear`) doesn't stop it; Ctrl-C does. |
| `lean-agent runs --lost [--clear]` | Runs whose supervisor died without a result (hidden from `--running`). `--lost --clear` marks them acknowledged so they stop appearing; `runs --stop <id>` still closes one by id. `--clear` alone is a usage error. |
| `lean-agent runs --wait <id\|all\|last> [--timeout S]` | Blocks until those runs are recorded, then prints each result as `run` printed it. Exit 1 if one failed, 124 on timeout. After a clear: `lean-agent runs --wait all`. |
| `lean-agent run --resume <run-id> "<follow-up>"` | Continue a worker's session (cheap: its context is cached). |
| `lean-agent card show\|add\|rm\|core\|unarchive\|protect <project> <id>` | Inspect or edit cards; `add` creates *note* cards from what workers had to discover. `protect` (`--off` to undo) keeps `optimize` from archiving, demoting or trimming a card; `unarchive` brings one back (`core` on an archived card unarchives it too). `optimize --apply --skip a,b` leaves those cards out. |
| `lean-agent optimize <project> [--apply [ids]] [--accept ids] [--reject ids] [--unreject ids]` | Promote/demote core cards, archive dead ones, flag big cards to trim, list recent context gaps, and draft new recipe cards and MCP presets from what workers actually did. |
| `lean-agent runs [--last] [--tokens] [--show [id]] [--details] [--grep TEXT] [--tail [N]]` | Recent runs; a run that fails, stops or hits a limit ends its output with `run <id> failed: <reason>`, and `--show <id> --tail N` (default 20) prints just the last N lines of its summary, reason included; `--tokens` prints the latest run's run/tokens/context lines again, `--show` its whole summary (saved per run, so a `| tail` can't lose it), `--details` its details file, `--grep` only matching lines. |
| `lean-agent run ... --answer-lines N` | The worker answers in at most N lines (default 25 in the orchestrator, `LEAN_AGENT_ANSWER_LINES`) and puts tables, lists and evidence after a `=== DETAILS ===` line; lean-agent saves that part to a file and prints only its path. An answer far past N lines is cut there and the rest opens the file. `0` = whole answer. Reviewers and other roles are never cut. |
| `lean-agent run ... --escalate haiku,sonnet` | Run on haiku; only if that run fails (or errors, or stops), run the task again on sonnet. `suggest` recommends it and shows how similar earlier tasks did per model ("similar tasks ran on haiku: 6/6 done"). |
| `lean-agent run ... --max-reads TOKENS` | Stop a worker once it has re-read this much context over all its calls (default 6,000,000; 0 = off; not for reviewers). The run can be resumed; the message says how to split the task instead. |
| `lean-agent stats [--today] [--project p] [--top N]` | Runs, success rate, avg/total weighted tokens and cost per model; `--top N` lists the biggest runs with turns, context per turn and task. |
| `lean-agent budget [--by-run [N]]` | This orchestrator session: tokens, context per call by quarter, what re-reading context above ~67K cost, the orchestrator's share next to its workers, and with `--by-run` its biggest runs. |
| `lean-agent handoff [--note TEXT [--kind decision\|reminder\|fyi]] [--done N\|all]` | The hand-off note a compacted or new orchestrator session starts with (injected at SessionStart after a compaction, and at startup when there was work in the last 12 hours): open items and pending decisions, standing rules (feedback memories), recent runs with their details files, running runs, items and branches touched (`PR 512 (feature/x)`, never a bare commit), latest reviews. Recent runs show their result's first sentence; standing rules are de-duplicated and ranked: core or protected memory cards first, then ones about the current work, the most used, the newest (10 at most). `--note` answers just `note N added`. |
| `lean-agent review <project> --goal "<task or PR title>"` | Completeness: the reviewer states what the change promises and walks the whole chain (code, config, build, signing, hosting, update path, pipeline, docs). lean-agent scans the added lines (code and docs, and untracked files in a working-tree review) and the commit messages for self-declared gaps ("not done yet", "not yet wired", "installs nothing", TODO, FIXME, placeholder, stub, `<host>` in a doc) and gives every hit to the reviewer; one it doesn't address sends it back once. A gap that keeps the goal from working, not scoped out, is a major finding. Every gap is listed as a "known gap" (`g1`, `g2` ...) until the user decides: `review decline <project> g1 --why "out of scope: ..."`; `review --status` exits 2 while one is open, and an approval with open gaps says to ask the user first. `--all-gaps` acknowledges them all; an acknowledgement carries over to later tips by file and text. In code only comments count (not names like a `renderPlaceholders` helper), and a gap that only repeats a nit stays a nit. When the CI pipeline checks out only some folders (`sparseCheckoutDirectories`, `sparse-checkout`), tests the change adds that read other top-level folders become checks ("CI parity"): they pass in a worker's full worktree and fail in CI. |
| `lean-agent run ... --worktree origin/<branch>` | Reusing a worktree never throws away commits that aren't on the ref (e.g. a worker's merge): it says so and keeps them; `--reset-worktree` discards them on purpose. Every run prints the worktree's HEAD, and when it moved. A detached worktree of `origin/<branch>` pushes to `<branch>` with `worktree push`; a clean merge of the base branch (no hand-made conflict edits, none of the PR's own files touched) keeps the PR's approving review. |
| Status line | The orchestrator home's settings give Claude Code a status line: `lean-agent · ctx 34k/67k · week 48% on pace · 2 running · 3 todo · next job Mon 08:45` (a status line you set yourself stays). |
| `lean-agent grep-log <file> [PATTERN] [-C N]` | The lines that matter in a saved CI or build log (plain text, or JSON such as `{"value": [lines]}`): errors and failures by default, with context, at most 80 lines. |
| `lean-agent run ... --todo N` | The run works on work-queue item N: an open item becomes doing, and the run is listed on that item. A resumed run keeps it. `review` and `do` take it too; `--todo none` marks a quick lookup that isn't queue work. In the orchestrator, a worker start with neither is refused with the open items listed, so the queue stays current (`LEAN_AGENT_TODO_REMINDER=0` turns that off); the guide has the rest: every request is an item with its `--ref`, finished items are closed, decisions you owe are hand-off notes. |
| `lean-agent run ... --read-only --allow-cmd "<prefix>"` | A read-only worker may also run exactly this read-only command (e.g. `az pipelines runs show`); prefixes with a changing verb are refused. A read-only task that names a CLI without it gets a warning. |
| `lean-agent todo add\|list\|next\|start\|done\|note\|edit\|rm` | The work queue across sessions and days: `todo add "<text>" -p <project> --ref "PR 512" --prio high --due 2026-10-24`; `next` picks what's in progress, then by priority and due date. The hand-off note shows the open items, so a new conversation picks up the queue. |
| `lean-agent schedule add "<when>" <lean-agent command>` | Recurring work: `"hourly"`, `"every 2h"`, `"daily 09:00"`, `"weekdays 08:45"`, `"mon,wed 10:00"`; the command is a lean-agent one (`do <project> <recipe>`, `run ...`, `review ...`, `week`), never arbitrary shell, so outward actions still stop for approval. `list`, `rm N`, `run N` (now), `pause N`, `resume N`; `schedule defaults` adds an update check every morning (`sync --check`, installs nothing), a weekly `optimize` report per project and a Friday `week` report. Jobs run while `lean-agent up` runs (a timer in it), else from the orchestrator's next tool call; a slot missed by more than 6 hours waits for the next one. Results go to `~/.lean-agent/scheduled/`; the running conversation is told when one finishes, and the hand-off note lists them. |
| `lean-agent week [--days N]` | The week: pace against your plan, runs by model and project, savings, the biggest runs, reviews, pushes, todos done and open, scheduled runs. |
| `lean-agent sync --check` | Whether an update is available (version and commits); installs nothing. |
| `lean-agent handover "<title>" [--project P] [--task-file F\|-] [--as-is] [--thread tN\|none]` | Writes a handover as a plain Markdown file: `<LEAN_AGENT_HOME>/<project>/handovers/<title slug>.md`, and prints `handover: <path>`. A read-only worker (sonnet, `--safe-mode`, Read/Glob/Grep) writes it from the request in the input; with `--as-is` the input is the document. The file starts with `# <title>` and `_<date> · thread tN_`. Writing the same title again moves the old file to `<slug>.prev.md`; an empty reply writes nothing and exits non-zero. Recorded like other role runs (not resumable) under the current thread; `thread show` lists it as `handover <path>`. The strict orchestrator may run it. |
| `lean-agent handover --list [--project P]` | Existing handovers, newest first: path, title, date |
| `lean-agent remember "<what>" [--project P] [--task-file -]` | Files something to keep through a small librarian worker (sonnet, `--cards auto`, read-only to project code, may run only lean-agent's memory/card/todo/handoff commands): memory, project card, todo, feedback rule or hand-off note, updating an existing entry instead of duplicating and reporting a conflict instead of overwriting. Prints `REMEMBERED <where> <id>`, `UNCHANGED ...` or `CONFLICT ...` lines (exit 1 on a conflict). |
| `lean-agent advise "<request>" [--project P] [--thread TAG] [--task-file -]` | Before the orchestrator acts on a NEW user request: a cheap worker (haiku, `--cards auto`, read-only) reads the memories, open todos, hand-off notes and latest checkpoint, and is given the card titles, the last ~10 runs, the latest review of the project and the user's last 5 requests in the thread (it starts no runs). It prints `Understood as: <one line>` first (plus `Ambiguous: <two readings>` and an "ask the user first: yes" when the request has two readings: show it to the user before starting a worker), then at most 15 lines starting with `ADVICE`, with `user already asked: proceed` instead of a question when the user already asked for the action explicitly: `known` (facts and earlier decisions), `project` and cards, `suggested` (one exact `lean-agent run ...` or `remember ...` command, or "answer from state"), `risks` (e.g. open review gaps, a decision the request contradicts) and `ask the user first` (yes + the question, or no). Printed and stored in `~/.lean-agent/advice/` (last 50) with the thread tag. The guide has the orchestrator run it for every new request (not for follow-ups in a thread, answers, status checks or resumes), deviate only with a one-line reason, and ask with AskUserQuestion about a risk or conflict unless the user's own request already answers it. |
| `lean-agent service install\|status\|start\|restart\|stop\|logs\|uninstall` | Optional: keep `lean-agent up` running across logins, restarts and closed terminals (a macOS LaunchAgent, or a systemd user unit on Linux; it restarts `up` if it stops). Everything else works without it. After `lean-agent sync`, `service restart` starts `lean-agent up` again with the new settings (it waits while workers are running; `--yes` restarts anyway). `service restart --clear` (or `lean-agent up --clear`) also starts the orchestrator on a fresh context after a checkpoint. |
| `lean-agent context [--apply] [--keep TOOL] [--undo] [--no-probe]` | What fills the orchestrator's context and what goes unused: its start-up size (one small Haiku call; `--no-probe` skips it), the instruction files it loads, the tools it never called in its recent sessions, agents, skills and MCP servers that load anyway, and the biggest items in the current conversation's messages (worker answers, command output, file reads, long replies, pasted text) with what to change. `--apply` denies the never-used tools and excludes the extra files in the home's settings (from the next session or /clear; `--keep` protects a tool, `--undo` reverts). Standing rule: at 80% of the compaction point the orchestrator is told to run it, save open items with `handoff --note` and tell you, before Claude Code compacts. |
| `lean-agent guard list\|add\|rm [<project>] [push-deny <pattern> ...]` | Branches lean-agent never pushes to, per project (globs; default `release/*`, `develop`, `main`, `master`). Matched against the remote branch a push would update, not the local branch name. `worktree push` refuses them whatever was approved (exit 3; only `--override-guard "<why>"`, logged in `pushes.jsonl`, gets past). Workers and the orchestrator run git with lean-agent's hooks folder (`core.hooksPath` via `GIT_CONFIG_*`), whose pre-push refuses guarded destinations however the push is written (`HEAD:<branch>`, `--force`, `--all`, `--mirror`); every other hook runs the repository's own. A guarded `git` first on their PATH checks every push too, so `--no-verify` doesn't get past. `require-pr` is accepted as the same kind (`guard add <project> require-pr develop`). `doctor` shows the guards; `sync` keeps them. `worktree push` names the files when the shared worktree has uncommitted changes; `--only-commits` pushes what is committed. |
| `lean-agent mcp preset <server> [<name> <tool,...>] [--desc TEXT] [--grep TEXT]` | Presets with a description; `--grep pull` finds the presets whose name, description or tools match. `--mcp server:a,server:b` means `server:a,b`. |
| `lean-agent mcp ignore <server> [--rm]` | Mark an MCP server you don't use (full name or alias): `doctor` skips it (also `doctor --ignore <server>`) and `mcp list` marks it; `--mcp <server>` still works when asked for explicitly. |
| `lean-agent --version` | The installed version (`sync` prints it last too). |
| `lean-agent output <command> [--grep TEXT]` | In brief mode (`LEAN_AGENT_BRIEF=1`, set for the orchestrator, or `--brief`), `optimize`, `tracker`, `stats`, `budget`, `cards`, `limits`, `projects`, `recipes` and `savings` print one line per item (at most 20); this prints what was left out. `--full` prints a command in full. Reviews in brief mode print the verdict and one line per finding; `runs --show <id>` has the rest. |
| `lean-agent savings [--days 7] [-p project] [--measure]` | Estimated tokens saved: worker context (vs a normal Claude Code turn in that project: measured with `--measure`, one tiny Haiku call, else assumed 30,000), model choice (vs Sonnet for every worker), and output the squeezer shortened. Each run's summary also has a `saved ~N` line. |

## MCP servers in workers

Workers get **no MCP servers** unless the orchestrator asks for them, and then only the tools it names:

```sh
lean-agent mcp list -p shop --probe        # servers from ~/.claude.json, <project>/.mcp.json, Claude Desktop, plugins
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
  within 5% of a real measurement. HTTP servers are listed by connecting the way a worker does (one tiny Haiku
  call, cached); the per-tool cost is the measured total split evenly. `--measure` gives the exact total.
- The config is copied into the run folder owner-only (`0600`) and **deleted when the run ends**, because MCP
  configs often contain tokens. Server names and tool-call counts go into the ledger; configs don't.
- **Presets:** `lean-agent mcp preset <server> <name> <tool,tool>` saves a named set, and
  `--mcp <server>:<name>` uses it. Every server whose tool list is known gets an automatic `read` preset
  (get/list/search/query/... tools). `run` prints each server's chosen tools and per-turn cost before it starts,
  e.g. `mcp: tracker 6/40 tools ~1,900 tok per turn (whole server ~18,800)`.
- lean-agent records which MCP tools each worker called, in order. The run summary says how many tools it was
  given and how many it used (`MCP/browser tools ~25,000 (40 offered, 3 used)`), and which `--mcp` spec or saved
  preset would have been enough. `optimize` suggests narrowing a server or dropping it after 2 runs.
- **Servers from Claude Code plugins** (`claude mcp list` shows them as `plugin:<plugin>:<server>`) are found in
  the enabled plugins' `.mcp.json`/`plugin.json`, with `${CLAUDE_PLUGIN_ROOT}`, `${user_config.*}` (from the
  plugin's options in your settings) and `${ENV}` filled in. Use the full name or the short alias `mcp list`
  shows, e.g. `--mcp datadog:read` when no other server is called `datadog`, else
  `--mcp plugin:datadog:mcp:read`. Workers get the server under the same name and config, and Claude Code keys a
  stored OAuth login by exactly those, so the login you already did is reused: no second sign-in.
  If a plugin is both installed and synced from claude.ai, the installed copy is used, or, once `doctor` has
  seen `claude mcp list`, whichever copy Claude Code itself connects to.
  `lean-agent doctor` connects to each plugin server as a worker (once a day) and says whether it's usable.
  When Claude Code connects but a worker gets needs-auth, doctor compares lean-agent's copy with
  `claude mcp get`: a different `type` or URL is corrected and retried automatically, and a header difference is
  named but not copied (header values can be secrets).
- **Big MCP results are trimmed before the model reads them:** every MCP worker gets a PostToolUse hook that
  compacts results over 3,000 chars (links, URLs, avatars, descriptors and empty values dropped, identities as
  names) and, for a recipe saved with `--fields`, keeps only those fields plus ids. The full result is saved
  and its path is in the first line. Measured on a 30-item list: 26,193 -> 1,309 chars, the run 1,439 -> 287
  sonnet-eq, same answer. A `--complete` recipe also says when it needed more than one tracker call per item.
- **Results saved to a file:** when a result is too big and Claude Code saves it to a file, workers are pointed at
  `lean-json <file> [--fields a,b.c] [--grep TEXT] [--exclude TEXT]`, which prints a compact view (links, URLs,
  avatars and empty values dropped, identities as names, one line per item). Read-only workers may run it too.
- **Exact identifiers for external systems:** every worker given `--mcp` gets the repository's identity from its
  git `origin` remote (Azure DevOps organization, project and repository; GitHub/GitLab owner and repository) and
  is told never to use lean-agent's project name as a tracker project, and to stop with `needs-input` if a
  lookup finds nothing. When the remote doesn't say, set it once: `lean-agent tracker <project> project=<name>`
  (also `org=`, `repo=`).
- **Who you are in the tracker, and its rules:** `lean-agent tracker <project> --discover --mcp <tracker>` lets
  a read-only worker find your identity id, name and email, each work item type's states (from the type
  definition, cross-checked with real items), and whether rules hold (voting needs you as a reviewer, delete
  or a Removed state, a description length limit): each `verified`, `false` or `unknown`, never guessed. A
  re-run replaces what discovery found and keeps your own notes; `tracker` and `doctor` warn when the tracker
  knows you by another email than your Claude account, and `tracker` warns when one of your notes contradicts a
  discovered fact about the same work item type (`--supersede N` keeps the note but stops giving it to workers);
  `--ack-email` silences the email warning once you've seen it. Add your own with `--note "..."` or `me_id=... me_name=...`. Every MCP worker gets
  them, so assigning, voting or closing doesn't have to fail first (`@me` often isn't accepted).
- **Variables without a token on disk:** a plugin config that uses `${VAR}` (e.g. a GitHub token) can get it
  from a command run when a worker starts: `lean-agent mcp env GITHUB_PERSONAL_ACCESS_TOKEN --command "gh auth
  token"` (or a macOS keychain item: `security find-generic-password -s <name> -w`). Only the command is saved;
  the value goes into the run's owner-only MCP config, which is deleted when the run ends. Options
  marked sensitive live in Claude Code's credentials store; lean-agent can't read them and doctor says so.
  `${VAR:-default}` uses it too, and a plain value works for things that aren't secrets:
  `lean-agent mcp env OBS_DOMAIN mcp.example.eu` (`--rm` removes any entry).
- **The right plugin copy:** when a plugin is both installed and synced from claude.ai, workers use a copy that
  is set up: a copy whose URL host is still a placeholder (a plugin's `${DOMAIN:-not-setup}` before its setup ran)
  is never picked, and `doctor` says which copy is used and which isn't set up. The orchestrator home switches off
  every plugin, synced ones included (Claude Code calls those `<name>@synced`); workers get plugin servers with `--mcp`.
- **Why a server fails:** `mcp list` and `doctor` give the reason, not only "failed": a placeholder host, a variable
  that isn't set, an `Authorization` header with no token or a line break in it, or the server's own answer
  (e.g. "HTTP 400: malformed Authorization header", "host not found"). `run` warns before it starts a worker with
  a config like that.
- Not covered: claude.ai connectors (they aren't in a local config file).

## The orchestrator's own context

Every orchestrator turn re-reads the whole conversation, so it's kept short:

- **Loads only its guide:** the home's settings keep your own instruction files out (`~/CLAUDE.md`,
  `~/.claude/CLAUDE.md`, `~/.claude/rules/`, and the same in folders above the home); `doctor` and `up` list what
  is still loaded on every call, with sizes. The CLI reference isn't in the guide: `lean-agent guide --cli`.
- **Shows its size at start:** `lean-agent up` prints the guide's size and the last orchestrator session's
  start-up context (system prompt, tools, guide), calls, average and peak context per call.
- **Compaction is Claude Code's call:** no overrides are set, so the orchestrator compacts where Claude Code does
  (~167K on a 200K window). `lean-agent config compact-window N|default` and `compact-pct P|default` (or `up --compact-at N`)
  opt in to earlier compaction; they take effect on `service restart`. Limits: compact-window 100000 or more
  (Claude Code's minimum; to compact earlier on a bigger window lower compact-pct), compact-pct 10-95.
- **Keeps what matters:** a PreCompact hook (lean-agent's home only) tells the summary to keep the user's goals
  and open requests, every approval word for word, runs in progress, branches and PRs, unfixed findings and
  decisions, and to drop worker answers, command output, file contents and the guide: lean-agent stores those.
- **Picks up cheaply:** after a compaction, and when a new session starts after recent work, a SessionStart
  hook gives the orchestrator the hand-off note from lean-agent's records (open items, standing rules, runs in
  progress, recent runs, items touched, latest review per branch), so it doesn't rebuild that from memory.
  Any run's full answer is one `lean-agent runs --show <id>` away. `lean-agent handoff --note` adds open items,
  so a topic can end with a fresh session instead of a long one.
- **Short results, clear on request:** `lean-agent run` prints a short result (about 1,200 characters of the answer,
  questions kept, a pointer to `runs --show <id>`; `--verbose` adds the token lines, `--full` everything). Context is
  handled by Claude Code's autocompact, so the session stays the same session in the Claude app. The orchestrator clears
  only when you ask ("clear the session", "start fresh"): it runs `lean-agent clear`, which queues a clear for the end
  of the turn (the orchestrator saves its soft state with `lean-agent checkpoint`, then `up` clears the session; the new
  session starts with `lean-agent brief`, the checkpoint first). It waits only for a pending permission prompt; running
  workers are detached and survive (collect them with `lean-agent runs --wait all`). Opt-in automatic clearing:
  `lean-agent config clear-at auto|N` (`auto` = 8,000 tokens below where Claude Code compacts; default `off`;
  `doctor` and `service status` show it): above it, after a finished turn, never within 30 s of typing or twice in
  10 minutes, and not while a worker runs unless the context is within 3,000 tokens of compaction. Each clear is
  logged in `logs/debug.log` (component `auto-clear`).
- **Restart with a clean context:** `lean-agent service restart --clear` and `lean-agent up --clear` have a live
  session checkpoint first (the same prompt as `lean-agent clear`, up to 120 s for 'checkpointed'), then the next session
  is a new one (a new session id in `up.json`) that starts from the brief, like after a clear.
- **Short answers in:** workers answer in at most 25 lines and put the rest in a details file; lean-agent's
  report commands print one line per item (brief mode); reviews print the verdict and one line per finding.
- **No MCP servers of its own:** `lean-agent up` switches your user-scope and plugin MCP servers off for the
  orchestrator home only (the per-folder list `/mcp` uses), so none connect or warn at its start; workers get
  them with `--mcp`.
- **Stays responsive:** in the orchestrator, `lean-agent run`, `review`, `do` and `tracker --discover` must be
  started as background Bash commands (the hook refuses a foreground start), so you can keep talking to it while
  workers run; it's notified when each one finishes. `LEAN_AGENT_BACKGROUND_RUNS=0` turns this off.
- **No dumps:** reading a long lean-agent run file with `cat`, `less` or a long `tail` is refused with the
  command to use instead.
- **Told when it grows:** past 100,000 tokens of context the hook says what compacting would save per 100
  calls, and whether the session predates lean-agent's early compaction (then restart `lean-agent up` once).
  `lean-agent budget` shows the context per call by quarter and what re-reading above ~67K cost.
- **Paced for the week:** `limits`, `week` and the hand-off note compare your weekly plan usage with the share of
  the week gone ("48% used, 43% of the week gone: on pace"); ahead of pace, `suggest` recommends haiku.
- **Fresh conversations:** after a conversation's second compaction, the orchestrator is asked to suggest a fresh
  one (/clear) at the next stopping point; the hand-off note and the work queue carry everything over.
- **Routing:** `lean-agent up --model haiku` runs a pure routing session on Haiku (switch up with `/model` when
  a step needs judgement); `--escalate haiku,sonnet` does the same for workers.

In short: `lean-agent run` hands the orchestrator a compact result, `lean-agent checkpoint` saves its soft state, and
Claude Code decides when to compact the orchestrator's context; the session is cleared only on `lean-agent clear` (or
with the opt-in `clear-at`).

## Threads

Each thread is its own Remote Control session. The main session is the front desk: its prompt hook scores every request
against the open threads without a model call (title, aliases and recent requests; rare words weigh more, recent threads
get a small boost, a score of 0.4 or more matches; an explicit `t7` or `#7` wins) and adds one line saying what to do:
`Belongs to t7 "..."` (hand it over with `lean-agent thread send t7 --prompt-file -`), `New topic` (start it with
`lean-agent thread new "<title>" --prompt-file -`), or `Status question` (answered in main with `lean-agent now`).
Notifications of background work attach to their run's thread silently. A thread session never guesses: every prompt
belongs to its thread, its context line is just `Thread t7 "..."` (once, at session start and after a `/clear`), and
everything started there is tagged t7. The thread is stored in the state of every run, review, todo, note, handover and
push that follows; `--thread tN|none` overrides it, workers inherit it through `LEAN_AGENT_THREAD`.

| Command | What it does |
|---|---|
| `lean-agent now` | Open threads by last activity (at most 25 lines): state (running, open review, open todos, idle), last action, age. Closes threads idle for 7 days (`LEAN_AGENT_THREAD_IDLE_DAYS` or `thread_idle_days` in config.json); nothing is deleted |
| `lean-agent thread show tN [--all]` | Everything for the topic in time order: requests, runs, reviews, todos, notes, handovers, pushes |
| `lean-agent thread close tN [tM ...]` / `--all` / `--idle 2h` / `reopen tN` | Hide finished topics from `now` and from matching (one checkpoint per thread, a summary line at the end; `--idle` skips sessions with a running run) / bring one back: a closed thread starts a new session from a short brief built from its record, `--resume-old` continues the previous transcript instead |
| `lean-agent thread new "<title>" [--prompt-file F\|-]` / `list` | Start a thread with its own Remote Control session (with a first message) / list threads |
| `lean-agent thread send tN --prompt-file F\|-` / `open tN` / `sessions` | Hand a message to the thread's session (starting or resuming it) / bring its session back / list the running sessions |
| `lean-agent thread merge tB tA` / `unmerge tB` | Fold thread B into A / give B its own tag back |
| `lean-agent thread move tN` | Wrong thread: move the latest request, the current thread and the work recorded since to tN |

`now` and `doctor` show each thread's session (running or closed, with its Remote Control name). The brief after a `/clear`
in the main session starts with the open threads; in a thread session it covers only that thread. Strict mode allows all of these: they only read or change
the registry.

## Handovers

`lean-agent handover "<title>"` turns a request (or, with `--as-is`, ready text) into a plain Markdown file under
`<LEAN_AGENT_HOME>/<project>/handovers/` and prints its path; open that file, or copy it wherever it is needed.
Nothing is uploaded. `handover --list` shows what exists. Details are in the command table above.

## Large front-end work: map, check, count, parity, codemod, slices

For a refactor or migration of a JS/TS front end (many files, many PRs), lean-agent has tools that do the bulk
reading and running themselves and hand the model a few lines. None of them calls a model; they're generic (any
framework) and keep their data under `~/.lean-agent/`. Workers are told about the ones set up for the project.

| Command | What it does |
|---|---|
| `lean-agent map <project> [--who-uses X] [--deps PATH] [--route [/x]] [--unused] [--find Name] [--dir DIR]` | An import graph of the code (ES imports, `require`, dynamic `import()`, CSS `@import`/`@use`; `tsconfig`/`jsconfig` path aliases), cached and rebuilt when a file changes. Without a question: files and lines per folder, packages, the most used modules, the biggest files no test imports. `--who-uses` takes a file, folder, file name or exported name and lists the importers with the names they use; `--deps` lists what a file or folder imports; `--route` finds routes (React Router / Vue Router style `path:` declarations, Next/Nuxt `pages/`, Next `app/`, SvelteKit `routes/`) and the size of each with its imports; `--unused` lists files nothing imports. A worker asks this instead of grepping and reading files. |
| `lean-agent count <project> add NAME "REGEX" [--glob "*.ts,*.tsx"] [--path src]`, `count <project> [NAME] [--files] [--by-folder]` | Named counters for what a refactor removes (an old API, an old state library, inline styles). Each run shows the total, per folder, and the change since the first run ("legacy-api: 404 in 120 files (was 812 on 10-21, -50%)"); the history is kept for the project's checkout. |
| `lean-agent check <project> add NAME "COMMAND"`, `check <project> baseline`, `check <project> [NAME...] [--dir DIR]` | Type-check, lint and test commands compared against a baseline of what was broken before: only new errors are shown (tsc, eslint stylish and unix formats, `file:line:col` compilers, jest/vitest/pytest failures; line numbers are left out of the comparison, so moved code doesn't count as new). An unrecognised failure shows the end of its output. Exit 1 on new errors; `--update` lowers the baseline when errors were fixed. |
| `lean-agent parity <project> set --url URL --routes "/,/settings" [--routes-from-map] [--start "npm run dev"] [--mask SELECTORS] [--storage FILE]`, `parity <project> baseline`, `parity <project> [--route /x] [--dir DIR]` | Per route: a screenshot, the page text and console errors, with Playwright from the project (or `LEAN_AGENT_PLAYWRIGHT_DIR`), against the baseline: "38/40 routes unchanged; /settings: 2.1% of pixels differ, rows 0-12% (top); text: 1 lines gone, 1 new: -Save \| +Save changes; 1 new console error: ...". Animations are switched off and masked selectors hidden; it starts the dev server with `--start` when nothing answers; `--storage` takes a signed-in Playwright session. Screenshots stay on disk. |
| `lean-agent codemod <project> "COMMAND" [--apply] [--dir DIR]` | Runs a codemod command (jscodeshift, ts-morph, a script) on a throwaway git worktree of the checkout as it is (uncommitted and new files included, `node_modules` linked) and summarises the change: files and lines per folder, and a sample diff from three folders. `--apply` runs it on the checkout itself and reports the same way. |
| `lean-agent slices <project> [--by route\|folder] [--depth N] [--src DIR] [--create --epic NAME]` | A plan from the map: units are routes (or folders), files more than one unit uses are shared parts grouped by folder and come first, then the slices, smallest first, each with the shared parts it needs. `--create` adds them to the work queue as an epic, each slice waiting for its shared parts. |
| `lean-agent todo add ... --epic NAME --after N,N`, `todo next --epic NAME`, `todo epic [NAME] [--count COUNTER]` | Epics in the work queue: an item can wait for others (`--after`), `next --epic` picks one that's ready, `todo epic` shows done / ready / waiting. |

A slice then runs cheap: the worker gets its context from `map`, makes mechanical changes with a codemod, and is
done when `check` shows no new errors, `count` went down and `parity` is unchanged; then `review --goal` and a PR.
The orchestrator's guide has the full sequence.

## Attribution (asked once)

Whether commits and PRs credit Claude is your call, asked once: by `lean-agent up` in a terminal, or by the
orchestrator before the first commit or PR (`lean-agent attribution` says "not set"). Save it with
`lean-agent attribution on|off`. When it's off:

- workers start with Claude Code's own `attribution` setting emptied (no Co-Authored-By line, no "Generated with
  Claude Code", no session link), and so does the orchestrator;
- workers and the orchestrator are told not to mention Claude or AI in commits, PR titles and descriptions, or
  comments;
- `lean-agent worktree push` refuses commits that still credit Claude.

## Branch names

New branches follow the project's branch rules, by default `feature/{task-id}-{name}`, `bugfix/{task-id}-{name}` and
`release/release-{version}`. `{name}` is a lowercase ascii slug of the title (up to ~40 characters); `{task-id}` is the
linked tracker item id of the todo, else the todo number, else left out together with its `-`. Change them per project:

```
lean-agent config branch-rules --project P feature=<pattern> bugfix=<pattern> release=<pattern>
lean-agent config branch-rules --project P default      # back to the defaults
lean-agent branch-name --project P [--type feature|bugfix|release] [--task ID] [--version X] "Fix login timeout"
lean-agent run P --worktree auto [--branch-type bugfix] --todo 12 -- "Fix login timeout"   # branch: bugfix/12-fix-login-timeout
```

The type is inferred when not given: bugfix when the title has fix/bug/hotfix/regression/defect as a word, release when
it starts with "release" plus a version (x.y or x.y.z, optional v) or names a release/ branch (a release needs a version: `--version X`, or "Release 1.2" in the title), else feature.
Existing names get `-2`, `-3`; every name passes `git check-ref-format --branch`. Explicit branch names
(`--worktree my-branch`) and old `lean/*` branches keep working. `release/*` is guarded by default: creating it
locally is fine, pushing it stays blocked unless you allow it (`lean-agent guard`). `doctor` shows the rules.

`--worktree auto` is for workers that write: a read-only worker gets no new branch. The name is chosen and the branch
created under a lock, so parallel runs never pick the same name. `auto` is a reserved value: a branch literally named
auto is given as `refs/heads/auto` or `heads/auto`.

## Shared worktrees

`lean-agent run <project> --worktree <branch> ...` runs the worker in a git worktree of that branch at
`~/.lean-agent/worktrees/<project>/<branch>`. Use it to run a reviewer's checks, such as tests, on a PR branch
without touching your checkout.

- **Shared to save tokens and time:** the next worker for the same branch reuses the worktree, so dependencies it
  installed (`node_modules`, virtualenvs) and build output are still there. Workers are told it's shared and to
  install only what's missing.
- **Kept current:** a clean reused worktree is moved to the branch's newest commit. Uncommitted work is left as it is,
  with a warning.
- **Commits:** a local branch that isn't checked out elsewhere is checked out in the worktree, so a worker's commits
  land on it (workers never push). A remote PR branch (`--worktree origin/feature-x`) gets a local `feature-x`
  that tracks it, so fixes can go back to the PR. A branch you have checked out yourself gets a detached worktree.
- **Setup once per worktree:** `lean-agent worktree setup <project> --run "npm ci && npm run build"` saves a
  command that runs in every new worktree before the first worker starts (output in a log next to it). Add the
  branch name to run it in an existing worktree too, and `--off` to remove it.
- **Pushing fixes:** `lean-agent worktree push <project> <branch>` pushes the worktree's branch to origin, but only
  when its tip has an approving review (`review --head <branch>`), there are no uncommitted changes, and nobody
  else pushed in between (it never force-pushes). Without `--allow-send "<what the user approved>"` it only shows
  the commits it would push, because pushing is an outward action.
- **Parallel workers:** read-only workers share a worktree at the same time. Workers that change files take turns.
- **Housekeeping:** `lean-agent worktrees [project]` lists them, and `lean-agent worktree rm <project> <branch>
  [--force]` removes one.

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
- **Reuse before style:** lean-agent lists the change's new files and newly defined symbols itself (exports,
  functions, classes, hooks, stores; test files left out) and gives them to the reviewer, whose first three
  passes are mandatory and come before any correctness, test or style finding:
  1. **Reuse and duplication:** at least one search per new symbol (by name, key identifiers and behaviour
     words like counter, subscribe, overlay, defer, retry) for existing code with the same job.
  2. **Scope and generality:** does it fix one dialog/field/endpoint while siblings share the cause?
  3. **Does the platform already handle it:** an existing hook or lifecycle that hides and restores, where
     the change adds permanent state.
  The review reports its `searches`, a `reuse` table (new symbol -> existing candidate -> reuse / extend /
  justified-new) and the `siblings` it checked. lean-agent enforces it: a new symbol without a reuse entry means
  "reuse not checked" and no approve; "justified-new" next to an existing candidate needs a concrete reason, and
  can't overrule a second opinion that found existing code for it. Open items send the reviewer back once, in the
  same session, to finish the reuse pass before you get the result; duplication, scope and platform findings are at least major, a reuse or
  extend verdict without a matching finding gets one, and design findings are listed before test and style ones.
- **Wrappers and decisions:** a thin wrapper or hook that calls existing code is `wraps-existing` (reuse done
  right, not a duplicate). Findings are numbered; `lean-agent review decline <project> <n> --why "separate
  ticket"` records a decision for that branch (`--all-branches` for the project), so later reviews and the second
  opinion are told and a matching finding isn't raised again.
- **Less noise, and a loop that ends:** `duplicate` (copies code outside the change) is a finding; `extends-existing`
  and `wraps-existing` are reuse (no finding), and a "candidate" inside the lines the change edits is the change
  itself (dropped). Symbols that already existed before the change (edits, signature changes) aren't new; a change
  with none prints "no new symbols". Duplication is major only for copied logic (about 10+ lines, a multi-branch
  algorithm) or a second copy of a mechanism; what the reviewer calls optional, follow-up or pre-existing is minor;
  a finding it says it didn't verify becomes `unverified -> delegate a read-only check`. Declines are keyed on the
  finding's kind and symbol, apply to every later review and `--resume` (whoever raised the finding), and never
  flip the verdict. `--resume` re-checks only the open findings and the files changed since; when only minor or
  declined findings are left it approves and lists what was declined. The REVIEW footer shows the review's cost
  and the running total for the branch.
- **Ordered passes, and what the diff shows by itself:** correctness with end-to-end flow tracing, reuse,
  scope and platform, **tests**, **defaults and state**, then style. lean-agent finds in the diff, without a model,
  the tests whose assertions the change edits (renamed, flipped, deleted, skipped), new parameters with
  defaults, and new module-level state, and gives the reviewer those lists. The reviewer reports a `coverage`
  table (edited test -> what it protected -> still-covered / lost / intentional), says whether each new test
  would fail without the fix, checks that production callers pass a defaulted parameter, follows merged or
  widened values to their consumers, and checks that specs reset new module state. An edited test without a
  coverage entry means no approve, like a new symbol without a reuse entry. It also lists what it checked and
  found fine and what it couldn't verify.
- **Expensive runs ask first:** `run -m opus|fable` prints the expected cost (from earlier runs on that model) and
  its share of your plan's session window; it needs `--yes` when that's 10% or more (`LEAN_AGENT_CONFIRM_PCT`) or
  the window is already over 50%. `lean-agent budget` shows the plan line too.
- **Several passes:** `review --runs 2` runs two independent passes and merges them (findings matched by category,
  file and wording, marked `[2/2 passes]` when both found them). Reviewers vary between runs; for high-risk
  changes two cheap passes are an alternative to one expensive one, and the high-risk hint offers both.
- **Model and cost:** `--reviewer-model opus` (or `fable`) for one review; the expected cost is printed first
  (from your earlier reviews on that model, else scaled from Sonnet's and corrected by how far such scaled
  estimates were off before; every estimate is stored with its run, so they improve). `--independent` gives a
  clean comparison run: no earlier findings, declined decisions, second opinion or decline filtering. For high-risk changes (concurrency, timers, auth and
  logout, sync, migrations, or large diffs) the review suggests a stronger reviewer with its expected cost.
- **Replay case:** `python3 tests/fixtures/review_case.py <dir>` builds a small repo whose change has a lost
  test case, a hiding default, a merged value with a stale consumer, unreset module state, a logout bug and an
  import cycle; `--fixed` adds the author's fixes, to replay `review --resume` until it approves.
- **Second opinion:** for new abstractions or big diffs (`--second-opinion auto|on|off`), a cheap search-only
  Haiku pass looks for reuse candidates and siblings first. The main reviewer has to confirm or reject each.
- **Lessons from human reviews:** `lean-agent review learn <project> --text "Before adding overlay state, check
  the shared surface counter"` or `--helper "name | where | what"` adds to two cards that every review of the
  project gets: `review-checklist` and `shared-helpers` (the latter also for code changes). `review learn
  <project> <PR> --mcp <tracker>` reads the PR's human review threads through the tracker's MCP server, compares
  them with lean-agent's own review of that branch, and turns what was missed into checklist lines and helpers.
  The worker has to open the code for every helper: one whose path isn't in the repository is left out. It gets
  the cards' current text, so near-duplicates are skipped, a known helper's line is updated, and wrong lines are
  corrected (`replace`). Threads that ended in a decision to leave something out become declined findings, not
  lessons. `review learn <project> --verify [--head <branch>]` lists helper lines whose code can't be found, with
  the reason; `--apply` removes them. It checks `--head`, HEAD, the default branch and every base branch your
  reviews used, matches partial paths (relative to a package folder, in backticks, with `:line`), and keeps a
  line whose symbol is found even when its path is wrong.
- **Cheaper reviews:** the reviewer prompt carries a fill-in template listing every new symbol (reuse) and edited or
  removed test (coverage) with the answer format; entries still missing are filled by the cheap haiku reuse run (coverage
  is recorded as "not checked") instead of resuming the main reviewer. The model is chosen by risk unless
  `--reviewer-model` is given: re-reviews, docs/test-only and small diffs (under about 150 lines) sonnet, first reviews of
  large diffs (about 800 lines or more) or of security-sensitive paths and keywords (auth, token, crypto, secret,
  password, permission, cert, sign, encrypt, sanitize, csp, cors) opus, fable never by default; `config review-model
  auto|<model>` fixes it. A gap declined earlier on the branch (matched by location and similar wording) is not shown
  again, and a gap whose own text says it is documented, out of scope or already handled is declined with that reason
  (one summary line). Review prompts carry at most 4 cards: rules whose globs match the changed files, or cards whose
  keywords appear in the diff or goal. `review --costs [--project P] [--days 7]` prints totals per branch and model,
  runs, second turns, re-review rounds, skips by reason and the average cost per review, from the ledger.
- **Re-review:** `review <project> --resume` starts a fresh reviewer with a small context: the open findings and
  checks of the last review, the declined decisions, and only the diff since then (with its own new symbols and
  edited tests). That's cheaper than continuing a long session, and it converges: a new major about code that
  didn't change since the last review is minor, earlier open findings keep their severity. `--same-session`
  continues the earlier reviewer instead. It also runs the reuse, scope and platform passes again
  on the files changed since the last review and asks it to reconsider the design, not only the earlier findings. Add `--head <branch>` to resume the review of that
  branch; the review is recorded for the branch's new tip (also when the reviewer is resumed with `run --resume`).
  A fresh review of a branch that was reviewed before gets the earlier findings, so it says which are resolved
  instead of starting blind. `review <project> --status` exits 0 only if the
  *current* code (HEAD plus uncommitted changes) has an approve. With `--head <branch>` it checks that branch's
  tip instead, whatever is checked out. The guide and repo block make that a hard rule
  before any PR.

Measured on a sample repo: a planted float-money change with no tests got 3 majors. These were the float rounding
bug with a concrete failing input, missing tests (citing the project's memory about money tests) and a double-VAT
risk (citing another memory). After a worker fixed them, the re-review confirmed the fixes and caught a new problem:
the worker had committed `__pycache__/*.pyc`. Each review cost about $0.06 and 30 s.

### The fix loop: one full review, then deltas

Reviews follow the branch, not the commit. Once a branch has a review, `lean-agent review <project> --head
<branch>` (or a commit on it) reviews only what changed since, plus whether the earlier findings are fixed: a fresh
reviewer with a small context, on sonnet (`LEAN_AGENT_DELTA_REVIEW_MODEL`) unless the change since is high-risk, then
on the earlier model. A commit counts as the same branch when it builds on the reviewed one, when the branch's reflog
had the reviewed commit (an amend or rebase), or when it's on that branch; `--resume` uses the same lookup. Above
`LEAN_AGENT_DELTA_MAX_LINES` (800) changed lines it's a full review again, unless `--delta-only`; `--full-review`
always reviews the whole change. What the user declined (`review decline ... --head <branch or commit>`) is kept
for the branch, so it isn't asked again on later commits, until the code it points at changes (then the reviewer
is told it was declined but may raise it again). `review --status` on a newer commit says how much changed since the
last review and gives the command for a delta review. `--for-push` is the gate before a push: it refuses while
fix workers still run on the branch, and says to batch fixes into one worker and review once after it.

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

**Repo rules** (`CLAUDE.md`, `.claude/rules/**/*.md`): `learn` imports them as `rule` cards and keeps each rule's
`paths:` globs and description. A rule card comes along when the task text, `run --files`, or the worktree's changed
files match a glob; a rule without `paths:` and the root `CLAUDE.md`'s opening section are always candidates within the card budget.
`lean-agent config project-rules on|off [-p project]` (default off) lets workers load them natively instead: they run
in their worktree (or the project) with `--setting-sources project` rather than `--safe-mode`, rule cards are skipped,
and the repo's `.claude/settings.json` (hooks, permissions, plugins, env) applies too; `doctor` shows the mode. Advisor,
reviewer, composer and gap-decider runs stay isolated.

**Strict mode** (`lean-agent config strict on|off`, default on; `doctor` shows it): the orchestrator only
orchestrates. A hook refuses Bash commands that aren't `lean-agent` commands and Reads outside lean-agent's home and
plugin, and the refusal names the worker to start instead (`lean-agent run <project> --cards auto ...`). Workers are
never affected. The orchestrator also changes and keeps nothing itself: the hook refuses the `lean-agent` subcommands that change a
repo, branch, remote or tracker, write memory, cards, rules, recipes, todos, notes, schedules, guards or counters, or list and run MCP
servers (and the `mcp__*` tools), and the denial names the worker to start instead (`lean-agent remember` or `lean-agent run`; a run
gets its queue item with `--todo new`). Workers keep all of it, including `--mcp`. The full list of what is allowed and denied, class by class, is in [docs/orchestrator-surface.md](docs/orchestrator-surface.md); known limit: Claude Code's own `/memory`, `/init` and `/config` commands in the hosted interactive session run locally, so the plugin can only refuse them when Claude Code passes them to its prompt hook (a `#` memory message is redirected to `lean-agent remember`). `lean-agent review <project> --decide-gaps [--head REF]` applies the same idea to decisions: a
sonnet worker reads the cards and the code around each open known gap of the branch's latest review, records the
declines it can justify (`review decline`), returns one-line fix tasks, and leaves only product or preference
choices to the user as questions with 2-4 options. It prints "N declined, M fix tasks, K need you" and exits 2 when
something needs the user.

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
   **New cards from what workers did:** one successful run with a distinctive MCP pattern (2+ tools, 4+ calls or
   6+ turns) is enough for `optimize` to draft a recipe card: the task, the tools in the order they worked, the
   `--mcp` spec, what a good answer looked like, and what it cost without the card. Runs with the same server and a
   similar tool set, or similar wording, are grouped into one draft. A **preset** is drafted (named from the tool
   names, e.g. `datadog:metrics`) when a run was given far more tools than it used, or a pattern recurs. Drafts
   already covered by a card are skipped. A preset draft is skipped when an existing preset already covers its
   tools closely, becomes an "extend <preset>" draft when an existing one has fewer, and two drafts never share a
   tool set. Context gaps a card or tracker note already covers are hidden; `optimize --ack <run-id>` hides others. Drafts are generalised (PR and ticket numbers, ids, hashes, local
   paths and "Goal:"-style labels removed), read-only and changing runs never share a draft, a read-only preset
   never contains a write tool (a separate `<name>-write` draft says which write tools it adds), and two drafts
   never get the same preset name. `optimize <project> --accept <id>` writes them (`card add`, `mcp
   preset`), `--reject <id>` stops proposing one (`--unreject <id>` brings it back). The 5-run threshold only gates trim/core/archive.
   Relevance in `suggest` and `--cards auto`: words are weighted by how rare they are across your cards. A card
   needs a distinctive title word, or (if it's small) three distinctive body words; cards over 800 tokens need a
   title match, and ranking divides by card size. Only cards scoring at least 40% of the best match are kept, at
   most 4 (`--max-cards`) within ~2,000 tokens (`--max-context`). The reviewer's card pick is more lenient.
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

Subscription plans limit usage per **session** (5 hours) and per **week**, and some models have their own weekly
limit. lean-agent reads the plan's **real** usage: every `claude -p` call in `stream-json` mode reports the
plan's utilization and reset times (the same numbers `/usage` shows), and workers run that way, so each worker
run updates them. `lean-agent limits --refresh` asks for them right away with one tiny Haiku call.

```sh
lean-agent limits                                  # Plan (from Claude, 3 min ago): session 37% (resets 13:30) · week 12% ...
lean-agent limits --refresh                        # the same, fetched now
lean-agent limits --session-pct 60 --week-pct 70   # agents stop at this share of your plan (real numbers when fresh)
lean-agent limits --5h 2000000 --week 15000000     # or: a fixed sonnet-eq budget for lean-agent's own usage
lean-agent limits --off                            # remove the budgets
```

Claude's numbers are used while they're under 30 minutes old, and they include claude.ai and other machines.
Between reports lean-agent estimates from local session logs; `limits plan` (reset times) and `limits calibrate
session=N week=N` (percentages from `/usage`) make that estimate closer, and are only needed if you rarely run workers.

- **What's counted:** usage comes from Claude Code's session logs on this machine, read incrementally and
  timestamped, in 10-minute buckets. That includes the orchestrator, every worker and their subagents, and your
  other Claude Code sessions (shown as "all Claude Code here").
- **Windows:** after `limits plan`, the session window ends at your reset time; the next one starts with the
  first message after it and lasts 5 hours. The week runs from the weekly reset. Without a plan the windows roll
  (the last 5 hours, the last 7 days), which is a bit stricter.
- **Units:** **Sonnet-equivalent tokens**, which are weighted tokens scaled by the model's price relative to
  Sonnet 5.5. Haiku 5.5 counts 0.05×, Opus 5.5 2× and Fable 5.1 5×. The weekly line also splits usage by model
  family, because a model with its own weekly bar fills that bar separately.
- **Calibration:** `calibrate` divides the usage seen in each window by the percentage you give, so `limits`
  can show "plan ≈ N%". A model family (`fable=8`) calibrates that family's own weekly limit. After three or more
  session calibrations at different moments, lean-agent also fits how much cache reads and output count (least
  squares; it keeps the defaults if the fit is implausible). Claude.ai chats and other machines aren't visible,
  so calibrate again now and then; the latest point wins.
- **Enforcement:** when a budget is used up (`--session-pct`/`--week-pct` of your calibrated plan, or the fixed
  `--5h`/`--week` budgets for lean-agent's own usage), `run` refuses new workers and says when the window resets.
  The orchestrator's hook blocks its own tool calls the same way, but `lean-agent limits` and `stats` stay allowed
  so you can raise the budget from your phone. Your normal sessions are never blocked.
- Everything is saved in `~/.lean-agent/limits.json`. The env vars `LEAN_AGENT_5H_BUDGET` and
  `LEAN_AGENT_WEEKLY_BUDGET` override the fixed budgets.

### Other limits

The session budget is in **weighted tokens**, input-token equivalents using the usual API price ratios:
`input + 1.25×cache_write + 0.1×cache_read + 5×output`.

| Variable | Default | |
|---|---|---|
| `LEAN_AGENT_BUDGET` | off | Optional self-set **spend** cap per orchestrator session in sonnet-eq tokens: billed tokens summed over every turn, so it's not your plan and not the context window (a session at 11% context can have billed far more). Enforced by a PreToolUse hook: at `LEAN_AGENT_WARN_PCT` (default 80%) a one-time note to spend less, with the current context size, suggesting a hand-off only if the context itself is over `LEAN_AGENT_HANDOFF_CONTEXT` (150,000); at 100% tool calls are blocked. `LEAN_AGENT_BUDGET_COUNT=new` counts only new tokens (no cache re-reads). `lean-agent budget --cap N\|off [--count new\|billed]` changes it for running orchestrator sessions from their next tool call, no restart (and wins over the env var); `lean-agent budget/limits/stats/runs/logs/doctor` always run, even when capped. The 1,000,000 default that `up` set before v0.5 is ignored. A session keeps the plugin version it started with; sessions from before v0.3 call their hook scripts in that old cached copy directly, so `sync` (and `doctor --fix`) replaces those scripts with a stub that runs the clone's current code. `lean-agent budget` shows a percentage only when a cap is set. |
| `LEAN_AGENT_RUN_MAX_USD` | `3.0` | Default `--max-usd` per worker (`claude --max-budget-usd`). |
| `LEAN_AGENT_MAX_TURNS` | `40` | Default `--max-turns` per worker. |
| `LEAN_AGENT_WORKER_PERMISSION_MODE` | `acceptEdits` | Worker permission mode. |
| `LEAN_AGENT_WORKER_BASH_OUTPUT` | `8000` | `BASH_MAX_OUTPUT_LENGTH` for workers (not the orchestrator's larger value). |
| `LEAN_AGENT_ANSWER_LINES` | `0` (`25` in the orchestrator) | Lines a worker's answer may use; the rest goes to a details file. |
| `LEAN_AGENT_BRIEF` | unset (`1` in the orchestrator) | One line per item from lean-agent's report commands. |
| `LEAN_AGENT_RUN_MAX_READS` | `6000000` | Context tokens a worker may re-read over its calls before it is stopped. |
| `LEAN_AGENT_CTX_NUDGE` | 80% of the compaction point (`100000` if unknown) | Orchestrator context size at which the hook asks for the context check before compaction (again every 50,000 more; 0 = off). |
| `LEAN_AGENT_READ_GUARD` / `LEAN_AGENT_READ_LINES` | on / `40` | In the orchestrator, refuse `cat`/`less`/long `tail` of a lean-agent run file longer than this. |
| `LEAN_AGENT_RESULT_CHARS` | `12000` | Max worker reply printed back to the orchestrator (workers lead with a summary; the full result is saved). |
| `LEAN_AGENT_HOME` | `~/.lean-agent` | Where everything lives. |

## The plugin

Installing the plugin also gives any Claude Code session (not just the orchestrator):

- **Output squeezer:** a PostToolUse hook for noisy Bash output over 6,000 chars. A lean-agent run summary in
  the output (the worker's answer) is never cut, however it got there. Noise goes first: progress
  bars, downloads, build steps, passing tests, deprecation notices and warnings that only differ in numbers or
  paths (one copy is kept, with a count). Then the room goes, in order, to the first error with its whole stack
  trace, the closing summary, the other distinct errors (the last one before the middle ones; repeats are
  counted, not repeated), the start, and one line per kind of warning. A long run of warnings can no longer
  push the real error out, and nothing is cut through the middle of an error. The full output and an
  errors-and-warnings-only copy (with line numbers) are saved, and both paths are in the first line. Reads
  (`cat`, `sed -n`, `head`, `grep`/`rg`, `git show/grep/diff/log/blame`) are never squeezed. Opt out per command
  with `LEAN_RAW=1`, or entirely with `LEAN_AGENT_SQUEEZE=0`.
- **`lean-sq <command>`:** the same filter as a wrapper, for places hooks don't run. Workers run in safe mode, so
  they're told to run builds, tests, installs and linters through it instead of `| tail`. It keeps the exit code.
- **Local logs, split by level** in `~/.lean-agent/logs/`: `error.log` (failed workers, CLI and hook errors,
  errors found in command output, each with the path of the full output), `debug.log` (every run, squeeze and
  decision), and `verbose/` (full outputs and their errors-only copies, kept 2 days). `lean-agent logs [error|debug|verbose] [-n N] [--run ID]`
  shows the newest entries first (10 by default), only those mentioning one run with `--run`. Nothing is sent to Claude unless it reads a file.
- **Budget guard:** the session budget above.
- Skills `/lean-agent:budget` (token breakdown for the session) and `/lean-agent:lean-mode` (frugal working rules).
- `lean-agent` on the Bash PATH.

## Troubleshooting Remote Control

`CCR v2 worker registration failed ... 404` on every start: when you stop `claude remote-control`, it keeps a
pointer so the next start can bring back the same session. If that session was archived or expired in the meantime,
the server answers "Session not found" and the worker registration fails, again on every start (deleting the
session in the app does the same). `lean-agent up` sees that error, makes the pointer forget the old session (keeping its
environment, which Remote Control leaves registered; a start without it is refused with "This folder is already
served ...") and starts again with a new session by itself; `lean-agent up --fresh` does it up front. "This folder is already served by a terminal
`claude remote-control`" means another Claude Code serves the home already, often the Claude desktop app: close it
and run `lean-agent up` again (`up` says so when it sees that error). The server itself keeps working either way.
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
