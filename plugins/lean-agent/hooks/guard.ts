// Guards for `tool.call` (design 2.6): strict mode for the desk, push gate and private projects everywhere,
// read-only and --allow-edit grants for worker subagents. `decide` answers a deny text or null (allow).
// register.tsx wraps it fail-closed: a throwing guard denies.
import { homeDir, leanDir, readJson, realPath, threadsDir, writeJson } from './state'
import { greenReview, hasApproval, takeApproval } from './reviews'
import { analyze, isGlobWord, plainPipeline, plainWords, privateText, readOnlyForge, type Verdict } from './shell'
import { auditorPromptProblem, unauditedRun } from './scripts'
import { addRequest, agentModel, claudeModelIn, familyOf, isExpensiveModel, modelAllowed, needsApprovalText } from './expensive'
import { DESK_ROUTE, isSmall, loadOrch, orchDecide } from './orchestrate'
import type { Host } from './state'
import type { Role } from './role'

export type Ctx = { role: Role; cwd: string; agentType?: string; agentId?: string; version?: string; root?: string } // agentType/agentId: set inside a subagent loop; root: the plugin's folder (agents/*.md)
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
// can strict mode ever allow this tool (by name)? lean-agent's own tools always
export const deskToolPossible = (name: string): boolean => DESK_TOOLS.includes(name) || name.startsWith(LEAN_TOOLS)

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
    const i = d.pending.findIndex(g => !g.type || sameAgent(g.type, ctx.agentType))
    if (i < 0) return {}
    const [g] = d.pending.splice(i, 1)
    d.agents[ctx.agentId!] = g!
    await writeJson($, file, d)
    return g!
  })
}

// A grant (`allow-cmd: git -C /w diff main...abc1234`) matches a command that is the grant itself or the grant followed by more words
// (flags, paths), compared word by word: spacing, quotes, `--no-pager` and a `-C` path spelled with `..`, `.` or a trailing slash do not
// matter (a thread folder is not a repository, so the review grants its git commands in the `git -C <worktree> ...` form). The command
// must have passed hasMeta already: no pipe, redirect or substitution ever rides on a grant.
const grantWords = (s: string): string[] => {
  const w = words(s)
  const out: string[] = []
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '--no-pager') continue
    if (w[i] === '-C' && w[i + 1]?.startsWith('/')) {
      out.push('-C', norm(w[i + 1]!))
      i++
    } else out.push(w[i]!)
  }
  return out
}
export const grantMatches = (command: string, grant: string): boolean => {
  const c = grantWords(command)
  const x = grantWords(grant)
  return x.length > 0 && x.length <= c.length && x.every((t, i) => t === c[i])
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
  return n === 'explorer' || n === 'auditor' ? GIT_EXPLORER : /^reader-/.test(n) || n === 'reviewer' ? GIT_READER : []
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
  return /^reader-/.test(n) || n === 'reviewer'
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

async function workerDenial($: Host, ctx: Ctx, e: Call): Promise<string | null> {
  const t = ctx.agentType ?? 'unresolved' // a subagent whose type is not known is a reader with no grants
  const edits = e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit'
  if (e.tool === 'AskUserQuestion') return 'lean-agent: a subagent never asks the user; report the question to the thread'
  if (isReader(t)) {
    if (edits) return t === 'unresolved' ? 'lean-agent: agent type unresolved, so it is a reader (read-only); report this with the debug log line "agent fields"' : `lean-agent: ${t} is read-only`
    if (e.tool === 'Bash') {
      const c = String(e.command ?? '').trim()
      if (t === 'unresolved') return 'lean-agent: agent type unresolved, so it is a reader with no grants; report this (feedback skill) with the debug log line "agent fields"'
      const refused = await builtinReadOnly($, ctx, c)
      if (!refused) return null
      const g = await grantFor($, ctx)
      const ok = !hasMeta(c) && (g.cmds ?? []).some(x => grantMatches(c, x))
      // the refused program is named (first word only) so the feedback export shows WHAT readers ask for
      return ok ? null : `lean-agent: refused: ${refused.prog} (${refused.why}); ${t} may run only its built-in read-only commands (${builtinList(t)}) and the commands the thread granted (allow-cmd)`
    }
    return null
  }
  if (isWorker(t) && edits) {
    const g = await grantFor($, ctx)
    const raw: string = e.file_path ?? e.notebook_path ?? ''
    if (!raw) return 'lean-agent: edit without a path'
    const p = await resolve($, raw, ctx.cwd)
    for (const root of g.edit ?? []) if (within(p, norm(root))) return null
    return `lean-agent: ${p} is outside the paths the thread granted this worker (allow-edit): stop and report this path to the thread (do not edit it another way); the thread adds it to allow-edit and briefs you again`
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
  // grants are owned by a thread's own loop: an Agent call with allow-cmd / allow-edit lines from anyone else would start a
  // subagent that can do nothing, so it is refused up front with the reason
  const sub = typeof e.subagent_type === 'string' ? e.subagent_type : ''
  if ((e.tool === 'Agent' || e.tool === 'Task') && /^(lean-agent:)?(worker-|reader-|reviewer$|explorer$|auditor$)/.test(sub) && !(ctx.role.kind === 'thread' && !ctx.agentId)) {
    const g = parseGrants(e.prompt)
    if (g.edit?.length || g.cmds?.length) {
      const who = ctx.agentId ? 'a subagent' : `a ${ctx.role.kind} session`
      return `lean-agent: this Agent call carries ${[g.cmds?.length ? 'allow-cmd' : '', g.edit?.length ? 'allow-edit' : ''].filter(Boolean).join(' and ')} lines, but ${who} cannot own grants (only a thread's own session records them), so the subagent could do nothing. Remove the lines or run this from a thread`
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
  if (orch.on) {
    const home = await homeDir($)
    const o = orchDecide(orch, { kind: ctx.role.kind === 'thread' ? 'thread' : ctx.role.kind === 'desk' ? 'desk' : 'other', agentType: ctx.agentType, agentId: ctx.agentId, home, cwd: ctx.cwd, threadDir: ctx.role.kind === 'thread' ? `${threadsDir(home)}/${ctx.role.id}` : undefined }, e)
    if (o) return o
  }
  if (ctx.role.kind === 'desk' && !ctx.agentType && !ctx.agentId) {
    const d = await deskDenial($, ctx, e)
    if (d) return orch.on ? DESK_ROUTE : d
  }
  if (ctx.role.kind === 'thread' && !ctx.agentType && !ctx.agentId && e.tool === 'AskUserQuestion') return 'lean-agent: a thread never asks the user directly; use lean_ask (the desk relays it)'
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
