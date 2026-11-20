// Execution model (config lean.orchestrate, default on): the desk only routes, a thread only orchestrates, every read/search/edit is one
// small step for a haiku worker. Enforced here by the guard (guard.ts calls orchDecide), not by text a model has to remember.
// Pure rules over a call plus a little in-memory state (per-turn direct reads, workers in flight, per-worker step counts).
import { plainPipeline } from './shell'
import { jobOf, retryDenial, retryReset, stepBudget } from './jobs'
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'

export type OrchConfig = { on: boolean; deskChars: number; agentChars: number; directReads: number; workers: number; briefChars: number; steps: number; stepsByJob: Partial<Record<string, number>>; requireJob: boolean }
export type OCtx = { kind: 'desk' | 'thread' | 'other'; agentType?: string; agentId?: string; job?: string; home: string; threadDir?: string; cwd?: string }
export type Call = { tool: string; [k: string]: any }

export const DESK_ROUTE = 'the desk routes: start or ask a thread (lean_thread new / send)'
export const THREAD_STEP = 'one step for a small worker: lean-agent:worker-haiku (allow-edit: <path>) / lean-agent:reader-haiku'
export const SPLIT = 'return what you have; the thread splits the rest'
export const DEFAULTS: OrchConfig = { on: true, deskChars: 6000, agentChars: 6000, directReads: 3, workers: 4, briefChars: 1500, steps: 15, stepsByJob: {}, requireJob: false }
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
const MAX_TRACKED = 500
export const orchTurnStart = (key: string): void => void reads.delete(key)
export function orchReset(): void {
  reads.clear()
  inflight.clear()
  steps.clear()
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
const inLean = (ctx: OCtx, p: string) => under(normPath(p, ctx.cwd), `${ctx.home}/.lean-agent`)

const GIT_OK = new Set(['status', 'log', 'add', 'commit', 'worktree', 'branch', 'rev-parse', 'remote', 'push', 'fetch', 'switch', 'show', 'diff'])
const DIFF_OK = /^--(stat|shortstat|numstat|name-only|name-status)(=.*)?$/
const OTHER_CLI = new Set(['lean-agent', 'claude', 'gh', 'az']) // the other guards judge these
const LIST = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'find', 'mkdir'])
const SEARCH = new Set(['grep', 'rg'])

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

function bashSegOk(ctx: OCtx, w: string[]): boolean {
  const c = w[0]
  if (!c) return false
  if (OTHER_CLI.has(c)) return true
  if (c === 'git') {
    const g = gitSub(w)
    if (!g || !GIT_OK.has(g.sub)) return false
    return g.sub !== 'diff' || g.rest.some(a => DIFF_OK.test(a))
  }
  if (c === 'echo' || c === 'pwd') return true
  const operands = w.slice(1).filter(a => !a.startsWith('-'))
  if (SEARCH.has(c)) return operands.length >= 2 && operands.slice(1).every(a => a.startsWith('/') && inLean(ctx, a))
  if (LIST.has(c)) return operands.length >= 1 && operands.every(a => a.startsWith('/') && inLean(ctx, a))
  return false
}

export function bashOk(ctx: OCtx, command: string): boolean {
  const parts = command.split(/\s*&&\s*/).filter(p => p.trim())
  if (!parts.length) return false
  for (const p of parts) {
    const segs = plainPipeline(p.trim())
    if (!segs || !segs.length || !segs.every(w => bashSegOk(ctx, w))) return false
  }
  return true
}

// ---- the rules -------------------------------------------------------------------------------------------------------------
function agentCallDenial(c: OrchConfig, ctx: OCtx, e: Call): string | null {
  if (isSmall(ctx.agentType)) return 'a worker never spawns workers; answer `split: <rest>` and the thread starts the next step'
  const s = bare(typeof e.subagent_type === 'string' ? e.subagent_type : '')
  const p = String(e.prompt ?? e.description ?? '')
  if ((s === 'worker-sonnet' || s === 'reader-sonnet') && !/^\s*why-sonnet:\s*\S/m.test(p)) return `haiku by default: add a prompt line \`why-sonnet: <reason>\` or use lean-agent:${s.replace('sonnet', 'haiku')}`
  if (!isSmall(s)) return null
  if (p.length > c.briefChars) return `one step per job: the brief is ${p.length} chars, at most ${c.briefChars} (workers.briefChars); split it, one job per step`
  if (c.requireJob && !jobOf(p)) return 'the first line of the brief names the job: `job: lookup|edit|run|check` (workers.requireJob)'
  const k = key(ctx)
  const n = inflight.get(k) ?? 0
  if (n >= c.workers) return `at most ${c.workers} workers at once (threads.workers); wait for one to finish`
  const again = retryDenial(k, p) // (counted only when nothing else refused it)
  if (again) return again
  inflight.set(k, n + 1)
  return null
}

function threadDenial(c: OrchConfig, ctx: OCtx, e: Call): string | null {
  const t = e.tool
  if (t.startsWith('mcp__lean-agent__') || /^(TodoWrite|ToolSearch|Skill|AskUserQuestion|SendMessage|Monitor|ScheduleWakeup|TaskCreate|TaskGet|TaskList|TaskStop|TaskUpdate|CronCreate|CronDelete|CronList)$/.test(t)) return null
  if (isAgentTool(e)) return agentCallDenial(c, ctx, e)
  if (t === 'Edit' || t === 'Write' || t === 'NotebookEdit') {
    const f = String(e.file_path ?? e.notebook_path ?? '')
    return f && inLean(ctx, f) ? null : THREAD_STEP
  }
  if (t === 'Read') {
    const f = String(e.file_path ?? '')
    if (f && inLean(ctx, f)) return null
    const lim = Number(e.limit)
    if (!Number.isFinite(lim) || lim < 1 || lim > DIRECT_READ_LINES) return `${THREAD_STEP}; a direct read needs limit <= ${DIRECT_READ_LINES}`
    const k = key(ctx)
    const n = reads.get(k) ?? 0
    if (n >= c.directReads) return `${THREAD_STEP} (${c.directReads} direct reads per turn used)`
    reads.set(k, n + 1)
    return null
  }
  if (t === 'Grep' || t === 'Glob') {
    const p = String(e.path ?? '')
    return p && inLean(ctx, p) ? null : THREAD_STEP
  }
  if (t === 'Bash') return bashOk(ctx, String(e.command ?? '')) ? null : 'run tests and builds with lean_run, or give the step to lean-agent:worker-haiku (allow-edit: <path>) / lean-agent:reader-haiku'
  return null
}

function workerDenial(c: OrchConfig, ctx: OCtx, e: Call): string | null {
  if (isAgentTool(e)) return 'a worker never spawns workers; answer `split: <rest>` and the thread starts the next step'
  const k = ctx.agentId ?? ctx.agentType ?? '?'
  const n = (steps.get(k) ?? 0) + 1
  if (!steps.has(k) && steps.size >= MAX_TRACKED) steps.delete(steps.keys().next().value as string)
  steps.set(k, n)
  const budget = stepBudget(ctx.job, c.steps, c.stepsByJob)
  return n > budget ? (ctx.job && budget < c.steps ? `step budget of a ${ctx.job} job (${budget} tool calls) is used: return what you have in the ${ctx.job} schema; the thread splits the rest` : SPLIT) : null
}

// null = allow, a string = the refusal
export function orchDecide(c: OrchConfig, ctx: OCtx, e: Call): string | null {
  if (!c.on) return null
  if (ctx.agentType || ctx.agentId) return isSmall(ctx.agentType) ? workerDenial(c, ctx, e) : null
  if (ctx.kind === 'desk') return isAgentTool(e) ? DESK_ROUTE : null
  if (ctx.kind === 'thread') return threadDenial(c, ctx, e)
  return null
}

// after a worker Agent call finished (allowed earlier by orchDecide): one slot is free again
export function orchEnd(ctx: OCtx, e: Call): void {
  if (!isAgentTool(e) || ctx.agentType || ctx.agentId || ctx.kind !== 'thread' || !isSmall(typeof e.subagent_type === 'string' ? e.subagent_type : '')) return
  const k = key(ctx)
  inflight.set(k, Math.max(0, (inflight.get(k) ?? 0) - 1))
}
