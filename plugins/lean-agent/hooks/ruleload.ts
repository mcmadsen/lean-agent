// The mod as the loader of a project's learned rules for THREADS. Measured with the engine (claude 2.1.327): a session loads
// `.claude/rules/*.md` (path rules, on a Read) only for files beneath ITS ROOT. A thread's root is ~/.lean-agent/threads/tN and it reads the
// project by absolute path, so with the engine alone no rule ever reached a thread: a session rooted elsewhere reading <repo>/src/a.ts,
// with or without `--add-dir <repo>` (and with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD), loaded nothing and fired no
// InstructionsLoaded; only a session rooted in the repo did. So the rules come from the store (~/.lean-agent/<project>/rules/):
//   - on a thread's (or its subagent's) Read/Edit/Write/Grep/Glob of a path inside a registered project or one of its worktrees, and on a
//     built-in read-only shell command naming such a path (cat, head, rg, ...), every rule whose `paths:` match is appended ONCE per
//     context (the session, and each subagent separately: a subagent has its own context) to that tool's result;
//   - `_project.md` goes into the thread's first context at session start, and into a subagent's first tool result;
//   - each injection is logged to logs/rules-loaded.jsonl ({ts, src: 'loader', rule, project, session, agent, thread, trigger, sha}), which
//     rulesStats counts; a load the engine did itself (InstructionsLoaded, a session rooted in the checkout) marks the rule as given, so a
//     rule is never injected twice (the key is rule + sha of its body).
// Threads only, on purpose (a plain session in a registered project gets no injected rules): a session rooted in a synced checkout loads
// the rules natively (they are copied into every checkout when a thread of the project starts), so injecting there too would double them
// and the engine-root dedupe above was only measured for threads; it would change every non-lean session in a project folder (a read of
// the rule files per tool call, `git worktree list` per registered project per minute) with no opt-out; and it needs the same care at four
// more places (the compaction reset, `_project.md` at start, a private-project check the roots do not carry, the plain role's tool hook).
import { appendJsonl, homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { RULES_LOG, bodyOf, checkoutsOf, globProblem, globRe, pathsOf, projectDir, slugOk } from './rules'
import { hashText } from './recipe'

export const MAX_INJECT_RULE = 4000 // characters of one rule's body in a tool result (a grandfathered rule is cut here)
export const MAX_INJECT_TOTAL = 9000 // and of everything one tool result gets
const WATCHED = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'Bash'])
const READS = /(?:^|[\s|;&(])(?:cat|head|tail|rg|grep|ls|find|sed|awk|wc|bat|less|stat|diff|jq|tree)(?=\s)/
const TTL = 60_000
const RULES_TTL = 15_000

type Rule = { name: string; globs: string[]; body: string; sha: string; fsha: string } // fsha: the whole file (the globs are in its frontmatter, not its body)
type Root = { project: string; root: string }
let roots: { at: number; list: Root[] } | null = null
const rulesCache = new Map<string, { at: number; list: Rule[] }>()
const given = new Map<string, Set<string>>() // context (the session '', or a subagent's id) -> `project/rule\0sha`
const agents = new Set<string>() // subagents whose first tool call was seen
// compiled globs per rule FILE sha (the same file in two projects, or the same text read again after the 15 s TTL, compiles once); bounded:
// the oldest entry goes first. A pattern over the caps (rules.ts globProblem) is left out: it never matches.
export const MAX_COMPILED = 200
const compiled = new Map<string, { usable: string[]; res: RegExp[] }>()
export const compiledCount = () => compiled.size
function compiledOf(r: Rule): { usable: string[]; res: RegExp[] } {
  let c = compiled.get(r.fsha)
  if (!c) {
    const usable = r.globs.filter(g => !globProblem(g))
    c = { usable, res: usable.map(globRe) }
    if (compiled.size >= MAX_COMPILED) compiled.delete(compiled.keys().next().value as string)
    compiled.set(r.fsha, c)
  }
  return c
}
export const resetRuleLoader = () => {
  roots = null
  compiled.clear()
  rulesCache.clear()
  given.clear()
  agents.clear()
}

// every registered project's folder and worktrees, longest first; refreshed once a minute
async function rootsOf(h: Host): Promise<Root[]> {
  const now = await h.clock.now()
  if (roots && now - roots.at < TTL) return roots.list
  const home = await homeDir(h)
  const projs = await readJson<Record<string, { path?: string }>>(h, `${leanDir(home)}/projects.json`, {})
  const list: Root[] = []
  for (const [name, p] of Object.entries(projs && typeof projs === 'object' ? projs : {})) {
    if (!slugOk(name) || typeof p?.path !== 'string' || !p.path.startsWith('/') || p.path.replace(/\/+$/, '').length < 2) continue // (a project at `/` would own every path)
    for (const root of await checkoutsOf(h, name, p.path).catch(() => [p.path!])) list.push({ project: name, root: root.replace(/\/+$/, '') })
  }
  list.sort((a, b) => b.root.length - a.root.length)
  roots = { at: now, list }
  return list
}
async function resolve(h: Host, abs: string): Promise<{ project: string; rel: string; root: string } | null> {
  for (const r of await rootsOf(h)) if (abs === r.root || abs.startsWith(`${r.root}/`)) return { project: r.project, rel: abs.slice(r.root.length + 1), root: r.root }
  return null
}

async function rulesOf(h: Host, project: string): Promise<Rule[]> {
  const now = await h.clock.now()
  const c = rulesCache.get(project)
  if (c && now - c.at < RULES_TTL) return c.list
  const home = await homeDir(h)
  const dir = `${projectDir(home, project)}/rules`
  const list: Rule[] = []
  for (const f of (await h.fs.list(dir).catch(() => [])).filter(x => x.kind === 'file' && x.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))) {
    const t = await h.fs.read(`${dir}/${f.name}`).then(String).catch(() => '')
    const body = bodyOf(t).replace(/\n{3,}/g, '\n\n').trim()
    if (body) list.push({ name: f.name, globs: pathsOf(t), body, sha: hashText(body).slice(0, 12), fsha: hashText(t).slice(0, 12) })
  }
  rulesCache.set(project, { at: now, list })
  return list
}

// the part of a glob before its first wildcard: `src/**/*.ts` -> `src/`
const prefixOf = (g: string) => g.replace(/[*?[{].*$/, '')
// loose: a directory (or a shell argument) inside the rule's area counts, not only a file that matches
const insideArea = (globs: string[], rel: string) => globs.some(g => { const p = prefixOf(g); return p !== '' && (rel === p.replace(/\/$/, '') || rel.startsWith(p)) })

// A git command that only reads (a reviewer's `git -C <repo> show <sha>:<path>`, `git grep`, `git diff`, `git log -p`) names its files
// RELATIVE to the repo, never by absolute path, so the scan below sees nothing. gitReads() resolves them: the repo is the `-C` argument
// (or a `cd <abs>` before it, or the session's cwd for a plain `git show <rev>:<path>`), and every path argument is joined to it.
const GIT_READS = new Set(['show', 'grep', 'diff', 'log', 'blame', 'ls-tree', 'cat-file'])
const MAX_CALL_PATHS = 8
const safeAbs = (p: string) => p.startsWith('/') && p.length > 1 && !p.split('/').includes('..')
// a `.` segment is dropped (`-C .` is the cwd; `/repo/./a.ts` is `/repo/a.ts`)
const tidy = (p: string) => p.replace(/\/(\.\/)+/g, '/').replace(/\/\.$/, '')
// the command split into simple commands (on | || & && ; newline OUTSIDE quotes), each into words with the quotes removed: a commit message
// that mentions `git show ...` is one word of `git commit`, and `grep "a|b" -- path` keeps its path
function shellSegments(cmd: string): string[][] {
  const segs: string[][] = [[]]
  let word = ''
  let has = false
  let q = ''
  const end = () => { if (has) segs[segs.length - 1]!.push(word); word = ''; has = false }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (q) { if (c === q) q = ''; else if (c === '\\' && q === '"' && i + 1 < cmd.length) word += cmd[++i]; else word += c; continue }
    if (c === '"' || c === "'") { q = c; has = true } else if (c === '\\' && i + 1 < cmd.length) { word += cmd[++i]; has = true } else if (/\s/.test(c) && c !== '\n') end()
    else if (c === '\n' || c === ';' || c === '|' || c === '&') { end(); if (segs[segs.length - 1]!.length) segs.push([]) } else { word += c; has = true }
  }
  end()
  return segs.filter(s => s.length)
}
export function gitReads(cmd: string, cwd = ''): { paths: string[]; repos: string[] } {
  const paths: string[] = []
  const repos: string[] = []
  let dir = cwd.replace(/\/+$/, '')
  for (const t of shellSegments(cmd)) {
    if (t[0] === 'cd' && t[1]) { dir = tidy(t[1].startsWith('/') ? t[1].replace(/\/+$/, '') : dir && t[1] !== '-' ? `${dir}/${t[1]}` : ''); continue }
    if (t[0] !== 'git' && t[0] !== '/usr/bin/git') continue
    let repo = dir
    let i = 1
    for (; i < t.length && t[i]!.startsWith('-'); i++) {
      if (t[i] === '-C' && t[i + 1]) { const p = t[++i]!; repo = p.startsWith('/') ? p : repo ? `${repo}/${p}` : '' } else if (t[i] === '-c') i++
    }
    const sub = t[i++]
    repo = tidy(repo.replace(/\/+$/, ''))
    if (!sub || !GIT_READS.has(sub) || !safeAbs(repo)) continue
    repos.push(repo)
    const add = (a: string) => {
      const rel = a.replace(/[*?[{].*$/, '').replace(/^\.\//, '').replace(/\/+$/, '')
      const abs = tidy(rel.startsWith('/') ? rel : rel ? `${repo}/${rel}` : '')
      if (abs && !a.startsWith(':') && safeAbs(abs)) paths.push(abs)
    }
    let dd = false
    let positional = 0
    for (let k = i; k < t.length; k++) {
      const a = t[k]!
      if (dd) { add(a); continue }
      if (a === '--') { dd = true; continue }
      if (a === '-e' || a === '-f') { k++; positional += a === '-e' ? 1 : 0; continue } // grep -e <pattern>: the pattern is given
      if (a.startsWith('-')) continue
      positional++
      const colon = a.indexOf(':')
      if (sub === 'grep' || sub === 'ls-tree') { if (positional > 1 && colon < 0) add(a) } // the first one is the pattern (the tree-ish)
      else if (colon > 0 && !a.startsWith('/')) add(a.slice(colon + 1)) // <rev>:<path>
      else if (!a.includes('..') && colon < 0 && /\.[A-Za-z0-9]{1,6}$/.test(a)) add(a) // a bare file name
    }
  }
  return { paths: [...new Set(paths)].slice(0, MAX_CALL_PATHS), repos: [...new Set(repos)] }
}

// absolute paths a tool call touches; `loose` = may be a directory or a shell argument; `repos` = the checkouts a read-only git command ran in
export function pathsOfCall(tool: string, e: any, o: { cwd?: string } = {}): { paths: string[]; loose: boolean; repos: string[] } {
  const one = (v: unknown) => (typeof v === 'string' && v.startsWith('/') && !v.split('/').includes('..') ? [v.replace(/\/+$/, '') || '/'] : []) // a `..` path is never placed inside a project by its spelling
  if (tool === 'Bash') {
    const cmd = typeof e?.command === 'string' ? e.command : ''
    const g = gitReads(cmd, o.cwd)
    if (!READS.test(cmd)) return { paths: g.paths, loose: true, repos: g.repos }
    const out = new Set<string>(g.paths)
    for (const raw of cmd.split(/[\s|;&<>()=]+/)) {
      const t = raw.replace(/^['"`]+|['"`]+$/g, '').replace(/[*?[{].*$/, '').replace(/\/+$/, '')
      if (t.startsWith('/') && t.length > 1 && !t.split('/').includes('..')) out.add(t)
      if (out.size >= MAX_CALL_PATHS) break
    }
    return { paths: [...out], loose: true, repos: g.repos }
  }
  if (tool === 'Grep' || tool === 'Glob') return { paths: one(e?.path), loose: true, repos: [] }
  return { paths: [...one(e?.file_path), ...one(e?.notebook_path)], loose: false, repos: [] }
}

const textOf = (project: string, r: Rule) => {
  const body = r.body.length > MAX_INJECT_RULE ? `${r.body.slice(0, MAX_INJECT_RULE)}\n(cut: ${r.name} is over the size cap; shorten it with learn --trim)` : r.body
  return `[lean-agent] rule ${project}/${r.name}${r.globs.length ? ` (for ${r.globs.join(', ')})` : ''}:\n${body}`
}

type Who = { session: string; agent: string; thread?: string }
async function give(h: Host, who: Who, project: string, r: Rule, trigger: string): Promise<boolean> {
  const set = given.get(who.agent) ?? new Set<string>()
  given.set(who.agent, set)
  const key = `${project}/${r.name}\0${r.sha}`
  if (set.has(key)) return false
  set.add(key)
  const home = await homeDir(h)
  await appendJsonl(h, RULES_LOG(home), { ts: Math.floor((await h.clock.now()) / 1000), src: 'loader', rule: r.name, project, session: who.session, ...(who.agent ? { agent: who.agent } : {}), ...(who.thread ? { thread: who.thread } : {}), trigger, sha: r.sha }).catch(() => undefined)
  return true
}

// `_project.md` of a project, once per context (the thread's first context line, or a subagent's first result)
export async function projectRule(h: Host, who: Who, project: string, trigger: string): Promise<string | null> {
  if (!slugOk(project)) return null
  const r = (await rulesOf(h, project)).find(x => x.name === '_project.md')
  return r && (await give(h, who, project, r, trigger)) ? textOf(project, r) : null
}

// The text to append to the result of one tool call of a thread (or of its subagent), or null. `engineRoot` = the session's root: paths
// beneath it are left to the engine when that root is itself a project checkout.
export async function ruleContext(h: Host, who: Who, tool: string, e: any, opts: { threadProject?: string; engineRoot?: string; cwd?: string; repoCounts?: boolean } = {}): Promise<string | null> {
  const first = who.agent !== '' && !agents.has(who.agent) // a subagent's first tool call: it never saw the session start's context
  if (who.agent) agents.add(who.agent)
  if (!WATCHED.has(tool) && !first) return null
  const out: string[] = []
  const add = (t: string | null) => { if (t) out.push(t) }
  if (first && opts.threadProject) add(await projectRule(h, who, opts.threadProject, 'agent.first'))
  // candidates first, nothing marked given yet: a rule the size budget cuts is delivered by a later call, not lost
  const cand: { project: string; r: Rule }[] = []
  const has = (project: string, r: Rule) => cand.some(c => c.project === project && c.r.name === r.name) || (given.get(who.agent) ?? new Set()).has(`${project}/${r.name}\0${r.sha}`)
  if (WATCHED.has(tool)) {
    const { paths: named, loose, repos } = pathsOfCall(tool, e, { cwd: opts.cwd })
    // the reviewer role: the checkout a git command ran in counts as touched, whatever the command names (a `git diff` has no path)
    const paths = opts.repoCounts ? [...new Set([...named, ...repos])] : named
    const engineHit = paths.length && opts.engineRoot ? await resolve(h, opts.engineRoot) : null // (no path: nothing to resolve, no refresh)
    for (const abs of paths) {
      if (engineHit && opts.engineRoot && (abs === opts.engineRoot || abs.startsWith(`${opts.engineRoot}/`))) continue
      const at = await resolve(h, abs)
      if (!at) continue
      for (const r of await rulesOf(h, at.project)) {
        const c = r.name === '_project.md' || r.globs.length === 0 ? null : compiledOf(r)
        // (a rule for the whole repo, `**`, matches the repo itself, rel '': a reviewer that touches the checkout gets it)
        const wanted = !c ? true : c.res.some(re => re.test(at.rel)) || (loose && insideArea(c.usable, at.rel))
        if (wanted && !has(at.project, r)) cand.push({ project: at.project, r })
      }
    }
  }
  let text = out.join('\n\n')
  let cut = false
  for (const c of cand) {
    const t = textOf(c.project, c.r)
    if (text.length + t.length > MAX_INJECT_TOTAL) { cut = true; break }
    if (await give(h, who, c.project, c.r, tool)) text += `${text ? '\n\n' : ''}${t}`
  }
  if (cut) text += '\n(more rules matched; they follow with the next read in the area)'
  return text || null
}

// After a compaction the rule text is summarised away: what was given to that context may be given again (a thread's `_project.md` stays,
// it is a prompt section). `agent` '' = the session, else a subagent's own context.
export async function resetContext(h: Host, agent: string, keepProject?: string): Promise<void> {
  given.delete(agent)
  if (agent === '' && keepProject && slugOk(keepProject)) {
    const r = (await rulesOf(h, keepProject)).find(x => x.name === '_project.md')
    if (r) given.set('', new Set([`${keepProject}/${r.name}\0${r.sha}`]))
  }
}

// A load the engine did itself (InstructionsLoaded for a rule file in a checkout): the rule is marked given for the session context,
// so the loader does not inject it again
export async function markNative(h: Host, file: string): Promise<void> {
  const m = /\/\.claude\/rules\/lean-agent\/([^/]+\.md)$/.exec(file)
  if (!m) return
  const at = await resolve(h, file.slice(0, file.length - m[0].length))
  if (!at) return
  const t = await h.fs.read(file).then(String).catch(() => null)
  if (t === null) return
  const body = bodyOf(t).replace(/\n{3,}/g, '\n\n').trim()
  const set = given.get('') ?? new Set<string>()
  given.set('', set)
  set.add(`${at.project}/${m[1]}\0${hashText(body).slice(0, 12)}`)
}
