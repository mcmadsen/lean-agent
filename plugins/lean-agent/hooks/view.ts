// The desk pane's data (design 2.5): read straight from the files, never throws; every failure becomes a line in `errors`.
import { homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { deskState, unconsumed } from './delivery'
import type { DeskRec } from './delivery'
import { openQuestions } from './extras'
import { readNotices } from './notices'
import { spentToday } from './budget'
import { isRunning, parseAgents } from './threads'
import type { Thread } from './threads'

export type GoalTone = 'working' | 'waiting' | 'stuck' | 'quiet'
export type GoalRow = { id: string; text: string; ts: number; tone: GoalTone }
export type AnswerRow = { n: number; rec: DeskRec; unread: boolean }
export type ThreadRow = { id: string; title: string; model?: string; effort?: string; state: string; run: 'running' | 'idle' | 'parked'; last: string; resumable: boolean }
import { listProjects } from './projects'
import type { ProjectRow } from './projects'
import { scriptCounts } from './scripts'
export type View = { scripts: { candidates: number; adopted: number }; projects: ProjectRow[]; goals: GoalRow[]; answers: AnswerRow[]; openQuestions: { q: number; from?: string; question?: string }[]; unread: number; total: number; threads: ThreadRow[]; budget: string; errors: string[] }

import { STALE_MS } from './chaser'
export { STALE_MS }
const ID = /^t\d+$/

const lastLine = (t: string) => t.split('\n').map(s => s.trim()).filter(Boolean).pop() ?? ''

// The pane refreshes every 5 s: `claude agents` and the whole-ledger sum are cached for a while (a pressed button
// drops the cache so its result shows at once).
const AGENTS_TTL = 10_000
const BUDGET_TTL = 60_000
let agentsCache: { at: number; out: { exitCode: number; stdout: string } } | null = null
let budgetCache: { at: number; text: string | null } | null = null
export const resetViewCache = () => {
  agentsCache = null
  budgetCache = null
}

// USD spent today from ledger.jsonl (rows carry usd, not tokens); null when there is no ledger.
async function loadBudget(h: Host, home: string): Promise<string | null> {
  const now = await h.clock.now()
  if (budgetCache && now - budgetCache.at < BUDGET_TTL && now >= budgetCache.at) return budgetCache.text
  const text = (await h.fs.exists(`${leanDir(home)}/ledger.jsonl`)) ? `$${(await spentToday(h)).toFixed(2)}` : null
  budgetCache = { at: now, text }
  return text
}

// The pane's own read marker (never the desk's inbox-read.json): rows below `upTo` plus single acked rows.
type PaneAck = { upTo: number; ns: number[] }
const paneAckFile = (home: string) => `${deskState(home)}/pane-ack.json`
async function paneAck(h: Host, home: string): Promise<PaneAck> {
  const a = await readJson<Partial<PaneAck>>(h, paneAckFile(home), {})
  return { upTo: Number(a.upTo) || 0, ns: Array.isArray(a.ns) ? a.ns.filter(x => Number.isInteger(x)) : [] }
}

export async function loadView(h: Host): Promise<View> {
  const v: View = { scripts: { candidates: 0, adopted: 0 }, projects: [], goals: [], answers: [], openQuestions: [], unread: 0, total: 0, threads: [], budget: 'n/a', errors: [] }
  const guard = async (what: string, f: () => Promise<void>) => {
    try {
      await f()
    } catch (e) {
      v.errors.push(`${what}: ${String((e as Error)?.message ?? e).slice(0, 160)}`)
    }
  }
  let home = ''
  await guard('home', async () => {
    home = await homeDir(h)
  })
  if (!home) return v
  await guard('projects', async () => {
    v.projects = (await listProjects(h)).rows
  })
  await guard('scripts', async () => {
    v.scripts = await scriptCounts(h)
  })
  const now = await h.clock.now().catch(() => Date.now())
  const recs: DeskRec[] = []
  let read = 0
  await guard('answers', async () => {
    recs.push(...(await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)))
    read = (await readJson<{ n: number }>(h, `${deskState(home)}/inbox-read.json`, { n: 0 })).n || 0
    v.total = recs.length
    const pa = await paneAck(h, home)
    const isUnread = (n: number) => n >= pa.upTo && !pa.ns.includes(n)
    v.unread = recs.filter((_, n) => isUnread(n)).length
    v.answers = recs
      .map((rec, n) => ({ n, rec, unread: isUnread(n) }))
      .sort((a, b) => Number(b.unread) - Number(a.unread) || b.n - a.n)
      .slice(0, 30)
  })
  await guard('questions', async () => { v.openQuestions = await openQuestions(h) })
  const rows = new Map<string, { run: boolean }>()
  let agentsOk = true
  await guard('agents', async () => {
    const t = await h.clock.now()
    let r: { exitCode: number; stdout: string }
    if (agentsCache && t - agentsCache.at < AGENTS_TTL && t >= agentsCache.at) r = agentsCache.out
    else {
      r = await h.process.run(['claude', 'agents', '--json', '--all'])
      if (r.exitCode === 0) agentsCache = { at: t, out: r }
    }
    if (r.exitCode !== 0) {
      agentsOk = false
      throw new Error(`claude agents exited ${r.exitCode}`)
    }
    for (const a of parseAgents(r.stdout)) rows.set(a.sid, { run: isRunning(a) })
  })
  const asking = new Set<string>()
  const owner = new Map<string, string>() // tN -> last record text
  for (const r of recs.slice(read)) if (r.kind === 'ask') asking.add(r.from)
  for (const r of recs) owner.set(r.from, r.text)
  await guard('threads', async () => {
    let ents: { name: string }[] = []
    try {
      ents = await h.fs.list(threadsDir(home))
    } catch {
      /* no threads yet */
    }
    for (const e of ents.filter(x => ID.test(x.name)).sort((a, b) => Number(b.name.slice(1)) - Number(a.name.slice(1)))) {
      const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
      if (!t || t.state === 'closed') continue
      const running = !!t.sid && !!rows.get(t.sid)?.run
      const notes = (await h.fs.read(`${threadsDir(home)}/${e.name}/notes.md`).catch(() => '')) as string
      v.threads.push({
        id: t.id,
        title: t.title,
        model: t.model,
        effort: t.effort,
        state: t.state,
        run: t.state === 'parked' ? 'parked' : running ? 'running' : 'idle',
        last: lastLine(typeof notes === 'string' ? notes : '') || owner.get(t.id) || '',
        resumable: t.state === 'open' && !running && agentsOk,
      })
    }
  })
  await guard('goals', async () => {
    const goals = await readJson<Record<string, { text: string; ts: number }>>(h, `${leanDir(home)}/goals.json`, {})
    const live = new Set(v.threads.filter(t => t.run === 'running').map(t => t.id))
    for (const [id, g] of Object.entries(goals)) {
      if (!g || typeof g.text !== 'string') continue
      const tone: GoalTone = asking.has(id) ? 'waiting' : live.has(id) ? 'working' : now - (g.ts || 0) > STALE_MS ? 'stuck' : 'quiet'
      v.goals.push({ id, text: g.text, ts: g.ts || 0, tone })
    }
    v.goals.sort((a, b) => b.ts - a.ts)
  })
  await guard('budget', async () => {
    v.budget = (await loadBudget(h, home)) ?? 'n/a'
  })
  v.errors.push(...(await readNotices(h)))
  return v
}

// Pane ack: one row (its index) or all; moves only the pane's marker, so the desk's delivery is unaffected.
export async function ackRows(h: Host, which: number | 'all'): Promise<void> {
  const home = await homeDir(h)
  const total = (await readJsonl(h, `${deskState(home)}/inbox.jsonl`)).length
  const a = await paneAck(h, home)
  if (which === 'all') await writeJson(h, paneAckFile(home), { upTo: total, ns: [] } satisfies PaneAck)
  else if (Number.isInteger(which) && which >= 0 && which < total && !a.ns.includes(which)) await writeJson(h, paneAckFile(home), { upTo: a.upTo, ns: [...a.ns, which] } satisfies PaneAck)
}

// A thread's status line: its id, today's budget, lines in its inbox it has not seen.
export async function threadStatus(h: Host, id: string): Promise<string> {
  const home = await homeDir(h)
  const n = (await unconsumed(h, home, id)).msgs.length
  const b = (await loadBudget(h, home)) ?? 'budget n/a'
  const notes = (await readNotices(h)).length
  return `${id} · ${b} · ${n} unread${notes ? ` · ⚠ ${notes} notice${notes > 1 ? 's' : ''} (see the desk pane)` : ''}`
}
