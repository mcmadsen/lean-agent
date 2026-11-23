// A turn that ends with "next: ..." is a stall at once, and continues by script (1.0.28; field: a thread under the standing order "keep going" wrote a report ending
// "next: ...", did nothing for 20 minutes, its context was 112k of 120k, and the user asked why it did not just continue). No model decides any of this.
// Thread side (noteTurnEnd, the thread's own mod at every main-thread turn end, register.tsx): the LAST assistant text of the turn is looked at; when it ends in a line
// that announces a next action (nextwords.ts), nothing came after it, and the thread is not done / blocked / asking / waiting / hard-stopped / parked, the record
// <thread folder>/continue-pending.json {at, sid, kind, text} is written (kind 'next'); in keep-going mode (thread.json keepGoing, `lean_thread keep-going`) every such
// turn end gets one (kind 'keep'). Any other turn end clears it.
// Desk side (continueTick, a timer): `threads.continueSeconds` (default 20) after the record, with no activity newer than it, the message is delivered by script
// (the desk's `send`, deliver-to-thread.ts): "Do the next step now: <text>. Do not report again before you have made progress." (kind 'next') or "Continue with the
// next step of your task." (kind 'keep'). Limits (continue-state.json, the desk's file): 'next' at most 3 in a row without a tool call between them, then ONE desk notice
// "t5 keeps stopping after 'next:'" and the stall state (stall.ts reads `halted`); 'keep' at most 30 per hour, then ONE notice per hour.
// A 'next' text that says the thread wants a fresh session / a restart / that its context is near the cap is not continued: it is a checkpoint restart (checkpoint.ts, 1.0.29).
// Config: threads.autoContinue (default true; false = no 'next' continues), threads.continueSeconds (default 20). Every check is repeated when the tick acts:
// only an OPEN thread whose session is the recorded one (never parked, closed, finished) is continued.
import { homeDir, readJson, readJsonl, threadsDir, writeJson, leanDir } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import { setNotice } from './notices'
import { turnState } from './autorestart'
import { readStop } from './contextstop'
import { liveOf, readActivity, readWaiting, stillWaiting } from './threadstate'
import { NEXT_LINE, NEXT_SENTENCE } from './nextwords'
import { announcesRestart, requestCheckpoint } from './checkpoint'
import type { AgentRow, Out, Thread } from './threads'

export const CONTINUE_SECONDS = 20
export const MAX_CONSECUTIVE = 3 // 'next' continues in a row with no tool call between them
export const MAX_PER_HOUR = 30 // keep-going continues per hour
export const TEXT_MAX = 200
export const NEXT_TEXT = (text: string) => `Do the next step now: ${text}. Do not report again before you have made progress.`
export const KEEP_TEXT = 'Continue with the next step of your task.'
export const haltText = (id: string) => `${id} keeps stopping after 'next:'`
export const capText = (id: string) => `${id} (keep-going) was continued ${MAX_PER_HOUR} times in the last hour and keeps stopping: no more automatic continues for now`

export type Kind = 'next' | 'keep'
export type Pending = { at: number; sid: string; kind: Kind; text: string }
export type CState = { consec?: number; sentAt?: number; hour?: number[]; halted?: number; noticedHour?: number }
export const pendingFile = (home: string, id: string) => `${threadsDir(home)}/${id}/continue-pending.json`
export const stateFile = (home: string, id: string) => `${threadsDir(home)}/${id}/continue-state.json`
export const readPending = async (h: Host, home: string, id: string): Promise<Pending | null> => {
  const p = await readJson<Partial<Pending> | null>(h, pendingFile(home, id), null)
  return p && typeof p === 'object' && Number(p.at) > 0 && typeof p.sid === 'string' && (p.kind === 'next' || p.kind === 'keep') ? { at: Number(p.at), sid: p.sid, kind: p.kind, text: typeof p.text === 'string' ? p.text : '' } : null
}
export const clearPending = (h: Host, home: string, id: string): Promise<void> => writeJson(h, pendingFile(home, id), {}).catch(() => undefined)
export const readCState = async (h: Host, home: string, id: string): Promise<CState> => {
  const s = await readJson<CState | null>(h, stateFile(home, id), null)
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {}
}
// the desk's stall state for a thread that keeps stopping: since when (stall.ts)
export async function haltedSince(h: Host, home: string, id: string): Promise<number | null> {
  const h0 = (await readCState(h, home, id)).halted
  return typeof h0 === 'number' && h0 > 0 ? h0 : null
}

export async function continueConfig(h: Host, home: string): Promise<{ auto: boolean; seconds: number }> {
  const t = (await readJson<{ threads?: { autoContinue?: unknown; continueSeconds?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null))?.threads
  const s = Number(t?.continueSeconds)
  return { auto: t?.autoContinue !== false, seconds: Number.isFinite(s) && s > 0 ? s : CONTINUE_SECONDS }
}

// ---- what a last text announces (pure) ----------------------------------------------------------------------------------------------
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
export const isQuestion = (text: string): boolean => /\?\s*[)"'*_`]*\s*$/.test(text.trim())
// the announced next action of a turn's last text, or null (no announcement, or the text ends in a question)
export function announcedNext(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim() || isQuestion(text)) return null
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  const low = last.toLowerCase()
  for (const re of NEXT_LINE) {
    const m = re.exec(low)
    if (m) return flat(last.slice(last.length - (m[1] ?? '').length)).replace(/[.!*_`]+$/, '').slice(0, TEXT_MAX) || null
  }
  const sentences = (last.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [last]).map(s => s.trim()).filter(Boolean)
  const sent = sentences[sentences.length - 1] ?? ''
  for (const re of NEXT_SENTENCE) {
    const m = re.exec(sent.toLowerCase())
    if (m) return flat(sent.slice(sent.length - (m[1] ?? '').length)).replace(/[.!*_`]+$/, '').slice(0, TEXT_MAX) || flat(sent).slice(0, TEXT_MAX)
  }
  return null
}

// ---- thread side -------------------------------------------------------------------------------------------------------------------
export type TurnEndIn = { sid: string; since: number; lastText?: string | null }
// Returns what was recorded: 'next' | 'keep' | 'none'. Never throws (the turn end is not the place for a failure).
export async function noteTurnEnd(h: Host, id: string, o: TurnEndIn): Promise<Kind | 'none'> {
  try {
    const home = await homeDir(h)
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    if (!t || t.state !== 'open' || t.finished || !o.sid) return await drop(h, home, id)
    if (await readStop(h, home, id, o.sid)) return await drop(h, home, id) // hard-stopped at the context limit: the restart path's
    const st = turnState(await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`), id, o.since)
    if (st !== 'work') return await drop(h, home, id) // done, blocked, a question, a request the user must answer
    const w = await readWaiting(h, home, id)
    if (w && stillWaiting(w, (await readActivity(h, home, id))?.at)) return await drop(h, home, id)
    const cfg = await continueConfig(h, home)
    const announced = typeof o.lastText === 'string' ? announcedNext(o.lastText) : null
    const question = typeof o.lastText === 'string' && isQuestion(o.lastText)
    let kind: Kind | null = null
    if (announced && cfg.auto) kind = 'next'
    else if (t.keepGoing === true && !question) kind = 'keep'
    if (!kind) return await drop(h, home, id)
    await writeJson(h, pendingFile(home, id), { at: await h.clock.now(), sid: o.sid, kind, text: announced ?? '' } satisfies Pending)
    return kind
  } catch {
    return 'none'
  }
}
async function drop(h: Host, home: string, id: string): Promise<'none'> {
  await clearPending(h, home, id)
  return 'none'
}

// ---- desk side ---------------------------------------------------------------------------------------------------------------------
export type ContinueDeps = { agents: () => Promise<AgentRow[] | null>; send: (id: string, text: string) => Promise<Out> }
export type ContinueNotice = { id: string; text: string }
const NEWER_EPS = 0
const TOOL_KINDS = new Set(['tool', 'worker', 'report'])

let ticking = false
export async function continueTick(h: Host, deps: ContinueDeps): Promise<ContinueNotice[]> {
  if (ticking) return []
  ticking = true
  try {
    return await tickOnce(h, deps)
  } catch {
    return [] // a timer never throws
  } finally {
    ticking = false
  }
}

async function tickOnce(h: Host, deps: ContinueDeps): Promise<ContinueNotice[]> {
  const home = await homeDir(h)
  const ids = (await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])).map(e => e.name).filter(n => /^t\d+$/.test(n))
  const cfg = await continueConfig(h, home)
  const out: ContinueNotice[] = []
  let rows: AgentRow[] | null | undefined
  for (const id of ids) {
    const act = await readActivity(h, home, id)
    let cs = await readCState(h, home, id)
    const save = async (n: CState) => {
      cs = n
      await writeJson(h, stateFile(home, id), n).catch(() => undefined)
    }
    // a tool call (or a report) after the last continue ends the "in a row" count and the halt
    if (act && TOOL_KINDS.has(act.kind) && act.at > (cs.sentAt ?? 0) && ((cs.consec ?? 0) > 0 || cs.halted)) {
      if (cs.halted) await setNotice(h, `continue-${id}`, null).catch(() => undefined)
      await save({ ...cs, consec: 0, halted: undefined })
    }
    const p = await readPending(h, home, id)
    if (!p) continue
    const now = await h.clock.now()
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    if (!t || t.state !== 'open' || !t.sid || t.finished || t.sid !== p.sid) {
      await clearPending(h, home, id) // parked, closed, finished or another session: the record is stale
      continue
    }
    if (act && act.at > p.at + NEWER_EPS) {
      await clearPending(h, home, id) // it did something since: not stalled
      continue
    }
    if (now - p.at < cfg.seconds * 1000) continue
    if (p.kind === 'next' && !cfg.auto) {
      await clearPending(h, home, id)
      continue
    }
    if (p.kind === 'keep' && t.keepGoing !== true) {
      await clearPending(h, home, id) // keep-going was switched off meanwhile
      continue
    }
    const w = await readWaiting(h, home, id)
    if ((w && stillWaiting(w, act?.at)) || (await readStop(h, home, id, t.sid))) {
      await clearPending(h, home, id)
      continue
    }
    rows ??= await deps.agents()
    if (!rows) continue // no listing: nothing is claimed, the record stays
    const row = rows.find(a => a.sid === t.sid)
    if (!row || row.pid <= 0 || liveOf(row) === 'gone' || row.state === 'done') {
      await clearPending(h, home, id)
      continue
    }
    if (row.waitingFor || liveOf(row) === 'working') continue // an open prompt is the user's; a working session is re-checked
    // a turn that announces a restart ("my context is near its cap, a fresh session continues ...") IS one (1.0.29, checkpoint.ts): the checkpoint restart from
    // the announced step, never "do the next step now" into the full session. Refused (restarted a moment ago): the thread is told so instead.
    if (p.kind === 'next' && announcesRestart(p.text)) {
      const r = await requestCheckpoint(h, id, { sid: t.sid, next: p.text, source: 'announce' })
      await clearPending(h, home, id)
      if (!r.ok) await deps.send(id, r.text)
      continue
    }
    // limits
    if (p.kind === 'next' && (cs.consec ?? 0) >= MAX_CONSECUTIVE) {
      await clearPending(h, home, id)
      if (!cs.halted) {
        await save({ ...cs, halted: now })
        const text = haltText(id)
        await setNotice(h, `continue-${id}`, text).catch(() => undefined)
        out.push({ id, text })
      }
      continue
    }
    const hour = (cs.hour ?? []).filter(x => now - x < 3_600_000)
    if (p.kind === 'keep' && hour.length >= MAX_PER_HOUR) {
      await clearPending(h, home, id)
      if (!cs.noticedHour || now - cs.noticedHour >= 3_600_000) {
        await save({ ...cs, hour, noticedHour: now })
        out.push({ id, text: capText(id) })
      }
      continue
    }
    // the moment it acts: the thread file again (a park between the read above and here)
    const again = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    if (!again || again.state !== 'open') {
      await clearPending(h, home, id)
      continue
    }
    const r = await deps.send(id, p.kind === 'next' ? NEXT_TEXT(p.text || 'the step you announced') : KEEP_TEXT)
    await clearPending(h, home, id)
    if (r.ok) await save({ ...cs, sentAt: now, hour: [...hour, now], ...(p.kind === 'next' ? { consec: (cs.consec ?? 0) + 1 } : {}) })
  }
  return out
}
