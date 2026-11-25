// The extra data of a thread's own pane cards (1.0.33): what threaddetail.ts does not hold and the files already do. Read straight from them, never a model call, never throws
// (a part that fails is a line in `errors`): the thread's standing rules (memory store), the open items of its task list (the snapshot), its scratch files, its msgs (queued /
// delivered / consumed / failed), the guard refusals of the last day, and its place in the desk's own list (how many sessions it had).
import { homeDir, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { readItems } from './memory'
import { readSnapshot } from './snapshot'
import type { SnapTask } from './snapshot'
import { scratchList } from './scratchnotes'
import type { ScratchFile } from './scratchnotes'
import { messageRecs } from './msgstate'
import type { MsgRec } from './msgstate'

export const MESSAGES_MAX = 8 // messages to the thread drawn (newest last)
export const REFUSAL_MS = 24 * 3_600_000
export type ThreadExtra = {
  rules: { id: string; text: string }[]
  tasks: SnapTask[] // the thread's task list as its last snapshot saw it (open ones first)
  scratch: ScratchFile[]
  msgs: MsgRec[] // desk and user messages TO the thread, oldest first, cut to the newest MESSAGES_MAX
  msgsTotal: number
  refusals: { n: number; last?: string } // guard refusals of this thread in the last 24 h
  created?: number
  restarts: number // sessions recorded for the thread minus the first (a mod reload or a resume is recorded too: "about")
  errors: string[]
}

const isOpen = (t: SnapTask) => t.status !== 'completed' && t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'deleted'

export async function loadThreadExtra(h: Host, id: string): Promise<ThreadExtra> {
  const x: ThreadExtra = { rules: [], tasks: [], scratch: [], msgs: [], msgsTotal: 0, refusals: { n: 0 }, restarts: 0, errors: [] }
  if (!/^t\d+$/.test(id)) return x
  let home = ''
  try {
    home = await homeDir(h)
  } catch {
    return x
  }
  const guard = async (what: string, f: () => Promise<void>) => {
    try {
      await f()
    } catch (e) {
      x.errors.push(`${what}: ${String((e as Error)?.message ?? e).slice(0, 160)}`)
    }
  }
  const dir = `${threadsDir(home)}/${id}`
  await guard('rules', async () => {
    x.rules = (await readItems(h, home)).filter(i => i.scope === `thread:${id}` && i.kind === 'rule' && i.status === 'active').map(i => ({ id: i.id, text: i.text }))
  })
  await guard('tasks', async () => {
    const tasks = (await readSnapshot(h, home, id))?.tasks ?? []
    x.tasks = [...tasks.filter(isOpen), ...tasks.filter(t => !isOpen(t))]
  })
  await guard('scratch', async () => {
    x.scratch = await scratchList(h, dir)
  })
  await guard('messages', async () => {
    const all = await messageRecs(h, home, id)
    x.msgsTotal = all.length
    x.msgs = all.slice(-MESSAGES_MAX)
  })
  await guard('refusals', async () => {
    const now = await h.clock.now().catch(() => Date.now())
    const rows = (await readJsonl<{ ts?: number; src?: string; kind?: string; thread?: string; text?: string }>(h, `${leanDir(home)}/refusals.jsonl`)).filter(r => r && r.thread === id && r.src !== 'worker' && r.kind !== 'missing-tool' && Number(r.ts) > now - REFUSAL_MS)
    x.refusals = { n: rows.length, ...(rows.length ? { last: String(rows[rows.length - 1]!.text ?? '').slice(0, 160) } : {}) }
  })
  await guard('record', async () => {
    const t = await readJson<{ created?: unknown; sids?: unknown } | null>(h, `${dir}/thread.json`, null)
    if (typeof t?.created === 'number' && t.created > 1_000_000) x.created = t.created
    x.restarts = Array.isArray(t?.sids) ? Math.max(0, new Set((t!.sids as unknown[]).filter(s => typeof s === 'string')).size - 1) : 0
  })
  return x
}
export const openTasks = (x: ThreadExtra): SnapTask[] => x.tasks.filter(isOpen)
