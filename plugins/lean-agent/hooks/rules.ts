// Learned project rules (design 2.8). The source of truth is ~/.lean-agent/<project>/rules/*.md; Claude Code only loads
// real files, so they are COPIED to <repo>/.claude/rules/lean-agent/ (symlinked dirs do not load) and kept out of git
// through the repo's shared .git/info/exclude. Recipes become skills the same way (skills/<n>/SKILL.md ->
// .claude/skills/lean-agent-<n>/SKILL.md).
import { appendJsonl, atomicWrite, homeDir, leanDir, readJson, readJsonl, writeJson } from './state'
import type { Host } from './state'

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
// what makes sync skip a rule (empty = within every cap)
export function ruleProblems(file: string, t: string): string[] {
  const m = ruleMetrics(t)
  const cap = capsOf(file)
  const out: string[] = []
  if (m.lines > cap.lines) out.push(`more than ${cap.lines} lines (${m.lines})`)
  if (m.chars > cap.chars) out.push(`more than ${cap.chars} characters (${m.chars})`)
  if (m.widest > MAX_LINE_WIDTH) out.push(`a line is ${m.widest} characters wide (max ${MAX_LINE_WIDTH})`)
  return out
}
// `paths:` globs of a rule's frontmatter (a YAML list, or a single value); [] = none
export function pathsOf(t: string): string[] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t)?.[1] ?? ''
  const m = /^paths:[ \t]*(.*)\r?\n?((?:[ \t]+-[^\n]*\n?)*)/m.exec(fm)
  if (!m) return []
  const unq = (x: string) => x.trim().replace(/^["']|["']$/g, '')
  const items = m[2]!.split('\n').map(l => /^\s*-\s*(.*)$/.exec(l)?.[1]).filter((x): x is string => x !== undefined).map(unq)
  if (m[1]!.trim()) items.push(...m[1]!.split(',').map(unq))
  return items.filter(Boolean)
}
// the footer's `relies-on:` list (symbols and files; the last field of the footer comment)
export function parseRelies(t: string): string[] {
  const f = /<!--\s*lean-agent:([\s\S]*?)-->/.exec(t)?.[1] ?? ''
  const m = /relies-on:\s*([\s\S]*)$/.exec(f)
  return m ? m[1]!.split(',').map(x => x.trim()).filter(Boolean) : []
}
const looksLikePath = (s: string) => !/\s/.test(s) && !/[<>$]/.test(s) && (s.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(s)) && !/^(https?:|\/|~)/.test(s)
// the footer gets `relies-on:` last (an existing one is replaced); no footer: one is made
export function withRelies(t: string, relies: string[], sha: string, date: string): string {
  const list = relies.join(', ')
  const re = /<!--\s*lean-agent:([\s\S]*?)-->/
  const m = re.exec(t)
  if (!m) return t.replace(/\n*$/, '\n') + `<!-- lean-agent: learned ${sha.slice(0, 8)} ${date}${list ? ` relies-on: ${list}` : ''} -->\n`
  const inner = m[1]!.replace(/\s*relies-on:[\s\S]*$/, '').trimEnd()
  return t.replace(re, `<!-- lean-agent:${inner}${list ? ` relies-on: ${list}` : ''} -->`)
}

export type SyncOut = { copied: string[]; removed: string[]; skipped: string[]; excluded: boolean; exclude?: 'ok' | 'failed' | 'n/a' }

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
  const out: SyncOut = { copied: [], removed: [], skipped: [], excluded: false }
  const pdir = projectDir(home, project)
  const rules = new Map<string, string>()
  const names = (await h.fs.list(`${pdir}/rules`).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => f.name).sort()
  for (const n of names) {
    if (rules.size >= MAX_RULE_FILES) { out.skipped.push(`${n}: more than ${MAX_RULE_FILES} rule files`); continue }
    const t = String(await h.fs.read(`${pdir}/rules/${n}`))
    const bad = ruleProblems(n, t)
    if (bad.length) { out.skipped.push(`${n}: ${bad.join(', ')}`); continue }
    rules.set(n, t)
  }
  const recipes: { name: string; text: string }[] = []
  for (const d of (await h.fs.list(`${pdir}/skills`).catch(() => [])).filter(f => f.kind === 'dir')) {
    const t = await h.fs.read(`${pdir}/skills/${d.name}/SKILL.md`).catch(() => null)
    if (t !== null && slugOk(d.name)) recipes.push({ name: `lean-agent-${d.name}`, text: String(t) })
  }
  // git-exclude first: nothing we copy is ever visible to git, not even for a moment
  if (rules.size || recipes.length) out.excluded = await exclude(h, repo)
  await mirror(h, rules, `${repo}/.claude/rules/lean-agent`, n => n.endsWith('.md'), out)
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
  `${path}: copied ${o.copied.length}, removed ${o.removed.length}, skipped ${o.skipped.length}, exclude ${o.exclude ?? (o.excluded ? 'ok' : 'n/a')}`

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
    const r = await h.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: repo })
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

export type SyncAll = { lines: string[]; detail: { path: string; out: SyncOut | null; error?: string }[] }
// sync one checkout, or with `all` every checkout of the project; `lines` is what the tool answers
export async function syncAll(h: Host, project: string, repo: string, all: boolean): Promise<SyncAll> {
  const paths = all ? await checkoutsOf(h, project, repo) : [repo]
  const detail: SyncAll['detail'] = []
  const lines: string[] = []
  const skipped = new Set<string>()
  for (const p of paths) {
    if (p !== repo && !(await h.fs.exists(p).catch(() => false))) { detail.push({ path: p, out: null, error: 'missing' }); lines.push(`${p}: missing, skipped`); continue }
    try {
      const o = await syncRules(h, project, p)
      detail.push({ path: p, out: o })
      lines.push(syncSummary(p, o))
      for (const s of o.skipped) skipped.add(s)
    } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 120)
      detail.push({ path: p, out: null, error })
      lines.push(`${p}: failed: ${error}`)
    }
  }
  if (skipped.size) lines.push(`not synced (shorten these): ${[...skipped].join('; ')}`)
  return { lines, detail }
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
export async function recordRule(h: Host, project: string, area: string, a: RecordIn): Promise<string> {
  const home = await homeDir(h)
  const notes: string[] = []
  const file = `${projectDir(home, project)}/rules/${ruleFile(area)}`
  let lines = 0
  let chars: number | undefined
  let relies = (a.relies ?? []).map(x => x.trim()).filter(x => x && !/[\n]|-->/.test(x)).map(x => x.slice(0, 120))
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
      if (bad.length) notes.push(`WARNING over the cap, sync will skip it: ${bad.join(', ')}`)
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
  for (const r of a.relies ?? []) {
    if (!looksLikePath(r)) continue
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
  lines.unshift(`limits: rule <= ${MAX_RULE_LINES} lines / ${MAX_RULE_CHARS} chars, _project <= ${MAX_PROJECT_LINES} lines / ${MAX_PROJECT_CHARS} chars, line <= ${MAX_LINE_WIDTH} chars, <= ${MAX_RULE_FILES} files, <= ${maxExplorers} explorers; ${names.length} rule(s), ${over} over the cap (sync would skip them)`)
  return { lines, over }
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
    if (/^\d+$/.test(w)) { if (w.length >= 2) add('number', w); continue }
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
      const r = await h.process.run(['git', 'grep', '--untracked', '-F', '-q', '-e', t.text], { cwd: repo })
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
    const toks = tokensOf(bodyOf(t))
    for (const r of a?.relies ?? parseRelies(t)) for (const x of tokensOf(`\`${r}\``)) if (!toks.some(y => y.text === x.text)) toks.push(x)
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
    lines.push(`${n}: ${take.length} checked, ${gone.length ? `missing: ${gone.map(x => `\`${x}\``).join(', ')}` : 'all found'}${notes.length ? `; ${notes.join('; ')}` : ''}`)
  }
  lines.unshift(`verify: ${missing} name(s) missing in ${names.length} rule(s); a missing name is a candidate, judge it before dropping the bullet`)
  return { lines, missing }
}

// Which lean-agent rules loaded (hooks/rules-loaded.sh logs one line per load) and which never did.
export async function rulesStats(h: Host, project: string): Promise<{ loaded: Record<string, number>; never: string[] }> {
  const home = await homeDir(h)
  const log = await readJsonl<{ e?: { file_path?: string } }>(h, `${leanDir(home)}/logs/rules-loaded.jsonl`)
  const loaded: Record<string, number> = {}
  for (const r of log) {
    const f = r.e?.file_path ?? ''
    const i = f.indexOf('/rules/lean-agent/')
    if (i >= 0) loaded[f.slice(i + 18)] = (loaded[f.slice(i + 18)] ?? 0) + 1
  }
  const have = (await h.fs.list(`${projectDir(home, project)}/rules`).catch(() => [])).map(f => f.name).filter(n => n.endsWith('.md') && n !== '_project.md')
  return { loaded, never: have.filter(n => !loaded[n]) }
}
