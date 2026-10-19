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
| `lean-agent optimize <project> [--apply] [--accept ids] [--reject ids]` | Promote/demote core cards, archive dead ones, flag big cards to trim, list recent context gaps, and draft new recipe cards and MCP presets from what workers actually did. |
| `lean-agent runs [--last] [--tokens] [--show [id]]` | Recent runs; `--tokens` prints the latest run's run/tokens/context lines again, `--show` its whole summary (saved per run, so a `| tail` can't lose it). |
| `lean-agent stats [--today] [--project p]` | Runs, success rate, avg/total weighted tokens and cost per model. |
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
- **Big MCP results:** when a result is too big and Claude Code saves it to a file, workers are pointed at
  `lean-json <file> [--fields a,b.c] [--grep TEXT] [--exclude TEXT]`, which prints a compact view (links, URLs,
  avatars and empty values dropped, identities as names, one line per item). Read-only workers may run it too.
- **Exact identifiers for external systems:** every worker given `--mcp` gets the repository's identity from its
  git `origin` remote (Azure DevOps organization, project and repository; GitHub/GitLab owner and repository) and
  is told never to use lean-agent's project name as a tracker project, and to stop with `needs-input` if a
  lookup finds nothing. When the remote doesn't say, set it once: `lean-agent tracker <project> project=<name>`
  (also `org=`, `repo=`).
- **Who you are in the tracker, and its rules:** `lean-agent tracker <project> --discover --mcp <tracker>` lets
  a worker find your identity id and name and the project's work item rules (allowed states, no delete, voting
  needs a reviewer id) once. Add your own with `--note "..."` or `me_id=... me_name=...`. Every MCP worker gets
  them, so assigning, voting or closing doesn't have to fail first (`@me` often isn't accepted).
- **Variables without a token on disk:** a plugin config that uses `${VAR}` (e.g. a GitHub token) can get it
  from a command run when a worker starts: `lean-agent mcp env GITHUB_PERSONAL_ACCESS_TOKEN --command "gh auth
  token"` (or a macOS keychain item: `security find-generic-password -s <name> -w`). Only the command is saved;
  the value goes into the run's owner-only MCP config, which is deleted when the run ends. Options
  marked sensitive live in Claude Code's credentials store; lean-agent can't read them and doctor says so.
- Not covered: claude.ai connectors (they aren't in a local config file).

## Attribution (asked once)

Whether commits and PRs credit Claude is your call, asked once: by `lean-agent up` in a terminal, or by the
orchestrator before the first commit or PR (`lean-agent attribution` says "not set"). Save it with
`lean-agent attribution on|off`. When it's off:

- workers start with Claude Code's own `attribution` setting emptied (no Co-Authored-By line, no "Generated with
  Claude Code", no session link), and so does the orchestrator;
- workers and the orchestrator are told not to mention Claude or AI in commits, PR titles and descriptions, or
  comments;
- `lean-agent worktree push` refuses commits that still credit Claude.

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
- **Re-review:** `review <project> --resume` continues the same reviewer session, which is cheap because its
  context is cached, and checks earlier findings first. It also runs the reuse, scope and platform passes again
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
   **New cards from what workers did:** one successful run with a distinctive MCP pattern (2+ tools, 4+ calls or
   6+ turns) is enough for `optimize` to draft a recipe card: the task, the tools in the order they worked, the
   `--mcp` spec, what a good answer looked like, and what it cost without the card. Runs with the same server and a
   similar tool set, or similar wording, are grouped into one draft. A **preset** is drafted (named from the tool
   names, e.g. `datadog:metrics`) when a run was given far more tools than it used, or a pattern recurs. Drafts
   already covered by a card are skipped. Drafts are generalised (PR and ticket numbers, ids, hashes, local
   paths and "Goal:"-style labels removed), read-only and changing runs never share a draft, a read-only preset
   never contains a write tool (a separate `<name>-write` draft says which write tools it adds), and two drafts
   never get the same preset name. `optimize <project> --accept <id>` writes them (`card add`, `mcp
   preset`), `--reject <id>` stops proposing one. The 5-run threshold only gates trim/core/archive.
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
| `LEAN_AGENT_WORKER_BASH_OUTPUT` | `12000` | `BASH_MAX_OUTPUT_LENGTH` for workers. |
| `LEAN_AGENT_RESULT_CHARS` | `12000` | Max worker reply printed back to the orchestrator (workers lead with a summary; the full result is saved). |
| `LEAN_AGENT_HOME` | `~/.lean-agent` | Where everything lives. |

## The plugin

Installing the plugin also gives any Claude Code session (not just the orchestrator):

- **Output squeezer:** a PostToolUse hook for noisy Bash output over 6,000 chars. Noise goes first: progress
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
  decision), and `verbose/` (full outputs and their errors-only copies, kept 2 days). `lean-agent logs [error|debug|verbose]`
  shows the latest entries. Nothing is sent to Claude unless it reads a file.
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
