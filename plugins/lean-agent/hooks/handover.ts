// The handover prompt of a fresh session for an existing thread (a reopen, or a resume that must start fresh because the old
// session runs older lean-agent code). Built by the mod from what lean-agent already keeps; the old conversation is never resumed.
import { atomicWrite, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { approvalOf, deskState, reportBody, reportFile, unconsumed } from './delivery'
import type { DeskRec } from './delivery'
import { readSnapshot, snapshotFile, snapshotText } from './snapshot'
import { retireText } from './forgewrite'
import { HANDOVER_RULE, NOTES_FILE, listText, scratchList, scratchNotes } from './scratchnotes'
import type { Inbox, Thread } from './threads'

export const REPORT_BUDGET = 16_000 // chars of report history (about 4k tokens); the newest report is always kept whole
const OLD_REPORT_MAX = 700 // an older report is cut to this
const NEWEST_REPORT_MAX = 20_000 // the newest is whole up to this (the prompt is one argv string: Linux caps a single one at 128 KB)
const QUEUED_EACH = 1_000 // a desk message in the corrections, cut to this
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

export type Handover = { prompt: string; worktree?: string; branch?: string; parts?: Part[]; missing?: string[] }

// The first words of a restart, wake or handover prompt are the task: a model that reads "continue" plus a status check answers the
// status check and ends its turn. A status request is answered as a side effect (one short lean_report), never as the whole turn.
export const STATUS_RULE = 'Answer status requests with a short lean_report as a side effect, never as the whole turn.'
export const TASK_MAX = 200
export const resumeLead = (task: string) => `Resume the work now (task: ${task}). ${STATUS_RULE}`
// the one-line task of a thread: its goal, else the first line of its brief, else its title
export const taskLine = (goal: string, brief: string, title: string): string => {
  const first = (s: string) => s.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
  const t = first(goal) || first(brief) || title
  return t.length > TASK_MAX ? t.slice(0, TASK_MAX) + '…' : t
}
export async function taskOf(h: Host, home: string, t: Thread): Promise<string> {
  const goals = await readJson<Record<string, { text?: string }>>(h, `${leanDir(home)}/goals.json`, {})
  const goal = typeof goals?.[t.id]?.text === 'string' ? goals[t.id]!.text! : t.lastGoal ?? ''
  const brief = await h.fs.read(`${threadsDir(home)}/${t.id}/brief.md`).catch(() => '')
  return taskLine(goal, typeof brief === 'string' ? brief : '', t.title)
}

// The prompt of a thread restarted at the context limit while it WAITED (its last report was blocked or a question): script-built from the
// store, the open question / request verbatim with its id. null = the last report is not an open question (nothing to wait for).
export const OPEN_MAX = 2000
export function waitingLead(recs: DeskRec[]): string | null {
  const last = recs[recs.length - 1]
  if (!last || !(last.kind === 'ask' || last.state === 'blocked')) return null
  const ap = approvalOf(last)
  const body = `${last.text.length > OPEN_MAX ? `${last.text.slice(0, OPEN_MAX)} [cut]` : last.text}${ap ? ` [needs the user's yes: ${ap}]` : ''}`
  return `You were restarted at the context limit while WAITING for: ${last.ts}-${last.from}-${last.kind}: ${body}. If the answer is in the messages below, act on it. If not, do nothing: end your turn without a report and wait.`
}

// A text the desk gave to restart / reopen / start / wake / resume (threads.ts queues it flagged `instr`) is the LAST part of the first prompt, after
// the handover, under this heading, and the task-first line points at it. It is never cut with the handover (it is added after the cap).
export const INSTR_HEAD = 'New instructions from the desk (newer than the handover above; they win where they differ):'
export const INSTR_EACH = 12_000
export const INSTR_LEAD = 'New instructions from the desk are at the END of this prompt: read them first; they are newer than everything else here and win where they differ.'
export const instrBlock = (msgs: Inbox[]): string => {
  const m = msgs.filter(x => x.instr)
  return m.length ? `${INSTR_HEAD}\n${m.map(x => (flat(x.text).length > INSTR_EACH ? `${flat(x.text).slice(0, INSTR_EACH)}\n…(cut at ${INSTR_EACH} characters; the full text is in your inbox.jsonl)` : flat(x.text))).join('\n\n')}` : ''
}

// ---- the brief is the OLDEST word: what the desk said to the thread since wins over it -----------------------------------------------
export const CORRECTIONS_HEAD = 'These came after the brief and win where they differ:'
export const CORRECTIONS_MAX = 30 // newest messages kept; older ones are a count
export const FOREIGN_NOTE = "(another thread's folder: use your own scratch/ or ask the desk to copy it)"
// A path in the brief that points into ANOTHER thread's folder (threads/tM/..., M != N) is flagged: the thread cannot count on reading it.
export function flagForeignPaths(brief: string, id: string): string {
  return brief.replace(/[^\s()'"`,;[\]]*\bthreads\/t(\d+)(?:\/[^\s()'"`,;[\]]*)?/g, (m, n: string) => (`t${n}` === id ? m : `${m} ${FOREIGN_NOTE}`))
}
export const timeText = (ts: number): string => (Number.isFinite(ts) ? `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')}Z` : '?')
// every message the desk sent the thread after its start (queued, delivered, the text of a restart / wake / resume), newest last, each with its time.
// `rows`: the thread's inbox.jsonl, `queued`: what is queued now (not yet in the file when the caller runs before the write); `instr`: the texts of
// THIS start, which the prompt carries whole at its end (a pointer here, not a second copy).
export function corrections(rows: Inbox[], queued: Inbox[], created: number): { lines: string[]; older: number } {
  const seen = new Set<string>()
  const all: Inbox[] = []
  for (const m of [...rows, ...queued]) {
    if (!m || typeof m.text !== 'string' || !Number.isFinite(m.ts) || m.ts < created) continue
    const k = `${m.ts}|${m.text}`
    if (seen.has(k)) continue
    seen.add(k)
    all.push(m)
  }
  all.sort((a, b) => a.ts - b.ts)
  const now = new Set(queued.filter(m => m.instr).map(m => `${m.ts}|${m.text}`))
  const line = (m: Inbox) => `- ${timeText(m.ts)} ${m.from ? `[${m.from}] ` : ''}${now.has(`${m.ts}|${m.text}`) ? '(the text given to this start: at the END of this prompt)' : `${m.instr ? '(text given to a restart / wake) ' : ''}${cut(flat(m.text), QUEUED_EACH)}`}`
  return { lines: all.slice(-CORRECTIONS_MAX).map(line), older: Math.max(0, all.length - CORRECTIONS_MAX) }
}

export async function buildHandover(h: Host, home: string, t: Thread, why: string, queuedAll: Inbox[], waiting = false): Promise<Handover> {
  const dir = `${threadsDir(home)}/${t.id}`
  const instr = queuedAll.filter(m => m.instr)
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
  const recs = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r.from === t.id && (r.kind === 'report' || r.kind === 'ask') && !(r as { mod?: boolean }).mod)
  // a cut report line names the file with its full text (written now when the desk never made one); no file = the inbox, by row time
  const none = await ensureReportFiles(h, home, reportHistory(recs).cutRecs)
  const hist = reportHistory(recs, REPORT_BUDGET, r => (none.has(r) ? `${deskState(home)}/inbox.jsonl (the row with ts ${r.ts})` : reportFile(home, r)))
  const mem = (await readJsonl<{ from?: string; text?: string }>(h, `${leanDir(home)}/memory/notes.jsonl`)).filter(m => m.from === t.id && typeof m.text === 'string').slice(-REMEMBER_MAX).map(m => ({ ...m, text: retireText(m.text!) })) // (a forge write by script is retired, not passed on)
  const where = [t.project && `project: ${t.project}`, wt?.path && `worktree: ${wt.path}`, wt?.branch && `branch: ${wt.branch}`, t.model && `model: ${t.model}/${t.effort ?? ''}`].filter(Boolean).join(' · ')
  const now = await h.clock.now()
  const snap = await readSnapshot(h, home, t.id)
  const pre = await preflightOf(h, home, t)
  const scratchNotesText = await scratchNotes(h, dir) // the reading the last session kept (scratchnotes.ts): a restart must not redo it
  const scratchFiles = await scratchList(h, dir)
  const inbox =`${deskState(home)}/inbox.jsonl`
  const wait = waiting ? waitingLead(recs) : null // restarted at the limit while waiting: the open question is the lead, nothing to carry on with
  // everything the desk sent this thread after its start (queued, delivered, to a session that has ended, the text of a restart / wake / resume, the
  // results of the actions the desk made for it), newest last, right after the brief: it is newer than the brief and wins where they differ.
  const corr = corrections(await readJsonl<Inbox>(h, `${dir}/inbox.jsonl`), queuedAll, Number.isFinite(t.created) ? t.created : 0)
  const parts: Part[] = [
    { name: 'lead', body: `${wait ?? resumeLead(taskLine(goal, brief, t.title))}${instr.length ? ` ${INSTR_LEAD}` : ''}`, mode: 'fixed' },
    { name: 'intro', body: `[lean-agent] You are thread ${t.id} (${t.title}), started again as a NEW session. ${why} The earlier conversation is not available to you; everything lean-agent kept is below.`, mode: 'fixed' },
    { name: 'check', body: wait ? '' : `Before you continue, check the real state yourself${wt?.path ? ` (git -C ${wt.path} status -sb, git -C ${wt.path} log -5 --oneline)` : ''}: the reports below can be older than the files. Then carry on and report with lean_report.`, mode: 'fixed' },
    { name: 'brief', head: '## Brief', body: cut(flagForeignPaths(brief, t.id), BRIEF_MAX), file: `${dir}/brief.md`, mode: 'head' },
    { name: 'corrections', head: `## Corrections since the brief\n${CORRECTIONS_HEAD}`, body: corr.lines.length ? `${corr.older ? `(${corr.older} older messages omitted: ${dir}/inbox.jsonl)\n` : ''}${corr.lines.join('\n')}` : '', file: `${dir}/inbox.jsonl`, mode: 'lines' },
    { name: 'where', head: '## Where the work lives', body: where, mode: 'fixed' },
    { name: 'goal', head: '## Goal', body: goal, mode: 'fixed' },
    { name: 'snapshot', head: '## State at the end of the last turn (state.json)', body: snap ? snapshotText(snap, now) : '', file: snapshotFile(home, t.id), mode: 'head' },
    { name: 'preflight', head: '## Preflight', body: pre, file: `${dir}/preflight`, mode: 'head' },
    { name: 'reports', head: `## Your reports so far (oldest first${hist.omitted ? `; ${hist.omitted} older omitted` : ''})`, body: hist.lines.join('\n'), file: inbox, mode: 'lines' },
    { name: 'notes', head: '## Your notes (end of notes.md)', body: notes ? cut(notes, NOTES_MAX, true) : '', file: `${dir}/notes.md`, mode: 'tail' },
    { name: 'scratchrule', body: scratchNotesText || scratchFiles.length ? `Your earlier reading is kept: ${HANDOVER_RULE}.` : '', mode: 'fixed' },
    { name: 'scratchnotes', head: '## Your scratch notes (end of scratch/notes.md)', body: scratchNotesText, file: `${dir}/scratch/${NOTES_FILE}`, mode: 'tail' },
    { name: 'scratchlist', head: '## Scratch files (name, size, first line)', body: scratchFiles.length ? listText(scratchFiles) : '', file: `${dir}/scratch`, mode: 'lines' },
    { name: 'remembered', head: '## What you asked to remember', body: mem.map(m => `- ${cut(flat(m.text!), 300)}`).join('\n'), file: `${leanDir(home)}/memory/notes.jsonl`, mode: 'lines' },
  ]
  const missing = [!goal && 'no goal (goal-set tN "<line>")', !notes && `no notes (${dir}/notes.md)`, !snap && `no snapshot (${snapshotFile(home, t.id)}: written at the end of the thread's next turn)`, !hist.lines.length && 'no report of this thread in the desk inbox'].filter((x): x is string => !!x)
  const sized = fitParts(parts, (await handoverTokens(h, home)) * 4)
  const tail = instrBlock(instr) // the desk's own instructions: last, whole, after the cap
  const base = cutPrompt(sized.map(partText).filter(Boolean).join('\n\n'))
  return { prompt: tail ? `${base}\n\n${tail}` : base, worktree: wt?.path, branch: wt?.branch, parts: tail ? [...sized, { name: 'instructions', head: INSTR_HEAD, body: tail.slice(INSTR_HEAD.length + 1), mode: 'fixed' as const }] : sized, missing }
}

// ---- the size budget -------------------------------------------------------------------------------------------------------------
export const HANDOVER_TOKENS = 6_000 // config handoverTokens: the handover is cut to about this many tokens (four characters a token)
export async function handoverTokens(h: Host, home: string): Promise<number> {
  const cfg = await readJson<{ handoverTokens?: unknown } | null>(h, `${leanDir(home)}/config.json`, null)
  const n = Number(cfg?.handoverTokens)
  return Number.isFinite(n) && n >= 500 ? Math.round(n) : HANDOVER_TOKENS
}

export type Part = { name: string; head?: string; body: string; file?: string; mode: 'fixed' | 'head' | 'tail' | 'lines'; cut?: boolean }
export const partText = (p: Part): string => (p.body ? (p.head ? `${p.head}\n${p.body}` : p.body) : '')
const CUT_ORDER = ['remembered', 'scratchlist', 'notes', 'reports', 'scratchnotes', 'corrections', 'brief', 'preflight', 'snapshot'] // the first to lose text is the least needed
const FLOOR = 300 // a section is never cut below this many characters
const noteOf = (p: Part) => `\n…(cut to fit the handover budget: full text in ${p.file ?? 'its source'})`
const total = (parts: Part[]) => parts.reduce((n, p) => n + (p.body ? partText(p).length + 2 : 0), 0)

// Trim to `maxChars`: sections lose text in CUT_ORDER, newest kept first (a list drops its oldest lines, notes keep their end);
// every cut names the file with the full text. The fixed lines and the goal are never cut.
export function fitParts(parts: Part[], maxChars: number): Part[] {
  const out = parts.map(p => ({ ...p }))
  for (const name of CUT_ORDER) {
    if (total(out) <= maxChars) break
    const p = out.find(x => x.name === name && x.body)
    if (!p) continue
    if (p.mode === 'lines') {
      const ls = p.body.split('\n')
      let dropped = 0
      while (ls.length > 1 && total(out) + (dropped ? 0 : noteOf(p).length) > maxChars) {
        ls.shift()
        p.body = ls.join('\n')
        dropped++
      }
      if (dropped) {
        p.body += noteOf(p)
        p.cut = true
      }
    } else {
      const excess = total(out) - maxChars
      const take = Math.min(Math.max(0, p.body.length - FLOOR), excess + noteOf(p).length)
      if (take <= 0) continue
      p.body = p.mode === 'tail' ? '…' + p.body.slice(take) + noteOf(p) : p.body.slice(0, p.body.length - take) + '…' + noteOf(p)
      p.cut = true
    }
  }
  return out
}

// The preflight text of the thread (hooks/preflight.ts, added by another change). A hooks module cannot import() lazily, and a static
// import of a file that does not exist would fail the load: so that module registers itself with `setPreflight(preflightText)` (one line
// at its top level); until it does, or when it fails, the section is empty.
export type PreflightFn = (h: Host, home: string, t: Thread) => Promise<string> | string
let preflight: PreflightFn | null = null
export const setPreflight = (fn: PreflightFn | null) => {
  preflight = fn
}
async function preflightOf(h: Host, home: string, t: Thread): Promise<string> {
  try {
    const s = preflight ? await preflight(h, home, t) : ''
    return typeof s === 'string' ? s.trim() : ''
  } catch {
    return ''
  }
}

// `lean_doctor handover tN`: exactly what a fresh session would get, the tokens of each section, what is missing.
export async function handoverReport(h: Host, home: string, id: string): Promise<string> {
  const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
  if (!t || typeof t !== 'object') return `no thread ${id}`
  const queued = (await unconsumed(h, home, id).catch(() => ({ msgs: [] as Inbox[] }))).msgs
  const ho = await buildHandover(h, home, t, 'This is a preview of the handover.', queued)
  const budget = await handoverTokens(h, home)
  const tok = (s: string) => Math.ceil(s.length / 4)
  const rows = (ho.parts ?? []).filter(p => p.body).map(p => `  ${p.name.padEnd(10)} ~${String(tok(partText(p))).padStart(5)} tokens${p.cut ? `  (cut: full text in ${p.file})` : ''}`)
  const all = tok(ho.prompt)
  return [
    `handover for ${id} (${t.title}): ~${all} tokens of a budget of ${budget} (config handoverTokens)${all > budget ? ' (over: the fixed lines are never cut)' : ''}`,
    'sections:',
    ...rows,
    ho.missing?.length ? `missing: ${ho.missing.join('; ')}` : 'missing: nothing',
    '--- the prompt, as a fresh session gets it ---',
    ho.prompt,
  ].join('\n')
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
