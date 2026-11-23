// A request to the user in the PROSE of a lean_report (1.0.28). A thread that writes "one batch of comments for approval; nothing is posted
// until you approve" into an ordinary `working` report asked the desk nothing: no `blocked` + `action`, no lean_ask, so no item on the
// Needs-you list and nobody to answer. A script reads the report text (requestwords.ts: the table), and on a hit the mod makes the item
// the thread should have made: a desk question (the same records as lean_ask), waiting.json (so the pane word, the reminder after 15
// minutes and the restart prompt all see it), and the thread gets one line back.
import { appendJsonl, leanDir, readJsonl } from './state'
import type { Host } from './state'
import { REQUEST_WORDS, NOT_A_REQUEST } from './requestwords'
import { markWaiting } from './threadstate'

export const SENTENCE_MAX = 200
const any = (list: string[]) => new RegExp(list.join('|'), 'i')
const ASK = any(REQUEST_WORDS)
const NOT = any(NOT_A_REQUEST)

// the first sentence of `text` that asks the user for an answer or an approval (cut to 200 characters), or null
export function requestSentence(text: string): string | null {
  const flat = text.replace(/`[^`\n]*`/g, m => m.replace(/\s+/g, ' ')) // (code spans stay in one piece)
  for (const raw of flat.split(/(?<=[.!?;:])\s+|\n+/)) {
    const s = raw.replace(/^[\s>*#-]+/, '').replace(/\s+/g, ' ').replace(/[;:,]+$/, '').trim()
    if (s.length >= 6 && ASK.test(s) && !NOT.test(s)) return s.length > SENTENCE_MAX ? `${s.slice(0, SENTENCE_MAX - 1)}…` : s
  }
  return null
}

export const PROSE_REPLY = 'that read like a request for the user: use lean_ask (a question) or lean_report with `action` (a write needing approval); the desk has been told'
export const questionText = (id: string, sentence: string): string => `${id} seems to wait for your answer: ${sentence}`

// The thread's open question lines (questions.jsonl without a row in answers.jsonl): a thread that has one asked with lean_ask already.
async function hasOpenQuestion(h: Host, home: string, id: string): Promise<boolean> {
  const qs = await readJsonl<{ from?: string }>(h, `${leanDir(home)}/questions.jsonl`)
  const done = new Set((await readJsonl<{ q: number }>(h, `${leanDir(home)}/answers.jsonl`)).map(a => a.q))
  return qs.some((q, n) => q && q.from === id && !done.has(n + 1))
}

export type Prose = { sentence: string; question: string; report: string }
// null = nothing to do (no request in the text, an action or an approval card exists, or the thread has an open question already)
export async function proseRequest(h: Host, home: string, id: string, o: { text: string; state: string; ts: number; hasAction: boolean; hasApproval: boolean; standing: boolean }): Promise<Prose | null> {
  if (o.state === 'done' || o.state === 'blocked' || o.state === 'waiting' || o.hasAction || o.hasApproval || o.standing) return null // (a blocked report is its own Needs-you row and waits already)
  const sentence = requestSentence(o.text)
  if (!sentence) return null
  if (await hasOpenQuestion(h, home, id)) return null
  const question = questionText(id, sentence)
  const report = `${o.ts}-${id}-report`
  // the same two records as lean_ask (delivery.ts), plus the report's id; the desk inbox row is a question, so the pane and the relay treat it as one
  await appendJsonl(h, `${leanDir(home)}/questions.jsonl`, { ts: o.ts, from: id, question, options: undefined, answered: false, report, prose: true })
  await appendJsonl(h, `${leanDir(home)}/desk/inbox.jsonl`, { ts: o.ts, from: id, kind: 'ask', text: question, report, prose: true })
  await markWaiting(h, home, id, { since: o.ts, text: question.slice(0, 300), q: o.ts })
  return { sentence, question, report }
}
