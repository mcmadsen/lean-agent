// Guards for `tool.call` (design 2.6): strict mode for the desk, push gate and private projects everywhere,
// read-only and --allow-edit grants for worker subagents. `decide` answers a deny text or null (allow).
// register.tsx wraps it fail-closed: a throwing guard denies.
import { homeDir, leanDir, readJson, realPath, threadsDir } from './state'
import type { Host } from './state'
import type { Role } from './role'

export type Ctx = { role: Role; cwd: string; agentType?: string } // agentType: set inside a subagent loop
export type Call = { tool: string; [k: string]: any }
export type Grants = { edit?: string[]; cmds?: string[] }

export const ROUTE = 'lean-agent strict mode: route this to a thread (thread skill)'

// ---- paths ---------------------------------------------------------------------------------------------------
export function norm(p: string): string {
  const out: string[] = []
  for (const s of p.split('/')) {
    if (!s || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return '/' + out.join('/')
}
export const within = (p: string, root: string) => p === root || p.startsWith(root.replace(/\/$/, '') + '/')

async function resolve($: Host, p: string, cwd: string): Promise<string> {
  const abs = p.startsWith('/') ? norm(p) : norm(`${cwd}/${p}`)
  return norm(await realPath($, abs))
}

// ---- shell command analysis ----------------------------------------------------------------------------------
const META = /[;&|<>`\n\r]|\$\(|\$\{/
export const hasMeta = (c: string) => META.test(c)

function words(c: string): string[] {
  return (c.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^(["'])(.*)\1$/, '$2'))
}

// The command reaches git push / gh publishing anywhere in its text (quotes, eval and bash -c included).
export const PUSH = /\bgit\b[^;&|\n]*\bpush\b/
export const PUBLISH = /\bgh\b[^;&|\n]*\b(pr\s+create|pr\s+comment|issue\s+comment|comment|review\s+[^;&|\n]*--(comment|body|approve|request-changes))\b/
// Directories a command works in: `git -C dir`, `cd dir`, `--git-dir`-less; the session cwd is always one.
export function dirsOf(c: string, cwd: string): string[] {
  const out = [cwd]
  for (const m of c.matchAll(/\bgit\s+(?:-[^C\s]\S*\s+)*-C\s+("[^"]+"|'[^']+'|\S+)/g)) out.push(m[1]!.replace(/^["']|["']$/g, ''))
  for (const m of c.matchAll(/(?:^|[;&|(]\s*|&&\s*)cd\s+("[^"]+"|'[^']+'|\S+)/g)) out.push(m[1]!.replace(/^["']|["']$/g, ''))
  return out.map(d => (d.startsWith('/') ? norm(d) : norm(`${cwd}/${d}`)))
}

type Proj = { path?: string; private?: boolean }
export async function projectOf($: Host, dir: string): Promise<{ slug: string; private: boolean } | null> {
  const home = await homeDir($)
  const projs = await readJson<Record<string, Proj>>($, `${leanDir(home)}/projects.json`, {})
  const real = await realPath($, dir)
  const wt = `${leanDir(home)}/worktrees/`
  let slug = ''
  if (real.startsWith(wt)) slug = real.slice(wt.length).split('/')[0] ?? ''
  for (const [k, v] of Object.entries(projs ?? {})) {
    if (!v || typeof v !== 'object' || !v.path) continue
    const p = await realPath($, norm(v.path))
    if (within(real, p) || k === slug) return { slug: k, private: v.private === true }
  }
  return slug ? { slug, private: false } : null
}

async function pushDenial($: Host, c: string, cwd: string): Promise<string | null> {
  const publishing = PUBLISH.test(c)
  const pushing = PUSH.test(c)
  if (!publishing && !pushing) return null
  const dirs = dirsOf(c, cwd)
  for (const d of dirs) {
    const p = await projectOf($, d)
    if (p?.private) return `lean-agent: ${p.slug} is a private project: it is never pushed or published (no override)`
  }
  if (!pushing) return null
  const dir = dirs[dirs.length - 1]!
  const r = await $.process.run(['git', '-C', dir, 'rev-parse', 'HEAD'])
  const sha = r.exitCode === 0 ? r.stdout.trim() : ''
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return 'lean-agent push gate: cannot read HEAD here, so no review can unlock the push'
  const p = await projectOf($, dir)
  if (!p) return `lean-agent push gate: this folder belongs to no lean-agent project; review ${sha.slice(0, 8)} first`
  const rec = await readJson<any>($, `${leanDir(await homeDir($))}/${p.slug}/reviews/${sha}.json`, null)
  if (rec && (rec.green === true || rec.verdict === 'green')) return null
  return `lean-agent push gate: no green review for ${sha.slice(0, 8)} (project ${p.slug}); run the review skill first`
}

// ---- strict mode (desk) --------------------------------------------------------------------------------------
const DESK_DENY = new Set(['Edit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'WebFetch'])
const DESK_READ = new Set(['Read', 'Grep', 'Glob'])

function deskBashOk(c: string): boolean {
  if (hasMeta(c)) return false
  const w = words(c.trim())
  if (w[0] === 'claude') return w[1] === '--bg' || w[1] === 'agents'
  if (w[0] === 'gh') return w[1] === 'pr' && (w[2] === 'view' || w[2] === 'list')
  if (w[0] === 'git' && w[1] === '-C' && w.length >= 4) return (w[3] === 'log' || w[3] === 'status') && !w.some(x => x.startsWith('--output'))
  return false
}

async function deskDenial($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  if (DESK_DENY.has(e.tool)) return `${ROUTE}: ${e.tool} is not for the desk`
  if (DESK_READ.has(e.tool)) {
    const raw: string = e.file_path ?? e.path ?? ''
    if (!raw) return `${ROUTE}: ${e.tool} only under ${leanDir(await homeDir($))}`
    const p = await resolve($, raw, ctx.cwd)
    return within(p, await realPath($, leanDir(await homeDir($)))) || within(p, leanDir(await homeDir($))) ? null : `${ROUTE}: ${e.tool} only under ${leanDir(await homeDir($))}`
  }
  if (e.tool === 'Bash') return deskBashOk(String(e.command ?? '')) ? null : ROUTE
  return null
}

// ---- workers -------------------------------------------------------------------------------------------------
export const isReader = (t?: string) => !!t && (/^reader-/.test(t) || t === 'reviewer' || t === 'explorer')
export const isWorker = (t?: string) => !!t && /^worker-/.test(t)

export async function grantsFile($: Host, role: Role): Promise<string> {
  const home = await homeDir($)
  return role.kind === 'thread' ? `${threadsDir(home)}/${role.id}/grants.json` : `${leanDir(home)}/grants.json`
}

async function workerDenial($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  const t = ctx.agentType
  const edits = e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit'
  if (isReader(t)) {
    if (edits) return `lean-agent: ${t} is read-only`
    if (e.tool === 'Bash' && t === 'explorer') {
      const c = String(e.command ?? '').trim()
      return !hasMeta(c) && /^git (log|ls-files)( |$)/.test(c) ? null : 'lean-agent: explorer may run only git log and git ls-files'
    }
    if (e.tool === 'Bash') {
      const g = await readJson<Grants>($, await grantsFile($, ctx.role), {})
      const c = String(e.command ?? '').trim()
      const ok = !hasMeta(c) && (g.cmds ?? []).some(x => c === x || c.startsWith(x + ' '))
      return ok ? null : `lean-agent: ${t} may run only the commands the thread granted (allow-cmd)`
    }
    return null
  }
  if (isWorker(t) && edits) {
    const g = await readJson<Grants>($, await grantsFile($, ctx.role), {})
    const raw: string = e.file_path ?? e.notebook_path ?? ''
    if (!raw) return 'lean-agent: edit without a path'
    const p = await resolve($, raw, ctx.cwd)
    for (const root of g.edit ?? []) if (within(p, norm(root))) return null
    return `lean-agent: ${p} is outside the paths the thread granted this worker (allow-edit)`
  }
  return null
}

// ---- entry ---------------------------------------------------------------------------------------------------
export async function decide($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  if (ctx.role.kind === 'desk' && !ctx.agentType) {
    const d = await deskDenial($, ctx, e)
    if (d) return d
  }
  if (ctx.agentType) {
    const d = await workerDenial($, ctx, e)
    if (d) return d
  }
  if (e.tool === 'Bash') return await pushDenial($, String(e.command ?? ''), ctx.cwd)
  return null
}
