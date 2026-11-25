// Execution model (config lean.orchestrate, default on): the desk only routes, a thread only orchestrates, every read/search/edit is one
// small step for a haiku worker. Enforced here by the guard (guard.ts calls orchDecide), not by text a model has to remember.
// Pure rules over a call plus a little in-memory state (per-turn direct reads, workers in flight, per-worker step counts).
import { plainPipeline } from './shell'
import { jobOf, retryDenial, retryRan, retryReset, reviewerBudget, stepBudget, stepNote } from './jobs'
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { forgeHint, forgeRefusal, forgeCommandWrite } from './forgewrite'
import { forgeReadOk, forgeReadRefusal, forgeTempOk, isForgeFetch } from './forgeread'
import { threadHint } from './denial'

export type OrchConfig = { on: boolean; deskChars: number; agentChars: number; directReads: number; workers: number; briefChars: number; steps: number; stepsByJob: Partial<Record<string, number>>; requireJob: boolean; grantTtlMin: number; commit: boolean }
export type OCtx = { kind: 'desk' | 'thread' | 'other'; agentType?: string; agentId?: string; job?: string; home: string; threadDir?: string; cwd?: string; projects?: string[]; selfEdit?: string[]; haiku?: string /* the haiku record of this project for the brief's job type (workerruns.ts haikuRecordText), said in the why-sonnet refusal */ } // selfEdit: the worktrees the user let this thread edit itself (selfedit.ts, verified per call); projects: the registered projects' folders (only to name a path's kind in a refusal record)
export type Call = { tool: string; [k: string]: any }

export const DESK_ROUTE = 'the desk routes: start or ask a thread (lean_thread new / send)'
export const THREAD_STEP = 'one step for a small worker: lean-agent:worker-haiku (workers may read and edit) / lean-agent:reader-haiku (set the Agent parameter run_in_background to the boolean false; a worker that still starts in the background is fine: wait for its result notification, do not poll or duplicate the job)'
export const SPLIT = 'return what you have; the thread splits the rest'
export const DEFAULTS: OrchConfig = { on: true, deskChars: 6000, agentChars: 6000, directReads: 3, workers: 4, briefChars: 3000, steps: 24, stepsByJob: {}, requireJob: false, grantTtlMin: 120, commit: true }

// What was tried, for the refusal record (never a path, never an argument): ` [tried: Edit project]`, ` [tried: az pipelines]`. feedback.ts takes it out
// of the text into the row's `what`, refusals.ts groups by it. A path is named by its KIND only.
export const tried = (what: string): string => ` [tried: ${what}]`
const SUBCMD_TOOLS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'az', 'gh', 'docker', 'dotnet', 'cargo', 'go', 'kubectl', 'pip', 'pip3', 'npx', 'poetry', 'terraform', 'helm'])
export function triedWords(w: string[]): string {
  let i = 0
  const prog = (w[0] ?? '').split('/').pop()!.replace(/[^A-Za-z0-9_.+-]/g, '').slice(0, 30) || '?'
  if (prog === 'git') for (i = 1; i < w.length; i++) { if (w[i] === '-C' || w[i] === '-c') i++; else if (!w[i]!.startsWith('-')) break }
  else i = 1
  const sub = SUBCMD_TOOLS.has(prog) ? w[i] : undefined
  return sub && /^[a-z][a-z0-9-]{0,24}$/.test(sub) ? `${prog} ${sub}` : prog
}
export type PathKind = 'worktree' | 'project' | 'lean state' | 'thread folder' | 'other'
export function pathKind(ctx: OCtx, p: string): PathKind {
  const abs = normPath(p || '.', ctx.cwd)
  const lean = `${ctx.home}/.lean-agent`
  if (ctx.threadDir && under(abs, ctx.threadDir)) return 'thread folder'
  if (under(abs, `${lean}/worktrees`)) return 'worktree'
  if (under(abs, lean)) return 'lean state'
  if ((ctx.projects ?? []).some(r => under(abs, r))) return 'project'
  return 'other'
}
export const DIRECT_READ_LINES = 200

// a key of config.json: nested (`threads: { directReads }`) or flat (`"threads.directReads"`)
const pick = (cfg: any, key: string): unknown => {
  if (!cfg || typeof cfg !== 'object') return undefined
  if (key in cfg) return cfg[key]
  let v: any = cfg
  for (const p of key.split('.')) v = v && typeof v === 'object' ? v[p] : undefined
  return v
}
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : d)

// config.json `workers.stepsByJob: { lookup, edit, run, check }`: whole numbers >= 1 for the four job types, anything else ignored
const byJob = (v: unknown): Partial<Record<string, number>> => {
  const out: Partial<Record<string, number>> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const j of ['lookup', 'edit', 'run', 'check']) { const n = (v as any)[j]; if (typeof n === 'number' && Number.isFinite(n) && n >= 1) out[j] = Math.floor(n) }
  return out
}

export function orchConfig(cfg: any): OrchConfig {
  const on = pick(cfg, 'lean.orchestrate')
  return {
    on: on !== false && on !== 'false' && on !== 0,
    deskChars: num(pick(cfg, 'deskToolResultChars'), DEFAULTS.deskChars),
    agentChars: num(pick(cfg, 'agentResultChars'), DEFAULTS.agentChars),
    directReads: typeof pick(cfg, 'threads.directReads') === 'number' && (pick(cfg, 'threads.directReads') as number) >= 0 ? Math.floor(pick(cfg, 'threads.directReads') as number) : DEFAULTS.directReads,
    workers: num(pick(cfg, 'threads.workers'), DEFAULTS.workers),
    briefChars: num(pick(cfg, 'workers.briefChars'), DEFAULTS.briefChars),
    steps: num(pick(cfg, 'workers.steps'), DEFAULTS.steps),
    stepsByJob: byJob(pick(cfg, 'workers.stepsByJob')),
    requireJob: pick(cfg, 'workers.requireJob') === true,
    grantTtlMin: num(pick(cfg, 'grants.ttlMinutes'), DEFAULTS.grantTtlMin),
    commit: pick(cfg, 'workers.commit') !== false && pick(cfg, 'workers.commit') !== 'false', // a worker may commit its own change when the brief says `commit: <message>`
  }
}

// The built-in tool list of a thread session, as the argv pair for `claude --bg`. Measured (haiku, one word answer, a real thread folder): the
// built-in tool definitions are most of what a session carries on EVERY request (47.1k with the full set, 31.0k with the list below). A subagent can
// only use tools its parent session has, so the list keeps what workers and readers need (Edit, Write, Grep, Glob, WebFetch, WebSearch) and
// ToolSearch (MCP tools stay deferred and loadable). config.json `threads.tools`: an array of names replaces the list; an empty array or "all"
// means no flag (the full set). Off with lean.orchestrate false (the thread then edits itself). Anything but a plain name is dropped here.
export const THREAD_TOOLS = ['Agent', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Skill', 'SendMessage', 'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch']
export async function threadToolsArgv(h: Host): Promise<string[]> {
  try {
    if (!(await loadOrch(h)).on) return []
    const cfg = await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, {})
    const raw = cfg?.threads?.tools ?? cfg?.['threads.tools']
    if (raw === undefined || raw === null) return ['--tools', THREAD_TOOLS.join(',')]
    if (raw === 'all') return []
    const names = Array.isArray(raw) ? [...new Set(raw.filter((x: unknown): x is string => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(x)))] : []
    return names.length ? ['--tools', names.join(',')] : []
  } catch {
    return []
  }
}

// config.json plus a host's LEAN_ORCHESTRATE variable (0 / false = off). The engine host (host.ts) answers only $HOME, so in a real session
// the file is the switch; a host that does answer the variable (the specs' fake host) can switch it off without a file.
export async function loadOrch(h: Host): Promise<OrchConfig> {
  const home = await homeDir(h)
  const c = orchConfig(await readJson<any>(h, `${leanDir(home)}/config.json`, {}))
  const env = await h.env.get('LEAN_ORCHESTRATE').catch(() => undefined)
  return env === '0' || env === 'false' ? { ...c, on: false } : c
}

// ---- state -----------------------------------------------------------------------------------------------------------------
const reads = new Map<string, number>() // thread key -> direct reads this turn
const inflight = new Map<string, number>() // thread key -> workers running
const steps = new Map<string, number>() // worker id -> tool calls so far
const notes = new Map<string, string>() // worker id -> the "N tool calls left" line its next tool result carries
// the line for the result of the worker's call that was just allowed (said once per call, then gone)
export function takeStepNote(workerKey: string): string | null {
  const n = notes.get(workerKey) ?? null
  notes.delete(workerKey)
  return n
}
const slots = new Map<string, { key: string; at: number; type?: string }>() // subagent id -> the thread whose worker slot it holds (a background worker outlives its Agent call)
// the background workers a thread's session has running now (launched, not ended): what a restarted session must not wait for (oldworkers.ts)
export const liveWorkers = (threadKey: string): { id: string; type?: string }[] => [...slots].filter(([, s]) => s.key === threadKey).map(([id, s]) => ({ id, ...(s.type ? { type: s.type } : {}) }))
const stopped = new Set<string>() // subagents that ended before their launch result was seen
const MAX_TRACKED = 500
const budgetHit = new Set<string>() // subagent ids whose call past the step budget was refused
export const hitBudget = (agentId: string | undefined): boolean => !!agentId && budgetHit.has(agentId)
// the tool-call count and budget of the refusal just made for a worker (said once per refusal, then gone): the refusal record names them
const over = new Map<string, { calls: number; budget: number }>()
export function takeOver(workerKey: string | undefined): { calls: number; budget: number } | null {
  const o = (workerKey && over.get(workerKey)) || null
  if (workerKey) over.delete(workerKey)
  return o
}
export const stepsOf = (agentId: string | undefined): number => (agentId && steps.get(agentId)) || 0 // tool calls the guard counted for this subagent so far
export const orchTurnStart = (key: string): void => void reads.delete(key)
export function orchReset(): void {
  reads.clear()
  inflight.clear()
  steps.clear()
  over.clear()
  notes.clear()
  slots.clear()
  stopped.clear()
  budgetHit.clear()
  denied.clear()
  readerDenied.clear()
  retryReset()
}

// ---- helpers ---------------------------------------------------------------------------------------------------------------
const bare = (t?: string) => (t ?? '').replace(/^lean-agent:/, '')
export const isSmall = (t?: string): boolean => /^(worker|reader)-(haiku|sonnet|opus|mcp)$/.test(bare(t))
const isAgentTool = (e: Call) => e.tool === 'Agent' || e.tool === 'Task'
const key = (ctx: OCtx) => ctx.threadDir ?? ctx.home
const under = (p: string, root: string) => p === root || p.startsWith(root + '/')
const normPath = (p: string, cwd?: string): string => {
  const out: string[] = []
  for (const s of (p.startsWith('/') ? p : `${cwd ?? '/'}/${p}`).split('/')) {
    if (!s || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return '/' + out.join('/')
}
// lean-agent's own state, for a direct read or edit: not the project worktrees (that is a worker's step) and not the settings, grants or
// review records (a thread that wrote them could switch the model off or forge a record)
const LEAN_PROTECTED = /^\/(worktrees\/|config\.json$|projects\.json$|grants\.json$|approvals|[^/]+\/reviews(\/|$))/
const inLean = (ctx: OCtx, p: string) => {
  const abs = normPath(p, ctx.cwd)
  const root = `${ctx.home}/.lean-agent`
  return under(abs, root) && !LEAN_PROTECTED.test(abs.slice(root.length))
}

const GIT_OK = new Set(['status', 'log', 'add', 'commit', 'worktree', 'branch', 'rev-parse', 'remote', 'push', 'fetch', 'switch', 'show', 'diff'])
const DIFF_OK = /^--(stat|shortstat|numstat|name-only|name-status)(=.*)?$/
const OTHER_CLI = new Set(['lean-agent', 'claude', 'gh', 'az']) // the other guards judge these (gh / az reads; a forge WRITE by gh / az / curl is refused first, in threadDenial, and in guard.ts for a subagent)
const LIST = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'find', 'mkdir'])
const SEARCH = new Set(['grep', 'rg'])
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const REFNAME = /^[\w./@^~+-]+$/
// text filters at the end of a pipeline (`gh pr list --json number | jq ...`): they read stdin only (no file operand, no flag that reads or writes a file)
const FILTER_FLAGS = /^(-[inFEvcwxoq]+|--(ignore-case|fixed-strings|extended-regexp|invert-match|count|only-matching))$/ // (grep / rg: never -r, -f, -d)
function filterOk(w: string[]): boolean {
  const c = w[0]!
  const args = w.slice(1)
  if (c === 'tr') return args.length >= 1 && !args.some(a => a.startsWith('-') && a !== '-d' && a !== '-s')
  if (['head', 'tail', 'wc', 'uniq', 'cut', 'sort', 'nl'].includes(c)) {
    if (args.some(a => /^(-o|--output|-f$|--files0|-T|--temporary|--compress|--random-source|-S$|-m$)/.test(a) && !(c === 'cut' && /^-f/.test(a)))) return false
    return args.every(a => /^-[\w,.:;|=/-]*$/.test(a) || /^\d+$/.test(a)) // flags with attached values, `-n 5`; never a file name
  }
  if (c === 'jq') {
    if (args.some(a => /^(-f|--from-file|--rawfile|--slurpfile|-L|--args|--jsonargs|--arg|--argjson)/.test(a))) return false
    const pos = args.filter(a => !/^-[a-zA-Z]+$/.test(a))
    return pos.length === 1
  }
  if (c === 'grep' || c === 'rg') {
    const flags = args.filter(a => a.startsWith('-'))
    return flags.every(a => FILTER_FLAGS.test(a)) && args.filter(a => !a.startsWith('-')).length === 1
  }
  return false
}
// the folder a git command works in: its -C (the last one), else the session folder; null when it carries -c (a config override can run programs)
function gitDir(ctx: OCtx, w: string[]): string | null {
  let dir = ctx.cwd ?? '/'
  for (let i = 1; i < w.length && w[i]!.startsWith('-'); i++) {
    if (w[i] === '-c') return null
    if (w[i] === '-C') { dir = normPath(w[i + 1] ?? '', dir); i++ }
  }
  return dir
}
// a thread's own git work in its OWN worktrees (not a project's main checkout), never a push: checkout -b, stash, pull / merge --ff-only, rebase onto a ref, cherry-pick
function gitOwnWork(ctx: OCtx, w: string[], sub: string, rest: string[]): boolean {
  const dir = gitDir(ctx, w)
  if (!dir || !under(dir, `${ctx.home}/.lean-agent/worktrees`)) return false
  const ref = (a?: string) => !!a && REFNAME.test(a) && !a.startsWith('-')
  if (sub === 'checkout') return (rest[0] === '-b' || rest[0] === '-B') && ref(rest[1]) && !rest[1]!.includes('..') && rest.length <= 3 && (rest.length === 2 || ref(rest[2]))
  if (sub === 'stash') return rest.every((a, i) => (i === 0 ? /^(push|pop|apply|list|show|drop|save|-u|-k|--include-untracked|--keep-index|-m)$/.test(a) : !a.startsWith('-') || /^(-u|-k|-m|--|--include-untracked|--keep-index|--staged|-p)$/.test(a)))
  if (sub === 'pull') return rest.includes('--ff-only') && rest.every(a => /^(--ff-only|--no-edit|--no-tags|--prune|-q|--quiet)$/.test(a) || ref(a))
  if (sub === 'merge') return (rest.includes('--ff-only') && rest.every(a => /^(--ff-only|--no-edit)$/.test(a) || ref(a))) || (rest.length === 1 && rest[0] === '--abort')
  if (sub === 'rebase') return (rest.length === 1 && /^--(continue|abort|skip)$/.test(rest[0]!)) || (rest.length === 1 && ref(rest[0])) // `git rebase <its base>`, never -i / --exec
  if (sub === 'cherry-pick') return rest.length >= 1 && rest.every(a => /^(-x|-n|--no-commit|--continue|--abort|--skip|--quit)$/.test(a) || ref(a))
  return false
}

function gitSub(w: string[]): { sub: string; rest: string[] } | null {
  let i = 1
  while (i < w.length) {
    const a = w[i]!
    if (a === '-C' || a === '-c') i += 2
    else if (a.startsWith('-')) i++
    else break
  }
  return i < w.length ? { sub: w[i]!, rest: w.slice(i + 1) } : null
}

function bashSegOk(ctx: OCtx, w: string[], piped = false): boolean {
  const c = w[0]
  if (!c) return false
  if (OTHER_CLI.has(c)) return true
  if (isForgeFetch(w)) return forgeReadOk(w, p => forgeTempOk(p, ctx.threadDir ? `${ctx.threadDir}/scratch` : undefined)) // curl / wget to a forge host: a plain GET (forgeread.ts)
  if (c === 'git') {
    const g = gitSub(w)
    if (!g) return false
    if (GIT_OK.has(g.sub)) return g.sub !== 'diff' || g.rest.some(a => DIFF_OK.test(a))
    return gitOwnWork(ctx, w, g.sub, g.rest)
  }
  if (c === 'echo' || c === 'pwd') return true
  // script listing (never a run): `npm run`, `pnpm run --list`, `npm pkg get scripts`
  if (PKG.has(c)) return ((w[1] === 'run' || w[1] === 'run-script') && w.slice(2).every(a => /^(--list|-l)$/.test(a))) || (c === 'npm' && w.slice(1).join(' ') === 'pkg get scripts')
  if (piped && filterOk(w)) return true
  const operands = w.slice(1).filter(a => !a.startsWith('-'))
  // `rm` of files inside the thread's own scratch folder (mkdir -p there is a LIST command)
  if (c === 'rm') return !!ctx.threadDir && w.slice(1).every(a => /^-[rRf]+$/.test(a) || (a.startsWith('/') && under(normPath(a), `${ctx.threadDir}/scratch`))) && operands.length >= 1
  if (SEARCH.has(c)) return operands.length >= 2 && operands.slice(1).every(a => a.startsWith('/') && inLean(ctx, a))
  if (LIST.has(c)) return operands.length >= 1 && operands.every(a => a.startsWith('/') && inLean(ctx, a))
  return false
}

// the words of the first segment the thread may not run itself (null: all of them are allowed); a command the scanner calls complex is named by its first words
export function bashBad(ctx: OCtx, command: string): string[] | null {
  const parts = command.split(/\s*&&\s*/).filter(p => p.trim())
  if (!parts.length) return ['?']
  for (const p of parts) {
    const segs = plainPipeline(p.trim())
    if (!segs || !segs.length) return p.trim().split(/\s+/).slice(0, 4)
    for (let i = 0; i < segs.length; i++) if (!bashSegOk(ctx, segs[i]!, i > 0)) return segs[i]!
  }
  return null
}
export const bashOk = (ctx: OCtx, command: string): boolean => bashBad(ctx, command) === null

// what to do instead, at most 12 words (after the general refusal)
const TEST_RUNNERS = /^(npm|pnpm|yarn|bun|npx|pytest|make|cargo|dotnet|go|tsc|vitest|jest|mvn|gradle)$/
function bashInstead(w: string[]): string {
  const prog = w[0] ?? ''
  if (prog === 'git') return '; git writes only inside your own worktree; a checkout of a branch is git switch'
  if (TEST_RUNNERS.test(prog)) return '; tests and builds: lean_run; scripts: npm run lists them'
  if (prog === 'cd') return '; never cd: name absolute paths or git -C <dir>'
  return ''
}
const BASH_STEP = 'run tests and builds with lean_run, or give the step to lean-agent:worker-haiku / lean-agent:reader-haiku'

// ---- the rules -------------------------------------------------------------------------------------------------------------
function agentCallDenial(c: OrchConfig, ctx: OCtx, e: Call): string | null {
  if (isSmall(ctx.agentType)) return 'a worker never spawns workers; answer `split: <rest>` and the thread starts the next step'
  const s = bare(typeof e.subagent_type === 'string' ? e.subagent_type : '')
  const p = String(e.prompt ?? e.description ?? '')
  if ((s === 'worker-sonnet' || s === 'reader-sonnet') && !/^\s*why-sonnet:\s*\S/m.test(p)) return `haiku by default: add a prompt line \`why-sonnet: <reason>\` or use lean-agent:${s.replace('sonnet', 'haiku')}${ctx.haiku ? `; ${ctx.haiku}` : ''}`
  if (!isSmall(s)) return null
  if (p.length > c.briefChars) return `one step per job: the brief is ${p.length} chars, at most ${c.briefChars} (workers.briefChars); split it, one job per step`
  if (c.requireJob && !jobOf(p)) return 'the first line of the brief names the job: `job: lookup|edit|run|check` (workers.requireJob)'
  const k = key(ctx)
  const hint = takeDeniedHint(k, true) // an edit worker call was denied by the permission check: said once, here or on the thread's next result
  if (hint) return hint
  const now = Date.now()
  for (const [id, sl] of slots) if (now - sl.at > c.grantTtlMin * 60_000) freeSlot(id) // a worker that never ended: its slot is not held forever
  const n = inflight.get(k) ?? 0
  if (n >= c.workers) return `at most ${c.workers} workers at once (threads.workers); wait for one to finish`
  const again = retryDenial(k, p) // (only a check: orchRan counts the try when the worker really ran)
  if (again) return again
  inflight.set(k, n + 1)
  return null
}

// a refusal after a denied worker call says what is allowed now (the hint is also said once on its own)
const fallbackNote = (ctx: OCtx): string => {
  const d = denied.get(key(ctx))
  return d && d.kind !== 'reader' && d.roots.length ? `; the worker was denied (${d.category}): your own edits in ${d.roots[0]} are allowed now, pass an absolute path inside it` : ''
}
function threadDenial(c: OrchConfig, ctx: OCtx, e: Call): string | null {
  const t = e.tool
  if (t.startsWith('mcp__lean-agent__') || /^(TodoWrite|ToolSearch|Skill|AskUserQuestion|SendMessage|Monitor|ScheduleWakeup|TaskCreate|TaskGet|TaskList|TaskStop|TaskUpdate|CronCreate|CronDelete|CronList)$/.test(t)) return null
  if (isAgentTool(e)) return agentCallDenial(c, ctx, e)
  if (t === 'Edit' || t === 'Write' || t === 'NotebookEdit') {
    const f = String(e.file_path ?? e.notebook_path ?? '')
    return f && (inLean(ctx, f) || deniedEdit(ctx, e) || selfEditOk(ctx, e)) ? null : THREAD_STEP + fallbackNote(ctx) + tried(`${t} ${pathKind(ctx, f)}`)
  }
  if (t === 'Read') {
    const f = String(e.file_path ?? '')
    if (f && inLean(ctx, f)) return null
    if (f && (deniedEdit(ctx, e) || selfEditOk(ctx, e))) return null // a path the denied call named, or a worktree the user let the thread edit itself: not counted, no limit needed
    const lim = Number(e.limit)
    if (!Number.isFinite(lim) || lim < 1 || lim > DIRECT_READ_LINES) return `${THREAD_STEP}; a direct read needs limit <= ${DIRECT_READ_LINES}${tried(`Read ${pathKind(ctx, f)}`)}`
    const k = key(ctx)
    const rd = readerDenied.get(k)
    if (rd) { rd.slices++; return null } // the fallback of a denied reader: a counted slice (<= 200 lines, checked above), not part of the per-turn cap
    const n = reads.get(k) ?? 0
    if (n >= c.directReads) return `${THREAD_STEP} (${c.directReads} direct reads per turn used)${tried(`Read ${pathKind(ctx, f)}`)}`
    reads.set(k, n + 1)
    return null
  }
  if (t === 'Grep' || t === 'Glob') {
    const p = String(e.path ?? '')
    return p && (inLean(ctx, p) || deniedEdit(ctx, e) || selfEditOk(ctx, e)) ? null : THREAD_STEP + fallbackNote(ctx) + tried(`${t} ${pathKind(ctx, p || ctx.cwd || '/')}`)
  }
  if (t === 'Bash') {
    // a forge write by shell (az / gh / curl / a script text): never, whatever else the command is (1.0.34: gh / az used to pass here as "judged by the other guards", which only judge private projects)
    const fw = forgeCommandWrite(String(e.command ?? ''))
    if (fw) return forgeRefusal() + forgeHint(String(e.command ?? '')) + tried(fw) // say what to do instead (the action kinds)
    const bad = bashBad(ctx, String(e.command ?? ''))
    if (bad && isForgeFetch(bad)) return forgeReadRefusal() + tried(triedWords(bad)) // a forge read outside the allow-list
    return bad ? BASH_STEP + bashInstead(bad) + tried(triedWords(bad)) : null
  }
  return null
}

// The engine's own tool a subagent hands its answer back with (field, 1.0.35: 61 refusals in the reviewer runs that "ended without a report":
// past call 16 the hand-back itself was counted and refused with "write the json block and answer", so the answer could never be delivered).
// It is the answer, not a tool call: never counted, never refused, whatever the budget.
export const HANDBACK_TOOL = 'SubagentHandback'
export const REVIEWER_ANSWER_NOW = 'now answer with the json block only, no more tool calls'
function workerDenial(c: OrchConfig, ctx: OCtx, e: Call): string | null {
  if (e.tool === HANDBACK_TOOL) return null
  if (isAgentTool(e)) return 'a worker never spawns workers; answer `split: <rest>` and the thread starts the next step'
  const k = ctx.agentId ?? ctx.agentType ?? '?'
  const n = (steps.get(k) ?? 0) + 1
  if (!steps.has(k) && steps.size >= MAX_TRACKED) steps.delete(steps.keys().next().value as string)
  steps.set(k, n)
  const budget = bare(ctx.agentType) === 'reviewer' ? reviewerBudget(c.steps) : stepBudget(ctx.job, c.steps, c.stepsByJob)
  const note = n <= budget ? stepNote(n, budget) : null // 75% of the budget used: the result of THIS call carries the line (takeStepNote)
  if (note) notes.set(k, note)
  else notes.delete(k)
  if (n > budget) { // the run used its whole step budget (workerruns.ts counts the share of runs that did)
    if (budgetHit.size >= MAX_TRACKED) budgetHit.delete(budgetHit.values().next().value as string)
    budgetHit.add(k)
    over.set(k, { calls: n, budget }) // for the refusal record (register.tsx takeOver): how many calls the run made, against which budget
  }
  if (n > budget && bare(ctx.agentType) === 'reviewer') return `the reviewer's budget (${budget} tool calls, REVIEWER_STEPS) is used: ${REVIEWER_ANSWER_NOW} (your reply is the json block, list what you could not check in unverified; the thread saves it)`
  return n > budget ? (ctx.job && budget < c.steps ? `step budget of a ${ctx.job} job (${budget} tool calls) is used: return what you have in the ${ctx.job} schema; the thread splits the rest` : SPLIT) : null
}

// null = allow, a string = the refusal
export function orchDecide(c: OrchConfig, ctx: OCtx, e: Call): string | null {
  if (!c.on) return null
  if (ctx.agentType || ctx.agentId) return isSmall(ctx.agentType) ? workerDenial(c, ctx, e) : bare(ctx.agentType) === 'reviewer' ? workerDenial(c, { ...ctx, job: 'check' }, e) : null // the reviewer has its own budget (REVIEWER_STEPS, jobs.ts: 16 tool calls) so it cannot explore
  if (ctx.kind === 'desk') return isAgentTool(e) ? DESK_ROUTE : null
  if (ctx.kind === 'thread') return threadDenial(c, ctx, e)
  return null
}

// the Agent call RAN a worker (a real result came back, or a background launch was accepted): one try of this brief is used.
// A call our guard denied, the permission check or the classifier rejected, or that errored before a worker started never gets here.
export function orchRan(ctx: OCtx, e: Call): void {
  if (!isAgentTool(e) || ctx.agentType || ctx.agentId || ctx.kind !== 'thread' || !isSmall(typeof e.subagent_type === 'string' ? e.subagent_type : '')) return
  retryRan(key(ctx), String(e.prompt ?? e.description ?? ''))
}

// after a worker Agent call returned (allowed earlier by orchDecide): its slot is free again. A background launch ("Async agent launched",
// the subagent id in the result) has only started the worker: the slot is held until the subagent ends (orchAgentEnd).
export function orchEnd(ctx: OCtx, e: Call, launch?: { async: boolean; agentId?: string }): void {
  if (!isAgentTool(e) || ctx.agentType || ctx.agentId || ctx.kind !== 'thread' || !isSmall(typeof e.subagent_type === 'string' ? e.subagent_type : '')) return
  const k = key(ctx)
  if (launch?.async && launch.agentId && !stopped.delete(launch.agentId)) {
    slots.set(launch.agentId, { key: k, at: Date.now(), type: bare(typeof e.subagent_type === 'string' ? e.subagent_type : '') })
    return
  }
  inflight.set(k, Math.max(0, (inflight.get(k) ?? 0) - 1))
}
function freeSlot(id: string): void {
  const sl = slots.get(id)
  if (!sl) return
  slots.delete(id)
  inflight.set(sl.key, Math.max(0, (inflight.get(sl.key) ?? 0) - 1))
}
// an Agent call's result that only LAUNCHED a background subagent: `status: "async_launched"` with `agentId` (the engine's result record), or
// the text "Async agent launched ... agentId: <id>". The subagent is still running; its life ends at classic.SubagentStop.
export function launchOf(r: any, text: string): { async: boolean; agentId?: string } {
  const o = [r?.result, r?.result?.data, r?.data, r].find(x => x && typeof x === 'object' && x.status === 'async_launched')
  const async = !!o || /async agent launched/i.test(text)
  const id = typeof o?.agentId === 'string' ? o.agentId : /agentId:?\s*["']?([A-Za-z0-9_-]+)/i.exec(text)?.[1]
  return { async, ...(async && id ? { agentId: id } : {}) }
}
// the subagent ended (classic.SubagentStop): its slot and its step count are released
export function orchAgentEnd(agentId: string): void {
  steps.delete(agentId)
  over.delete(agentId)
  notes.delete(agentId)
  if (slots.has(agentId)) freeSlot(agentId)
  else {
    if (stopped.size >= MAX_TRACKED) stopped.delete(stopped.values().next().value as string)
    stopped.add(agentId)
  }
}

// ---- a delegation the permission check denied ----------------------------------------------------------------------------------
// Our guard is a token policy, not a safety boundary: it must never turn a permission denial (the auto mode classifier, a rule) of the
// thread's worker Agent call into a dead end. When the engine reports the denial (classic.PermissionDenied, or a failed Agent result that
// says so), the thread's OWN Edit/Write on the paths that call named in its brief (and its own small reads there) are allowed for the
// rest of the session; the engine's own permission check still judges each of those edits itself. Nothing here changes a permission.
export const DELEGATION_DENIED = 'the permission check denied the worker call: do this one step yourself (your own edit is allowed here now), then carry on'
type DeniedRec = { roots: string[]; told: boolean; category: string; kind: 'worker' | 'reader' | 'other'; broad: string }
const denied = new Map<string, DeniedRec>() // thread key -> roots of the denied worker call(s), said once
// roots: the thread's registered worktrees + the worktree folders and absolute paths the brief named (denial.ts worktreeRoots / pathsOf). A denied READER
// (kind reader) allows nothing by itself: the thread gets the category and the retry advice only (denial.ts READER_RETRY).
export function noteDelegationDenied(threadKey: string, roots: string[], info: { category?: string; kind?: 'worker' | 'reader' | 'other'; broad?: string } = {}): boolean {
  const kind = info.kind ?? 'worker'
  const abs = kind === 'reader' ? [] : roots.map(r => normPath(r)).filter(r => r !== '/')
  const cur = denied.get(threadKey)
  const had = cur?.roots ?? []
  const next = [...new Set([...had, ...abs])].slice(-12)
  if (!abs.length && !cur && kind !== 'reader' && !info.category) return false
  denied.set(threadKey, { roots: next, told: false, category: info.category ?? cur?.category ?? 'unspecified', kind, broad: info.broad ?? '' })
  return next.length > 0
}
export const delegationDenied = (threadKey: string): boolean => denied.has(threadKey)
// ---- a READER the permission check denied (1.0.26) -----------------------------------------------------------------------------------
// A denied reader (a lookup job) is no reason to read everything oneself: the thread hears the engine's own reason category, retries ONCE with a
// narrower brief, and when that is denied too reads only in slices of at most 200 lines, each finding written to scratch/notes.md at once. Those
// fallback reads are not capped per turn (a denied lookup has to be read by someone) but they are counted; after READER_SLICES_WARN of them in a
// session the next one carries "you are reading a long source yourself". Nothing here changes a permission.
export const READER_SLICES_WARN = 10
const readerDenied = new Map<string, { category: string; told: boolean; slices: number; said: boolean }>()
// the reason category as the engine printed it: the `[Category]` of the denial text, else its first words
export function readerCategory(reason: unknown): string {
  const t = String(reason ?? '').replace(/\s+/g, ' ').trim()
  const m = /\[([^\]]{2,60})\]/.exec(t)
  return (m ? m[1]! : t.slice(0, 80)) || 'no reason given'
}
export function noteReaderDenied(threadKey: string, category: string): void {
  const cur = readerDenied.get(threadKey)
  readerDenied.set(threadKey, { category, told: false, slices: cur?.slices ?? 0, said: cur?.said ?? false })
}
export const readerDeniedHint = (category: string, broad = ''): string => threadHint({ category, kind: 'reader', broad })
export const SLICES_NOTE = 'you are reading a long source yourself: this is the most expensive way; split the task (report to the desk)'
export const readerFallbackReads = (threadKey: string): number => readerDenied.get(threadKey)?.slices ?? 0
// said once, on the result of the first slice past the limit
export function takeSliceNote(threadKey: string): string | null {
  const r = readerDenied.get(threadKey)
  if (!r || r.said || r.slices <= READER_SLICES_WARN) return null
  r.said = true
  return SLICES_NOTE
}

export const deniedRoots = (threadKey: string): string[] => denied.get(threadKey)?.roots ?? []
export const clearDenied = (): void => { denied.clear(); readerDenied.clear() } // a fresh session starts clean
// said once: the next refusal of a worker call (an edit worker: do the step yourself), or else the next tool result of the thread. The reader's
// hint is for the tool result only: the retry it asks for must not be refused with it.
export function takeDeniedHint(threadKey: string, refusal = false): string | null {
  const r = readerDenied.get(threadKey)
  const d = denied.get(threadKey)
  if (d?.kind === 'reader' && refusal) return null
  if (!refusal && r && !r.told) {
    r.told = true
    if (d) d.told = true
    return readerDeniedHint(r.category, d?.broad)
  }
  if (d?.kind === 'reader' && r) return null // the reader's hint is the one above
  if (!d || d.told) return null
  d.told = true
  return threadHint({ category: d.category, kind: d.kind, worktree: d.roots[0], broad: d.broad })
}
const protectedLean = (ctx: OCtx, abs: string): boolean => {
  const lean = `${ctx.home}/.lean-agent`
  return under(abs, lean) && !under(abs, `${lean}/worktrees`) // lean state is never opened by a fallback or a grant; a worktree under it is the work (1.0.18 listed worktrees/ as protected, so a denied worker's own worktree could never be edited: the deadlock)
}
const inDenied = (ctx: OCtx, abs: string): boolean => {
  const d = denied.get(key(ctx))
  return !!d && d.roots.some(r => under(abs, r)) && !protectedLean(ctx, abs) // never its own settings, grants or review records, nor any other lean state
}
const inSelfEdit = (ctx: OCtx, abs: string): boolean => (ctx.selfEdit ?? []).some(r => under(abs, r)) && !protectedLean(ctx, abs)
const FALLBACK_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Read', 'Grep', 'Glob'])
const pathOf = (e: Call): string => String(e.file_path ?? e.notebook_path ?? e.path ?? '')
// the thread's own edit / read / search of a path the denied worker call named (or of its worktrees): the guard's fallback
export function deniedEdit(ctx: OCtx, e: Call): boolean {
  if (ctx.kind !== 'thread' || ctx.agentId || ctx.agentType || !FALLBACK_TOOLS.has(e.tool)) return false
  const f = pathOf(e)
  return !!f && inDenied(ctx, normPath(f, ctx.cwd))
}
// the thread's own work inside a worktree the USER let it edit itself (selfedit.ts grant, verified before the call: ctx.selfEdit)
export function selfEditOk(ctx: OCtx, e: Call): boolean {
  if (ctx.kind !== 'thread' || ctx.agentId || ctx.agentType || !FALLBACK_TOOLS.has(e.tool)) return false
  const f = pathOf(e)
  return !!f && inSelfEdit(ctx, normPath(f, ctx.cwd))
}
// which fallback let this call through (for the refusal record: `self-edit-grant` / `delegation-denied`); null: neither was needed
export function fallbackUsed(ctx: OCtx, e: Call): 'self-edit-grant' | 'delegation-denied' | null {
  if (!isThreadOwn(ctx) || !FALLBACK_TOOLS.has(e.tool)) return null
  const f = pathOf(e)
  if (!f) return null
  const abs = normPath(f, ctx.cwd)
  if (inLean(ctx, abs)) return null
  return inSelfEdit(ctx, abs) ? 'self-edit-grant' : inDenied(ctx, abs) ? 'delegation-denied' : null
}
const isThreadOwn = (ctx: OCtx): boolean => ctx.kind === 'thread' && !ctx.agentId && !ctx.agentType
export const deniedCategory = (threadKey: string): string => denied.get(threadKey)?.category ?? ''
