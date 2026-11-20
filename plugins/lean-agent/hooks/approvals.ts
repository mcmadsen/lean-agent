// When is a thread's "needs your yes" card real?
//
// A thread whose action Claude Code's permission check denied reports `blocked` with an `approval` (delivery.ts threadTool); the user
// answers in THAT session (Open tN). No hook can carry the answer from the desk (a classifier's denial is not an ask a PermissionRequest
// hook is consulted for, and PermissionDenied can only say `retry`: see the changelog), so there is no grant here, only the card.
//
// The card used to exist for as long as the blocked report was the thread's last desk record, so a thread that carried on (the user
// answered in its session, or it decided the matter itself) kept showing "needs your yes ... (it is working: wait)". It exists now only
// while the thread is really blocked: its session is not working, and it made no tool call since it reported. The thread's own mod notes
// the first call after the report (noteCall); the pane and the detail read it (liveApproval). The notes are display state, never a
// decision: nothing is allowed or denied by them.
import type { Host } from './state'

const PENDING = (t: string) => `approval.pending.${t}` // ms of the blocked report that carries an approval, until a tool call follows it
const RESUMED = (t: string) => `approval.resumed.${t}` // ms of the first tool call that followed such a report
const idOk = (t: unknown): t is string => typeof t === 'string' && /^t\d{1,9}$/.test(t)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

// what this process knows of a thread's pending report (0 = none), so a session reads the store once, not at every tool call
const known = new Map<string, number>()
export const resetApprovals = () => known.clear()

// threadTool: this thread just reported blocked with an approval at `ts`
export async function notePending(h: Host, thread: string, ts: number): Promise<void> {
  if (!idOk(thread) || !num(ts)) return
  known.set(thread, ts)
  await h.store.set(PENDING(thread), ts)
}

// A reply to the desk is no sign the thread went on; any other tool call of its main loop is. True when this call was the first one.
const REPORTS = /(?:^|__)lean_(?:report|ask)$/
export async function noteCall(h: Host, thread: string, tool: string): Promise<boolean> {
  if (!idOk(thread) || REPORTS.test(String(tool ?? ''))) return false
  let pending = known.get(thread)
  if (pending === undefined) {
    pending = num(await h.store.get(PENDING(thread)).catch(() => 0))
    known.set(thread, pending)
  }
  if (!pending) return false
  known.set(thread, 0)
  await h.store.set(RESUMED(thread), await h.clock.now())
  await h.store.set(PENDING(thread), null)
  return true
}

export const resumedAt = async (h: Host, thread: string): Promise<number> => (idOk(thread) ? num(await h.store.get(RESUMED(thread)).catch(() => 0)) : 0)

// The text of the card, or '' when there is none: `text` is approvalOf(last desk record), `ts` that record's time. `working` is true only
// when the session list was read and says the session works (an unreadable list keeps the card: a real approval is never hidden on a guess).
export const approvalLive = (text: string, ts: number, o: { working: boolean; resumedAt: number }): string => (!text || o.working || (o.resumedAt > 0 && o.resumedAt >= ts) ? '' : text)

export async function liveApproval(h: Host, thread: string, text: string, ts: number, working: boolean): Promise<string> {
  if (!text || working) return ''
  return approvalLive(text, ts, { working, resumedAt: await resumedAt(h, thread) })
}
