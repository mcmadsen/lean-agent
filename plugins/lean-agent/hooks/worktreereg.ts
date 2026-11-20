// The worktree registry, ~/.lean-agent/worktrees.json: an object keyed `<project>/<branch>` with {path, repo, branch, thread?, shared?,
// adopted?}. The worktree skill used to edit it by hand (Read, edit, Write), which failed silently on a key collision. Everything that
// adds, lists or prunes entries goes through here: the lean_worktree tool (a thread registers or adopts its worktree), the desk's push
// (adopts an unregistered linked worktree whose HEAD is the approved commit) and doctor (stale entries).
//
// A key is `<project>/<branch>`; when that key already belongs to ANOTHER live worktree the entry gets `<key>~2`, `~3` ... (git forbids `~`
// in a branch name, so a suffixed key never collides with a real one, and `startsWith('<project>/')` readers still see it). A key whose
// recorded path no longer exists, or is not a worktree any more, is replaced. A refusal always says why.
import { homeDir, leanDir, realPath, writeJson } from './state'
import type { Host } from './state'

export type WtEntry = { path?: unknown; repo?: unknown; branch?: unknown; thread?: unknown; shared?: unknown; adopted?: unknown }
export const registryFile = (home: string) => `${leanDir(home)}/worktrees.json`
const MAX_SUFFIX = 20

async function git(h: Host, dir: string, ...a: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await h.process.run(['git', '-C', dir, ...a], { timeoutMs: 15_000 })
    return { ok: r.exitCode === 0, out: r.stdout.trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

// the registry as an object; `damaged` when the file exists but is not a JSON object (never overwritten then)
export async function readRegistry(h: Host, home: string): Promise<{ reg: Record<string, WtEntry>; damaged: boolean }> {
  let text = ''
  try {
    text = String((await h.fs.exists(registryFile(home))) ? await h.fs.read(registryFile(home)) : '')
  } catch {
    return { reg: {}, damaged: true }
  }
  if (!text.trim()) return { reg: {}, damaged: false }
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? { reg: v, damaged: false } : { reg: {}, damaged: true }
  } catch {
    return { reg: {}, damaged: true }
  }
}

const abs = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/')

// What is at `path`: a git worktree's top folder (what the worktree skill's adopt checks) = live; nothing there = gone; a folder that git
// says is no worktree top (another top level, or "not a git repository") = plain; git did not answer (cannot run, odd error) = unknown.
// Only gone and plain are stale: an unknown is never replaced or pruned (a git that fails for a moment must not cost live entries).
export type WtState = 'live' | 'gone' | 'plain' | 'unknown'
export async function worktreeState(h: Host, path: string): Promise<WtState> {
  if (!abs(path) || !(await h.fs.exists(path).catch(() => false))) return 'gone'
  let r: { exitCode: number; stdout: string; stderr: string }
  try {
    r = await h.process.run(['git', '-C', path, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 })
  } catch {
    return 'unknown'
  }
  if (r.exitCode === 0) return r.stdout.trim() && (await realPath(h, r.stdout.trim())) === (await realPath(h, path)) ? 'live' : 'plain'
  return /not a git repository/i.test(r.stderr ?? '') ? 'plain' : 'unknown'
}
export const isWorktree = async (h: Host, path: string): Promise<boolean> => (await worktreeState(h, path)) === 'live'
const isStale = (s: WtState) => s === 'gone' || s === 'plain'

export type Linked = { path: string; head: string; branch: string }
// the LINKED worktrees of the repository `repo` belongs to (the main checkout, bare and prunable entries left out); branch '' = detached
export async function linkedWorktrees(h: Host, repo: string): Promise<Linked[]> {
  const r = await git(h, repo, 'worktree', 'list', '--porcelain')
  if (!r.ok) return []
  const out: Linked[] = []
  const blocks = r.out.split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(b => b.length)
  blocks.slice(1).forEach(lines => {
    let path = ''
    let head = ''
    let branch = ''
    let skip = false
    for (const l of lines) {
      if (l.startsWith('worktree ')) path = l.slice(9).trim()
      else if (l.startsWith('HEAD ')) head = l.slice(5).trim()
      else if (l.startsWith('branch ')) branch = l.slice(7).trim().replace(/^refs\/heads\//, '')
      else if (l === 'bare' || l.startsWith('prunable')) skip = true
    }
    if (path && abs(path) && !skip) out.push({ path, head, branch })
  })
  return out
}

export type RegInput = { project: string; path: string; repo: string; branch: string; thread: string; adopted?: boolean; shared?: boolean }
export type RegResult = { ok: boolean; key?: string; text: string }

let tail: Promise<unknown> = Promise.resolve()
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const r = tail.then(f, f)
  tail = r.catch(() => undefined)
  return r
}

export const registerWorktree = (h: Host, o: RegInput): Promise<RegResult> => serial(() => doRegister(h, o))

async function doRegister(h: Host, o: RegInput): Promise<RegResult> {
  const home = await homeDir(h)
  const { reg, damaged } = await readRegistry(h, home)
  if (damaged) return { ok: false, text: `worktree NOT registered: ${registryFile(home)} is not a JSON object (damaged); it was left as it is, fix or remove it first` }
  const real = await realPath(h, o.path)
  const base = `${o.project}/${o.branch}`
  const notes: string[] = []
  // the same worktree under ANY key (its branch may have changed since): another thread's, not shared, is never taken over
  let sharedPath = false
  for (const [k, e] of Object.entries(reg)) {
    if (!e || typeof e !== 'object' || !abs(e.path) || (await realPath(h, e.path)) !== real) continue
    if (typeof e.thread === 'string' && e.thread && e.thread !== o.thread && e.shared !== true) return { ok: false, key: k, text: `worktree NOT registered: ${e.path} is ${e.thread}'s (${k}, not shared); make a new worktree, or ask the user to mark it shared` }
    if (e.shared === true) sharedPath = true
  }
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const key = n === 1 ? base : `${base}~${n}`
    const cur = reg[key]
    let take = false
    if (!cur || typeof cur !== 'object') take = true
    else if (abs(cur.path) && (await realPath(h, cur.path)) === real) {
      // the same worktree: a refresh of this thread's own entry; a shared one of another thread stays as it is (it keeps its thread, so
      // it can still push) and this thread gets an entry of its own under the next key
      if (typeof cur.thread === 'string' && cur.thread && cur.thread !== o.thread) { notes.push(`${key} is ${cur.thread}'s shared entry`); continue }
      take = true
    } else if (!abs(cur.path) || isStale(await worktreeState(h, cur.path))) {
      notes.push(`replaced the stale entry ${key}${abs(cur.path) ? ` (${cur.path} is gone or no longer a worktree)` : ' (no usable path)'}`)
      take = true
    } else {
      notes.push(`${key} already points to the live worktree ${cur.path}`)
    }
    if (!take) continue
    const prev = reg[key] && typeof reg[key] === 'object' ? reg[key]! : {}
    reg[key] = { ...(prev.path && abs(prev.path) && (await realPath(h, prev.path)) === real ? prev : {}), path: o.path, repo: o.repo, branch: o.branch, thread: o.thread, ...(o.adopted ? { adopted: true } : {}), ...(o.shared || sharedPath ? { shared: true } : {}) }
    try {
      await writeJson(h, registryFile(home), reg)
    } catch (e) {
      return { ok: false, key, text: `worktree NOT registered: ${registryFile(home)} could not be written (${String((e as Error)?.message ?? e).slice(0, 120)})` }
    }
    if (n > 1) notes.push(`registered under ${key}`)
    return { ok: true, key, text: `registered ${key} -> ${o.path}${notes.length ? ` (${notes.join('; ')})` : ''}` }
  }
  return { ok: false, text: `worktree NOT registered: ${base} and its ${MAX_SUFFIX - 1} suffixed keys are all taken by live worktrees; run doctor (stale entries) or remove one` }
}

// A thread registers (or adopts: made with plain `git worktree add`) its own worktree: the path must be the top folder of a LINKED worktree
// of the project's own repository, on a branch.
export async function registerOwn(h: Host, home: string, o: { project: string; path: string; thread: string; shared?: boolean }): Promise<RegResult> {
  const no = (why: string): RegResult => ({ ok: false, text: `worktree NOT registered: ${why}` })
  if (!abs(o.path) || o.path.includes('/../') || o.path.endsWith('/..')) return no('path must be absolute (the worktree\'s top folder)')
  const projs = await readProjects(h, home)
  const repo = projs[o.project]
  if (!abs(repo)) return no(`${o.project} is not a registered project with a folder`)
  if (!(await isWorktree(h, o.path))) return no(`${o.path} is not the top folder of a git worktree`)
  const wc = await git(h, o.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const rc = await git(h, repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!wc.ok || !rc.ok || (await realPath(h, wc.out)) !== (await realPath(h, rc.out))) return no(`${o.path} is not a worktree of the repository of project ${o.project} (${repo})`)
  if ((await realPath(h, o.path)) === (await realPath(h, repo))) return no(`${o.path} is the main checkout of ${o.project}, not a linked worktree`)
  const br = await git(h, o.path, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  if (!br.ok || !br.out) return no(`${o.path} has no branch checked out (detached HEAD)`)
  const { reg } = await readRegistry(h, home)
  const adopted = !Object.values(reg).some(e => e && typeof e === 'object' && abs(e.path) && e.path === o.path)
  return registerWorktree(h, { project: o.project, path: o.path, repo, branch: br.out, thread: o.thread, ...(adopted && !o.path.startsWith(`${leanDir(home)}/worktrees/`) ? { adopted: true } : {}), ...(o.shared ? { shared: true } : {}) })
}

async function readProjects(h: Host, home: string): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(String(await h.fs.read(`${leanDir(home)}/projects.json`)))
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, any>).map(([k, p]) => [k, p?.path])) : {}
  } catch {
    return {}
  }
}

export type Stale = { key: string; path: string; why: string }
// entries whose path is gone, is not a worktree any more, or is missing
export async function staleEntries(h: Host): Promise<Stale[]> {
  const home = await homeDir(h)
  const { reg } = await readRegistry(h, home)
  const out: Stale[] = []
  for (const [key, e] of Object.entries(reg)) {
    if (!e || typeof e !== 'object' || !abs(e.path)) out.push({ key, path: '', why: 'no usable path' })
    else {
      const st = await worktreeState(h, e.path)
      if (st === 'gone') out.push({ key, path: e.path, why: 'the folder is gone' })
      else if (st === 'plain') out.push({ key, path: e.path, why: 'not a git worktree any more' })
    }
  }
  return out
}

// drops the stale entries (nothing else changes); returns what was dropped
export const pruneStale = (h: Host): Promise<Stale[]> =>
  serial(async () => {
    const home = await homeDir(h)
    const stale = await staleEntries(h)
    if (!stale.length) return []
    const { reg, damaged } = await readRegistry(h, home)
    if (damaged) return []
    // only what was seen stale: an entry another process replaced since (same key, another path) stays
    const dropped = stale.filter(s => (typeof reg[s.key]?.path === 'string' ? (reg[s.key]!.path as string) : '') === s.path)
    for (const s of dropped) delete reg[s.key]
    if (dropped.length) await writeJson(h, registryFile(home), reg)
    return dropped
  })

// The desk's push: a linked worktree of the project's repository whose HEAD is `sha`, on a branch, that no registry entry (of any thread)
// points at. Exactly one counts; several are ambiguous (named, never guessed).
export async function unregisteredAt(h: Host, home: string, repo: string, sha: string): Promise<{ one?: Linked; why?: string }> {
  const { reg } = await readRegistry(h, home)
  const taken = new Set<string>()
  for (const e of Object.values(reg)) if (e && typeof e === 'object' && abs(e.path)) taken.add(await realPath(h, e.path))
  const hits: Linked[] = []
  for (const w of await linkedWorktrees(h, repo)) if (w.head === sha && w.branch && !taken.has(await realPath(h, w.path))) hits.push(w)
  if (hits.length === 1) return { one: hits[0] }
  if (hits.length > 1) return { why: `${hits.length} unregistered worktrees are at ${sha.slice(0, 8)} (${hits.map(w => w.path).join(', ')}): register the right one (lean_worktree register)` }
  return {}
}
