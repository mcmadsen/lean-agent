// COMPARE (back from 0.45.72, rebuilt the 1.0 way: the mod runs it, no model judges the overhead).
//
// Overhead mode: for a registered project it runs `claude -p "Reply with OK." --output-format json` and `claude -p "/context"` (local,
// free: a table of tokens by category, parseable) in three places and puts them side by side:
//   clean   in the project folder with the lean-agent plugin switched off (--settings enabledPlugins false for every installed
//           `lean-agent@...`; the process env's CLAUDE_CODE_PLUGIN_DIRS is emptied)
//   thread  in a throw-away folder shaped like a thread (threads/t9<n>: a thread's CLAUDE.md and .claude/settings.json)
//   desk    in the real desk folder
// Rows: the first turn's input tokens (measured: input + cache creation + cache read), its cost, then /context's categories
// (system prompt, system tools, MCP tools, custom agents, memory files, skills, messages: estimated by Claude Code). "One source off
// at a time" on the clean column: --disable-slash-commands (skills) and an empty strict MCP config, as far as this claude has the flags.
// Task mode (explicit, costs money; run by a thread): one read-only task clean and in a thread-shaped folder on the same model and
// effort, then a haiku judge compares correctness and completeness only.
// Reports (~/.lean-agent/compare/<date>-<project>.md and history.jsonl) hold NAMES and numbers only, never contents: the judge's reason
// goes to the caller, not to a file.
import { appendJsonl, atomicWrite, deskDir, homeDir, leanDir, mkdirp, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { rulesStats, slugOk } from './rules'
import { threadClaudeMd, threadSettings } from './threads'
import { installedKeys } from './skew'

export const PROMPT = 'Reply with OK.'
export const OVERHEAD_CAP_USD = 0.25
export const TASK_CAP_USD = 1
export const READ_TOOLS = 'Read,Grep,Glob'
export const ROWS = ['system prompt', 'system tools', 'system tools (deferred)', 'mcp tools', 'custom agents', 'memory files', 'skills', 'messages'] as const

// ---- parsing ------------------------------------------------------------------------------------------------------
// "27.8k" -> 27800, "~100" -> 100, "1m" -> 1e6, "1,234" -> 1234; null when it is no number
export function parseTokens(s: string): number | null {
  const m = /^~?\s*([\d,]*\.?\d+)\s*([kmKM])?$/.exec(s.trim().replace(/\s*tokens?$/i, ''))
  if (!m) return null
  const n = parseFloat(m[1]!.replace(/,/g, ''))
  return Math.round(n * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1))
}

export type Item = { name: string; source: string; tokens: number }
export type Ctx = { total: number | null; model: string; rows: Record<string, number>; lists: Record<string, Item[]> }
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

// `/context` as Claude Code prints it: "**Tokens:** 27.8k / 1m", a category table, and one table per list (### Skills: Skill | Source |
// Tokens). null when there is no category table.
export function parseContext(md: string): Ctx | null {
  const out: Ctx = { total: null, model: '', rows: {}, lists: {} }
  const head = /\*\*Model:\*\*\s*(\S+)/.exec(md)
  if (head) out.model = head[1]!
  const tot = /\*\*Tokens:\*\*\s*([\d.,]+\s*[kmKM]?)/.exec(md)
  if (tot) out.total = parseTokens(tot[1]!)
  let section = ''
  let any = false
  for (const line of md.split('\n')) {
    const h = /^#{2,4}\s+(.*)$/.exec(line)
    if (h) { section = h[1]!.trim().toLowerCase(); continue }
    if (!line.trim().startsWith('|')) continue
    const c = cells(line)
    if (c.length < 2 || /^[-: ]+$/.test(c.join(''))) continue
    if (/^(category|skill|tool|file|agent|name|server|memory)/i.test(c[0]!) && /token/i.test(c.join(' '))) continue // a header row
    if (section.startsWith('estimated usage')) {
      const n = parseTokens(c[1]!)
      if (n !== null) { out.rows[c[0]!.toLowerCase()] = n; any = true }
    } else if (section) {
      const n = parseTokens(c[c.length - 1]!)
      if (n !== null) (out.lists[section] ??= []).push({ name: c[0]!, source: c.length > 2 ? c[1]! : '', tokens: n })
    }
  }
  return any ? out : null
}

export type Run = { input: number; output: number; cost: number; turns: number; ms: number; model: string; error: string; text: string }
// `claude -p --output-format json`: the result object (or the result event of an array); input = the first iteration's input tokens
// (input + cache creation + cache read), else the totals
export function parseRun(stdout: string): Run | null {
  let v: any = null
  const text = stdout.trim()
  for (const cand of [text, text.split('\n').filter(l => l.trim().startsWith('{')).pop() ?? '']) {
    try {
      v = JSON.parse(cand)
      break
    } catch {
      /* try the last JSON line */
    }
  }
  if (Array.isArray(v)) v = [...v].reverse().find(e => e && e.type === 'result') ?? null
  if (!v || typeof v !== 'object' || (v.type !== undefined && v.type !== 'result')) return null
  const u = v.usage && typeof v.usage === 'object' ? v.usage : {}
  const it = Array.isArray(u.iterations) && u.iterations[0] && typeof u.iterations[0] === 'object' ? u.iterations[0] : u
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  const sum = (o: any) => n(o.input_tokens) + n(o.cache_creation_input_tokens) + n(o.cache_read_input_tokens)
  const models = v.modelUsage && typeof v.modelUsage === 'object' ? Object.keys(v.modelUsage) : []
  return { input: sum(it), output: n(u.output_tokens), cost: n(v.total_cost_usd), turns: n(v.num_turns), ms: n(v.duration_ms), model: models[0] ?? '', error: v.is_error ? String(v.subtype ?? 'error') : '', text: typeof v.result === 'string' ? v.result : '' }
}
// every token the whole run used (a task run has many turns)
export function allTokens(stdout: string): number {
  try {
    const u = JSON.parse(stdout.trim()).usage ?? {}
    return ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((s, k) => s + (typeof u[k] === 'number' ? u[k] : 0), 0)
  } catch {
    return 0
  }
}

// ---- running claude -----------------------------------------------------------------------------------------------
type Meter = { cost: number; cap: number; runs: number; skipped: string[]; has: Set<string> }
const FLAGS = ['--max-budget-usd', '--settings', '--plugin-dir', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '--effort', '--tools', '--allowedTools', '--add-dir']
async function helpFlags(h: Host): Promise<Set<string>> {
  const r = await h.process.run(['claude', '--help'], { timeoutMs: 30_000 }).catch(() => null)
  const text = r ? `${r.stdout}\n${r.stderr}` : ''
  return new Set(FLAGS.filter(f => text.includes(f)))
}
type Call = { out: Run | null; raw: string; stderr: string; seconds: number }
// o.max: this run's own budget (a task run gets the per-run cap, not what is left of the shared one); a free run (/context) has none.
// A run that rejects (killed by its timeout) is counted at its full budget: its real cost is unknown and the cap must hold.
async function claude(h: Host, m: Meter, label: string, cwd: string, args: string[], o: { env?: Record<string, string>; stdin?: string; timeoutMs?: number; budget?: boolean; max?: number } = {}): Promise<Call | null> {
  if (o.budget !== false && m.cost >= m.cap) { m.skipped.push(label); return null }
  const left = Math.max(0.05, +(m.cap - m.cost).toFixed(3)) // (a cold-cache first turn costs a few cents: a smaller budget would fail it)
  const budget = Math.min(left, o.max ?? left)
  const argv = ['claude', ...args, ...(o.budget !== false && m.has.has('--max-budget-usd') ? ['--max-budget-usd', String(budget)] : [])]
  const t0 = await h.clock.now()
  try {
    const r = await h.process.run(argv, { cwd, env: o.env, stdin: o.stdin, timeoutMs: o.timeoutMs ?? 120_000 })
    const run = parseRun(r.stdout)
    m.runs++
    m.cost += run?.cost ?? 0
    return { out: run, raw: r.stdout, stderr: r.stderr, seconds: Math.round(((await h.clock.now()) - t0) / 100) / 10 }
  } catch (e) {
    if (o.budget !== false) m.cost += budget
    m.skipped.push(`${label} (${scrub(String((e as Error)?.message ?? e)).slice(0, 80)})`)
    return null
  }
}

// ---- the overhead columns -----------------------------------------------------------------------------------------
export type Col = { name: string; input: number | null; cost: number; seconds: number; ctx: Ctx | null; notes: string[] }
const JSON_ARGS = (model: string, prompt: string) => ['-p', prompt, '--output-format', 'json', '--model', model]

async function column(h: Host, m: Meter, name: string, cwd: string, extra: string[], env: Record<string, string> | undefined, model: string): Promise<Col> {
  const col: Col = { name, input: null, cost: 0, seconds: 0, ctx: null, notes: [] }
  const run = await claude(h, m, `${name} turn`, cwd, [...JSON_ARGS(model, PROMPT), '--max-turns', '1', ...extra], { env })
  if (run?.out && !run.out.error && run.out.input > 0) {
    col.input = run.out.input
    col.cost = run.out.cost
    col.seconds = run.seconds
  } else if (run) col.notes.push(`the turn failed (${run.out?.error || 'no usage in the output'})`)
  if (run && /hooks module not loaded/i.test(run.stderr)) col.notes.push('the lean-agent hooks module did not load in this -p run (skills, agents and CLAUDE.md count, the mod\'s own trimming does not)')
  if (name !== 'clean') col.notes.push('a -p run: what the mod trims by role (the desk\'s skill listing, tool pool and agent offer) applies only if its hooks module loaded here, so the live desk can be smaller: check /context in it')
  const ctx = await claude(h, m, `${name} context`, cwd, [...JSON_ARGS(model, '/context'), ...extra], { env, budget: false })
  col.ctx = ctx?.out ? parseContext(ctx.out.text) : null
  if (!col.ctx) col.notes.push('/context gave no table')
  return col
}

// Names only. The project folder and the home folder are replaced (whole path words, so `/work/app-secret` is not `<project>-secret`)
// and `scrub` cuts every other absolute path to its last component: a memory file in a folder above the project, or a path in an
// error text, never reaches a report.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const redactor = (home: string, project: string) => (s: string) => s.replace(new RegExp(`${esc(project)}(?![\\w.-])`, 'g'), '<project>').replace(new RegExp(`${esc(home)}(?![\\w.-])`, 'g'), '~')
export const scrub = (s: string) => s.replace(/(?:^|(?<=[\s("'=:,]))\/(?:[^\s/"'),;:]+\/)+([^\s/"'),;:]*)/g, (_m, last: string) => `…/${last}`)
// a /context item name that is a path: its last component (names only; the folders above stay out)
export const shortName = (name: string) => (name.includes('/') ? name.replace(/^.*\//, '…/') : name)

export type Report = { project: string; model: string; cols: Col[]; attribution: string[]; suggestions: string[]; cost: number; skipped: string[]; ts: number }

export function fmtTok(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'n/a'
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
}

// plugin / MCP server names with their tokens, from /context's lists (names only)
export function bySource(ctx: Col['ctx'], list: string): [string, number, number][] {
  const g: Record<string, [number, number]> = {}
  for (const it of ctx?.lists[list] ?? []) {
    const src = it.source.replace(/^Plugin \((.*)\)$/, 'plugin $1') || (list.includes('mcp') ? it.name.split('__')[1] ?? it.name : '?')
    const a = (g[src] ??= [0, 0])
    a[0] += it.tokens
    a[1]++
  }
  return Object.entries(g).map(([k, v]) => [k, v[0], v[1]] as [string, number, number]).sort((a, b) => b[1] - a[1])
}

// Suggestions computed from the numbers, each with the concrete step.
export async function suggestions(h: Host, project: string, slug: string, cols: Col[]): Promise<string[]> {
  const out: string[] = []
  const home = await homeDir(h)
  const clean = cols.find(c => c.name === 'clean')
  for (const c of cols.filter(x => x.name !== 'clean')) {
    if (clean?.input != null && c.input != null && c.input > clean.input) {
      const diffs = ROWS.map(r => [r, (c.ctx?.rows[r] ?? 0) - (clean.ctx?.rows[r] ?? 0)] as const).filter(([, d]) => d > 500).sort((a, b) => b[1] - a[1]).slice(0, 3)
      out.push(`a ${c.name} session starts at ${fmtTok(c.input)} tokens vs ${fmtTok(clean.input)} clean${diffs.length ? `; most of the difference: ${diffs.map(([r, d]) => `${r} +${fmtTok(d)}`).join(', ')}` : ''}`)
    }
  }
  // other plugins' skills and MCP servers, on the desk and thread columns (a clean run has them too: they are the user's)
  for (const c of cols) {
    for (const [src, tok, n] of bySource(c.ctx, 'skills')) {
      if (/^(built-in|user|claude\.ai sync|\?)$/i.test(src) || /lean-agent/.test(src) || tok < 300) continue
      out.push(`${c.name}: ${src} adds ~${fmtTok(tok)} tokens (${n} skills) to every session: switch it off for this project with "enabledPlugins": {"<name>@<marketplace>": false} in ${project}/.claude/settings.json`)
    }
    for (const [src, tok, n] of bySource(c.ctx, 'mcp tools')) {
      if (tok < 300) continue
      out.push(`${c.name}: MCP server ${src} adds ~${fmtTok(tok)} tokens (${n} tools): add "mcp__${src}__*" to tools.${c.name === 'clean' ? 'thread' : c.name}.drop in ~/.lean-agent/config.json`)
    }
  }
  const mem = [...(clean?.ctx?.lists['memory files'] ?? [])].sort((a, b) => b.tokens - a.tokens).filter(x => x.tokens > 1500).slice(0, 3)
  for (const f of mem) out.push(`memory file ${shortName(f.name)} is ~${fmtTok(f.tokens)} tokens in every session: move area-specific parts into path rules (learn ${slug} --gaps)`)
  const rs = await rulesStats(h, slug).catch(() => null)
  if (rs && rs.never.length) out.push(`${rs.never.length} learned rule(s) never loaded (${rs.never.slice(0, 4).join(', ')}${rs.never.length > 4 ? ', ...' : ''}): learn ${slug} --trim`)
  const gaps = await readJsonl<{ text?: string }>(h, `${leanDir(home)}/${slug}/gaps.jsonl`).catch(() => [])
  const mech = gaps.filter(g => /\b(count|list|how many|find all|diff|compare|grep|which (files|packages|worktrees))\b/i.test(g.text ?? '')).length
  if (mech) out.push(`${mech} gap(s) look like mechanical work: learn ${slug} --trim lists them as script candidates`)
  return out
}

export function renderReport(r: Report, redact: (s: string) => string): string {
  const names = r.cols.map(c => c.name)
  const row = (label: string, f: (c: Col) => string) => `| ${label} | ${r.cols.map(f).join(' | ')} |`
  const out = [
    `# lean-agent compare: ${r.project}`,
    '',
    `${new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC · model ${r.model} · prompt "${PROMPT}" · cost of this comparison $${r.cost.toFixed(3)}`,
    '',
    `| | ${names.join(' | ')} |`,
    `|---|${names.map(() => '---').join('|')}|`,
    row('first-turn input (measured)', c => fmtTok(c.input)),
    row('first-turn cost', c => (c.input === null ? 'n/a' : `$${c.cost.toFixed(4)}`)),
    ...ROWS.map(k => row(`${k} (est.)`, c => (c.ctx ? fmtTok(c.ctx.rows[k] ?? 0) : 'n/a'))),
    '',
  ]
  if (r.attribution.length) out.push('One source off at a time (clean column):', ...r.attribution.map(a => `- ${a}`), '')
  for (const c of r.cols) {
    const sk = bySource(c.ctx, 'skills').slice(0, 6)
    if (sk.length) out.push(`Skills in ${c.name}, by source: ${sk.map(([s, t, n]) => `${s} ${fmtTok(t)} (${n})`).join(', ')}`)
    const mem = (c.ctx?.lists['memory files'] ?? []).slice(0, 6)
    if (mem.length) out.push(`Memory files in ${c.name}: ${mem.map(f => `${shortName(f.name)} ${fmtTok(f.tokens)}`).join(', ')}`)
    const mcp = bySource(c.ctx, 'mcp tools').slice(0, 6)
    if (mcp.length) out.push(`MCP servers in ${c.name}: ${mcp.map(([s, t, n]) => `${s} ${fmtTok(t)} (${n})`).join(', ')}`)
  }
  for (const c of r.cols) for (const n of c.notes) out.push(`Note (${c.name}): ${n}`)
  if (r.skipped.length) out.push(`Not run (cap reached or failed): ${r.skipped.join(', ')}`)
  out.push('', 'Suggestions:', ...(r.suggestions.length ? r.suggestions.map(s => `- ${s}`) : ['- nothing to suggest from these numbers']), '', '(numbers and source names only; no file contents)')
  return redact(out.join('\n')) + '\n'
}

// ---- saved reports -------------------------------------------------------------------------------------------------
export const compareDir = (home: string) => `${leanDir(home)}/compare`
async function saveReport(h: Host, home: string, slug: string, md: string, hist: Record<string, unknown>): Promise<string> {
  const dir = compareDir(home)
  await mkdirp(h, dir)
  const day = new Date(await h.clock.now()).toISOString().slice(0, 10)
  let file = `${dir}/${day}-${slug}.md`
  for (let i = 2; await h.fs.exists(file).catch(() => false); i++) file = `${dir}/${day}-${slug}-${i}.md`
  await atomicWrite(h, file, md)
  await appendJsonl(h, `${dir}/history.jsonl`, { ...hist, file: file.slice(dir.length + 1) })
  return file
}

export async function historyText(h: Host, slug?: string): Promise<string> {
  const rows = (await readJsonl<any>(h, `${compareDir(await homeDir(h))}/history.jsonl`)).filter(r => !slug || r.project === slug)
  if (!rows.length) return 'no comparisons yet: lean_doctor compare with a project (overhead mode)'
  return rows.slice(-20).map(r => r.mode === 'task'
    ? `${String(r.date)} ${r.project} task ${r.model}: clean ${fmtTok(r.clean?.tokens)} tok $${(r.clean?.cost ?? 0).toFixed(3)} · thread ${fmtTok(r.thread?.tokens)} tok $${(r.thread?.cost ?? 0).toFixed(3)} · judge ${r.verdict} · $${(r.cost ?? 0).toFixed(3)} (${r.file})`
    : `${String(r.date)} ${r.project} overhead ${r.model}: clean ${fmtTok(r.totals?.clean)} · thread ${fmtTok(r.totals?.thread)} · desk ${fmtTok(r.totals?.desk)} · $${(r.cost ?? 0).toFixed(3)} (${r.file})`).join('\n')
}

// ---- the project and the folders -----------------------------------------------------------------------------------
async function projectOf(h: Host, home: string, name: string): Promise<{ slug: string; path: string } | string> {
  if (!slugOk(name)) return 'compare needs a registered project name (lean_thread projects lists them)'
  const projs = await readJson<Record<string, { path?: string; private?: boolean }>>(h, `${leanDir(home)}/projects.json`, {})
  const p = projs?.[name]
  if (!p || typeof p.path !== 'string' || !p.path.startsWith('/')) return `project ${name} is not registered (lean_thread projects)`
  if (p.private === true) return `project ${name} is private: compare never runs there (its names would leave the machine in a report)`
  return { slug: name, path: p.path.replace(/\/+$/, '') }
}

// a throw-away folder shaped like a thread: threads/t9<n> with a thread's CLAUDE.md and .claude/settings.json
// Its name is t9 + 13 digits of time + 3 random digits: it must look like a thread to role detection (threads/t<digits>), and it is
// longer than any real thread number, which threads.ts nextId ignores (so a leftover one never shifts the next thread's id). A
// thread.json is never written, so no list shows it, and every compare run first sweeps the ones an hour old (a killed run's).
const TEMP = /^t9\d{16}$/
const TEMP_DIR = /\/threads\/t9\d{16}$/
async function tempThread(h: Host, root: string, home: string, project: string): Promise<string> {
  const now = await h.clock.now()
  for (const e of await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])) {
    if (TEMP.test(e.name) && Number(e.name.slice(2, 15)) < now - 3_600_000) await h.process.run(['rm', '-rf', `${threadsDir(home)}/${e.name}`]).catch(() => undefined)
  }
  const id = `t9${now}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`
  const dir = `${threadsDir(home)}/${id}`
  await mkdirp(h, dir)
  await h.fs.write(`${dir}/CLAUDE.md`, await threadClaudeMd(h, root, id, 'compare', project))
  await h.fs.write(`${dir}/.claude/settings.json`, await threadSettings(h, id, false))
  return dir
}
const dropDir = async (h: Host, dir: string) => {
  if (TEMP_DIR.test(dir)) await h.process.run(['rm', '-rf', dir]).catch(() => undefined)
}
const THREAD_NOTE = 'the thread folder does not load the project\'s CLAUDE.md or .claude/rules at start (a real thread reads the project by absolute paths: its rules load when files are read), so this column omits them'

const meterOf = async (h: Host, cap: number): Promise<Meter> => ({ cost: 0, cap, runs: 0, skipped: [], has: await helpFlags(h) })

// ---- overhead mode ---------------------------------------------------------------------------------------------------
export async function overhead(h: Host, root: string, name: string, o: { model?: string; maxUsd?: number } = {}): Promise<{ ok: boolean; text: string }> {
  const home = await homeDir(h)
  const p = await projectOf(h, home, name)
  if (typeof p === 'string') return { ok: false, text: p }
  const model = o.model || 'haiku'
  const m = await meterOf(h, Math.min(Math.max(o.maxUsd ?? OVERHEAD_CAP_USD, 0.02), 1))
  const keys = await installedKeys(h)
  const plugin = !keys.length && m.has.has('--plugin-dir') ? ['--plugin-dir', root] : [] // lean-agent not installed (a dev copy): load it by folder
  const off = keys.length && m.has.has('--settings') ? ['--settings', JSON.stringify({ enabledPlugins: Object.fromEntries(keys.map(k => [k, false])) })] : []
  const cols: Col[] = []
  cols.push(await column(h, m, 'clean', p.path, off, { CLAUDE_CODE_PLUGIN_DIRS: '' }, model))
  if (!cols[0]!.input) return { ok: false, text: `the clean run gave no usage (${cols[0]!.notes.join('; ') || m.skipped.join(', ') || 'is `claude` signed in?'})` }
  let tdir = ''
  try {
    tdir = await tempThread(h, root, home, p.slug)
    cols.push(await column(h, m, 'thread', tdir, plugin, undefined, model))
    cols[cols.length - 1]!.notes.push(THREAD_NOTE)
  } finally {
    if (tdir) await dropDir(h, tdir)
  }
  if (await h.fs.exists(deskDir(home)).catch(() => false)) cols.push(await column(h, m, 'desk', deskDir(home), plugin, undefined, model))
  // one source off at a time (clean column): the difference is that source's share of the first turn
  const attribution: string[] = []
  const clean = cols[0]!
  if (m.has.has('--disable-slash-commands') && (clean.ctx?.rows.skills ?? 0) > 0) {
    const r = await claude(h, m, 'clean without skills', p.path, [...JSON_ARGS(model, PROMPT), '--max-turns', '1', ...off, '--disable-slash-commands'], { env: { CLAUDE_CODE_PLUGIN_DIRS: '' } })
    if (r?.out && !r.out.error && r.out.input) attribution.push(`skills: ${fmtTok(clean.input! - r.out.input)} tokens (first turn ${fmtTok(clean.input)} -> ${fmtTok(r.out.input)} with skills off)`)
  }
  if (m.has.has('--strict-mcp-config') && m.has.has('--mcp-config') && (clean.ctx?.rows['mcp tools'] ?? 0) > 0) {
    const r = await claude(h, m, 'clean without MCP', p.path, [...JSON_ARGS(model, PROMPT), '--max-turns', '1', ...off, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { env: { CLAUDE_CODE_PLUGIN_DIRS: '' } })
    if (r?.out && !r.out.error && r.out.input) attribution.push(`MCP servers: ${fmtTok(clean.input! - r.out.input)} tokens (${fmtTok(clean.input)} -> ${fmtTok(r.out.input)} with MCP off)`)
  }
  const rep: Report = { project: p.slug, model, cols, attribution, suggestions: await suggestions(h, p.path, p.slug, cols), cost: m.cost, skipped: m.skipped, ts: await h.clock.now() }
  const md = renderReport(rep, redactor(home, p.path))
  const get = (n: string) => cols.find(c => c.name === n)?.input ?? null
  const file = await saveReport(h, home, p.slug, md, { date: new Date(rep.ts).toISOString().slice(0, 16), project: p.slug, mode: 'overhead', model, totals: { clean: get('clean'), thread: get('thread'), desk: get('desk') }, cost: +m.cost.toFixed(4), skipped: m.skipped.length })
  return { ok: true, text: `${md}Saved: ${file}` }
}

// ---- task mode ---------------------------------------------------------------------------------------------------------
const JUDGE = 'Two answers to the same read-only task about a code project. Judge correctness and completeness only (not style). Reply with JSON only: {"winner": "A"|"B"|"tie", "reason": "<one sentence>"}.\n\nTASK:\n'

export async function taskMode(h: Host, root: string, name: string, task: string, o: { model?: string; maxUsd?: number; maxTurns?: number } = {}): Promise<{ ok: boolean; text: string }> {
  const home = await homeDir(h)
  const p = await projectOf(h, home, name)
  if (typeof p === 'string') return { ok: false, text: p }
  if (!task.trim()) return { ok: false, text: 'task mode needs the read-only task text' }
  const model = o.model || 'sonnet'
  const cap = Math.min(Math.max(o.maxUsd ?? TASK_CAP_USD, 0.05), 5)
  const m = await meterOf(h, cap * 2 + 0.1) // two runs of at most `cap` each, and the judge's 0.1
  // read-only is enforced by the tool list, not by a permission rule (--allowedTools only pre-approves): no --tools, no task mode
  if (!m.has.has('--tools')) return { ok: false, text: 'task mode needs `claude --tools` (to keep both runs read-only): this claude does not list it' }
  const keys = await installedKeys(h)
  const effort = m.has.has('--effort') ? ['--effort', 'high'] : []
  const run = (extra: string[], prompt: string) => [...JSON_ARGS(model, prompt), '--max-turns', String(o.maxTurns ?? 25), ...effort, '--tools', READ_TOOLS, ...(m.has.has('--allowedTools') ? ['--allowedTools', READ_TOOLS] : []), ...extra]
  const off = keys.length && m.has.has('--settings') ? ['--settings', JSON.stringify({ enabledPlugins: Object.fromEntries(keys.map(k => [k, false])) })] : []
  // the same prompt for both (it never starts with "/", so a task is never a slash command)
  const prompt = `Read-only task about the repository at ${p.path} (use absolute paths; never cd):\n${task}`
  const clean = await claude(h, m, 'clean task', p.path, run(off, prompt), { env: { CLAUDE_CODE_PLUGIN_DIRS: '' }, timeoutMs: 600_000, max: cap })
  let tdir = ''
  let lean: Call | null = null
  try {
    tdir = await tempThread(h, root, home, p.slug)
    const plug = !keys.length && m.has.has('--plugin-dir') ? ['--plugin-dir', root] : []
    lean = await claude(h, m, 'thread task', tdir, run([...plug, ...(m.has.has('--add-dir') ? ['--add-dir', p.path] : [])], prompt), { timeoutMs: 600_000, max: cap })
  } finally {
    if (tdir) await dropDir(h, tdir)
  }
  // a run that hit its turn or budget limit, or answered nothing, is no answer: no judge, no verdict
  const why = (c: Call | null, label: string) => (!c?.out ? `the ${label} run gave no result` : c.out.error ? `the ${label} run stopped: ${c.out.error}` : !c.out.text.trim() ? `the ${label} run gave no answer` : '')
  const bad = [why(clean, 'clean'), why(lean, 'thread'), ...m.skipped].filter(Boolean)
  if (bad.length || !clean?.out || !lean?.out) return { ok: false, text: `task mode needs both runs to answer: ${bad.join('; ')} (cost so far $${m.cost.toFixed(3)}; raise maxTurns or maxUsd, or pick a smaller task)` }
  await mkdirp(h, compareDir(home)) // the judge's neutral folder (it runs with lean-agent's plain role, not in a project)
  // the judge sees both answers in an order that alternates, so a position bias does not always favour one side
  const swap = (await h.clock.now()) % 2 === 1
  const [a, b] = swap ? [lean.out.text, clean.out.text] : [clean.out.text, lean.out.text]
  const j = await claude(h, m, 'judge', compareDir(home), [...JSON_ARGS('haiku', `${JUDGE}${task.slice(0, 4000)}\n\nANSWER A:\n${a.slice(0, 6000)}\n\nANSWER B:\n${b.slice(0, 6000)}\n`), '--max-turns', '1', '--tools', ''], { timeoutMs: 180_000, max: 0.1 })
  let verdict = '?'
  let reason = ''
  try {
    const v = JSON.parse(/\{[\s\S]*\}/.exec(j?.out?.text ?? '')?.[0] ?? '{}')
    const w = String(v.winner ?? '')
    verdict = w === 'tie' ? 'tie' : w === 'A' ? (swap ? 'thread' : 'clean') : w === 'B' ? (swap ? 'clean' : 'thread') : '?'
    reason = typeof v.reason === 'string' ? v.reason.slice(0, 300) : ''
  } catch {
    /* no verdict */
  }
  const sum = (c: Call) => ({ tokens: allTokens(c.raw), cost: +(c.out?.cost ?? 0).toFixed(4), turns: c.out?.turns ?? 0, seconds: c.seconds })
  const cs = sum(clean)
  const ls = sum(lean)
  const saving = cs.tokens ? Math.round((100 * (cs.tokens - ls.tokens)) / cs.tokens) : 0
  const md = [
    `# lean-agent compare (task): ${p.slug}`,
    '',
    `${new Date(await h.clock.now()).toISOString().slice(0, 16).replace('T', ' ')} UTC · model ${model}${effort.length ? ' / effort high' : ''} · task of ${task.length} characters (not saved) · cost of this comparison $${m.cost.toFixed(3)}`,
    '',
    '| | clean | thread |',
    '|---|---|---|',
    `| tokens (all turns) | ${fmtTok(cs.tokens)} | ${fmtTok(ls.tokens)} |`,
    `| cost | $${cs.cost.toFixed(3)} | $${ls.cost.toFixed(3)} |`,
    `| turns | ${cs.turns} | ${ls.turns} |`,
    `| time | ${cs.seconds}s | ${ls.seconds}s |`,
    '',
    `Judge (correctness and completeness only): ${verdict}. The thread used ${saving >= 0 ? `${saving}% fewer` : `${-saving}% more`} tokens than the clean run.`,
    '',
    `Note: ${THREAD_NOTE}.`,
    '(numbers only; neither answer nor the judge\'s reason is saved)',
  ].join('\n') + '\n'
  const file = await saveReport(h, home, p.slug, md, { date: new Date(await h.clock.now()).toISOString().slice(0, 16), project: p.slug, mode: 'task', model, clean: cs, thread: ls, verdict, cost: +m.cost.toFixed(4) })
  return { ok: true, text: `${md}${reason ? `Judge's reason (not saved): ${reason}\n` : ''}Saved: ${file}` }
}

// ---- the entry the desk (lean_doctor) and a thread (lean_compare) call ----------------------------------------------
export async function compare(h: Host, root: string, i: { project?: string; mode?: string; task?: string; model?: string; maxUsd?: number }, who: 'desk' | 'thread'): Promise<{ ok: boolean; text: string }> {
  const mode = i.mode || 'overhead'
  if (mode === 'history') return { ok: true, text: await historyText(h, i.project || undefined) }
  if (!i.project) return { ok: false, text: 'compare needs project (a registered name)' }
  if (mode === 'overhead') return overhead(h, root, i.project, { model: i.model, maxUsd: i.maxUsd })
  if (mode === 'task') {
    if (who !== 'thread') return { ok: false, text: 'task mode costs money and runs in a thread: ask the user, then start a thread with the compare skill and the task (lean_thread new)' }
    return taskMode(h, root, i.project, i.task ?? '', { model: i.model, maxUsd: i.maxUsd })
  }
  return { ok: false, text: 'compare mode must be overhead, task or history' }
}
