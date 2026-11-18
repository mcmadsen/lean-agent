// The handover prompt of a fresh session for an existing thread (a reopen, or a resume that must start fresh because the old
// session runs older lean-agent code). Built by the mod from what lean-agent already keeps; the old conversation is never resumed.
import { leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import type { Inbox, Thread } from './threads'

export const REPORT_BUDGET = 16_000 // chars of report history (about 4k tokens); the newest report is always kept whole
const OLD_REPORT_MAX = 700 // an older report is cut to this
const BRIEF_MAX = 6_000
const NOTES_MAX = 3_000
const REMEMBER_MAX = 20
const flat = (s: string) => s.replace(/\r/g, '').trim()
const cut = (s: string, n: number, tail = false) => (s.length <= n ? s : tail ? '…' + s.slice(s.length - n) : s.slice(0, n) + '…')

// The reports of one thread, oldest first, inside the budget: the newest whole, older ones newest-first while they fit.
export function reportHistory(recs: DeskRec[], budget = REPORT_BUDGET): { lines: string[]; omitted: number } {
  const line = (r: DeskRec, max: number) => `- ${r.kind === 'ask' ? '[question]' : `[${r.state || 'working'}]${r.superseded ? ' [brief superseded]' : ''}`} ${cut(flat(r.text), max)}`
  const kept: string[] = []
  let used = 0
  let omitted = 0
  for (let i = recs.length - 1; i >= 0; i--) {
    const l = line(recs[i]!, i === recs.length - 1 ? Number.MAX_SAFE_INTEGER : OLD_REPORT_MAX)
    if (kept.length && used + l.length > budget) {
      omitted = i + 1
      break
    }
    kept.unshift(l)
    used += l.length
  }
  return { lines: kept, omitted }
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
  const hist = reportHistory(recs)
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
    queued.length && `## Messages from the desk that were queued for you\n${queued.map(m => `- ${m.from ? `[${m.from}] ` : ''}${flat(m.text)}`).join('\n')}`,
  ].filter(Boolean)
  return { prompt: parts.join('\n\n'), worktree: wt?.path, branch: wt?.branch }
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
