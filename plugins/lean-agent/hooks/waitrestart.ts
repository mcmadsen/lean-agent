// A restart WHILE WAITING never goes silent (1.0.28). A thread restarted at the context limit (or after a stall or an escalation) while it waited for
// the desk's answer used to get "do nothing: end your turn without a report": it ended its turn silently, the desk showed nothing, the user
// saw a finished or hung thread. Now (by script, not by the thread):
//   - the open item (a question, a blocked request) is put back to the desk (a mod row with the same id and its since-time) and stays on Needs-you;
//   - the restart prompt says the desk has it open and asks for ONE `waiting` report ("restarted ...; still waiting on <id>") and the end of the turn;
//   - no open item in the store (a prose request from before the prose catch, proserequest.ts): the prompt says to send the request now;
//   - a session that ends its turn without that report gets it written by the mod (holdSilentEnd): never a silent end.
import { appendJsonl, leanDir, readJsonl, writeJson } from './state'
import type { Host } from './state'
import { approvalOf, deskState } from './delivery'
import type { DeskRec } from './delivery'
import { requestSentence } from './proserequest'
import { lastActivity, markWaiting, readWaiting, stillWaiting, waitingFile } from './threadstate'

export const ITEM_TEXT_MAX = 200
const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16)
const one = (s: string, n = ITEM_TEXT_MAX) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export type OpenItem = { id: string; text: string; since: number; approval: string; kind: 'ask' | 'report' }
const isMine = (r: DeskRec, id: string) => r.from === id && (r.kind === 'report' || r.kind === 'ask') && !(r as { mod?: boolean }).mod
// the thread's last record that is not its own `waiting` report: an ask or a blocked report is the open item, anything else is none
export function openItemOf(recs: DeskRec[], id: string): { item: OpenItem | null; last: DeskRec | undefined } {
  const mine = recs.filter(r => isMine(r, id) && r.state !== 'waiting')
  const last = mine[mine.length - 1]
  if (!last || !(last.kind === 'ask' || last.state === 'blocked')) return { item: null, last }
  return { item: { id: `${last.ts}-${last.from}-${last.kind}`, text: one(last.text), since: last.ts, approval: approvalOf(last), kind: last.kind }, last }
}

export const stillOpenText = (id: string, text: string) => `You were waiting for the desk's answer to ${id}: ${text}. The desk has it open. If a message below answers it, act on it. If not, write ONE report with state \`waiting\` ('restarted at the context limit; still waiting on ${id}') and end your turn.`
export const resendText = (text: string) => `You were waiting for the user's answer or approval (${text}), but the desk has NO open item for it. Re-send the request now with lean_ask (a question) or lean_report with \`action\` (a write needing approval), then end your turn.`
export const leadOf = (item: OpenItem): string => stillOpenText(item.id, `${item.text}${item.approval ? ` [needs the user's yes: ${item.approval}]` : ''}`)

// The restart prompt's lead for a thread that WAITED, or null (it did not). `mutate` false (a preview, a question about the thread): nothing is written.
// waiting: the caller's own knowledge (the hard stop saw the last record was a question or blocked).
export async function restartWaiting(h: Host, home: string, id: string, recs: DeskRec[], waiting: boolean, mutate = true): Promise<string | null> {
  const w = await readWaiting(h, home, id)
  const { item, last } = openItemOf(recs, id)
  const act = w ? await lastActivity(h, home, id) : null
  const byFile = !!w && (!!w.restarted || !!w.held || stillWaiting(w, act)) // (a restart in a chain stays waiting until an answer clears waiting.json)
  const prose = !item && !!last && last.kind === 'report' && last.state !== 'done' && requestSentence(last.text) !== null // a request in prose from before the catch
  if (!(waiting || byFile || prose)) return null
  const now = await h.clock.now()
  if (item) {
    if (mutate) {
      await markWaiting(h, home, id, { ...(w ?? {}), since: w?.since ?? item.since, text: w?.text ?? item.text, restarted: now })
      await requeue(h, home, id, item, now)
    }
    return leadOf(item)
  }
  const text = one(w?.text ?? (last ? (requestSentence(last.text) ?? last.text) : '') ?? '')
  if (mutate) await markWaiting(h, home, id, { ...(w ?? {}), since: w?.since ?? last?.ts ?? now, text: text.slice(0, 300), restarted: now })
  return resendText(text || 'the request in your last report')
}

// the open item goes back to the desk: one mod row (a question, same id) and, for an ask the question list lost, its line again
async function requeue(h: Host, home: string, id: string, item: OpenItem, now: number): Promise<void> {
  await appendJsonl(h, `${deskState(home)}/inbox.jsonl`, { ts: now, from: id, kind: 'ask', mod: true, requeued: item.id, since: item.since, text: `${id} still waits for your answer (since ${hhmm(item.since)}Z, restarted by the mod): ${item.text} [${item.id}]` } satisfies Record<string, unknown>)
  if (item.kind !== 'ask') return
  const qs = await readJsonl<{ from?: string; question?: string }>(h, `${leanDir(home)}/questions.jsonl`)
  const done = new Set((await readJsonl<{ q: number }>(h, `${leanDir(home)}/answers.jsonl`)).map(a => a.q))
  const open = qs.some((q, n) => q && q.from === id && !done.has(n + 1) && one(q.question ?? '', 60) === one(item.text, 60))
  if (!open) await appendJsonl(h, `${leanDir(home)}/questions.jsonl`, { ts: item.since, from: id, question: item.text, answered: false, requeued: true })
}

// The end of a turn of a restarted thread that still waits and wrote no `waiting` report: the mod writes it (the thread must not end silently).
export async function holdSilentEnd(h: Host, home: string, id: string): Promise<boolean> {
  const w = await readWaiting(h, home, id)
  if (!w || !w.restarted || w.held) return false
  const now = await h.clock.now()
  await appendJsonl(h, `${deskState(home)}/inbox.jsonl`, { ts: now, from: id, kind: 'report', state: 'waiting', mod: true, text: `${id} restarted at the context limit; still waiting on the desk since ${hhmm(w.since)}Z (its new session ended its turn without a report, the mod wrote this): ${one(w.text ?? '')}` } satisfies Record<string, unknown>)
  await writeJson(h, waitingFile(home, id), { ...w, held: now })
  return true
}
