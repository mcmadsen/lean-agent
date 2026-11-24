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
// 1.0.31: kind 'todo' (an open item in the thread's task list: structural, no phrase; "Continue: <title>. Do it now ...", 6 in a row, then one notice), kind 'remind' (a
// last paragraph conditional on an event while waitevent.ts finds nothing that wakes the thread; at most 2 per thread), and NO continue of any kind while waitingOn() holds.
// Keep-going is on by default (config threads.keepGoing, `keep-going off` wins; keepGoingOf). Every todo / next / remind continue is one line in continue-log.jsonl and counted.
// 1.0.32: kind 'end' (endnudge.ts: the report rule): a turn that ends with no final report and nothing above to continue is nudged ONCE ("end with lean_report ...", at most 2 an hour a
// thread, threads.endNudge), takes precedence over 'keep', and is recorded for the desk's alert (stall.ts).
// Config: threads.autoContinue (default true; false = no 'next' / 'todo' / 'remind' continues), threads.continueSeconds (default 20), threads.keepGoing (default true). Every check is repeated when the tick acts:
// only an OPEN thread whose session is the recorded one (never parked, closed, finished) is continued.
import { appendJsonl, homeDir, readJson, readJsonl, threadsDir, writeJson, leanDir } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import { setNotice } from './notices'
import { turnState } from './autorestart'
import { readStop } from './contextstop'
import { liveOf, readActivity, readWaiting, stillWaiting } from './threadstate'
import { NEXT_CONDITIONAL, NEXT_LINE, NEXT_PHRASE, NEXT_SENTENCE } from './nextwords'
import { waitingOn } from './waitevent'
import { announcesRestart, requestCheckpoint } from './checkpoint'
import { markerOf } from './reviewkind'
import { HINT_KEY, MAX_NUDGES_PER_HOUR, NUDGE_TEXT, clearEnded, endNudgeOn, hasUnverifiedClaim, noteEnded, requireReportOn, singleAction } from './endnudge'
import { readSnapshot, tasksOf } from './snapshot'
import type { SnapTask } from './snapshot'
import type { AgentRow, Out, Thread } from './threads'

export const CONTINUE_SECONDS = 20
export const MAX_CONSECUTIVE = 3 // 'next' continues in a row with no tool call between them
export const MAX_PER_HOUR = 30 // keep-going continues per hour
export const TEXT_MAX = 200
export const NEXT_TEXT = (text: string) => `Do the next step now: ${text}. Do not report again before you have made progress.`
export const KEEP_TEXT = 'Continue with the next step of your task.'
export const MAX_TODO_CONSECUTIVE = 6 // 'todo' continues in a row with no tool call and no changed task list between them
export const TODO_TEXT = (title: string) => `Continue: ${title}. Do it now; do not end your turn announcing the next step.`
export const REMIND_MAX = 2 // reminders per thread
export const REMIND_TEXT = "Nothing is pending that wakes you: if you wait for the push, request it with lean_report ('ready to push <sha>'); if you wait for the user, ask with lean_ask; otherwise do the step now."
export const remindCapText = (id: string) => `${id} ends its turns waiting for something nothing will deliver (reminded ${REMIND_MAX} times): it needs a message from you`
export const haltTodoText =(id: string) => `${id} keeps ending its turns without doing the next item`
export const haltText = (id: string) => `${id} keeps stopping after 'next:'`
export const capText = (id: string) => `${id} (keep-going) was continued ${MAX_PER_HOUR} times in the last hour and keeps stopping: no more automatic continues for now`

export type Kind = 'next' | 'keep' | 'todo' | 'remind' | 'end'
export type Pending = { at: number; sid: string; kind: Kind; text: string; sig?: string; req?: boolean /* 'end' of a single-action brief (threads.requireReport): sent at once, with the whole rule */ } // sig: the task list at the turn end ('todo'): a changed list lifts the loop guard
export type CState = { endHour?: number[]; consec?: number; sentAt?: number; hour?: number[]; halted?: number; noticedHour?: number; todoRun?: number; todoSig?: string; keepRun?: number; total?: number; noticedFirst?: boolean; remindN?: number; remindNoticed?: boolean }
export const logFile = (home: string, id: string) => `${threadsDir(home)}/${id}/continue-log.jsonl`
export const continuedLine = (kind: Kind, text: string): string => kind === 'end' ? 'nudged by the mod: its turn ended without a report' : kind === 'remind' ? 'reminded by the mod: nothing is pending that wakes it' : `continued by the mod: ${kind === 'todo' ? `open ${text}` : `announced "${text || 'the step it announced'}"`}`
export const pendingFile = (home: string, id: string) => `${threadsDir(home)}/${id}/continue-pending.json`
export const stateFile = (home: string, id: string) => `${threadsDir(home)}/${id}/continue-state.json`
export const readPending = async (h: Host, home: string, id: string): Promise<Pending | null> => {
  const p = await readJson<Partial<Pending> | null>(h, pendingFile(home, id), null)
  return p && typeof p === 'object' && Number(p.at) > 0 && typeof p.sid === 'string' && (p.kind === 'next' || p.kind === 'keep' || p.kind === 'todo' || p.kind === 'remind' || p.kind === 'end') ? { at: Number(p.at), sid: p.sid, kind: p.kind, text: typeof p.text === 'string' ? p.text : '', ...(typeof p.sig === 'string' ? { sig: p.sig } : {}), ...(p.req === true ? { req: true } : {}) } : null
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

export async function continueConfig(h: Host, home: string): Promise<{ auto: boolean; seconds: number; keepGoing: boolean }> {
  const t = (await readJson<{ threads?: { autoContinue?: unknown; continueSeconds?: unknown; keepGoing?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null))?.threads
  const s = Number(t?.continueSeconds)
  return { auto: t?.autoContinue !== false, seconds: Number.isFinite(s) && s > 0 ? s : CONTINUE_SECONDS, keepGoing: t?.keepGoing !== false }
}
// Is the standing order "keep going" in force for this thread? The thread's own `keep-going on|off` (thread.json keepGoing true|false) wins; without one the config
// threads.keepGoing (default true) decides, for a work thread: a review thread (marker in the mod's store) is never covered by the default.
export async function keepGoingOf(h: Host, t: { id: string; keepGoing?: unknown }, cfgKeep: boolean): Promise<boolean> {
  if (t.keepGoing === true) return true
  if (t.keepGoing === false || !cfgKeep) return false
  return !(await markerOf(h, t.id).catch(() => null))
}

// ---- what a last text announces (pure) ----------------------------------------------------------------------------------------------
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
export const isQuestion = (text: string): boolean => /\?\s*[)"'*_`]*\s*$/.test(text.trim())
// the announced next action of a turn's last text, or null (no announcement, or the text ends in a question)
// the last paragraph of a text, flattened and lower-cased
const lastParagraph = (text: string): string => flat(text.trim().split(/\n\s*\n/).pop() ?? '').toLowerCase()
// the last paragraph is conditional on an external event ("once the desk reports the push, ...", "waiting for ...": nextwords.ts NEXT_CONDITIONAL)
export const isConditional = (text: unknown): boolean => typeof text === 'string' && !!text.trim() && !isQuestion(text) && NEXT_CONDITIONAL.some(re => re.test(lastParagraph(text)))
export function announcedNext(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim() || isQuestion(text) || isConditional(text)) return null
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  const low = last.toLowerCase()
  for (const re of NEXT_LINE) {
    const m = re.exec(low)
    if (m) return flat(last.slice(last.length - (m[1] ?? '').length)).replace(/[.!*_`]+$/, '').slice(0, TEXT_MAX) || null
  }
  const sentencesOf = (s: string) => (s.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [s]).map(x => x.trim()).filter(Boolean)
  const textOf = (sent: string, re: RegExp): string | null => {
    const m = re.exec(sent.toLowerCase())
    return m ? flat(sent.slice(sent.length - (m[1] ?? '').length)).replace(/[.!*_`]+$/, '').slice(0, TEXT_MAX) || flat(sent).slice(0, TEXT_MAX) : null
  }
  const sentences = sentencesOf(last)
  const sent = sentences[sentences.length - 1] ?? ''
  for (const re of NEXT_SENTENCE) {
    const t = textOf(sent, re)
    if (t) return t
  }
  // the whole last paragraph: an announcement followed by a sentence or two of detail ("... I'm continuing with the seed data. Both tables are in place.")
  const paragraph = text.trim().split(/\n\s*\n/).pop() ?? ''
  const all = sentencesOf(flat(paragraph))
  for (let i = all.length - 1; i >= 0; i--) {
    for (const re of NEXT_PHRASE) {
      const t = textOf(all[i]!, re)
      if (t) return t
    }
  }
  return null
}

// ---- the task list (structural: no phrase decides anything here) --------------------------------------------------------------------
const OPEN = new Set(['pending', 'in_progress', 'in-progress', 'in progress', 'open', 'todo'])
export const firstOpen = (tasks: SnapTask[]): SnapTask | null => tasks.find(t => OPEN.has(t.status.toLowerCase())) ?? null
export const tasksSig = (tasks: SnapTask[]): string => tasks.map(t => `${t.status}:${t.text}`).join('|').slice(0, 2_000)
// the thread's task list at this turn end: the one the mod passes, else the snapshot the same turn end wrote (state.json: this session, not older than the turn)
async function tasksOfTurn(h: Host, home: string, id: string, o: TurnEndIn): Promise<SnapTask[]> {
  if (o.tasks !== undefined) return tasksOf(o.tasks)
  const s = await readSnapshot(h, home, id)
  return s && s.sid === o.sid && s.at >= o.since ? tasksOf(s.tasks) : []
}

// ---- thread side -------------------------------------------------------------------------------------------------------------------
export type TurnEndIn = { sid: string; since: number; lastText?: string | null; tasks?: unknown }
// Returns what was recorded: 'next' | 'keep' | 'todo' | 'remind' | 'end' (the report-rule nudge, endnudge.ts) | 'none'. Never throws (the turn end is not the place for a failure).
export async function noteTurnEnd(h: Host, id: string, o: TurnEndIn): Promise<Kind | 'none'> {
  try {
    const home = await homeDir(h)
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    if (!t || t.state !== 'open' || t.finished || !o.sid) return await drop(h, home, id)
    if (await readStop(h, home, id, o.sid)) return await drop(h, home, id) // hard-stopped at the context limit: the restart path's
    const st = turnState(await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`), id, o.since)
    if (st !== 'work') return await drop(h, home, id) // done, blocked, a question, a request the user must answer
    // a thread that waits for an external event by RECORD (the desk's push result, an action result, an answer, a CI run: waitevent.ts) is never continued, whatever it said
    if (await waitingOn(h, home, id)) return await drop(h, home, id)
    const cfg = await continueConfig(h, home)
    const announced = typeof o.lastText === 'string' ? announcedNext(o.lastText) : null
    const question = typeof o.lastText === 'string' && isQuestion(o.lastText)
    // the open-TODO rule (1.0.31): an open item in the task list and a turn that is not done / blocked / waiting / a question / a pending request: the work is not finished
    const tasks = await tasksOfTurn(h, home, id, o)
    const open = cfg.auto && !question && !(announced && announcesRestart(announced)) ? firstOpen(tasks) : null
    let kind: Kind | null = null
    // a last paragraph that waits for an event ("once the desk reports the push ...") while no record will ever wake the thread: ONE reminder instead of "do it now" (it must
    // not do the step before the event); at most REMIND_MAX per thread (the tick), then one desk notice
    if (cfg.auto && isConditional(o.lastText)) kind = 'remind'
    else if (open) kind = 'todo'
    else if (announced && cfg.auto) kind = 'next'
    // the report rule (1.0.32, endnudge.ts): none of the above and no final report in this turn = "ended without a report": the record, and ONE nudge (kind 'end', at most
    // MAX_NUDGES_PER_HOUR an hour; over that the keep-going continue below is what it was)
    const endOn = !kind && (await endNudgeOn(h, home))
    const now = await h.clock.now()
    if (endOn) {
      const hint = hasUnverifiedClaim(o.lastText)
      await noteEnded(h, home, id, { sid: o.sid, now, hint, recs: await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`) })
      if (((await readCState(h, home, id)).endHour ?? []).filter(x => now - x < 3_600_000).length < MAX_NUDGES_PER_HOUR) {
        // threads.requireReport (default true) and a brief that asks for ONE action: the nudge goes out at the next tick, not after continueSeconds, and carries the whole rule
        // (the engine gives a mod no way to refuse a Stop: turn.complete returns text only, so this is the refusal's fallback)
        const req = (await requireReportOn(h, home)) && singleAction(await Promise.resolve(h.fs.read(`${threadsDir(home)}/${id}/brief.md`)).catch(() => ''))
        await writeJson(h, pendingFile(home, id), { at: now, sid: o.sid, kind: 'end', text: hint ? HINT_KEY : '', ...(req ? { req: true } : {}) } satisfies Pending)
        return 'end'
      }
    } else await clearEnded(h, home, id) // continued by an open task / announcement / reminder, or the nudge is off: not an unreported end
    if (!kind && !question && (await keepGoingOf(h, t, cfg.keepGoing))) kind = 'keep'
    if (!kind) return await drop(h, home, id, endOn)
    await writeJson(h, pendingFile(home, id), { at: now, sid: o.sid, kind, text: kind === 'todo' ? open!.text : kind === 'remind' ? '' : (announced ?? ''), ...(kind === 'todo' ? { sig: tasksSig(tasks) } : {}) } satisfies Pending)
    return kind
  } catch {
    return 'none'
  }
}
async function drop(h: Host, home: string, id: string, keepEnd = false): Promise<'none'> {
  await clearPending(h, home, id)
  if (!keepEnd) await clearEnded(h, home, id) // a final report, a question, a wait, a stop, a closed thread: nothing ended unreported
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
    if (act && TOOL_KINDS.has(act.kind) && act.at > (cs.sentAt ?? 0) && ((cs.consec ?? 0) > 0 || (cs.todoRun ?? 0) > 0 || (cs.keepRun ?? 0) > 0 || cs.halted)) {
      if (cs.halted) await setNotice(h, `continue-${id}`, null).catch(() => undefined)
      await save({ ...cs, consec: 0, todoRun: 0, keepRun: 0, halted: undefined })
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
    if (!p.req && now - p.at < cfg.seconds * 1000) continue
    // the report-rule nudge (kind 'end'): threads.endNudge decides, not autoContinue; at most MAX_NUDGES_PER_HOUR a thread an hour (then only the desk alert, stall.ts)
    if (p.kind === 'end' && (!(await endNudgeOn(h, home)) || (cs.endHour ?? []).filter(x => now - x < 3_600_000).length >= MAX_NUDGES_PER_HOUR)) {
      await clearPending(h, home, id)
      continue
    }
    if (p.kind !== 'keep' && p.kind !== 'end' && !cfg.auto) {
      await clearPending(h, home, id)
      continue
    }
    if (p.kind === 'keep' && !(await keepGoingOf(h, t, cfg.keepGoing))) {
      await clearPending(h, home, id) // keep-going was switched off meanwhile
      continue
    }
    // by the default (no `keep-going on` of the user's): a thread that ends its turn 6 times in a row without a tool call has nothing left to do (a finished thread that did not
    // report): silent, no alarm
    if (p.kind === 'keep' && t.keepGoing !== true && (cs.keepRun ?? 0) >= MAX_TODO_CONSECUTIVE) {
      await clearPending(h, home, id)
      continue
    }
    const w = await readWaiting(h, home, id)
    if ((w && stillWaiting(w, act?.at)) || (await readStop(h, home, id, t.sid)) || (await waitingOn(h, home, id))) {
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
    // 'remind': at most REMIND_MAX per thread, then ONE desk notice
    if (p.kind === 'remind' && (cs.remindN ?? 0) >= REMIND_MAX) {
      await clearPending(h, home, id)
      if (!cs.remindNoticed) {
        await save({ ...cs, remindNoticed: true })
        out.push({ id, text: remindCapText(id) })
      }
      continue
    }
    // 'todo': the same open list again and again with no tool call between is a loop: at most MAX_TODO_CONSECUTIVE, then ONE notice (a changed list or a tool call lifts it)
    const sameList = p.kind === 'todo' && p.sig === cs.todoSig
    const todoRun = p.kind === 'todo' && sameList ? (cs.todoRun ?? 0) : 0
    if (p.kind === 'todo' && !sameList && cs.halted) {
      await setNotice(h, `continue-${id}`, null).catch(() => undefined)
      await save({ ...cs, halted: undefined, todoRun: 0 })
    }
    if (p.kind === 'todo' && todoRun >= MAX_TODO_CONSECUTIVE) {
      await clearPending(h, home, id)
      if (!cs.halted) {
        await save({ ...cs, halted: now })
        const text = haltTodoText(id)
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
    const r = await deps.send(id, p.kind === 'end' ? NUDGE_TEXT(p.text === HINT_KEY, p.req === true) : p.kind === 'remind' ? REMIND_TEXT : p.kind === 'todo' ? TODO_TEXT(p.text) : p.kind === 'next' ? NEXT_TEXT(p.text || 'the step you announced') : KEEP_TEXT)
    await clearPending(h, home, id)
    if (!r.ok) continue
    if (p.kind === 'end') {
      // one nudge per ended turn, counted per hour (the cap above); one line in the thread's record, never announced to the desk (the alert of stall.ts is the desk's word)
      await save({ ...cs, sentAt: now, endHour: [...(cs.endHour ?? []).filter(x => now - x < 3_600_000), now] })
      await appendJsonl(h, logFile(home, id), { at: now, kind: 'end', text: continuedLine('end', '') }).catch(() => undefined)
      continue
    }
    // the desk sees it (1.0.31): a continue by the open-TODO rule or an announcement is one line in the thread's record and one in the count of `lean_thread list`; the FIRST
    // one of a thread is also said once in the desk, the rest are only counted. (A plain keep-going continue is the standing order's own: not counted.)
    const counted = p.kind !== 'keep'
    const first = counted && !cs.noticedFirst
    await save({ ...cs, sentAt: now, hour: [...hour, now], ...(p.kind === 'next' ? { consec: (cs.consec ?? 0) + 1 } : {}), ...(p.kind === 'todo' ? { todoRun: todoRun + 1, todoSig: p.sig } : {}), ...(p.kind === 'keep' ? { keepRun: (cs.keepRun ?? 0) + 1 } : {}), ...(p.kind === 'remind' ? { remindN: (cs.remindN ?? 0) + 1 } : {}), ...(counted ? { total: (cs.total ?? 0) + 1, noticedFirst: true } : {}) })
    if (counted) {
      const line = continuedLine(p.kind, p.text)
      await appendJsonl(h, logFile(home, id), { at: now, kind: p.kind, text: line }).catch(() => undefined)
      if (first) out.push({ id, text: `${id} was ${line} (further continues are counted in the list, not announced)` })
    }
  }
  return out
}
