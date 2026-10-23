# What the orchestrator session can still do

Audit of the orchestrator (the lean-agent home, or the service session behind the dashboard chat) with strict mode on
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
| Edit, MultiEdit, Write, NotebookEdit | c | denied in the home settings |
| Agent, Task, Workflow, WebFetch, WebSearch, Skill, LSP, EnterWorktree, ExitWorktree, TodoWrite, Task*, Cron*, Artifact*, SendMessage, SendUserFile, plugin/skill/connector search and install tools, ... | c | denied in the home settings (full list: `ORCHESTRATOR_DENY`) |
| Glob, Grep, LS, NotebookRead | a | denied in the home settings |
| `mcp__*` (every MCP server tool) | c | denied: server prefixes in the home settings, and every `mcp__` name by the hook |
| ListMcpResources(Tool), ReadMcpResource(Tool), ReadMcpResourceDir(Tool) | a | denied in the home settings and by the hook |
| Bash | b | allowed only for `lean-agent` commands (no other command, no redirects to files, no command substitution); subcommands in section 2 |
| Read | a | allowed only for lean-agent's own files (home, run files, the plugin) |
| AskUserQuestion, ToolSearch, Monitor, TaskOutput, TaskStop, ExitPlanMode (names vary by Claude Code version) | b | allowed: they talk to the user or watch the orchestrator's own background commands |

Also off in the home settings: Claude Code auto memory (`autoMemoryEnabled: false`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`),
bundled skills, claude.ai connectors, every other plugin, and every MCP server (`enableAllProjectMcpServers: false`; the
user, plugin and home `.mcp.json` servers are listed in `disabledMcpServers` / `disabledMcpjsonServers` of the home
folder's entry in `~/.claude.json`, `enabledMcpjsonServers` is empty). `lean-agent up` and `home` apply this
(`disable_home_mcp`, `orchestrator_settings`).

## 2. `lean-agent` subcommands strict mode allows or denies

| Subcommand and flags | Class | Strict mode |
| --- | --- | --- |
| `remember "<what>" [--project P] [--task-file -]` | b | allowed: starts the librarian worker; the only way to keep something |
| `advise "<request>" [--project P] [--thread TAG] [--task-file -]` | b | allowed: starts a read-only haiku advisor worker; stores its short answer in `advice/` (the dashboard shows it under the message) |
| `run`, `review`, `do`, `tracker --discover` (all flags, `--mcp`, `--allow-cmd`, `--todo new\|N\|none`) | b | allowed, in the background; they start workers |
| `thread new\|list\|merge\|unmerge\|move` | b | allowed |
| `checkpoint`, `brief` | b | allowed |
| `handoff` (read), `handoff --done N`, `handoff --note … --kind checkpoint\|fyi\|decision` | b | allowed: the orchestrator's own state; a `decision` note is how it asks the user something asynchronously |
| `handoff --note …` with no `--kind` or `--kind reminder` | c | **denied**: user content; `remember` |
| `todo list\|next\|start\|done` | b | allowed: status that follows a run it started |
| `todo add\|note\|edit\|rm\|reopen\|epic` | c | **denied** (`todo add` serves both; a run gets its item from `run --todo new`, which names it after `--why`) |
| `memory list\|where` | a | allowed |
| `memory add\|edit\|rm\|import` | c | **denied** |
| `cards`, `card show`, `suggest`, `projects` | a | allowed |
| `card add\|rm\|core\|shorten\|unarchive\|protect` | c | **denied** |
| `recipes` | a | allowed |
| `recipe add\|rm` | c | **denied** (stored runs are presets) |
| `mcp list\|tools\|preset\|env\|ignore` (all of `mcp`), `chrome check` | c | **denied**: the orchestrator neither lists nor runs MCP servers or presets; a read-only worker with `--allow-cmd 'lean-agent mcp'` does |
| `chrome status` | a | allowed |
| `doc write` | c | **denied** (files); a worker writes documents |
| `schedule list\|run\|pause\|resume\|run-due` | b | allowed |
| `schedule add\|rm\|defaults` | c | **denied** (a job later runs lean-agent commands) |
| `guard list` | a | allowed |
| `guard add\|rm` | c | **denied** |
| `count <project> [names]`, `--files`, `--by-folder` | a | allowed |
| `count <project> add\|rm …` | c | **denied** |
| `tracker <project>` (read), `tracker --discover` | a / b | allowed (`--discover` starts a worker that records identity it finds) |
| `tracker <project> KEY=VALUE`, `--note`, `--rm-note`, `--supersede`, `--ack-email` | c | **denied** |
| `worktree rm\|setup\|push\|reset`, `rules`, `codemod --apply` | c | **denied** (repo, branch, remote) |
| `worktrees`, `codemod` (throwaway copy), `map`, `slices`, `check`, `parity`, `grep-log`, `text-len` | a | allowed |
| `slices --create`, `learn` | b | allowed: todos, cards and lean-agent's own repo rules block derived from the code by lean-agent, with no text from the user |
| `optimize` (also `--apply`, `--accept`, `--reject`) | b | allowed: applies drafts a worker made from run feedback; no orchestrator text is stored. The user can also use the dashboard buttons |
| `review-decline`, `review-learn` | b | allowed: review state, and lessons a worker derives from human reviews |
| `publish` | b | allowed: a worker publishes the content |
| `config strict on`, `config artifacts …`, `attribution`, `limits`, `budget`, `context` | b | allowed: switches and limits |
| `config strict off` | c | **denied**: the orchestrator doesn't lift its own guardrail |
| `runs`, `logs`, `output`, `stats`, `savings`, `week`, `guide`, `doctor`, `dashboard` | a | allowed |
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
| PermissionRequest `permission_hook.py` | b | routes an approval to the dashboard |
| UserPromptSubmit `budget_hook.py` | b | strict mode only: a one-line `#` memory message is redirected to `lean-agent remember`; `/memory` and `/init` are blocked when Claude Code passes them to the hook |

## 4. Dashboard actions

| Action | Who runs it | Class | Status |
| --- | --- | --- | --- |
| Chat message (`/api/chat`) | the user, to the orchestrator | b | the orchestrator turns it into a worker task; section 2 applies |
| Fixed forms from buttons: `Answer to run …` (`run --resume`), `Decision for hand-off note N` (`handoff --done N`), `Start the next ready item …` (`todo next`, `run`), `About #N …` | the orchestrator | b | all allowed subcommands |
| Thread buttons (`/api/thread/*`) | the dashboard, directly | b | not a model call |
| Todo, note, dismiss, stop-run, sync, optimize buttons (`/api/action`) | the dashboard, directly, as the user | c | the user's own edit through the CLI; the orchestrator session is not involved, so strict mode doesn't apply |

## 5. Claude Code built-ins in an interactive session

| Built-in | Class | Handling |
| --- | --- | --- |
| `#` memory message | c | the UserPromptSubmit hook adds a redirect to `lean-agent remember` (one line starting with `#`; multi-line text is a normal prompt). Claude Code auto memory is off, so it has nowhere to write |
| `/memory`, `/init` | c | Claude Code runs them locally. The UserPromptSubmit hook blocks them if Claude Code passes them to it; otherwise this is a **known limit**: they edit the user's own CLAUDE.md files, are typed by the user, and the orchestrator doesn't load those files (`claudeMdExcludes`) |
| `/config`, `/mcp`, `/plugin` | c | **known limit**: local user commands that change Claude Code's settings; the hook can't block them. The home settings keep their own keys (`lean-agent home` rewrites them) |
| Other slash commands | b | bundled skills are off; the rest are the user's own commands |

There is no Claude Code setting that disables a single built-in slash command or the `#` shortcut for one folder
(`--disable-slash-commands` exists only as a launch flag, which workers use).
