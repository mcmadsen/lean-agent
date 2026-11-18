// The desk pane's data (design 2.5): read straight from the files, never throws; every failure becomes a line in `errors`.
import { homeDir, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskState, markRead, unreadReports, unconsumed } from './delivery'
import type { DeskRec } from './delivery'
import { isRunning, parseAgents } from './threads'
import type { Thread } from './threads'

export type GoalTone = 'working' | 'waiting' | 'stuck' | 'quiet'
export type GoalRow = { id: string; text: string; ts: number; tone: GoalTone }
export type AnswerRow = { n: number; rec: DeskRec; unread: boolean }
export type ThreadRow = { id: string; title: string; state: string; run: 'running' | 'idle' | 'parked'; last: string; resumable: boolean }
export type View = { goals: GoalRow[]; answers: AnswerRow[]; unread: number; total: number; threads: ThreadRow[]; budget: string; errors: string[] }

import { STALE_MS } from './chaser'
export { STALE_MS }
const ID = /^t\d+$/

const lastLine = (t: string) => t.split('\n').map(s => s.trim()).filter(Boolean).pop() ?? ''

// Tokens spent today from ledger.jsonl (written by the budget package); null when there is no ledger.
async function loadBudget(h: Host, home: string): Promise<string | null> {
  const rows = await readJsonl<{ ts: number; tokens?: number }>(h, `${leanDir(home)}/ledger.jsonl`)
  if (!rows.length) return null
  const day = new Date(await h.clock.now()).toISOString().slice(0, 10)
  return `${rows.filter(r => new Date(r.ts).toISOString().slice(0, 10) === day).reduce((s, r) => s + (r.tokens || 0), 0)} tokens`
}

export async function loadView(h: Host): Promise<View> {
  const v: View = { goals: [], answers: [], unread: 0, total: 0, threads: [], budget: 'n/a', errors: [] }
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
  const now = await h.clock.now().catch(() => Date.now())
  const recs: DeskRec[] = []
  let read = 0
  await guard('answers', async () => {
    recs.push(...(await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)))
    read = (await readJson<{ n: number }>(h, `${deskState(home)}/inbox-read.json`, { n: 0 })).n || 0
    v.total = recs.length
    v.unread = Math.max(0, recs.length - read)
    v.answers = recs
      .map((rec, n) => ({ n, rec, unread: n >= read }))
      .sort((a, b) => Number(b.unread) - Number(a.unread) || b.n - a.n)
      .slice(0, 30)
  })
  const rows = new Map<string, { run: boolean }>()
  let agentsOk = true
  await guard('agents', async () => {
    const r = await h.process.run(['claude', 'agents', '--json', '--all'])
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
  return v
}

export async function ackRows(h: Host, upTo: number | 'all'): Promise<void> {
  const u = await unreadReports(h)
  await markRead(h, upTo === 'all' ? u.upTo : Math.min(Math.max(upTo, 0), u.upTo))
}

// A thread's status line: its id, today's budget, lines in its inbox it has not seen.
export async function threadStatus(h: Host, id: string): Promise<string> {
  const home = await homeDir(h)
  const n = (await unconsumed(h, home, id)).msgs.length
  const b = (await loadBudget(h, home)) ?? 'budget n/a'
  return `${id} · ${b} · ${n} unread`
}
