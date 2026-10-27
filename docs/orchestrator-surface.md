# What the orchestrator session can still do

Audit of the orchestrator (the lean-agent home, or the service session the Claude app talks to) with strict mode on
(`lean-agent config strict on`, the default). Workers are never restricted by any of this.

Classes:

- **(a)** reads state.
- **(b)** pure orchestration: starting workers, thread bookkeeping, checkpoint, brief, todo status that follows a run,
  lean-agent's own maintenance and settings. Nothing the user said is stored by it.
- **(c)** writes knowledge or project data: memory, cards, feedback rules, presets, todos or notes the user asked for,
  tracker, files, git.

Rule: every (c) item is **denied** in strict mode (the deny message names `lean-agent remember` or `lean-agent run`) or
**routed** to a worker. Where one subcommand serves both the orchestrator's bookkeeping and the user's content, it is
denied for the orchestrator and workers use it. The enforcement is `strict_denial` in
`plugins/lean-agent/scripts/budget_hook.py`; the tests are in `tests/test_hooks.py`.

## 1. Tools (home settings deny list, `ORCHESTRATOR_DENY`, plus the PreToolUse hook)

| Tool | Class | Status |
| --- | --- | --- |
| Bash | b | **allowed** only for `lean-agent` commands (no other command, no redirects to files, no command substitution); subcommands in section 2 |
| AskUserQuestion | b | **allowed**: talks to the user |
| TaskOutput, BashOutput | a | **allowed**: read the output of lean-agent's own background commands |
| ToolSearch | b | **allowed**, only to load an allowed tool |
| Read | a | **allowed** only for lean-agent's own files (home, run files, the plugin) |
| TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet (`Task*` except TaskOutput) | c | **denied** (settings and hook); redirect: `lean-agent todo list\|next\|start\|done`, `lean-agent now` |
| TaskStop, KillShell | c | **denied**; redirect: `lean-agent runs --stop <id>` |
| CronCreate, CronDelete, CronList, ScheduleWakeup | c | **denied**; redirect: `lean-agent schedule list\|run\|pause\|resume` |
| Agent, Task, Workflow, SendMessage | c | **denied**; redirect: `lean-agent run` |
| Monitor | b | **denied**; redirect: `lean-agent runs --wait <id\|all>` |
| EnterPlanMode, ExitPlanMode | b | **denied**; redirect: a thread (`thread show tN`) or `advise` |
| PushNotification | b | **denied**: the user is reached by the reply |
| NotebookEdit, NotebookRead, WebFetch, WebSearch | c | **denied**; redirect: a worker |
| Edit, MultiEdit, Write | c | **denied** in the home settings |
| Artifact*, Skill, LSP, EnterWorktree, ExitWorktree, SendUserFile, plugin/skill/connector search and install tools, ... | c | **denied** in the home settings (full list: `ORCHESTRATOR_DENY`) |
| Glob, Grep, LS | a | **denied** in the home settings |
| `mcp__*` (every MCP server tool) | c | **denied**: server prefixes in the home settings, and every `mcp__` name by the hook |
| ListMcpResources(Tool), ReadMcpResource(Tool), ReadMcpResourceDir(Tool) | a | **denied** in the home settings and by the hook |

The redirect text is `TRACK_REDIRECT` in `budget_hook.py`. A new `lean-agent` command that reads or updates only
lean-agent's own state (`now`, `thread`, `runs --show --tail|--wait|--stop`, `logs`, `handover`, `advise`, `learn`,
`output` of a lean-agent command) needs no entry; one that takes a project file or arbitrary output file as input
must be added to the denied rows of section 2.

Also off in the home settings: Claude Code auto memory (`autoMemoryEnabled: false`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`),
bundled skills, claude.ai connectors, every other plugin, and every MCP server (`enableAllProjectMcpServers: false`; the
user, plugin and home `.mcp.json` servers are listed in `disabledMcpServers` / `disabledMcpjsonServers` of the home
folder's entry in `~/.claude.json`, `enabledMcpjsonServers` is empty). `lean-agent up` and `home` apply this
(`disable_home_mcp`, `orchestrator_settings`).

## 2. `lean-agent` subcommands strict mode allows or denies

| Subcommand and flags | Class | Strict mode |
| --- | --- | --- |
| `remember "<what>" [--project P] [--task-file -]` | b | allowed: starts the librarian worker; the only way to keep something |
| `advise "<request>" [--project P] [--thread TAG] [--task-file -]` | b | allowed: starts a read-only haiku advisor worker; stores its short answer in `advice/` |
| `run`, `review`, `do`, `tracker --discover` (all flags, `--mcp`, `--allow-cmd`, `--todo new\|N\|none`) | b | allowed, in the background; they start workers |
| `now`, `thread list`, `thread show tN [--all]` | b | allowed: read-only |
| `thread new "title" [--prompt-file F\|-]`, `thread send tN --prompt-file F\|-`, `thread open tN`, `thread close tN`, `thread sessions` | b | allowed: each thread is its own Remote Control session (`lean-agent · tN <title>`) that `up` hosts next to the main one; they start, message, resume, checkpoint-and-stop and list those sessions; `max-thread-sessions` (default 8) caps the sessions hosted now; at the cap `thread new`/`open`/`send` closes the longest-idle session that has no running run (checkpointed, thread closed, reopen with `thread open`) and refuses, listing them, when every one is busy; a session meant to be open is resumed when the service starts |
| `thread reopen\|merge\|unmerge\|move` | b | allowed: they only change the thread registry |
| `checkpoint`, `brief` | b | allowed |
| `clear [--thread tN]` | b | allowed: queues a checkpoint and /clear of the service session (or the thread's own session) at the end of the turn; only when the user asks |
| `handoff` (read), `handoff --done N`, `handoff --note … --kind checkpoint\|fyi\|decision` | b | allowed: the orchestrator's own state; a `decision` note is how it asks the user something asynchronously |
| `handoff --note …` with no kind, or kind reminder | c | **denied**: user content; `remember` |
| `todo list\|next\|start\|done` | b | allowed: status that follows a run it started |
| `todo add\|note\|edit\|rm\|reopen\|epic` | c | **denied** (`todo add` serves both; a run gets its item from `run --todo new`, which names it after `--why`) |
| `memory list\|where` | a | allowed |
| `memory add\|edit\|rm\|import` | c | **denied** |
| `cards`, `card show`, `suggest`, `projects` | a | allowed |
| `card add\|rm\|core\|shorten\|unarchive\|protect` | c | **denied** |
| `recipes` | a | allowed |
| `worktree base` | c | **denied** (it changes the project's base branch; `run --worktree-base` is per run) |
| `recipe add\|rm` | c | **denied** (stored runs are presets) |
| `mcp list\|tools\|preset\|env\|ignore` (all of `mcp`), `chrome check` | c | **denied**: the orchestrator neither lists nor runs MCP servers or presets; a read-only worker with `--allow-cmd 'lean-agent mcp'` does |
| `chrome status` | a | allowed |
| `doc` (every subcommand: write, list, ...) | c | **denied** (files); a worker writes documents |
| `schedule list\|run\|pause\|resume\|run-due` | b | allowed |
| `schedule add\|rm\|defaults` | c | **denied** (a job later runs lean-agent commands) |
| `guard list` | a | allowed |
| `guard add\|rm` | c | **denied** |
| `count <project> [names]`, `--files`, `--by-folder` | a | allowed |
| `count <project> add\|rm …` | c | **denied** |
| `tracker <project>` (read), `tracker --discover` | a / b | allowed (`--discover` starts a worker that records identity it finds) |
| `tracker <project> KEY=VALUE`, `--note`, `--rm-note`, `--supersede`, `--ack-email` | c | **denied** |
| `worktree rm\|setup\|push\|reset`, `rules`, `codemod --apply` | c | **denied** (repo, branch, remote) |
| `branch-name` (prints a name from the project's branch rules, read-only), `worktrees`, `codemod` (throwaway copy), `map`, `slices`, `check`, `parity`, `grep-log`, `text-len` | a | allowed |
| `slices --create`, `learn` | b | allowed: todos, cards and lean-agent's own repo rules block derived from the code by lean-agent, with no text from the user |
| `optimize` (also `--apply`, `--accept`, `--reject`) | b | allowed: applies drafts a worker made from run feedback; no orchestrator text is stored. |
| `review decline <p> <n>…` (also `review-decline`), `review learn <p> <PR> --mcp <tracker>` (also `review-learn`) | b | allowed: review state, and lessons a worker derives from human reviews |
| `review learn <p> --text "…"` / `--helper "…"` | c | **denied**: text the orchestrator supplies is knowledge; `remember` (or a worker) |
| `handover` (also `--list`) | b | allowed: a worker writes a Markdown file; it only writes under LEAN_AGENT_HOME |
| `config strict on`, `config branch-rules`, `attribution`, `limits`, `budget`, `context` | b | allowed: switches and limits |
| `config strict off` | c | **denied**: the orchestrator doesn't lift its own guardrail |
| `runs` (also `runs --wait <id\|all\|last>`, which blocks until those runs are recorded and prints their results; `runs --stop <id\|last>`, which ends one of lean-agent's own runs, records it as `stopped` and lists what it changed in its worktree; a run whose supervisor died shows as `lost`: `runs --lost` lists them, `runs --lost --clear` acknowledges them, and `runs --stop <id>` still closes one by id; `--clear` needs `--lost`), `logs`, `output`, `stats`, `savings`, `week`, `guide`, `doctor` | a | allowed |
| `up`, `install`, `trust`, `home`, `env`, `sync`, `service` | b | allowed: lean-agent's own setup and updates |

A lean-agent command with the same name as a denied one but another first word, a quoted text that merely contains the
word, or `lean-agent run … -- 'memory add …'` is not affected: the hook reads the command, not the task text.

## 3. Hooks (`plugins/lean-agent/hooks/hooks.json`)

| Hook | Class | What it does |
| --- | --- | --- |
| PreToolUse `budget_hook.py` | a | denies, never writes: budgets, strict mode (sections 1 and 2), background-run and todo-link reminders, read guard |
| PostToolUse `squeeze_hook.py` | a | shortens long Bash output |
| PreCompact / SessionStart `compact_hook.py` | a | prints the hand-off note and brief |
| SessionStart `session_hook.py` | b | records the session id in lean-agent's own runtime files |
| UserPromptSubmit `budget_hook.py` | b | strict mode only: a one-line `#` memory message is redirected to `lean-agent remember`; `/memory` and `/init` are blocked when Claude Code passes them to the hook |

## 4. Claude Code built-ins in an interactive session

| Built-in | Class | Handling |
| --- | --- | --- |
| `#` memory message | c | the UserPromptSubmit hook adds a redirect to `lean-agent remember` (a prompt that starts with `# ` followed by text; `#12 is failing` and multi-line text are normal prompts). Claude Code auto memory is off, so it has nowhere to write |
| `/memory`, `/init` | c | Claude Code runs them locally. The UserPromptSubmit hook blocks them if Claude Code passes them to it; otherwise this is a **known limit**: they edit the user's own CLAUDE.md files, are typed by the user, and the orchestrator doesn't load those files (`claudeMdExcludes`) |
| `/config`, `/mcp`, `/plugin` | c | **known limit**: local user commands that change Claude Code's settings; the hook can't block them. The home settings keep their own keys (`lean-agent home` rewrites them) |
| Other slash commands | b | bundled skills are off; the rest are the user's own commands |

There is no Claude Code setting that disables a single built-in slash command or the `#` shortcut for one folder
(`--disable-slash-commands` exists only as a launch flag, which workers use).
