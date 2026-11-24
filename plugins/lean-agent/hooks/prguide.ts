// 1.0.31: a repo's PR guidelines, read by script (no model): the PR template (Azure DevOps and GitHub places), CONTRIBUTING, CODEOWNERS and the title convention of the last
// merged PRs. Read-only and size-capped; the compact record is cached per project in the mod store under the hash of the source files (re-read only when they change).
// `lintPr` refuses a PR text that does not follow it, naming the exact missing parts. Pure parsing + `readGuide` over an injected Host (a spec passes a fake one).
import type { Host } from './state'
import { sha256 } from './sha'

export const FILE_MAX = 20_000 // characters read per source file
export const SOURCES_MAX = 12
export type TitleStyle = { kind: 'conventional' | 'workitem' | 'none'; pattern: string; ci: boolean; example: string }
export type Guide = {
  sources: string[] // repo-relative files read
  headings: string[] // the template's headings, in order
  required: string[] // the headings that are not marked optional
  title: TitleStyle
  workitems: boolean // the recent history links work items (AB#123, PROJ-123, "Related work items")
  owners: string[] // CODEOWNERS handles
  reviewers: string[] // the handles of the `*` rule: the default reviewers
  contributing: string[] // CONTRIBUTING files found (the thread reads them when it needs the rules)
  hash: string
}
const dec = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
export const hashText = (s: string): string => dec(sha256(new TextEncoder().encode(s)))

// ---- where the files are ---------------------------------------------------------------------------------------------------------------------
const TEMPLATE_DIRS: { dir: string; re: RegExp }[] = [
  { dir: '.azuredevops', re: /^pull_request_template.*\.md$/i },
  { dir: '.azuredevops/pull_request_template', re: /\.md$/i },
  { dir: '.github', re: /^pull_request_template\.md$/i },
  { dir: '.github/PULL_REQUEST_TEMPLATE', re: /\.md$/i },
  { dir: 'docs', re: /^pull_request_template\.md$/i },
  { dir: '', re: /^pull_request_template\.md$/i },
]
const CONTRIB_DIRS: { dir: string; re: RegExp }[] = [
  { dir: '', re: /^contributing([._-].*)?$/i },
  { dir: '.github', re: /^contributing([._-].*)?$/i },
  { dir: 'docs', re: /^contributing([._-].*)?$/i },
]
const OWNER_FILES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', '.azuredevops/CODEOWNERS']
const join = (a: string, b: string): string => (a ? `${a}/${b}` : b)

async function names(h: Host, root: string, dir: string, re: RegExp): Promise<string[]> {
  try {
    const l = await h.fs.list(dir ? `${root}/${dir}` : root)
    return l.filter(e => e.kind !== 'dir' && re.test(e.name)).map(e => join(dir, e.name)).sort()
  } catch {
    return []
  }
}
async function readCapped(h: Host, root: string, rel: string): Promise<string | null> {
  try {
    const st = await h.fs.stat(`${root}/${rel}`)
    if (st.kind !== 'file') return null
    const t = String((await h.fs.read(`${root}/${rel}`)) ?? '')
    return t.length > FILE_MAX ? t.slice(0, FILE_MAX) : t
  } catch {
    return null
  }
}

// ---- parsing ---------------------------------------------------------------------------------------------------------------------------------
const stripNoise = (t: string): string => t.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '')
const clean = (s: string): string => s.replace(/[*_`:]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
type Section = { level: number; text: string; body: string }
export function sectionsOf(t: string): Section[] {
  const out: Section[] = []
  for (const line of stripNoise(t).split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) out.push({ level: m[1]!.length, text: m[2]!.replace(/[*_`]+/g, '').trim(), body: '' })
    else if (out.length) out[out.length - 1]!.body += `${line}\n`
  }
  return out
}
// the template's headings; a lone top-level heading above deeper ones is the template's title, not a section
export function templateHeadings(t: string): { headings: string[]; required: string[] } {
  let s = sectionsOf(t)
  const min = Math.min(...s.map(x => x.level))
  if (s.length > 1 && s.filter(x => x.level === min).length === 1 && s[0]!.level === min) s = s.slice(1)
  return { headings: s.map(x => x.text), required: s.filter(x => !/\boptional\b/i.test(x.text)).map(x => x.text) }
}
const OWNER = /^(@[\w.-]+(\/[\w.-]+)?|[\w.+-]+@[\w.-]+\.\w+)$/ // @user, @org/team or an email
export function parseOwners(t: string): { owners: string[]; reviewers: string[] } {
  const owners = new Set<string>()
  let reviewers: string[] = []
  for (const raw of t.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const [pat, ...who] = line.split(/\s+/)
    const handles = who.filter(w => OWNER.test(w))
    for (const w of handles) owners.add(w)
    if (pat === '*') reviewers = handles
  }
  return { owners: [...owners].slice(0, 20), reviewers: reviewers.slice(0, 10) }
}

// ---- the title convention of the recent merged PRs --------------------------------------------------------------------------------------------
const STYLES: { kind: 'conventional' | 'workitem'; re: RegExp; ci: boolean; example: string }[] = [
  { kind: 'conventional', re: /^(feat|fix|docs|style|refactor|perf|test|tests|build|ci|chore|revert)(\([^)]+\))?!?: \S/i, ci: true, example: 'feat(api): add the export endpoint' },
  { kind: 'workitem', re: /^\[?(AB#|#)?\d{1,8}\]?[:\s-]+\S/, ci: false, example: 'AB#1234 add the export endpoint' },
  { kind: 'workitem', re: /^\[?[A-Z][A-Z0-9]{1,9}-\d+\]?[:\s-]+\S/, ci: false, example: 'PROJ-123: add the export endpoint' },
]
// a subject of a merge as a PR title: "Merged PR 12: title" (Azure DevOps) and "title (#12)" (a squash merge); a plain merge commit names no title
export function prTitleOf(subject: string): string | null {
  const s = subject.trim()
  if (!s || /^merge (pull request|branch|remote-tracking|tag)\b/i.test(s)) return null
  return s.replace(/^merged pr \d+:\s*/i, '').replace(/\s*\(#\d+\)\s*$/, '').trim() || null
}
export function titleStyle(titles: string[]): TitleStyle {
  const none: TitleStyle = { kind: 'none', pattern: '', ci: false, example: '' }
  if (titles.length < 5) return none
  let best: { n: number; style: (typeof STYLES)[number]; example: string } | null = null
  for (const style of STYLES) {
    const hits = titles.filter(t => style.re.test(t))
    if (hits.length >= Math.ceil(titles.length * 0.6) && (!best || hits.length > best.n)) best = { n: hits.length, style, example: hits[0]!.slice(0, 80) }
  }
  return best ? { kind: best.style.kind, pattern: best.style.re.source, ci: best.style.ci, example: best.example } : none
}
const WI_REF = /\bAB#\d+|\b[A-Z][A-Z0-9]{1,9}-\d+\b|\brelated work items?\b|\bwork item #?\d+/i
export const mentionsWorkItem = (t: string): boolean => WI_REF.test(t)

// ---- the record ------------------------------------------------------------------------------------------------------------------------------
type Read = { files: Record<string, string>; contributing: string[] }
async function readSources(h: Host, root: string): Promise<Read> {
  const files: Record<string, string> = {}
  const paths: string[] = []
  for (const { dir, re } of TEMPLATE_DIRS) paths.push(...(await names(h, root, dir, re)))
  const tpl = [...new Set(paths)].slice(0, 4)
  const contributing: string[] = []
  for (const { dir, re } of CONTRIB_DIRS) contributing.push(...(await names(h, root, dir, re)))
  const owners = (await Promise.all(OWNER_FILES.map(async p => ((await readCapped(h, root, p)) !== null ? p : null)))).filter((p): p is string => !!p)
  for (const p of [...tpl, ...owners, ...[...new Set(contributing)].slice(0, 3)].slice(0, SOURCES_MAX)) {
    const t = await readCapped(h, root, p)
    if (t !== null) files[p] = t
  }
  return { files, contributing: [...new Set(contributing)] }
}
const git = async (h: Host, dir: string, ...a: string[]): Promise<string | null> => {
  const r = await h.process.run(['git', '-C', dir, ...a], { timeoutMs: 15_000 }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout : null
}
// the branch the recent merges are read from: the remote's default, else main / master
async function mainRef(h: Host, dir: string): Promise<string | null> {
  const head = ((await git(h, dir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')) ?? '').trim()
  for (const ref of [head, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)) if ((await git(h, dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) !== null) return ref
  return null
}
export async function historyOf(h: Host, dir: string): Promise<{ titles: string[]; workitems: boolean }> {
  const ref = await mainRef(h, dir)
  const log = ref ? await git(h, dir, 'log', '--first-parent', '-n', '20', '--format=%s%x1f%b%x1e', ref) : null
  if (!log) return { titles: [], workitems: false }
  const rows = log.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => r.split('\x1f'))
  const titles = rows.map(r => prTitleOf(r[0] ?? '')).filter((t): t is string => !!t)
  const linked = rows.filter(r => mentionsWorkItem(r.join(' '))).length
  return { titles, workitems: rows.length >= 5 && linked >= Math.ceil(rows.length * 0.4) }
}

const cacheKey = (project: string) => `prguide.${project}`
// the guide of a repo folder: the source files are read (capped), their hash decides whether the cached record is still the one; the history is read only on a miss
export async function guideOf(h: Host, project: string, dir: string): Promise<{ guide: Guide; cached: boolean }> {
  const src = await readSources(h, dir)
  const hash = hashText(Object.entries(src.files).sort(([a], [b]) => a.localeCompare(b)).map(([p, t]) => `${p}\n${t}`).join('\n\u0000\n'))
  const hit = (await h.store.get(cacheKey(project)).catch(() => null)) as { guide?: Guide } | null
  if (hit?.guide && hit.guide.hash === hash) return { guide: hit.guide, cached: true }
  const tplPath = Object.keys(src.files).find(p => p.toLowerCase().includes('pull_request_template'))
  const heads = tplPath ? templateHeadings(src.files[tplPath]!) : { headings: [], required: [] }
  const ownerPath = Object.keys(src.files).find(p => p.split('/').pop() === 'CODEOWNERS')
  const own = ownerPath ? parseOwners(src.files[ownerPath]!) : { owners: [], reviewers: [] }
  const hist = await historyOf(h, dir)
  const guide: Guide = { sources: Object.keys(src.files), ...heads, title: titleStyle(hist.titles), workitems: hist.workitems, ...own, contributing: src.contributing, hash }
  await h.store.set(cacheKey(project), { guide, ts: await h.clock.now() }).catch(() => undefined)
  return { guide, cached: false }
}

// ---- the lint: the exact missing parts -------------------------------------------------------------------------------------------------------
const PLACEHOLDER = /^(todo|tbd|\.\.\.|…|-|—|<[^>]*>)$/i
export function sectionFilled(body: string, heading: string): boolean {
  const want = clean(heading)
  const s = sectionsOf(body).find(x => clean(x.text) === want)
  if (!s) return false
  const text = s.body.replace(/^\s*[-*]?\s*\[[ xX]\]\s*/gm, '').replace(/\s+/g, ' ').trim()
  return /[\p{L}\p{N}]/u.test(text) && !PLACEHOLDER.test(text)
}
export type PrText = { title: string; body: string }
export function lintPr(g: Guide, t: PrText, o: { evidence?: string | null } = {}): string[] {
  const missing: string[] = []
  if (g.title.kind !== 'none' && !new RegExp(g.title.pattern, g.title.ci ? 'i' : '').test(t.title.trim())) missing.push(`the title does not follow the repo's ${g.title.kind === 'conventional' ? 'conventional-commit' : 'work-item-prefix'} pattern (like "${g.title.example}")`)
  for (const h of g.required) if (!sectionFilled(t.body, h)) missing.push(`the description section "${h}" is missing or empty (the PR template has it)`)
  if (g.workitems && !mentionsWorkItem(`${t.title}\n${t.body}`)) missing.push('no work item is linked (the repo\'s recent merges link one: AB#<id> or the work item key in the title or description)')
  if (o.evidence && !/\b(tested|tests?|passed|green|lean_run)\b/i.test(t.body.replace(/^#{1,6}\s.*$/gm, ''))) missing.push(`no test evidence line in the description (the last run: ${o.evidence})`)
  return missing
}
export const guideText = (g: Guide, cached = false): string =>
  [
    `PR guidelines (${g.sources.length ? g.sources.join(', ') : 'no template, owners or contributing file found'}${cached ? '; cached, the files did not change' : ''}):`,
    g.headings.length ? `description sections: ${g.headings.join(' | ')}` : 'description: no template (say what changed, why and how it was tested)',
    g.title.kind === 'none' ? 'title: no convention found in the last merged PRs' : `title: ${g.title.kind === 'conventional' ? 'conventional commit' : 'work item prefix'}, like "${g.title.example}"`,
    g.workitems ? 'work item: link one (AB#<id> or the key in the title or description)' : '',
    g.owners.length ? `owners: ${g.owners.join(' ')}${g.reviewers.length ? `; default reviewers: ${g.reviewers.join(' ')}` : ''}` : '',
    g.contributing.length ? `rules to read when unsure: ${g.contributing.join(', ')}` : '',
  ].filter(Boolean).join('\n')
