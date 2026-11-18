// Guards for `tool.call` (design 2.6): strict mode for the desk, push gate and private projects everywhere,
// read-only and --allow-edit grants for worker subagents. `decide` answers a deny text or null (allow).
// register.tsx wraps it fail-closed: a throwing guard denies.
import { homeDir, leanDir, readJson, realPath, threadsDir, writeJson } from './state'
import { greenReview } from './reviews'
import { analyze } from './shell'
import type { Host } from './state'
import type { Role } from './role'

export type Ctx = { role: Role; cwd: string; agentType?: string; agentId?: string } // agentType/agentId: set inside a subagent loop
export type Call = { tool: string; [k: string]: any }
export type Grants = { edit?: string[]; cmds?: string[] }
type GrantRec = Grants & { call: string; type?: string }
type GrantDoc = { pending: GrantRec[]; agents: Record<string, GrantRec> }

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
// PRIVATE projects (structure in shell.ts): the command is lexed like a shell; quotes, heredocs, here-strings and
// redirections are data. It is denied (no override) only when a gh/az WRITE is positively found at a program position
// (also inside bash -c / eval / $(...) / backticks / subshells / pipes, after env, sudo, command, exec ... prefixes),
// or git push / git remote add|set-url / lean-agent worktree push|pr create|review --post, or a variable / command
// substitution is used as the program name ($GH pr create, $(echo gh) pr create). Read-only gh/az stay allowed:
//   gh: pr view|list|diff|checks|status; issue view|list|status; repo view|list; run view|list; auth status; api without
//       a write method or -f/-F/--field/--raw-field/--input; no subcommand (gh, gh --version).  az: list/show/query/get verbs.
// Unlexable commands are denied only if they also mention a gh/az token or a variable program. This is the fast first
// line; git itself refuses a push through the pre-push hook (githooks.ts) whatever the shell form.
// In non-private projects none of this applies: only the push gate and the protected-branch / --force guard do.
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

// A push that rewrites or deletes a shared branch is refused in every repo, registered or not.
export const PROTECTED = /^(main|master|develop|dev|trunk|prod|production|stable|release([/-].*)?)$/
async function protectedDenial($: Host, c: string, dir: string): Promise<string | null> {
  const w = words(c)
  const at = w.indexOf('push')
  if (at < 0) return null
  const args = w.slice(at + 1)
  const flags = args.filter(a => a.startsWith('-') && a.length > 1)
  const rest = args.filter(a => !a.startsWith('-'))
  const force = flags.some(f => /^--force(-with-lease|-if-includes)?(=.*)?$/.test(f) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)) || rest.slice(1).some(a => a.startsWith('+'))
  const del = flags.some(f => f === '--delete' || f === '-d') || rest.slice(1).some(a => a.startsWith(':'))
  if (flags.includes('--mirror') || (flags.includes('--all') && force)) return 'lean-agent: --mirror / forced --all pushes rewrite shared branches and are refused'
  if (!force && !del) return null
  let targets = rest.slice(1).map(a => a.replace(/^\+/, '').split(':').pop()!.replace(/^refs\/heads\//, '')).filter(Boolean)
  if (!targets.length) {
    const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    targets = [r.exitCode === 0 ? r.stdout.trim() : 'main'] // unknown: assume protected
  }
  const bad = targets.find(t => PROTECTED.test(t) || t === 'HEAD')
  return bad ? `lean-agent: ${force ? 'force-pushing' : 'deleting'} protected branch ${bad} is never allowed` : null
}

async function pushDenial($: Host, c: string, cwd: string): Promise<string | null> {
  const a = analyze(c)
  const pushing = a.push
  if (!a.push && !a.write) return null
  const dirs = dirsOf(c, cwd)
  for (const d of dirs) {
    const p = await projectOf($, d)
    if (p?.private) return `lean-agent: ${p.slug} is a private project: it is never pushed or published (no override)`
  }
  if (!pushing) return null
  const dir = dirs[dirs.length - 1]!
  const prot = await protectedDenial($, c, dir)
  if (prot) return prot
  const p = await projectOf($, dir)
  if (!p) return null // the review gate is for registered projects; other repos push as before
  const r = await $.process.run(['git', '-C', dir, 'rev-parse', 'HEAD'])
  const sha = r.exitCode === 0 ? r.stdout.trim() : ''
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return 'lean-agent push gate: cannot read HEAD here, so no review can unlock the push'
  if (await greenReview($, p.slug, sha)) return null
  return `lean-agent push gate: no green review for ${sha.slice(0, 8)} (project ${p.slug}); run the review skill first (an override needs the user's approval)`
}

// ---- strict mode (desk): an allow-list, every other tool is denied ----------------------------------------------
const DESK_READ = new Set(['Read', 'Grep', 'Glob'])
const DESK_FREE = new Set(['Skill', 'ToolSearch', 'TodoWrite', 'AskUserQuestion'])

function deskBashOk(c: string): boolean {
  if (hasMeta(c)) return false
  const w = words(c.trim())
  if (w[0] === 'claude') return w[1] === '--bg' || w[1] === 'agents'
  if (w[0] === 'gh') return w[1] === 'pr' && (w[2] === 'view' || w[2] === 'list')
  if (w[0] === 'git' && w[1] === '-C' && w.length >= 4) return (w[3] === 'log' || w[3] === 'status') && !w.some(x => x.startsWith('--output'))
  return false
}

async function deskDenial($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  if (DESK_READ.has(e.tool)) {
    const raw: string = e.file_path ?? e.path ?? ''
    if (!raw) return `${ROUTE}: ${e.tool} only under ${leanDir(await homeDir($))}`
    const p = await resolve($, raw, ctx.cwd)
    return within(p, await realPath($, leanDir(await homeDir($)))) || within(p, leanDir(await homeDir($))) ? null : `${ROUTE}: ${e.tool} only under ${leanDir(await homeDir($))}`
  }
  if (e.tool === 'Bash') return deskBashOk(String(e.command ?? '')) ? null : ROUTE
  if (DESK_FREE.has(e.tool) || e.tool.startsWith('mcp__lean-agent__')) return null
  return `${ROUTE}: ${e.tool} is not for the desk`
}

// ---- workers -------------------------------------------------------------------------------------------------
export const isWorker = (t?: string) => !!t && /^worker-/.test(t)
// every subagent that is not a known worker (readers, the reviewer, explorer, general-purpose, an unknown type) is read-only
export const isReader = (t?: string) => !!t && !isWorker(t)

export async function grantsFile($: Host, role: Role): Promise<string> {
  const home = await homeDir($)
  return role.kind === 'thread' ? `${threadsDir(home)}/${role.id}/grants.json` : `${leanDir(home)}/grants.json`
}

// Grants are written by the mod when the thread calls the Agent tool (register.tsx): `allow-edit: /abs, /abs` and
// `allow-cmd: cmd` lines in the prompt. The subagent id is not known yet, so the grant waits as pending and is bound
// to the first subagent of that type that acts; it is removed when the Agent call returns.
export function parseGrants(prompt: unknown): Grants {
  const t = typeof prompt === 'string' ? prompt : ''
  const list = (key: string) => [...t.matchAll(new RegExp(`^\\s*-{0,2}${key}\\s*[:=]\\s*(.+)$`, 'gim'))].flatMap(m => m[1]!.split(',')).map(x => x.trim().replace(/^["'`]|["'`]$/g, '')).filter(Boolean)
  return { edit: list('allow-edit').filter(x => x.startsWith('/')), cmds: list('allow-cmd') }
}

let chain: Promise<unknown> = Promise.resolve()
function locked<T>(f: () => Promise<T>): Promise<T> {
  const r = chain.then(f, f)
  chain = r.catch(() => undefined)
  return r
}
async function readDoc($: Host, file: string): Promise<GrantDoc> {
  const d = await readJson<Partial<GrantDoc>>($, file, {})
  return { pending: Array.isArray(d.pending) ? d.pending : [], agents: d.agents && typeof d.agents === 'object' && !Array.isArray(d.agents) ? d.agents : {} }
}

export function recordGrant($: Host, role: Role, call: string, type: string | undefined, g: Grants): Promise<void> {
  return locked(async () => {
    const file = await grantsFile($, role)
    const d = await readDoc($, file)
    d.pending.push({ call, type, edit: g.edit ?? [], cmds: g.cmds ?? [] })
    await writeJson($, file, d)
  })
}

export function releaseGrant($: Host, role: Role, call: string): Promise<void> {
  return locked(async () => {
    const file = await grantsFile($, role)
    const d = await readDoc($, file)
    d.pending = d.pending.filter(g => g.call !== call)
    for (const [id, g] of Object.entries(d.agents)) if (g.call === call) delete d.agents[id]
    await writeJson($, file, d)
  })
}

async function grantFor($: Host, ctx: Ctx): Promise<Grants> {
  if (!ctx.agentId) return {}
  return locked(async () => {
    const file = await grantsFile($, ctx.role)
    const d = await readDoc($, file)
    const bound = d.agents[ctx.agentId!]
    if (bound) return bound
    const i = d.pending.findIndex(g => !g.type || g.type === ctx.agentType)
    if (i < 0) return {}
    const [g] = d.pending.splice(i, 1)
    d.agents[ctx.agentId!] = g!
    await writeJson($, file, d)
    return g!
  })
}

async function workerDenial($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  const t = ctx.agentType
  const edits = e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit'
  if (e.tool === 'AskUserQuestion') return 'lean-agent: a subagent never asks the user; report the question to the thread'
  if (isReader(t)) {
    if (edits) return `lean-agent: ${t} is read-only`
    if (e.tool === 'Bash' && t === 'explorer') {
      const c = String(e.command ?? '').trim()
      return !hasMeta(c) && /^git (log|ls-files)( |$)/.test(c) ? null : 'lean-agent: explorer may run only git log and git ls-files'
    }
    if (e.tool === 'Bash') {
      const g = await grantFor($, ctx)
      const c = String(e.command ?? '').trim()
      const ok = !hasMeta(c) && (g.cmds ?? []).some(x => c === x || c.startsWith(x + ' '))
      return ok ? null : `lean-agent: ${t} may run only the commands the thread granted (allow-cmd)`
    }
    return null
  }
  if (isWorker(t) && edits) {
    const g = await grantFor($, ctx)
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
  if (ctx.role.kind === 'thread' && !ctx.agentType && e.tool === 'AskUserQuestion') return 'lean-agent: a thread never asks the user directly; use lean_ask (the desk relays it)'
  if (ctx.agentType) {
    const d = await workerDenial($, ctx, e)
    if (d) return d
  }
  if (e.tool === 'Bash') return await pushDenial($, String(e.command ?? ''), ctx.cwd)
  return null
}
