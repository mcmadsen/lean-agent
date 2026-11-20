// The handover prompt of a fresh session for an existing thread (a reopen, or a resume that must start fresh because the old
// session runs older lean-agent code). Built by the mod from what lean-agent already keeps; the old conversation is never resumed.
import { atomicWrite, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskState, reportBody, reportFile } from './delivery'
import type { DeskRec } from './delivery'
import type { Inbox, Thread } from './threads'

export const REPORT_BUDGET = 16_000 // chars of report history (about 4k tokens); the newest report is always kept whole
const OLD_REPORT_MAX = 700 // an older report is cut to this
const NEWEST_REPORT_MAX = 20_000 // the newest is whole up to this (the prompt is one argv string: Linux caps a single one at 128 KB)
const QUEUED_MAX = 20 // queued desk messages, each cut to QUEUED_EACH
const QUEUED_EACH = 1_000
export const PROMPT_MAX = 80_000 // hard cap on the whole handover prompt (the parts above add up to about 60k at most)
const BRIEF_MAX = 6_000
const NOTES_MAX = 3_000
const REMEMBER_MAX = 20
const flat = (s: string) => s.replace(/\r/g, '').trim()
const cut = (s: string, n: number, tail = false) => (s.length <= n ? s : tail ? '…' + s.slice(s.length - n) : s.slice(0, n) + '…')

// The reports of one thread, oldest first, inside the budget: the newest whole, older ones newest-first while they fit.
// `pathOf`: where the FULL text of a report is (desk/reports/<file>); a line that is cut names it, so the new session can Read the rest
// instead of guessing. `cutRecs` are the reports whose line was cut (the caller makes sure their file exists).
export function reportHistory(recs: DeskRec[], budget = REPORT_BUDGET, pathOf?: (r: DeskRec) => string): { lines: string[]; omitted: number; cutRecs: DeskRec[] } {
  const cutRecs: DeskRec[] = []
  const line = (r: DeskRec, max: number) => {
    const text = flat(r.text)
    const isCut = text.length > max
    return `- ${r.kind === 'ask' ? '[question]' : `[${r.state || 'working'}]${r.superseded ? ' [brief superseded]' : ''}`} ${cut(text, max)}${isCut && pathOf ? ` (cut: full text in ${pathOf(r)})` : ''}`
  }
  const kept: string[] = []
  let used = 0
  let omitted = 0
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]!
    const max = i === recs.length - 1 ? NEWEST_REPORT_MAX : OLD_REPORT_MAX
    const l = line(r, max)
    if (kept.length && used + l.length > budget) {
      omitted = i + 1
      break
    }
    kept.unshift(l)
    if (flat(r.text).length > max) cutRecs.unshift(r)
    used += l.length
  }
  return { lines: kept, omitted, cutRecs }
}

// Make sure the full text of every cut report is in desk/reports/<ts>-<from>-<kind>.md (the file a long direct send wrote; a short
// report, or one pruned after 30 days, has none): written now when missing. Returns the reports that still have no file (a write failed).
async function ensureReportFiles(h: Host, home: string, recs: DeskRec[]): Promise<Set<DeskRec>> {
  const none = new Set<DeskRec>()
  for (const r of recs) {
    const path = reportFile(home, r)
    if (await h.fs.exists(path).catch(() => false)) continue
    await atomicWrite(h, path, reportBody(r)).catch(() => none.add(r))
  }
  return none
}

export type Handover = { prompt: string; worktree?: string; branch?: string }

export async function buildHandover(h: Host, home: string, t: Thread, why: string, queued: Inbox[]): Promise<Handover> {
  const dir = `${threadsDir(home)}/${t.id}`
  const text = async (p: string) => {
    const r = await h.fs.read(p).catch(() => '')
    return typeof r === 'string' ? r : ''
  }
  const brief = flat(await text(`${dir}/brief.md`)) || t.title
  const notes = flat(await text(`${dir}/notes.md`))
  const reg = await readJson<Record<string, { path?: string; branch?: string; thread?: string }>>(h, `${leanDir(home)}/worktrees.json`, {})
  const mine = Object.values(reg && typeof reg === 'object' ? reg : {}).filter(w => w && w.thread === t.id && typeof w.path === 'string')
  const wt = mine[mine.length - 1]
  const goals = await readJson<Record<string, { text?: string }>>(h, `${leanDir(home)}/goals.json`, {})
  const goal = (typeof goals?.[t.id]?.text === 'string' ? goals[t.id]!.text!.trim() : '') || (t.lastGoal ?? '').trim()
  const recs = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r.from === t.id && (r.kind === 'report' || r.kind === 'ask'))
  // a cut report line names the file with its full text (written now when the desk never made one); no file = the inbox, by row time
  const none = await ensureReportFiles(h, home, reportHistory(recs).cutRecs)
  const hist = reportHistory(recs, REPORT_BUDGET, r => (none.has(r) ? `${deskState(home)}/inbox.jsonl (the row with ts ${r.ts})` : reportFile(home, r)))
  const mem = (await readJsonl<{ from?: string; text?: string }>(h, `${leanDir(home)}/memory/notes.jsonl`)).filter(m => m.from === t.id && typeof m.text === 'string').slice(-REMEMBER_MAX)
  const where = [t.project && `project: ${t.project}`, wt?.path && `worktree: ${wt.path}`, wt?.branch && `branch: ${wt.branch}`, t.model && `model: ${t.model}/${t.effort ?? ''}`].filter(Boolean).join(' · ')
  const parts = [
    `[lean-agent] You are thread ${t.id} (${t.title}), started again as a NEW session. ${why} The earlier conversation is not available to you; everything lean-agent kept is below.`,
    `Before you continue, check the real state yourself${wt?.path ? ` (git -C ${wt.path} status -sb, git -C ${wt.path} log -5 --oneline)` : ''}: the reports below can be older than the files. Then carry on and report with lean_report.`,
    `## Brief\n${cut(brief, BRIEF_MAX)}`,
    where && `## Where the work lives\n${where}`,
    goal && `## Goal\n${goal}`,
    hist.lines.length && `## Your reports so far (oldest first${hist.omitted ? `; ${hist.omitted} older omitted` : ''})\n${hist.lines.join('\n')}`,
    notes && `## Your notes (end of notes.md)\n${cut(notes, NOTES_MAX, true)}`,
    mem.length && `## What you asked to remember\n${mem.map(m => `- ${cut(flat(m.text!), 300)}`).join('\n')}`,
    queued.length && `## Messages from the desk that were queued for you\n${queued.slice(-QUEUED_MAX).map(m => `- ${m.from ? `[${m.from}] ` : ''}${cut(flat(m.text), QUEUED_EACH)}`).join('\n')}${queued.length > QUEUED_MAX ? `\n(${queued.length - QUEUED_MAX} older messages omitted)` : ''}`,
  ].filter(Boolean)
  const prompt = parts.join('\n\n')
  return { prompt: cutPrompt(prompt), worktree: wt?.path, branch: wt?.branch }
}

// The cap is in characters AND in bytes: the prompt is one argv string, and with 3-byte characters (CJK, emoji) 80,000 characters
// are 240 KB, past what the OS passes to a process (E2BIG: the reopen would fail to start).
export const PROMPT_MAX_BYTES = 100_000
const utf8 = new TextEncoder()
export function cutPrompt(prompt: string): string {
  if (prompt.length <= PROMPT_MAX && utf8.encode(prompt).length <= PROMPT_MAX_BYTES) return prompt
  let cut = prompt.slice(0, PROMPT_MAX)
  while (utf8.encode(cut).length > PROMPT_MAX_BYTES) cut = cut.slice(0, Math.max(0, cut.length - Math.ceil((utf8.encode(cut).length - PROMPT_MAX_BYTES) / 3) - 1))
  return cut.replace(/[\ud800-\udbff]$/, '') + '\n…(handover cut: read brief.md, notes.md and the desk inbox for the rest)'
}

// "1.0.4" < "1.0.10": numeric by part; an empty or unreadable version is unknown (never older)
export function olderVersion(recorded: string | undefined, installed: string): boolean {
  const num = (v: string | undefined) => {
    const m = /^\d+(\.\d+){0,3}/.exec((v ?? '').trim())
    return m ? m[0].split('.').map(Number) : null
  }
  const a = num(recorded)
  const b = num(installed)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

export async function pluginVersion(h: Host, root: string): Promise<string> {
  const v = await readJson<{ version?: unknown }>(h, `${root}/.claude-plugin/plugin.json`, {})
  return typeof v?.version === 'string' ? v.version : ''
}
