// The state of every message the desk sent to a thread (1.0.31). The inbox (threads/tN/inbox.jsonl) is the record: line n is message "m<n>".
// Its state is DERIVED, so no second list can drift from it:
//   consumed  the thread's own mod handed it to the session (consumed.json n >= its position: takeBatch at a tool call, consumeWake at a prompt)
//   delivered the desk handed it to the live session directly (thread.json delivered >= its position), not read back yet
//   queued    it waits in the inbox: read at the thread's next tool call, or by the wake
//   failed    the mod gave up on it (the automatic restart failed MAX_ESCALATE_TRIES times): msgs.json `failed`
// msgs.json (a sidecar, the thread's mod and the desk both write it, one key per position) keeps what the files above cannot: readAt, deliveredAt,
// `answer` (the message answered the thread's open question), `escalated` (the mod woke / restarted the thread for it: told the desk once) and `failed`.
import { readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import type { Inbox, Thread } from './threads'

export type MsgState = 'queued' | 'delivered' | 'consumed' | 'failed'
export type MsgMeta = { deliveredAt?: number; readAt?: number; answer?: boolean; escalated?: number; failed?: string }
export type MsgRec = { id: string; n: number; state: MsgState; at: number; readAt?: number; deliveredAt?: number; text: string; answer: boolean; escalated?: number; failed?: string }

export const DEDUPE_MS = 10 * 60_000 // an identical text still unread within this long is not queued again
export const metaFile = (home: string, id: string) => `${threadsDir(home)}/${id}/msgs.json`
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

export async function readMeta(h: Host, home: string, id: string): Promise<Record<string, MsgMeta>> {
  const m = await readJson<Record<string, MsgMeta> | null>(h, metaFile(home, id), null)
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {}
}
const tails = new Map<string, Promise<unknown>>()
// one writer at a time per thread inside this process (the desk and a thread's mod are separate processes: a lost update of a timestamp is harmless)
export function patchMeta(h: Host, home: string, id: string, ns: number[], patch: (m: MsgMeta) => MsgMeta): Promise<void> {
  const run = (tails.get(id) ?? Promise.resolve()).then(async () => {
    if (!ns.length) return
    const all = await readMeta(h, home, id)
    for (const n of ns) all[String(n)] = patch(all[String(n)] ?? {})
    await writeJson(h, metaFile(home, id), all)
  })
  const safe = run.catch(() => undefined)
  tails.set(id, safe)
  return safe
}
const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, Math.min(to - from, 200)) }, (_, i) => from + 1 + i)

// the thread's mod consumed lines up to `upTo` (delivery.ts markConsumed)
export const markMsgRead = async (h: Host, home: string, id: string, from: number, upTo: number): Promise<void> => {
  const at = await h.clock.now()
  await patchMeta(h, home, id, range(from, upTo), m => ({ ...m, readAt: m.readAt ?? at })).catch(() => undefined)
}
// the desk handed lines (from, upTo] to the live session
export const markHanded = async (h: Host, home: string, id: string, from: number, upTo: number): Promise<void> => {
  const at = await h.clock.now()
  await patchMeta(h, home, id, range(from, upTo), m => ({ ...m, deliveredAt: m.deliveredAt ?? at })).catch(() => undefined)
}
export const markAnswer = (h: Host, home: string, id: string, ns: number[]): Promise<void> => patchMeta(h, home, id, ns, m => ({ ...m, answer: true })).catch(() => undefined)
export const markEscalated = async (h: Host, home: string, id: string, ns: number[]): Promise<void> => {
  const at = await h.clock.now()
  await patchMeta(h, home, id, ns, m => ({ ...m, escalated: m.escalated ?? at })).catch(() => undefined)
}
export const markFailed = (h: Host, home: string, id: string, ns: number[], why: string): Promise<void> => patchMeta(h, home, id, ns, m => ({ ...m, failed: why.slice(0, 160) })).catch(() => undefined)

export async function messageRecs(h: Host, home: string, id: string): Promise<MsgRec[]> {
  const dir = `${threadsDir(home)}/${id}`
  const all = await readJsonl<Inbox>(h, `${dir}/inbox.jsonl`).catch(() => [] as Inbox[])
  if (!all.length) return []
  const t = await readJson<Partial<Thread> | null>(h, `${dir}/thread.json`, null)
  const c = await readJson<{ n?: number } | null>(h, `${dir}/consumed.json`, null)
  const consumed = Number.isFinite(Number(c?.n)) ? Number(c!.n) : 0
  const delivered = Number(t?.delivered) || 0
  const meta = await readMeta(h, home, id)
  return all.map((m, i) => {
    const n = i + 1
    const x = meta[String(n)] ?? {}
    const state: MsgState = n <= consumed ? 'consumed' : x.failed ? 'failed' : n <= delivered ? 'delivered' : 'queued'
    return { id: `m${n}`, n, state, at: Number(m.ts) || 0, ...(x.readAt ? { readAt: x.readAt } : {}), ...(x.deliveredAt ? { deliveredAt: x.deliveredAt } : {}), text: String(m.text ?? ''), answer: x.answer === true, ...(x.escalated ? { escalated: x.escalated } : {}), ...(x.failed ? { failed: x.failed } : {}) }
  })
}
export const unread = (r: MsgRec): boolean => r.state === 'queued' || r.state === 'delivered'

// ---- answers (1.0.31): a message sent while the thread waited for its answer ----------------------------------------------------
// `lastAt`: when the newest answer was sent (0 = none): a question or blocked report OLDER than that is answered. `open`: the newest answer the thread has not read yet.
export type AnswerInfo = { lastAt: number; last: MsgRec | null; open: MsgRec | null }
export async function answerInfo(h: Host, home: string, id: string): Promise<AnswerInfo> {
  const as = (await messageRecs(h, home, id)).filter(r => r.answer)
  const last = as[as.length - 1] ?? null
  return { lastAt: last?.at ?? 0, last, open: [...as].reverse().find(unread) ?? null }
}
// ---- a replaced session's findings (1.0.31) ---------------------------------------------------------------------------------------------
// threads/tN/unverified.json {at, sid}: written when a NEW session replaced the thread's old one (handover.ts buildHandover); the old session's recorded findings and
// area records stay in their stores (signed review records are never edited) but count as UNVERIFIED until the new session reports (delivery.ts lean_report clears it).
export type Unverified = { at: number; sid: string }
export const unverifiedFile = (home: string, id: string) => `${threadsDir(home)}/${id}/unverified.json`
export async function readUnverified(h: Host, home: string, id: string): Promise<Unverified | null> {
  const u = await readJson<Partial<Unverified> | null>(h, unverifiedFile(home, id), null)
  return u && Number(u.at) > 0 ? { at: Number(u.at), sid: String(u.sid ?? '') } : null
}
export const markUnverified = (h: Host, home: string, id: string, u: Unverified): Promise<void> => writeJson(h, unverifiedFile(home, id), u).catch(() => undefined)
export const clearUnverified = (h: Host, home: string, id: string): Promise<void> => writeJson(h, unverifiedFile(home, id), {}).catch(() => undefined)
export const unverifiedText = (u: Unverified): string => `unverified (session replaced at ${new Date(u.at).toTimeString().slice(0, 5)})`

// the row text while an answer is on its way: "answer queued, not read yet (4 min)"
export const answerText = (r: MsgRec | null, now: number): string => (r ? `answer ${r.state === 'delivered' ? 'delivered, not read back yet' : 'queued, not read yet'} (${ageText(now - r.at)})` : '')

export const ageText = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`
}

// an identical text of the same thread that is still unread (queued or delivered, not yet consumed) and was sent within DEDUPE_MS: the desk must not send it twice.
// (Not for an FYI / status check: those repeat on purpose; not for a consumed one: the thread read it, saying it again is a new instruction.)
export async function duplicateOf(h: Host, home: string, id: string, text: string, now: number): Promise<MsgRec | null> {
  if (/^\s*(?:fyi\b|status check\b)/i.test(text)) return null
  const want = norm(text)
  const recs = await messageRecs(h, home, id)
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]!
    if (now - r.at > DEDUPE_MS) break
    if (unread(r) && norm(r.text) === want) return r
  }
  return null
}

export const stateWord = (r: MsgRec): string => (r.state === 'queued' ? 'queued, not read yet' : r.state === 'delivered' ? 'delivered, not read back yet' : r.state === 'failed' ? `failed (${r.failed ?? 'not delivered'})` : 'consumed')

// `lean_thread messages tN`: the last messages with state and age, from the files, no model
export const MESSAGES_SHOWN = 8
export async function messagesText(h: Host, home: string, id: string, now: number): Promise<string> {
  const recs = await messageRecs(h, home, id)
  if (!recs.length) return `${id}: no messages sent yet`
  const shown = recs.slice(-MESSAGES_SHOWN)
  const lines = shown.map(r => {
    const read = r.readAt ? ` (read ${ageText(r.readAt - r.at)} after sending)` : ''
    const extra = `${r.answer ? ', answer to its question' : ''}${r.escalated ? `, the mod woke it ${ageText(now - r.escalated)} ago` : ''}`
    return `${r.id} ${r.state} ${ageText(now - r.at)} ago${read}${extra}: ${r.text.replace(/\s+/g, ' ').slice(0, 100)}`
  })
  const open = recs.filter(unread).length
  return `${id}: ${recs.length} message(s), ${open} not read yet${recs.length > shown.length ? ` (last ${shown.length} shown)` : ''}\n${lines.join('\n')}`
}

// the reply line of `send`
export function sendLine(r: MsgRec, o: { woken: boolean; answerWaitSeconds: number }): string {
  if (r.state === 'consumed') return `${r.id}: consumed (the thread has read it)`
  if (r.state === 'delivered') return `${r.id}: delivered to its running session, not read back yet; it is marked consumed when the thread reads it (lean_thread messages shows it)`
  if (o.woken) return `${r.id}: queued, not read yet (the session was woken with it; it is marked consumed when it starts)`
  return `${r.id}: queued, not read yet. This thread can only be reached through its inbox: it is read at its next tool call; if it is idle or hung the mod wakes it by script after ${o.answerWaitSeconds} s`
}
