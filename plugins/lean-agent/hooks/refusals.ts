// `lean_doctor refusals`: the guard's own recorded refusals (the rows of ~/.lean-agent/refusals.jsonl that the feedback export lists under
// "Guard refusals"), grouped by PATTERN with a count and a one-line fix, so a block that keeps happening is seen once, with what removes it:
// a grant the brief should have given, a command the reader set lacks, a path a worker needs. No model reads anything: the pattern is
// decided by the shape of the refusal text, and nothing here ever allows anything (a fix is advice, never a rule that is added).
// The doctor shows a "top refusals" row when a pattern repeats (config.json `refusals.repeat`, default 3).
import { homeDir, leanDir, readJsonl } from './state'
import type { Host } from './state'
import { readConfig } from './budget'
import { serverOf } from './profile'
import { triedOf } from './feedback'

export const REPEAT_DEFAULT = 3
export const DAYS_DEFAULT = 7
type Row = { ts?: number; text?: string; agent?: string; src?: string; command?: string; thread?: string; kind?: string; role?: string; rule?: string; tool?: string; job?: string; what?: string }
export type Pattern = { key: string; label: string; fix: string }
export type Group = Pattern & { n: number; agents: string[] }

const VERSION_TAIL = /\s*\(lean-agent \d[\w.-]*\)\s*$/
const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : p
}

// the shape of one refusal text -> its pattern. The texts are the guard's own (guard.ts); an unknown shape is its own pattern.
// `what` (the row's field, else the ` [tried: ...]` tag of the text): what was tried, so a pattern splits by it ("thread-orchestrate: az pipelines",
// "Edit project", "lean state config.json"); the cmd: patterns already name the program
export function patternOf(rawText: string, agent: string, what?: string): Pattern {
  const p = basePattern(rawText, agent)
  const w = what ?? triedOf(rawText)
  return w && !p.key.startsWith('cmd:') ? { ...p, key: `${p.key}:${w}`, label: `${p.label} [${w}]` } : p
}
function basePattern(rawText: string, agent: string): Pattern {
  const text = rawText.replace(VERSION_TAIL, '').replace(/\s+/g, ' ').trim()
  const who = agent || 'session'
  let m = /^lean-agent: refused: (\S+) \(([^)]*)\); (\S+) may run only/.exec(text)
  if (m) {
    const prog = m[1]!
    const why = m[2]!
    const kind = prog === 'cd' ? 'cd' : /redirect|substitution|glob|shell form/.test(why) ? 'shell' : /flag that writes|runs a program/.test(why) ? 'flag' : /outside the allowed/.test(why) ? 'path' : 'other'
    const fixes: Record<string, string> = {
      cd: 'a reader never cds: name absolute paths, or git -C <abs repo> ...',
      shell: 'one plain command per call: no ;, &&, ||, redirects, $(...) or a glob that leaves the allowed folders; give a plain command, or the step to a worker',
      flag: 'that flag writes or runs a program: a reader does not write: give the step to a worker',
      path: 'the path is outside the folders a reader may read: name one inside the worktree',
      other: `if \`${prog}\` is read-only and the work needs it, give the step to a reader-haiku (wide read commands) or a worker`,
    }
    return { key: `cmd:${who}:${prog}:${kind}`, label: `${who} refused \`${prog}\` (${why})`, fix: fixes[kind]! }
  }
  if (/may run only its built-in read-only git commands and the commands the thread granted/.test(text)) return { key: `cmd-old:${who}`, label: `${who} refused a command (older lean-agent wording: the program is not named)`, fix: 'update lean-agent: since 1.0.9 readers run the whole read-only set and the refusal names the program' }
  m = /^lean-agent: (?:the path )?(\/\S+?):? (?:is outside the paths the thread granted this worker|is not within the granted roots)/.exec(text) ?? /^lean-agent: no grant is recorded for this worker \(granted on the call: none found\), path (\/\S+?):/.exec(text)
  if (m) {
    const dir = dirOf(m[1]!)
    return { key: `edit:${dir}`, label: `a worker's edit outside its grant (older wording): ${dir}`, fix: 'older lean-agent wording (a grant refusal): since 1.0.18 a worker edits anywhere the permission check allows, no grant needed' }
  }
  if (/strict mode: route this to a thread/.test(text)) return { key: 'desk-strict', label: 'the desk was refused a command or file (strict mode)', fix: 'the desk routes work to a thread (thread skill); it reads only under ~/.lean-agent and runs the read-only git / gh forms' }
  if (/subagent cap reached/.test(text)) return { key: 'cap', label: 'the subagent cap was reached', fix: 'raise agents.cap in config.json, or do the rest in the thread (reviewer passes never count)' }
  m = /^lean-agent: (\S+) needs the user's approval/.exec(text)
  if (m) return { key: `model:${m[1]}`, label: `${m[1]} was refused until the user approves it`, fix: 'approve it in the pane (Needs you) when it is worth it, otherwise start the work on sonnet' }
  if (/push gate/.test(text)) return { key: 'push-gate', label: 'a thread tried git push', fix: 'a thread never pushes: run the full review, then lean_report "ready to push <sha>"; the desk pushes after the user\'s yes' }
  if (/a thread never asks the user directly/.test(text)) return { key: 'thread-ask', label: 'a thread used AskUserQuestion', fix: 'a thread asks with lean_ask; the desk relays it' }
  if (/cannot own grants/.test(text)) return { key: 'grants-owner', label: 'an Agent call with allow-* lines outside a thread', fix: 'allow-mcp lines are written only by a thread\'s own session: remove the lines or run the call from a thread' }
  for (const [id, re] of RULES) if (re.test(text)) return { key: `${id}:${who}`, label: `${who}: ${text.slice(0, 120)}`, fix: RULE_FIX[id] ?? 'read the refusal text' }
  return { key: `other:${who}:${text.slice(0, 50)}`, label: `${who}: ${text.slice(0, 120)}`, fix: 'read the refusal text; it names what was refused and why' }
}

// the rule id of a refusal (the second field of the one refusal record, feedback.ts logRefusal): from the shape of the guard's text, in this
// order; what the table does not know is the pattern's own head (cmd, edit, desk-strict, cap ...). Paths that are not a guard text pass their id.
const RULE_FIX: Record<string, string> = {
  'retry-limit': 'the same brief a third time never works: change what is asked, split it, or report blocked',
  'desk-routing': 'the desk routes: start or ask a thread (lean_thread new / send); it does not run tools itself',
  'why-sonnet-missing': 'haiku is the default worker: use lean-agent:worker-haiku / reader-haiku, or add a `why-sonnet: <reason>` line to the brief',
  'brief-too-long': 'one step per job: split the brief into steps of at most workers.briefChars characters',
  'job-missing': 'start the brief with `job: lookup|edit|run|check` (workers.requireJob)',
  'worker-slots': 'wait for a running worker to finish before starting the next (threads.workers)',
  'worker-spawn': 'a worker answers `split: <rest>`; the thread starts the next step',
  'worker-step-budget': 'the step was too big: give the worker one smaller step (workers.steps / stepsByJob)',
  'thread-orchestrate': 'a thread orchestrates: give a small step to lean-agent:worker-haiku / reader-haiku (workers may read and edit), tests and builds go through lean_run',
  'forge-write': 'a forge write (curl / az / gh) is never made by script: lean_report with an action kind (ado-pr-reply, ado-pr-thread-status, ... batch); the user approves, the mod sends it',
  'forge-read': 'a forge read outside the fixed allow-list: lean_run get (ado / github path, select) or lean_run ci reads it by the mod; or az repos pr show, az devops invoke (GET), gh pr view, gh api (GET), a plain curl GET without a body or an output file outside temp',
  'allow-mcp-missing': 'add `allow-mcp: <server>` to the worker brief (MCP is opt-in per job), or allowMcp on lean_thread new',
  'allow-mcp-other-server': 'the worker called a server its brief did not grant: grant that server, or keep the step to the granted ones',
  'allow-mcp-write-tool': 'a worker has read-only MCP access: the write goes through the thread and the desk\'s approval',
  'delegation-denied': 'the permission check (auto mode classifier or a rule) denied the thread\'s worker call: the thread did that step itself (its own edit under the call\'s allow-edit paths is allowed, the permission check still judges it); not a lean-agent fault',
  'context-limit': 'the thread reached threadTokens: its state is saved, a fresh session continues from the handover (end the turn; raise threadTokens in config.json if the limit is too small)',
  'run-refused': 'lean_run runs tests and builds only: push and forge commands are the desk\'s',
}
const RULES: [string, RegExp][] = [
  ['delegation-denied', /^delegation-denied:|^the permission check denied the worker call/],
  ['retry-limit', /this exact job already ran (twice|once)/],
  ['desk-routing', /^the desk routes:/],
  ['why-sonnet-missing', /^haiku by default: add a prompt line/],
  ['brief-too-long', /^one step per job: the brief is/],
  ['job-missing', /^the first line of the brief names the job/],
  ['worker-slots', /^at most \d+ workers at once/],
  ['worker-spawn', /^a worker never spawns workers/],
  ['worker-step-budget', /^step budget of a|^return what you have; the thread splits/],
  ['forge-write', /^forge writes go through the desk/],
  ['forge-read', /^read it with lean_run get \(forge reads/],
  ['thread-orchestrate', /^one step for a small worker|^run tests and builds with lean_run/],
  ['allow-mcp-missing', /this brief has no allow-mcp line/],
  ['allow-mcp-other-server', /is not granted for this job \(allow-mcp/],
  ['allow-mcp-write-tool', /allow-mcp-write is not honoured|looks like a write tool/],
  ['context-limit', /^context limit reached \(/],
  ['run-refused', /^lean_run refused/],
]
export function ruleOf(rawText: string, agent = ''): string {
  const text = rawText.replace(VERSION_TAIL, '').replace(/\s+/g, ' ').trim()
  for (const [id, re] of RULES) if (re.test(text)) return id
  return patternOf(text, agent).key.split(':')[0]!
}

export async function groupRefusals(h: Host, days = DAYS_DEFAULT): Promise<{ groups: Group[]; total: number; since: number }> {
  const home = await homeDir(h)
  const now = await h.clock.now()
  const since = now - Math.max(1, days) * 86_400_000
  const groups = new Map<string, Group>()
  let total = 0
  // the guard's own rows only (a worker's own report of a refusal is counted in the export separately, never twice here)
  for (const r of await readJsonl<Row>(h, `${leanDir(home)}/refusals.jsonl`)) {
    if (!r || r.src === 'worker' || r.kind === 'missing-tool' || r.command !== undefined || typeof r.text !== 'string' || (typeof r.ts === 'number' && r.ts < since)) continue
    total++
    const agent = (r.agent ?? 'session').replace(/^lean-agent:/, '')
    const p = patternOf(r.text, agent, typeof r.what === 'string' ? r.what : undefined)
    const g = groups.get(p.key)
    if (g) {
      g.n++
      if (!g.agents.includes(agent)) g.agents.push(agent)
    } else groups.set(p.key, { ...p, n: 1, agents: [agent] })
  }
  return { groups: [...groups.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)), total, since }
}

// ---- missing tools -------------------------------------------------------------------------------------------------------------
// A tool call that failed because the tool is not available to that session or worker (not in its tool list, an MCP server that is not
// connected). Returns what was missing (the tool, or `mcp <server>`), or null when the failure is anything else (a failing test, a bad
// argument): only the engine's "not available" wording counts, so a failing command is never recorded as a missing tool.
const MISSING = /no such tool|unknown tool|tool [^.\n]{0,80}\b(is |was )?not (available|found|connected|enabled|allowed in this)|not available (to|in|for) (this|the) (session|agent|worker|subagent)|(mcp )?server [^.\n]{0,60}(not connected|failed to connect|is unavailable|not found)|not connected to (the )?mcp|no mcp server/i
export function missingWhat(tool: string, resultText: string): string | null {
  if (!MISSING.test(resultText.slice(0, 600))) return null
  const s = serverOf(tool)
  return s ? `mcp ${s}` : tool.slice(0, 80) || null
}
// the answer lines of a worker that could not finish its step: `split: ...`, `missing: ...`, `refused: ...` (the keywords found, never the text)
export function workerLines(text: string): string[] {
  const out: string[] = []
  for (const l of text.split('\n')) {
    const m = /^\s*(split|missing|refused):\s*(\S.*)$/i.exec(l)
    if (m && !out.includes(m[1]!.toLowerCase())) out.push(m[1]!.toLowerCase()) // the keyword only: a worker's own words can name a client or a path
    if (out.length >= 3) break
  }
  return out
}

export type MissingGroup = { role: string; what: string; job: string; n: number }
// the rows of kind missing-tool (a tool a session or worker needed and did not have), grouped by role, tool or server and job type
export async function groupMissing(h: Host, days = DAYS_DEFAULT): Promise<{ groups: MissingGroup[]; total: number }> {
  const since = (await h.clock.now()) - Math.max(1, days) * 86_400_000
  const groups = new Map<string, MissingGroup>()
  let total = 0
  for (const r of await readJsonl<Row>(h, `${leanDir(await homeDir(h))}/refusals.jsonl`)) {
    if (!r || r.kind !== 'missing-tool' || (typeof r.ts === 'number' && r.ts < since)) continue
    total++
    const role = r.role ?? 'session'
    const what = r.tool ?? '?'
    const job = r.job ?? 'none'
    const k = `${role}\u0000${what}\u0000${job}`
    const g = groups.get(k)
    if (g) g.n++
    else groups.set(k, { role, what, job, n: 1 })
  }
  return { groups: [...groups.values()].sort((a, b) => b.n - a.n || a.what.localeCompare(b.what)), total }
}

export async function repeatOf(h: Host): Promise<number> {
  const v = Number((await readConfig(h, await homeDir(h))).refusals?.repeat)
  return Number.isInteger(v) && v >= 2 ? v : REPEAT_DEFAULT
}

// the action's text: every pattern, most frequent first, each with its one-line fix
export async function refusalsText(h: Host, days = DAYS_DEFAULT): Promise<string> {
  const d = Number.isFinite(days) && days >= 1 ? Math.min(90, Math.floor(days)) : DAYS_DEFAULT
  const { groups, total } = await groupRefusals(h, d)
  const miss = await groupMissing(h, d)
  const missing = miss.total ? [`${miss.total} missing tool(s) in the last ${d} day(s) (the feedback export lists them under "Missing tools"):`, ...miss.groups.map(g => `- (x${g.n}) [${g.role}] ${g.what}${g.job !== 'none' ? ` (job ${g.job})` : ''}`)] : []
  if (!total) return [`no guard refusal in the last ${d} day(s)`, ...missing].join('\n')
  const repeat = await repeatOf(h)
  return [`${total} guard refusal(s) in the last ${d} day(s), ${groups.length} pattern(s) (the rows the feedback export lists under "Guard refusals"); a pattern that repeats ${repeat} times or more is a block to remove:`, ...groups.map(g => `- (x${g.n})${g.n >= repeat ? ' REPEATS' : ''} ${g.label}\n    fix: ${g.fix}`), ...missing].join('\n')
}

// the doctor's row: null when nothing repeats
export async function topRefusalsRow(h: Host): Promise<string | null> {
  const repeat = await repeatOf(h)
  const { groups } = await groupRefusals(h, DAYS_DEFAULT)
  const top = groups.filter(g => g.n >= repeat).slice(0, 3)
  if (!top.length) return null
  return `note top refusals (last ${DAYS_DEFAULT} days): ${top.map(g => `(x${g.n}) ${g.label}: ${g.fix}`).join(' | ')}. All of them: lean_doctor refusals`
}
