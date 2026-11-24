// PULL MODE (1.0.27): in core mode (handover.ts) a fresh session's first prompt holds only what changes behaviour; the rest is pulled when the
// next step needs it, by `lean_run {pull: "reports" | "notes" | "brief" | "snapshot" | "preflight", section?}` (the thread's own read-only tool;
// a thread has no lean_thread). A pull returns a SECTION, never the whole store: reports as a one-line list, then one report; notes and the
// brief as headings with line numbers, then one heading's text; the snapshot as field names, then the named fields; the preflight filtered by a word.
// Pure script, no model. Every answer is cut at PULL_MAX characters and says where the full text is.
import { readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskState, reportFile } from './delivery'
import type { DeskRec } from './delivery'
import { readSnapshot, snapshotFile } from './snapshot'
import type { Snapshot } from './snapshot'
import { NOTES_FILE } from './scratchnotes'
import { preflightOf } from './handover'
import { memoryPull } from './memorytool'
import type { Thread } from './threads'

export const PULL_KINDS = ['brief', 'reports', 'notes', 'snapshot', 'preflight', 'memory'] as const
export const PULL_MAX = 4_000
export const LIST_MAX = 30
const cut = (s: string, n: number, where: string) => (s.length <= n ? s : `${s.slice(0, n)}\n…(cut at ${n} characters: ${where})`)
const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

export type Heading = { line: number; level: number; title: string }
export function headingsOf(text: string): Heading[] {
  const out: Heading[] = []
  let fence = false
  text.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence
    const m = !fence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l) : null
    if (m) out.push({ line: i + 1, level: m[1]!.length, title: m[2]! })
  })
  return out
}
// the text under the first heading that contains `name` (case-insensitive), up to the next heading of the same or a higher level
export function sectionOf(text: string, name: string): string | null {
  const hs = headingsOf(text)
  const want = name.trim().toLowerCase()
  const at = hs.findIndex(h => h.title.toLowerCase() === want) >= 0 ? hs.findIndex(h => h.title.toLowerCase() === want) : hs.findIndex(h => h.title.toLowerCase().includes(want))
  if (at < 0 || !want) return null
  const next = hs.slice(at + 1).find(h => h.level <= hs[at]!.level)
  const lines = text.split('\n')
  return lines.slice(hs[at]!.line - 1, next ? next.line - 1 : lines.length).join('\n').trimEnd()
}

// headings (with line numbers) of a markdown file, or its first lines when it has none; with `section`: that section only
function docPull(file: string, label: string, text: string, section: string): string {
  if (!text.trim()) return `${label}: empty or missing (${file})`
  const lines = text.split('\n').length
  if (section) {
    const s = sectionOf(text, section)
    if (s === null) return `${label}: no heading matches "${section}" (${lines} lines; pull without a section lists the headings)`
    return `${label} · section "${section}" (${file}):\n${cut(s, PULL_MAX, `read ${file} with offset and limit`)}`
  }
  const hs = headingsOf(text)
  const head = hs.length ? hs.slice(0, 40).map(h => `  L${h.line} ${'#'.repeat(h.level)} ${h.title}`).join('\n') + (hs.length > 40 ? `\n  (+${hs.length - 40} more headings)` : '') : text.split('\n').filter(l => l.trim()).slice(0, 5).map(l => `  ${oneLine(l, 120)}`).join('\n') + '\n  (no headings: the first lines)'
  return `${label} (${file}, ${lines} lines) headings; pull with section "<heading>" for one:\n${head}`
}

async function reportsPull(h: Host, home: string, id: string, section: string): Promise<string> {
  const recs = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r && r.from === id && (r.kind === 'report' || r.kind === 'ask') && !(r as { mod?: boolean }).mod)
  if (!recs.length) return `no reports of ${id} in the desk inbox`
  const tag = (r: DeskRec) => (r.kind === 'ask' ? '[question]' : `[${r.state || 'working'}]`)
  if (!section) {
    const from = Math.max(0, recs.length - LIST_MAX)
    return [`${recs.length} reports of ${id}${from ? ` (the last ${LIST_MAX} listed)` : ''}; pull with section "<n>" (negative counts from the end: -1 is the last), or a word of its first line:`, ...recs.slice(from).map((r, i) => `  ${from + i + 1}. ${tag(r)} ${oneLine(r.text, 90)}`)].join('\n')
  }
  const n = /^-?\d+$/.test(section.trim()) ? Number(section) : 0
  const r = n > 0 ? recs[n - 1] : n < 0 ? recs[recs.length + n] : [...recs].reverse().find(x => x.text.toLowerCase().includes(section.trim().toLowerCase()))
  if (!r) return `no report matches "${section}" (${recs.length} reports; pull without a section lists them)`
  return `report ${recs.indexOf(r) + 1} of ${recs.length} ${tag(r)}:\n${cut(r.text.trim(), PULL_MAX, `full text in ${reportFile(home, r)}`)}`
}

const FIELDS: Record<string, (s: Snapshot) => string> = {
  branch: s => `branch: ${s.branch || '?'} · HEAD ${s.head ? s.head.slice(0, 10) : '?'}${s.headLine ? ` ${s.headLine}` : ''}${s.dir ? ` · in ${s.dir}` : ''}`,
  status: s => (s.status.length ? `git status --short:\n${s.status.map(x => `  ${x}`).join('\n')}` : 'git status --short: clean (or not readable)'),
  diff: s => (s.diffStat ? `diff stat:\n${s.diffStat}` : 'diff stat: none'),
  edited: s => (s.edited.length ? `edited in the last turn: ${s.edited.join(', ')}` : 'edited in the last turn: none'),
  tasks: s => (s.tasks.length ? `task list:\n${s.tasks.map(t => `  [${t.status}] ${t.text}`).join('\n')}` : 'task list: empty'),
  report: s => (s.lastReport ? `last report (${s.lastReport.state}): ${s.lastReport.text.replace(/\s+/g, ' ')}` : 'last report: none'),
  questions: s => (s.questions.length ? `open questions:\n${s.questions.map(q => `  - ${oneLine(q, 400)}`).join('\n')}` : 'open questions: none'),
  pending: s => (s.pending?.length ? `pending worker results (not acted on):\n${s.pending.map(p => `  - ${p.agent}: ${oneLine(p.text, 600)}`).join('\n')}` : 'pending worker results: none'),
  scratch: s => (s.scratch?.length ? `scratch files:\n${s.scratch.map(f => `  - ${f.name} (${f.size} B): ${f.first}`).join('\n')}` : 'scratch files: none'),
  context: s => `context at that time: ${s.tokens ?? '?'} tokens`,
}
async function snapshotPull(h: Host, home: string, id: string, section: string): Promise<string> {
  const s = await readSnapshot(h, home, id)
  if (!s) return `no state snapshot yet (${snapshotFile(home, id)}: written at the end of a turn)`
  if (!section.trim()) return `snapshot fields (${snapshotFile(home, id)}): pull with section "<field>,<field>":\n${Object.keys(FIELDS).map(k => `  ${k}: ${FIELDS[k]!(s).split('\n').length} line(s)`).join('\n')}`
  const want = section.split(/[\s,]+/).filter(Boolean)
  const bad = want.filter(w => !FIELDS[w])
  if (bad.length) return `unknown snapshot field ${bad.join(', ')} (fields: ${Object.keys(FIELDS).join(', ')})`
  return cut(want.map(w => FIELDS[w]!(s)).join('\n'), PULL_MAX, `the whole record is ${snapshotFile(home, id)}`)
}

export async function pullText(h: Host, home: string, id: string, kind: string, section = ''): Promise<string> {
  try {
    const dir = `${threadsDir(home)}/${id}`
    const text = async (p: string) => {
      const r = await h.fs.read(p).catch(() => '')
      return typeof r === 'string' ? r : ''
    }
    if (kind === 'memory') return await memoryPull(h, home, id, section) // the standing orders and the rest the thread may see (memory.ts)
    if (kind === 'reports') return await reportsPull(h, home, id, section)
    if (kind === 'snapshot') return await snapshotPull(h, home, id, section)
    if (kind === 'brief') return docPull(`${dir}/brief.md`, 'brief', await text(`${dir}/brief.md`), section)
    if (kind === 'notes') {
      const files = [`${dir}/${NOTES_FILE}`, `${dir}/scratch/${NOTES_FILE}`]
      const docs = await Promise.all(files.map(async f => ({ f, t: await text(f) })))
      const have = docs.filter(d => d.t.trim())
      if (!have.length) return `no notes yet (${files.join(', ')})`
      if (section) {
        const hit = have.find(d => sectionOf(d.t, section) !== null)
        return docPull(hit?.f ?? have[0]!.f, 'notes', (hit ?? have[0]!).t, section)
      }
      return have.map(d => docPull(d.f, 'notes', d.t, '')).join('\n')
    }
    if (kind === 'preflight') {
      const t = await readJson<Thread | null>(h, `${dir}/thread.json`, null)
      if (!t) return `no thread ${id}`
      const pre = await preflightOf(h, home, t)
      if (!pre) return 'preflight: nothing to report'
      const lines = section ? pre.split('\n').filter(l => l.toLowerCase().includes(section.toLowerCase())) : pre.split('\n')
      return lines.length ? cut(lines.join('\n'), PULL_MAX, `${dir}/preflight`) : `preflight: no line contains "${section}"`
    }
    return `pull: kind must be one of ${PULL_KINDS.join(', ')}`
  } catch (err) {
    return `pull failed: ${String((err as Error)?.message ?? err)}`
  }
}
