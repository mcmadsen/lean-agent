// Done = session over. A thread whose last report is `done` has finished its piece of work: once its turn has ended (its session is
// idle) the desk's 10 s tick stops the session and marks the thread `finished` (threads.ts action `finish`). Whatever comes for it
// later (send, wake, resume, start) starts a NEW session with the handover (brief, goal, notes, reports including the done report,
// queued messages, branch and worktree), never a resume of the old conversation. A thread that reported done but is still working
// (a final step) is left alone until it is idle; blocked, question and progress reports never finish a session.
import { homeDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import type { Thread } from './threads'

export const finishedText = (id: string) => `${id} finished: next message starts a new session`

// is the thread's LAST report to the desk a done report of its current session (written since the session was last started or woken)?
// A question or a later progress report after the done report means more work followed: not done.
export async function doneSession(h: Host, home: string, t: Thread): Promise<boolean> {
  const recs = await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)
  for (let n = recs.length - 1; n >= 0; n--) {
    const r = recs[n]
    if (!r || r.from !== t.id) continue
    return r.kind === 'report' && r.state === 'done' && r.ts >= (t.lastWake || 0)
  }
  return false
}

// The desk's tick: open threads with a session that are not finished yet and whose last report is done; `run` is leanThread's `finish`
// action (it checks again under the thread's lock, leaves a working session alone and stops an idle one). Returns the ids it finished.
let sweeping = false // ticks overlap when a stop is slow (it waits up to 8 s): one sweep at a time
export async function sweepFinished(h: Host, run: (id: string) => Promise<{ ok: boolean; text: string; data?: unknown } | unknown>): Promise<string[]> {
  if (sweeping) return []
  sweeping = true
  try {
    const home = await homeDir(h)
    const did: string[] = []
    let ents: { name: string }[] = []
    try {
      ents = await h.fs.list(threadsDir(home))
    } catch {
      return did
    }
    for (const e of ents.filter(x => /^t\d+$/.test(x.name)).sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))) {
      const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
      if (!t || t.state !== 'open' || !t.sid || t.finished) continue
      if (!(await doneSession(h, home, t))) continue
      const r: any = await run(e.name)
      if (r?.ok && r.data?.finished === true) did.push(e.name)
    }
    return did
  } finally {
    sweeping = false
  }
}
export const resetFinish = (): void => {
  sweeping = false
}
