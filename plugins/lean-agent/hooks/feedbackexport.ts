// Feedback export, done by the mod (no model, no network, nothing is ever posted): ONE markdown file,
// ~/.lean-agent/feedback-export/<YYYY-MM-DD-HHMM>.md, with the environment, the doctor's problem lines, the drafts not exported
// before, the LEAN-FEEDBACK texts and guard refusals since the last export (grouped, de-duplicated, with counts), the script
// candidates for lean-agent core and the blocked thread reports. Everything is anonymised by code first (home dir, user and project
// names, emails, URLs, shas, ticket numbers, secrets) and the file is NOT written when a known private string survived.
import { appendJsonl, atomicWrite, homeDir, leanDir, mkdirp, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { check } from './doctor'
import { allScripts } from './scripts'

export const EXPORT_CAP = 40 * 1024
const exportDir = (home: string) => `${leanDir(home)}/feedback-export`
export const REPO_URL = /^https:\/\/github\.com\/mcmadsen\/lean-agent(?:[/?#].*)?$/
const GENERIC_USERS = new Set(['root', 'user', 'users', 'admin', 'home', 'ubuntu', 'runner', 'claude'])
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- anonymisation ------------------------------------------------------------------------------------------------------------
// credential and key shapes (the bare long-token rule runs last, after hashes)
const SECRET_RES: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\b((?:password|passwd|secret|token|api[_-]?key)\w*["']?\s*[:=]\s*["']?)[^\s"']{6,}/gi,
]
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g
const URL_RE = /https?:\/\/[^\s)>\]"'`]+/g
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const HEX_RE = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g
const ID_WORD_RE = /\b(PR|pull request|issue|ticket|bug|story|task|case)(\s*#?\s*)\d+\b/gi
const ID_KEY_RE = /\b(?!(?:UTF|SHA|ISO|MD|AES|RSA|TLS|SSL|HTTP|ECMA|RFC)-)[A-Z][A-Z0-9]{1,9}-\d+\b/g // a tracker key like ABC-123, not UTF-8
const LABEL_RE = /(project-(?:[A-Z]|\d+)\b)/
const AZURE_PATH = /dev\.azure\.com\/[^/\s]+(?:\/[^/\s]+)?/g
const AZURE_HOST = /\b([A-Za-z0-9-]+)\.visualstudio\.com/g
const USER_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+(\/|(?![A-Za-z0-9._-]))/g

export type Anonymiser = { anonymise: (t: string) => string; missed: (t: string) => string[] }

const label = (n: number) => (n < 26 ? `project-${String.fromCharCode(65 + n)}` : `project-${n + 1}`)

// project names -> project-A, project-B ... through a stable map kept locally (feedback-export/projects.map.json, never exported)
async function projectNames(h: Host, home: string): Promise<string[]> {
  const names: string[] = []
  const add = (n: unknown) => {
    if (typeof n === 'string' && n.trim() && !names.includes(n.trim())) names.push(n.trim())
  }
  for (const k of Object.keys((await readJson<Record<string, unknown>>(h, `${leanDir(home)}/projects.json`, {})) ?? {})) add(k)
  for (const e of await h.fs.list(threadsDir(home)).catch(() => [])) add((await readJson<{ project?: string }>(h, `${threadsDir(home)}/${e.name}/thread.json`, {})).project)
  const file = `${exportDir(home)}/projects.map.json`
  const map = await readJson<Record<string, string>>(h, file, {})
  let changed = false
  for (const n of names) {
    if (!map[n]) {
      map[n] = label(Object.keys(map).length)
      changed = true
    }
  }
  if (changed) await writeJson(h, file, map)
  return Object.keys(map).sort((a, b) => b.length - a.length)
}

export async function makeAnonymiser(h: Host): Promise<Anonymiser> {
  const home = await homeDir(h)
  const map = await (async () => {
    await projectNames(h, home)
    return readJson<Record<string, string>>(h, `${exportDir(home)}/projects.map.json`, {})
  })()
  const projects = Object.keys(map).sort((a, b) => b.length - a.length)
  const user = home.split('/').pop() ?? ''
  const userOk = user.length >= 4 && !GENERIC_USERS.has(user.toLowerCase())
  const homeRe = home.length > 1 ? new RegExp(`${esc(home)}(?![A-Za-z0-9._-])`, 'g') : null
  const nameRe = (n: string) => new RegExp(`(?<![A-Za-z0-9])${esc(n)}(?![A-Za-z0-9])`, 'gi') // a name as a word (my-proj-api and proj/x match, projection does not)
  const hidden = (t: string) => t.replace(/project-(?:[A-Z]|\d+)\b/g, '') // our own labels are not leaks

  const anonymise = (input: string): string => {
    let t = input
    for (const re of SECRET_RES) t = t.replace(re, (m, g1) => (typeof g1 === 'string' ? `${g1}<secret>` : '<secret>'))
    t = t.replace(URL_RE, u => {
      const core = u.replace(/[.,;:!?]+$/, '') // sentence punctuation after a URL is not part of it
      return (REPO_URL.test(core) ? core : '<url>') + u.slice(core.length)
    })
    // what is left of azure hosts (written without a scheme): the organisation and project segments go
    t = t.replace(AZURE_PATH, 'dev.azure.com/<org>/<org>').replace(AZURE_HOST, '<org>.visualstudio.com')
    t = t.replace(EMAIL_RE, '<email>')
    if (homeRe) t = t.replace(homeRe, '~')
    t = t.replace(USER_PATH, '~$1')
    if (userOk) t = t.replace(new RegExp(`(?<![A-Za-z0-9])${esc(user)}(?![A-Za-z0-9])`, 'g'), '<user>') // zeldaquux-laptop yes, zeldaquuxbox is left for the check
    // projects: names become a private token first, then their labels, so a label is never re-matched by a name (labels already in
    // the text are left alone: running this twice changes nothing)
    t = t
      .split(LABEL_RE)
      .map((part, k) => {
        if (k % 2) return part
        let p = part
        projects.forEach((n, i) => {
          p = p.replace(nameRe(n), `\u0001${i}\u0001`)
        })
        return p.replace(/\u0001(\d+)\u0001/g, (_, i) => map[projects[Number(i)]!]!)
      })
      .join('')
    t = t.replace(ID_WORD_RE, '$1$2<id>').replace(/#\d+\b/g, '#<id>').replace(ID_KEY_RE, '<id>')
    t = t.replace(HEX_RE, '<sha>')
    t = t.replace(LONG_TOKEN, '<secret>')
    return t
  }

  // the final check: names the rules that missed. Stricter than the rules on purpose (a user name inside a longer word, say).
  const missed = (text: string): string[] => {
    const t = hidden(text)
    const out: string[] = []
    if (homeRe && new RegExp(homeRe.source).test(t)) out.push('home directory')
    if (/\/(?:Users|home)\/[A-Za-z0-9._-]+/.test(t)) out.push('/Users or /home path')
    if (userOk && new RegExp(esc(user), 'i').test(t)) out.push('user name')
    if (projects.some(n => nameRe(n).test(t))) out.push('project name')
    if (new RegExp(EMAIL_RE.source).test(t)) out.push('email address')
    if (SECRET_RES.some(re => { const hit = new RegExp(re.source, re.flags.replace('g', '')).exec(t); return !!hit && !/<secret>$/.test(hit[0]) })) out.push('token or key')
    if (/dev\.azure\.com\/(?!<org>)[^/\s]/.test(t) || /\b(?!<org>)[A-Za-z0-9-]+\.visualstudio\.com/.test(t)) out.push('azure organisation')
    if ((t.match(URL_RE) ?? []).some(u => !REPO_URL.test(u.replace(/[.,;:!?]+$/, '')))) out.push('URL')
    return [...new Set(out)]
  }
  return { anonymise, missed }
}

// ---- sources ------------------------------------------------------------------------------------------------------------------
type Group = { text: string; n: number; first: number }
const key = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim()
function group(items: { text: string; ts: number }[]): Group[] {
  const m = new Map<string, Group>()
  for (const { text, ts } of items) {
    const t = text.replace(/\s+/g, ' ').trim()
    if (!t) continue
    const g = m.get(key(t))
    if (g) {
      g.n++
      g.first = Math.min(g.first, ts)
    } else m.set(key(t), { text: t.slice(0, 300), n: 1, first: ts })
  }
  return [...m.values()].sort((a, b) => b.n - a.n || b.first - a.first) // most repeated first; among equals the newest
}
const FB_FIELDS = ['missing', 'refused', 'unverified', 'unreached'] as const

type State = { at: number; drafts: string[]; core: string[] }
const emptyState = (): State => ({ at: 0, drafts: [], core: [] })

export async function logRefusal(h: Host, rec: { text: string; agent?: string; tool?: string; thread?: string }): Promise<void> {
  await appendJsonl(h, `${leanDir(await homeDir(h))}/logs/refusals.jsonl`, { ts: await h.clock.now(), text: String(rec.text).slice(0, 300), agent: rec.agent, tool: rec.tool, thread: rec.thread })
}

type Collected = {
  notes: string
  env: string[]
  problems: string[]
  drafts: { name: string; raw: string; text: string }[]
  statuses: [string, number][]
  fields: Record<(typeof FB_FIELDS)[number], Group[]>
  refusals: { text: string; agent: string; n: number }[]
  core: { name: string; line: string }[]
  blocked: string[]
}

async function collect(h: Host, root: string, o: { notes?: string; version: string }, st: State, an: Anonymiser): Promise<Collected> {
  const home = await homeDir(h)
  const lean = leanDir(home)
  const A = an.anonymise
  const run = async (argv: string[]) => {
    const r = await h.process.run(argv).catch(() => null)
    return r && r.exitCode === 0 ? r.stdout.trim() : ''
  }
  const installed = (await readJson<{ version?: string }>(h, `${root}/.claude-plugin/plugin.json`, {})).version ?? 'unknown'
  const uname = await run(['uname', '-s'])
  const env = [
    `- lean-agent running: ${o.version}; installed: ${installed}${installed !== 'unknown' && installed !== o.version ? ' (SKEW: the running mod is not the installed version, restart the session)' : ''}`,
    `- Claude Code: ${(await run(['claude', '--version'])) || 'not found'}`,
    `- OS family: ${uname === 'Darwin' ? 'macOS (Darwin)' : uname === 'Linux' ? 'Linux' : uname || 'unknown'}`,
  ]
  const problems = ((await check(h, root).catch(() => ['FIX  the doctor check failed to run'])) as string[]).filter(l => l.startsWith('FIX')).map(l => A(l.replace(/^FIX\s+/, '')))
  const drafts: Collected['drafts'] = []
  for (const f of (await h.fs.list(`${lean}/feedback-drafts`).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name)))
    if (!st.drafts.includes(f.name)) drafts.push({ name: f.name, raw: f.name, text: String(await h.fs.read(`${lean}/feedback-drafts/${f.name}`).catch(() => '')) })
  const fb = (await readJsonl<Record<string, unknown>>(h, `${lean}/feedback.jsonl`)).filter(r => r && Number(r.ts) > st.at && r.kind !== 'core-candidate')
  const counts = new Map<string, number>()
  for (const r of fb) counts.set(String(r.status ?? 'unknown'), (counts.get(String(r.status ?? 'unknown')) ?? 0) + 1)
  const texts: Record<string, { text: string; ts: number }[]> = { missing: [], refused: [], unverified: [], unreached: [] }
  for (const r of fb) for (const f of FB_FIELDS) if (typeof r[f] === 'string') texts[f]!.push({ text: A(String(r[f])), ts: Number(r.ts) || 0 })
  // `missing` also comes from the gap logs (one line per gap a worker reported)
  const gapFiles = [`${lean}/gaps.jsonl`]
  for (const d of await h.fs.list(lean).catch(() => [])) if (d.kind === 'dir') gapFiles.push(`${lean}/${d.name}/gaps.jsonl`)
  for (const f of gapFiles) for (const g of await readJsonl<{ ts?: number; text?: string }>(h, f)) if (typeof g?.text === 'string' && Number(g.ts) > st.at) texts.missing!.push({ text: A(g.text), ts: Number(g.ts) })
  const fields = Object.fromEntries(FB_FIELDS.map(f => [f, group(texts[f]!)])) as Collected['fields']
  const ref = new Map<string, { text: string; agent: string; n: number }>()
  for (const r of await readJsonl<{ ts?: number; text?: string; agent?: string }>(h, `${lean}/logs/refusals.jsonl`)) {
    if (typeof r?.text !== 'string' || !(Number(r.ts) > st.at)) continue
    const agent = (r.agent ?? 'session').replace(/^lean-agent:/, '')
    const t = A(r.text).replace(/\s+/g, ' ').trim()
    const k = `${agent}\u0000${key(t)}`
    const cur = ref.get(k)
    if (cur) cur.n++
    else ref.set(k, { text: t, agent, n: 1 })
  }
  const core = (await allScripts(h).catch(() => [])).filter(x => x.meta.core && !st.core.includes(x.meta.name)).map(x => ({ name: x.meta.name, line: A(`${x.meta.name}: ${x.meta.purpose} (run: ${x.meta.run}; inputs: ${x.meta.inputs.join('; ')}; ${x.meta.status})`) }))
  const blocked = (await readJsonl<{ ts?: number; from?: string; kind?: string; state?: string; text?: string }>(h, `${lean}/desk/inbox.jsonl`))
    .filter(r => r?.kind === 'report' && r.state === 'blocked' && Number(r.ts) > st.at)
    .map(r => `${r.from ?? '?'}: ${A(String(r.text ?? '').split('\n')[0]!.trim().slice(0, 200))}`)
  return { notes: A(o.notes ?? '').trim(), env, problems, drafts: drafts.map(d => ({ name: A(d.name), raw: d.raw, text: A(d.text) })), statuses: [...counts], fields, refusals: [...ref.values()].sort((a, b) => b.n - a.n), core, blocked }
}

// ---- rendering with the size cap ------------------------------------------------------------------------------------------------
type Limits = { draft: number; top: number }
function render(c: Collected, at: number, lim: Limits): string {
  const out: string[] = ['# lean-agent feedback export', '', `Anonymised by the mod (no model, nothing posted). Covers ${at ? `everything since the last export (${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : 'everything so far (no earlier export)'}.`, '']
  const more = (n: number, what: string) => (n > 0 ? [`_... ${n} more ${what} summarised (oldest / least repeated)._`] : [])
  const top = <T,>(xs: T[]): [T[], number] => [xs.slice(0, lim.top), Math.max(0, xs.length - lim.top)]
  if (c.notes) out.push('## Notes', '', c.notes, '')
  out.push('## Environment', '', ...c.env, '')
  if (c.problems.length) out.push('## Doctor check: problems', '', ...c.problems.map(p => `- ${p}`), '')
  if (c.drafts.length) {
    out.push('## Drafts not exported before', '')
    for (const d of c.drafts) out.push(`### ${d.name}`, '', d.text.length > lim.draft ? `${d.text.slice(0, lim.draft)}\n\n_(truncated at ${lim.draft} characters)_` : d.text.trim(), '')
  }
  const fbTotal = c.statuses.reduce((n, [, k]) => n + k, 0)
  if (fbTotal || FB_FIELDS.some(f => c.fields[f].length)) {
    out.push('## LEAN-FEEDBACK since the last export', '')
    if (fbTotal) out.push(`Reports: ${fbTotal} (${c.statuses.map(([s, k]) => `${s} ${k}`).join(', ')})`, '')
    for (const f of FB_FIELDS) {
      if (!c.fields[f].length) continue
      const [shown, rest] = top(c.fields[f])
      out.push(`### ${f}`, '', ...shown.map(g => `- ${g.n > 1 ? `(x${g.n}) ` : ''}${g.text}`), ...more(rest, 'entries'), '')
    }
  }
  if (c.refusals.length) {
    const [shown, rest] = top(c.refusals)
    out.push('## Guard refusals since the last export', '', ...shown.map(r => `- (x${r.n}) [${r.agent}] ${r.text}`), ...more(rest, 'refusals'), '')
  }
  if (c.core.length) out.push('## Script candidates for lean-agent core', '', ...top(c.core)[0].map(x => `- ${x.line}`), ...more(top(c.core)[1], 'candidates'), '')
  if (c.blocked.length) {
    const [shown, rest] = top(c.blocked.slice().reverse())
    out.push('## Threads blocked since the last export', '', ...shown.map(b => `- ${b}`), ...more(rest, 'reports'), '')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
const bytes = (s: string) => new TextEncoder().encode(s).length
export function fit(c: Collected, at: number, cap = EXPORT_CAP): string {
  for (const lim of [{ draft: 1e9, top: 1e9 }, { draft: 6000, top: 20 }, { draft: 3000, top: 8 }, { draft: 1200, top: 3 }]) {
    const t = render(c, at, lim)
    if (bytes(t) <= cap) return t
  }
  const t = render(c, at, { draft: 600, top: 3 })
  const cut = t.slice(0, Math.max(0, cap - 200))
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n\n_... the rest was cut to keep the file under ${Math.round(cap / 1024)} KB._\n`
}

// ---- the export ---------------------------------------------------------------------------------------------------------------
export async function exportFeedback(h: Host, root: string, o: { notes?: string; version: string }): Promise<{ ok: boolean; text: string; path?: string }> {
  try {
    const home = await homeDir(h)
    const dir = exportDir(home)
    const st = { ...emptyState(), ...(await readJson<Partial<State>>(h, `${dir}/state.json`, {})) } as State
    const an = await makeAnonymiser(h)
    const c = await collect(h, root, o, st, an)
    const body = an.anonymise(fit(c, st.at)) // once more over the whole file: nothing reaches it unscrubbed
    const miss = an.missed(body)
    if (miss.length) return { ok: false, text: `feedback export refused, nothing written: a private string survived the anonymiser (missed rule: ${miss.join(', ')}). Say so in a bug report without the text; nothing was posted.` }
    const now = await h.clock.now()
    const stamp = new Date(now).toISOString().slice(0, 16).replace('T', '-').replace(':', '')
    let path = `${dir}/${stamp}.md`
    for (let n = 2; await h.fs.exists(path).catch(() => false); n++) path = `${dir}/${stamp}-${n}.md`
    await mkdirp(h, dir)
    await atomicWrite(h, path, body)
    await writeJson(h, `${dir}/state.json`, { at: now, drafts: [...st.drafts, ...c.drafts.map(d => d.raw)], core: [...st.core, ...c.core.map(x => x.name)] } satisfies State)
    return { ok: true, path, text: `feedback export written: ${path} (${Math.ceil(bytes(body) / 1024)} KB, anonymised by code). Nothing was posted: show the path; the user pastes the file to the maintainers, or posts it only after an explicit yes (gh if it is installed, otherwise say it is not).` }
  } catch (e) {
    return { ok: false, text: `feedback export failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` }
  }
}
