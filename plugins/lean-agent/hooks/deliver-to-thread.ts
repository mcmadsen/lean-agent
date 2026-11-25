// Desk -> thread delivery, by script (1.0.27c; field: a thread asked a question, ended its turn and showed "running"; the answer sat in its inbox file,
// which a thread reads only at its next tool call, and the desk asked the user whether to restart it. That decision is mechanical: a script makes it).
// ONE place for every message to a thread (send, wake, an answer to a question, approve-action / approve-push results, the chaser):
//   1. DIRECT: the thread's session is alive (a row of `claude agents --json` with a pid, not done): the batch goes to it with `$.session.send` (an idle
//      session starts a turn for it, a working one reads it at its next step). The inbox rows count as delivered only when the send resolved.
//      A session with an OPEN permission prompt (waitingFor) cannot take it: said plainly, the inbox keeps it. No live session: the caller wakes it.
//   2. VERIFY, then ESCALATE (deliveryTick, the desk's timer): the thread's own hooks write activity.json on a prompt / tool call / received message.
//      No activity newer than the send within `threads.answerWaitSeconds` (default 45) and the thread is idle or waiting for its answer: the message did
//      not start a turn, the session is stopped (forced, as the manual restart) and a fresh one starts with the message in its first prompt, ONE notice
//      afterwards. Never for: an open permission prompt, a message that is only an FYI (no record is kept), a session that works (a long tool call reads
//      it at its next step; a worker's tool calls count as activity): those are re-checked. `threads.escalate` false: the notice asks instead.
//   3. WAITING: a thread's question records waiting.json (threadstate.ts); `waiting` is its state word. Over `threads.waitReminderMinutes` (default 15)
//      the question comes back ONCE as a notice line of the pane, a toast and a line for the desk.
import { homeDir, leanDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { wakeMark } from './delivery'
import { setNotice } from './notices'
import { MOD_SEND_PREFIX, asMod } from './modsend'
import { clearWaiting, liveOf, readActivity, readWaiting, stallConfig, stallFor, stillWaiting, waitingFile } from './threadstate'
import { markEscalated, markFailed, messageRecs } from './msgstate'
import type { AgentRow, Out, Thread } from './threads'

export type MsgKind = 'answer' | 'instruction' | 'fyi'
export type ThreadSend = (sid: string, text: string) => Promise<{ isDelivered: boolean; reason?: string } | void>
let sender: ThreadSend | null = null
// the desk's mod sets it (register.tsx: `$.session.send`); a spec sets a fake
export const setThreadSender = (f: ThreadSend | null): void => {
  sender = f
}

export const ANSWER_WAIT_SECONDS = 45
export const WAIT_REMINDER_MINUTES = 15
export const MAX_ESCALATE_TRIES = 3
export const RECHECK_MAX_MS = 60 * 60_000 // a record that could not be decided for an hour is dropped
export type DeliverConfig = { escalate: boolean; answerWaitSeconds: number; waitReminderMinutes: number }
export async function deliverConfig(h: Host, home: string): Promise<DeliverConfig> {
  const t = (await readJson<{ threads?: { escalate?: unknown; answerWaitSeconds?: unknown; waitReminderMinutes?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null))?.threads
  const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
  return { escalate: t?.escalate !== false, answerWaitSeconds: pos(t?.answerWaitSeconds, ANSWER_WAIT_SECONDS), waitReminderMinutes: pos(t?.waitReminderMinutes, WAIT_REMINDER_MINUTES) }
}

// What a message is: an FYI (the chaser's status check, or text that starts with "FYI") never restarts anything; a message to a thread that waits for
// its answer is the answer; anything else is an instruction. Answers and instructions are verified.
export const FYI = /^\s*(?:fyi\b|status check\b)/i
export const kindOf = (text: string, waiting: boolean): MsgKind => (FYI.test(text) ? 'fyi' : waiting ? 'answer' : 'instruction')

const recFile = (home: string, id: string) => `${threadsDir(home)}/${id}/delivery.json`
export type DeliveryRec = { at: number; sid: string; from: number; upTo: number; kind: MsgKind; tries?: number }
const readRec = async (h: Host, home: string, id: string): Promise<DeliveryRec | null> => {
  const r = await readJson<Partial<DeliveryRec> | null>(h, recFile(home, id), null)
  return r && typeof r === 'object' && Number(r.at) > 0 && typeof r.sid === 'string' ? ({ ...r, at: Number(r.at), from: Number(r.from) || 0, upTo: Number(r.upTo) || 0, kind: r.kind === 'fyi' || r.kind === 'answer' ? r.kind : 'instruction' } as DeliveryRec) : null
}
const dropRec = (h: Host, home: string, id: string) => writeJson(h, recFile(home, id), {}).catch(() => undefined)

// a session that can take a direct message: a listed row with a live process
export const aliveRow = (row: AgentRow | undefined): row is AgentRow => !!row && row.pid > 0 && liveOf(row) !== 'gone' && row.state !== 'done'

// The message is WATCHED (delivery.json) from the moment it is handed to any route: the activity check in deliveryTick decides whether it started a turn. A message
// still pending for the same session keeps its ORIGINAL time (`again`: the desk's sweep sends the unread inbox again every few seconds, and a restarted clock would
// never reach threads.answerWaitSeconds). A message that is not an FYI also ends the thread's waiting state (the answer is on its way).
export async function watchDelivery(h: Host, home: string, id: string, o: { sid: string; from: number; upTo: number; kind: MsgKind; again?: boolean }): Promise<void> {
  if (o.kind === 'fyi') return
  try {
    const old = o.again ? await readRec(h, home, id) : null
    const keep = old && old.sid === o.sid
    await writeJson(h, recFile(home, id), { at: keep ? old.at : await h.clock.now(), sid: o.sid, from: keep ? Math.min(old.from, o.from) : o.from, upTo: o.upTo, kind: keep && old.kind === 'answer' ? 'answer' : o.kind, ...(keep && old.tries ? { tries: old.tries } : {}) } satisfies DeliveryRec)
  } catch {
    /* the watch is best effort */
  }
}
export async function answered(h: Host, home: string, id: string): Promise<void> {
  await clearWaiting(h, home, id) // the answer (or an instruction) is in: it no longer waits
  await setNotice(h, `wait-${id}`, null).catch(() => undefined)
}

// A refusal that is about THIS SESSION, not about the target ("this session has no SendMessage tool ..."), is remembered: the mod does not try again every few seconds,
// and a send that never went out is not waited for: the next route (the wake) runs at once. Forgotten after UNAVAILABLE_MS (the desk's tool pool may have changed).
export const UNAVAILABLE_MS = 10 * 60_000
const sessionLevel = (reason: string) => /has no SendMessage tool/i.test(reason)
let unavailable: { reason: string; at: number } | null = null
export const directUnavailable = (): string | null => unavailable?.reason ?? null
export const resetUnavailable = (): void => {
  unavailable = null
}

export type Delivered = { delivered: boolean; text: string; refused?: boolean; unavailable?: boolean }
// `body`: the batch as the thread reads it; `from` / `upTo`: its inbox positions (the caller moves the thread's `delivered` pointer to upTo when this says delivered)
export async function deliverToThread(h: Host, home: string, t: Thread, row: AgentRow | undefined, o: { body: string; from: number; upTo: number; kind: MsgKind }): Promise<Delivered> {
  if (!aliveRow(row)) return { delivered: false, text: '' } // no live session: the caller's wake
  if (row.waitingFor) return { delivered: false, refused: true, text: `${t.id} waits on a permission prompt in its own session: ${String(row.waitingFor).replace(/\s+/g, ' ').slice(0, 160)}; a message cannot answer it, so it stays queued in its inbox (the user answers the prompt in that session)` }
  const send = sender
  if (!send) return { delivered: false, text: '' }
  const now = await h.clock.now()
  if (unavailable && now >= unavailable.at && now - unavailable.at < UNAVAILABLE_MS) return { delivered: false, unavailable: true, text: '' } // known: no send, no wait
  const line = `${MOD_SEND_PREFIX}:\n${o.body}\n${wakeMark(o.upTo)}`
  try {
    const r = await asMod(() => send(row.sid, line))
    if (r && r.isDelivered === false) {
      const why = String(r.reason ?? 'no reason').replace(/\s+/g, ' ').slice(0, 160)
      if (sessionLevel(why)) {
        unavailable = { reason: why, at: now }
        return { delivered: false, unavailable: true, text: `direct send unavailable: ${why}; using the inbox and the wake` }
      }
      await watchDelivery(h, home, t.id, { sid: row.sid, from: o.from, upTo: o.upTo, kind: o.kind, again: true }) // a refused send leaves it queued: still watched
      return { delivered: false, text: `direct send to ${t.id} refused (${why}): queued in its inbox` }
    }
  } catch (e) {
    await watchDelivery(h, home, t.id, { sid: row.sid, from: o.from, upTo: o.upTo, kind: o.kind, again: true })
    return { delivered: false, text: `direct send to ${t.id} failed (${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 160)}): queued in its inbox` }
  }
  await writeJson(h, `${threadsDir(home)}/${t.id}/delivered-at.json`, { at: now }).catch(() => undefined) // when the desk last delivered anything (sendhold.ts)
  if (o.kind !== 'fyi') {
    await watchDelivery(h, home, t.id, { sid: row.sid, from: o.from, upTo: o.upTo, kind: o.kind })
    await answered(h, home, t.id)
  }
  return { delivered: true, text: `${t.id}: ${sessionWords(row)}${o.kind === 'fyi' ? '' : '; the mod restarts it by itself if it does not react'}` }
}
// What the reply says about the session the message went to. 1.0.35, field: "delivered straight to its running session (blocked)" - a session in state blocked is not running:
// it may not start a turn for the message (a restarted thread stood there 12 minutes). Only a working or idle session is called running.
export const sessionWords = (row: AgentRow): string => {
  const s = row.state || 'alive'
  return s === 'working' || s === 'idle' || s === 'busy' || s === 'alive' || s === 'running' ? `delivered straight to its running session (${s})` : `sent to its session, which is ${s}, not running: it may not start a turn for it`
}

// ---- the desk's timer ------------------------------------------------------------------------------------------------------------
export type DeliveryDeps = {
  agents: () => Promise<AgentRow[] | null>
  restart: (id: string, why: string, rewind: number) => Promise<Out> // stop (forced) + fresh session; the message is the thread's unread inbox again from `rewind`
}
export type DeliveryNotice = { id: string; text: string; toast?: boolean }

let ticking = false
export async function deliveryTick(h: Host, deps: DeliveryDeps): Promise<DeliveryNotice[]> {
  if (ticking) return []
  ticking = true
  try {
    return await tickOnce(h, deps)
  } catch {
    return [] // a watchdog never throws into the timer
  } finally {
    ticking = false
  }
}

async function tickOnce(h: Host, deps: DeliveryDeps): Promise<DeliveryNotice[]> {
  const home = await homeDir(h)
  const ents = await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])
  const ids = ents.map(e => e.name).filter(n => /^t\d+$/.test(n))
  const cfg = await deliverConfig(h, home)
  const out: DeliveryNotice[] = []
  let rows: AgentRow[] | null | undefined
  for (const id of ids) {
    const rec = await readRec(h, home, id)
    const w = await readWaiting(h, home, id)
    if (!rec && !w) continue
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const now = await h.clock.now()
    const act = await readActivity(h, home, id)
    if (!t || t.state !== 'open' || !t.sid || t.finished) {
      if (rec) await dropRec(h, home, id)
      if (w) await clearWaiting(h, home, id)
      continue
    }
    rows ??= await deps.agents()
    if (!rows) continue // no listing: nothing is claimed
    const row = rows.find(a => a.sid === t.sid)
    // ---- 2. a delivered message: did it start a turn?
    if (rec) {
      const noun = rec.kind === 'answer' ? 'answer' : 'message'
      const ns = Array.from({ length: Math.max(0, Math.min(rec.upTo - rec.from, 50)) }, (_, k) => rec.from + 1 + k)
      const ids = ns.map(n => `m${n}`).join(', ')
      const read = rec.upTo > 0 && (await messageRecs(h, home, id))[rec.upTo - 1]?.state === 'consumed' // the thread's mod handed it over (takeBatch / a wake prompt)
      if (rec.sid !== t.sid || (act && act.at > rec.at) || read) await dropRec(h, home, id) // reacted (a prompt, a tool call, a worker's call), read, or another session now
      else if (now - rec.at > RECHECK_MAX_MS) await dropRec(h, home, id)
      else if (now - rec.at >= cfg.answerWaitSeconds * 1000) {
        const gone = !aliveRow(row)
        const idle = !gone && liveOf(row) === 'idle'
        const waiting = rec.kind === 'answer' || stillWaiting(w, act?.at) // (an answer cleared waiting.json when it was delivered: the kind remembers that the thread was waiting)
        // stuck (1.0.31; field: 4 messages unread for 12 min in a session that "worked"): alive, no tool call / report / start for threads.stallMinutes. A message it never
        // reads is no longer left to the desk: the same restart as for an idle one, the text last in the new session's prompt.
        const stuck = !gone && liveOf(row) === 'working' && now - Math.max(act?.at ?? 0, Number(t.lastWake) || 0, 0) >= stallFor((await stallConfig(h, home)).minutes, t) * 60_000
        // never while a permission prompt is open; a session that works (and asked nothing) reads it at its next step: re-checked
        if (!gone && (row!.waitingFor || !(idle || waiting || stuck || row!.state === 'blocked'))) {
          /* re-checked at the next tick */
        } else if (!cfg.escalate) {
          await dropRec(h, home, id)
          out.push({ id, text: `${id} did not react to your ${noun} within ${cfg.answerWaitSeconds} s (threads.escalate is off): restart it with the ${noun}? (${ids})`, toast: true })
        } else {
          const r = await deps.restart(id, `Its previous session did not react to the desk's ${noun} within ${cfg.answerWaitSeconds} s (no prompt, no tool call${stuck ? ' for the stall minutes' : ''}); restarted by script, the message is in this prompt.`, rec.from)
          if (r.ok && (r.data as { fresh?: boolean } | undefined)?.fresh) {
            await dropRec(h, home, id)
            await clearWaiting(h, home, id)
            await markEscalated(h, home, id, ns)
            out.push({ id, text: `${id} did not react to your ${noun} within ${cfg.answerWaitSeconds} s${stuck ? ' (its session was stuck)' : ''}: restarted it with the ${noun}; its notes are kept`, toast: true })
          } else {
            const tries = (rec.tries ?? 0) + 1
            if (tries >= MAX_ESCALATE_TRIES) {
              await dropRec(h, home, id)
              await markFailed(h, home, id, ns, `automatic restart failed: ${r.text.slice(0, 80)}`)
              out.push({ id, text: `${id} did not react to your ${noun} and the automatic restart failed ${tries} times (last reason: ${r.text.slice(0, 160)}); restart it by hand (${ids})`, toast: true })
            } else await writeJson(h, recFile(home, id), { ...rec, tries } satisfies DeliveryRec).catch(() => undefined)
          }
        }
      }
    }
    // ---- 3. an open question that stays unanswered: back once as a notice
    const w2 = rec ? await readWaiting(h, home, id) : w // (the restart above clears it)
    if (w2 && !w2.reminded && now - w2.since >= cfg.waitReminderMinutes * 60_000 && stillWaiting(w2, act?.at) && aliveRow(row)) {
      const mins = Math.max(1, Math.round((now - w2.since) / 60_000))
      const text = `${id} has waited ${mins} min for your answer: ${(w2.text ?? 'its question is open').replace(/\s+/g, ' ').slice(0, 200)}`
      await writeJson(h, waitingFile(home, id), { ...w2, reminded: true }).catch(() => undefined)
      await setNotice(h, `wait-${id}`, text).catch(() => undefined)
      out.push({ id, text, toast: true })
    }
  }
  return out
}
