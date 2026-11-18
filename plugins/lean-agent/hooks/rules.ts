// Learned project rules (design 2.8). The source of truth is ~/.lean-agent/<project>/rules/*.md; Claude Code only loads
// real files, so they are COPIED to <repo>/.claude/rules/lean-agent/ (symlinked dirs do not load) and kept out of git
// through the repo's shared .git/info/exclude. Recipes become skills the same way (skills/<n>/SKILL.md ->
// .claude/skills/lean-agent-<n>/SKILL.md).
import { appendJsonl, atomicWrite, homeDir, leanDir, readJson, readJsonl, writeJson } from './state'
import type { Host } from './state'
import { SAFE_FILE, shippable } from './recipe'
import { withFolderLock } from './folderlock'
import { fileSize } from './ledger'
import { setNotice } from './notices'

export const MAX_RULE_FILES = 40
export const MAX_RULE_LINES = 25
export const MAX_PROJECT_LINES = 10
// the size budget next to the line cap: about 500 tokens per rule and 150 for _project (4 characters a token), and no
// line wider than 240 characters (one long line is how a line cap is dodged). They count the body: no frontmatter, no footer.
export const MAX_RULE_CHARS = 2000
export const MAX_PROJECT_CHARS = 600
export const MAX_LINE_WIDTH = 240
export const MAX_EXPLORERS = 4 // config.json learn.maxExplorers
export const STALE_FILES = 15 // the least a change count has to exceed; big areas scale it (staleLimit)
export const STALE_SHARE = 0.1
export const STALE_GAPS = 3
export const MAX_RELIES = 20
export const VERIFY_TOKENS = 150 // a verify run searches the repo for at most this many names
export const VERIFY_PER_RULE = 40
export const EXCLUDES = ['.claude/rules/lean-agent/', '.claude/skills/lean-agent-*/']
const MANIFESTS = new Set(['package.json', 'go.mod', 'go.work', 'Cargo.toml', 'pyproject.toml', 'pnpm-workspace.yaml', 'pom.xml', 'build.gradle'])

export type Area = { globs: string[]; sha: string; lines: number; chars?: number; relies?: string[]; coveredBy?: string; stale?: string; gaps?: number; at?: number }
export type Learn = { sha: string; areas: Record<string, Area> }

export const projectDir = (home: string, project: string) => `${leanDir(home)}/${project}`
const learnFile = (home: string, project: string) => `${projectDir(home, project)}/learn.json`
export const slugOk = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)

// `a.{ts,tsx}` (Claude Code's path rules accept braces): one level, expanded into alternatives
export function expandBraces(g: string): string[] {
  const m = /\{([^{}]*)\}/.exec(g)
  if (!m) return [g]
  return m[1]!.split(',').flatMap(alt => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)))
}

export function globRe(g: string): RegExp {
  const alts = expandBraces(g)
  if (alts.length === 1 && alts[0] !== g) return globRe(alts[0]!)
  if (alts.length > 1) return new RegExp(alts.map(a => globRe(a).source).join('|'))
  let r = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string
    if (c === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') { i++; r += '(?:.*/)?' } else r += '.*'
    } else if (c === '*') r += '[^/]*'
    else if (c === '?') r += '[^/]'
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${r}$`)
}
export const matches = (globs: string[], path: string) => globs.some(g => globRe(g).test(path))

export const lineCount = (t: string) => t.replace(/<!--[\s\S]*?-->/g, '').split('\n').filter(l => l.trim()).length
// the body of a rule: frontmatter and the lean-agent footer (an HTML comment) do not count against any cap
export const bodyOf = (t: string): string => t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/<!--[\s\S]*?-->/g, '')
export type Metrics = { lines: number; chars: number; widest: number }
// lines = non-empty body lines; chars = those lines joined by newlines
export function ruleMetrics(t: string): Metrics {
  const ls = bodyOf(t).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim())
  return { lines: ls.length, chars: ls.join('\n').length, widest: ls.reduce((m, l) => Math.max(m, l.length), 0) }
}
export const capsOf = (file: string) => (file === '_project.md' ? { lines: MAX_PROJECT_LINES, chars: MAX_PROJECT_CHARS } : { lines: MAX_RULE_LINES, chars: MAX_RULE_CHARS })
// what is over a cap (empty = within every cap). A rule over a cap is GRANDFATHERED by sync up to HARD_FACTOR times the cap: copied
// anyway and reported (rules written by an older version were under looser caps and must not vanish); beyond that sync skips it, and a
// skipped rule never deletes the copy that is already in a checkout (it stays until the rule is shortened).
export const HARD_FACTOR = 3
export function ruleProblems(file: string, t: string, factor = 1): string[] {
  const m = ruleMetrics(t)
  const cap = capsOf(file)
  const out: string[] = []
  if (m.lines > cap.lines * factor) out.push(`more than ${cap.lines * factor} lines (${m.lines})`)
  if (m.chars > cap.chars * factor) out.push(`more than ${cap.chars * factor} characters (${m.chars})`)
  if (m.widest > MAX_LINE_WIDTH * factor) out.push(`a line is ${m.widest} characters wide (max ${MAX_LINE_WIDTH * factor})`)
  return out
}
// `paths:` globs of a rule's frontmatter (a YAML list, or a single value); [] = none
export function pathsOf(t: string): string[] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t)?.[1] ?? ''
  const m = /^paths:[ \t]*(.*)\r?\n?((?:[ \t]*-[^\n]*\n?)*)/m.exec(fm)
  if (!m) return []
  const unq = (x: string) => x.trim().replace(/^["']|["']$/g, '')
  const items = m[2]!.split('\n').map(l => /^\s*-\s*(.*)$/.exec(l)?.[1]).filter((x): x is string => x !== undefined).map(unq)
  const inline = m[1]!.trim().replace(/^\[|\]$/g, '') // a flow list: paths: ["a", "b"]
  if (inline) items.push(...inline.split(/,(?![^{]*\})/).map(unq)) // a comma inside braces is part of the glob
  return items.filter(Boolean)
}
// The footer is the comment `<!-- lean-agent: learned ... -->` (a space after the colon). The marker comments of an adopted-
// scripts block, `<!-- lean-agent:scripts -->` ... `<!-- /lean-agent:scripts -->` (written by the mod at every sync, rulelines.ts; learn keeps the
// block intact and trim never deletes it), are not the footer and are never touched here.
const FOOTER = /<!--\s*lean-agent:(?=\s)([\s\S]*?)-->/
export const SCRIPTS_BLOCK = /<!--\s*lean-agent:scripts\s*-->[\s\S]*?<!--\s*\/lean-agent:scripts\s*-->/
// the footer's `relies-on:` list (symbols and files; the last field of the footer comment)
export function parseRelies(t: string): string[] {
  const f = FOOTER.exec(t)?.[1] ?? ''
  const m = /relies-on:\s*([\s\S]*)$/.exec(f)
  return m ? m[1]!.split(',').map(x => x.trim()).filter(Boolean) : []
}
const looksLikePath = (s: string) => !/\s/.test(s) && !/[<>$]/.test(s) && !s.split('/').includes('..') && !s.startsWith(':') && (s.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(s)) && !/^(https?:|\/|~)/.test(s)
// the footer gets `relies-on:` last (an existing one is replaced); no footer: one is made
export function withRelies(t: string, relies: string[], sha: string, date: string): string {
  const list = relies.join(', ')
  const re = FOOTER
  const m = re.exec(t)
  if (!m) return t.replace(/\n*$/, '\n') + `<!-- lean-agent: learned ${sha.slice(0, 8)} ${date}${list ? ` relies-on: ${list}` : ''} -->\n`
  const inner = m[1]!.replace(/\s*relies-on:[\s\S]*$/, '').trimEnd()
  return t.replace(re, () => `<!-- lean-agent:${inner}${list ? ` relies-on: ${list}` : ''} -->`) // a function: `$&` in a symbol is text
}
// non-empty body lines of a rule: what the line cap counts (the scripts block's lines too; frontmatter and comments are free)
export const bodyLines = (t: string): number => ruleMetrics(t).lines

// over: rules past a cap that were copied anyway (grandfathered, warned); skipped: not copied at all (kept as they are in the checkout)
export type SyncOut = { copied: string[]; removed: string[]; skipped: string[]; over?: string[]; excluded: boolean; exclude?: 'ok' | 'failed' | 'n/a' }

async function exclude(h: Host, repo: string): Promise<boolean> {
  const r = await h.process.run(['git', 'rev-parse', '--git-common-dir'], { cwd: repo })
  if (r.exitCode !== 0) return false
  const g = r.stdout.trim()
  if (!g) return false
  const file = `${g.startsWith('/') ? g : `${repo.replace(/\/$/, '')}/${g}`}/info/exclude`
  const have = await h.fs.read(file).catch(() => '')
  const lines = new Set(String(have).split('\n').map(l => l.trim()))
  const add = EXCLUDES.filter(x => !lines.has(x))
  if (add.length) await atomicWrite(h, file, String(have).replace(/\n*$/, '\n') + add.join('\n') + '\n')
  return true
}

async function mirror(h: Host, src: Map<string, string>, destDir: string, keep: (n: string) => boolean, out: SyncOut) {
  for (const [name, text] of src) {
    const file = `${destDir}/${name}`
    const have = await h.fs.read(file).catch(() => null)
    if (have !== text) { await h.fs.write(file, text); out.copied.push(file) }
  }
  const have = await h.fs.list(destDir).catch(() => [])
  for (const f of have) {
    if (keep(f.name) && !src.has(f.name)) { await h.process.run(['rm', '-rf', `${destDir}/${f.name}`]); out.removed.push(`${destDir}/${f.name}`) }
  }
}

const SKILL_MARK = '.lean-agent-managed'

// Copy the project's rules and recipe skills into `repo` (the checkout or one of its worktrees); remove stale copies.
export async function syncRules(h: Host, project: string, repo: string): Promise<SyncOut> {
  const home = await homeDir(h)
  const out: SyncOut = { copied: [], removed: [], skipped: [], over: [], excluded: false }
  const pdir = projectDir(home, project)
  const rules = new Map<string, string>()
  const protect = new Set<string>() // skipped rules: the copy a checkout already has stays (a cap that tightened never deletes a rule)
  const names = (await h.fs.list(`${pdir}/rules`).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => f.name).sort()
  for (const n of names) {
    if (rules.size >= MAX_RULE_FILES) { out.skipped.push(`${n}: more than ${MAX_RULE_FILES} rule files`); protect.add(n); continue }
    const t = String(await h.fs.read(`${pdir}/rules/${n}`))
    const bad = ruleProblems(n, t)
    if (bad.length) {
      const hard = ruleProblems(n, t, HARD_FACTOR)
      if (hard.length) { out.skipped.push(`${n}: ${hard.join(', ')}`); protect.add(n); continue }
      out.over!.push(`${n}: ${bad.join(', ')}`) // grandfathered: copied anyway
    }
    rules.set(n, t)
  }
  const recipes: { name: string; text: string }[] = []
  for (const d of (await h.fs.list(`${pdir}/skills`).catch(() => [])).filter(f => f.kind === 'dir')) {
    const t = await h.fs.read(`${pdir}/skills/${d.name}/SKILL.md`).catch(() => null)
    if (t !== null && slugOk(d.name)) recipes.push({ name: `lean-agent-${d.name}`, text: String(t) })
  }
  // adopted scripts (scripts.ts) are recipe skills too: the project's own, then the global ones
  for (const base of [`${pdir}/scripts`, `${leanDir(home)}/scripts`]) {
    for (const d of (await h.fs.list(base).catch(() => [])).filter(f => f.kind === 'dir' && f.name !== 'candidates' && f.name !== 'retired')) {
      // only a script that is still adopted and still the audited text ships a skill, and the skill is generated from the verified
      // meta (recipe.ts), never read from a file that could have been edited
      const dir = `${base}/${d.name}`
      const meta = await readJson<{ file?: unknown } | null>(h, `${dir}/meta.json`, null)
      const code = typeof meta?.file === 'string' && SAFE_FILE.test(meta.file) ? await h.fs.read(`${dir}/${meta.file}`).catch(() => null) : null
      const text = shippable(meta, code, dir)
      const name = `lean-agent-script-${d.name}`
      if (text !== null && slugOk(d.name) && !recipes.some(r => r.name === name)) recipes.push({ name, text })
    }
  }
  // git-exclude first: nothing we copy is ever visible to git, not even for a moment
  if (rules.size || recipes.length) out.excluded = await exclude(h, repo)
  await mirror(h, rules, `${repo}/.claude/rules/lean-agent`, n => n.endsWith('.md') && !protect.has(n), out)
  const mine = new Set(recipes.map(r => r.name))
  for (const r of recipes) {
    await mirror(h, new Map([['SKILL.md', r.text]]), `${repo}/.claude/skills/${r.name}`, () => false, out)
    await mirror(h, new Map([[SKILL_MARK, 'managed by lean-agent\n']]), `${repo}/.claude/skills/${r.name}`, () => false, { copied: [], removed: [], skipped: [], excluded: false })
  }
  // only folders lean-agent made (they carry the marker) are removed; a user's own lean-agent-* skill is left alone
  for (const d of await h.fs.list(`${repo}/.claude/skills`).catch(() => []))
    if (d.name.startsWith('lean-agent-') && !mine.has(d.name) && (await h.fs.exists(`${repo}/.claude/skills/${d.name}/${SKILL_MARK}`).catch(() => false))) {
      await h.process.run(['rm', '-rf', `${repo}/.claude/skills/${d.name}`])
      out.removed.push(`${repo}/.claude/skills/${d.name}`)
    }
  const wanted = rules.size > 0 || recipes.length > 0
  if (!out.excluded && out.removed.length) out.excluded = await exclude(h, repo)
  out.exclude = out.excluded ? 'ok' : wanted ? 'failed' : 'n/a'
  return out
}

// ONE line per checkout: counts, never the paths (those only with verbose)
export const syncSummary = (path: string, o: SyncOut) =>
  `${path}: copied ${o.copied.length}, removed ${o.removed.length}, skipped ${o.skipped.length}${o.over?.length ? `, over cap ${o.over.length}` : ''}, exclude ${o.exclude ?? (o.excluded ? 'ok' : 'n/a')}`

// Every checkout of the project: `git worktree list --porcelain` of `repo` (any checkout of the repository lists them all),
// plus the worktrees lean-agent made (~/.lean-agent/worktrees.json, keys `<project>/<branch>`). `repo` itself first.
export async function checkoutsOf(h: Host, project: string, repo: string): Promise<string[]> {
  const home = await homeDir(h)
  const out: string[] = [repo.replace(/(.)\/+$/, '$1')]
  const add = (p: unknown) => {
    if (typeof p !== 'string' || !p.startsWith('/')) return
    const q = p.replace(/(.)\/+$/, '$1')
    if (!out.includes(q)) out.push(q)
  }
  try {
    const r = await h.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: repo, timeoutMs: 5_000 }) // (a hung git never stalls a tool call)
    if (r.exitCode === 0) {
      let path = ''
      let skip = false
      const flush = () => { if (path && !skip) add(path); path = ''; skip = false }
      for (const l of r.stdout.split('\n')) {
        if (l.startsWith('worktree ')) { flush(); path = l.slice(9).trim() }
        else if (l === 'bare' || l.startsWith('prunable')) skip = true
      }
      flush()
    }
  } catch { /* the registry below still counts */ }
  const reg = await readJson<Record<string, { path?: string }>>(h, `${leanDir(home)}/worktrees.json`, {})
  if (reg && typeof reg === 'object') for (const [k, v] of Object.entries(reg)) if (k.startsWith(`${project}/`)) add(v?.path)
  return out
}

export type SyncAll = { lines: string[]; detail: { path: string; out: SyncOut | null; error?: string }[]; over: string[]; skipped: string[] }
// sync one checkout, or with `all` every checkout of the project; `lines` is what the tool answers
export async function syncAll(h: Host, project: string, repo: string, all: boolean): Promise<SyncAll> {
  const paths = all ? await checkoutsOf(h, project, repo) : [repo]
  const detail: SyncAll['detail'] = []
  const lines: string[] = []
  const skipped = new Set<string>()
  const over = new Set<string>()
  for (const p of paths) {
    if (p !== repo && !(await h.fs.exists(p).catch(() => false))) { detail.push({ path: p, out: null, error: 'missing' }); lines.push(`${p}: missing, skipped`); continue }
    try {
      const o = await syncRules(h, project, p)
      detail.push({ path: p, out: o })
      lines.push(syncSummary(p, o))
      for (const s of o.skipped) skipped.add(s)
      for (const s of o.over ?? []) over.add(s)
    } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 120)
      detail.push({ path: p, out: null, error })
      lines.push(`${p}: failed: ${error}`)
    }
  }
  if (over.size) lines.push(`over the size cap but copied anyway (shorten them: learn --trim): ${[...over].join('; ')}`)
  if (skipped.size) lines.push(`not synced, an earlier copy stays (shorten these): ${[...skipped].join('; ')}`)
  return { lines, detail, over: [...over], skipped: [...skipped] }
}

// The thread's first-context line about rules the caps touch (empty = nothing to say): what `learn --trim` / `lean_rules check` fix
export function capLine(s: { over: string[]; skipped: string[] }): string | null {
  if (!s.over.length && !s.skipped.length) return null
  const names = (l: string[]) => l.map(x => x.split(':')[0]).join(', ')
  return `rules: ${s.skipped.length} skipped (over cap${s.skipped.length ? `: ${names(s.skipped)}` : ''})${s.over.length ? `, ${s.over.length} over the cap but loaded anyway (${names(s.over)})` : ''}; run learn --trim or lean_rules check`
}

// ---- record ------------------------------------------------------------------------------------------------------
export type RecordIn = { globs: string[]; sha: string; lines?: number; relies?: string[]; coveredBy?: string }
const ruleFile = (area: string) => `${area}.md`

export async function recordLearn(h: Host, project: string, area: string, a: RecordIn & { lines: number; chars?: number }): Promise<void> {
  const home = await homeDir(h)
  const l = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  l.areas[area] = { globs: a.globs, sha: a.sha, lines: a.lines, ...(a.chars !== undefined ? { chars: a.chars } : {}), ...(a.relies?.length ? { relies: a.relies } : {}), ...(a.coveredBy ? { coveredBy: a.coveredBy } : {}), at: await h.clock.now() }
  l.sha = a.sha
  await writeJson(h, learnFile(home, project), l)
}

// The tool's record: `lines` is counted from the rule file here (a caller's number is ignored, and said so when it differs);
// relies-on is written into the footer (or read back from it); an area covered by the repo's own docs has no rule file.
// One writer of a project's rule files at a time, across processes (a learn thread's record and the script-rule rebuild of the desk or
// another thread both read a rule and write it back): folderlock.ts, a lock folder in the project's own folder.
export const withRulesLock = async <T,>(h: Host, project: string, f: () => Promise<T>): Promise<T> => withFolderLock(h, `${projectDir(await homeDir(h), project)}/.rules-lock`, f)
export const recordRule = (h: Host, project: string, area: string, a: RecordIn): Promise<string> => withRulesLock(h, project, () => recordRuleLocked(h, project, area, a))
async function recordRuleLocked(h: Host, project: string, area: string, a: RecordIn): Promise<string> {
  const home = await homeDir(h)
  const notes: string[] = []
  const file = `${projectDir(home, project)}/rules/${ruleFile(area)}`
  let lines = 0
  let chars: number | undefined
  let relies = (a.relies ?? []).map(x => x.replace(/,/g, ' ').trim()).filter(x => x && !/[\n]|-->/.test(x)).map(x => x.slice(0, 120)) // a comma would split the entry on read-back
  if (relies.length > MAX_RELIES) { notes.push(`relies-on cut to ${MAX_RELIES} entries`); relies = relies.slice(0, MAX_RELIES) }
  if (a.coveredBy) {
    notes.push(`covered by ${a.coveredBy}: no rule file, never stale, skipped by the next run`)
  } else {
    const t = await h.fs.read(file).then(String).catch(() => null)
    if (t === null) notes.push(`WARNING rules/${ruleFile(area)} does not exist: recorded with 0 lines`)
    else {
      const m = ruleMetrics(t)
      lines = m.lines
      chars = m.chars
      if (a.lines !== undefined && a.lines !== m.lines) notes.push(`lines: caller said ${a.lines}, the file has ${m.lines} (the file wins)`)
      const bad = ruleProblems(ruleFile(area), t)
      if (bad.length) notes.push(ruleProblems(ruleFile(area), t, HARD_FACTOR).length ? `WARNING over the cap, sync will skip it (an earlier copy stays): ${bad.join(', ')}` : `WARNING over the cap, sync still copies it but warns: ${bad.join(', ')}`)
      if (a.relies) {
        const date = new Date(await h.clock.now()).toISOString().slice(0, 10)
        const next = withRelies(t, relies, a.sha, date)
        if (next !== t) await atomicWrite(h, file, next)
      } else relies = parseRelies(t)
    }
  }
  await recordLearn(h, project, area, { globs: a.globs, sha: a.sha, lines, chars, relies, coveredBy: a.coveredBy })
  return `recorded ${area}: ${lines} lines${chars !== undefined ? `, ${chars} chars` : ''}${relies.length ? `, relies-on ${relies.length}` : ''}${notes.length ? `; ${notes.join('; ')}` : ''}`
}

async function markStale(h: Host, home: string, project: string, area: string, why: string): Promise<void> {
  const l = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  if (!l.areas[area] || l.areas[area].coveredBy || l.areas[area].stale === why) return
  l.areas[area].stale = why
  await writeJson(h, learnFile(home, project), l)
}

export const staleLine = (area: string) => `rules for ${area} are stale: re-learn when you touch it`
// a big area is not stale after 15 changed files: 10% of its files, at least `base`
export const staleLimit = (areaFiles: number, base = STALE_FILES) => Math.max(base, Math.ceil(areaFiles * STALE_SHARE))

// changed (M/A/T...) and vanished (D) paths since `sha`; a rename counts as a vanished old path and a new one
async function changedSince(h: Host, repo: string, sha: string): Promise<Map<string, string> | null> {
  const r = await h.process.run(['git', 'diff', '--name-status', '--no-renames', `${sha}..HEAD`], { cwd: repo })
  if (r.exitCode !== 0) return null
  const m = new Map<string, string>()
  for (const l of r.stdout.split('\n')) {
    const t = l.trim()
    if (!t) continue
    const tab = t.indexOf('\t')
    if (tab > 0) m.set(t.slice(tab + 1).trim(), t.slice(0, tab).trim().charAt(0))
    else m.set(t, 'M') // plain names (an older git or a stub): changed
  }
  return m
}
// relied-on FILES (entries that look like paths) that changed or vanished since the area was recorded
function reliesHit(a: Area, changed: Map<string, string>): string | null {
  for (const r0 of a.relies ?? []) {
    const r = r0.replace(/^\.\//, '')
    if (!looksLikePath(r)) continue
    if (!changed.has(r) && (/[*?[]/.test(r) || r.endsWith('/')) || ![...changed.keys()].includes(r) && [...changed.keys()].some(p => p.startsWith(`${r}/`))) { // a glob or a folder: any change under it
      const hit = [...changed].find(([p]) => (/[*?[]/.test(r) ? matches([r], p) : p.startsWith(r.endsWith('/') ? r : `${r}/`)))
      if (hit) return `relied-on ${hit[1] === 'D' ? 'file gone' : 'file changed'}: ${hit[0]}`
      continue
    }
    const st = changed.get(r)
    if (st === 'D') return `relied-on file gone: ${r}`
    if (st) return `relied-on file changed: ${r}`
  }
  return null
}

// Areas whose relied-on files changed or vanished, whose manifest changed, or whose globs changed in more than
// max(limit, 10% of the area's files) files since they were learned. Areas covered by repo docs are never stale.
export async function checkStale(h: Host, project: string, repo: string, limit = STALE_FILES): Promise<string[]> {
  const home = await homeDir(h)
  const l = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  const out: string[] = []
  const diffs = new Map<string, Map<string, string> | null>()
  let tracked: string[] | null | undefined
  const filesOf = async (globs: string[]): Promise<number | null> => {
    if (tracked === undefined) {
      const r = await h.process.run(['git', 'ls-files'], { cwd: repo }).catch(() => null)
      tracked = r && r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : null
    }
    return tracked ? tracked.filter(f => matches(globs, f)).length : null
  }
  for (const [name, a] of Object.entries(l.areas)) {
    if (a.coveredBy) continue
    if (!a.stale && a.sha) {
      if (!diffs.has(a.sha)) diffs.set(a.sha, await changedSince(h, repo, a.sha).catch(() => null))
      const all = diffs.get(a.sha)
      if (all) {
        const hit = reliesHit(a, all)
        const files = [...all.keys()].filter(x => matches(a.globs, x))
        const manifest = files.some(f => MANIFESTS.has(f.split('/').pop() ?? ''))
        if (hit) await markStale(h, home, project, name, hit)
        else if (manifest) await markStale(h, home, project, name, 'build manifest changed')
        else if (files.length > limit) {
          const n = await filesOf(a.globs)
          const lim = n === null ? limit : staleLimit(n, limit)
          if (files.length > lim) await markStale(h, home, project, name, `${files.length} files changed (limit ${lim})`)
        }
      }
    }
    const now = (await readJson<Learn>(h, learnFile(home, project), l)).areas[name]
    if (now?.stale) out.push(staleLine(name))
  }
  return out
}

export function pathsIn(text: string): string[] {
  const m = text.replace(/\bhttps?:\/\/\S+/g, ' ').match(/[\w.@-]+(?:\/[\w.@*-]+)+/g) ?? []
  return [...new Set(m.filter(Boolean))]
}

// A path the rules did not cover: log it, and three gaps for one area mark that area stale.
export async function addGap(h: Host, project: string, path: string, text = ''): Promise<string | null> {
  const home = await homeDir(h)
  const l = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  const area = Object.entries(l.areas).find(([, a]) => matches(a.globs, path))?.[0] ?? null
  await appendJsonl(h, `${projectDir(home, project)}/gaps.jsonl`, { ts: await h.clock.now(), path, area, text: text.slice(0, 300) })
  if (area) {
    const n = (await readJsonl<{ area: string | null }>(h, `${projectDir(home, project)}/gaps.jsonl`)).filter(g => g.area === area).length
    if (n >= STALE_GAPS) await markStale(h, home, project, area, `${n} gaps reported`)
  }
  return area
}

// ---- check: a dry run before any sync -----------------------------------------------------------------------------
export async function checkRules(h: Host, project: string, maxExplorers = MAX_EXPLORERS): Promise<{ lines: string[]; over: number }> {
  const home = await homeDir(h)
  const pdir = projectDir(home, project)
  const l = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  const names = (await h.fs.list(`${pdir}/rules`).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => f.name).sort()
  const lines: string[] = []
  let over = 0
  for (const n of names) {
    const t = String(await h.fs.read(`${pdir}/rules/${n}`).catch(() => ''))
    const m = ruleMetrics(t)
    const cap = capsOf(n)
    const bad = ruleProblems(n, t)
    const warn = n !== '_project.md' && !pathsOf(t).length ? ['no paths: it would load in every session'] : []
    if (bad.length) over++
    lines.push(`${n}: ${m.lines}/${cap.lines} lines, ${m.chars}/${cap.chars} chars, widest ${m.widest}${bad.length ? ` OVER: ${bad.join(', ')}` : warn.length ? ` WARN: ${warn.join(', ')}` : ' ok'}`)
  }
  if (names.length > MAX_RULE_FILES) { over++; lines.push(`${names.length} rule files (max ${MAX_RULE_FILES}): sync skips the rest`) }
  for (const [a, v] of Object.entries(l.areas)) {
    if (v.coveredBy) lines.push(`${a}: covered by ${v.coveredBy} (no rule)`)
    else if (!names.includes(ruleFile(a))) lines.push(`${a}: recorded but rules/${ruleFile(a)} is missing`)
  }
  lines.unshift(`limits: rule <= ${MAX_RULE_LINES} lines / ${MAX_RULE_CHARS} chars, _project <= ${MAX_PROJECT_LINES} lines / ${MAX_PROJECT_CHARS} chars, line <= ${MAX_LINE_WIDTH} chars, <= ${MAX_RULE_FILES} files, <= ${maxExplorers} explorers; ${names.length} rule(s), ${over} over the cap (copied anyway up to ${HARD_FACTOR}x the cap, skipped beyond; shorten them)`)
  return { lines, over }
}

// Once per plugin version (the desk's first session after an update): `lean_rules check` for every registered project, so rules a
// tightened cap touches are told to the desk instead of silently dropped, and the 0.45 `"rules": "off"` key of projects.json (nothing in 1.0
// ever read it, and a project with learned rules wants them loaded) is removed. Returns what to tell the desk; also a pane notice.
export async function rulesUpdateCheck(h: Host, version: string): Promise<string[]> {
  if ((await h.store.get('rules-check.v').catch(() => undefined)) === version) return []
  const home = await homeDir(h)
  const file = `${leanDir(home)}/projects.json`
  const projs = await readJson<Record<string, any>>(h, file, {})
  const lines: string[] = []
  const drop: string[] = []
  for (const [name, p] of Object.entries(projs && typeof projs === 'object' ? projs : {})) {
    if (!slugOk(name)) continue
    if (p && typeof p === 'object' && (p.rules === 'off' || p.rules === false)) {
      drop.push(name)
      lines.push(`${name}: the 0.45 "rules": "off" in projects.json was removed (1.0 never read it; the learned rules load)`)
    }
    const c = await checkRules(h, name).catch(() => null)
    if (c?.over) lines.push(`rules ${name}: ${c.over} over the size cap, still loaded; learn ${name} --trim or lean_rules check`)
  }
  if (drop.length) {
    // read again right before the write: a project added or removed meanwhile (a thread's tool) is not lost
    const fresh = await readJson<Record<string, any>>(h, file, {})
    let cut = 0
    for (const n of drop) if (fresh?.[n] && typeof fresh[n] === 'object' && (fresh[n].rules === 'off' || fresh[n].rules === false)) { delete fresh[n].rules; cut++ }
    if (cut && Object.keys(fresh).length) await writeJson(h, file, fresh) // (an unreadable file reads as {}: never written back over the projects)
  }
  await setNotice(h, 'rules-cap', lines.length ? lines.join(' | ') : null)
  await h.store.set('rules-check.v', version)
  return lines
}

// ---- verify: do the names a rule mentions still exist ----------------------------------------------------------------
const COMMAND_WORDS = new Set(['pnpm', 'npm', 'npx', 'yarn', 'go', 'cargo', 'make', 'git', 'docker', 'python', 'python3', 'pip', 'pytest', 'node', 'bun', 'deno', 'rg', 'ls', 'cat', 'sh', 'bash', 'true', 'false', 'null', 'none'])
export type Token = { kind: 'path' | 'symbol' | 'number'; text: string }
const trimEnd = (s: string) => s.replace(/(?:\(\))?[,.;:)]*$/, '')
// every backticked span of a body (fenced blocks are left out): a one-word span is a path, a number or a symbol;
// a span with spaces is a command, of which only path-like words count (flags, placeholders and URLs never)
export function tokensOf(body: string): Token[] {
  const seen = new Set<string>()
  const out: Token[] = []
  const add = (kind: Token['kind'], text: string) => { if (text && !seen.has(text)) { seen.add(text); out.push({ kind, text }) } }
  for (const m of body.replace(/```[\s\S]*?```/g, ' ').matchAll(/`([^`\n]+)`/g)) {
    const span = m[1]!.trim()
    if (!span || /:\/\//.test(span)) continue
    const words = span.split(/\s+/)
    if (words.length > 1) {
      for (const w0 of words) {
        const w = trimEnd(w0)
        if (w.startsWith('-') || /[<>$={}|&;"']/.test(w)) continue
        if (w.includes('/') && looksLikePath(w)) add('path', w.replace(/^\.\//, ''))
      }
      continue
    }
    const w = trimEnd(span)
    if (!w || w.startsWith('-') || /[<>${}|&;"'=\s]/.test(w) || /^[~/]/.test(w)) continue
    if (/^\d+$/.test(w)) { if (w.length >= 3) add('number', w); continue } // short numbers are in every repo: no signal
    if (looksLikePath(w)) add('path', w.replace(/^\.\//, ''))
    else if (/^[A-Za-z_][\w.:#-]{2,}$/.test(w) && !COMMAND_WORDS.has(w)) add('symbol', w)
  }
  return out
}

// does the name exist in the repo (tracked or new files; read-only: git ls-files / git grep -F)? null = could not tell
async function exists(h: Host, repo: string, t: Token, cache: Map<string, boolean | null>): Promise<boolean | null> {
  const key = `${t.kind}\0${t.text}`
  if (cache.has(key)) return cache.get(key)!
  let res: boolean | null = null
  try {
    const grep = async () => {
      // whole words (`Client` is not `ClientFactory`, `3000` is not `30001`); the synced rule copies are never a hit, excluded or not
      const r = await h.process.run(['git', 'grep', '--untracked', '--exclude-standard', '-F', '-w', '-q', '-e', t.text, '--', '.', ':(exclude).claude/rules/lean-agent', ':(exclude).claude/skills/lean-agent-*'], { cwd: repo })
      return r.exitCode === 0 ? true : r.exitCode === 1 ? false : null
    }
    if (t.kind === 'path') {
      const glob = /[*?[]/.test(t.text)
      if (!glob && t.text.includes('/') && (await h.fs.exists(`${repo.replace(/\/$/, '')}/${t.text}`).catch(() => false))) res = true
      else {
        // a glob, or a bare file name: a pathspec (`*name` matches at any depth)
        const spec = t.text.includes('/') ? t.text : `*${t.text}`
        const r = await h.process.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', spec], { cwd: repo })
        if (r.exitCode === 0 && r.stdout.trim()) res = true
        else if (r.exitCode !== 0) res = null
        else res = t.text.includes('/') ? false : await grep() // `Config.load` looks like a file name but may be a symbol
      }
    } else res = await grep()
  } catch {
    res = null
  }
  cache.set(key, res)
  return res
}

export async function verifyRules(h: Host, project: string, repo: string, only?: string): Promise<{ lines: string[]; missing: number }> {
  const home = await homeDir(h)
  const pdir = projectDir(home, project)
  const l = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  const names = (await h.fs.list(`${pdir}/rules`).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => f.name).sort().filter(n => !only || n === ruleFile(only))
  const cache = new Map<string, boolean | null>()
  const lines: string[] = []
  let budget = VERIFY_TOKENS
  let missing = 0
  const changed = new Map<string, Map<string, string> | null>()
  for (const n of names) {
    const t = String(await h.fs.read(`${pdir}/rules/${n}`).catch(() => ''))
    const area = n.replace(/\.md$/, '')
    const a = l.areas[area]
    const toks = [...(a?.relies ?? parseRelies(t))].flatMap(r => tokensOf(`\`${r}\``)) // relies-on first: they are what `stale` stands on
    for (const x of tokensOf(bodyOf(t))) if (!toks.some(y => y.text === x.text)) toks.push(x)
    const take = toks.slice(0, Math.min(VERIFY_PER_RULE, Math.max(0, budget)))
    budget -= take.length
    const gone: string[] = []
    let unknown = 0
    for (const k of take) {
      const e = await exists(h, repo, k, cache)
      if (e === false) gone.push(k.text)
      else if (e === null) unknown++
    }
    missing += gone.length
    const notes: string[] = []
    if (toks.length > take.length) notes.push(`${toks.length - take.length} not checked (limit)`)
    if (unknown) notes.push(`${unknown} could not be checked`)
    if (a?.sha && a.relies?.length) {
      if (!changed.has(a.sha)) changed.set(a.sha, await changedSince(h, repo, a.sha).catch(() => null))
      const c = changed.get(a.sha)
      const hit = c ? reliesHit(a, c) : null
      if (hit) notes.push(hit)
    }
    const head = !toks.length ? 'nothing to check' : !take.length ? 'NOT CHECKED (limit reached)' : `${take.length} checked, ${gone.length ? `missing: ${gone.map(x => `\`${x}\``).join(', ')}` : 'all found'}`
    lines.push(`${n}: ${head}${notes.length ? `; ${notes.join('; ')}` : ''}`)
  }
  lines.unshift(`verify: ${missing} name(s) missing in ${names.length} rule(s); a missing name is a candidate, judge it before dropping the bullet`)
  return { lines, missing }
}

// Which lean-agent rules loaded and which never did. Loads are logged by hooks/rules-loaded.sh (the InstructionsLoaded command
// hook) AND by the mod's own classic.InstructionsLoaded handler (logRuleLoad), into the same file; the same load seen by both
// (same file, reason, trigger and second) counts once. Counted by rule file name, `_project.md` included (it loads at session
// start, with no `paths:`), across every checkout of the project.
export const RULES_LOG = (home: string) => `${leanDir(home)}/logs/rules-loaded.jsonl`
export async function logRuleLoad(h: Host, e: any): Promise<boolean> {
  const f = typeof e?.file_path === 'string' ? e.file_path : ''
  if (!f.includes('/rules/lean-agent/')) return false
  const home = await homeDir(h)
  await appendJsonl(h, RULES_LOG(home), { ts: Math.floor((await h.clock.now()) / 1000), src: 'mod', e: { file_path: f, load_reason: e.load_reason, trigger_file_path: e.trigger_file_path, memory_type: e.memory_type } })
  return true
}
// A reported gap that reads like mechanical work (count, list, sum, find all, which files ...): a script could have done it.
const MECHANICAL = /\b(?:count(?:ing)?|how many|number of|list(?:ing)? (?:all|every|the)|find(?:ing)? all|every (?:file|place|usage|caller)|all (?:the )?(?:files|usages|occurrences|callers)|sum(?:ming)?|total(?:s|ling)?|which files|aggregat\w*|tally|enumerat\w*)\b/i
export const looksMechanical = (text: string) => MECHANICAL.test(text)

// What `stats` and `compare` may say about rule loading (rulesStats): `events` = loads recorded for this project; with none, loading is
// UNVERIFIED (the log is absent or empty) and "never loaded" proves nothing; `never` lists the rules with no load, `neverConfirmed` only
// those a recorded load came after (the log has an event from after the rule was written): the only ones `learn --trim` may be told about.
export type RulesStats = { loaded: Record<string, number>; never: string[]; neverConfirmed: string[]; events: number; verified: boolean; logRows: number; scriptCandidates: string[]; overCap: string[] }
export const unverifiedLine = (project: string, s: Pick<RulesStats, 'logRows'>) => `no rule load has ever been recorded${s.logRows ? ` for ${project}` : ' (log absent)'}: loading unverified`

// The load log: `fs.read` rejects a file over 4 MiB (readJsonl then gives nothing, which would read as "log absent"): the newest 3 MB come
// from `tail` instead (its first line is cut and dropped); a log that is really absent still gives nothing. `since` (ms): the time of the
// oldest row kept when the log was cut (0 = the whole log was read): a rule written before it cannot be called "never loaded".
const LOG_TAIL_BYTES = 3_000_000
async function readLoadLog<T extends { ts?: number }>(h: Host, path: string): Promise<{ rows: T[]; since: number }> {
  const rows = await readJsonl<T>(h, path)
  if (rows.length) return { rows, since: 0 }
  const size = await fileSize(h, path)
  if (!size) return { rows: [], since: 0 }
  const from = Math.max(1, size - LOG_TAIL_BYTES + 1)
  const r = await h.process.run(['tail', '-c', `+${from}`, path]).catch(() => null)
  if (!r || r.exitCode !== 0 || !r.stdout.trim()) return { rows: [], since: 0 }
  const out: T[] = []
  for (const line of r.stdout.split('\n').slice(from > 1 ? 1 : 0)) { // (a cut first line is dropped; a whole file keeps it)
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      /* a torn or damaged line is skipped */
    }
  }
  return { rows: out, since: from > 1 ? (typeof out[0]?.ts === 'number' ? out[0].ts * 1000 : Number.MAX_SAFE_INTEGER) : 0 } // (no readable first row: nothing is confirmed)
}

export async function rulesStats(h: Host, project: string): Promise<RulesStats> {
  const home = await homeDir(h)
  type Row = { ts?: number; rule?: string; project?: string; sha?: string; session?: string; agent?: string; e?: { file_path?: string; load_reason?: string; trigger_file_path?: string } }
  const { rows: log, since } = await readLoadLog<Row>(h, RULES_LOG(home))
  const loaded: Record<string, number> = {}
  const seen = new Set<string>()
  let lastEvent = 0
  // Only this project's loads: a rule loaded from one of its checkouts (the registered folder and its worktrees). Two projects often
  // have a rule of the same name (`api.md`): counted by name alone, one would hide the other's never-loaded one. A project without
  // a registered folder cannot be told apart, so every load counts, as before.
  const repo = (await readJson<Record<string, { path?: string }>>(h, `${leanDir(home)}/projects.json`, {}))?.[project]?.path
  const roots = typeof repo === 'string' && repo.startsWith('/') ? (await checkoutsOf(h, project, repo)).map(p => `${p}/.claude/rules/lean-agent/`) : null
  for (const r of log) {
    if (typeof r.rule === 'string' && typeof r.project === 'string') { // the mod's own loader (ruleload.ts): counted per project, no path to match
      if (r.project !== project) continue
      const key = `${r.rule}\0${r.sha ?? ''}\0${r.session ?? ''}\0${r.agent ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      loaded[r.rule] = (loaded[r.rule] ?? 0) + 1
      lastEvent = Math.max(lastEvent, (r.ts ?? 0) * 1000)
      continue
    }
    const f = r.e?.file_path ?? ''
    const i = f.indexOf('/rules/lean-agent/')
    if (i < 0) continue
    if (roots && !roots.some(p => f.startsWith(p))) continue
    const key = `${f}\0${r.e?.load_reason ?? ''}\0${r.e?.trigger_file_path ?? ''}\0${r.ts ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    loaded[f.slice(i + 18)] = (loaded[f.slice(i + 18)] ?? 0) + 1
    lastEvent = Math.max(lastEvent, (r.ts ?? 0) * 1000)
  }
  const have = (await h.fs.list(`${projectDir(home, project)}/rules`).catch(() => [])).map(f => f.name).filter(n => n.endsWith('.md')) // _project.md included: it is listed when it never loaded
  const learn = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  const overCap: string[] = []
  for (const n of have) {
    const t = await h.fs.read(`${projectDir(home, project)}/rules/${n}`).then(String).catch(() => '')
    const bad = ruleProblems(n, t)
    if (bad.length) overCap.push(`${n}: ${bad.join(', ')}`)
  }
  // gaps whose text looks mechanical are candidates for a script (lean_script propose); one line each, repeats counted once
  const seenGap = new Set<string>()
  const scriptCandidates: string[] = []
  for (const g of await readJsonl<{ path?: string; text?: string }>(h, `${projectDir(home, project)}/gaps.jsonl`)) {
    const t = String(g?.text ?? '').replace(/\s+/g, ' ').trim()
    const key = t.toLowerCase()
    if (t && looksMechanical(t) && !seenGap.has(key) && scriptCandidates.length < 10) {
      seenGap.add(key)
      scriptCandidates.push(`${g.path ? `${g.path}: ` : ''}${t.slice(0, 160)}`)
    }
  }
  const never = have.filter(n => !loaded[n])
  const events = Object.values(loaded).reduce((s, c) => s + c, 0)
  // a rule is only "never loaded" when a load was recorded after it was written (a rule learned later than the last event had no chance)
  // (a log read from its tail only covers the time since `since`: a rule written before that may have loaded in the part not read)
  const neverConfirmed = never.filter(n => {
    const at = learn.areas?.[n.replace(/\.md$/, '')]?.at ?? 0
    return !!lastEvent && at <= lastEvent && (!since || at >= since)
  })
  return { loaded, never, neverConfirmed, events, verified: events > 0, logRows: log.length, scriptCandidates, overCap }
}
