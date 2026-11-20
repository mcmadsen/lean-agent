// Goals chaser (design 25): a goal nobody touched for STALE_MS gets one "status?" message to its open thread, then
// is left alone for another STALE_MS. A thread that has an unread question to the user is waiting, not stuck.
import { homeDir, leanDir, readJson, writeJson } from './state'
import type { Host } from './state'
import { goalsLocked, unreadReports } from './delivery'
import type { Thread } from './threads'
import { threadsDir } from './state'
import { doneSession } from './finish'
import { checkBudget, expensiveNote } from './budgetalert'

export const STALE_MS = 60 * 60_000
export type Goal = { text: string; ts: number; chased?: number }
export const CHASE_TEXT = 'Status check from the desk: where are you on your goal, and are you blocked? Reply with lean_report.'

// `send` queues the message and wakes the thread once if it is idle (a running one only gets it queued)
export async function chase(h: Host, send: (id: string, text: string) => Promise<unknown>): Promise<string[]> {
  const home = await homeDir(h)
  await checkBudget(h) // the budget alerts ride on the same minute tick (budgetalert.ts): a desk notice and a toast at 50% / 80% and per expensive thread
  const file = `${leanDir(home)}/goals.json`
  const goals = await readJson<Record<string, Goal>>(h, file, {})
  const now = await h.clock.now()
  const asking = new Set((await unreadReports(h)).recs.filter(r => r.kind === 'ask').map(r => r.from))
  const chased: string[] = []
  for (const [id, g] of Object.entries(goals)) {
    if (!g || typeof g.text !== 'string' || asking.has(id)) continue
    if (now - (g.ts || 0) <= STALE_MS || now - (g.chased || 0) <= STALE_MS) continue
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    if (!t || t.state !== 'open' || !t.sid) continue
    if (t.finished || (await doneSession(h, home, t))) continue // a finished thread is not stuck: a message would start a whole new session
    g.chased = now
    chased.push(id)
    await send(id, CHASE_TEXT + (await expensiveNote(h, id))) // a thread over its daily alert is also asked what the spend bought
  }
  if (chased.length) {
    // sends can be slow: re-read, so a goal updated meanwhile is not overwritten; only `chased` is set
    await goalsLocked(async () => {
      const fresh = await readJson<Record<string, Goal>>(h, file, {})
      for (const id of chased) if (fresh[id]) fresh[id]!.chased = now
      await writeJson(h, file, fresh)
    })
  }
  return chased
}
