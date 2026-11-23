// The data of one thread's detail pane (threadpane.tsx): the thread's own files, the desk inbox, the worktree registry, a bounded
// `git diff --stat` and the review record for HEAD, read straight from the files. Never throws: a part that fails is a line in
// `errors` and the rest is still drawn. Several panes (one per thread) read through the same short caches, so five open panes do not
// run five `claude agents` listings or five git diffs per refresh.
import { approvalOf, deskState, unconsumed } from './delivery'
import { liveApproval } from './approvals'
import { denialCard, noPromptText, sessionAlive } from './denial'
import type { DeskRec } from './delivery'
import { dayOf, syncRollup } from './ledger'
import type { Rollup } from './ledger'
import { greenReview, reviewFile } from './reviews'
import type { Review } from './reviews'
import { resolveRange } from './reviewprep'
import { costBadge, costLine, threadCostsToday } from './stats'
import { homeDir, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { isRunning, isWorking, listAgents, needsYou } from './threads'
import { ENDED_AT_ONCE, endedAtOnce, isStuck, lastActivity, readWaiting, requestsOf, staleWorking, stallConfig, stallFor, stuckAdvice, threadsConfig, truthOf } from './threadstate'
import type { Word } from './threadstate'
import type { AgentRow, Inbox, Thread } from './threads'
import { ctxOf } from './threadcontext'
import type { CtxView } from './threadcontext'

export const REPORTS_MAX = 10 // reports drawn (newest first)
export const DIFF_FILES_MAX = 12 // files named in the diff stat; the rest is "+N more"
export const QUEUED_MAX = 20
export const BRIEF_MAX = 4000 // characters of brief.md kept (the pane shows the first lines until expanded)
const TTL_AGENTS = 8_000
const TTL_GIT = 15_000
const TTL_COST = 30_000
const ID = /^t\d+$/

export type Report = { n: number; ts: number; kind: 'report' | 'ask'; state?: string; text: string } // n: its place among all of the thread's records (stable while newer ones arrive)
export type DiffStat = { base: string; files: string[]; more: number; summary: string }
export type ReviewInfo = { sha: string; verdict: 'green' | 'not green' | 'unverified' | 'none'; passes?: number; findings: string[]; ts?: number }
export type ThreadDetail = {
  id: string
  title: string
  project: string
  state: string // open | parked | closing | closed
  model?: string
  effort?: string
  brief: string
  goal: string
  run: 'running' | 'idle' | 'parked' | 'unknown' // unknown: `claude agents` could not be read
  live?: Word // running | idle | stuck | done | parked (threadstate.ts truthOf); absent when the listing could not be read
  liveNote: string // "2 unread queued: wake or restart it", a stale [working] report, a start that ended its turn at once ('' = nothing to say)
  working: boolean // never closed or restarted behind the user's back: an unreadable listing counts as working
  needsYou: boolean
  finished: boolean
  keep?: boolean // keep mode (threadcontext.ts)
  ctx?: CtxView // the context size of the current session: text "ctx 108k/120k" | "ctx unknown", level (dim ok, yellow warn, red over)
  approval: string
  denial?: string // "no permission prompt exists for tN: the auto-mode classifier denied ..." (denial.ts), instead of an approval
  worktree?: { path: string; branch?: string; exists: boolean }
  head?: string
  diff?: DiffStat
  diffNote?: string // why there is no diff stat (no worktree, no base, git did not answer)
  review?: ReviewInfo
  cost: { today: number; total: number } | null
  costBadge?: string // "$6.20", "$21.30!" over the alert; absent when the thread spent nothing today
  costLine?: string // "today $6.20 (reviews $2.10, restarts $0.90)"
  reports: Report[] // newest first, at most REPORTS_MAX
  reportsTotal: number
  queued: { ts: number; from?: string; text: string }[]
  queuedTotal: number
  errors: string[]
}

// ---- short caches (module state: resetThreadCache drops them, a pressed button does) ----
let agentsCache: { at: number; rows: AgentRow[] | null } | null = null
let gitCache = new Map<string, { at: number; v: GitPart }>()
let rollupCache: { at: number; ro: Rollup } | null = null
export const resetThreadCache = () => {
  agentsCache = null
  gitCache = new Map()
  rollupCache = null
}

async function agentRows(h: Host, now: number): Promise<AgentRow[] | null> {
  if (agentsCache && now >= agentsCache.at && now - agentsCache.at < TTL_AGENTS) return agentsCache.rows
  const rows = await listAgents(h).catch(() => null)
  agentsCache = { at: now, rows }
  return rows
}

type GitPart = { head?: string; diff?: DiffStat; diffNote?: string; review?: ReviewInfo }

// the first lines of `git diff --stat` are one file each, the last is the summary; bounded: a huge stat is cut to DIFF_FILES_MAX files
export function parseStat(out: string): { files: string[]; more: number; summary: string } {
  const lines = out.split('\n').map(l => l.trimEnd()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  const hasSummary = /\bfiles? changed\b/.test(last)
  const files = (hasSummary ? lines.slice(0, -1) : lines).map(l => l.trim().slice(0, 160))
  return { files: files.slice(0, DIFF_FILES_MAX), more: Math.max(0, files.length - DIFF_FILES_MAX), summary: hasSummary ? last.trim() : '' }
}

async function gitPart(h: Host, home: string, t: Thread, wt: { path: string; exists: boolean } | undefined): Promise<GitPart> {
  if (!wt) return { diffNote: 'no worktree is registered for this thread' }
  if (!wt.exists) return { diffNote: `the worktree ${wt.path} is gone` }
  const git = async (...a: string[]): Promise<string | null> => {
    // the path comes from worktrees.json, which a thread can write: a repo there must not run its own fsmonitor or hooks in the desk
    const r = await h.process.run(['git', '-C', wt.path, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...a], { timeoutMs: 15_000 }).catch(() => null)
    return r && r.exitCode === 0 ? r.stdout : null
  }
  const head = (await git('rev-parse', 'HEAD'))?.trim()
  if (!head || !/^[0-9a-f]{40,64}$/.test(head)) return { diffNote: 'git did not answer in the worktree (HEAD unreadable)' }
  // the review record for exactly this HEAD (what a push is judged on); its base is the branch the work goes into
  let review: ReviewInfo = { sha: head, verdict: 'none', findings: [] }
  let recBase: string | undefined
  if (t.project && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.project)) {
    const rec = await readJson<Partial<Review> | null>(h, reviewFile(home, t.project, head), null)
    if (rec && typeof rec === 'object') {
      const green = await greenReview(h, t.project, head).catch(() => false)
      review = {
        sha: head,
        verdict: green ? 'green' : rec.green === true ? 'unverified' : 'not green', // a green flag whose signature does not check is not drawn as green
        passes: typeof rec.passes === 'number' ? rec.passes : undefined,
        findings: (Array.isArray(rec.findings) ? rec.findings : []).filter((x): x is string => typeof x === 'string').slice(0, 30).map(x => x.slice(0, 300)),
        ts: typeof rec.ts === 'number' ? rec.ts : undefined,
      }
      if (typeof rec.base === 'string' && rec.base) recBase = rec.base
    }
  }
  // the base: the review's, else the project's default branch (resolveRange, the one place that knows the candidates)
  const resolve = (base?: string) => resolveRange(h, t.project, base, head).catch(() => 'git did not answer')
  let range = t.project ? await resolve(recBase) : 'the thread has no project'
  if (typeof range === 'string' && recBase) range = await resolve(undefined) // the review's base is gone: the default branch
  if (typeof range === 'string') return { head, review, diffNote: `no diff: ${range.slice(0, 160)}` }
  return finish(head, review, range.base, await git('diff', '--stat', '--no-color', '--no-ext-diff', `${range.base}...HEAD`))
}

function finish(head: string, review: ReviewInfo, base: string, out: string | null): GitPart {
  if (out === null) return { head, review, diffNote: 'git diff --stat did not answer' }
  const s = parseStat(out)
  return { head, review, diff: { base: base.slice(0, 12), ...s } }
}

async function costOf(h: Host, id: string, now: number): Promise<{ today: number; total: number } | null> {
  try {
    if (!rollupCache || now < rollupCache.at || now - rollupCache.at >= TTL_COST) rollupCache = { at: now, ro: await syncRollup(h, now) }
    const ro = rollupCache.ro
    let total = 0
    for (const d of Object.values(ro.days)) total += d.tN?.[id]?.[0] ?? 0
    return { today: ro.days[dayOf(now)]?.tN?.[id]?.[0] ?? 0, total }
  } catch {
    return null
  }
}

const text = async (h: Host, p: string): Promise<string> => {
  const r = await h.fs.read(p).catch(() => '')
  return typeof r === 'string' ? r : ''
}

// a pane's title needs only thread.json: no git, no session listing, no ledger
export async function threadTitle(h: Host, id: string): Promise<string | null> {
  if (!ID.test(id)) return null
  try {
    const t = await readJson<Thread | null>(h, `${threadsDir(await homeDir(h))}/${id}/thread.json`, null)
    return t && t.id === id ? String(t.title ?? '') : null
  } catch {
    return null
  }
}

// null: no such thread (a bad id or no thread.json). A closed thread is returned with state 'closed' and only what is cheap.
export async function loadThreadDetail(h: Host, id: string): Promise<ThreadDetail | null> {
  if (!ID.test(id)) return null
  let home = ''
  try {
    home = await homeDir(h)
  } catch {
    return null
  }
  const dir = `${threadsDir(home)}/${id}`
  const t = await readJson<Thread | null>(h, `${dir}/thread.json`, null)
  if (!t || t.id !== id) return null
  const d: ThreadDetail = { id, title: String(t.title ?? ''), project: String(t.project ?? ''), state: t.state, model: t.model, effort: t.effort, brief: '', goal: '', run: 'unknown', liveNote: '', working: false, needsYou: false, finished: typeof t.finished === 'number' && t.finished > 0, approval: '', cost: null, reports: [], reportsTotal: 0, queued: [], queuedTotal: 0, errors: [] }
  if (t.state === 'closed') return d
  const guard = async (what: string, f: () => Promise<void>) => {
    try {
      await f()
    } catch (e) {
      d.errors.push(`${what}: ${String((e as Error)?.message ?? e).slice(0, 160)}`)
    }
  }
  const now = await h.clock.now().catch(() => Date.now())
  await guard('brief', async () => {
    d.brief = (await text(h, `${dir}/brief.md`)).trim().slice(0, BRIEF_MAX) || d.title
  })
  await guard('goal', async () => {
    const goals = await readJson<Record<string, { text?: unknown }>>(h, `${leanDir(home)}/goals.json`, {})
    const g = goals?.[id]?.text
    d.goal = (typeof g === 'string' ? g.trim() : '') || (t.lastGoal ?? '').trim()
  })
  let sessionRow: AgentRow | undefined
  let listed = false
  await guard('session', async () => {
    const rows = await agentRows(h, now)
    const row = t.sid && rows ? rows.find(a => a.sid === t.sid) : undefined
    sessionRow = row
    listed = !!rows
    d.run = t.state === 'parked' ? 'parked' : !rows ? 'unknown' : isRunning(row) ? 'running' : 'idle'
    d.working = !rows || isWorking(row) // an unreadable listing is never "not working"
    d.needsYou = needsYou(row)
  })
  let wt: ThreadDetail['worktree']
  await guard('worktree', async () => {
    const reg = await readJson<Record<string, { path?: unknown; branch?: unknown; thread?: unknown }>>(h, `${leanDir(home)}/worktrees.json`, {})
    const mine = Object.values(reg && typeof reg === 'object' ? reg : {}).filter(w => w && w.thread === id && typeof w.path === 'string' && (w.path as string).startsWith('/'))
    const w = mine[mine.length - 1]
    if (!w) return
    const path = w.path as string
    wt = { path, ...(typeof w.branch === 'string' && w.branch ? { branch: w.branch } : {}), exists: await h.fs.exists(path).catch(() => false) }
    d.worktree = wt
  })
  await guard('git', async () => {
    const hit = gitCache.get(id)
    const part = hit && now >= hit.at && now - hit.at < TTL_GIT ? hit.v : await gitPart(h, home, t, wt)
    if (part.diff) gitCache.set(id, { at: now, v: part }) // (only a complete answer is kept: a failure is asked again at the next draw)
    d.head = part.head
    d.diff = part.diff
    d.diffNote = part.diffNote
    d.review = part.review
  })
  await guard('cost', async () => {
    d.cost = await costOf(h, id, now)
    const c = (await threadCostsToday(h))[id]
    if (c) {
      d.costBadge = costBadge(c) // the header's badge, "!" over the alert
      d.costLine = costLine(c, true) // main $a · workers $b · reviews $c
    }
  })
  await guard('context', async () => {
    if (t.keep === true) d.keep = true
    if (t.sid) d.ctx = await ctxOf(h, home, t) // "ctx 108k/120k" | "ctx unknown" and its level (threadcontext.ts)
  })
  await guard('reports', async () => {
    const all = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r && r.from === id && (r.kind === 'report' || r.kind === 'ask') && typeof r.text === 'string')
    d.reportsTotal = all.length
    d.reports = all
      .map((r, n) => ({ n, ts: r.ts, kind: r.kind, ...(r.state ? { state: r.state } : {}), text: r.text }))
      .slice(-REPORTS_MAX)
      .reverse()
    const last = all[all.length - 1]
    if (last && t.state === 'open') d.approval = await liveApproval(h, id, approvalOf(last), last.ts, d.run !== 'unknown' && d.working).catch(() => approvalOf(last)) // only while it is really blocked (approvals.ts)
    // no permission prompt behind a classifier / rule denial: said plainly, never an "Open" (denial.ts)
    if (last && last.kind === 'report' && last.state === 'blocked' && t.state === 'open') {
      const den = await denialCard(h, id, { blocked: true, approval: d.approval, noPrompt: listed && sessionAlive(sessionRow) && !d.needsYou, reportTs: last.ts, working: d.run !== 'unknown' && d.working, text: last.text }).catch(() => null)
      if (den) {
        d.denial = noPromptText(id, den.category)
        d.approval = ''
      }
    }
  })
  await guard('queued', async () => {
    const q: Inbox[] = (await unconsumed(h, home, id)).msgs
    d.queuedTotal = q.length
    d.queued = q.slice(-QUEUED_MAX).map(m => ({ ts: m.ts, ...(m.from ? { from: m.from } : {}), text: String(m.text ?? '') }))
  })
  // the truth about "running": the session's own state and the queue (idle with N unread, stuck, a stale [working] report, an instant end)
  await guard('live', async () => {
    if (!listed || !t.sid) return // (no listing, or no session yet: nothing is claimed)
    const q = (await unconsumed(h, home, id)).msgs
    const truth = truthOf({ threadState: t.state, finished: d.finished, row: t.sid ? sessionRow : undefined, queued: q, now, stuckMinutes: (await threadsConfig(h, home)).stuckMinutes, stallMinutes: stallFor((await stallConfig(h, home)).minutes, t), activityAt: t.state === 'open' && t.sid ? await lastActivity(h, home, id, t.lastWake) : null, waitingSince: (await readWaiting(h, home, id))?.since ?? null })
    d.live = truth.word
    const all = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r && r.from === id && (r.kind === 'report' || r.kind === 'ask'))
    const last = all[all.length - 1]
    const stale = !!last && last.kind === 'report' && staleWorking(last.state, truth.word)
    const ended = t.state === 'open' && !!t.sid && t.lastWake > 0 && (truth.word === 'idle' || truth.word === 'done') && typeof t.req0 === 'number' && endedAtOnce({ word: truth.word, req0: t.req0, req: await requestsOf(h, id, now), reportsSince: all.filter(r => r.ts >= t.lastWake).length })
    d.liveNote = [truth.word === 'idle' && truth.unread ? `${truth.unread} unread queued: wake or restart it` : '', isStuck(truth.word) ? `${truth.text}: ${stuckAdvice(sessionRow)}` : '', stale ? 'its last [working] report is stale: the session is not running' : '', ended ? ENDED_AT_ONCE : ''].filter(Boolean).join(' · ')
  })
  return d
}
