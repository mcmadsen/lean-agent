// Is a thread legitimately WAITING for an external event? Answered from records the mod already holds, never from the words of the last text (1.0.31).
// Field: a thread ended its turn with "once the desk reports the push, I request one batched reply ...". It waits for the desk's push result, but it did not say so with a
// `waiting` / blocked report: it looks stuck, and the open-TODO rule would have told it "do it now" (it must not request the reply before the push happened).
//
// waitingOn(h, home, threadId) -> null | { kind, since, text }       (STABLE SIGNATURE: fix431's idle-without-report alert and the continue rules call it as is)
//   kind 'push'   : the thread's last "ready to push" report, or the user's approve-push, is newer than the desk's last push record (history.jsonl `push`); at most 24 h
//   kind 'action' : a desk action request of the thread (a remote write) is pending, or approved and not sent yet (deskactions.ts listActions)
//   kind 'answer' : the thread asked the user (waiting.json while nothing was done since; or an open lean_ask line in questions.jsonl with no activity after it)
//   kind 'ci'     : <thread folder>/ci-wait.json {since, text}: a run the thread started and left running (nothing in 1.0.30 runs in the background: lean_run {ci} waits inside
//                   its own call; the record is the hook for one that will), at most 40 min
//   kind 'desk'   : the thread's own last report is state `waiting` (a restarted thread told to wait) and nothing was done since
// The first kind that holds wins, in the order above. `since` is the ms of the record; `text` is waitText(kind): what the desk shows ("waiting for push").
// Never throws: a record that cannot be read says nothing (null).
import { leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import { listActions } from './deskactions'
import { readActivity, readWaiting, stillWaiting, WAIT_EPS_MS } from './threadstate'

export type WaitKind = 'push' | 'action' | 'answer' | 'ci' | 'desk'
export type WaitOn = { kind: WaitKind; since: number; text: string }
export const PUSH_WAIT_MAX_MS = 24 * 3_600_000
export const CI_WAIT_MAX_MS = 40 * 60_000
const WAIT_TEXT: Record<WaitKind, string> = { push: 'waiting for push', action: 'waiting for an action result', answer: 'waiting for your answer', ci: 'waiting for CI', desk: 'waiting for the desk' }
export const waitText = (kind: WaitKind): string => WAIT_TEXT[kind]
const READY = /\bready to push\b/i

export async function waitingOn(h: Host, home: string, id: string): Promise<WaitOn | null> {
  try {
    const now = await h.clock.now()
    const mk = (kind: WaitKind, since: number): WaitOn => ({ kind, since, text: WAIT_TEXT[kind] })
    const act = await readActivity(h, home, id)
    const recs = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`).catch(() => [] as DeskRec[])).filter(r => r.from === id && (r.kind === 'report' || r.kind === 'ask') && !(r as { mod?: unknown }).mod)
    // push
    const hist = await readJsonl<{ kind?: string; ts?: number }>(h, `${threadsDir(home)}/${id}/history.jsonl`).catch(() => [] as { kind?: string; ts?: number }[])
    const at = (kind: string) => Math.max(0, ...hist.filter(x => x?.kind === kind && Number(x.ts) > 0).map(x => Number(x.ts)))
    const ready = Math.max(0, ...recs.filter(r => r.kind === 'report' && READY.test(String(r.text ?? ''))).map(r => r.ts))
    const sincePush = Math.max(ready, at('approve-push'))
    if (sincePush > 0 && sincePush > at('push') && now - sincePush < PUSH_WAIT_MAX_MS) return mk('push', sincePush)
    // action
    const acts = (await listActions(h).catch(() => [])).filter(r => r.thread === id)
    if (acts.length) return mk('action', Math.min(...acts.map(r => Number(r.ts) || now)))
    // answer
    const w = await readWaiting(h, home, id)
    if (w && stillWaiting(w, act?.at)) return mk('answer', w.since)
    const qs = await readJsonl<{ from?: string; ts?: number }>(h, `${leanDir(home)}/questions.jsonl`).catch(() => [] as { from?: string; ts?: number }[])
    const answered = new Set((await readJsonl<{ q: number }>(h, `${leanDir(home)}/answers.jsonl`).catch(() => [] as { q: number }[])).map(a => a.q))
    const open = qs.map((q, n) => ({ q, n })).filter(x => x.q && x.q.from === id && !answered.has(x.n + 1) && Number(x.q.ts) > 0 && (act?.at ?? 0) < Number(x.q.ts) + WAIT_EPS_MS)
    if (open.length) return mk('answer', Number(open[0]!.q.ts))
    // ci
    const ci = await readJson<{ since?: number } | null>(h, `${threadsDir(home)}/${id}/ci-wait.json`, null)
    if (ci && Number(ci.since) > 0 && now - Number(ci.since) < CI_WAIT_MAX_MS) return mk('ci', Number(ci.since))
    // desk
    const last = recs[recs.length - 1]
    if (last && last.kind === 'report' && last.state === 'waiting' && (act?.at ?? 0) < last.ts + WAIT_EPS_MS) return mk('desk', last.ts)
    return null
  } catch {
    return null
  }
}
