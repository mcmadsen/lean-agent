// Preflight pack (execution model): what a thread's fresh start needs to know about its checkout, computed by script, no model. The
// handover includes it (`preflightText`), so the new session starts from facts instead of exploring with its own tool calls.
import { leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { listProjects } from './projects'
import { readRegistry } from './worktreereg'

export type PreflightThread = { id: string; cwd: string; home: string }

const NA = 'n/a'
const one = (s: string) => s.trim().split('\n')[0]!.trim()

async function git(h: Host, cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const r = await h.process.run(['git', '-C', cwd, ...args])
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

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

// the user's open to-do items (todo.json: an array, or { items }), at most 5
async function openTasks(h: Host, home: string): Promise<string> {
  const raw: any = await readJson<any>(h, `${leanDir(home)}/todo.json`, null)
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : []
  const open = list.filter(x => x && typeof x === 'object' && !x.done && !x.completed).map(x => String(x.text ?? x.title ?? '').trim()).filter(Boolean)
  return open.length ? open.slice(0, 5).map(t => `- ${t.slice(0, 120)}`).join('\n') + (open.length > 5 ? `\n(+${open.length - 5} more)` : '') : NA
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
  const branch = await git(h, t.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  const head = await git(h, t.cwd, 'log', '-1', '--format=%h %s')
  const status = await git(h, t.cwd, 'status', '--short')
  const stat = await git(h, t.cwd, 'diff', '--stat')
  const st = status === null ? [] : status.split('\n').filter(l => l.trim())
  const statLines = st.length > 30 ? [...st.slice(0, 30), `(+${st.length - 30} more)`] : st
  const diffLast = stat === null ? NA : stat.trim() ? stat.trim().split('\n').pop()!.trim() : 'no unstaged changes'
  return [
    `preflight (computed by script, ${t.id}):`,
    `branch: ${branch === null ? NA : one(branch) || NA}`,
    `HEAD: ${head === null ? NA : one(head) || NA}`,
    `status: ${status === null ? NA : st.length ? `${st.length} changed` : 'clean'}`,
    ...statLines.map(l => `  ${l}`),
    `diff: ${diffLast}`,
    `last report: ${await part(() => lastReport(h, t.home, t.id), NA)}`,
    `open tasks: ${await part(() => openTasks(h, t.home), NA)}`,
    `PR / work item: ${await part(() => knownRef(h, t.home, t.id), NA)}`,
  ].join('\n').split('\n').slice(0, 40).join('\n')
}

// The adapter handover.ts calls (`setPreflight(preflightFor)` in register.tsx): the thread's checkout is the worktree registered to it,
// else its project's folder; with neither, git finds nothing and the pack says n/a.
export async function preflightFor(h: Host, home: string, t: { id: string; project: string }): Promise<string> {
  let cwd = ''
  try {
    const { reg } = await readRegistry(h, home)
    const own = Object.values(reg).find(e => e && e.thread === t.id && typeof e.path === 'string')
    if (own) cwd = String(own.path)
  } catch {
    /* no registry */
  }
  if (!cwd) cwd = (await listProjects(h, true).catch(() => ({ rows: [] as { name: string; path: string }[] }))).rows.find(r => r.name === t.project)?.path ?? ''
  return preflightText(h, { id: t.id, cwd, home })
}
