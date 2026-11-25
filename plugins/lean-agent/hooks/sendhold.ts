// A standing grant, a written instruction or an own-PR default must not send UNSEEN or AGAINST A NEWER INSTRUCTION (1.0.28; field: a thread with a standing PR grant
// posted its reply at once, the plan in it contradicted the user's message just before it, the desk saw the text only after it was sent).
// ONE hook line in deskactions.ts (runStanding, claimAndSend) calls holdCovered BEFORE a covered request is claimed and sent:
//   (a) NEWER INSTRUCTION: a recorded human prompt (humanprompts.ts) that arrived after the last time the desk delivered anything to that thread (deliver-to-thread,
//       the thread's inbox read, its wake or start) and within the last 30 minutes: the request is NOT sent. It stays pending, the user is asked as usual, and the
//       line "a newer instruction from you may not have reached t5: <first 80 chars>" goes to the desk and the thread.
//   (b) HOLD WINDOW: a covered request that carries TEXT (a reply, a comment: params.body) waits `actions.holdSeconds` (default 30; 0 = at once). The exact text is shown
//       to the desk (a line in its next context) and in the pane with Send now / Cancel and the countdown; `lean_thread action-cancel <id>` cancels. When the window
//       ends (holdsTick, the desk's timer) the request goes through the same covered path as before (the hook then lets it pass). Status-only kinds (no text) are not held.
// A held send is never sent for a thread that is no longer open when the window ends. Nothing here sends: the executor stays approveAction.
import { homeDir, leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { recentPrompts } from './humanprompts'
import type { Thread } from './threads'

export const HOLD_SECONDS = 30
export const HOLD_MIN = 5 // 1.0.35: config actions.holdSeconds is 5 to 600 (0 stays "no window", as before: a file written by hand; the registry refuses it)
export const HOLD_MAX = 600
export const NEWER_WINDOW_MS = 30 * 60_000
const HOLDS = 'action.holds'
const NOTES = 'action.holds.notes'
export type Held = { id: string; thread: string; kind: string; headline: string; text: string; at: number; until: number; forced?: boolean; extended?: boolean }
export type HoldResult = { sent: boolean; line: string }
type Req = { id: string; thread: string; kind: string; params: Record<string, unknown> }
type PlanLike = { headline?: string; text?: string }

export async function holdSeconds(h: Host): Promise<number> {
  const cfg = await readJson<{ actions?: { holdSeconds?: unknown } } | null>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const v = cfg?.actions?.holdSeconds
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return HOLD_SECONDS
  return v === 0 ? 0 : Math.min(HOLD_MAX, Math.max(HOLD_MIN, v)) // 1 -> 5 s, 9999 -> 600 s
}

// the texts a request would post (a batch: its items'); status-only kinds have none
export function bodiesOf(kind: string, params: Record<string, unknown>): string[] {
  const items = kind === 'batch' && Array.isArray(params.items) ? (params.items as { params?: Record<string, unknown> }[]).map(x => x?.params ?? {}) : [params]
  return items.map(p => (typeof p.body === 'string' ? p.body.trim() : '')).filter(Boolean)
}
const flat = (s: string, n: number) => (s.replace(/\s+/g, ' ').trim().length > n ? `${s.replace(/\s+/g, ' ').trim().slice(0, n - 1)}…` : s.replace(/\s+/g, ' ').trim())

async function holds(h: Host): Promise<Held[]> {
  const v = await h.store.get(HOLDS).catch(() => null)
  return (Array.isArray(v) ? v : []).filter((x): x is Held => !!x && typeof x.id === 'string' && typeof x.thread === 'string' && Number.isFinite(x.until))
}
const saveHolds = (h: Host, all: Held[]) => h.store.set(HOLDS, all.slice(-20))
async function note(h: Host, text: string): Promise<void> {
  const v = await h.store.get(NOTES).catch(() => null)
  await h.store.set(NOTES, [...(Array.isArray(v) ? v : []).filter((x: unknown) => typeof x === 'string'), text].slice(-5))
}

// when the desk last delivered anything to the thread: its direct sends and inbox reads (delivered-at.json), its last wake or start, its creation
export const deliveredFile = (home: string, id: string) => `${threadsDir(home)}/${id}/delivered-at.json`
export async function lastDelivered(h: Host, home: string, t: { id: string; lastWake?: number; created?: number }): Promise<number> {
  const d = await readJson<{ at?: number } | null>(h, deliveredFile(home, t.id), null)
  return Math.max(Number(d?.at) || 0, Number(t.lastWake) || 0, Number(t.created) || 0)
}
export const newerLine = (thread: string, text: string): string => `a newer instruction from you may not have reached ${thread}: ${flat(text, 80)}`

// The hook. null = go on and send (as before); else the covered request is NOT sent now: { sent: false } = held and asked as usual (the line says why), { sent: true } = in its
// hold window (the thread is told it goes out; the real result follows). Never throws into the sender: a failure here lets the request pass as before.
export async function holdCovered(h: Host, r: Req, plan: PlanLike, label = ''): Promise<HoldResult | null> {
  try {
    const home = await homeDir(h)
    const now = await h.clock.now()
    const all = await holds(h)
    const mine = all.find(x => x.id === r.id)
    if (mine?.forced) return release(h, all, r.id) // the user's Send now
    const fresh = await newer(h, home, r.thread, now)
    if (fresh) {
      const line = newerLine(r.thread, fresh)
      if (mine) await saveHolds(h, all.filter(x => x.id !== r.id))
      await note(h, `${r.thread}: ${line}${label ? ` (${label})` : ''}`)
      return { sent: false, line }
    }
    if (mine && now >= mine.until) return release(h, all, r.id) // the window ended: send
    const bodies = bodiesOf(r.kind, r.params)
    const secs = await holdSeconds(h)
    if (!bodies.length || secs <= 0) return null // status only, or no window configured
    if (mine) return { sent: true, line: heldLine(mine, Math.round((mine.until - mine.at) / 1000)) } // asked again while it waits
    const rec: Held = { id: r.id, thread: r.thread, kind: r.kind, headline: String(plan.headline ?? r.kind), text: flat(bodies.join(' | '), 600), at: now, until: now + secs * 1000 }
    await saveHolds(h, [...all, rec])
    return { sent: true, line: heldLine(rec, secs) }
  } catch {
    return null
  }
}
const heldLine = (x: Held, secs: number) => `held ${secs} s before sending, then it goes out unless you cancel (the pane has Send now / Cancel; lean_thread action-cancel ${x.id} with text = your reason; on: true extends the hold once by ${secs} s): ${x.text}`
async function release(h: Host, all: Held[], id: string): Promise<null> {
  await saveHolds(h, all.filter(x => x.id !== id))
  return null
}
// the first 80 chars of the newest human prompt after the last delivery (within 30 min), or ''
async function newer(h: Host, home: string, thread: string, now: number): Promise<string> {
  const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${thread}/thread.json`, null)
  const since = t ? await lastDelivered(h, home, t) : 0
  const ps = (await recentPrompts(h)).filter(p => p.ts > since && now - p.ts <= NEWER_WINDOW_MS)
  return ps.length ? ps[ps.length - 1]!.text : ''
}

// ---- the desk's timer: a window that ended -------------------------------------------------------------------------------------------
export type HoldDeps = { run: (id: string) => Promise<HoldResult | null>; tell: (thread: string, text: string) => Promise<void> }
export type HoldNotice = { id: string; text: string }
let ticking = false
export async function holdsTick(h: Host, deps: HoldDeps): Promise<HoldNotice[]> {
  if (ticking) return []
  ticking = true
  try {
    const home = await homeDir(h)
    const now = await h.clock.now()
    const out: HoldNotice[] = []
    for (const x of await holds(h)) {
      if (now < x.until) continue
      const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${x.thread}/thread.json`, null)
      if (!t || t.state !== 'open') {
        await dropHold(h, x.id)
        out.push({ id: x.thread, text: `${x.thread}: the held send ${x.id} was not sent (the thread is ${t?.state ?? 'gone'})` })
        continue
      }
      const r = await deps.run(x.id).catch(() => null) // (the hook sees the ended window and lets it pass; a newer prompt meanwhile holds it again and asks)
      await dropHold(h, x.id)
      if (r?.sent) out.push({ id: x.thread, text: `${x.thread}: ${r.line}` })
      else {
        const why = r?.line ?? 'it is no longer covered, or no longer pending'
        out.push({ id: x.thread, text: `${x.thread}: the held send ${x.id} was not sent: ${why}` })
        await deps.tell(x.thread, `Your request ${x.id} (${x.kind}) was held and then not sent: ${why}. Ask the user, or continue without it.`).catch(() => undefined)
      }
    }
    return out
  } catch {
    return []
  } finally {
    ticking = false
  }
}
async function dropHold(h: Host, id: string): Promise<void> {
  await saveHolds(h, (await holds(h)).filter(x => x.id !== id))
}
// `lean_thread action-cancel <id>` and the pane's Cancel: the held send is not sent. The request stays PENDING (a human answer is written only by the pane press and
// the desk's question, never here): the user is asked as usual, the pane's Cancel also denies it. The thread is told when `tell` is given.
// 1.0.35: the thread is told WHO cancelled: the desk (lean_thread action-cancel, with its reason) or the user (the pane's Cancel)
export type CancelBy = { who: 'user' | 'desk'; reason?: string }
export const cancelNotice = (id: string, kind: string, by: CancelBy): string => {
  const why = (by.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  const head = by.who === 'desk' ? `Your request ${id} (${kind}) was cancelled by the desk before sending: ${why || 'no reason given'}.` : `Your request ${id} (${kind}) was cancelled by the user before it was sent.`
  return `${head} Nothing went out. It waits for the user's own yes at the desk; continue without it meanwhile. Do not send the same text again.`
}
export async function cancelHeld(h: Host, id: string, tell?: (thread: string, text: string) => Promise<void>, by: CancelBy = { who: 'user' }): Promise<{ ok: boolean; text: string }> {
  const x = (await holds(h)).find(v => v.id === id)
  if (!x) return { ok: false, text: `no held send ${id || '(an id is needed)'}: it was already sent, cancelled, or never held` }
  await dropHold(h, id)
  if (tell) await tell(x.thread, cancelNotice(id, x.kind, by)).catch(() => undefined)
  return { ok: true, text: `cancelled ${id}: nothing was sent${tell ? `; ${x.thread} was told (${by.who === 'desk' ? 'by the desk' : 'by the user'})` : ''}; the request stays pending for the user's own answer` }
}
// `lean_thread action-cancel <id> on: true`: the desk needs longer to check a batch: the window grows by one hold length, ONCE per request (never past 600 s from now)
export async function extendHeld(h: Host, id: string): Promise<{ ok: boolean; text: string }> {
  const all = await holds(h)
  const x = all.find(v => v.id === id)
  if (!x) return { ok: false, text: `no held send ${id || '(an id is needed)'}: it was already sent, cancelled, or never held` }
  if (x.forced) return { ok: false, text: `the user pressed Send now for ${id}: it goes out at once` }
  if (x.extended) return { ok: false, text: `the hold of ${id} was already extended once: cancel it (action-cancel with your reason) or let it go out` }
  const now = await h.clock.now()
  const add = Math.max(HOLD_MIN, (await holdSeconds(h)) || HOLD_SECONDS) * 1000
  const until = Math.min(Math.max(x.until, now) + add, now + HOLD_MAX * 1000)
  await saveHolds(h, all.map(v => (v.id === id ? { ...v, until, extended: true } : v)))
  return { ok: true, text: `extended the hold of ${id}: it goes out in ${Math.ceil((until - now) / 1000)} s unless cancelled (this is the only extension)` }
}
// the pane's Send now: the window ends at once; the desk's timer sends it within seconds
export async function sendHeldNow(h: Host, id: string): Promise<boolean> {
  const all = await holds(h)
  if (!all.some(x => x.id === id)) return false
  await saveHolds(h, all.map(x => (x.id === id ? { ...x, until: 0, forced: true } : x)))
  return true
}

// ---- views: the pane's rows and the desk's lines ------------------------------------------------------------------------------------
export async function holdsView(h: Host): Promise<Held[]> {
  return holds(h)
}
// the desk's next-context lines: what waits in its window (the exact text), and a newer-instruction hold said once
export async function holdLines(h: Host): Promise<string | null> {
  const now = await h.clock.now()
  const lines = (await holds(h)).map(x => `${x.thread}: ${Math.max(0, Math.ceil((x.until - now) / 1000))} s until this goes out: ${x.text} (cancel: lean_thread action-cancel ${x.id})`)
  const v = await h.store.get(NOTES).catch(() => null)
  const notes = (Array.isArray(v) ? v : []).filter((s: unknown): s is string => typeof s === 'string')
  if (notes.length) await h.store.set(NOTES, [])
  const all = [...lines.map(l => `held: ${l}`), ...notes.map(n => `not sent: ${n}`)]
  return all.length ? `[lean-agent] ${all.join('; ')}` : null
}
export const resetHolds = async (h: Host): Promise<void> => {
  await h.store.set(HOLDS, [])
  await h.store.set(NOTES, [])
}
