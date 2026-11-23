// The desk pane's data (design 2.5): read straight from the files, never throws; every failure becomes a line in `errors`.
import { homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { approvalOf, deskState, unconsumed } from './delivery'
import { liveApproval } from './approvals'
import { denialCard, noPromptText, sessionAlive } from './denial'
import { selfEditView } from './selfedit'
import type { SelfEditView } from './selfedit'
import type { DeskRec } from './delivery'
import { openQuestions } from './extras'
import { peekNotice, readNoticeRows, readNotices } from './notices'
import { dayOf } from './ledger'
import { NOTICE_SET, deskModelStatus, deskModelText, readDeskModel, readDeskSwitch } from './deskmodel'
import { costBadge, costLine, spendNumbers, spendText, threadCostsToday, windowLine } from './stats'
import type { Spend, ThreadCost } from './stats'
import { isRunning, isWorking, needsYou, parseAgents } from './threads'
import { ENDED_AT_ONCE, endedAtOnce, isStuck, lastActivity, readWaiting, requestsOf, staleWorking, stallConfig, stallFor, stuckAdvice, threadsConfig, truthOf } from './threadstate'
import type { Word } from './threadstate'
import { isLimitRow, pausedRec, readLimit } from './limits'
import type { AgentRow, Thread } from './threads'
import { deskChoice } from './models'
import { isExpensiveModel, listRequests } from './expensive'
import type { ModelRequest } from './expensive'
import { listActions, standingView } from './deskactions'
import { holdsView } from './sendhold'
import type { Held } from './sendhold'
import type { ActionView, StandingView } from './deskactions'
import { writesView } from './deskwrites'
import type { WritesView } from './deskwrites'
import { contextSize, deskNote, deskTokens } from './deskcompact'
import { greenReview, reviewFile } from './reviews'
import type { Review } from './reviews'
import { slugOk } from './rules'
import { agentsText } from './guard'
import { ctxOf, threadLimits } from './threadcontext'
import { RESTARTING_TEXT, isRestarting } from './contextstop'
import type { Level } from './threadcontext'

export type GoalTone = 'working' | 'waiting' | 'stuck' | 'quiet'
export type GoalRow = { id: string; text: string; ts: number; tone: GoalTone }
export type AnswerRow = { n: number; rec: DeskRec; unread: boolean }
// the review record of the commit a thread's last report names: green (a signed green record), red (a record that is not green), none
export type Verdict = 'green' | 'red' | 'none'
// working: the session is busy or reports state working (never closed from the pane); done: the thread's LAST record is a done report
// (a later question or progress makes it not done); asking: its last record is a question or one is unread; needsYou: the session
// waits on a prompt nobody answers (open it in the app)
// lastReport: the last report or question as one flat line; branch / sha: what its last reports name (and the review record knows);
// review: the verdict of that sha; cost: today's usd; ready: done, a green review, and the report does not say it was pushed; recTs: when
// the last record was written (an event's identity)
// live: what the session really is (threadstate.ts truthOf): running (alive and working) | idle (turn ended, `unread` queued messages) | stuck
// (queued unread for threads.stuckMinutes, no tool call or inbox read) | done | parked; liveNote: the card's extra line (unread count, a stale
// [working] report, a start that ended its turn at once)
export type ThreadRow = { finishing?: boolean; restarting?: boolean /* hard-stopped at the context limit, the mod restarts it */; id: string; title: string; model?: string; effort?: string; state: string; run: 'running' | 'idle' | 'parked'; live?: Word; unread?: number; liveNote?: string; last: string; resumable: boolean; working: boolean; done: boolean; asking: boolean; blocked: boolean; needsYou: boolean; pausedUntil?: number; finished?: boolean; ctx?: string; ctxLevel?: Level /* "ctx 108k/120k" and its level (threadcontext.ts), only for an open thread with a recorded size */; keep?: boolean; keepGoing?: boolean /* the standing order "keep going" (continuepending.ts) */; approval?: string; pending?: string /* "waiting for your Approve: reply to thread 7": a request for a remote write waits (the thread's state stays working, 1.0.28) */; denial?: string /* the reason category of a classifier denial: no permission prompt exists (denial.ts) */; lastReport: string; branch?: string; sha?: string; review: Verdict; cost: number; costBadge?: string; costLine?: string /* "today $12.40 (reviews $5.10, restarts $0.90)" */; costOver?: boolean; ready: boolean; recTs: number; agents?: string; blockedDismissed?: boolean /* its blocked report is the one the user dismissed */; waitId?: string /* which prompt wait (session + what it waits for), for Dismiss */; stallId?: string /* which stall (the last wake), for Dismiss */ }
export type ClosedRow = { id: string; title: string; last: string }
import { listProjects } from './projects'
import type { ProjectRow } from './projects'
import { scriptCounts, waitingScripts } from './scripts'
import type { Waiting } from './scripts'
// one thing that waits for the user (the pane's first section, and what a toast is made of). key: the event's identity (a toast is shown
// once per key); notify: false = shown in the pane, never a toast
// model: a request for an expensive model (Approve / Deny, expensive.ts); deskmodel: the desk runs an expensive model and the mod could not
// switch it (red)
// action: a thread's request for the desk to send a typed remote write (deskactions.ts): Approve / Deny presses in the pane, or the desk's question
// dk: what Dismiss records and the view hides by (dismissstore.ts); every card has one
// "waiting for your Approve: reply to thread 7" (and how many more): the badge a thread with a pending request wears while its state stays working
export const pendingText = (r: Pick<ActionView, 'headline'>, n = 1): string => `waiting for your Approve: ${r.headline.replace(/\s+/g, ' ').replace(/\s*\([^)]*\)\s*$/, '').slice(0, 70)}${n > 1 ? ` (+${n - 1})` : ''}`
export type NeedKind ='approval' | 'denial' | 'question' | 'push' | 'blocked' | 'script' | 'context' | 'model' | 'deskmodel' | 'action' | 'stalled'
export type NeedRow = { key: string; kind: NeedKind; thread?: string; text: string; notify: boolean; script?: Waiting; request?: ModelRequest; action?: ActionView; dk?: DItem }
// one thread's inbox: unread rows first, then at most READ_SHOWN read ones (`read` holds every read row that is not archived)
// a line at the top of the pane that comes from a notice file (budget alert, restart that gave up, old-desk reminder, ...); budget: an alert, not an error
export type NoticeRow = { key: string; text: string; dk: DItem; budget?: boolean }
export type InboxGroup = { from: string; title: string; unread: AnswerRow[]; read: AnswerRow[]; newest: number }
export type DeskInfo = { context: number; limit: number; model: string; effort: string; note: string }
export type View = { scripts: { candidates: number; adopted: number; needsUpdate: number; waiting: Waiting[] }; projects: ProjectRow[]; goals: GoalRow[]; answers: AnswerRow[]; inbox: InboxGroup[]; archived: number; needs: NeedRow[]; openQuestions: { q: number; from?: string; question?: string }[]; unread: number; total: number; threads: ThreadRow[]; closed: ClosedRow[]; budget: string; spend: Spend | null; window: string; desk: DeskInfo; errors: string[]; dismissed: NeedRow[] /* cards the user dismissed (hidden from `needs`, not counted) */; notices: NoticeRow[]; dismissedNotices: NoticeRow[]; deskModel?: string; deskModelRed?: string; deskModelSet?: string; deskModelStatus?: string /* which case applies, in words (deskmodel.ts deskModelStatus) */; modelRequests: ModelRequest[]; actionRequests?: ActionView[]; standing?: StandingView /* active grants and recent standing sends (deskactions.ts) */; holds?: Held[] /* covered replies in their hold window (sendhold.ts) */; writes?: WritesView /* the user's written approvals and what was sent under them (deskwrites.ts) */; selfEdit?: SelfEditView /* the threads the user let edit their worktree themselves (selfedit.ts) */ }
export const ANSWERS_MAX = 200 // rows the view hands the pane (it draws only what is unfolded)
export const CLOSED_MAX = 40
export const ARCHIVE_MS = 7 * 86_400_000 // a read inbox row older than this is hidden in the pane (it stays in inbox.jsonl)
export const ACTION_CARD_MAX = 400 // a write request longer than this is not approved in the pane (the desk question shows all of it)
export const READ_SHOWN = 5 // read rows drawn per thread until "show all"
export const OVER_PCT = 80 // the desk context bar turns yellow, and Restart desk appears beside it, from here

// ---- a thread's one-word state and its colour (theme keys) ----------------------------------------------------------------
export type StateWord = 'parked' | 'paused' | 'restarting' | 'waiting' | 'waiting for answer' | 'approval' | 'blocked' | 'asking' | 'stuck' | 'stalled' | 'working' | 'done (finishing)' | 'done' | 'idle'
export const stateOf = (t: ThreadRow): { word: StateWord; color: string } => {
  if (t.run === 'parked') return { word: 'parked', color: 'inactive' }
  if (t.pausedUntil) return { word: 'paused', color: 'warning' }
  if (t.restarting) return { word: 'restarting', color: 'warning' } // never a red state that asks the user to act: the mod restarts it
  if (t.live === 'waiting') return { word: 'waiting for answer', color: 'warning' } // it asked a question and did nothing since (threadstate.ts); the engine's `blocked` label is not a prompt
  if (t.needsYou) return { word: 'waiting', color: 'warning' }
  if (t.approval) return { word: 'approval', color: 'warning' }
  if (t.blocked) return { word: 'blocked', color: 'error' }
  if (t.asking) return { word: 'asking', color: 'warning' }
  if (t.live === 'stuck') return { word: 'stuck', color: 'error' }
  if (t.live === 'stalled') return { word: 'stalled', color: 'error' } // alive and working, no tool call or report for threads.stallMinutes (stall.ts)
  if (t.finishing) return { word: 'done (finishing)', color: 'inactive' } // reported done, the session only waits for a background worker's notification
  if (t.working) return { word: 'working', color: 'success' }
  if (t.done || t.finished) return { word: 'done', color: 'inactive' }
  return { word: 'idle', color: 'inactive' }
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

// ---- the branch and the commit a thread's reports name, and the review record of that commit --------------------------------
const SHA = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g // (a word of hex letters only is not taken for a commit)
const BRANCH_STRONG = [/\bbranch\b\s*[:=]\s*[`'"]?([^\s`'",;)]+)/i, /\bbranch\s+[`'"]([^`'"\s]+)[`'"]/i]
const BRANCH_WEAK = /\bbranch\s+([\w]+[/-][\w./-]*)/i // (`branch fix/x`, never `branch is ready`)
export const branchIn = (text: string): string | undefined => {
  for (const re of BRANCH_STRONG) {
    const m = re.exec(text)
    if (m?.[1] && /[\w]/.test(m[1])) return m[1].replace(/[.:]+$/, '')
  }
  return BRANCH_WEAK.exec(text)?.[1]?.replace(/[.:]+$/, '')
}
export const shasIn = (text: string): string[] => text.match(SHA) ?? []
const NOT_PUSHED = /\b(?:not\s+(?:yet\s+)?pushed|unpushed|not\s+been\s+pushed|pushed\s*[:=]\s*(?:no|false))\b/i
// does the report say the branch is on the remote? ("not pushed", "unpushed", "pushed: no" say it is not)
export const claimsPushed = (text: string): boolean => !NOT_PUSHED.test(text) && /\bpushed\b/i.test(text)

// reviews/<sha>.json per project, listed once per load
type Reviews = Map<string, string[]>
async function reviewShas(h: Host, home: string, project: string, cache: Reviews): Promise<string[]> {
  const hit = cache.get(project)
  if (hit) return hit
  const names = (await h.fs.list(`${leanDir(home)}/${project}/reviews`).catch(() => [])).map(e => e.name).filter(n => /^[0-9a-f]{7,64}\.json$/.test(n)).map(n => n.slice(0, -5))
  cache.set(project, names)
  return names
}
async function reviewOf(h: Host, home: string, project: string, sha: string, cache: Reviews): Promise<{ verdict: Verdict; branch?: string; full?: string }> {
  if (!slugOk(project)) return { verdict: 'none' }
  const full = (await reviewShas(h, home, project, cache)).find(s => s.startsWith(sha))
  if (!full) return { verdict: 'none' }
  const rec = await readJson<Partial<Review> | null>(h, reviewFile(home, project, full), null)
  const green = await greenReview(h, project, full).catch(() => false)
  return { verdict: green ? 'green' : 'red', branch: typeof rec?.branch === 'string' && rec.branch ? rec.branch : undefined, full }
}

// ---- the inbox: grouped by thread, unread first, old read rows archived ----------------------------------------------------
export const archivedRow = (a: AnswerRow, now: number): boolean => !a.unread && now - (a.rec.ts || 0) > ARCHIVE_MS
export function groupInbox(answers: AnswerRow[], now: number, titles: Map<string, string>): { groups: InboxGroup[]; archived: number } {
  let archived = 0
  const by = new Map<string, InboxGroup>()
  for (const a of answers) {
    if (archivedRow(a, now)) {
      archived++
      continue
    }
    const g = by.get(a.rec.from) ?? { from: a.rec.from, title: titles.get(a.rec.from) ?? '', unread: [], read: [], newest: 0 }
    ;(a.unread ? g.unread : g.read).push(a)
    g.newest = Math.max(g.newest, a.n)
    by.set(a.rec.from, g)
  }
  for (const g of by.values()) {
    g.unread.sort((x, y) => y.n - x.n)
    g.read.sort((x, y) => y.n - x.n)
  }
  // groups with something unread first, then the one with the newest row
  return { groups: [...by.values()].sort((x, y) => Number(y.unread.length > 0) - Number(x.unread.length > 0) || y.newest - x.newest), archived }
}

import { STALE_MS } from './chaser'
import { dismissedKeys, dismissedTs, dkey } from './dismissstore'
import type { DItem } from './dismissstore'
export { STALE_MS }
const ID = /^t\d+$/

const lastLine = (t: string) => t.split('\n').map(s => s.trim()).filter(Boolean).pop() ?? ''

// The pane refreshes every 5 s: `claude agents` and the whole-ledger sum are cached for a while (a pressed button
// drops the cache so its result shows at once).
const AGENTS_TTL = 10_000
const BUDGET_TTL = 60_000
let agentsCache: { at: number; out: { exitCode: number; stdout: string } } | null = null
let budgetCache: { at: number; spend: Spend | null } | null = null
export const resetViewCache = () => {
  agentsCache = null
  budgetCache = null
}

// today, 7 days and today's usd per thread from the rollup; null when there is no ledger.
async function loadBudget(h: Host, home: string): Promise<Spend | null> {
  const now = await h.clock.now()
  if (budgetCache && now - budgetCache.at < BUDGET_TTL && now >= budgetCache.at) return budgetCache.spend
  const spend = await spendNumbers(h)
  budgetCache = { at: now, spend }
  return spend
}

// The pane's own read marker (never the desk's inbox-read.json): rows below `upTo` plus single acked rows.
type PaneAck = { upTo: number; ns: number[] }
const paneAckFile = (home: string) => `${deskState(home)}/pane-ack.json`
async function paneAck(h: Host, home: string): Promise<PaneAck> {
  const a = await readJson<Partial<PaneAck>>(h, paneAckFile(home), {})
  return { upTo: Number(a.upTo) || 0, ns: Array.isArray(a.ns) ? a.ns.filter(x => Number.isInteger(x)) : [] }
}

export async function loadView(h: Host): Promise<View> {
  const v: View = { window: '', scripts: { candidates: 0, adopted: 0, needsUpdate: 0, waiting: [] }, projects: [], goals: [], answers: [], inbox: [], archived: 0, needs: [], openQuestions: [], unread: 0, total: 0, threads: [], closed: [], budget: 'n/a', spend: null, desk: { context: 0, limit: 0, model: '', effort: '', note: '' }, errors: [], dismissed: [], notices: [], dismissedNotices: [], modelRequests: [] }
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
    v.scripts = { ...(await scriptCounts(h)), waiting: await waitingScripts(h) }
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
    const all = recs.map((rec, n) => ({ n, rec, unread: isUnread(n) }))
    v.archived = all.filter(a => archivedRow(a, now)).length // (counted over every record, not only the ones handed on)
    v.answers = all
      .filter(a => !archivedRow(a, now))
      .sort((a, b) => Number(b.unread) - Number(a.unread) || b.n - a.n)
      .slice(0, ANSWERS_MAX)
  })
  await guard('questions', async () => { v.openQuestions = await openQuestions(h) })
  const rows = new Map<string, { run: boolean; working: boolean; needsYou: boolean; limit: boolean; agent: AgentRow }>()
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
    for (const a of parseAgents(r.stdout)) rows.set(a.sid, { run: isRunning(a), working: isWorking(a), needsYou: needsYou(a), limit: isLimitRow(a), agent: a })
  })
  const asking = new Set<string>()
  const owner = new Map<string, string>() // tN -> last record text
  const lastRec = new Map<string, DeskRec>() // tN -> its last record (report or question)
  const recsOf = new Map<string, DeskRec[]>() // tN -> its records, oldest first
  for (const r of recs.slice(read)) if (r.kind === 'ask') asking.add(r.from)
  for (const r of recs) {
    owner.set(r.from, r.text)
    lastRec.set(r.from, r)
    const mine = recsOf.get(r.from)
    if (mine) mine.push(r)
    else recsOf.set(r.from, [r])
  }
  // spend first: a thread card shows what the thread cost today
  let costs: Record<string, ThreadCost> = {}
  await guard('budget', async () => {
    v.spend = await loadBudget(h, home)
    v.budget = v.spend ? spendText(v.spend) : 'n/a'
    v.window = await windowLine(h) // the plan windows (windows.ts), one line under the header
    costs = await threadCostsToday(h, v.spend).catch(() => ({}) as Record<string, ThreadCost>) // the card's badge: today's usd, "!" over the alert
  })
  const reviews: Reviews = new Map()
  await guard('threads', async () => {
    const stuckMinutes = (await threadsConfig(h, home)).stuckMinutes // (once per refresh, not per thread)
    const stallMinutes = (await stallConfig(h, home)).minutes
    const ctxLimits = await threadLimits(h)
    let ents: { name: string }[] = []
    try {
      ents = await h.fs.list(threadsDir(home))
    } catch {
      /* no threads yet */
    }
    for (const e of ents.filter(x => ID.test(x.name)).sort((a, b) => Number(b.name.slice(1)) - Number(a.name.slice(1)))) {
      const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
      if (!t) continue
      const notes = (await h.fs.read(`${threadsDir(home)}/${e.name}/notes.md`).catch(() => '')) as string
      if (t.state === 'closed') {
        if (v.closed.length < CLOSED_MAX) v.closed.push({ id: t.id, title: t.title, last: lastLine(typeof notes === 'string' ? notes : '') || owner.get(t.id) || '' })
        continue
      }
      const ag = t.sid ? rows.get(t.sid) : undefined
      const running = !!ag?.run
      const lr = lastRec.get(t.id)
      // blocked by the usage limit with a known reset (and the desk's auto-resume not given up): paused, not "needs you", not working
      const paused = t.state === 'open' && ag?.limit ? pausedRec(await readLimit(h, home, t.id), t.sid, now) : null
      // the branch and the commit its latest reports name, and that commit's review record (newest report first)
      let branch: string | undefined
      let sha: string | undefined
      let review: Verdict = 'none'
      let full: string | undefined
      // the NEWEST report that names a commit decides: a newer commit without a review record is "no review", never an older commit's verdict
      for (const r of [...(recsOf.get(t.id) ?? [])].reverse()) {
        if (r.kind !== 'report') continue
        branch ??= branchIn(r.text)
        const named = shasIn(r.text)
        if (!named.length) continue
        for (const c of named) {
          const o = await reviewOf(h, home, t.project, c, reviews)
          if (!o.full) continue
          full = o.full
          sha = o.full.slice(0, 7)
          review = o.verdict
          branch = o.branch ?? branch
          break
        }
        break
      }
      const isDone = !!lr && lr.kind === 'report' && lr.state === 'done'
      // the desk's push is recorded in the thread's history (push.ts), not in the desk inbox: a pushed commit is not "ready to push"
      const pushed = isDone && review === 'green' && !!full && (await readJsonl<{ kind?: string; ok?: boolean; sha?: string }>(h, `${threadsDir(home)}/${t.id}/history.jsonl`).catch(() => [])).some(x => x?.kind === 'push' && x.ok === true && typeof x.sha === 'string' && x.sha.length >= 7 && full!.startsWith(x.sha))
      const used = await agentsText(h, home, t.id).catch(() => '') // "agents 3/4" when config.json agents.cap is set
      // running | idle (N unread queued) | stuck | done | parked: from the session's own state and the queue; an unreadable listing says nothing
      const queued = (await unconsumed(h, home, t.id)).msgs
      const truth = truthOf({ threadState: t.state, finished: typeof t.finished === 'number' && t.finished > 0, row: t.sid ? ag?.agent : undefined, queued, now, stuckMinutes, stallMinutes: stallFor(stallMinutes, t), activityAt: t.state === 'open' && t.sid ? await lastActivity(h, home, t.id, t.lastWake) : null, waitingSince: (await readWaiting(h, home, t.id))?.since ?? null })
      const stale = agentsOk && !!lr && lr.kind === 'report' && staleWorking(lr.state, truth.word)
      const mine = recsOf.get(t.id) ?? []
      const ended = agentsOk && t.state === 'open' && !!t.sid && t.lastWake > 0 && (truth.word === 'idle' || truth.word === 'done') && typeof t.req0 === 'number' && endedAtOnce({ word: truth.word, req0: t.req0, req: await requestsOf(h, t.id, now), reportsSince: mine.filter(r => r.ts >= t.lastWake).length })
      const liveNote = !agentsOk || t.state !== 'open' || !t.sid ? '' : [truth.word === 'idle' && truth.unread ? `${truth.unread} unread queued: wake or restart it` : '', isStuck(truth.word) ? `${truth.text}: ${stuckAdvice(ag?.agent)}` : '', stale ? 'its last [working] report is stale: the session is not running' : '', ended ? ENDED_AT_ONCE : ''].filter(Boolean).join(' · ')
      const apv0 = lr && t.state === 'open' ? await liveApproval(h, t.id, approvalOf(lr), lr.ts, !!ag?.working && !paused).catch(() => approvalOf(lr)) : '' // a blocked report that still waits for the user's yes (approvals.ts)
      // "needs your yes in its own session" only when a prompt is really open there (`claude agents --json`: waitingFor / blocked). A classifier or rule denial has none:
      // the card says so and offers the real options instead of an Open button (denial.ts)
      const noPrompt = agentsOk && !!t.sid && !!ag && sessionAlive(ag.agent) && !ag.needsYou // (a stopped session, after "Open tN" stopped its idle process, says nothing about a prompt)
      const den = lr && lr.kind === 'report' && lr.state === 'blocked' && t.state === 'open' ? await denialCard(h, t.id, { blocked: true, approval: apv0, noPrompt, reportTs: lr.ts, working: !!ag?.working && !paused, text: lr.text }).catch(() => null) : null
      const apv = den ? '' : apv0
      const isBlocked = !!lr && lr.kind === 'report' && lr.state === 'blocked' && !(t.state === 'open' && approvalOf(lr) && !apv && !den)
      const dts = isBlocked ? await dismissedTs(h, home, t.id) : 0
      const cv = t.state === 'open' && t.sid ? await ctxOf(h, home, t, ctxLimits).catch(() => null) : null
      // hard-stopped at the context limit and the mod will restart it (its marker is pending: a give-up drops it): "restarting", amber, nothing for the user to do
      const restarting = await isRestarting(h, home, t).catch(() => false)
      v.threads.push({
        ...(restarting ? { restarting: true } : {}),
        ...(cv && cv.tokens !== undefined ? (restarting ? { ctx: `${cv.text} · ${RESTARTING_TEXT}`, ctxLevel: 'warn' as Level } : { ctx: cv.text, ctxLevel: cv.level }) : {}), // (an unknown size says nothing on the card)
        ...(t.keep === true ? { keep: true } : {}),
        ...(t.keepGoing === true ? { keepGoing: true } : {}),
        ...(agentsOk && t.sid ? { live: truth.word } : {}), // (no listing, or no session yet: nothing is claimed)
        unread: truth.unread,
        ...(liveNote ? { liveNote } : {}),
        ...(used ? { agents: used } : {}),
        lastReport: flat(lr?.text ?? '') || flat(lastLine(typeof notes === 'string' ? notes : '')),
        ...(branch ? { branch } : {}),
        ...(sha ? { sha } : {}),
        review,
        cost: v.spend?.byThread[t.id] ?? 0,
        ...(costs[t.id] ? { costBadge: costBadge(costs[t.id]!), costLine: costLine(costs[t.id]!), costOver: costs[t.id]!.over } : {}),
        ready: t.state === 'open' && isDone && review === 'green' && !pushed && !claimsPushed(lr?.text ?? ''),
        recTs: lr?.ts ?? 0,
        id: t.id,
        title: t.title,
        model: t.model,
        effort: t.effort,
        state: t.state,
        run: t.state === 'parked' ? 'parked' : running ? 'running' : 'idle',
        last: lastLine(typeof notes === 'string' ? notes : '') || owner.get(t.id) || '',
        resumable: t.state === 'open' && !running && agentsOk,
        ...(isDone && agentsOk && truth.word === 'running' && ag?.agent.status === 'idle' ? { finishing: true } : {}), // the last report is done and the session's status is idle: it only finishes (a pending background worker)
        working: (!!ag?.working && !paused) || !agentsOk, // an unreadable listing is never "not working": nothing is closed on a guess
        done: isDone,
        asking: asking.has(t.id) || lr?.kind === 'ask',
        ...(isBlocked ? (dts >= lr!.ts ? { blocked: false, blockedDismissed: true } : { blocked: true }) : { blocked: false }), // not once its approval ended: it carried on; not once the user dismissed THIS report (a newer blocked one shows again)
        needsYou: !!ag?.needsYou && !paused,
        ...(ag?.needsYou && !paused ? { waitId: `${t.sid}:${ag.agent.waitingFor || ag.agent.state}` } : {}),
        ...(isStuck(truth.word) && agentsOk && t.state === 'open' && t.sid ? { stallId: String(t.lastWake) } : {}),
        ...(apv ? { approval: apv } : {}),
        ...(den ? { denial: den.category } : {}),
        ...(paused ? { pausedUntil: paused.resetAt } : {}),
        ...(typeof t.finished === 'number' && t.finished > 0 ? { finished: true } : {}), // reported done and was stopped: the next message starts a new session
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
  // the desk runs a model other than its pin and the mod could not change it: one top row says what to pick (not also a red notice line)
  let deskModelNote = ''
  let deskRuns = ''
  await guard('desk model', async () => {
    const m = await readDeskModel(h)
    if (m) {
      v.deskModel = deskModelText(m)
      deskModelNote = v.deskModel
      deskRuns = m.running
      if (isExpensiveModel(m.running)) v.deskModelRed = v.deskModel // an expensive desk the mod could not switch: a red row in "Needs you", not a header line
    }
    const st = await deskModelStatus(h)
    if (st) v.deskModelStatus = st.text
    if (!m) {
      const sw = await readDeskSwitch(h)
      if (sw?.user) deskRuns = sw.user // chosen by hand: the chip says what it runs, not the pin
    }
  })
  // requests for an expensive model (a thread's own `lean_thread` call, the guard's refusal, a review): Approve / Deny in "Needs you"
  await guard('model requests', async () => {
    const open = new Set(v.threads.map(t => t.id))
    v.modelRequests = (await listRequests(h)).filter(r => r.thread === 'desk' || open.has(r.thread))
  })
  // thread requests for a typed remote write (reply to a PR thread, work item update ...): pending or approved and not yet sent
  await guard('action requests', async () => {
    const open = new Set(v.threads.map(t => t.id))
    v.actionRequests = (await listActions(h)).filter(r => open.has(r.thread))
    // the badge on the thread's row: a pending request does not block the thread (it stays `working`)
    for (const t of v.threads) {
      const p = v.actionRequests.find(r => r.thread === t.id && r.state === 'pending')
      if (p) t.pending = pendingText(p, v.actionRequests.filter(r => r.thread === t.id && r.state === 'pending').length)
    }
  })
  // the user's standing approvals: the lines "sent under your standing approval: ..." and their Revoke buttons
  await guard('standing approvals', async () => {
    const s = await standingView(h)
    v.standing = { ...s, grants: s.grants.filter(g => v.threads.some(t => t.id === g.thread)) }
  })
  // covered replies waiting in their hold window (sendhold.ts): the exact text, the countdown, Send now / Cancel
  await guard('held sends', async () => {
    v.holds = (await holdsView(h)).filter(x => v.threads.some(t => t.id === x.thread))
  })
  // the user's written approvals (deskwrites.ts): the instruction a grant rests on, the writes sent under it, each with a Revoke button
  await guard('written approvals', async () => {
    const w = await writesView(h)
    v.writes = { ...w, grants: w.grants.filter(g => v.threads.some(t => t.id === g.thread)) }
  })
  // the threads the user let edit their worktree themselves (selfedit.ts): a line each with a Revoke button
  await guard('self-edit grants', async () => {
    const s = await selfEditView(h)
    v.selfEdit = { grants: s.grants.filter(g => v.threads.some(t => t.id === g.thread)) }
  })
  // the header chip (the pinned model and effort, or what it really runs when that is another) and the context bar
  // (the model lookup is guarded on its own: the size, the limit and the "cannot compact" note, with its Restart desk button, never depend on it)
  let pin: { model: string; effort: string } = { model: '', effort: '' }
  await guard('desk model pin', async () => {
    pin = await deskChoice(h, home)
  })
  await guard('desk', async () => {
    v.desk = { context: contextSize(), limit: await deskTokens(h), model: deskRuns || pin.model, effort: deskRuns ? '' : pin.effort, note: deskNote() }
  })
  // what the mod set is information, not an error: a dim line at the top, not a red one (and not counted in a thread's status line)
  const setNote = await peekNotice(h, NOTICE_SET)
  if (setNote) v.deskModelSet = setNote
  const day = dayOf(now)
  const allNotices: NoticeRow[] = (await readNoticeRows(h)).filter(n => n.text !== deskModelNote && n.text !== setNote).map(n => ({ key: n.key, text: n.text, dk: noticeDk(n.key, n.text, day), ...(BUDGET_KEY.test(n.key) ? { budget: true } : {}) }))
  // the inbox by thread, read rows older than a week hidden (they stay in inbox.jsonl)
  v.inbox = groupInbox(v.answers, now, new Map([...v.closed, ...v.threads].map(t => [t.id, t.title] as const))).groups
  // the user's Dismiss (dismissstore.ts): the card goes from `needs` (and from every count) until a newer item of its kind has another id
  const all = needsOf(v)
  const gone = await dismissedKeys(h, home, ['desk', ...v.threads.map(t => t.id), ...all.map(n => n.dk?.thread ?? ''), ...allNotices.map(n => n.dk.thread)].filter(Boolean)).catch(() => new Set<string>())
  v.needs = all.filter(n => !(n.dk && gone.has(dkey(n.dk))))
  v.dismissed = all.filter(n => n.dk && gone.has(dkey(n.dk)))
  v.notices = allNotices.filter(n => !gone.has(dkey(n.dk)))
  v.dismissedNotices = allNotices.filter(n => gone.has(dkey(n.dk)))
  return v
}

// a notice's dismiss identity: a restart that gave up belongs to its thread; a budget alert is also bound to the day (the next day's is a new one);
// the text is the rest (a new threshold or a changed finding has other text, so it shows again)
const BUDGET_KEY = /^budget/
const noticeDk = (key: string, text: string, day: string): DItem => {
  const m = /^restart-(t\d+)$/.exec(key)
  if (m) return { thread: m[1]!, kind: 'restart', id: text }
  return { thread: 'desk', kind: key === 'old-desk' ? 'olddesk' : 'notice', id: `${key}${BUDGET_KEY.test(key) ? `@${day}` : ''}:${text}` }
}

// what waits for the user, in the order the pane draws it: approvals, questions, ready reports, blocked threads, scripts, the desk's size
export function needsOf(v: Pick<View, 'threads' | 'openQuestions' | 'scripts' | 'desk'> & Partial<Pick<View, 'modelRequests' | 'deskModelRed' | 'actionRequests'>>): NeedRow[] {
  const out: NeedRow[] = []
  const title = (id: string) => v.threads.find(t => t.id === id)?.title ?? ''
  // the desk itself runs an expensive model that the mod could not switch away from: first, red
  if (v.deskModelRed) out.push({ key: `deskmodel:${v.deskModelRed.slice(0, 80)}`, kind: 'deskmodel', text: v.deskModelRed, notify: true, dk: { thread: 'desk', kind: 'deskmodel', id: v.deskModelRed.slice(0, 80) } })
  // a request for an expensive model: the user's Approve is the only way it runs (expensive.ts); a denied one stays until dismissed
  for (const r of v.modelRequests ?? []) {
    const what = `${r.model}${r.effort ? `/${r.effort}` : ''}`
    const who = r.thread === 'desk' ? 'the desk' : r.thread
    const text =
      r.state === 'denied'
        ? `${who}: ${what} was denied (${flat(r.reason).slice(0, 120)}); nothing runs on ${r.family}. Start it on sonnet instead?`
        : r.origin === 'tool'
          ? `${who} asks to run on ${what} (${r.family} is not sonnet or haiku, so it needs your approval): ${flat(r.reason).slice(0, 200)}`
          : `${who} was refused ${r.family} and reported blocked: ${flat(r.reason).slice(0, 200)}. Approve it to let ${who} go on, or deny it.`
    out.push({ key: `model:${r.id}:${r.state}`, kind: 'model', ...(r.thread !== 'desk' ? { thread: r.thread } : {}), text, notify: r.state === 'pending', request: r, dk: { thread: r.thread, kind: 'model', id: `${r.id}:${r.state}` } })
  }
  // a thread's request for a remote write: the exact text is on the card; the thread's own "blocked" row is not shown on top of it
  const asking = new Set((v.actionRequests ?? []).map(r => r.thread))
  for (const r of v.actionRequests ?? []) {
    const text = r.state === 'approved' ? `${r.thread}: you approved "${r.headline}" (request ${r.id}); the desk has not sent it yet` : r.items?.length ? `${r.thread} wants to ${r.headline}` : `${r.thread} wants to ${r.headline}: ${r.text.length > ACTION_CARD_MAX ? `${r.text.slice(0, ACTION_CARD_MAX - 1)}…` : r.text}` // a review batch: the pane draws its numbered one-liners; a text too long for the card: the pane says where it is approved
    out.push({ key: `action:${r.id}:${r.state}`, kind: 'action', thread: r.thread, text, notify: r.state === 'pending', action: r, dk: { thread: r.thread, kind: 'action', id: `${r.id}:${r.state}` } })
  }
  for (const t of v.threads) if (t.approval) out.push({ key: `approval:${t.id}:${t.recTs}`, kind: 'approval', thread: t.id, text: `${t.id} needs your yes in its own session: ${t.approval}`, notify: true, dk: { thread: t.id, kind: 'approval', id: String(t.recTs) } })
  // a classifier / rule denial: NO permission prompt exists, so no Open button: the real options (the pane draws the buttons)
  for (const t of v.threads) if (t.denial !== undefined && !t.approval && !asking.has(t.id)) out.push({ key: `denial:${t.id}:${t.recTs}`, kind: 'denial', thread: t.id, text: `${noPromptText(t.id, t.denial)} ${t.lastReport ? `It said: ${t.lastReport.slice(0, 120)}` : ''}`.trim(), notify: true, dk: { thread: t.id, kind: 'blocked', id: String(t.recTs) } })
  for (const q of v.openQuestions) out.push({ key: `ask:${q.q}`, kind: 'question', thread: q.from, text: `${q.from ?? 'desk'} asks: ${flat(q.question ?? '')}`, notify: true, dk: { thread: q.from ?? 'desk', kind: 'question', id: String(q.q) } })
  for (const t of v.threads) if (t.ready) out.push({ key: `push:${t.id}:${t.sha}`, kind: 'push', thread: t.id, text: `${t.id} ${title(t.id) ? `${flat(title(t.id)).slice(0, 60)} ` : ''}is ready to push (${t.sha}${t.branch ? ` on ${t.branch}` : ''}, review green): ask the desk to push`, notify: true, dk: { thread: t.id, kind: 'ready', id: String(t.recTs) } })
  for (const t of v.threads) {
    if (t.approval || t.denial !== undefined || asking.has(t.id) || t.run === 'parked' || t.pausedUntil) continue
    if (t.needsYou && t.live !== 'waiting') out.push({ key: `waiting:${t.id}`, kind: 'blocked', thread: t.id, text: `${t.id} waits on a prompt in its own session`, notify: true, dk: { thread: t.id, kind: 'prompt', id: t.waitId ?? '0' } })
    else if (t.blocked || t.blockedDismissed) out.push({ key: `blocked:${t.id}:${t.recTs}`, kind: 'blocked', thread: t.id, text: `${t.id} is blocked: ${t.lastReport.slice(0, 160)}`, notify: true, dk: { thread: t.id, kind: 'blocked', id: String(t.recTs) } })
    else if (t.stallId !== undefined) out.push({ key: `stalled:${t.id}:${t.stallId}`, kind: 'stalled', thread: t.id, text: `${t.id} is ${t.live}: ${t.liveNote || 'no progress'}`, notify: false, dk: { thread: t.id, kind: 'stalled', id: t.stallId } })
  }
  for (const w of v.scripts.waiting.slice(0, 8)) out.push({ key: `script:${w.name}:${w.update ?? ''}`, kind: 'script', text: `${w.name}${w.update ? ` ${w.update}` : ''} (${w.project}) waits for you: ${flat(w.why).slice(0, 80)}`, notify: false, script: w, dk: { thread: 'desk', kind: 'script', id: `${w.name}:${w.update ?? ''}:${w.sha.slice(0, 12)}` } })
  if (v.desk.limit > 0 && (v.desk.context >= v.desk.limit || v.desk.note)) out.push({ key: 'context', kind: 'context', text: v.desk.note || `desk context ${Math.round(v.desk.context / 1000)}k is over its limit (${Math.round(v.desk.limit / 1000)}k)`, notify: false, dk: { thread: 'desk', kind: 'context', id: v.desk.note || 'over' } })
  return out
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
  const sp = await loadBudget(h, home)
  const b = sp ? spendText(sp) : 'budget n/a'
  const setNote = await peekNotice(h, NOTICE_SET)
  const notes = (await readNotices(h)).filter(n => n !== setNote).length
  return `${id} · ${b} · ${n} unread${notes ? ` · ⚠ ${notes} notice${notes > 1 ? 's' : ''} (see the desk pane)` : ''}`
}
