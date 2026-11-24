// The report rule and its enforcement (1.0.32; field: a thread ended its turn with a plain summary that handed over a worker's claim ("mv exited 0 ... ls failed") and
// said "I haven't re-checked that myself"; it never called lean_report, so the desk and the user saw nothing. 1.0.31's alerts did not catch it: keep-going answered the
// summary with a bare "Continue" and went silent after 6 (continuepending.ts), the idle alert is off for a keep-going thread and counts ANY earlier report of the session as
// "reported" (threadstate.ts idleNoReport), and nothing read the text.) No model decides any of this.
// A. THE RULE (REPORT_RULE): one fixed text, injected first in every thread session's system prompt (register.tsx prompt.compose), at the top of the thread guide template and
//    of every plugin agent file (REPORT_RULE_SENTENCE). Never written into the user's CLAUDE.md, rules folders or project files.
// B. Enforcement. Thread side (continuepending.ts noteTurnEnd): a turn that ends with no final report (done / blocked / question), not waiting (waitevent.ts), not hard-stopped,
//    and with no open task / announced next step to continue, is "ended without a report": the record <thread folder>/ended-noreport.json {at, first, sid, hint?, alerted?}
//    and one line in end-log.jsonl (lean_doctor counts them). It also gets ONE internal nudge by the desk's continue timer (kind 'end', NUDGE_TEXT; at most
//    MAX_NUDGES_PER_HOUR a thread an hour). Desk side (stall.ts): the thread is idle, still without a report and waits for nothing threads.idleAlertMinutes after the turn end:
//    ONE desk alert (the desk sees it in its next turn; `lean_thread list` says "ended without a report, N min"). Config threads.endNudge (default true; false = no nudge, no alert).
// Unverified claims: an ending text that matches UNVERIFIED_PHRASES (and no tool call followed it) makes the nudge say: verify it first.
import { appendJsonl, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import { turnState } from './autorestart'
import { waitingOn } from './waitevent'
import { idleNoReport } from './threadstate'

// ---- the rule (A): one place ----------------------------------------------------------------------------------------------------
export const REPORT_RULE_SENTENCE = 'Every turn of yours ends with lean_report (done, blocked or question) or, for a worker, with its answer to the thread.'
export const REPORT_RULE = [
  REPORT_RULE_SENTENCE,
  'Never end a turn with a plain summary, a status, a hedge or a promise of a next step.',
  'A result you did not verify yourself is reported as unverified, with what is missing.',
  'Silence is a failure, the desk cannot see it.',
].join('\n')

export const REPORT_RULE_ID = 'lean-agent:report-rule'
// prompt.compose (register.tsx): a thread session's sections with the rule FIRST (a fixed text, so a `shared` section: the engine wants every shared section before the session ones; never trimmed: it does not pass through the memory size caps); a desk and
// anything that is not a thread are left as they are. Never throws; a result without a sections list is returned unchanged.
export function withReportRule<T>(r: T, kind: string): T {
  const x = r as unknown as { sections?: { id?: string }[] } | null
  if (kind !== 'thread' || !x || !Array.isArray(x.sections)) return r
  return { ...x, sections: [{ id: REPORT_RULE_ID, text: REPORT_RULE, scope: 'shared' }, ...x.sections.filter(s => s?.id !== REPORT_RULE_ID)] } as unknown as T
}

// ---- unverified claims (one list) -----------------------------------------------------------------------------------------------
export const UNVERIFIED_PHRASES: RegExp[] = [
  /\b(?:i|we) (?:have not|haven't|did not|didn't|have yet to|am yet to) (?:re-?check|re-?verif|verif|confirm|validate|test)/i,
  /\bnot (?:yet |been )?(?:re-?checked|verified|confirmed)\b/i,
  /\bunverified\b/i,
  /\bthe (?:worker|reader|agent|subagent) (?:report(?:s|ed)|says|said|claims?|claimed)\b/i,
  /\bworker (?:report(?:s|ed)|says|said|claims?|claimed)\b/i,
  /\bits report says\b/i,
]
export const hasUnverifiedClaim = (text: unknown): boolean => {
  if (typeof text !== 'string' || !text.trim()) return false
  const t = text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ')
  return UNVERIFIED_PHRASES.some(re => re.test(t))
}

// ---- the nudge ------------------------------------------------------------------------------------------------------------------
export const MAX_NUDGES_PER_HOUR = 2
export const HINT_KEY = 'unverified' // the pending record's text when the ending text hands over a claim nobody checked
// req (threads.requireReport, a single-action brief): the whole rule leads the text
export const NUDGE_TEXT = (hint: boolean, req = false): string =>
  (req ? `Refused: your task is one action and you ended your turn without reporting it.\n${REPORT_RULE}\n` : '') +
  'Your turn ended without a lean_report: the desk saw nothing. End with lean_report done, blocked, or a question (lean_ask); if work is left, do it now, never end a turn on a summary or a promise.' +
  (hint
    ? ' Your last text hands over a result you did not check yourself: verify it first (one lean_run ls / stat, or a worker check), then report; report "done (unverified)" with what is missing only if it cannot be verified.'
    : ' If a claim in your text is not verified yet, verify it first (lean_run or a worker check), then report.')
export const alertText = (id: string, ms: number, title: string, nudged = true): string => `${id} ended its turn without a report ${mins(ms)} min ago${title ? ` (${title})` : ''}: ${nudged ? 'it was nudged; ' : ''}ask it for lean_report done / blocked / question`
// was a nudge sent since the first unreported end of this spell? (continue-state.json endHour, the desk's count)
export async function wasNudged(h: Host, home: string, id: string, first: number): Promise<boolean> {
  const cs = await readJson<{ endHour?: unknown } | null>(h, `${threadsDir(home)}/${id}/continue-state.json`, null)
  return Array.isArray(cs?.endHour) && cs!.endHour.some(x => Number(x) >= first)
}
export const endedNote = (ms: number): string => `ended without a report, ${mins(ms)} min`
const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000))

// ---- config ---------------------------------------------------------------------------------------------------------------------
export async function endNudgeOn(h: Host, home: string): Promise<boolean> {
  return (await readJson<{ threads?: { endNudge?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null))?.threads?.endNudge !== false
}

// threads.requireReport (default true): for a thread whose brief asks for ONE action the nudge is immediate and carries the whole rule. The engine gives a mod no way to
// refuse a Stop (turn.complete returns text only), so the nudge is the refusal.
export async function requireReportOn(h: Host, home: string): Promise<boolean> {
  return (await readJson<{ threads?: { requireReport?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null))?.threads?.requireReport !== false
}
// a brief that asks for ONE action: oneStepBrief (firstrequest.ts), the same detection the lite setup uses

// ---- the record (thread side writes, desk side reads) ---------------------------------------------------------------------------
export type EndRec = { at: number; first: number; sid: string; hint?: boolean; alerted?: number }
export const endFile = (home: string, id: string) => `${threadsDir(home)}/${id}/ended-noreport.json`
export const endLogFile = (home: string, id: string) => `${threadsDir(home)}/${id}/end-log.jsonl`
export async function readEnd(h: Host, home: string, id: string): Promise<EndRec | null> {
  const r = await readJson<Partial<EndRec> | null>(h, endFile(home, id), null)
  return r && typeof r === 'object' && Number(r.at) > 0 && Number(r.first) > 0 && typeof r.sid === 'string' ? { at: Number(r.at), first: Number(r.first), sid: r.sid, ...(r.hint === true ? { hint: true } : {}), ...(Number(r.alerted) > 0 ? { alerted: Number(r.alerted) } : {}) } : null
}
export const clearEnded = (h: Host, home: string, id: string): Promise<void> => writeJson(h, endFile(home, id), {}).catch(() => undefined)
// a turn ended without a report: the record (the FIRST unreported end of this spell is kept) and one line of the count
export async function noteEnded(h: Host, home: string, id: string, o: { sid: string; now: number; hint: boolean; recs: DeskRec[] }): Promise<void> {
  try {
    const prev = await readEnd(h, home, id)
    // the same spell: same session and nothing reported (a final report or a question) since its first end
    const same = !!prev && prev.sid === o.sid && turnState(o.recs, id, prev.first) === 'work'
    await writeJson(h, endFile(home, id), { at: o.now, first: same ? prev!.first : o.now, sid: o.sid, ...(o.hint ? { hint: true } : {}), ...(same && prev!.alerted ? { alerted: prev!.alerted } : {}) } satisfies EndRec)
    await appendJsonl(h, endLogFile(home, id), { at: o.now })
  } catch {
    /* an observation: never blocks a turn end */
  }
}
// turns that ended without a report in the last `days` days, over all threads (lean_doctor)
export async function endedCount(h: Host, days = 7): Promise<number> {
  const home = await homeDir(h)
  const since = (await h.clock.now()) - days * 86_400_000
  let n = 0
  for (const e of await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])) {
    if (!/^t\d+$/.test(e.name)) continue
    n += (await readJsonl<{ at?: number }>(h, endLogFile(home, e.name)).catch(() => [] as { at?: number }[])).filter(x => Number(x?.at) >= since).length
  }
  return n
}
export const doctorRow = async (h: Host): Promise<string> => `ok   report rule: injected (threads), ${await endedCount(h)} turns ended without a report in 7 days`

// ---- desk side: is the alert due? -----------------------------------------------------------------------------------------------
// idle for `minutes` since the turn end, still no final report since the first unreported end, waits for nothing (waitevent.ts), same session, open thread
export async function endDue(h: Host, home: string, t: { id: string; state?: string; sid?: string; finished?: unknown }, o: { word: string | undefined; now: number; minutes: number; recs: DeskRec[] }): Promise<{ ms: number; rec: EndRec } | null> {
  if (o.word !== 'idle' || !(o.minutes > 0) || t.state !== 'open' || !t.sid || t.finished || !(await endNudgeOn(h, home))) return null
  const rec = await readEnd(h, home, t.id)
  if (!rec || rec.sid !== t.sid || o.now - rec.at < o.minutes * 60_000) return null
  if (turnState(o.recs, t.id, rec.first) !== 'work') return null
  if (await waitingOn(h, home, t.id)) return null
  return { ms: o.now - rec.first, rec }
}
// the pane chip (1.0.32): "idle, no report 12 min"
export const noReportChip = (ms: number): string => `idle, no report ${mins(ms)} min`
// the 1.0.31 idle alert's condition as ms (threadstate.ts idleNoReport), for the pane: a thread that waits for something (waitevent.ts) is not flagged
export async function idleNoReportMs(h: Host, home: string, t: { id: string; keepGoing?: unknown; lastWake?: unknown; created?: unknown }, o: { word: string | undefined; lastAt: number | null; now: number; minutes: number; lastRec?: { ts: number; kind: string; state?: string } }): Promise<number | null> {
  const idle = idleNoReport({ word: o.word, keepGoing: t.keepGoing === true, lastAt: o.lastAt, now: o.now, minutes: o.minutes, since: Math.max(Number(t.lastWake) || 0, Number(t.created) || 0), lastRec: o.lastRec })
  return idle && !(await waitingOn(h, home, t.id)) ? idle.ms : null
}
// (re-read first: the thread's own turn end may have rewritten the record since endDue read it; only the same spell is marked)
export async function markAlerted(h: Host, home: string, id: string, rec: EndRec, now: number): Promise<void> {
  const cur = await readEnd(h, home, id)
  if (cur && cur.first === rec.first && cur.sid === rec.sid) await writeJson(h, endFile(home, id), { ...cur, alerted: now }).catch(() => undefined)
}
export const deskInbox = async (h: Host, home: string): Promise<DeskRec[]> => readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`).catch(() => [] as DeskRec[])
