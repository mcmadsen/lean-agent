// 1.0.35: a thread that reports "still waiting for the worker" again and again must not reach the desk again and again (field: repeated waiting reports, partly asked for
// by a desk instruction). By script, no model: a `working` / `waiting` report whose normalised text equals the thread's previous report, or that names the SAME WAIT TARGET
// ("waiting for the worker") in a short text, is RECORDED here (a counter and the time of the first one) and NOT written to the desk's inbox or sent to the desk. The thread is
// told so in its tool result. The list shows "waiting for worker since 13:42 (3 repeats)" while nothing else happened since (threads.ts list, waitLine).
// Never deduplicated: done, blocked, a report with an approval, an action request, `important`, a question mark, or a state that changed.
import { threadsDir, readJson, writeJson } from './state'
import type { Host } from './state'

const WAIT_LINE_MAX_MS = 6 * 3_600_000 // a wait line older than this is not shown

export type LastReport = { state: string; norm: string; target: string; since: number; last: number; repeats: number }
export const lastReportFile = (home: string, id: string) => `${threadsDir(home)}/${id}/last-report.json`
const SHORT = 240 // a wait target counts only in a short, plain wait report: progress text around it is news
const REPEATABLE = new Set(['working', 'waiting'])

// lower case, digits as #, punctuation out, words joined by one space: "Still waiting for worker w3 (13:42)." == "still waiting for worker w# #:#"
export function normText(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}\p{N}# ]+/gu, ' ').replace(/\s+/g, ' ').trim()
}
const TARGET = /\b(?:still\s+|currently\s+)?(?:waiting|awaiting|waits)\s+(?:for|on)\s+(?:the\s+|a\s+|an\s+|my\s+|its\s+)?([a-z][a-z0-9 _-]{0,40}?)(?=\s*(?:[.,;:!?(\n]|$)|\s+(?:to|before|until|since|so|and|but|then|which)\b)/i
// "waiting for the worker to finish" -> "worker"; '' when the text names none
export function waitTarget(text: string): string {
  const m = TARGET.exec(text.trim().replace(/\s+/g, ' '))
  return m ? normText(m[1]!).replace(/#/g, '').replace(/\s+/g, ' ').trim() : ''
}
export const sameReport = (prev: LastReport | null, state: string, text: string): boolean => {
  if (!prev || prev.state !== state || !REPEATABLE.has(state)) return false
  const norm = normText(text)
  if (norm && norm === prev.norm) return true
  const target = waitTarget(text)
  return !!target && target === prev.target && text.trim().length <= SHORT
}
const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16)

// null = a new report: it was noted and goes on to the desk as before; else the sentence for the thread (it was a repeat: recorded, not forwarded)
export async function noteReport(h: Host, home: string, id: string, rep: { state: string; text: string; ts: number; plain: boolean }): Promise<string | null> {
  try {
    const file = lastReportFile(home, id)
    const prev = await readJson<LastReport | null>(h, file, null)
    const state = rep.state
    if (rep.plain && sameReport(prev && typeof prev.norm === 'string' ? prev : null, state, rep.text)) {
      const repeats = (prev!.repeats || 0) + 1
      await writeJson(h, file, { ...prev!, last: rep.ts, repeats })
      return `recorded, NOT sent to the desk again: the same ${state} report as before (${repeats} repeat${repeats > 1 ? 's' : ''} since ${hhmm(prev!.since)}). The desk sees "waiting${prev!.target ? ` for ${prev!.target}` : ''} since ${hhmm(prev!.since)} (${repeats} repeat${repeats > 1 ? 's' : ''})" in its list. Do not report the same wait again: do other work or end your turn, and report when something changes.`
    }
    await writeJson(h, file, { state, norm: normText(rep.text), target: REPEATABLE.has(state) ? waitTarget(rep.text) : '', since: rep.ts, last: rep.ts, repeats: 0 } satisfies LastReport)
    return null
  } catch {
    return null // never in the way of a report
  }
}

// the list's word for a thread whose last report was a wait, with nothing done since: "waiting for worker since 13:42 (3 repeats)", else ''
export async function waitLine(h: Host, home: string, id: string): Promise<string> {
  try {
    const r = await readJson<LastReport | null>(h, lastReportFile(home, id), null)
    if (!r || !REPEATABLE.has(r.state) || !(r.target || r.repeats > 0)) return ''
    // (not tied to the thread's activity: a worker it waits for makes tool calls that count as the thread's own; its next different report ends this line)
    if ((await h.clock.now()) - r.last > WAIT_LINE_MAX_MS) return ''
    return `waiting${r.target ? ` for ${r.target}` : ''} since ${hhmm(r.since)}${r.repeats > 0 ? ` (${r.repeats} repeat${r.repeats > 1 ? 's' : ''})` : ''}`
  } catch {
    return ''
  }
}
