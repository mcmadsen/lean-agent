// The desk pane's data (design 2.5): read straight from the files, never throws; every failure becomes a line in `errors`.
import { homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { approvalOf, deskState, unconsumed } from './delivery'
import type { DeskRec } from './delivery'
import { openQuestions } from './extras'
import { peekNotice, readNotices } from './notices'
import { NOTICE_SET, deskModelText, readDeskModel } from './deskmodel'
import { spendNumbers, spendText } from './stats'
import type { Spend } from './stats'
import { isRunning, isWorking, needsYou, parseAgents } from './threads'
import { isLimitRow, pausedRec, readLimit } from './limits'
import type { Thread } from './threads'
import { deskChoice } from './models'
import { contextSize, deskNote, deskTokens } from './deskcompact'
import { greenReview, reviewFile } from './reviews'
import type { Review } from './reviews'

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
export type ThreadRow = { id: string; title: string; model?: string; effort?: string; state: string; run: 'running' | 'idle' | 'parked'; last: string; resumable: boolean; working: boolean; done: boolean; asking: boolean; blocked: boolean; needsYou: boolean; pausedUntil?: number; finished?: boolean; approval?: string; lastReport: string; branch?: string; sha?: string; review: Verdict; cost: number; ready: boolean; recTs: number }
export type ClosedRow = { id: string; title: string; last: string }
import { listProjects } from './projects'
import type { ProjectRow } from './projects'
import { scriptCounts, waitingScripts } from './scripts'
import type { Waiting } from './scripts'
// one thing that waits for the user (the pane's first section, and what a toast is made of). key: the event's identity (a toast is shown
// once per key); notify: false = shown in the pane, never a toast
export type NeedKind = 'approval' | 'question' | 'push' | 'blocked' | 'script' | 'context'
export type NeedRow = { key: string; kind: NeedKind; thread?: string; text: string; notify: boolean; script?: Waiting }
// one thread's inbox: unread rows first, then at most READ_SHOWN read ones (`read` holds every read row that is not archived)
export type InboxGroup = { from: string; title: string; unread: AnswerRow[]; read: AnswerRow[]; newest: number }
export type DeskInfo = { context: number; limit: number; model: string; effort: string; note: string }
export type View = { scripts: { candidates: number; adopted: number; needsUpdate: number; waiting: Waiting[] }; projects: ProjectRow[]; goals: GoalRow[]; answers: AnswerRow[]; inbox: InboxGroup[]; archived: number; needs: NeedRow[]; openQuestions: { q: number; from?: string; question?: string }[]; unread: number; total: number; threads: ThreadRow[]; closed: ClosedRow[]; budget: string; spend: Spend | null; desk: DeskInfo; errors: string[]; deskModel?: string; deskModelSet?: string }
export const ANSWERS_MAX = 200 // rows the view hands the pane (it draws only what is unfolded)
export const CLOSED_MAX = 40
export const ARCHIVE_MS = 7 * 86_400_000 // a read inbox row older than this is hidden in the pane (it stays in inbox.jsonl)
export const READ_SHOWN = 5 // read rows drawn per thread until "show all"
export const OVER_PCT = 80 // the desk context bar turns yellow, and Restart desk appears beside it, from here

// ---- a thread's one-word state and its colour (theme keys) ----------------------------------------------------------------
export type StateWord = 'parked' | 'paused' | 'waiting' | 'approval' | 'blocked' | 'asking' | 'working' | 'done' | 'idle'
export const stateOf = (t: ThreadRow): { word: StateWord; color: string } => {
  if (t.run === 'parked') return { word: 'parked', color: 'inactive' }
  if (t.pausedUntil) return { word: 'paused', color: 'warning' }
  if (t.needsYou) return { word: 'waiting', color: 'warning' }
  if (t.approval) return { word: 'approval', color: 'warning' }
  if (t.blocked) return { word: 'blocked', color: 'error' }
  if (t.asking) return { word: 'asking', color: 'warning' }
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
  if (!project || !/^[\w.-]+$/.test(project)) return { verdict: 'none' }
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
  const v: View = { scripts: { candidates: 0, adopted: 0, needsUpdate: 0, waiting: [] }, projects: [], goals: [], answers: [], inbox: [], archived: 0, needs: [], openQuestions: [], unread: 0, total: 0, threads: [], closed: [], budget: 'n/a', spend: null, desk: { context: 0, limit: 0, model: '', effort: '', note: '' }, errors: [] }
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
    v.answers = recs
      .map((rec, n) => ({ n, rec, unread: isUnread(n) }))
      .sort((a, b) => Number(b.unread) - Number(a.unread) || b.n - a.n)
      .slice(0, ANSWERS_MAX)
  })
  await guard('questions', async () => { v.openQuestions = await openQuestions(h) })
  const rows = new Map<string, { run: boolean; working: boolean; needsYou: boolean; limit: boolean }>()
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
    for (const a of parseAgents(r.stdout)) rows.set(a.sid, { run: isRunning(a), working: isWorking(a), needsYou: needsYou(a), limit: isLimitRow(a) })
  })
  const asking = new Set<string>()
  const owner = new Map<string, string>() // tN -> last record text
  const lastRec = new Map<string, DeskRec>() // tN -> its last record (report or question)
  const recsOf = new Map<string, DeskRec[]>() // tN -> its records, oldest first
  for (const r of recs.slice(read)) if (r.kind === 'ask') asking.add(r.from)
  for (const r of recs) {
    owner.set(r.from, r.text)
    lastRec.set(r.from, r)
    recsOf.set(r.from, [...(recsOf.get(r.from) ?? []), r])
  }
  // spend first: a thread card shows what the thread cost today
  await guard('budget', async () => {
    v.spend = await loadBudget(h, home)
    v.budget = v.spend ? spendText(v.spend) : 'n/a'
  })
  const reviews: Reviews = new Map()
  await guard('threads', async () => {
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
      for (const r of [...(recsOf.get(t.id) ?? [])].slice(-6).reverse()) {
        if (r.kind !== 'report') continue
        branch ??= branchIn(r.text)
        for (const c of shasIn(r.text)) {
          const o = await reviewOf(h, home, t.project, c, reviews)
          if (!o.full) continue
          sha = o.full.slice(0, 7)
          review = o.verdict
          branch = o.branch ?? branch
          break
        }
        if (sha) break
      }
      const isDone = !!lr && lr.kind === 'report' && lr.state === 'done'
      v.threads.push({
        lastReport: flat(lr?.text ?? '') || flat(lastLine(typeof notes === 'string' ? notes : '')),
        ...(branch ? { branch } : {}),
        ...(sha ? { sha } : {}),
        review,
        cost: v.spend?.byThread[t.id] ?? 0,
        ready: t.state === 'open' && isDone && review === 'green' && !claimsPushed(lr?.text ?? ''),
        recTs: lr?.ts ?? 0,
        id: t.id,
        title: t.title,
        model: t.model,
        effort: t.effort,
        state: t.state,
        run: t.state === 'parked' ? 'parked' : running ? 'running' : 'idle',
        last: lastLine(typeof notes === 'string' ? notes : '') || owner.get(t.id) || '',
        resumable: t.state === 'open' && !running && agentsOk,
        working: (!!ag?.working && !paused) || !agentsOk, // an unreadable listing is never "not working": nothing is closed on a guess
        done: isDone,
        asking: asking.has(t.id) || lr?.kind === 'ask',
        blocked: !!lr && lr.kind === 'report' && lr.state === 'blocked',
        needsYou: !!ag?.needsYou && !paused,
        ...(lr && t.state === 'open' && approvalOf(lr) ? { approval: approvalOf(lr) } : {}), // its last record is a blocked report that waits for the user's yes
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
    }
  })
  // the header chip (the pinned model and effort, or what it really runs when that is another) and the context bar
  await guard('desk', async () => {
    const pin = await deskChoice(h, home)
    v.desk = { context: contextSize(), limit: await deskTokens(h), model: deskRuns || pin.model, effort: deskRuns ? '' : pin.effort, note: deskNote() }
  })
  // what the mod set is information, not an error: a dim line at the top, not a red one (and not counted in a thread's status line)
  const setNote = await peekNotice(h, NOTICE_SET)
  if (setNote) v.deskModelSet = setNote
  v.errors.push(...(await readNotices(h)).filter(n => n !== deskModelNote && n !== setNote))
  // the inbox by thread, read rows older than a week hidden (they stay in inbox.jsonl)
  const g = groupInbox(v.answers, now, new Map(v.threads.map(t => [t.id, t.title] as const)))
  v.inbox = g.groups
  v.archived = g.archived
  v.answers = v.answers.filter(a => !archivedRow(a, now))
  v.needs = needsOf(v)
  return v
}

// what waits for the user, in the order the pane draws it: approvals, questions, ready reports, blocked threads, scripts, the desk's size
export function needsOf(v: Pick<View, 'threads' | 'openQuestions' | 'scripts' | 'desk'>): NeedRow[] {
  const out: NeedRow[] = []
  const title = (id: string) => v.threads.find(t => t.id === id)?.title ?? ''
  for (const t of v.threads) if (t.approval) out.push({ key: `approval:${t.id}:${t.recTs}`, kind: 'approval', thread: t.id, text: `${t.id} needs your yes in its own session: ${t.approval}`, notify: true })
  for (const q of v.openQuestions) out.push({ key: `ask:${q.q}`, kind: 'question', thread: q.from, text: `${q.from ?? 'desk'} asks: ${flat(q.question ?? '')}`, notify: true })
  for (const t of v.threads) if (t.ready) out.push({ key: `push:${t.id}:${t.sha}`, kind: 'push', thread: t.id, text: `${t.id} ${title(t.id) ? `${flat(title(t.id)).slice(0, 60)} ` : ''}is ready to push (${t.sha}${t.branch ? ` on ${t.branch}` : ''}, review green): ask the desk to push`, notify: true })
  for (const t of v.threads) {
    if (t.approval || t.run === 'parked' || t.pausedUntil) continue
    if (t.needsYou) out.push({ key: `waiting:${t.id}`, kind: 'blocked', thread: t.id, text: `${t.id} waits on a prompt in its own session`, notify: true })
    else if (t.blocked) out.push({ key: `blocked:${t.id}:${t.recTs}`, kind: 'blocked', thread: t.id, text: `${t.id} is blocked: ${t.lastReport.slice(0, 160)}`, notify: true })
  }
  for (const w of v.scripts.waiting.slice(0, 8)) out.push({ key: `script:${w.name}:${w.update ?? ''}`, kind: 'script', text: `${w.name}${w.update ? ` ${w.update}` : ''} (${w.project}) waits for you: ${flat(w.why).slice(0, 80)}`, notify: false, script: w })
  if (v.desk.limit > 0 && (v.desk.context >= v.desk.limit || v.desk.note)) out.push({ key: 'context', kind: 'context', text: v.desk.note || `desk context ${Math.round(v.desk.context / 1000)}k is over its limit (${Math.round(v.desk.limit / 1000)}k)`, notify: false })
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
