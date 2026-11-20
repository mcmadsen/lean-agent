// The state snapshot of a thread (user requirement: the store is the memory). At every main-thread turn end the thread's own mod writes
// <thread folder>/state.json by script, atomically, with no model turn: branch, HEAD, `git status --short`, the diff stat, the files edited
// this turn, the task list, the last report, the open questions and the context size. A session started from scratch (handover.ts) reads
// it, so it knows the real state of the work without the old conversation. A failed git call leaves its field empty, never an error.
import { atomicWrite, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'

export type SnapTask = { text: string; status: string }
export type SnapPending = { agent: string; text: string }
export type Snapshot = {
  v: 1
  id: string
  at: number
  sid: string
  dir: string // where git ran (the thread's worktree, else its folder)
  branch: string
  head: string
  status: string[] // `git status --short`, cut
  diffStat: string
  edited: string[] // files edited in the turn that just ended
  tasks: SnapTask[]
  lastReport: { ts: number; state: string; text: string } | null
  questions: string[] // asks of this thread newer than its last report
  tokens: number | null // the session's context size
  pending?: SnapPending[] // results of workers that finished after the context limit stopped the thread (recorded by script, not acted on)
}

const STATUS_MAX = 40
const EDITED_MAX = 40
const TASKS_MAX = 30
const REPORT_MAX = 1_500
const QUESTION_MAX = 400
const PENDING_MAX = 10
const PENDING_TEXT = 600
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + '…')

export const snapshotFile = (home: string, id: string) => `${threadsDir(home)}/${id}/state.json`

// ---- the files edited in the running turn (the mod's tool.call hooks fill it, turn.start empties it) ----------------------------
const edited = new Set<string>()
export const noteEdited = (path: unknown) => {
  if (typeof path === 'string' && path) edited.add(path)
}
export const takeEdited = (): string[] => [...edited]
export const resetEdited = () => edited.clear()

// ---- the task list: what the session wrote with TodoWrite / TaskCreate / TaskUpdate (tool.call hooks fill it; a hooks module cannot read
// the engine's own list) --------------------------------------------------------------------------------------------------------------
let todos: SnapTask[] = []
const byId = new Map<string, SnapTask>()
export const resetTasks = () => {
  todos = []
  byId.clear()
}
export const currentTasks = (): SnapTask[] => todos.map(t => ({ ...t }))
export function noteTasks(tool: unknown, input: any): void {
  if (tool === 'TodoWrite' && Array.isArray(input?.todos)) {
    todos = tasksOf(input.todos)
    byId.clear()
  } else if (tool === 'TaskCreate') {
    const text = String(input?.subject ?? input?.content ?? '').trim()
    if (!text) return
    const t = { text: cut(text, 200), status: 'pending' }
    todos.push(t)
    byId.set(String(todos.length), t)
  } else if (tool === 'TaskUpdate' && input?.taskId !== undefined) {
    const t = byId.get(String(input.taskId))
    if (t && typeof input.status === 'string') t.status = input.status
  }
}

async function git(h: Host, dir: string, args: string[]): Promise<string> {
  try {
    const r = await h.process.run(['git', '-C', dir, ...args], { timeoutMs: 15_000 })
    return r.exitCode === 0 ? r.stdout.replace(/\s+$/, '') : ''
  } catch {
    return ''
  }
}

// The thread's worktree (the last one registered for it), else its own folder.
async function workDir(h: Host, home: string, id: string): Promise<string> {
  const reg = await readJson<Record<string, { path?: string; thread?: string }>>(h, `${leanDir(home)}/worktrees.json`, {})
  const mine = Object.values(reg && typeof reg === 'object' ? reg : {}).filter(w => w && w.thread === id && typeof w.path === 'string')
  return mine[mine.length - 1]?.path ?? `${threadsDir(home)}/${id}`
}

// Tolerant: the engine's task list, whatever shape it comes in ({content|text|subject, status}); strings are pending tasks.
export function tasksOf(raw: unknown): SnapTask[] {
  const list = Array.isArray(raw) ? raw : []
  const out: SnapTask[] = []
  for (const t of list) {
    if (typeof t === 'string' && t.trim()) out.push({ text: cut(t.trim(), 200), status: 'pending' })
    else if (t && typeof t === 'object') {
      const text = String((t as any).content ?? (t as any).text ?? (t as any).subject ?? (t as any).title ?? '').trim()
      if (text) out.push({ text: cut(text, 200), status: String((t as any).status ?? 'pending') })
    }
    if (out.length >= TASKS_MAX) break
  }
  return out
}

export async function buildSnapshot(h: Host, home: string, id: string, o: { sid?: string; tokens?: number | null; edited?: string[]; tasks?: unknown; pending?: SnapPending[] } = {}): Promise<Snapshot> {
  const dir = await workDir(h, home, id)
  const [branch, head, status, stat] = await Promise.all([git(h, dir, ['rev-parse', '--abbrev-ref', 'HEAD']), git(h, dir, ['rev-parse', 'HEAD']), git(h, dir, ['status', '--short']), git(h, dir, ['diff', '--stat', 'HEAD'])])
  const recs = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r.from === id && (r.kind === 'report' || r.kind === 'ask'))
  const reports = recs.filter(r => r.kind === 'report' && !(r as any).mod)
  const last = reports[reports.length - 1]
  const asks = recs.filter(r => r.kind === 'ask' && (!last || r.ts > last.ts))
  const lines = status ? status.split('\n') : []
  const statLines = stat ? stat.split('\n') : []
  return {
    v: 1,
    id,
    at: await h.clock.now(),
    sid: o.sid ?? '',
    dir,
    branch,
    head,
    status: lines.slice(0, STATUS_MAX).concat(lines.length > STATUS_MAX ? [`… ${lines.length - STATUS_MAX} more`] : []),
    diffStat: statLines.length > 6 ? `${statLines.slice(0, 5).join('\n')}\n… ${statLines[statLines.length - 1]}` : stat,
    edited: (o.edited ?? []).slice(0, EDITED_MAX),
    tasks: tasksOf(o.tasks),
    lastReport: last ? { ts: last.ts, state: last.state || 'working', text: cut(String(last.text ?? '').trim(), REPORT_MAX) } : null,
    questions: asks.slice(-5).map(a => cut(String(a.text ?? '').trim(), QUESTION_MAX)),
    tokens: typeof o.tokens === 'number' && Number.isFinite(o.tokens) ? Math.round(o.tokens) : null,
    ...(o.pending?.length ? { pending: o.pending.slice(-PENDING_MAX).map(p => ({ agent: cut(String(p.agent), 60), text: cut(String(p.text), PENDING_TEXT) })) } : {}),
  }
}

// atomic (tmp file + mv); false when the write failed (the old file stays)
export async function writeSnapshot(h: Host, home: string, snap: Snapshot): Promise<boolean> {
  try {
    await atomicWrite(h, snapshotFile(home, snap.id), JSON.stringify(snap, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

export async function readSnapshot(h: Host, home: string, id: string): Promise<Snapshot | null> {
  const s = await readJson<Partial<Snapshot> | null>(h, snapshotFile(home, id), null)
  return s && typeof s === 'object' && s.v === 1 && s.id === id && typeof s.at === 'number' ? (s as Snapshot) : null
}

// "3 min", "2 h": the age of the snapshot
export function ageText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 1 ? 'under a minute' : m < 120 ? `${m} min` : `${Math.round(m / 60)} h`
}

// The handover section: what a fresh session needs to know about the working tree without running git first.
export function snapshotText(s: Snapshot, now: number): string {
  const l: string[] = [`taken ${ageText(now - s.at)} ago, at the end of the last turn (threads/${s.id}/state.json); check with git before you rely on it`]
  if (s.branch || s.head) l.push(`branch: ${s.branch || '?'} · HEAD ${s.head ? s.head.slice(0, 10) : '?'}${s.dir ? ` · in ${s.dir}` : ''}`)
  l.push(s.status.length ? `git status --short:\n${s.status.map(x => `  ${x}`).join('\n')}` : 'git status --short: clean (or not readable)')
  if (s.diffStat) l.push(`diff stat:\n${s.diffStat.split('\n').map(x => `  ${x}`).join('\n')}`)
  if (s.edited.length) l.push(`edited in the last turn: ${s.edited.join(', ')}`)
  if (s.tasks.length) l.push(`task list:\n${s.tasks.map(t => `  [${t.status}] ${t.text}`).join('\n')}`)
  if (s.lastReport) l.push(`last report (${s.lastReport.state}): ${s.lastReport.text.replace(/\s+/g, ' ')}`)
  if (s.questions.length) l.push(`open questions:\n${s.questions.map(q => `  - ${q.replace(/\s+/g, ' ')}`).join('\n')}`)
  if (s.pending?.length) l.push(`pending results (workers that finished after the context limit stopped the thread; read them, they were not acted on):\n${s.pending.map(p => `  - ${p.agent}: ${p.text.replace(/\s+/g, ' ')}`).join('\n')}`)
  if (s.tokens !== null) l.push(`context at that time: ${s.tokens} tokens`)
  return l.join('\n')
}
