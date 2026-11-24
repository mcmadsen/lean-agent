# lean-agent Live Map: design brief

> The hosted page was dropped in 0.45.91. As of 1.0 the surface is the desk pane (goals, answers, threads with
> Resume / Start, status line) in `plugins/lean-agent/hooks/pane.tsx`; the CLI text form and the `lean-agent` command
> mentioned below no longer exist. This brief is background for a visual redesign of that pane.

A brief for a designer. It describes what the Live Map is, who uses it, what data it has, what it shows today and
where it falls short. It ends with what we would like from you. Screens today work and are tested; the visual design
is engineer-made and is the thing to improve.

---

## 1. What lean-agent is (in one minute)

lean-agent is an add-on for Claude Code that lets one person run many AI coding agents at once without burning
tokens. The pieces:

| Piece | What it is | How the user sees it |
|---|---|---|
| **Front desk** | The one chat the user talks to. It routes work, never does project work itself. | A Claude chat (desktop or phone) |
| **Threads** | Long-lived agent sessions, one per topic (`t5 E2E checks`). They talk to the front desk. | Listed and reported by the front desk |
| **Workers** | Short, cheap, scoped runs a thread (or the front desk) starts for one task (`run 8545 · sonnet`). | Mostly invisible; results come back as reports |
| **Service socket** | A local background service that carries every message between them. | Invisible |
| **Hooks** | Small scripts Claude Code calls on every tool call (Edit, Bash, Read ...). | Invisible |
| **Projects** | Code repositories lean-agent has learned. Some can be marked private. | Named in threads and runs |

The Live Map makes this invisible machine visible: **who is working, on what, using which tools, what it costs, and
what needs the user.**

## 2. Who uses it and why

**Primary user:** a developer running 3–15 agent threads and a handful of workers across 1–5 projects, often on a
laptop, with the map open in a narrow side window while they keep chatting with the front desk.

The questions the map must answer at a glance, in priority order:

1. **Is anything stuck or waiting for me?** (stuck thread, undelivered message, failed tools, plan limit near)
2. **What is happening right now?** (which agent is doing what, live)
3. **How much am I using?** (plan usage and when it resets, cost today, tokens saved by lean-agent)
4. **What happened while I looked away?** (feed, timeline, replay)
5. **Where does the money go over time?** (trends per day, model, project, thread)

## 3. Where it runs (constraints that shape the design)

- **One self-contained HTML page**, served by the local service at `http://127.0.0.1:<port>/`. Inline CSS and JS
  only: no web fonts, no CDNs, no images from the network, no frameworks. System font stack.
- Opened as: a small **app window** (Chrome/Edge `--app` window or a Safari "Add to Dock" app), a normal browser tab,
  or a **file preview** inside the Claude desktop app (which blocks all live connections, so the page reloads itself
  from a file every 3 s there).
- **Widths from ~400 px (side window) to full desktop.** No horizontal page scroll at 400 px.
- **Light and dark**, following the system setting.
- **Live:** up to 30+ events per second at peak (tool calls, messages). Animations must stay calm, not frantic.
- **Privacy:** only a tool name and a short target are ever shown (`Edit · app.py`, `Bash · pytest`,
  `github · create_issue`, `WebFetch · example.com`). Never file contents, full commands, paths, queries or prompts.
  Private projects can be hidden by the user; then nothing of them may appear anywhere.
- There is also a tiny **Claude Code pane** version (server-drawn SVG, ~380×220) and a CLI text form; out of scope
  for this brief except as "the same visual language, very small".

## 4. The data (what you can design with)

Everything below is available live. Example values are made up.

### Nodes

| Kind | Example | Fields |
|---|---|---|
| Front desk | `Front desk · talking` | state (active / idle), idle time |
| Service socket | `service.sock · 0.6 ms · 20 threads · up 2 h` | round trip ms, CPU %, thread count, uptime |
| Thread | `t5 E2E checks · mid-turn` | id, title, project, state (active, mid-turn, parked, idle, undelivered), idle time |
| Worker | `run 8545 · sonnet · 12 min · alive` | model, state (alive, done, orphaned, dead), age, last progress, turns / max turns (7/80), tokens, cost ($0.52), git branch, context size |
| Hooks | `tool calls · 14 a min` | rate |

Each thread, worker and the front desk also carries **activity**:

- **now:** the tool in progress (`Edit · lean_map.py · 3 s`), or none
- **top tools** in the last 30 min (`Edit 12 · Bash 7 · Read 5`)
- **recent tool calls** (time, tool, target, duration, ok / failed), up to 20
- files touched (count), failed calls (count), MCP servers used (`github`)

### Edges (who talks to whom)

| Kind | Meaning | Today drawn as |
|---|---|---|
| message | front desk / service → agent (`send · t5`, `deliver`) | teal arrow |
| report | agent → back (`report · t6`, `result`) | amber arrow |
| request | socket request (`pending? 1 ms`) | blue arrow |
| idle | link exists, nothing moving | dashed grey |
| undelivered / stuck | a message did not arrive | red |

Edges fade 30 s after their last message. Live events animate a dot along the edge.

### Header-level numbers

- connection state (see §6), service CPU, workers, inbox (questions waiting for the user)
- **plan usage** per window: `5-hour 42% · resets in 2h 01m`, `week 83% · resets Fri 09:07`, model-specific weekly
  windows; source is Claude's own report (or lean-agent's estimate, labelled) with its age; "limit reached" state
- today: runs, cost, **tokens saved by lean-agent** (its main selling point), tool calls per minute, errors

### Alerts

`t5 mid-turn with no tool activity for 12 min` (warn) · `5-hour limit 96% - resets 14:10` (bad) · stuck worker,
undelivered message, error burst, daily budget, slow service. Each has a level (warn / bad), a node (optional), an age
and a stable id (so "new" vs "seen" is possible).

### Feed and history

- **Feed:** newest-first lines (`07:36 t1 Edit lean_map.py`, `t3 message`, `run started`, `Bash git failed`).
- **Replay:** every event of the last 60 min, for scrubbing back in time.
- **Trends (14 days):** cost per day, tokens saved, runs, model mix, cache-read ratio, cost per project, top threads
  by cost, top tools, plan usage over 7 days.

### Scale

Real homes have **hundreds** of threads and runs over time. Today the map shows at most **12 threads** (ranked: active
first, then undelivered, then most recent), **3 workers per thread**, and a `+N more` label.

## 5. What exists today (screens to redesign)

Screenshots can be produced on request; this is the inventory.

1. **Header:** title + version line; chips (connection, CPU, workers, inbox, alert bell with count, plan usage gauges,
   runs / cost / saved / tools per min); `Map | Trends` switch; Pause.
2. **Alerts bar:** one row per alert (level colour, text, age, "show", dismiss).
3. **Toolbar:** search ("filter by node or tool", `/` focuses it), Hide idle, Only errors, Activity (feed toggle),
   Notify (browser notifications for new bad alerts), project chips (`All · api 2 $1.20 · web 1 $0.40`).
4. **Map:** front desk left, service socket centre, threads in a column right (grouped by project when there are
   several), each thread's workers beside it, Hooks under the socket. Cards show title, state line, tool in progress,
   tool chips, error / MCP badges; worker cards add model, cost, tokens, turns bar, branch.
5. **Activity feed:** right-side panel (bottom sheet when narrow).
6. **Timeline:** last 10 or 60 min, one row per node, a tick per tool call (red when failed), a scrubber for replay
   with a "live" button.
7. **Details panel** (click a card): all fields, recent tool calls table, files / MCP / stats, its edges and feed
   lines. Plan usage has its own details panel.
8. **Trends view:** daily cost bars with tokens-saved line, model mix stacked bars, cache ratio line, projects table,
   top threads, top tools, plan usage chart.
9. **Legend + footer:** edge kinds (also toggles), "lines fade 30 s after the last message".

Current palette (dark / light), used as roles:

| Role | Dark | Light |
|---|---|---|
| background | `#0F1217` | `#F6F7F9` |
| card | `#1A1F27` | `#FFFFFF` |
| border | `#2A313C` | `#CBD2DC` |
| muted text | `#9AA3B2` | `#667085` |
| ok / message (teal) | `#2EC4B6` | `#1B9E92` |
| report (amber) | `#F2A541` | `#C9821A` |
| request (blue) | `#7AA2F7` | `#4A72D8` |
| idle | `#5B6475` | `#98A2B3` |
| bad (red) | `#F07167` | `#D6453B` |

## 6. States the design must cover

Connection chip (one at a time):

| State | When |
|---|---|
| `live (socket) · 0.6 ms` | normal |
| `live (polling)` / `live (image)` | fallbacks when sockets are blocked |
| `live (file refresh · 3 s)` | inside the Claude desktop file preview |
| `connecting` / `reconnecting` | starting / lost the connection |
| `connected, waiting for data` / `connected, no data (reason)` | the service answers but has no map yet / fails |
| `snapshot (service not running)` | page shows the last saved map |
| `preview blocks live updates` + "Open in browser" | every channel blocked |
| `service restarted - ...` | old page after a restart (normally recovers by itself) |
| paused | user pressed Pause: view frozen, nothing else stops |

Plus: empty home (no threads yet), one project vs many, a busy home (12 shown + `+268 more`), every node state, every
alert level, plan usage at 0 / 50 / 85 / 97 % / limit reached, estimate vs real, a worker with no thread (started by
the front desk), long titles, 400 px width.

## 7. Known problems (where design help is most wanted)

1. **Layout at scale.** A column of 12 threads with workers to the right gets tall; edges from the socket fan out and
   cross. Is a graph the right primary view at all, or should the default be a **status board / list** with the graph
   as a secondary "topology" view?
2. **Information density.** Cards carry many facts (state, tool now, top tools, errors, MCP, cost, turns, branch).
   What is primary, what is on hover / details?
3. **Narrow width (400 px).** Cards and chips wrap; text is cut. A dedicated narrow layout is probably better than a
   scaled-down wide one.
4. **The header is crowded:** connection, CPU, workers, inbox, bell, 2–3 usage gauges, 4 totals, switch, Pause.
5. **Calm liveness.** 30 events per second must feel alive but not noisy (pulses, fades, counters).
6. **Plan usage** is the number users ask about most ("how much do I have left, when does it reset?"). It deserves a
   clear, glanceable home.
7. **"Needs me"** (inbox questions, undelivered, stuck, limits) should be impossible to miss and separate from
   "interesting".
8. **Identity.** lean-agent has no visual identity yet: no icon, no wordmark, no colour story beyond the role colours
   above. An icon that works at 16 px (tab / Dock / menu bar) is welcome.

## 8. What we would like from you

- **Concept directions** (2–3) for the primary view: graph-first vs board-first vs a hybrid, at desktop and 400 px.
- **One chosen direction worked out:** header, "needs me" area, main view, details panel, feed, timeline / replay,
  Trends, all states in §6, light and dark.
- **Components:** node card (all kinds and states), edge styles, chips / gauges (plan usage!), alert row, feed line,
  timeline row, table, empty states.
- **Tokens:** colours (roles above may change), type scale (system fonts), spacing, radii, motion (pulse, fade,
  durations).
- **Icon** for lean-agent (16, 32, 512 px; light and dark).
- Deliver as images or an interactive mock (any tool); exact HTML is not needed, we implement it. Note anything that
  needs data we do not have (§4) so we can add it.

**Out of scope:** the chat itself, the Claude Code pane (beyond a tiny version of the same look), native menu bar /
tray apps (dropped for now), anything that needs network assets.
