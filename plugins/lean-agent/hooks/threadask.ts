// Answers from the store (user requirement: the store is the memory, scripts not model turns):
//   lean_thread find <words|PR|branch|project>  script search over titles, goals, branches, reports, notes, remembered items and the state
//                                               snapshot: matching lines with the thread id and the source file
//   lean_thread ask tN "<question>"             (a) by script when lines of the store match; (b) else a FRESH small session (haiku / low,
//                                               config ask.model / ask.effort) with the handover and the question; the big old session is
//                                               never resumed
//   lean_thread report tN                       a script summary (state, sha, verdict, open questions, counts, the path of the full text)
import { leanDir, mkdirp, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskState, reportFile } from './delivery'
import type { DeskRec } from './delivery'
import { buildHandover } from './handover'
import { greenReview } from './reviews'
import { readSnapshot } from './snapshot'
import { waitingOn } from './waitevent'
import { kTokens, readContext } from './threadcontext'
import type { Out, Thread } from './threads'

export type Line = { id: string; file: string; text: string }
const MAX_LINES = 25
const EACH = 180
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n = EACH) => (s.length <= n ? s : s.slice(0, n) + '…')

// Every searchable line of the store for the threads in `only` (all when empty). Nothing is read twice per call.
export async function storeLines(h: Host, home: string, only?: string): Promise<Line[]> {
  const out: Line[] = []
  const names = (await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])).map(e => e.name).filter(n => /^t\d+$/.test(n) && (!only || n === only))
  const goals = await readJson<Record<string, { text?: string }>>(h, `${leanDir(home)}/goals.json`, {})
  const wts = await readJson<Record<string, Record<string, unknown>>>(h, `${leanDir(home)}/worktrees.json`, {})
  const recs = await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)
  const mem = await readJsonl<{ from?: string; text?: string }>(h, `${leanDir(home)}/memory/notes.jsonl`)
  const text = async (p: string) => {
    const r = await h.fs.read(p).catch(() => '')
    return typeof r === 'string' ? r : ''
  }
  for (const id of names) {
    const dir = `threads/${id}`
    const t = await readJson<Partial<Thread> | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    if (t) out.push({ id, file: `${dir}/thread.json`, text: `title: ${t.title ?? ''} · project: ${t.project ?? ''} · state: ${t.state ?? ''}${t.finished ? ' (finished)' : ''}` })
    const g = goals?.[id]?.text ?? t?.lastGoal
    if (g) out.push({ id, file: 'goals.json', text: `goal: ${flat(String(g))}` })
    for (const w of Object.values(wts && typeof wts === 'object' ? wts : {})) {
      if (w && w.thread === id) out.push({ id, file: 'worktrees.json', text: Object.entries(w).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => `${k}: ${v}`).join(' · ') })
    }
    const s = await readSnapshot(h, home, id)
    if (s) out.push({ id, file: `${dir}/state.json`, text: `branch: ${s.branch} · HEAD ${s.head.slice(0, 10)}${s.edited.length ? ` · edited: ${s.edited.join(', ')}` : ''}` })
    for (const l of (await text(`${threadsDir(home)}/${id}/notes.md`)).split('\n')) if (l.trim()) out.push({ id, file: `${dir}/notes.md`, text: flat(l) })
    for (const r of recs) {
      if (r.from !== id || (r as { mod?: boolean }).mod) continue
      for (const l of String(r.text ?? '').split('\n')) if (l.trim()) out.push({ id, file: `desk/reports/${r.ts}-${id}-${r.kind}.md`, text: `${r.kind === 'ask' ? '[question] ' : ''}${flat(l)}` })
    }
    for (const m of mem) if (m.from === id && typeof m.text === 'string') out.push({ id, file: 'memory/notes.jsonl', text: `remembered: ${flat(m.text)}` })
  }
  return out
}

const words = (q: string) => [...new Set(q.toLowerCase().split(/\s+/).map(w => w.replace(/^["'(]+|["'?!.,;:)]+$/g, '')).filter(Boolean))]
const show = (l: Line) => `${l.id}  ${l.file}: ${clip(l.text)}`

export async function findText(h: Host, home: string, query: string): Promise<Out> {
  const ws = words(query)
  if (!ws.length) return { ok: false, text: 'find needs words (text): a word, a PR number, a branch or a project' }
  const all = await storeLines(h, home)
  const hit = all.filter(l => ws.every(w => (l.text + ' ' + l.file).toLowerCase().includes(w)))
  const threads = new Set(hit.map(l => l.id))
  if (!hit.length) return { ok: true, text: `find "${query}": nothing matches (searched titles, goals, branches, reports, notes, remembered items and snapshots of ${new Set(all.map(l => l.id)).size} thread(s))` }
  // a line is shown once (the same text twice, e.g. a report and its note)
  const seen = new Set<string>()
  const rows = hit.filter(l => (seen.has(l.id + l.text) ? false : (seen.add(l.id + l.text), true)))
  return { ok: true, text: [`find "${query}": ${rows.length} line(s) in ${threads.size} thread(s)${rows.length > MAX_LINES ? `, first ${MAX_LINES}` : ''}`, ...rows.slice(0, MAX_LINES).map(show)].join('\n'), data: { threads: [...threads] } }
}

// ---- ask -------------------------------------------------------------------------------------------------------------------------
const STOP = new Set('the and for are was were with what which who whom whose when where why how did does has have had this that these those from into about thread its their there then than but not you your our can could would should will shall may might must any all one two been being his her him she they them out off over under again also just only very too yet'.split(' '))

export type AskDeps = { run?: (prompt: string, model: string, effort: string, cwd: string) => Promise<{ ok: boolean; text: string }> }

export async function askText(h: Host, home: string, id: string, question: string, deps: AskDeps = {}): Promise<Out> {
  const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
  if (!t) return { ok: false, text: `no thread ${id}` }
  const q = question.trim()
  if (!q) return { ok: false, text: 'ask needs text: the question' }
  // (a) the store, by script: lines that carry at least half of the question's content words
  const kw = words(q).filter(w => w.length >= 3 && !STOP.has(w))
  if (kw.length) {
    const need = Math.max(1, Math.ceil(kw.length / 2))
    const scored = (await storeLines(h, home, id))
      .map(l => ({ l, n: kw.filter(w => (l.text + ' ' + l.file).toLowerCase().includes(w)).length }))
      .filter(x => x.n >= need)
      .sort((a, b) => b.n - a.n)
    if (scored.length) {
      const seen = new Set<string>()
      const rows = scored.filter(x => (seen.has(x.l.text) ? false : (seen.add(x.l.text), true))).slice(0, 6)
      return { ok: true, text: [`${id} (from the store, by script; no model): ${rows.length} matching line(s)`, ...rows.map(x => show(x.l))].join('\n'), data: { source: 'store' } }
    }
  }
  // (b) a FRESH small session with the handover and the question; the old session is never resumed
  const cfg = await readJson<{ ask?: { model?: unknown; effort?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null)
  const model = typeof cfg?.ask?.model === 'string' && cfg.ask.model ? cfg.ask.model : 'haiku'
  const effort = typeof cfg?.ask?.effort === 'string' && cfg.ask.effort ? cfg.ask.effort : 'low'
  const ho = await buildHandover(h, home, t, `A question about the thread is answered from this handover; no work is continued.`, [], false, undefined, true)
  const prompt = `Answer this question about thread ${id} in at most 5 lines, as a short report, using only the handover below (name the file when you cite one). If the handover does not say, answer "not in the store" and name what to read. Do not edit anything and do not start work.\n\nQuestion: ${q}\n\n--- handover of ${id} ---\n${ho.prompt}`
  const cwd = `${deskState(home)}/ask`
  await mkdirp(h, cwd).catch(() => undefined)
  const run = deps.run ?? (async (p, m, e, c) => {
    const r = await h.process.run(['claude', '-p', '--model', m, '--effort', e, '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--max-budget-usd', '0.25', '--', p], { cwd: c, timeoutMs: 120_000 })
    return { ok: r.exitCode === 0, text: (r.stdout || r.stderr).trim() }
  })
  const r = await run(prompt, model, effort, cwd).catch(e => ({ ok: false, text: String((e as Error)?.message ?? e) }))
  if (!r.ok || !r.text) return { ok: false, text: `${id}: no line of the store matches and the small session (${model}/${effort}) failed: ${clip(r.text || 'no output', 200)}` }
  return { ok: true, text: `${id} (fresh ${model}/${effort} session with the handover, ~${Math.ceil(prompt.length / 4)} tokens in; the old session was not touched): ${clip(r.text, 1_200)}`, data: { source: 'fresh' } }
}

// ---- report ----------------------------------------------------------------------------------------------------------------------
// a heading line of a report: `## Title`, `**Title**` or `Title:` alone on its line; level = the number of #s (the others count as 1)
const HEADING = /^\s{0,3}(?:(#{1,6})\s+(.+?)\s*#*|\*\*(.+?)\*\*:?|([A-Z][\w /&()-]{0,50}):)\s*$/
const headingOf = (line: string): { level: number; title: string } | null => {
  const m = HEADING.exec(line)
  return m ? { level: m[1] ? m[1].length : 1, title: (m[2] ?? m[3] ?? m[4] ?? '').trim() } : null
}
// the lines under the heading that contains `want` (case-insensitive), up to the next heading of the same or a higher level; null = none
export function sectionOf(text: string, want: string): { title: string; body: string } | { titles: string[] } {
  const lines = text.split('\n')
  const heads = lines.map((l, i) => ({ i, h: headingOf(l) })).filter((x): x is { i: number; h: { level: number; title: string } } => !!x.h)
  const w = want.trim().toLowerCase()
  const at = heads.find(x => x.h.title.toLowerCase().includes(w))
  if (!at || !w) return { titles: heads.map(x => x.h.title) }
  const next = heads.find(x => x.i > at.i && x.h.level <= at.h.level)
  return { title: at.h.title, body: lines.slice(at.i + 1, next ? next.i : lines.length).join('\n').trim() }
}

export async function reportText(h: Host, home: string, id: string, o: { section?: string; full?: boolean } = {}): Promise<Out> {
  const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
  if (!t) return { ok: false, text: `no thread ${id}` }
  const recs = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r.from === id && (r.kind === 'report' || r.kind === 'ask') && !(r as { mod?: boolean }).mod)
  const reports = recs.filter(r => r.kind === 'report')
  const asks = recs.filter(r => r.kind === 'ask')
  const last = reports[reports.length - 1]
  const lastAsk = asks[asks.length - 1]
  // more on demand: the newest report's whole text, or one section of it (the digest the desk got names this call)
  if (o.full || o.section) {
    if (!last) return { ok: false, text: `${id} has no report yet` }
    if (o.full) return { ok: true, text: `${id} report (${last.state || 'working'}), full text:\n${last.text.trim()}` }
    const s = sectionOf(last.text, o.section!)
    return 'body' in s ? { ok: true, text: `${id} report, section "${s.title}":\n${s.body || '(empty)'}` } : { ok: false, text: `${id}'s last report has no section "${o.section}"${s.titles.length ? `; its sections: ${s.titles.slice(0, 15).join(' | ')}` : ' (it has no headings: use full: true)'}` }
  }
  const open = asks.filter(a => !last || a.ts > last.ts)
  const snap = await readSnapshot(h, home, id)
  const ctx = await readContext(h, home, t)
  const sha = snap?.head ?? ''
  const verdict = !sha ? 'unknown (no snapshot yet)' : !t.project ? 'n/a (no project)' : (await greenReview(h, t.project, sha).catch(() => false)) ? 'green' : 'none for this sha'
  const newest = [last, lastAsk].filter((r): r is DeskRec => !!r).sort((a, b) => b.ts - a.ts)[0]
  let path = 'none (no report yet)'
  if (newest) {
    const f = reportFile(home, newest)
    path = (await h.fs.exists(f).catch(() => false)) ? f : `${deskState(home)}/inbox.jsonl (the row with ts ${newest.ts})`
  }
  const now = await h.clock.now()
  const age = last ? `${Math.max(0, Math.round((now - last.ts) / 60_000))} min ago` : ''
  const waits = t.state === 'open' && !t.finished ? await waitingOn(h, home, id) : null // "waiting for push", not "idle, no report yet" (waitevent.ts)
  return {
    ok: true,
    text: [
      `${id} (${t.title}): ${t.state}${t.finished ? ', finished' : ''}${waits ? ` · ${waits.text}` : ''}${last ? ` · last report ${last.state || 'working'} ${age}` : waits ? '' : ' · no report yet'}`,
      `sha: ${sha ? sha.slice(0, 10) : 'unknown'}${snap?.branch ? ` on ${snap.branch}` : ''} · review: ${verdict}${snap ? ` · tree: ${snap.status.length ? `${snap.status.length} changed file(s)` : 'clean'}` : ''}`,
      `open questions: ${open.length}${open.length ? ` (latest: ${clip(flat(String(open[open.length - 1]!.text)), 120)})` : ''} · reports: ${reports.length} · questions asked: ${asks.length}${ctx ? ` · context ${kTokens(ctx.tokens)}` : ''}`,
      `full text: ${path}`,
    ].join('\n'),
    data: { state: t.state, sha, verdict, open: open.length, reports: reports.length, asks: asks.length, path },
  }
}
