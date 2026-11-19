// The desk's own context. A desk session lives for days: when it is idle and over its limit (config.json `deskTokens`, default 200000)
// the mod compacts it (`$.session.compact` with fixed instructions). Every compaction that was vetoed or failed is recorded with its
// reason (desk/compact.json, a notice, the doctor check) and tried again when the desk's turn ends. When compaction is not possible
// the mod writes desk/handover.md and the status line asks the user to type /compact or start a new desk session, which reads it.
// "Restart desk" (pane button, /lean-agent-restart-desk) writes the same handover on demand and opens a new desk session.
//
// Threads have no size trigger: a thread that reports done is finished as a session (finish.ts), and the pane's Restart button starts
// a new session of a thread when its context is large.
import { atomicWrite, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { readConfig } from './budget'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import { openQuestions } from './extras'
import { waitingScripts } from './scripts'
import { setNotice } from './notices'
import type { Thread } from './threads'

export const DEFAULT_TOKENS = 200_000
export const MIN_TOKENS = 10_000 // a smaller configured value is ignored (a compaction every few turns would be worse than none)
export const DESK_RETRY_MS = 10 * 60_000 // after a vetoed or failed compaction, when no turn end comes sooner
const SOON_MS = 30_000

// config.json `deskTokens` (default 200000). The 1.0.6 key `checkpoint.deskTokens` is still read when `deskTokens` is not set.
export async function deskTokens(h: Host): Promise<number> {
  const c: any = await readConfig(h, await homeDir(h))
  const v = c?.deskTokens ?? c?.checkpoint?.deskTokens
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_TOKENS ? Math.floor(v) : DEFAULT_TOKENS
}

export type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null | undefined
// what the request was answered over: uncached, cache-read and cache-written input together
export const contextTokens = (u: Usage): number => (u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0)
export const kTokens = (n: number) => `${Math.round(n / 1000)}k`

// ---- the session's context size (main loop only) -----------------------------------------------------------------
let ctxTokens = 0
let sawUsage = false // a request of this session reported its usage (after a compaction the size is unknown until the next one)
export const noteUsage = (u: Usage): void => {
  const n = contextTokens(u)
  if (n > 0) {
    ctxTokens = n
    sawUsage = true
  }
}
export const hasUsage = (): boolean => sawUsage
export const contextSize = (): number => ctxTokens
export const forgetContext = (): void => {
  ctxTokens = 0 // after a compaction: the next request tells the new size
}

export const DESK_COMPACT_INSTRUCTIONS =
  "lean-agent desk compaction. KEEP: the user's goals; the open threads table (id, title, project, state, last report line); every unanswered thread question; the user's stated preferences and decisions of this session; pending approvals. DROP: tool outputs and old report texts (they are in the desk inbox, ~/.lean-agent/desk/inbox.jsonl)."

export type DeskDeps = {
  tokens: () => Promise<number> // the desk's current context size
  busy: () => boolean // a desk turn is running
  compact: (instructions: string) => Promise<unknown> // $.session.compact; a rejection or a missing function = not possible
  notes: () => Promise<void> // the compaction notes (the session.compact hook does not run for the plugin's own call)
  recent: () => Promise<string[]> // the user's latest messages, for the handover file
  sid?: () => string // this desk session's id: recorded in the handover, so this session's own start never consumes it
  status: (text: string) => void
  reset: () => void // forget the context size: the next request tells the new one
}
// fallback: the size the handover file was written at (0 = none); again: try at the turn's end; vetoes: in a row; episode: a failure or a
// veto is on record and not yet settled
type Desk = { retryAt: number; fallback: number; rejected: number; again: boolean; vetoes: number; episode: boolean }
const freshDesk = (): Desk => ({ retryAt: 0, fallback: 0, rejected: 0, again: false, vetoes: 0, episode: false })
export const MAX_VETOES = 3 // vetoes in a row before the handover file and the /compact line
let ds: Desk = freshDesk()
export const resetDeskCompact = (): void => {
  ctxTokens = 0
  sawUsage = false
  ds = freshDesk()
}
// an engine without session.compact (a TypeError, "not available"): no retry will help
const hopeless = (e: unknown) => e instanceof TypeError || /not a function|session\.compact is not available|no implementation/i.test(String((e as Error)?.message ?? e))
// the sentence the pane footer and the status line carry while the mod could not compact
export const deskNote = (): string => (ds.fallback ? `desk context ${kTokens(ds.fallback)}: type /compact (or start a new desk session; it reads the handover)` : '')

// a vetoed or failed compaction is tried again when the desk's turn ends (register.tsx calls deskTick then)
export const deskRetryWanted = (): boolean => ds.again
export const deskTurnEnded = (): void => {
  if (ds.again) ds.retryAt = 0
}

// ---- the record of the last compaction (desk/compact.json): the doctor shows it, a notice tells the user ----------------
export type CompactRec = { ts: number; tokens: number; result: 'compacted' | 'vetoed' | 'failed'; reason?: string }
const recFile = (home: string) => `${deskState(home)}/compact.json`
export async function lastCompaction(h: Host): Promise<CompactRec | null> {
  const r = await readJson<CompactRec | null>(h, recFile(await homeDir(h)), null)
  return r && typeof r === 'object' && typeof r.result === 'string' ? r : null
}
async function record(h: Host, tokens: number, result: CompactRec['result'], reason?: string): Promise<void> {
  try {
    await writeJson(h, recFile(await homeDir(h)), { ts: await h.clock.now(), tokens, result, ...(reason ? { reason: reason.slice(0, 200) } : {}) } satisfies CompactRec)
  } catch {
    /* the record is best effort */
  }
  await setNotice(h, 'desk-compaction', result === 'compacted' ? null : `desk compaction ${result} at ${kTokens(tokens)}: ${reason || 'no reason given'}; it is tried again when the turn ends`)
}
const why = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 160) || 'no reason given'

export async function deskTick(h: Host, d: DeskDeps): Promise<'compacted' | 'skipped' | 'fallback' | 'busy' | 'quiet'> {
  const limit = await deskTokens(h)
  const tokens = await d.tokens().catch(() => 0)
  if (tokens < limit) {
    if (ds.fallback) d.status('') // the "type /compact" line goes away with the reason for it
    if (ds.episode) await record(h, tokens, 'compacted', 'the context is below the limit again') // the notice and the doctor row go with it
    ds.fallback = 0
    ds.rejected = 0
    ds.vetoes = 0
    ds.again = false
    ds.episode = false
    return 'quiet'
  }
  if (d.busy()) return 'busy'
  const now = await h.clock.now()
  if (now < ds.retryAt) {
    if (ds.fallback) d.status(deskNote()) // a status line may have been replaced meanwhile
    return ds.fallback ? 'fallback' : 'quiet'
  }
  ds.retryAt = now + DESK_RETRY_MS // whatever happens next, not again before this (a turn's end brings it forward)
  ds.again = false
  if (!ds.episode) await d.notes().catch(() => undefined) // (once per episode: a retry would append the same notes again)
  let res: any
  try {
    res = await d.compact(DESK_COMPACT_INSTRUCTIONS)
  } catch (err) {
    if (d.busy()) {
      ds.retryAt = now + SOON_MS // rejected because a turn started meanwhile: that is no failure, again at its end
      ds.again = true
      return 'busy'
    }
    ds.episode = true
    await record(h, tokens, 'failed', why(err))
    // a rejection can be transient (an API error, a limit): once more at the turn's end; twice in a row, or an engine that has no
    // session.compact, is "not possible": the handover file and the status line
    if (!hopeless(err) && ++ds.rejected < 2) {
      ds.again = true
      return 'skipped'
    }
    await writeDeskHandover(h, tokens, await d.recent().catch(() => []), d.sid?.())
    ds.fallback = tokens
    d.status(deskNote())
    return 'fallback'
  }
  ds.rejected = 0
  if (res && typeof res === 'object' && typeof res.skip === 'string') {
    ds.episode = true
    await record(h, tokens, 'vetoed', res.skip || 'a hook vetoed it')
    if (++ds.vetoes < MAX_VETOES) {
      ds.again = true // a hook vetoed it: at the turn's end
      return 'skipped'
    }
    // vetoed every time: the mod cannot compact, the user can (the notice and the doctor row keep the reason)
    await writeDeskHandover(h, tokens, await d.recent().catch(() => []), d.sid?.())
    ds.fallback = tokens
    d.status(deskNote())
    return 'fallback'
  }
  await record(h, tokens, 'compacted')
  if (ds.fallback) d.status('')
  ds.fallback = 0
  ds.vetoes = 0
  ds.episode = false
  d.reset()
  return 'compacted'
}

// the user's latest messages in the desk's conversation (not lean-agent's own relays), for the handover file; `$` is the session handle
export async function recentUser($: any): Promise<string[]> {
  const m: any = await $.session.messages({ last: 40 })
  return (Array.isArray(m) ? m : []).filter((x: any) => x?.role === 'user' && typeof x.text === 'string' && x.text.trim() && !x.text.startsWith('[lean-agent]')).slice(-6).map((x: any) => x.text as string)
}

// this session's id, '' when the engine gives none (never a made-up one: the handover names its writer by it)
export async function sessionId($: any): Promise<string> {
  const s = await $.session.id()
  return typeof s === 'string' ? s : ''
}

// ---- desk/handover.md ---------------------------------------------------------------------------------------------
const flat = (s: string, n: number) => (s.replace(/\s+/g, ' ').trim().length > n ? s.replace(/\s+/g, ' ').trim().slice(0, n - 1) + '…' : s.replace(/\s+/g, ' ').trim())
const cell = (s: string, n: number) => flat(s, n).replace(/\|/g, '/')
export const handoverFile = (home: string) => `${deskState(home)}/handover.md`

// the last line of the file names the session that wrote it (serveHandover: that session's own start must not consume it)
// (anchored to the END of the file: the user's messages, titles and report texts above it may quote such a comment, and none of them counts)
const WRITER = /\n<!-- lean-agent: written-by-session ([A-Za-z0-9_-]{1,80}) -->\s*$/
const sidOk = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s)
export async function deskHandover(h: Host, tokens: number, recent: string[], sid = ''): Promise<string> {
  const home = await homeDir(h)
  const goals = await readJson<Record<string, { text?: string }>>(h, `${leanDir(home)}/goals.json`, {})
  const recs = await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)
  const last = new Map<string, DeskRec>()
  for (const r of recs) if (r && typeof r.from === 'string') last.set(r.from, r)
  const rows: string[] = []
  let ents: { name: string }[] = []
  try {
    ents = await h.fs.list(threadsDir(home))
  } catch {
    /* no threads */
  }
  for (const e of ents.filter(x => /^t\d+$/.test(x.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))) {
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (!t || t.state === 'closed') continue
    const lr = last.get(t.id)
    rows.push(`| ${t.id} | ${cell(t.title, 50)} | ${cell(t.project || '-', 30)} | ${t.state}${t.finished ? ' (finished: the next message starts a new session)' : ''} | ${lr ? cell(`[${lr.kind === 'ask' ? 'question' : lr.state || 'working'}] ${lr.text}`, 120) : '-'} |`)
  }
  const goalLines = Object.entries(goals && typeof goals === 'object' ? goals : {}).filter(([, g]) => g && typeof g.text === 'string').map(([id, g]) => `- ${id}: ${flat(g.text!, 200)}`)
  const qs = (await openQuestions(h)).map(q => `- ${q.from ?? 'desk'}: ${flat(q.question ?? '', 300)}`)
  const waiting = (await waitingScripts(h).catch(() => [])).map(s => `- script ${s.name} (${s.project}) waits for the user's decision: ${flat(s.why, 120)}`)
  const read = (await readJson<{ n?: number }>(h, `${deskState(home)}/inbox-read.json`, {})).n || 0
  const unread = Math.max(0, recs.length - read)
  const when = new Date(await h.clock.now()).toISOString()
  const parts = [
    `# Desk handover (written ${when}, context ${tokens > 0 ? kTokens(tokens) : 'size unknown'})`,
    `This desk session replaces the previous one (restarted, or its context was too large). Read this at the start, then carry on; the full report texts are in ${deskState(home)}/inbox.jsonl (${unread} row(s) unread), earlier handoff notes in ${deskState(home)}/notes.md.`,
    `## Goals\n${goalLines.length ? goalLines.join('\n') : 'none set'}`,
    `## Open threads\n| id | title | project | state | last report |\n|---|---|---|---|---|\n${rows.length ? rows.join('\n') : '| - | no open threads | | | |'}`,
    `## Unanswered thread questions\n${qs.length ? qs.join('\n') : 'none'}`,
    `## Pending approvals\n${waiting.length ? waiting.join('\n') : 'none known to the mod (a push approval the user gave in the old chat is single use: ask again if needed)'}`,
    recent.length ? `## What the user said last (newest last; their preferences and decisions of the old session are in the old conversation)\n${recent.map(m => `- ${flat(m, 300)}`).join('\n')}` : '',
    sidOk(sid) ? `<!-- lean-agent: written-by-session ${sid} -->` : '',
  ]
  return parts.filter(Boolean).join('\n\n') + '\n'
}

// `sid`: the writing desk session. Unknown, no writer is named (desk.json may still hold an older desk's id): any desk may then serve it.
export async function writeDeskHandover(h: Host, tokens: number, recent: string[], sid = ''): Promise<void> {
  await atomicWrite(h, handoverFile(await homeDir(h)), await deskHandover(h, tokens, recent, sid))
}

// A new desk session's start serves the handover: the file is renamed to handover-read-<date>.md (the last 3 are kept), so a later desk
// never reads a stale one as if it were fresh, and the first prompt names where it is now. null = no handover waiting (or it could not be moved:
// then it stays as it was, and the desk's guide still tells it to read handover.md).
export const KEEP_READ_HANDOVERS = 3
// Only a NEW desk session consumes it: the file names the session that wrote it, and that session's own start (a resume, a compaction, a
// reload) leaves it where it is. A start whose own id is unknown cannot tell, so it leaves a named handover alone too; a handover that
// names no writer (an older file) goes to whichever desk starts.
export async function serveHandover(h: Host, sid = ''): Promise<string | null> {
  try {
    const home = await homeDir(h)
    const from = handoverFile(home)
    if (!(await h.fs.exists(from))) return null
    const body = String(await h.fs.read(from).catch(() => ''))
    const writer = WRITER.exec(body)?.[1]
    if (writer && (!sid || writer === sid)) return null
    const date = new Date(await h.clock.now()).toISOString().slice(0, 19).replace(/:/g, '-')
    let to = `${deskState(home)}/handover-read-${date}.md`
    for (let n = 2; await h.fs.exists(to); n++) to = `${deskState(home)}/handover-read-${date}-${n}.md` // (two starts in one second)
    const written = /^# Desk handover \(written (\S+?),/.exec(body)?.[1] // (its own first line says when)
    const r = await h.process.run(['mv', from, to])
    if (r.exitCode !== 0 || (await h.fs.exists(from))) return null
    const old = (await h.fs.list(deskState(home)).catch(() => [])).filter(f => f.kind === 'file' && /^handover-read-.+\.md$/.test(f.name)).map(f => f.name.replace(/\.md$/, '')).sort().map(n => `${n}.md`) // (the date sorts as text; without the extension, `-2` after the same second sorts after it)
    const drop = old.slice(0, Math.max(0, old.length - KEEP_READ_HANDOVERS)).filter(n => `${deskState(home)}/${n}` !== to)
    if (drop.length) await h.process.run(['rm', '-f', ...drop.map(n => `${deskState(home)}/${n}`)]).catch(() => undefined)
    return `a desk handover${written ? ` (written ${written})` : ''} from an earlier desk session is waiting in ${to}: read it now (goals, open threads, questions, approvals; disregard it if it is old news), then carry on`
  } catch {
    return null
  }
}

// "Restart desk": the handover is written now, then a new desk session is opened (`open` = setup.ts openDesk). The new session reads the
// handover at its start (the desk's CLAUDE.md says so); the old one stays open until the user closes it.
export const DESK_RESTARTED = 'New desk opened with the handover: close this one'
export async function restartDesk(h: Host, o: { recent: () => Promise<string[]>; open: () => Promise<{ ok: boolean; text: string }>; sid?: () => Promise<string> }): Promise<{ ok: boolean; text: string }> {
  const home = await homeDir(h)
  try {
    await writeDeskHandover(h, contextSize(), await o.recent().catch(() => []), await o.sid?.().catch(() => '') || '')
  } catch (e) {
    return { ok: false, text: `desk not restarted: the handover could not be written (${why(e)})` }
  }
  const r = await o.open()
  return r.ok ? { ok: true, text: DESK_RESTARTED } : { ok: false, text: `Handover written to ${handoverFile(home)}, but no new desk was opened: ${r.text}` }
}
