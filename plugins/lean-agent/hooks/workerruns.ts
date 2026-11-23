// Worker runs, by tier and job. The ledger has one row per model request with the agent type and agent id but no job; the thread's Agent call knows the
// job (`job: edit` on the brief) and whether it was a second try of the same brief (the retry rule) or hit the step budget. So the mod writes ONE record per
// worker Agent call to runs.jsonl (agent type, job, agent id, retry, budget, ok) and `lean_doctor stats` joins it with the ledger by agent id:
// runs, requests, cost, cost per run, retry and budget shares per (agent type, job); the thread's own session; and what the edit runs on sonnet would
// have cost on haiku (the same tokens at haiku's list prices, never a guess). The haiku record of a project's job type feeds the why-sonnet refusal.
import { appendJsonl, homeDir, leanDir } from './state'
import type { Host } from './state'
import { costUsd } from './budget'
import { fileSize, normalizeRow, readFrom } from './ledger'
import type { Norm } from './ledger'
import { ledgerTail } from './reviewcost'
import { hitBudget } from './orchestrate'

export const RUNS = 'runs.jsonl'
const TAIL_BYTES = 2_000_000
export type Run = { ts: number; tN: string; project: string; agent: string; job: string; agentId?: string; retry: boolean; budget: boolean; ok: boolean }

const bare = (a: string) => a.replace(/^lean-agent:/, '')
// the agent id the engine names in an Agent result ("agentId: a1b2c3 (use SendMessage ...)"), else undefined
export const agentIdIn = (text: string): string | undefined => /agentId:?\s*["']?([A-Za-z0-9_-]{4,})/i.exec(text)?.[1]

// did the run succeed? A `result: fail`, a LEAN-FEEDBACK status of partial or failed, or a step budget that was used up says no
export function runOk(text: string, job: string, budget: boolean): boolean {
  if (budget) return false
  if (/"status"\s*:\s*"(partial|failed)"/.test(text)) return false
  if (job !== 'lookup' && /^\s*result\s*:\s*fail\b/im.test(text)) return false
  return true
}

// the thread's foreground Agent call to a worker returned: one record. `retried`: this brief already ran before (the retry rule's count was >= 1).
// A worker that started in the background is not recorded (its outcome is not in this call's result).
export async function recordWorkerCall(h: Host, a: { thread: string; project: string; agent: string; job: string | null; text: string; retried: boolean }): Promise<void> {
  const agentId = agentIdIn(a.text)
  const budget = hitBudget(agentId) || /step budget of a \w+ job \(\d+ tool calls\) is used/i.test(a.text)
  const job = a.job ?? 'none'
  await noteRun(h, { ts: await h.clock.now(), tN: a.thread, project: a.project, agent: a.agent, job, ...(agentId ? { agentId } : {}), retry: a.retried, budget, ok: runOk(a.text, job, budget) }).catch(() => undefined)
}
export async function noteRun(h: Host, run: Run): Promise<void> {
  await appendJsonl(h, `${leanDir(await homeDir(h))}/${RUNS}`, { ...run, agent: bare(run.agent) })
}
export async function readRuns(h: Host, since = 0): Promise<Run[]> {
  const file = `${leanDir(await homeDir(h))}/${RUNS}`
  const size = await fileSize(h, file)
  if (size === null) return []
  const out: Run[] = []
  for (const l of (await readFrom(h, file, Math.max(0, size - TAIL_BYTES)).catch(() => '')).split('\n')) {
    if (!l.trim()) continue
    try {
      const r = JSON.parse(l)
      if (r && typeof r.ts === 'number' && r.ts >= since && typeof r.agent === 'string' && typeof r.job === 'string') out.push({ ts: r.ts, tN: String(r.tN ?? ''), project: String(r.project ?? ''), agent: bare(r.agent), job: r.job, ...(typeof r.agentId === 'string' && r.agentId ? { agentId: r.agentId } : {}), retry: r.retry === true, budget: r.budget === true, ok: r.ok !== false })
    } catch {
      /* a cut first line of the tail */
    }
  }
  return out
}

// ---- haiku first, measured (the why-sonnet refusal) -------------------------------------------------------------------------------
export const HAIKU_MIN_OK = 5
export const HAIKU_MIN_RATE = 0.8
// "haiku succeeded 6 of 7 times on edit here", or '' when this project has no such record (at least 5 successful haiku runs of the job and >= 80%)
export function haikuRecordText(runs: Run[], project: string, job: string): string {
  const mine = runs.filter(r => r.agent === 'worker-haiku' && r.job === job && r.project === project)
  const ok = mine.filter(r => r.ok).length
  return ok >= HAIKU_MIN_OK && ok / mine.length >= HAIKU_MIN_RATE ? `haiku succeeded ${ok} of ${mine.length} times on ${job} here: try haiku with a narrower brief first` : ''
}
export async function haikuRecord(h: Host, project: string, job: string): Promise<string> {
  try {
    return haikuRecordText(await readRuns(h), project, job)
  } catch {
    return ''
  }
}

// ---- the stats section ---------------------------------------------------------------------------------------------------------------
const usd = (n: number) => `$${n.toFixed(2)}`
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '0%')
type Tot = { usd: number; req: number; in: number; out: number; cr: number; cw: number }
const emptyTot = (): Tot => ({ usd: 0, req: 0, in: 0, out: 0, cr: 0, cw: 0 })
const addRow = (t: Tot, r: Norm) => {
  t.usd += r.usd
  t.req++
  t.in += r.in
  t.out += r.out
  t.cr += r.cr
  t.cw += r.cw
}

// rows: the ledger rows of the window (any role); runs: the run records of the window. Pure: the specs feed a synthetic ledger.
export function tierJobLines(runs: Run[], rows: Norm[], days: number): string[] {
  const byId = new Map<string, Tot>()
  const mainBy = new Map<string, Tot>()
  const reviewers = new Map<string, Tot>()
  for (const r of rows) {
    if (r.role !== 'thread') continue
    if (r.agent === 'main') addRow(mainBy.get(r.tN) ?? mainBy.set(r.tN, emptyTot()).get(r.tN)!, r)
    const id = (r as Norm & { agentId?: string }).agentId
    if (!id) continue
    addRow(byId.get(id) ?? byId.set(id, emptyTot()).get(id)!, r)
    if (r.agent === 'reviewer') addRow(reviewers.get(id) ?? reviewers.set(id, emptyTot()).get(id)!, r)
  }
  const out: string[] = []
  type G = { runs: number; costed: number; retry: number; budget: number; tot: Tot }
  const groups = new Map<string, G>()
  for (const r of runs) {
    const k = `${r.agent} · ${r.job}`
    const g = groups.get(k) ?? groups.set(k, { runs: 0, costed: 0, retry: 0, budget: 0, tot: emptyTot() }).get(k)!
    g.runs++
    if (r.retry) g.retry++
    if (r.budget) g.budget++
    const t = r.agentId ? byId.get(r.agentId) : undefined
    if (t) {
      g.costed++
      g.tot.usd += t.usd
      g.tot.req += t.req
    }
  }
  if (reviewers.size) {
    const g = { runs: reviewers.size, costed: reviewers.size, retry: 0, budget: 0, tot: emptyTot() }
    for (const t of reviewers.values()) {
      g.tot.usd += t.usd
      g.tot.req += t.req
    }
    groups.set('reviewer · check', g)
  }
  out.push(`by worker tier and job (${days}d; runs of the thread's Agent calls joined with the ledger by agent id)`)
  if (!groups.size) out.push('  no worker run recorded yet (runs.jsonl is written from 1.0.27 on)')
  for (const [k, g] of [...groups].sort((a, b) => b[1].tot.usd - a[1].tot.usd)) {
    const per = g.costed ? `${usd(g.tot.usd / g.costed)}/run` : 'cost unknown'
    const retry = k.startsWith('reviewer') ? '' : ` · second try ${pct(g.retry, g.runs)} · step budget hit ${pct(g.budget, g.runs)}`
    out.push(`  ${k}: ${g.runs} run${g.runs === 1 ? '' : 's'} · ${g.tot.req} req · ${usd(g.tot.usd)} · ${per}${retry}${g.costed < g.runs ? ` (cost known for ${g.costed} of ${g.runs})` : ''}`)
  }
  // thread main session: requests, average context per request (input + cache read + cache write), cost
  const mains = [...mainBy].filter(([id]) => /^t\d+$/.test(id)).sort((a, b) => b[1].usd - a[1].usd)
  if (mains.length) {
    out.push('thread main session (requests · avg context · cost):')
    for (const [id, t] of mains.slice(0, 8)) out.push(`  ${id}: ${t.req} requests · avg context ${Math.round((t.in + t.cr + t.cw) / Math.max(1, t.req) / 1000)}k · ${usd(t.usd)}`)
  }
  // the same edit runs on haiku: the same tokens at haiku's list prices
  const sonnetEdit = runs.filter(r => r.agent === 'worker-sonnet' && r.job === 'edit' && r.agentId && byId.has(r.agentId))
  if (sonnetEdit.length) {
    let x = 0
    let y = 0
    for (const r of sonnetEdit) {
      const t = byId.get(r.agentId!)!
      x += t.usd
      y += costUsd('haiku', { input_tokens: t.in, output_tokens: t.out, cache_read_input_tokens: t.cr, cache_creation_input_tokens: t.cw })
    }
    const okEdit = runs.filter(r => r.job === 'edit' && r.ok)
    out.push(`${sonnetEdit.length} edit run${sonnetEdit.length === 1 ? '' : 's'} on sonnet cost ${usd(x)}; the same on haiku would be about ${usd(y)} (haiku share of successful edit runs: ${pct(okEdit.filter(r => r.agent === 'worker-haiku').length, okEdit.length)})`)
  }
  return out
}

export async function tierJobSection(h: Host, now: number, days: number): Promise<string[]> {
  const since = now - days * 86_400_000
  const rows: Norm[] = []
  for (const l of (await ledgerTail(h).catch(() => '')).split('\n')) {
    if (!l.includes('"tN"')) continue
    try {
      const o = JSON.parse(l)
      const r = normalizeRow(o)
      if (r && r.ts >= since) rows.push(typeof o.agentId === 'string' && o.agentId ? ({ ...r, agentId: o.agentId } as Norm) : r)
    } catch {
      /* a cut or damaged line */
    }
  }
  const lines = tierJobLines(await readRuns(h, since), rows, days)
  return lines.length === 2 && lines[1]!.includes('no worker run recorded') ? [] : lines // nothing to say: no section
}
