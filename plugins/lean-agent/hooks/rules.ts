// Learned project rules (design 2.8). The source of truth is ~/.lean-agent/<project>/rules/*.md; Claude Code only loads
// real files, so they are COPIED to <repo>/.claude/rules/lean-agent/ (symlinked dirs do not load) and kept out of git
// through the repo's shared .git/info/exclude. Recipes become skills the same way (skills/<n>/SKILL.md ->
// .claude/skills/lean-agent-<n>/SKILL.md).
import { appendJsonl, atomicWrite, homeDir, leanDir, readJson, readJsonl, writeJson } from './state'
import type { Host } from './state'
import { sha256 } from './reviews'

const hashHex = (t: string) => Array.from(sha256(new TextEncoder().encode(t)), x => x.toString(16).padStart(2, '0')).join('')

export const MAX_RULE_FILES = 40
export const MAX_RULE_LINES = 25
export const MAX_PROJECT_LINES = 10
export const STALE_FILES = 15
export const STALE_GAPS = 3
export const EXCLUDES = ['.claude/rules/lean-agent/', '.claude/skills/lean-agent-*/']
const MANIFESTS = new Set(['package.json', 'go.mod', 'go.work', 'Cargo.toml', 'pyproject.toml', 'pnpm-workspace.yaml', 'pom.xml', 'build.gradle'])

export type Area = { globs: string[]; sha: string; lines: number; stale?: string; gaps?: number; at?: number }
export type Learn = { sha: string; areas: Record<string, Area> }

export const projectDir = (home: string, project: string) => `${leanDir(home)}/${project}`
const learnFile = (home: string, project: string) => `${projectDir(home, project)}/learn.json`
export const slugOk = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)

export function globRe(g: string): RegExp {
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
// the body of a rule: frontmatter and the lean-agent footer do not count against the cap
function bodyLines(t: string): number {
  return lineCount(t.replace(/^---\n[\s\S]*?\n---\n/, ''))
}

export type SyncOut = { copied: string[]; removed: string[]; skipped: string[]; excluded: boolean }

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
    const cap = n === '_project.md' ? MAX_PROJECT_LINES : MAX_RULE_LINES
    if (bodyLines(t) > cap) { out.skipped.push(`${n}: more than ${cap} lines`); continue }
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
      // only a script that is still adopted and still the audited text (a retired one, or one edited in place, ships no skill)
      const meta = await readJson<{ status?: string; file?: string; sha256?: string } | null>(h, `${base}/${d.name}/meta.json`, null)
      const code = meta?.file ? await h.fs.read(`${base}/${d.name}/${meta.file}`).catch(() => null) : null
      if (meta?.status !== 'adopted' || typeof code !== 'string' || hashHex(code) !== meta.sha256) continue
      const t = await h.fs.read(`${base}/${d.name}/SKILL.md`).catch(() => null)
      const name = `lean-agent-script-${d.name}`
      if (t !== null && slugOk(d.name) && !recipes.some(r => r.name === name)) recipes.push({ name, text: String(t) })
    }
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
  if (!out.excluded && out.removed.length) out.excluded = await exclude(h, repo)
  return out
}

export async function recordLearn(h: Host, project: string, area: string, a: { globs: string[]; sha: string; lines: number }): Promise<void> {
  const home = await homeDir(h)
  const l = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  l.areas[area] = { globs: a.globs, sha: a.sha, lines: a.lines, at: await h.clock.now() }
  l.sha = a.sha
  await writeJson(h, learnFile(home, project), l)
}

async function markStale(h: Host, home: string, project: string, area: string, why: string): Promise<void> {
  const l = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  if (!l.areas[area] || l.areas[area].stale === why) return
  l.areas[area].stale = why
  await writeJson(h, learnFile(home, project), l)
}

export const staleLine = (area: string) => `rules for ${area} are stale: re-learn when you touch it`

// Areas whose globs changed in more than `limit` files since they were learned, or whose manifest changed.
export async function checkStale(h: Host, project: string, repo: string, limit = STALE_FILES): Promise<string[]> {
  const home = await homeDir(h)
  const l = await readJson<Learn>(h, learnFile(home, project), { sha: '', areas: {} })
  const out: string[] = []
  for (const [name, a] of Object.entries(l.areas)) {
    if (!a.stale && a.sha) {
      const r = await h.process.run(['git', 'diff', '--name-only', `${a.sha}..HEAD`], { cwd: repo })
      if (r.exitCode === 0) {
        const files = r.stdout.split('\n').map(x => x.trim()).filter(x => matches(a.globs, x))
        const manifest = files.some(f => MANIFESTS.has(f.split('/').pop() ?? ''))
        if (files.length > limit) await markStale(h, home, project, name, `${files.length} files changed`)
        else if (manifest) await markStale(h, home, project, name, 'build manifest changed')
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
