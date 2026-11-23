// Preflight pack (execution model): what a thread's fresh start needs to know about its checkout, computed by script, no model. The
// handover includes it (`preflightText`), so the new session starts from facts instead of exploring with its own tool calls.
import { leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { listProjects } from './projects'
import { readRegistry } from './worktreereg'
import { STOP_WORDS } from './stopwords'
import { GIT_LINE, atText, sharedGit } from './snapshot'

export type PreflightThread = { id: string; cwd: string; home: string; title?: string; goal?: string; branch?: string; worktree?: string }

const NA = 'n/a'

// the last non-empty line of the thread's last report to the desk (desk/inbox.jsonl)
async function lastReport(h: Host, home: string, id: string): Promise<string> {
  const rows = await readJsonl<{ from?: string; kind?: string; text?: string }>(h, `${leanDir(home)}/desk/inbox.jsonl`).catch(() => [])
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r && r.from === id && r.kind === 'report' && typeof r.text === 'string') {
      const lines = r.text.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length) return lines[lines.length - 1]!.slice(0, 200)
    }
  }
  return NA
}

// ---- the open tasks that are about THIS thread (the to-do list is the whole account's) -----------------------------------------------
export const TASKS_SHOWN = 5
const STOP = new Set(STOP_WORDS)
// the significant words of a text: lower case, at least 3 characters, not a stop word, not a bare number
export const significantWords = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter(w => !STOP.has(w) && !/^\d+$/.test(w)))
// the PR / work item references in a text, as keys ("pr:42", "wi:7")
export function refKeys(s: string): Set<string> {
  const k = new Set<string>()
  for (const m of s.matchAll(/\b(?:PR|pull request)\s*#?(\d+)/gi)) k.add(`pr:${m[1]}`)
  for (const m of s.matchAll(/\/pull(?:request)?s?\/(\d+)/gi)) k.add(`pr:${m[1]}`)
  for (const m of s.matchAll(/\bAB#(\d+)|\bwork item\s*#?(\d+)/gi)) k.add(`wi:${m[1] ?? m[2]}`)
  return k
}
export type TaskCtx = { id: string; title?: string; goal?: string; branch?: string; worktree?: string; ref?: string }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// does this to-do item belong to the thread: it carries the thread's id, its branch or worktree, its PR / work item, or shares two significant
// words with the thread's goal / title
export function taskIsAbout(x: Record<string, unknown>, c: TaskCtx): boolean {
  const text = String(x.text ?? x.title ?? '')
  const links = [x.thread, ...(Array.isArray(x.threads) ? x.threads : []), x.branch, x.worktree, x.path, x.cwd, x.pr, x.ref, x.workItem, x.url].filter(v => typeof v === 'string' || typeof v === 'number').join(' ')
  const hay = `${text} ${links}`
  if (c.id && new RegExp(`(?<![\\w])${esc(c.id)}(?![\\w])`, 'i').test(hay)) return true
  if (c.branch && c.branch.length >= 4 && !/^(HEAD|main|master|develop)$/.test(c.branch) && hay.includes(c.branch)) return true
  if (c.worktree && hay.includes(c.worktree)) return true
  const mine = refKeys(c.ref ?? '')
  if (mine.size) for (const k of refKeys(hay)) if (mine.has(k)) return true
  const a = significantWords(`${c.goal ?? ''} ${c.title ?? ''}`)
  let shared = 0
  for (const w of significantWords(text)) if (a.has(w) && ++shared >= 2) return true
  return false
}

// the user's open to-do items (todo.json: an array, or { items }) that are about this thread: at most 5, then a count of the others, never the rest
async function openTasks(h: Host, home: string, c: TaskCtx): Promise<string> {
  const raw: any = await readJson<any>(h, `${leanDir(home)}/todo.json`, null)
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : []
  const open = list.filter(x => x && typeof x === 'object' && !x.done && !x.completed && String(x.text ?? x.title ?? '').trim())
  const mine = open.filter(x => taskIsAbout(x, c))
  if (!mine.length) return 'none linked to this thread'
  const shown = mine.slice(0, TASKS_SHOWN).map(x => `- ${String(x.text ?? x.title).trim().slice(0, 120)}`)
  const more = mine.length - shown.length
  const other = open.length - mine.length
  return `\n${shown.join('\n')}${more > 0 ? `\n(+${more} more tasks about this thread)` : ''}${other > 0 ? `\n(${other} more tasks not about this thread)` : ''}`
}

// a PR / work item reference named in the thread's brief
async function knownRef(h: Host, home: string, id: string): Promise<string> {
  let brief = ''
  try {
    brief = String((await h.fs.read(`${threadsDir(home)}/${id}/brief.md`)) ?? '')
  } catch {
    return NA
  }
  const m = brief.match(/^.*(\bPR\s*#?\d+|\bpull request\s*#?\d+|\bAB#\d+|\bwork item\s*#?\d+|\/pull\/\d+|\/pullrequest\/\d+).*$/im)
  return m ? m[0].trim().slice(0, 200) : NA
}

export async function preflightText(h: Host, t: PreflightThread): Promise<string> {
  const part = async <T>(f: () => Promise<T>, d: T): Promise<T> => f().catch(() => d)
  // ONE computation of the working tree's state, shared with the state snapshot (snapshot.ts sharedGit): the snapshot's own fields when it is
  // younger than 60 s, else computed once and written back to it: the handover never prints two numbers for one file
  const { facts: g, at, reused } = await part(() => sharedGit(h, t.home, t.id, t.cwd), { facts: { branch: '', head: '', headLine: '', status: [] as string[], diffStat: '', ok: false }, at: 0, reused: false })
  const st = g.status.filter(l => l.trim())
  const statLines = st.length > 20 ? [...st.slice(0, 20), `(+${st.length - 20} more)`] : st
  const dirty = st.length > 0
  const ref = await part(() => knownRef(h, t.home, t.id), NA)
  const tasks = await part(() => openTasks(h, t.home, { id: t.id, title: t.title, goal: t.goal, branch: g.branch || t.branch, worktree: t.worktree, ref: ref === NA ? '' : ref }), NA)
  return [
    `preflight (computed by script, ${t.id}):`,
    `branch: ${g.branch || NA}`,
    `HEAD: ${g.headLine || NA}`,
    g.ok ? `${GIT_LINE}${atText(at)} (${reused ? 'from the state snapshot' : 'computed now'}): commit ${g.head.slice(0, 7)}, worktree ${dirty ? 'dirty' : 'clean'}` : `git state: not readable${t.cwd ? '' : ' (no checkout registered)'}`,
    `status: ${!g.ok ? NA : dirty ? `${st.length} changed` : 'clean'}`,
    ...statLines.map(l => `  ${l}`),
    ...(g.ok ? [`diff vs HEAD: ${g.diffStat.trim() ? '' : 'no changes'}`.trimEnd(), ...(g.diffStat.trim() ? g.diffStat.split('\n').map(l => `  ${l}`) : [])] : [`diff vs HEAD: ${NA}`]),
    `last report: ${await part(() => lastReport(h, t.home, t.id), NA)}`,
    `open tasks:${tasks.startsWith('\n') ? tasks : ` ${tasks}`}`,
    `PR / work item: ${ref}`,
  ].join('\n').split('\n').slice(0, 40).join('\n')
}

// The adapter handover.ts calls (`setPreflight(preflightFor)` in register.tsx): the thread's checkout is the worktree registered to it,
// else its project's folder; with neither, git finds nothing and the pack says n/a.
export async function preflightFor(h: Host, home: string, t: { id: string; project: string; title?: string; lastGoal?: string }): Promise<string> {
  let cwd = ''
  let worktree = ''
  let branch = ''
  try {
    const { reg } = await readRegistry(h, home)
    const own = Object.values(reg).find(e => e && e.thread === t.id && typeof e.path === 'string')
    if (own) {
      cwd = String(own.path)
      worktree = cwd
      branch = typeof own.branch === 'string' ? own.branch : ''
    }
  } catch {
    /* no registry */
  }
  if (!cwd) cwd = (await listProjects(h, true).catch(() => ({ rows: [] as { name: string; path: string }[] }))).rows.find(r => r.name === t.project)?.path ?? ''
  const goals = await readJson<Record<string, { text?: string }>>(h, `${leanDir(home)}/goals.json`, {}).catch(() => ({}) as Record<string, { text?: string }>)
  const brief = String(await h.fs.read(`${threadsDir(home)}/${t.id}/brief.md`).catch(() => '')).split('\n').find(l => l.trim()) ?? ''
  const goal = (typeof goals?.[t.id]?.text === 'string' ? goals[t.id]!.text! : '') || t.lastGoal || brief
  return preflightText(h, { id: t.id, cwd, home, title: t.title, goal, branch, worktree })
}
