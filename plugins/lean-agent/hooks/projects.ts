// Projects: ~/.lean-agent/projects.json (carried over from 0.45; guard.ts and githooks.ts read it) plus the learned rules
// in ~/.lean-agent/<project>/ (learn.json). The desk lists them and adds, removes (unregisters only) or flips private.
import { homeDir, leanDir, readJson, realPath, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { slugOk } from './rules'
import type { Learn } from './rules'
import type { Thread } from './threads'

export type ProjectRow = {
  name: string
  path: string
  private: boolean
  guards: string // the push-deny list, or "default"
  areas: number // learned rule areas
  stale: number // of those, marked stale
  learned: string // date of the last learn, "never" when none
  threads: number // open threads on it
}
type Out = { ok: boolean; text: string; data?: unknown }
const err = (text: string): Out => ({ ok: false, text })
const file = (home: string) => `${leanDir(home)}/projects.json`
const BAD = new Set(['__proto__', 'constructor', 'prototype'])
const has = (o: Record<string, any>, k: string) => Object.prototype.hasOwnProperty.call(o, k)
let queue: Promise<unknown> = Promise.resolve() // one projects.json write at a time (a read-modify-write must not interleave)
const queued = <T,>(f: () => Promise<T>): Promise<T> => {
  const r = queue.then(f, f)
  queue = r.catch(() => undefined)
  return r
}
export const resetProjectsQueue = () => {
  queue = Promise.resolve()
}
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

// projects.json for a WRITE: a missing file is {}, a damaged one stops the write (it carries the private flags: never clobber it)
async function readForWrite(h: Host, home: string): Promise<Record<string, any> | null> {
  if (!(await h.fs.exists(file(home)))) return {}
  try {
    const t = String(await h.fs.read(file(home)))
    if (!t.trim()) return {}
    const v = JSON.parse(t)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

// Is this folder a linked git worktree (or a thread's worktree), not a project checkout? A linked worktree has a `.git` FILE
// ("gitdir: <main>/.git/worktrees/<name>"); the worktree skill keeps its worktrees under ~/.lean-agent/worktrees and in worktrees.json.
// null = a normal folder; otherwise `repo` is the main checkout when it can be read from the .git file.
export async function worktreeInfo(h: Host, home: string, path: string): Promise<{ repo?: string; why: string } | null> {
  const real = await realPath(h, path)
  let repo: string | undefined
  let linked = false
  const st = await h.fs.stat(`${real}/.git`).catch(() => null)
  if (st && st.kind === 'file') {
    linked = true
    const body = await h.fs.read(`${real}/.git`).catch(() => '')
    const m = typeof body === 'string' ? /^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/\n]+\s*$/m.exec(body) : null
    if (m) repo = m[1]
  }
  const under = `${await realPath(h, `${leanDir(home)}/worktrees`)}/`
  if (real.startsWith(under)) return { repo, why: 'it lives under ~/.lean-agent/worktrees' }
  const reg = await readJson<Record<string, { path?: unknown }>>(h, `${leanDir(home)}/worktrees.json`, {})
  for (const w of Object.values(isObj(reg) ? reg : {})) if (isObj(w) && typeof w.path === 'string' && (await realPath(h, w.path)) === real) return { repo, why: 'worktrees.json lists it as a worktree' }
  return linked ? { repo, why: 'it is a linked git worktree' } : null
}

// the registered project (name) whose checkout is `repo`
async function projectAt(h: Host, projs: Record<string, any>, repo: string | undefined): Promise<string | undefined> {
  if (!repo) return undefined
  const real = await realPath(h, repo)
  for (const [k, v] of Object.entries(projs)) if (isObj(v) && typeof v.path === 'string' && (await realPath(h, v.path)) === real) return k
  return undefined
}

// registered projects whose path is a git worktree (doctor flags them; project-remove unregisters, no file is deleted)
export async function worktreeProjects(h: Host): Promise<{ name: string; path: string; of?: string; why: string }[]> {
  const home = await homeDir(h)
  const projs = await readForWrite(h, home)
  const out: { name: string; path: string; of?: string; why: string }[] = []
  for (const [name, v] of Object.entries(projs ?? {})) {
    if (!isObj(v) || typeof v.path !== 'string' || !v.path) continue
    const w = await worktreeInfo(h, home, v.path).catch(() => null)
    if (!w) continue
    const of = await projectAt(h, projs!, w.repo)
    out.push({ name, path: v.path, of: of && of !== name ? of : undefined, why: w.why })
  }
  return out
}

// the 0.45 global switch: config.json `private: "off"` hides private projects everywhere
export const privateHidden = async (h: Host, home: string) => (await readJson<Record<string, unknown>>(h, `${leanDir(home)}/config.json`, {})).private === 'off'

async function threadsOf(h: Host, home: string): Promise<Thread[]> {
  const out: Thread[] = []
  let ents: { name: string }[] = []
  try {
    ents = await h.fs.list(threadsDir(home))
  } catch {
    return out
  }
  for (const e of ents) {
    if (!/^t\d+$/.test(e.name)) continue
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (t && t.id === e.name) out.push(t)
  }
  return out
}

export async function listProjects(h: Host, all = false): Promise<{ rows: ProjectRow[]; hidden: number; damaged?: boolean }> {
  const home = await homeDir(h)
  const wr = await readForWrite(h, home)
  const projs = wr ?? {}
  const hide = !all && (await privateHidden(h, home))
  const threads = await threadsOf(h, home)
  const rows: ProjectRow[] = []
  let hidden = 0
  for (const [name, v] of Object.entries(isObj(projs) ? projs : {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isObj(v)) continue
    if (hide && v.private === true) {
      hidden++
      continue
    }
    const lf = `${leanDir(home)}/${name}/learn.json`
    const learn = slugOk(name) ? await readJson<Learn>(h, lf, { sha: '', areas: {} }) : { sha: '', areas: {} }
    const areas = Object.values(learn.areas ?? {})
    const at = Math.max(0, ...areas.map(a => Number(a?.at) || 0))
    const learned = !areas.length ? 'never' : at ? new Date(at).toISOString().slice(0, 10) : 'date unknown'
    const pd = v.guards?.['push-deny']
    rows.push({
      name,
      path: typeof v.path === 'string' ? v.path : '',
      private: v.private === true,
      guards: Array.isArray(pd) ? (pd.length ? pd.filter((x: unknown) => typeof x === 'string').join(', ') : 'none') : 'default',
      areas: areas.length,
      stale: areas.filter(a => a?.stale).length,
      learned,
      threads: threads.filter(t => t.project === name && t.state === 'open').length,
    })
  }
  return { rows, hidden, ...(wr === null ? { damaged: true } : {}) }
}

// `new` with a project: null when it is registered (and not hidden by the private switch), else the refusal naming the known projects
export async function unknownProject(h: Host, name: string): Promise<string | null> {
  const { rows, damaged } = await listProjects(h)
  if (damaged) return 'projects.json is unreadable or not an object: fix it by hand first; no thread was created'
  if (rows.some(r => r.name === name)) return null
  const known = rows.map(r => r.name)
  return `unknown project ${name}: ${known.length ? `known projects: ${known.join(', ')}` : 'none registered'}. Register a folder with project-add (project, path), or leave project out. No thread was created.`
}

type PIn = { action: string; project?: string; path?: string; on?: boolean; all?: boolean; confirm?: boolean }
export const projectsAction = (h: Host, i: PIn): Promise<Out> => (i.action === 'projects' ? run(h, i) : queued(() => run(h, i)))

async function run(h: Host, i: PIn): Promise<Out> {
  const home = await homeDir(h)
  const name = (i.project ?? '').trim()
  if (i.action === 'projects') {
    const { rows, hidden, damaged } = await listProjects(h, i.all === true)
    if (damaged) return err('projects.json is unreadable or not an object: fix it by hand; nothing is listed')
    if (!rows.length && !hidden) return { ok: true, text: 'no projects registered (project-add: name + path)', data: [] }
    const lines = rows.map(r => `${r.name} · ${r.path || 'no path'} · ${r.private ? 'private' : 'not private'} · guards: ${r.guards} · rules: ${r.areas} area(s), learned ${r.learned}, ${r.stale} stale · ${r.threads} open thread(s)`)
    if (hidden) lines.push(`(${hidden} private project(s) hidden by the private switch; pass all: true to list them)`)
    return { ok: true, text: lines.join('\n'), data: rows }
  }
  if (!slugOk(name) || BAD.has(name)) return err(`${i.action} needs project: a name of letters, digits, . _ -`)
  const projs = await readForWrite(h, home)
  if (!projs) return err('projects.json is unreadable or not an object: fix it by hand first, nothing was changed')
  // a private project hidden by the private switch is not reachable without all: true (its name must not leak)
  const hide = i.all !== true && (await privateHidden(h, home))
  const have = has(projs, name) && !(hide && isObj(projs[name]) && projs[name].private === true) ? projs[name] : undefined
  const secret = has(projs, name) && have === undefined
  if (secret) return err(`no project ${name}`)
  switch (i.action) {
    case 'project-add': {
      const raw = (i.path ?? '').trim()
      if (!raw.startsWith('/')) return err('project-add needs path: an absolute path of an existing folder')
      const st = await h.fs.stat(raw).catch(() => null)
      if (!st || st.kind !== 'dir') return err(`${raw} does not exist or is not a folder`)
      const real = await realPath(h, raw)
      // a worktree or branch folder is not a project: it would sit in the list next to the real one (threads get their own
      // worktrees from the worktree skill; the project is the main checkout)
      const wt = await worktreeInfo(h, home, real)
      if (wt) {
        const of = await projectAt(h, projs, wt.repo)
        return err(`${real} is a git worktree (${wt.why})${of ? ` of ${of}` : wt.repo ? ` of ${wt.repo}` : ''}: register the main checkout${of ? ` (already registered as ${of})` : wt.repo ? ` ${wt.repo}` : ''}, never a worktree or branch folder`)
      }
      for (const [k, v] of Object.entries(projs)) {
        if (k !== name && isObj(v) && typeof v.path === 'string' && (await realPath(h, v.path)) === real) return err(hide && v.private === true ? `${real} is already registered` : `${real} is already registered as ${k}`)
      }
      if (isObj(have) && typeof have.path === 'string' && (await realPath(h, have.path)) !== real) return err(`${name} is already registered at ${have.path}: project-remove it first`)
      projs[name] = { ...(isObj(have) ? have : {}), path: real }
      await writeJson(h, file(home), projs)
      return { ok: true, text: `${name} registered at ${real}${isObj(have) ? ' (already was)' : ''}` }
    }
    case 'project-remove': {
      if (!isObj(have)) return err(`no project ${name}`)
      if (have.private === true) return err(`${name} is private: removing it would drop its push protection. Turn private off first (project-private on: false, confirm: true), if that is really wanted`)
      const users = (await threadsOf(h, home)).filter(t => t.project === name && t.state !== 'closed')
      if (users.length) return err(`${name} is used by ${users.map(t => t.id).join(', ')}: close ${users.length > 1 ? 'them' : 'it'} first`)
      delete projs[name]
      await writeJson(h, file(home), projs)
      return { ok: true, text: `${name} unregistered (no files were deleted)` }
    }
    case 'project-private': {
      if (!isObj(have)) return err(`no project ${name}`)
      if (typeof i.on !== 'boolean') return err('project-private needs on: true or false')
      if (!i.on && have.private === true && i.confirm !== true) return err(`${name} is private: turning it off lifts the push protection. Ask the user, then repeat with confirm: true`)
      projs[name] = { ...have, private: i.on }
      await writeJson(h, file(home), projs)
      return { ok: true, text: `${name} is now ${i.on ? 'private (never pushed or published)' : 'not private'}` }
    }
    default:
      return err(`unknown action ${i.action}`)
  }
}
