// Guards for `tool.call` (design 2.6): strict mode for the desk, push gate and private projects everywhere,
// read-only and --allow-edit grants for worker subagents. `decide` answers a deny text or null (allow).
// register.tsx wraps it fail-closed: a throwing guard denies.
import { homeDir, leanDir, mkdirp, readJson, realPath, threadsDir, writeJson } from './state'
import { greenReview, hasApproval, takeApproval } from './reviews'
import { markerOf } from './reviewkind'
import { reviewGitDenial } from './reviewguard'
import { analyze, isGlobWord, plainPipeline, plainWords, privateText, readOnlyForge, type Verdict } from './shell'
import { auditorPromptProblem, unauditedRun } from './scripts'
import { addRequest, agentModel, claudeModelIn, familyOf, isExpensiveModel, modelAllowed, needsApprovalText } from './expensive'
import { DESK_ROUTE, isSmall, loadOrch, orchDecide, tried } from './orchestrate'
import { forgeRefusal, isForgeWrite } from './forgewrite'
import { forgeReadOk, forgeReadRefusal, forgeTempOk, isForgeFetch } from './forgeread'
import { WHY_SONNET, jobOf } from './jobs'
import { haikuRecord } from './workerruns'
import { selfEditRoots } from './selfedit'
import { mcpDecision, isMcpTool } from './mcpgrant'
import { isOwn, serverOf } from './profile'
import type { Host } from './state'
import type { Role } from './role'
import { modSending } from './modsend'
import { forcedPrDenial, isForce } from './forcepr'
import { agentWindowDenial, threadPriority } from './throttle'
import { budgetFile, budgetRefusal } from './budgetthread'

export type Ctx = { role: Role; cwd: string; agentType?: string; agentId?: string; version?: string; root?: string } // agentType/agentId: set inside a subagent loop; root: the plugin's folder (agents/*.md)
export type Call = { tool: string; [k: string]: any }
export type Grants = { edit?: string[]; cmds?: string[]; mcp?: string[]; mcpWrite?: string[]; job?: string; chars?: number }
type GrantRec = Grants & { call: string; type?: string; at?: number; sid?: string }
type GrantDoc = { pending: GrantRec[]; agents: Record<string, GrantRec>; ended?: Record<string, GrantRec> } // ended: a subagent that stopped; a resumed one (same id) takes its grant back
export const GRANT_TTL_MIN = 120
export type GrantOpts = { sid?: string; ttlMin?: number }

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

// Both sides of a grant check go through this: the real path of the deepest EXISTING parent (symlinks, /private/tmp on macOS, a file that
// does not exist yet under a granted directory), `..` / `.` / doubled and trailing slashes removed, `~` expanded. Never the raw spelling.
export async function deepReal($: Host, raw: string, cwd: string): Promise<string> {
  const home = await homeDir($)
  const t = raw === '~' ? home : raw.startsWith('~/') ? `${home}/${raw.slice(2)}` : raw
  const abs = t.startsWith('/') ? norm(t) : norm(`${cwd}/${t}`)
  const rest: string[] = []
  let cur = abs
  for (let i = 0; i < 128; i++) {
    try {
      const s = await $.fs.stat(cur, { resolve: true })
      return norm([s.realPath ?? cur, ...rest].join('/'))
    } catch {
      if (cur === '/') break
      rest.unshift(cur.slice(cur.lastIndexOf('/') + 1))
      cur = cur.slice(0, cur.lastIndexOf('/')) || '/'
    }
  }
  return abs
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
// line; the pre-push hook (githooks.ts) is only a backstop (--no-verify and config overrides skip it, so those are refused here).
// ssh / flock / parallel and similar wrappers are parsed; not parsed (residual risk): python -c and other interpreters' strings, eval with variables; a whole-text check still catches `git push` and `gh ... create|comment|merge`.
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

// ---- guarded branches (0.45 push_guard.py): a plain push to a guarded branch is refused, registered project or not ----
export const DEFAULT_PUSH_DENY = ['release/*', 'develop', 'main', 'master']
const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
export const guardedBy = (branch: string, pats: string[]) => pats.find(p => globRe(p).test(branch.replace(/^refs\/heads\//, ''))) ?? null

// a project's own `guards.push-deny` list (even an empty one), else the defaults; a lean-agent worktree counts as its project
export async function patternsFor($: Host, dir: string): Promise<string[]> {
  const home = await homeDir($)
  const projs = await readJson<Record<string, any>>($, `${leanDir(home)}/projects.json`, {})
  const real = await realPath($, dir)
  const lean = await realPath($, leanDir(home))
  for (const [k, v] of Object.entries(projs ?? {})) {
    if (!v || typeof v !== 'object') continue
    const p = v.path ? await realPath($, norm(v.path)) : ''
    const wt = `${lean}/worktrees/${k}`
    if ((p && within(real, p)) || within(real, wt)) {
      const pd = v.guards?.['push-deny']
      return Array.isArray(pd) ? pd.filter((x: unknown) => typeof x === 'string') : DEFAULT_PUSH_DENY
    }
  }
  return DEFAULT_PUSH_DENY
}

const isLocalDest = (d: string) => !!d && (d.startsWith('file://') || (!d.includes('://') && !/^([^/@]+@)?[^/:]+:/.test(d)))
async function git1($: Host, dir: string, ...a: string[]): Promise<string | null> {
  const r = await $.process.run(['git', '-C', dir, ...a])
  return r.exitCode === 0 ? r.stdout.trim() : null
}
// the push words after `push`: flags dropped (with the values of -o/--repo/...), then [remote, ...refspecs]
function pushArgs(args: string[]): { flags: string[]; rest: string[] } {
  const flags: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!
    if (['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(x)) i++
    else if (x.startsWith('--repo=')) rest.unshift(x.slice(7))
    else if (x.startsWith('-')) flags.push(x)
    else rest.push(x)
  }
  return { flags, rest }
}
// remote branches the push would update (null: all of them)
export async function pushDestinations($: Host, args: string[], dir: string): Promise<string[] | null> {
  const { flags, rest } = pushArgs(args)
  if (flags.some(f => ['--all', '--mirror', '--branches'].includes(f))) return null
  const specs = rest.slice(1)
  const cur = async () => (await git1($, dir, 'symbolic-ref', '--quiet', '--short', 'HEAD')) ?? ''
  if (!specs.length) {
    if (flags.includes('--tags')) return []
    const up = await git1($, dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
    if (up && up.includes('/') && !/^[0-9a-f]{40,64}$/.test(up)) return [up.split('/').slice(1).join('/')]
    const b = await cur()
    return b ? [b] : []
  }
  const out: string[] = []
  for (const raw of specs) {
    const spec = raw.replace(/^\+/, '')
    if (spec.startsWith('refs/tags/')) continue
    let dst = spec.includes(':') ? spec.split(':').slice(1).join(':') : spec
    if (dst === 'HEAD' || dst === '@') dst = (await cur()) || 'HEAD'
    if (dst) out.push(dst.replace(/^refs\/heads\//, ''))
  }
  return out
}

async function pushIsLocal($: Host, args: string[], dir: string): Promise<boolean> {
  if ((await $.env.get('LEAN_AGENT_PUSH_GUARD_LOCAL')) === '1') return false
  const { rest } = pushArgs(args)
  let remote = rest[0]
  if (!remote) {
    const b = await git1($, dir, 'symbolic-ref', '--quiet', '--short', 'HEAD')
    remote = (b && ((await git1($, dir, 'config', `branch.${b}.pushRemote`)) || (await git1($, dir, 'config', `branch.${b}.remote`)))) || 'origin'
  }
  const url = await git1($, dir, 'remote', 'get-url', '--push', remote)
  return isLocalDest(url && !/^[0-9a-f]{40,64}$/.test(url) ? url : remote)
}

// the refusal text, or null: `git push` words (the whole command) run in dir
async function guardedDenial($: Host, a: Verdict, dir: string): Promise<string | null> {
  if ((await $.env.get('LEAN_AGENT_PUSH_GUARD_OVERRIDE')) === '1') return null
  const pats = await patternsFor($, dir)
  if (!pats.length) return null
  for (const { args, known } of a.pushes) {
    if (!known) return UNREADABLE
    if (await pushIsLocal($, args, dir)) continue
    const dests = await pushDestinations($, args, dir)
    if (dests === null) return `lean-agent: \`git push --all/--mirror\` would update every branch, including guarded ones (${pats.join(', ')}). Push only your own branch.`
    for (const d of dests) {
      const hit = guardedBy(d, pats)
      if (hit) return `lean-agent: \`git push\` would update ${d}, which lean-agent never pushes to (guard '${hit}'). Push your own branch and open a pull request.`
    }
  }
  return null
}

export const UNREADABLE = 'lean-agent: could not read this git push safely; write it as a plain `git push <remote> <branch>`'
// A push that rewrites or deletes a shared branch is refused in every repo, registered or not.
export const PROTECTED = /^(main|master|develop|dev|trunk|prod|production|stable|release([/-].*)?)$/
async function protectedDenial($: Host, a: Verdict, dir: string): Promise<string | null> {
  for (const { args, known } of a.pushes) {
    if (!known) return UNREADABLE
    const r = await protectedOne($, args, dir)
    if (r) return r
  }
  return null
}
async function protectedOne($: Host, args: string[], dir: string): Promise<string | null> {
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

async function pushDenial($: Host, c: string, cwd: string, role?: Role): Promise<string | null> {
  const a = analyze(c)
  const pushing = a.push
  const text = privateText(c)
  if (!a.push && !a.write && !text) return null
  const dirs = dirsOf(c, cwd)
  for (const d of dirs) {
    const p = await projectOf($, d)
    if (p?.private) return `lean-agent: ${p.slug} is a private project: it is never pushed or published (no override)`
  }
  if (!pushing) return null
  const dir = dirs[dirs.length - 1]!
  if (a.pushes.some(x => !x.known)) return UNREADABLE
  const prot = await protectedDenial($, a, dir)
  if (prot) return prot
  // 1.0.31: a forced push to a branch whose open PR has comments orphans the review (forcepr.ts: asked read-only, a failed lookup lets the push go on)
  for (const { args } of a.pushes) {
    if (!isForce(args)) continue
    const dests = await pushDestinations($, args, dir)
    const fp = dests?.length ? await forcedPrDenial($, dests.filter(b => b !== 'HEAD'), dir) : null
    if (fp) return fp
  }
  const gd = await guardedDenial($, a, dir)
  if (gd) return gd
  const p = await projectOf($, dir)
  if (!p) return null // the review gate is for registered projects; other repos push as before
  // the review is for the commit each pushed ref points at (the refspec's source), HEAD when the push names none
  const segs = a.pushes.filter(x => x.known).map(x => x.args)
  const refs: string[] = []
  for (const args of segs.length ? segs : [[]]) {
    const { flags, rest } = pushArgs(args)
    const srcs = flags.some(f => ['--all', '--mirror', '--branches'].includes(f)) ? [] : rest.slice(1).map(x => x.replace(/^\+/, '')).filter(x => !x.startsWith(':') && !x.startsWith('refs/tags/')).map(x => (x.includes(':') ? x.split(':')[0]! : x))
    refs.push(...(srcs.length ? srcs : ['HEAD']))
  }
  const shas: string[] = []
  for (const ref of refs) {
    const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--verify', '--end-of-options', `${ref === '@' ? 'HEAD' : ref}^{commit}`])
    const sha = r.exitCode === 0 ? r.stdout.trim() : ''
    if (!/^[0-9a-f]{7,64}$/.test(sha)) return `lean-agent push gate: cannot resolve ${ref} here, so no review can unlock the push`
    shas.push(sha)
  }
  // every distinct sha needs a green review or an approval; approvals are consumed only when ALL are covered
  const thread = role?.kind === 'thread' ? role.id : ''
  const need: string[] = []
  for (const sha of [...new Set(shas)]) {
    if (await greenReview($, p.slug, sha)) continue
    if (await hasApproval($, p.slug, sha, thread)) { need.push(sha); continue }
    const first = pushArgs(segs[0] ?? []).rest
    const manual = `git -C ${dir} push ${first[0] ?? '<remote>'} ${first[1] ?? '<branch>'}`
    if (role?.kind === 'thread') return `lean-agent push gate: a thread does not push (its own permission check refuses it, and the user's yes goes to the desk). ${sha.slice(0, 8)} has no green review in project ${p.slug}: run the review skill, then lean_report "ready to push ${sha} (<branch>, <PR title>)" and stop; the desk asks the user and pushes. Or the user can push by hand: ${manual}`
    const who = `the desk's lean_thread approve-push <tN> ${sha}, then push`
    return `lean-agent push gate: no green review for ${sha.slice(0, 8)} (project ${p.slug}). Run the review skill first, or have the user approve this exact commit (${who}); or the user can push by hand: ${manual}`
  }
  for (const sha of need) if (!(await takeApproval($, p.slug, sha, thread))) return `lean-agent push gate: the approval for ${sha.slice(0, 8)} was just used by another push; ask the desk to approve again`
  return null
}

// ---- strict mode (desk): an allow-list, every other tool is denied ----------------------------------------------
// ONE list of what the desk may call: deskDenial decides by it, and the desk's tool pool (tool.list) is cut to it
const DESK_READ = new Set(['Read', 'Grep', 'Glob']) // only under ~/.lean-agent
const DESK_BASH = 'Bash' // only the commands deskBashOk lists
const DESK_FREE = new Set(['Skill', 'ToolSearch', 'TodoWrite', 'AskUserQuestion'])
const LEAN_TOOLS = 'mcp__lean-agent__'
export const DESK_TOOLS: readonly string[] = [...DESK_READ, DESK_BASH, ...DESK_FREE]
// Tools the desk's MOD calls, never the model: the engine's `$.session.send` runs only when the session's tool pool has SendMessage ("this session has no
// SendMessage tool", seen live), so the pool and the settings keep it (it is a deferred tool: a name in the listing) and deskDenial lets only the mod's own send use it
export const DESK_MOD_TOOLS: readonly string[] = ['SendMessage']
// can strict mode ever allow this tool (by name)? lean-agent's own tools always
export const deskToolPossible = (name: string): boolean => DESK_TOOLS.includes(name) || DESK_MOD_TOOLS.includes(name) || name.startsWith(LEAN_TOOLS)

export function deskBashOk(c: string): boolean {
  if (hasMeta(c)) return false
  const w = words(c.trim())
  if (w[0] === 'claude') return w[1] === '--bg' || w[1] === 'agents'
  if (w[0] === 'gh' || w[0] === 'az') {
    const p = plainWords(c.trim()) // quotes resolved, no expansion or second command; the read-only test is the private guard's own
    return !!p && readOnlyForge(p)
  }
  if (w[0] === 'git' && w[1] === '-C' && w.length === 6 && w[3] === 'remote' && w[4] === 'get-url') return !w[5]!.startsWith('-') // where a project's origin is (the pr skill picks gh or az by it)
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
  if (e.tool === DESK_BASH) {
    const c = String(e.command ?? '')
    if (deskBashOk(c)) return null
    // read-only search under ~/.lean-agent (this build has no Grep / Glob): rg, grep, find, ls, wc, head, tail, cat
    const segs = plainPipeline(c)
    const lean = leanDir(await homeDir($))
    const roots = [norm(lean), norm(await realPath($, lean))]
    if (segs && (await Promise.all(segs.map((w, i) => searchOk($, ctx, w, roots, i === 0)))).every(Boolean)) return null
    return ROUTE
  }
  if (DESK_FREE.has(e.tool) || e.tool.startsWith(LEAN_TOOLS)) return null
  if (DESK_MOD_TOOLS.includes(e.tool)) return modSending(e) ? null : `${ROUTE}: the desk does not message sessions itself; \`lean_thread send\` delivers a message to a thread (the mod sends it straight to the session)`
  return `${ROUTE}: ${e.tool} is not for the desk`
}

// ---- workers -------------------------------------------------------------------------------------------------
// The plugin's subagents carry the plugin prefix in the Agent tool (`lean-agent:worker-sonnet`). Only a type with exactly that
// leading prefix is ours: a bare `worker-x` can only come from a user or project agent, and `other:worker-x` from another plugin.
export const OWN_PREFIX = 'lean-agent:'
export const ownName = (t?: string): string | null => (t && t.startsWith(OWN_PREFIX) ? t.slice(OWN_PREFIX.length) : null)
export const isWorker = (t?: string) => /^worker-/.test(ownName(t) ?? '')
// every subagent that is not one of our workers (our readers, the reviewer, explorer, general-purpose, foreign or unknown types) is read-only
export const isReader = (t?: string) => !!t && !isWorker(t)
// the same agent under either spelling (a grant may name it bare or with the prefix)
export const sameAgent = (a?: string, b?: string) => !!a && !!b && (a === b || a.replace(/^lean-agent:/, '') === b.replace(/^lean-agent:/, ''))

export async function grantsFile($: Host, role: Role): Promise<string> {
  const home = await homeDir($)
  return role.kind === 'thread' ? `${threadsDir(home)}/${role.id}/grants.json` : `${leanDir(home)}/grants.json`
}

// Grants are written by the mod when the thread calls the Agent tool (register.tsx): `allow-edit: /abs, /abs` and
// `allow-cmd: cmd` lines in the prompt. The subagent id is not known yet, so the grant waits as pending and is bound
// to the first subagent of that type that acts (or to its id when an async launch names it); it is released when the subagent ends.
export function parseGrants(prompt: unknown): Grants {
  const t = typeof prompt === 'string' ? prompt : ''
  const list = (key: string) => [...t.matchAll(new RegExp(`^\\s*-{0,2}${key}\\s*[:=]\\s*(.+)$`, 'gim'))].flatMap(m => m[1]!.split(',')).map(x => x.trim().replace(/^["'`]|["'`]$/g, '')).filter(Boolean)
  return { edit: list('allow-edit').filter(x => x.startsWith('/') || x === '~' || x.startsWith('~/')), cmds: list('allow-cmd'), mcp: list('allow-mcp'), mcpWrite: list('allow-mcp-write'), ...(jobOf(t) ? { job: jobOf(t)! } : {}) }
}
// does the brief carry anything the guard must remember for the subagent it starts (a grant or a job type)?
// (allow-edit / allow-cmd lines are accepted and ignored: workers and readers need no grant for them)
// the absolute paths a brief names (its `allow-edit:` lines and any absolute path in the text, at least two levels deep): what the thread may
// do itself when the permission check denied that worker call (orchestrate.ts delegation-denied)
export function pathsOf(prompt: unknown): string[] {
  const t = typeof prompt === 'string' ? prompt : ''
  const found = [...(parseGrants(t).edit ?? []), ...[...t.matchAll(/(?:^|[\s`'"(=:,])((?:~|\/)[\w.@+\-/]*[\w@+\-/])/g)].map(m => m[1]!)]
  return [...new Set(found.filter(p => (p.startsWith('~/') || p.startsWith('/')) && p.split('/').filter(Boolean).length >= 2))].slice(0, 12)
}
export const hasGrants = (g: Grants): boolean => !!(g.mcp?.length || g.mcpWrite?.length || g.job)

let chain: Promise<unknown> = Promise.resolve()
function locked<T>(f: () => Promise<T>): Promise<T> {
  const r = chain.then(f, f)
  chain = r.catch(() => undefined)
  return r
}
async function readDoc($: Host, file: string): Promise<GrantDoc> {
  const d = await readJson<Partial<GrantDoc>>($, file, {})
  const rec = (v: unknown): Record<string, GrantRec> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, GrantRec>) : {})
  return { pending: Array.isArray(d.pending) ? d.pending : [], agents: rec(d.agents), ended: rec(d.ended) }
}
// stale entries go on every write and at session start: older than the TTL (a subagent that never reported), or written by another session
function prune(d: GrantDoc, now: number, o: GrantOpts): void {
  const max = (o.ttlMin && o.ttlMin > 0 ? o.ttlMin : GRANT_TTL_MIN) * 60_000
  const stale = (g: GrantRec) => typeof g?.at !== 'number' || now - g.at > max || (!!o.sid && !!g.sid && g.sid !== o.sid)
  d.pending = d.pending.filter(g => !stale(g))
  for (const m of [d.agents, d.ended!]) for (const [id, g] of Object.entries(m)) if (stale(g)) delete m[id]
}
// one locked read-modify-write of the grants file
function mutate($: Host, role: Role, o: GrantOpts, f: (d: GrantDoc, now: number) => void): Promise<void> {
  return locked(async () => {
    const file = await grantsFile($, role)
    const d = await readDoc($, file)
    const now = await $.clock.now()
    prune(d, now, o)
    f(d, now)
    await writeJson($, file, { pending: d.pending, agents: d.agents, ended: d.ended })
  })
}
export const sweepGrants = ($: Host, role: Role, o: GrantOpts = {}): Promise<void> => mutate($, role, o, () => undefined)

export function recordGrant($: Host, role: Role, call: string, type: string | undefined, g: Grants, o: GrantOpts = {}): Promise<void> {
  return mutate($, role, o, (d, now) => {
    d.pending.push({ call, type, at: now, ...(o.sid ? { sid: o.sid } : {}), edit: [], cmds: [], mcp: g.mcp ?? [], mcpWrite: g.mcpWrite ?? [], ...(g.job ? { job: g.job } : {}), ...(g.chars ? { chars: g.chars } : {}) })
  })
}

// The Agent call returned. A foreground call is the subagent's whole life: the unbound grant goes, the bound one is released (kept only as
// `ended`, for a resume). An async launch ("Async agent launched", `agentId` in the result) only starts it: the pending grant is bound to that id
// now (or stays pending, bound by type as before, when the result names no id) and lives until the subagent ends (releaseAgent).
export function releaseGrant($: Host, role: Role, call: string, o: GrantOpts & { async?: boolean; agentId?: string } = {}): Promise<void> {
  return mutate($, role, o, d => {
    if (o.async) {
      const i = o.agentId ? d.pending.findIndex(g => g.call === call) : -1
      if (i >= 0 && !d.agents[o.agentId!] && !d.ended![o.agentId!]) d.agents[o.agentId!] = d.pending.splice(i, 1)[0]!
      return
    }
    d.pending = d.pending.filter(g => g.call !== call)
    for (const [id, g] of Object.entries(d.agents)) if (g.call === call) { d.ended![id] = g; delete d.agents[id] }
  })
}
// the subagent ended (classic.SubagentStop): its bound grant is released
export const releaseAgent = ($: Host, role: Role, agentId: string, o: GrantOpts = {}): Promise<void> =>
  mutate($, role, o, d => {
    const g = d.agents[agentId]
    if (g) { d.ended![agentId] = g; delete d.agents[agentId] }
  })

// the job type of the brief a worker was started with (the refusal and missing-tool records name it)
export const workerJob = async ($: Host, ctx: Ctx): Promise<string | undefined> => (await grantFor($, ctx).catch(() => ({}) as Grants)).job
// the job type and the size (characters) of the brief: the step-budget refusal record carries both, so an export can tell a job that is too big for its budget from a brief that is too big
export const workerBrief = async ($: Host, ctx: Ctx): Promise<{ job?: string; chars?: number }> => {
  const g = await grantFor($, ctx).catch(() => ({}) as Grants)
  return { ...(g.job ? { job: g.job } : {}), ...(g.chars ? { chars: g.chars } : {}) }
}
async function grantFor($: Host, ctx: Ctx): Promise<Grants> {
  if (!ctx.agentId) return {}
  return locked(async () => {
    const file = await grantsFile($, ctx.role)
    const d = await readDoc($, file)
    const bound = d.agents[ctx.agentId!]
    if (bound) return bound
    const back = d.ended?.[ctx.agentId!] // a resumed / continued worker keeps its grant
    if (back) {
      d.agents[ctx.agentId!] = back
      delete d.ended![ctx.agentId!]
      await writeJson($, file, { pending: d.pending, agents: d.agents, ended: d.ended })
      return back
    }
    const i = d.pending.findIndex(g => !g.type || sameAgent(g.type, ctx.agentType))
    if (i < 0) return {}
    const [g] = d.pending.splice(i, 1)
    d.agents[ctx.agentId!] = g!
    await writeJson($, file, { pending: d.pending, agents: d.agents, ended: d.ended })
    return g!
  })
}

// Built-in read-only commands, so a reader never depends on a brief: only OUR agent types (exact `lean-agent:` prefix) get them;
// other:explorer, a bare explorer and every other type get nothing (an allow-cmd grant adds on top). One plain `git` command
// (shell.ts plainPipeline: no redirect, substitution, expansion, glob, brace or tilde outside quotes), the only global options are
// --no-pager and one absolute -C <dir inside those roots>,
// and no option that writes a file, runs a program or reads outside the repository. Accepted residual risk: the repository's own
// config can run programs for status (core.fsmonitor) and diff/show/log -p (diff.external, textconv drivers), git status refreshes
// .git/index, and `git diff A B` with paths outside the work tree reads them; -c / --ext-diff / -C escapes are what is refused.
const GIT_EXPLORER = ['log', 'ls-files']
const GIT_READER = ['log', 'ls-files', 'show', 'diff', 'status', 'rev-parse', 'merge-base'] // (merge-base: the review's `git -C <worktree> merge-base <base> <sha>`; it only reads)
export const builtinGit = (t?: string): string[] => {
  const n = ownName(t) ?? ''
  return n === 'explorer' ? GIT_EXPLORER : /^reader-/.test(n) || n === 'reviewer' || n === 'auditor' ? GIT_READER : []
}
// long options git accepts by any unambiguous prefix: --out, --output=f, --ext, --ext-diff, --exec, --exec-path ...
const BAD_LONG = (o: string, sub: string) =>
  /^(config|work-tree|no-index|upload-pack|receive-pack|paginate|help|textconv-)/.test(o) || (sub !== 'rev-parse' && /^git-dir/.test(o)) || (/^output/.test(o) && !/^output-indicator-/.test(o)) ||
  (o.length > 0 && ('output'.startsWith(o) || 'ext-diff'.startsWith(o) || 'exec-path'.startsWith(o) || 'help'.startsWith(o) || 'no-index'.startsWith(o))) || /^exec/.test(o) || /^ext-d/.test(o)
// -o <file> (git has no -o for log/diff/show, the spec refuses it anyway) and -h (help starts a pager)
const SHORT_O = (a: string) => a.startsWith('-o') || a === '-h'
// where `git -C <dir>` and the search commands may reach: ~/.lean-agent (thread folders, worktrees) and the registered projects' folders
async function cRoots($: Host, ctx: Ctx): Promise<string[]> {
  const home = await homeDir($)
  const projs = await readJson<Record<string, { path?: unknown }>>($, `${leanDir(home)}/projects.json`, {})
  const raw = [leanDir(home), // the session cwd is NOT a root by itself: a reader started in $HOME or /tmp reads nothing there
     ...Object.values(projs && typeof projs === 'object' ? projs : {}).map(x => x?.path).filter((x): x is string => typeof x === 'string' && x.startsWith('/'))]
  const out: string[] = []
  for (const r of raw) out.push(norm(r), norm(await realPath($, r)))
  return out
}
// ---- read-only search commands (this Claude Code build has no Grep / Glob: a reader can only search through Bash) ----------------
// rg, grep, find, ls, wc, head, tail, cat on paths inside the same roots as `git -C`; pipes only between commands the scanner
// (shell.ts plainPipeline) proves plain and that are each allowed here. Relative words resolve against the session cwd, which must
// itself be inside the roots when a command names no path.
const SEARCH_CMDS = new Set(['rg', 'grep', 'find', 'ls', 'wc', 'head', 'tail', 'cat'])
// more plain read-only file commands, only for the readers and the reviewer (not the explorer, the auditor or the desk):
// sed -n, stat, file, diff, jq, tree. Same rules: listed flags only, paths inside the roots, no redirect.
// and the text filters of a pipeline (sort without -o, uniq with at most one operand, cut, tr, nl; xargs, awk and the rest stay refused)
const MORE_CMDS = new Set(['sed', 'stat', 'file', 'diff', 'jq', 'tree', 'sort', 'uniq', 'cut', 'tr', 'nl'])
// the commands whose plain file operands may be an unquoted glob (readers and the reviewer; the words are expanded and checked by globOk)
// (never uniq: its second operand is the OUTPUT file, and a glob can expand to two names)
const GLOB_CMDS = new Set(['rg', 'grep', 'ls', 'wc', 'head', 'tail', 'cat', 'sort', 'cut', 'nl'])
export const builtinMore = (t?: string): boolean => {
  const n = ownName(t) ?? ''
  return /^reader-/.test(n) || n === 'reviewer' || n === 'auditor'
}
// Every flag a built-in search command may carry is listed here; ANY other flag (or abbreviation, or cluster letter) refuses the
// command, so no option can shift which word is a pattern, read a file, run a program, write, or follow a symlink out of the roots.
// no: letters without a value; val: letters whose value is attached or the next word; lnone / lval: long names without / with a value
// (`--name=v` or `--name v`); digits: `-5` / `-A5` style counts.
type Spec = { no: string; val: string; lnone: string[]; lval: string[]; digits?: boolean }
const SPECS: Record<string, Spec> = {
  rg: { no: 'nNiSslcvwxFoqIuUHha', val: 'ABCmgtTMde', digits: true,
    lnone: ['hidden', 'files', 'no-ignore', 'no-ignore-vcs', 'no-ignore-parent', 'no-ignore-dot', 'ignore-case', 'case-sensitive', 'smart-case', 'line-number', 'no-line-number', 'count', 'files-with-matches', 'files-without-match', 'fixed-strings', 'word-regexp', 'line-regexp', 'invert-match', 'only-matching', 'heading', 'no-heading', 'column', 'with-filename', 'no-filename', 'no-messages', 'sort-files', 'trim', 'type-list', 'stats', 'text', 'multiline', 'unrestricted', 'vimgrep', 'no-config', 'crlf'],
    lval: ['max-count', 'glob', 'iglob', 'type', 'type-not', 'context', 'after-context', 'before-context', 'regexp', 'max-depth'] },
  grep: { no: 'rnilLcvwxFEGoqsHhIaTbU', val: 'ABCme', digits: true,
    lnone: ['ignore-case', 'no-ignore-case', 'line-number', 'recursive', 'count', 'files-with-matches', 'files-without-match', 'no-filename', 'with-filename', 'invert-match', 'word-regexp', 'fixed-strings', 'extended-regexp', 'perl-regexp', 'basic-regexp', 'only-matching', 'quiet', 'silent', 'no-messages', 'null', 'color', 'colour', 'text', 'line-buffered', 'initial-tab', 'byte-offset'],
    lval: ['include', 'exclude', 'exclude-dir', 'max-count', 'context', 'after-context', 'before-context', 'regexp'] },
  ls: { no: 'laAhrRtSsd1FpiknGCxXuUcvmq', val: '', lnone: ['all', 'almost-all', 'human-readable', 'recursive', 'reverse', 'directory', 'classify', 'color'], lval: [] },
  cat: { no: 'nbsAETv', val: '', lnone: ['number', 'number-nonblank', 'squeeze-blank', 'show-all', 'show-ends', 'show-tabs'], lval: [] },
  head: { no: 'qv', val: 'nc', digits: true, lnone: ['quiet', 'silent', 'verbose'], lval: ['lines', 'bytes'] },
  tail: { no: 'qv', val: 'nc', digits: true, lnone: ['quiet', 'silent', 'verbose'], lval: ['lines', 'bytes'] }, // no -f / -F / --follow / --retry
  wc: { no: 'lwcmL', val: '', lnone: ['lines', 'words', 'bytes', 'chars', 'max-line-length'], lval: [] },
  // no -L / --dereference (follows a link out of the roots), no -f of file / -z / -X / -r of diff / -o / -l / --fromfile of tree
  stat: { no: 'tx', val: 'c', lnone: ['terse'], lval: ['format', 'printf'] }, // (no -f: GNU takes no value, so a path after it would skip the check)
  file: { no: 'bIi', val: '', lnone: ['brief', 'mime', 'mime-type', 'mime-encoding'], lval: [] },
  diff: { no: 'uqsbBwiyEZaNpTtc', val: 'UC', digits: true, lnone: ['unified', 'context', 'brief', 'report-identical-files', 'ignore-all-space', 'ignore-space-change', 'ignore-blank-lines', 'ignore-case', 'ignore-trailing-space', 'new-file', 'text', 'side-by-side', 'expand-tabs', 'initial-tab', 'minimal', 'show-c-function'], lval: ['unified', 'context'] },
  tree: { no: 'adfiFqhpusgDtrCNJx', val: 'LIP', lnone: ['noreport', 'dirsfirst', 'prune', 'du', 'si', 'inodes', 'device'], lval: ['filelimit'] },
  // sort: no -o / --output (writes a file), -T / --compress-program / --random-source / --files0-from (name a file or run a program)
  sort: { no: 'bdfghiMnruVcCmsz', val: 'kt', lnone: ['reverse', 'numeric-sort', 'unique', 'ignore-case', 'ignore-leading-blanks', 'dictionary-order', 'ignore-nonprinting', 'general-numeric-sort', 'human-numeric-sort', 'month-sort', 'version-sort', 'stable', 'check', 'merge', 'zero-terminated'], lval: ['key', 'field-separator'] },
  uniq: { no: 'cdDiuz', val: 'fsw', digits: true, lnone: ['count', 'repeated', 'ignore-case', 'unique', 'zero-terminated'], lval: ['skip-fields', 'skip-chars', 'check-chars'] }, // (a second operand of uniq is the OUTPUT file: at most one is allowed, below)
  cut: { no: 'snz', val: 'bcfd', lnone: ['only-delimited', 'complement', 'zero-terminated'], lval: ['bytes', 'characters', 'fields', 'delimiter', 'output-delimiter'] },
  tr: { no: 'cCdst', val: '', lnone: ['complement', 'delete', 'squeeze-repeats', 'truncate-set1'], lval: [] }, // its operands are character sets, not files
  nl: { no: 'p', val: 'bhfdilnsvw', lnone: ['no-renumber'], lval: ['body-numbering', 'header-numbering', 'footer-numbering', 'number-format', 'number-width', 'number-separator', 'starting-line-number', 'line-increment', 'join-blank-lines', 'section-delimiter'] },
}
// ---- sed -n: a script of print / delete / quit / hold-space commands and s / y, nothing that writes, reads or runs ----------------
// Refused: w W e r R a i c b t T : v F z, the s flags w and e, a custom regex delimiter (\cREc), a raw newline inside a part. A
// bracket expression that holds the delimiter is refused too: GNU sed and BSD sed (macOS) split `s/[/]/x/` differently, so a script
// both would read the same way is the only one accepted.
function sedScriptOk(s: string): boolean {
  const n = s.length
  let i = 0
  const ws = () => { while (i < n && (s[i] === ' ' || s[i] === '\t')) i++ }
  const part = (d: string): boolean => {
    for (; i < n; i++) {
      const c = s[i]!
      if (c === '\n') return false
      if (c === '\\') { i++; if (i >= n || s[i] === '\n') return false; continue }
      if (c === d) { i++; return true }
      if (c === '[') {
        let j = i + 1
        if (s[j] === '^') j++
        if (s[j] === ']') j++
        for (; j < n; j++) {
          if (s[j] === '[' && ':.='.includes(s[j + 1] ?? '#')) { const k = s.indexOf(`${s[j + 1]}]`, j + 2); if (k < 0) return false; j = k + 1; continue }
          if (s[j] === ']') break
        }
        if (j >= n) return false
        const b = s.slice(i, j + 1)
        if (b.includes(d) || b.includes('\n')) return false
        i = j
      }
    }
    return false
  }
  const num = () => { const k = i; while (i < n && /\d/.test(s[i]!)) i++; return i > k }
  const addr = (): boolean => {
    if (s[i] === '$') { i++; return true }
    if (num()) { if (s[i] === '~') { i++; return num() } return true }
    if (s[i] === '/') { i++; if (!part('/')) return false; while (s[i] === 'I' || s[i] === 'M') i++; return true }
    return false
  }
  if (!s.trim()) return false
  while (i < n) {
    while (i < n && /[\s;]/.test(s[i]!)) i++
    if (i >= n) break
    if (s[i] === '}') { i++; continue }
    if (addr()) {
      ws()
      if (s[i] === ',') {
        i++; ws()
        if (s[i] === '+' || s[i] === '~') { i++; if (!num()) return false } else if (!addr()) return false
      }
    } else if (s[i] === '\\') return false
    ws()
    while (s[i] === '!') { i++; ws() }
    const c = s[i++]
    if (c === undefined) return false
    if (c === '{') continue
    if (c === 's') {
      const d = s[i++]
      if (!d || /[\s\\\w]/.test(d)) return false
      if (!part(d) || !part(d)) return false
      for (; i < n && !/[\s;}]/.test(s[i]!); i++) if (!/[gpiImM\d]/.test(s[i]!)) return false
    } else if (c === 'y') {
      const d = s[i++]
      if (!d || /[\s\\\w]/.test(d)) return false
      if (!part(d) || !part(d)) return false
    } else if ('pPdD=nNhHgGxlQq'.includes(c)) {
      if (c === 'q' || c === 'Q') num()
    } else return false
    ws()
    if (i < n && !/[;\n}]/.test(s[i]!)) return false
  }
  return true
}
// sed [-n] [-E|-r] [-s] [-e script | script] [file ...]: -n is required (no automatic printing), no -i / --in-place / -f / -z / --posix
function sedWordsOk(rest: string[]): { script: boolean; pos: string[] } | null {
  let quiet = false
  const scripts: string[] = []
  const pos: string[] = []
  let dashdash = false
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i]!
    if (dashdash || x === '-' || !x.startsWith('-')) { pos.push(x); continue }
    if (x === '--') { dashdash = true; continue }
    if (x.startsWith('--')) {
      if (x === '--quiet' || x === '--silent') quiet = true
      else if (x === '--regexp-extended' || x === '--separate') continue
      else if (x.startsWith('--expression=')) scripts.push(x.slice(13))
      else if (x === '--expression') { if (i + 1 >= rest.length) return null; scripts.push(rest[++i]!) }
      else return null
      continue
    }
    for (let k = 1; k < x.length; k++) {
      const c = x[k]!
      if (c === 'n') quiet = true
      else if (c === 'E' || c === 'r' || c === 's') continue
      else if (c === 'e') {
        if (k < x.length - 1) scripts.push(x.slice(k + 1))
        else { if (i + 1 >= rest.length) return null; scripts.push(rest[++i]!) }
        break
      } else return null
    }
  }
  if (!quiet) return null
  if (!scripts.length) { if (!pos.length) return null; scripts.push(pos.shift()!) }
  return scripts.every(sedScriptOk) ? { script: true, pos } : null
}
// jq: no -f / --from-file, --rawfile, --slurpfile, --argfile, -L, --args; a filter that reads the environment or loads a module is refused
const JQ_FLAGS = new Set(['-n', '-r', '-c', '-s', '-e', '-S', '-M', '-C', '-a', '-j', '-R', '--null-input', '--raw-output', '--compact-output', '--slurp', '--exit-status', '--sort-keys', '--monochrome-output', '--color-output', '--ascii-output', '--join-output', '--raw-input', '--tab', '--seq', '--unbuffered', '--stream'])
function jqWordsOk(rest: string[]): string[] | null {
  const pos: string[] = []
  let dashdash = false
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i]!
    if (dashdash || x === '-' || !x.startsWith('-')) { pos.push(x); continue }
    if (x === '--') { dashdash = true; continue }
    if (x === '--indent') { if (!/^[0-7]$/.test(rest[i + 1] ?? '')) return null; i++; continue }
    if (JQ_FLAGS.has(x)) continue
    if (/^-[nrcseSMCajR]+$/.test(x)) continue
    return null
  }
  if (!pos.length) return null
  const filter = pos[0]!
  if (/(?<![A-Za-z0-9_])(?:env|ENV|import|include|modulemeta|get_search_list|input_filename|debug|stderr|halt_error)(?![A-Za-z0-9_])|\$ENV|\$__prog/.test(filter)) return null
  return pos.slice(1)
}
// find: starting points are the words before the first predicate; only these predicates (argument count) exist for us
const FIND_PRED: Record<string, number> = { '-name': 1, '-iname': 1, '-path': 1, '-ipath': 1, '-wholename': 1, '-regex': 1, '-type': 1, '-maxdepth': 1, '-mindepth': 1, '-size': 1, '-mtime': 1, '-atime': 1, '-ctime': 1, '-mmin': 1, '-user': 1, '-group': 1, '-perm': 1, '-newer': 1, '-empty': 0, '-print': 0, '-print0': 0, '-prune': 0, '-not': 0, '-a': 0, '-o': 0, '-true': 0, '-false': 0, '-readable': 0, '-writable': 0, '-executable': 0, '-depth': 0, '-xdev': 0, '-mount': 0 }

async function pathOk($: Host, ctx: Ctx, roots: string[], word: string): Promise<boolean> {
  if (!ctx.cwd || ctx.cwd === '/' || word.split('/').includes('..')) return false // `..` after a symlink would leave the roots: no `..` at all
  const d = await resolve($, word, ctx.cwd)
  return roots.some(r => within(d, r))
}
// An unquoted glob operand (shell.ts GLOB_MARK + the pattern): expanded here, level by level, the way the shell would (a superset: dotfiles
// match, a [...] set matches any one character), and the command is allowed only when the folder it starts in and EVERY possible match
// resolve inside the roots (a symlink out of them refuses) and no match could be read as a flag (a name starting with `-`). More than
// GLOB_MAX entries looked at: refused (quote the pattern, or name a narrower folder).
const GLOB_MAX = 1000
const hasGlob = (s: string) => /[*?[\]]/.test(s)
const segRe = (s: string) => new RegExp('^' + s.replace(/\[[^\]]*\]|[*?[\]]|[.+^${}()|\\]/g, m => (m === '*' ? '[^/]*' : m === '?' || m[0] === '[' || m === ']' ? '[^/]' : '\\' + m)) + '$')
async function globOk($: Host, ctx: Ctx, roots: string[], marked: string): Promise<boolean> {
  const pat = marked.slice(1)
  if (!pat || pat.startsWith('-') || pat.split('/').includes('..')) return false
  const parts = pat.split('/')
  // a bracket set the scan above cannot size exactly (`[]a]`, `[!]]`, `[[:alpha:]]`: a `]` or `[` inside the set) matches one character in the
  // shell but more in segRe: refused, not guessed
  if (/\[[!^]?\]|\[[^\]]*\[/.test(pat)) return false
  const first = parts.findIndex(hasGlob)
  if (first < 0) return pathOk($, ctx, roots, pat)
  const lead = parts.slice(0, first).join('/') // '' = the cwd, or the root for an absolute pattern
  if (!(await pathOk($, ctx, roots, pat.startsWith('/') ? lead || '/' : lead || '.'))) return false
  const join = (dir: string, name: string) => (dir === '' ? name : dir === '/' ? `/${name}` : `${dir}/${name}`)
  let level: string[] = [pat.startsWith('/') && !lead ? '/' : lead] // '' = the cwd (a relative pattern), '/' = the file system root
  let seen = 0
  for (let k = first; k < parts.length; k++) {
    const next: string[] = []
    for (const dir of level) {
      if (!hasGlob(parts[k]!)) { next.push(join(dir, parts[k]!)); continue }
      const real = await resolve($, dir || '.', ctx.cwd)
      if (!roots.some(r => within(real, r))) return false
      const names = await $.fs.list(real).catch(() => [] as { name: string; kind: string }[])
      const re = segRe(parts[k]!)
      // a segment led by a literal dot (`.*`, `.?`, `..*`) matches `.` and `..` in older shells (bash before 5.2, macOS bash 3.2), which a
      // directory listing never shows: `.*/.*/.*` would climb out of the roots
      if (parts[k]!.startsWith('.') && (re.test('.') || re.test('..'))) return false
      for (const n of names) {
        if (!re.test(n.name)) continue
        if (++seen > GLOB_MAX) return false
        next.push(join(dir, n.name))
      }
    }
    level = next
  }
  for (const m of level) {
    if (m.startsWith('-')) return false
    if (!(await pathOk($, ctx, roots, m))) return false
  }
  return true
}
// flags parsed against the spec; the positional words come back (null = a flag that is not allowed)
function parseFlags(cmd: string, rest: string[]): { pos: string[]; given: boolean; recursive: boolean; noPattern: boolean } | null {
  const sp = SPECS[cmd]!
  const pos: string[] = []
  let given = false
  let recursive = false
  let noPattern = false
  let dashdash = false
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i]!
    if (dashdash || x === '-' || !x.startsWith('-')) { pos.push(x); continue }
    if (x === '--') { dashdash = true; continue }
    if (x.startsWith('--')) {
      const eq = x.indexOf('=')
      const name = x.slice(2, eq < 0 ? undefined : eq)
      if (sp.lnone.includes(name) && eq < 0) { if (name === 'recursive') recursive = true; if (name === 'files' || name === 'type-list') noPattern = true; continue }
      if (sp.lval.includes(name)) { if (name === 'regexp') given = true; if (eq < 0) { if (i + 1 >= rest.length) return null; i++ } continue }
      if ((name === 'color' || name === 'colour') && eq > 0 && cmd === 'grep') continue
      return null
    }
    for (let k = 1; k < x.length; k++) { // a short cluster, letter by letter
      const c = x[k]!
      if (sp.no.includes(c)) { if (c === 'r' && cmd === 'grep') recursive = true; if (c === 'R' && cmd === 'ls') recursive = true; continue }
      if (/\d/.test(c) && sp.digits) continue
      if (sp.val.includes(c)) {
        if (c === 'e') given = true
        if (k === x.length - 1) { if (i + 1 >= rest.length) return null; i++ } // the value is the next word
        break // else the rest of the word is the value
      }
      return null
    }
  }
  return { pos, given, recursive, noPattern }
}
async function searchOk($: Host, ctx: Ctx, w: string[], roots: string[], first = true, more = false): Promise<boolean> {
  const cmd = w[0]!
  if (!SEARCH_CMDS.has(cmd) && !(more && MORE_CMDS.has(cmd))) return false
  const nGlob = w.filter(isGlobWord).length // words with an unquoted glob (shell.ts marks them): only the plain file operands of GLOB_CMDS may be one
  if (nGlob && !(more && GLOB_CMDS.has(cmd))) return false
  const rest = w.slice(1)
  if (cmd === 'sed' || cmd === 'jq') { // the script / filter is data (checked above), the other words are files; none = stdin
    const files = cmd === 'sed' ? sedWordsOk(rest)?.pos : jqWordsOk(rest)
    if (!files) return false
    for (const p of files) if (!(await pathOk($, ctx, roots, p))) return false
    return true
  }
  if (cmd === 'find') {
    let i = 0
    const starts: string[] = []
    const newer: string[] = [] // -newer names a file to compare with: a path, but not a starting point
    for (; i < rest.length && !rest[i]!.startsWith('-'); i++) starts.push(rest[i]!)
    for (; i < rest.length; i++) {
      const n = FIND_PRED[rest[i]!]
      if (n === undefined) return false // -exec, -delete, -fprint*, -L, -files0-from ... and anything unknown
      if (n === 1) { if (i + 1 >= rest.length) return false; i++; if (rest[i - 1] === '-newer') newer.push(rest[i]!) }
    }
    for (const p of [...starts, ...newer]) if (!(await pathOk($, ctx, roots, p))) return false
    return starts.length > 0 || (await pathOk($, ctx, roots, '.')) // no starting point: the cwd
  }
  const f = parseFlags(cmd, rest)
  if (!f) return false
  if (cmd === 'tr') return f.pos.length >= 1 && f.pos.length <= 2 // character sets from stdin, no file operand
  const grepLike = cmd === 'grep' || cmd === 'rg'
  const paths = grepLike && !f.given && !f.noPattern ? f.pos.slice(1) : f.pos // the first positional of grep / rg is the pattern: data
  if (grepLike && !f.given && !f.noPattern && !f.pos.length) return false // no pattern
  if (cmd === 'uniq' && paths.length > 1) return false // `uniq in out` writes `out`
  if (paths.filter(isGlobWord).length !== nGlob) return false // a glob that is the pattern or a flag's value is expanded by the shell, never checked: refused
  for (const p of paths) if (!(isGlobWord(p) ? await globOk($, ctx, roots, p) : await pathOk($, ctx, roots, p))) return false
  if ((cmd === 'stat' || cmd === 'file') && !paths.length) return false
  if (cmd === 'diff') { // two plain files: on directories diff stat()s same-named entries, following a symlink out of the roots
    if (paths.length !== 2) return false
    for (const p of paths) {
      if (p === '-') continue
      const st = await $.fs.stat(await resolve($, p, ctx.cwd), { resolve: true }).catch(() => null)
      if (!st || st.kind !== 'file') return false
    }
  }
  // rg, ls and tree always look at the cwd when no path is named; grep when it is first in its pipeline or recursive; the others read stdin
  const needCwd = !paths.length && (cmd === 'rg' || cmd === 'ls' || cmd === 'tree' || f.recursive || (cmd === 'grep' && first))
  return !needCwd || (await pathOk($, ctx, roots, '.'))
}
// the whole command: every pipeline segment is a built-in git read or a search command
// null = allowed, else the refusal: the program that was refused (its first word only, a plain name, never an argument) and why
type Refusal = { prog: string; why: string }
const WHY_CMD = 'not a built-in read-only command'
const WHY_ARGS = 'a flag that writes or runs a program, a path outside the allowed folders, or a missing operand / -n'
const WHY_SHELL = (more: boolean) => `redirect, ;, &&, ||, substitution, ${more ? '' : 'glob, '}& or another shell form is not allowed${more ? ' (allowed: 2>/dev/null, and a glob that stays inside the allowed folders)' : ''}`
// the first word as a name (`npm`, `/usr/bin/ls`): leading name characters only, so no argument, variable or substitution is echoed
const progName = (word: string | undefined): string => (/^[A-Za-z0-9_.+/-]{1,40}/.exec(word ?? '')?.[0] ?? '?')
async function builtinReadOnly($: Host, ctx: Ctx, c: string): Promise<Refusal | null> {
  const git = builtinGit(ctx.agentType)
  const more = builtinMore(ctx.agentType)
  const segs = plainPipeline(c, more ? { glob: true, devnull: true } : {}) // readers and the reviewer: unquoted globs (checked in globOk) and 2>/dev/null
  if (!git.length) return { prog: progName(segs?.[0]?.[0] ?? c.trim().split(/\s+/)[0]), why: WHY_CMD }
  if (!segs) return { prog: progName(c.trim().split(/[\s|;&<>]/)[0]), why: WHY_SHELL(more) }
  const roots = await cRoots($, ctx)
  for (let i = 0; i < segs.length; i++) {
    const w = segs[i]!
    if (w[0] === 'git' ? !w.some(isGlobWord) && (await gitOk($, ctx, w, git, roots)) : await searchOk($, ctx, w, roots, i === 0, more)) continue
    const known = w[0] === 'git' || SEARCH_CMDS.has(w[0]!) || (more && MORE_CMDS.has(w[0]!))
    return { prog: progName(w[0]), why: known ? WHY_ARGS : WHY_CMD }
  }
  return null
}
const builtinList = (t?: string) => (builtinGit(t).length ? [...['git'], ...SEARCH_CMDS, ...(builtinMore(t) ? ['sed -n', 'stat', 'file', 'diff', 'jq', 'tree', 'sort', 'uniq', 'cut', 'tr', 'nl'] : [])].join(', ') : 'none')
async function gitOk($: Host, ctx: Ctx, w: string[], allowed: string[], roots: string[]): Promise<boolean> {
  let i = 1
  let seenC = false // one -C only (git chains them)
  for (; i < w.length && w[i]!.startsWith('-'); ) {
    if (w[i] === '--no-pager') i++
    else if (w[i] === '-C' && w[i + 1] && !seenC && w[i + 1]!.startsWith('/') && !w[i + 1]!.split('/').includes('..')) {
      seenC = true
      const d = await resolve($, w[i + 1]!, ctx.cwd)
      if (!roots.some(r => within(d, r))) return false
      i += 2
    } else return false
  }
  const sub = w[i++]
  if (!sub || !allowed.includes(sub)) return false
  for (const a of w.slice(i)) {
    if (a === '--') break
    if (a.startsWith('--')) { if (BAD_LONG(a.slice(2).split('=')[0]!, sub)) return false }
    else if (a.startsWith('-') && SHORT_O(a) && ['log', 'diff', 'show'].includes(sub)) return false
  }
  return true
}

// A thread's OWN read-only git and `ls` (one cheap command is cheaper than a reader): the same read-only flag checks the readers have (gitOk),
// only on its registered worktrees and the project repositories (cRoots), and the Bash result of a thread is capped (cap.ts). `branch` only
// lists and `worktree` only lists; every other word of those two is refused. Anything else falls through to the orchestration rules.
const THREAD_GIT = ['log', 'ls-files', 'show', 'diff', 'status', 'rev-parse', 'merge-base', 'branch', 'worktree']
const BRANCH_LIST = /^(-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--list|--no-color|--(contains|merged|no-merged|format|sort)=\S+)$/
const WORKTREE_LIST = /^(--porcelain|-v|--verbose)$/
async function threadReadOnly($: Host, ctx: Ctx, c: string): Promise<boolean> {
  const segs = plainPipeline(c)
  if (!segs?.length) return false
  const roots = await cRoots($, ctx)
  if (!roots.some(r => within(norm(ctx.cwd), r))) return false // no path named: the command works in the session folder, which must be one of the roots
  for (const w of segs) {
    if (w[0] === 'ls') {
      if (!(await searchOk($, ctx, w, roots, true, false))) return false
      continue
    }
    if (w[0] !== 'git' || w.some(isGlobWord) || !(await gitOk($, ctx, w, THREAD_GIT, roots))) return false
    let i = 1
    while (i < w.length && w[i]!.startsWith('-')) i += w[i] === '-C' ? 2 : 1
    const sub = w[i], rest = w.slice(i + 1)
    if (sub === 'branch' && !rest.every(a => BRANCH_LIST.test(a))) return false
    if (sub === 'worktree' && !(rest[0] === 'list' && rest.slice(1).every(a => WORKTREE_LIST.test(a)))) return false
  }
  return true
}
// ---- what a subagent may do: read and edit, with a short never-list ------------------------------------------------------------
// Workers (worker-*) edit anywhere the engine's own permission check allows, and run any shell command; readers (reader-*, explorer) read
// anything and run any shell command that writes nothing outside a temp folder or the calling thread's `scratch/` (the reviewer has the same
// rule since 1.0.22). The auditor stays on the read-only command list (its verdict must be trustworthy). Never, for any of them: git push /
// tags / releases, a forge write (gh / az), a change of permissions or settings, lean-agent's own state under the lean home (except that scratch). `allow-edit:` / `allow-cmd:` lines in a brief are accepted and ignored.
const GIT_TAG = /\bgit\b[^;&|\n]*\btag\b[ \t]*([^;&|\n]*)/g
const TAG_LIST = /^(-l\b|--list\b|-n\b|--contains\b|--points-at\b|--merged\b|--no-merged\b|--sort\b|$)/
const SETTINGS_CMD = /\bclaude\s+(config|mcp|plugin|permissions|settings|login|logout|setup-token)\b|(^|[\s/'"])(\.claude\/settings(\.local)?\.json|managed-settings\.json)/
const SETTINGS_PATH = /(^|\/)\.claude\/settings(\.local)?\.json$|(^|\/)managed-settings\.json$/
const TEMP_OK = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/dev\/(null|stderr|stdout)$|\$\{?TMPDIR\}?\/|[^\0]*\/\.claude\/jobs\/[^/]+\/tmp\/|[^\0]*\/\.lean-agent\/tmp\/)/
// `scratch`: the calling thread's own `<thread folder>/scratch` (the one place under the lean home a subagent may write notes and drafts)
const tempFile = (w: string, scratch?: string): boolean => (TEMP_OK.test(w) || (!!scratch && w.startsWith(`${scratch}/`))) && !w.split('/').includes('..') && !/[`]|\$(?!\{?TMPDIR)/.test(w)
// the words that follow a `>` / `>>` / `&>` outside quotes (a `>&2` fd copy is no file)
// A heredoc body and a `# comment` are text, not commands: a `>` in them ("# result > no-token", "if v > 3.4.0" in a python heredoc)
// is no redirect (1.0.33: readers were refused with "redirect to ON" / "redirect to 3.4.0"). The rest of the `<<WORD` line stays scanned
// (`cat <<EOF > f`); a `<<` inside quotes starts nothing; an UNQUOTED heredoc whose body has a substitution still runs that command: scanned.
const HEREDOC_AT = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1/y
export function redirectTargets(c: string): string[] {
  const out: string[] = []
  let q = ''
  let body: { from: number; to: number } | null = null // the lines of a heredoc body, once the line of its `<<WORD` is done
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!
    if (body && i >= body.from) { i = body.to - 1; body = null; continue }
    if (q) { if (ch === q) q = ''; else if (ch === '\\' && q === '"') i++; continue }
    if (ch === '\\') { i++; continue }
    if (ch === '#' && (i === 0 || /[\s;&|(]/.test(c[i - 1]!))) { while (i + 1 < c.length && c[i + 1] !== '\n') i++; continue }
    if (ch === '<' && c[i + 1] === '<' && c[i + 2] !== '<' && c[i - 1] !== '<' && !body) {
      HEREDOC_AT.lastIndex = i
      const m = HEREDOC_AT.exec(c)
      const nl = m ? c.indexOf('\n', i) : -1
      if (m && nl >= 0) {
        const end = new RegExp(`\\n[ \\t]*${m[2]}[ \\t]*(?=\\n|$)`).exec(c.slice(nl))
        const to = end ? nl + end.index + end[0].length : c.length
        // (a body that is fed to a shell, `bash <<'EOF'` / `sh -s <<EOF`, is a script: its redirects count)
        const feedsShell = /(^|[\s;&|(])(ba|z|da|k)?sh\b|\b(eval|source)\b/.test(c.slice(c.lastIndexOf('\n', i) + 1, i))
        if (!feedsShell && (m[1] || !/\$\(|`/.test(c.slice(nl, to)))) body = { from: nl, to }
        i += m[0].length - 1
        continue
      }
    }
    if (ch === "'" || ch === '"') { q = ch; continue }
    if (ch !== '>') continue
    let j = i + 1
    if (c[j] === '>') j++
    if (c[j] === '&' && /[\d-]/.test(c[j + 1] ?? '')) { i = j + 1; continue }
    if (c[j] === '&' || c[j] === '|') j++
    while (c[j] === ' ' || c[j] === '\t') j++
    let w = ''
    let qq = ''
    for (; j < c.length; j++) {
      const d = c[j]!
      if (qq) { if (d === qq) qq = ''; else w += d; continue }
      if (d === "'" || d === '"') { qq = d; continue }
      if (/[\s;&|()<>]/.test(d)) break
      w += d
    }
    out.push(w)
    i = Math.max(i, j - 1)
  }
  return out
}
const UNQUOTED = (c: string) => c.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
const CMD_AT = (names: string) => new RegExp(`(?:^|[;&|(\\n])\\s*(?:sudo\\s+|env\\s+)?(?:${names})\\b`)
const WRITING_PROGS = CMD_AT('rm|mv|cp|touch|truncate|dd|ln|install|rsync|patch')
const WRITING_GIT = CMD_AT('git(?:\\s+-C\\s+\\S+)?\\s+(?:commit|add|checkout|switch|reset|restore|stash|merge|rebase|cherry-pick|apply|clean|rm|mv|am|pull|revert)(?![\\w-])') // (not merge-base, rm-xyz ...)
// a reader's shell command that would write a file (it has no Edit / Write tool: the shell is its only way to)
export function readerWrite(c: string, scratch?: string): string | null {
  const bad = redirectTargets(c).find(w => !tempFile(w, scratch))
  const u = UNQUOTED(c)
  if (bad !== undefined) return `lean-agent: a reader writes no file (redirect to ${bad.slice(0, 80) || 'a command'}); only a temp folder${scratch ? ` or ${scratch}` : ''} may be written, or give the step to a worker`
  if (/\btee\b/.test(u) && /\btee\b\s+(?:-\S+\s+)*(\S+)/.exec(u) && !tempFile(/\btee\b\s+(?:-\S+\s+)*(\S+)/.exec(c)?.[1]?.replace(/^['"]|['"]$/g, '') ?? '', scratch)) return 'lean-agent: a reader writes no file (tee); only a temp folder may be written, or give the step to a worker'
  if (/\b(sed|perl)\b[^;&|\n]*\s(-[a-zA-Z]*i\S*|--in-place\S*)(\s|$)/.test(u) || WRITING_PROGS.test(u) || WRITING_GIT.test(u)) return 'lean-agent: a reader changes nothing in the project (no rm / mv / cp / touch / sed -i / git write); give the step to a worker'
  return null
}
// the program and subcommand of the outward command a refusal is about (`gh pr`, `az pipelines`, `git remote`), never an argument
const OUTWARD = /(?:^|[\s;&|(])(gh|az|lean-agent|git|curl|wget|npm|docker)\s+(?:(?:-R|--repo|-C|--org|--organization|--project|--subscription)\s+\S+\s+|-\S+\s+)*([a-z][a-z0-9-]*)/g
export function forgeTried(c: string): string {
  const all = [...c.matchAll(OUTWARD)]
  const m = all.find(x => x[1] === 'gh' || x[1] === 'az') ?? all[0]
  return m ? `${m[1]} ${m[2]}` : progName(c.trim().split(/\s+/)[0])
}
// A worker commits its OWN change (brief line `commit: <message>`: git add of the files it changed, git commit; status / diff / log read). The git writes that
// could lose or rewrite someone else's work are refused: reset --hard, a checkout / switch of a branch (`checkout -- <path>` restores a file and stays),
// rebase, amend (a worker's commit is always a new one). Quoted text is blanked first, so a commit message that says "rebase" is no rebase.
const GIT_WORDS = /\bgit\s+(?:(?:-C|-c)\s+\S+\s+|-{1,2}[\w-]+(?:=\S+)?\s+)*([a-z][a-z-]*)\b([^;&|\n]*)/g
export function workerGitDenial(c: string, commit = true): string | null {
  for (const m of UNQUOTED(c).matchAll(GIT_WORDS)) {
    const sub = m[1]!
    const rest = m[2]!.trim().split(/\s+/).filter(Boolean)
    if (sub === 'commit' && !commit) return 'lean-agent: workers.commit is off: a worker does not commit; return files + diffstat and the thread commits'
    if (sub === 'reset' && rest.some(a => /^--(hard|merge|keep)$/.test(a))) return 'lean-agent: a worker never runs `git reset --hard`; commit what you changed and report the rest to the thread'
    if (sub === 'rebase') return 'lean-agent: a worker never rebases; report to the thread'
    if (sub === 'commit' && rest.includes('--amend')) return 'lean-agent: a worker never amends: a commit of yours is a new commit (git add <your files> && git commit -m <message>)'
    if ((sub === 'checkout' || sub === 'switch') && !rest.includes('--')) return `lean-agent: a worker never changes branch (git ${sub}); stay on the worktree's branch, and \`git checkout -- <path>\` restores a file`
  }
  return null
}
// the never-list of every subagent's shell
async function neverDenial($: Host, c: string): Promise<string | null> {
  const a = analyze(c)
  if (a.push || PUSH.test(c)) return 'lean-agent: a subagent never pushes; report to the thread (the desk pushes after the review)'
  if (isForgeWrite(c)) return forgeRefusal() + tried(forgeTried(c))
  if (a.write) return `lean-agent: a subagent makes no forge write (gh / az), no remote change and no outward lean-agent command; report to the thread${tried(forgeTried(c))}`
  for (const m of c.matchAll(GIT_TAG)) if (!TAG_LIST.test(m[1]!.trim())) return 'lean-agent: a subagent never creates or deletes a tag or a release; report to the thread'
  if (SETTINGS_CMD.test(c)) return 'lean-agent: a subagent never changes permissions or settings'
  // a subagent never starts a Claude session (a session started from a shell could pose as a desk or a thread)
  if (/(^|[\s;&|(`'"/])claude(\s+|$)(?!plugin\s+(validate|test)\b)/.test(UNQUOTED(c)) && !/^\s*claude\s+(--version|--help|-v|-h)\s*$/.test(c)) return 'lean-agent: a subagent never starts a Claude session (claude ...); report to the thread'
  return null
}
// a worker's shell command that names lean-agent's protected state and writes (a redirect, or a program that can)
// Returns the kind of file the command names (statePattern, never a path) or null. A read of lean state is no change: only a redirect to a
// file that is not temp or scratch, a program that writes (rm, mv, cp, tee ..., sed -i, an interpreter that says write) counts. The calling
// thread's own scratch folder is not lean state for this rule.
const SHELL_WRITERS = /\b(rm|mv|cp|tee|truncate|dd|ln|install|rsync|touch)\b/
const INTERP_WRITES = /\b(python3?|node|ruby|perl)\b/
async function leanStateShell($: Host, c: string, own?: string): Promise<string | null> {
  const home = await homeDir($)
  const lean = leanDir(home)
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const alts = [esc(lean), '~/\\.lean-agent', '\\$HOME/\\.lean-agent', '\\$\\{HOME\\}/\\.lean-agent'].join('|')
  const scratch = own ? `${lean}/threads/${own}/scratch` : ''
  // (a path that climbs out of scratch with `..` is not scratch)
  const c2 = own ? c.replace(new RegExp(`(?:${alts})/threads/${esc(own)}/scratch(?![\\w.-])([^\\s;&|<>"']*)`, 'g'), (all, rest: string) => (rest.includes('..') ? all : '')) : c
  const names = c2.includes(lean) || /(~|\$HOME|\$\{HOME\})\/\.lean-agent\b/.test(c2)
  const m = names ? /(config\.json|projects\.json|grants[\w.-]*|approvals[\w.-]*|\/reviews\b|\/threads\/)/.exec(c2) : null
  if (!m) return null
  const u = UNQUOTED(c2)
  const writes =
    redirectTargets(c2).some(w => !tempFile(w, scratch) && (/\.lean-agent\b/.test(w) || /^[~$]/.test(w) || !w.startsWith('/'))) ||
    SHELL_WRITERS.test(u) ||
    /\b(sed|perl)\b[^;&|\n]*\s(-[a-zA-Z]*i\S*|--in-place\S*)(\s|$)/.test(u) ||
    (INTERP_WRITES.test(u) && /(write|unlink|rename|remove|rmtree|open\([^)]*['"][wa]|appendFile|>\s)/i.test(c2))
  return writes ? statePattern(m[1]!.startsWith('/') ? m[1]! : `/${m[1]}`) : null
}
// the file-name pattern of lean state a refusal is about: a known name (config.json, projects.json, grants.json, approvals), reviews, reports,
// thread folder (another thread's), else the extension (`*.jsonl`) or `other`. Never a path, never a file's own name outside the known ones.
export function statePattern(rel: string): string {
  const base = rel.split('/').filter(Boolean).pop() ?? ''
  if (/^(config|projects)\.json$/.test(base)) return base
  if (/^grants/.test(base)) return 'grants.json'
  if (/^approvals/.test(base) || /\/approvals/.test(rel)) return 'approvals'
  if (/\/reviews(\/|$)/.test(rel)) return 'reviews'
  if (/\/reports?(\/|$)/.test(rel)) return 'reports'
  if (/^\/threads(\/|$)/.test(rel)) return 'thread folder'
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(base)?.[1]
  return ext ? `*.${ext}` : 'other'
}
// lean-agent's own state under the lean home: refused for a worker's edit (and a shell write); worktrees and the thread's own folder are not
const scratchHint = (lean: string, own: string) => `use <thread folder>/scratch for notes and drafts${own ? ` (${lean}/threads/${own}/scratch)` : ''}`
async function leanStateDenial($: Host, ctx: Ctx, abs: string, tool = 'Edit'): Promise<string | null> {
  const home = await homeDir($)
  const own = ctx.role.kind === 'thread' ? ctx.role.id : ''
  for (const lean of new Set([norm(leanDir(home)), norm(await realPath($, leanDir(home)))])) {
    if (!within(abs, lean)) continue
    const rel = abs.slice(lean.length)
    if (/^\/worktrees\//.test(rel)) return null
    const th = /^\/threads\/([^/]+)\/(.*)$/.exec(rel)
    if (th && own && th[1] === own && !/^(grants\.json$|approvals|reviews(\/|$))/.test(th[2]!)) return null
    const mine = !!th && !!own && th[1] === own
    return `lean-agent: ${abs} is lean-agent's own state (settings, grants, approvals, review records, other threads): a worker never edits it; ${scratchHint(lean, own)}; report the rest to the thread${tried(`${tool} ${mine ? 'thread folder' : 'lean state'} ${statePattern(rel)}`)}`
  }
  return null
}
const LEAN_TYPE = /^(lean-agent:)?(worker-|reader-|reviewer$|explorer$|auditor$)/
async function workerDenial($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  const t = ctx.agentType ?? 'unresolved' // a subagent whose type is not known is a reader with no grants
  const edits = e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit'
  if (e.tool === 'AskUserQuestion') return 'lean-agent: a subagent never asks the user; report the question to the thread'
  // MCP is opt-in per job: a lean-agent subagent reaches a server only when the brief says `allow-mcp: <server>` (read-only tools)
  if (isMcpTool(e.tool) && !isOwn(serverOf(e.tool)) && (t === 'unresolved' || LEAN_TYPE.test(t))) return mcpDecision(await grantFor($, ctx), e.tool)
  const wideReader = /^(reader-|explorer$|reviewer$)/.test(ownName(t) ?? '') // (the reviewer has the readers' shell rule since 1.0.22; the auditor stays on the read-only list)
  if (e.tool === 'Bash' && (isWorker(t) || wideReader)) {
    const c = String(e.command ?? '')
    const never = await neverDenial($, c)
    if (never) return never
    const ownId = ctx.role.kind === 'thread' ? ctx.role.id : ''
    const lean = leanDir(await homeDir($))
    const scratch = ownId ? `${lean}/threads/${ownId}/scratch` : undefined // the one place under the lean home a subagent writes notes and drafts, created on demand
    if (scratch && c.includes(scratch)) await mkdirp($, scratch).catch(() => undefined)
    if (isWorker(t)) {
      const wg = workerGitDenial(c, (await loadOrch($).catch(() => undefined))?.commit !== false)
      if (wg) return wg + tried(forgeTried(c))
      const pat = await leanStateShell($, c, ownId)
      if (pat) return `lean-agent: a worker never changes lean-agent's own state (settings, grants, approvals, review records, threads); ${scratchHint(lean, ownId)}; report the rest to the thread${tried(`Bash ${pat === 'thread folder' ? 'thread folder' : 'lean state'} ${pat}`)}`
      return null
    }
    // a reader's (and the reviewer's) curl / wget to a forge host is a plain GET that writes no file outside temp / scratch (forgeread.ts)
    if ((plainPipeline(c) ?? []).some(s => isForgeFetch(s) && !forgeReadOk(s, p => forgeTempOk(p, scratch)))) return forgeReadRefusal() + tried(forgeTried(c))
    return readerWrite(c, scratch)
  }
  if (isReader(t)) {
    if (edits) return t === 'unresolved' ? 'lean-agent: agent type unresolved, so it is a reader (read-only); report this with the debug log line "agent fields"' : `lean-agent: ${t} is read-only`
    if (e.tool === 'Bash') {
      const c = String(e.command ?? '').trim()
      if (t === 'unresolved') return 'lean-agent: agent type unresolved, so it is a reader; report this (feedback skill) with the debug log line "agent fields"'
      const refused = await builtinReadOnly($, ctx, c)
      if (!refused) return null
      // the refused program is named (first word only) so the feedback export shows WHAT readers ask for
      return `lean-agent: refused: ${refused.prog} (${refused.why}); ${t} may run only its built-in read-only commands (${builtinList(t)})`
    }
    return null
  }
  if (isWorker(t) && edits) {
    const raw: string = e.file_path ?? e.notebook_path ?? ''
    if (!raw) return 'lean-agent: edit without a path'
    const p = await resolve($, raw, ctx.cwd)
    if (SETTINGS_PATH.test(p)) return `lean-agent: ${p} holds permissions or settings: a worker never edits it; report it to the thread`
    return await leanStateDenial($, ctx, p, String(e.tool))
  }
  return null
}

// ---- expensive models ----------------------------------------------------------------------------------------------------------
// "opus or higher needs the user's approval" (expensive.ts): a thread's or the desk's own Agent call that would run an expensive model
// (the worker-opus type, any agent whose frontmatter model is one, a `model` override to one) and a `claude ... --model <x>` / `-m <x>`
// in a shell command are refused unless the user approved that family for this thread in the pane. The refusal is also a request in the
// pane's "Needs you" (the thread reports blocked). The user's own plain session is never touched: its model is the user's choice.
async function expensiveDenial($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  if (ctx.role.kind !== 'thread' && ctx.role.kind !== 'desk') return null
  const scope = ctx.role.kind === 'thread' ? ctx.role.id : 'desk'
  let model = ''
  let what = ''
  let action = 'agent'
  if (e.tool === 'Agent' || e.tool === 'Task') {
    const sub = typeof e.subagent_type === 'string' ? e.subagent_type.trim() : ''
    const over = typeof e.model === 'string' ? e.model.trim() : ''
    const note = typeof e.description === 'string' && e.description.trim() ? ` (${e.description.trim().replace(/\s+/g, ' ').slice(0, 100)})` : ''
    if (/^(lean-agent:)?worker-opus$/.test(sub)) {
      model = 'opus'
      what = `the worker-opus agent${note}`
    } else if (over && over.toLowerCase() !== 'inherit') {
      if (isExpensiveModel(over)) {
        model = over
        what = `an Agent call with model ${over.slice(0, 40)}${note}`
      }
    } else if (sub) {
      const m = await agentModel($, ctx.root ?? '', ctx.cwd, sub).catch(() => null)
      if (m && isExpensiveModel(m)) {
        model = m
        what = `the ${sub.slice(0, 60)} agent runs on ${m}${note}`
      }
    }
  } else if (e.tool === 'Bash') {
    const m = claudeModelIn(String(e.command ?? ''))
    if (m && isExpensiveModel(m)) {
      model = m
      what = `a shell command that starts claude on ${m.slice(0, 40)}`
      action = 'bash'
    }
  }
  if (!model || (await modelAllowed($, scope, model))) return null
  const family = familyOf(model)
  await addRequest($, { thread: scope, model, reason: what, action, origin: 'guard', asked: true }).catch(() => undefined)
  return `lean-agent: ${needsApprovalText(family, what)}`
}

// a new Agent call while the 5h window is hot (throttle.ts): the model it would run on is the call's override, else its type's own, else the session's (unknown: not haiku)
async function windowDenial($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  if ((e.tool !== 'Agent' && e.tool !== 'Task') || (ctx.role.kind !== 'thread' && ctx.role.kind !== 'desk')) return null
  if (ctx.role.kind === 'thread') { // the thread's HARD cap (config threads.hardTokens, none by default) is reached (budgetthread.ts, written by the desk's tick): no NEW agent call, nothing running is cut; the soft budget never refuses anything
    const b = await readJson<{ hard?: number; hardTokens?: number } | null>($, budgetFile(await homeDir($), ctx.role.id), null).catch(() => null)
    if (b?.hard && typeof b.hardTokens === 'number' && b.hardTokens > 0) return budgetRefusal(b.hardTokens)
  }
  const sub = typeof e.subagent_type === 'string' ? e.subagent_type.trim() : ''
  const over = typeof e.model === 'string' ? e.model.trim() : ''
  const own = over && over.toLowerCase() !== 'inherit' ? over : sub ? ((await agentModel($, ctx.root ?? '', ctx.cwd, sub).catch(() => null)) ?? '') : ''
  const model = own || (/haiku/i.test(sub) ? 'haiku' : '') // (an agent file that names no model: its name says haiku)
  const urgent = ctx.role.kind === 'desk' || (await threadPriority($, ctx.role.id)) === 'urgent' // (the desk routes: it is never held by the block level)
  return agentWindowDenial($, model, urgent)
}

// ---- the subagent cap ----------------------------------------------------------------------------------------
// config.json `agents.cap` (a whole number; absent or 0 = lean-agent sets none, and a cap in the user's own CLAUDE.md is the model's to
// count): the most subagents a thread's own loop may start in one session (the session id of thread.json; a restart starts again at 0).
// The review is not "work" under that cap: a thread that spent its cap on traces still gets its reviewer passes. Not counted, and never
// refused by the cap: `lean-agent:reviewer` (at most REVIEW_EXEMPT per session) and the review's second-opinion reader, a
// `lean-agent:reader-*` whose prompt has the line `review: second-opinion` (at most SECOND_EXEMPT). Past those numbers they count like any
// other subagent, so the marker cannot be used to dodge the cap.
export const REVIEW_EXEMPT = 6
export const SECOND_EXEMPT = 2
export const SECOND_OPINION_LINE = /^\s*review:\s*second-opinion\s*$/im
type CapState = { sid: string; counted: number; review: number; second: number }
export const capKind = (e: Call): 'review' | 'second' | 'counted' => {
  const sub = typeof e.subagent_type === 'string' ? e.subagent_type : ''
  if (sub === 'lean-agent:reviewer') return 'review'
  if (/^lean-agent:reader-(haiku|sonnet)$/.test(sub) && SECOND_OPINION_LINE.test(String(e.prompt ?? ''))) return 'second'
  return 'counted'
}
// "agents 3/4": the subagents a thread's session has counted against agents.cap (reviewer passes are not in it); '' when no cap is set
export async function agentsText($: Host, home: string, id: string): Promise<string> {
  const cap = Number((await readJson<{ agents?: { cap?: unknown } }>($, `${leanDir(home)}/config.json`, {}))?.agents?.cap)
  if (!Number.isInteger(cap) || cap <= 0) return ''
  const dir = `${threadsDir(home)}/${id}`
  const sid = String((await readJson<{ sid?: unknown }>($, `${dir}/thread.json`, {}))?.sid ?? '')
  const had = await readJson<Partial<CapState>>($, `${dir}/subagents.json`, {})
  return `agents ${had?.sid === sid ? Number(had.counted) || 0 : 0}/${cap}`
}
async function capDenial($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  if (ctx.role.kind !== 'thread' || ctx.agentId || ctx.agentType || (e.tool !== 'Agent' && e.tool !== 'Task')) return null
  const home = await homeDir($)
  const cfg = await readJson<{ agents?: { cap?: unknown } }>($, `${leanDir(home)}/config.json`, {})
  const cap = Number(cfg?.agents?.cap)
  if (!Number.isInteger(cap) || cap <= 0) return null
  // execution model: the small workers (worker-*, reader-*) are the work itself; they never count against the user's subagent cap
  if ((await loadOrch($)).on && isSmall(typeof e.subagent_type === 'string' ? e.subagent_type : '') && capKind(e) === 'counted') return null
  return locked(async () => {
    const dir = `${threadsDir(home)}/${ctx.role.kind === 'thread' ? ctx.role.id : ''}`
    const sid = String((await readJson<{ sid?: unknown }>($, `${dir}/thread.json`, {}))?.sid ?? '')
    const had = await readJson<Partial<CapState>>($, `${dir}/subagents.json`, {})
    const st: CapState = had?.sid === sid ? { sid, counted: Number(had.counted) || 0, review: Number(had.review) || 0, second: Number(had.second) || 0 } : { sid, counted: 0, review: 0, second: 0 }
    const kind = capKind(e)
    if (kind === 'review' && st.review < REVIEW_EXEMPT) st.review++
    else if (kind === 'second' && st.second < SECOND_EXEMPT) st.second++
    else if (st.counted >= cap) return `lean-agent: subagent cap reached: ${st.counted} subagents already started in this session (cap ${cap}, config.json agents.cap). Reviewer passes (lean-agent:reviewer), the review's second-opinion reader (a line "review: second-opinion" in its prompt) and the small workers (lean-agent:worker-* / reader-*, execution model) do not count against it and are still allowed; do the rest yourself or report with lean_report`
    else st.counted++
    await writeJson($, `${dir}/subagents.json`, st)
    return null
  })
}

// ---- entry ---------------------------------------------------------------------------------------------------
// every refusal names the code that refused: a session may run an older guard than the skills it reads say (version skew)
export async function decide($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  const why = await decideRaw($, ctx, e)
  return why && ctx.version ? `${why} (lean-agent ${ctx.version})` : why
}
async function decideRaw($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  const dear = await expensiveDenial($, ctx, e)
  if (dear) return dear
  const hot = await windowDenial($, ctx, e) // the 5-hour plan window (throttle.ts): haiku only above window.throttleAbove, nothing new above blockAbove or the user's cap
  if (hot) return hot
  // grants are owned by a thread's own loop: an Agent call with allow-mcp lines from anyone else would start a
  // subagent that can do nothing, so it is refused up front with the reason
  const sub = typeof e.subagent_type === 'string' ? e.subagent_type : ''
  if ((e.tool === 'Agent' || e.tool === 'Task') && /^(lean-agent:)?(worker-|reader-|reviewer$|explorer$|auditor$)/.test(sub) && !(ctx.role.kind === 'thread' && !ctx.agentId)) {
    const g = parseGrants(e.prompt)
    if (g.mcp?.length || g.mcpWrite?.length) { // (allow-edit / allow-cmd lines are ignored, never refused)
      const who = ctx.agentId ? 'a subagent' : `a ${ctx.role.kind} session`
      return `lean-agent: this Agent call carries ${[g.mcp?.length ? 'allow-mcp' : '', g.mcpWrite?.length ? 'allow-mcp-write' : ''].filter(Boolean).join(' and ')} lines, but ${who} cannot own grants (only a thread's own session records them), so the subagent could do nothing. Remove the lines or run this from a thread`
    }
  }
  // the script auditor judges what it is given: its prompt is exactly the brief the mod generated (a thread cannot add instructions)
  if ((e.tool === 'Agent' || e.tool === 'Task') && /^(lean-agent:)?auditor$/.test(sub)) {
    const p = await auditorPromptProblem($, String(e.prompt ?? ''))
    if (p) return p
  }
  const capped = await capDenial($, ctx, e)
  if (capped) return capped
  const orch = await loadOrch($)
  const ownGit = ctx.role.kind === 'thread' && !ctx.agentType && !ctx.agentId && e.tool === 'Bash' && orch.on && (await threadReadOnly($, ctx, String(e.command ?? '')))
  if (orch.on && !ownGit) {
    const home = await homeDir($)
    const job = ctx.agentId && isSmall(ctx.agentType) ? (await grantFor($, ctx)).job : undefined // the job type of the brief this worker was started with
    const own = ctx.role.kind === 'thread' && !ctx.agentType && !ctx.agentId // (the project folders only name a refused path's kind in the record: threads' own calls)
    const projs = own ? await readJson<Record<string, { path?: unknown }>>($, `${leanDir(home)}/projects.json`, {}) : {}
    const projects = Object.values(projs && typeof projs === 'object' ? projs : {}).map(x => x?.path).filter((x): x is string => typeof x === 'string' && x.startsWith('/')).map(norm)
    const selfEdit = own && ctx.role.kind === 'thread' ? await selfEditRoots($, ctx.role.id).catch(() => []) : undefined // the worktrees the user let this thread edit itself (selfedit.ts, signed, verified per call)
    // haiku first, measured: a worker-sonnet brief without `why-sonnet:` for a job type haiku has a good record on in this project is refused as before, and the refusal says so
    let haiku = ''
    if (own && ctx.role.kind === 'thread' && (e.tool === 'Agent' || e.tool === 'Task') && /^(lean-agent:)?worker-sonnet$/.test(String(e.subagent_type ?? '')) && !WHY_SONNET.test(String(e.prompt ?? ''))) {
      const jb = jobOf(e.prompt)
      const project = String((await readJson<{ project?: unknown }>($, `${threadsDir(home)}/${ctx.role.id}/thread.json`, {}))?.project ?? '')
      if (jb && project) haiku = await haikuRecord($, project, jb)
    }
    const o = orchDecide(orch, { kind: ctx.role.kind === 'thread' ? 'thread' : ctx.role.kind === 'desk' ? 'desk' : 'other', agentType: ctx.agentType, agentId: ctx.agentId, job, home, cwd: ctx.cwd, threadDir: ctx.role.kind === 'thread' ? `${threadsDir(home)}/${ctx.role.id}` : undefined, projects, selfEdit, ...(haiku ? { haiku } : {}) }, e)
    if (o) return o
  }
  if (ctx.role.kind === 'desk' && !ctx.agentType && !ctx.agentId) {
    const d = await deskDenial($, ctx, e)
    if (d) return orch.on ? DESK_ROUTE : d
  }
  if (ctx.role.kind === 'thread' && !ctx.agentType && !ctx.agentId && e.tool === 'AskUserQuestion') return 'lean-agent: a thread never asks the user directly; use lean_ask (the desk relays it)'
  // a review thread (the mod's marker), its workers and its reviewers: the PR's checkout is read-only (reviewguard.ts)
  if (ctx.role.kind === 'thread' && e.tool === 'Bash') {
    const ro = reviewGitDenial(String(e.command ?? ''))
    if (ro && (await markerOf($, ctx.role.id))) return `lean-agent: ${ro}`
  }
  if ((ctx.agentType || ctx.agentId) && e.tool === 'Bash') {
    const u = await unauditedRun($, String(e.command ?? '')) // a subagent never runs an adopted script that was edited by hand
    if (u) return u
  }
  if (ctx.agentType || ctx.agentId) {
    const d = await workerDenial($, ctx, e)
    if (d) return d
  }
  if (e.tool === 'Bash') return await pushDenial($, String(e.command ?? ''), ctx.cwd, ctx.role)
  return null
}
