// The handover prompt of a fresh session for an existing thread (a reopen, or a resume that must start fresh because the old
// session runs older lean-agent code). Built by the mod from what lean-agent already keeps; the old conversation is never resumed.
import { atomicWrite, leanDir, readJson, readJsonl, threadsDir } from './state'
import type { Host } from './state'
import { approvalOf, deskState, reportBody, reportFile, unconsumed } from './delivery'
import type { DeskRec } from './delivery'
import { GIT_LINE, readSnapshot, snapshotFile, snapshotText } from './snapshot'
import { retireText } from './forgewrite'
import { HANDOVER_RULE, NOTES_FILE, scratchList, scratchNotes } from './scratchnotes'
import { NOTE_FILES_MAX, READ_FIRST, lookupNotes, noteLine } from './threadnotes'
import type { Inbox, Thread } from './threads'

export const REPORT_DIGESTS = 3 // 1.0.27: the restart prompt carries the last 3 reports as digests (state, first 200 characters, file path), the rest is a count
export const DIGEST_CHARS = 200
export const SNAPSHOT_MAX = 1_500 // chars of the state snapshot in the prompt (the file has the rest)
export const PREFLIGHT_MAX = 800 // chars of the preflight in the prompt
const QUEUED_EACH = 1_000 // a desk message in the corrections, cut to this
export const PROMPT_MAX = 80_000 // hard cap on the whole handover prompt (the parts above add up to about 60k at most)
const BRIEF_MAX = 6_000
const NOTES_MAX = 3_000
const REMEMBER_MAX = 20
const flat = (s: string) => s.replace(/\r/g, '').trim()
const cut = (s: string, n: number, tail = false) => (s.length <= n ? s : tail ? '…' + s.slice(s.length - n) : s.slice(0, n) + '…')

// The reports of one thread, oldest first: the LAST 3 as digests (state, first 200 characters, the file with the full text when cut), older ones
// only counted (the head says `lean_thread report tN`). `pathOf`: where the FULL text of a report is (desk/reports/<file>).
// `cutRecs` are the reports whose line was cut (the caller makes sure their file exists).
export function reportHistory(recs: DeskRec[], pathOf?: (r: DeskRec) => string): { lines: string[]; omitted: number; cutRecs: DeskRec[] } {
  const cutRecs: DeskRec[] = []
  const lines = recs.slice(-REPORT_DIGESTS).map(r => {
    const text = flat(r.text)
    const isCut = text.length > DIGEST_CHARS
    if (isCut) cutRecs.push(r)
    return `- ${r.kind === 'ask' ? '[question]' : `[${r.state || 'working'}]${r.superseded ? ' [brief superseded]' : ''}`} ${cut(text, DIGEST_CHARS)}${isCut && pathOf ? ` (cut: full text in ${pathOf(r)})` : ''}`
  })
  return { lines, omitted: Math.max(0, recs.length - REPORT_DIGESTS), cutRecs }
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

// notes: the files of the notes lookup (threadnotes.ts): carried with their text, listed by name, found but left out
export type Handover = { prompt: string; worktree?: string; branch?: string; parts?: Part[]; missing?: string[]; notes?: { content: string[]; listed: string[]; left: string[]; scratchNotes: boolean } }

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
  const ok = (m: Inbox) => !!m && typeof m.text === 'string' && Number.isFinite(m.ts) && m.ts >= created
  const all: Inbox[] = rows.filter(ok) // (the file's rows all count, also equal ones)
  const inFile = new Set(all.map(m => `${m.ts}|${m.text}`))
  for (const m of queued) if (ok(m) && !inFile.has(`${m.ts}|${m.text}`)) all.push(m) // queued and not yet in the file: once
  all.sort((a, b) => a.ts - b.ts)
  const now = new Set(queued.filter(m => m.instr).map(m => `${m.ts}|${m.text}`))
  const line = (m: Inbox) => `- ${timeText(m.ts)} ${m.from ? `[${m.from}] ` : ''}${now.has(`${m.ts}|${m.text}`) ? '(the text given to this start: at the END of this prompt)' : `${m.instr ? '(text given to a restart / wake) ' : ''}${cut(flat(m.text), QUEUED_EACH)}`}`
  return { lines: all.slice(-CORRECTIONS_MAX).map(line), older: Math.max(0, all.length - CORRECTIONS_MAX) }
}

// ---- the pull mode (1.0.27): config.json `handover.mode` ---------------------------------------------------------------------------------
// "core" (default): the first prompt holds ONLY what changes behaviour (about CORE_TOKENS), script-built; the rest is a pull list of one-line
// commands with sizes (pull.ts: `lean_run {pull}` returns a section, not the whole store). "full": the bounded prompt (handoverTokens).
export type HandoverMode = 'core' | 'full'
export const CORE_TOKENS = 1_500
export const CORE_BRIEF = 600 // characters of the brief in the core prompt
export const CORE_CORRECTIONS = 5
const CORE_EACH = 240 // characters of one correction
export async function handoverMode(h: Host, home: string): Promise<HandoverMode> {
  const cfg = await readJson<{ handover?: { mode?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null)
  return cfg?.handover?.mode === 'full' ? 'full' : 'core'
}
const lastLine = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? ''

export async function buildHandover(h: Host, home: string, t: Thread, why: string, queuedAll: Inbox[], waiting = false, modeIn?: HandoverMode): Promise<Handover> {
  const mode = modeIn ?? (await handoverMode(h, home))
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
  // no goal set: the first line of the brief is the goal, never "no goal" for a thread that has a brief
  const briefFirst = taskLine('', flat(await text(`${dir}/brief.md`)), '')
  const goalText = goal || (briefFirst ? `goal: ${briefFirst}` : '')
  const nl = await lookupNotes(h, dir)
  const progress = nl.content.find(f => f.path !== 'notes.md')
  const progressText = progress ? flat(await text(`${dir}/${progress.path}`)) : ''
  const recs = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r.from === t.id && (r.kind === 'report' || r.kind === 'ask') && !(r as { mod?: boolean }).mod)
  // a cut report line names the file with its full text (written now when the desk never made one); no file = the inbox, by row time
  const none = await ensureReportFiles(h, home, reportHistory(recs).cutRecs)
  const capped = (s: string, n: number, file: string) => (s.length > n ? `${s.slice(0, n)}\n…(cut to ${n} characters: full text in ${file})` : s)
  const hist = reportHistory(recs, r => (none.has(r) ? `${deskState(home)}/inbox.jsonl (the row with ts ${r.ts})` : reportFile(home, r)))
  const mem = (await readJsonl<{ from?: string; text?: string }>(h, `${leanDir(home)}/memory/notes.jsonl`)).filter(m => m.from === t.id && typeof m.text === 'string').slice(-REMEMBER_MAX).map(m => ({ ...m, text: retireText(m.text!) })) // (a forge write by script is retired, not passed on)
  const where = [t.project && `project: ${t.project}`, wt?.path && `worktree: ${wt.path}`, wt?.branch && `branch: ${wt.branch}`, t.model && `model: ${t.model}/${t.effort ?? ''}`].filter(Boolean).join(' · ')
  const now = await h.clock.now()
  const pre = await preflightOf(h, home, t) // (first: it refreshes the snapshot's git fields when they are older than 60 s; the snapshot is read after)
  const snap = await readSnapshot(h, home, t.id)
  const gitInPre = pre.includes(GIT_LINE) // the preflight carries the git state from the snapshot's own record: the snapshot section does not repeat it
  const scratchNotesText = await scratchNotes(h, dir) // the reading the last session kept (scratchnotes.ts): a restart must not redo it
  const scratchFiles = await scratchList(h, dir)
  const inbox =`${deskState(home)}/inbox.jsonl`
  const wait = waiting ? waitingLead(recs) : null // restarted at the limit while waiting: the open question is the lead, nothing to carry on with
  // everything the desk sent this thread after its start (queued, delivered, to a session that has ended, the text of a restart / wake / resume, the
  // results of the actions the desk made for it), newest last, right after the brief: it is newer than the brief and wins where they differ.
  const corr = corrections(await readJsonl<Inbox>(h, `${dir}/inbox.jsonl`), queuedAll, Number.isFinite(t.created) ? t.created : 0)
  if (mode === 'core') {
    // only what changes behaviour; every other source is one line in the pull list, with its size
    const last3 = recs.slice(-REPORT_DIGESTS)
    const nonePaths = await ensureReportFiles(h, home, last3)
    const digestPaths = last3.map(r => (nonePaths.has(r) ? `${deskState(home)}/inbox.jsonl (ts ${r.ts})` : reportFile(home, r)))
    const open = wait ? '' : waitingLead(recs) ?? '' // an open question / blocked request with its id, verbatim (when the lead is not already it)
    const diffLine = snap?.diffStat ? lastLine(snap.diffStat) : ''
    const git = snap && (snap.branch || snap.head) ? `branch ${snap.branch || '?'} · HEAD ${snap.head ? snap.head.slice(0, 10) : '?'} · dirty: ${snap.status.length ? `yes (${snap.status.length} paths)` : 'no'}${diffLine ? ` · ${diffLine}` : ''}` : ''
    const nextTask = snap?.tasks.find(x => x.status === 'in_progress') ?? snap?.tasks.find(x => x.status === 'pending')
    const noteLines = (notes ? notes.split('\n').length : 0) + (scratchNotesText ? scratchNotesText.split('\n').length : 0)
    const pull = [
      brief.length > CORE_BRIEF && `- brief in full: read ${dir}/brief.md (${brief.split('\n').length} lines; headings first: lean_run {pull: "brief"})`,
      recs.length > 0 && `- earlier reports: lean_run {pull: "reports"} lists ${recs.length}, {pull: "reports", section: "<n>"} reads one; last ${last3.length} digests: ${digestPaths.join(', ')}`,
      (notes || scratchNotesText || nl.listed.length) && `- notes: ${dir}/notes.md${scratchNotesText ? `, ${dir}/scratch/${NOTES_FILE}` : ''} (${noteLines} lines${nl.listed.length ? `, +${nl.listed.length} more files in ${dir}` : ''}): headings only first: lean_run {pull: "notes"}, then {pull: "notes", section: "<heading>"}`,
      snap && `- state snapshot: ${snapshotFile(home, t.id)} (${snapshotText(snap, now).length} characters; fields: lean_run {pull: "snapshot", section: "status,tasks,report,pending"})`,
      pre && `- preflight: lean_run {pull: "preflight"} (${pre.length} characters; section: "<word>" keeps the lines with it)`,
    ].filter((x): x is string => !!x)
    const core: Part[] = [
      { name: 'lead', body: `${wait ?? resumeLead(taskLine(goal, brief, t.title))}${instr.length ? ` ${INSTR_LEAD}` : ''}`, mode: 'fixed' },
      { name: 'intro', body: `[lean-agent] You are thread ${t.id} (${t.title}), started again as a NEW session. ${why} The earlier conversation is not available to you; this prompt holds only what changes your behaviour.`, mode: 'fixed' },
      { name: 'brief', head: `## Brief (first ${CORE_BRIEF} characters)`, body: cut(flagForeignPaths(brief, t.id), CORE_BRIEF), file: `${dir}/brief.md`, mode: 'head' },
      { name: 'corrections', head: `## Corrections since the brief\n${CORRECTIONS_HEAD}${corr.older + Math.max(0, corr.lines.length - CORE_CORRECTIONS) ? `\n(${corr.older + Math.max(0, corr.lines.length - CORE_CORRECTIONS)} older messages omitted: ${dir}/inbox.jsonl)` : ''}`, body: corr.lines.slice(-CORE_CORRECTIONS).map(l => cut(l, CORE_EACH)).join('\n'), file: `${dir}/inbox.jsonl`, mode: 'lines' },
      { name: 'open', head: '## Open', body: open, mode: 'fixed' },
      { name: 'where', head: '## Where the work lives', body: where, mode: 'fixed' },
      { name: 'git', head: '## Git', body: git, mode: 'fixed' },
      { name: 'next', head: '## Next step (your task list)', body: nextTask ? `[${nextTask.status}] ${cut(nextTask.text, 300)}` : '', mode: 'fixed' },
      { name: 'pull', head: '## Pull list', body: pull.length ? `Read only what the next step needs from the pull list; a pull returns a section, not the whole store.\n${pull.join('\n')}` : '', mode: 'fixed' },
    ]
    const ctail = instrBlock(instr)
    const csized = fitParts(core, Math.max(2_000, CORE_TOKENS * 4 - (ctail ? ctail.length + 2 : 0)))
    const cbase = cutPrompt(csized.map(partText).filter(Boolean).join('\n\n'))
    return { prompt: ctail ? `${cbase}\n\n${ctail}` : cbase, worktree: wt?.path, branch: wt?.branch, parts: ctail ? [...csized, { name: 'instructions', head: INSTR_HEAD, body: ctail.slice(INSTR_HEAD.length + 1), mode: 'fixed' as const }] : csized, missing: [!goalText && 'no goal (goal-set tN "<line>")', !snap && `no snapshot (${snapshotFile(home, t.id)}: written at the end of the thread's next turn)`, !hist.lines.length && 'no report of this thread in the desk inbox'].filter((x): x is string => !!x) }
  }
  const parts: Part[] = [
    { name: 'lead', body: `${wait ?? resumeLead(taskLine(goal, brief, t.title))}${instr.length ? ` ${INSTR_LEAD}` : ''}`, mode: 'fixed' },
    { name: 'intro', body: `[lean-agent] You are thread ${t.id} (${t.title}), started again as a NEW session. ${why} The earlier conversation is not available to you; everything lean-agent kept is below.`, mode: 'fixed' },
    { name: 'check', body: wait ? '' : `Before you continue, check the real state yourself${wt?.path ? ` (git -C ${wt.path} status -sb, git -C ${wt.path} log -5 --oneline)` : ''}: the reports below can be older than the files. Then carry on and report with lean_report.`, mode: 'fixed' },
    { name: 'brief', head: '## Brief', body: cut(flagForeignPaths(brief, t.id), BRIEF_MAX), file: `${dir}/brief.md`, mode: 'head' },
    { name: 'corrections', head: `## Corrections since the brief\n${CORRECTIONS_HEAD}${corr.older ? `\n(${corr.older} older messages omitted: ${dir}/inbox.jsonl)` : ''}`, body: corr.lines.join('\n'), file: `${dir}/inbox.jsonl`, mode: 'lines' },
    { name: 'where', head: '## Where the work lives', body: where, mode: 'fixed' },
    { name: 'goal', head: '## Goal', body: goalText, mode: 'fixed' },
    { name: 'snapshot', head: '## State at the end of the last turn (state.json)', body: snap ? capped(snapshotText(snap, now, { git: !gitInPre, scratch: false }), SNAPSHOT_MAX, snapshotFile(home, t.id)) : '', file: snapshotFile(home, t.id), mode: 'head' },
    { name: 'preflight', head: '## Preflight', body: capped(pre, PREFLIGHT_MAX, `${dir}/preflight`), file: `${dir}/preflight`, mode: 'head' },
    { name: 'reports', head: `## Your reports so far (last ${Math.min(REPORT_DIGESTS, recs.length)}, oldest first${hist.omitted ? `; ${hist.omitted} older reports: lean_thread report ${t.id}` : ''})`, body: hist.lines.join('\n'), file: inbox, mode: 'lines' },
    { name: 'notes', head: '## Your notes (end of notes.md)', body: notes ? cut(notes, NOTES_MAX, true) : '', file: `${dir}/notes.md`, mode: 'tail' },
    { name: 'progress', head: `## Your notes (end of ${progress?.path})`, body: progressText ? cut(progressText, NOTES_MAX, true) : '', file: `${dir}/${progress?.path}`, mode: 'tail' },
    { name: 'scratchrule', body: scratchNotesText || scratchFiles.length || nl.content.length || nl.listed.length ? `Your earlier reading is kept: ${HANDOVER_RULE}.` : '', mode: 'fixed' },
    { name: 'scratchnotes', head: '## Your scratch notes (end of scratch/notes.md)', body: scratchNotesText, file: `${dir}/scratch/${NOTES_FILE}`, mode: 'tail' },
    { name: 'scratchlist', head: `## Other notes and scratch files: ${READ_FIRST} (newest first; path, size, first line)`, body: nl.listed.length ? `${nl.listed.map(noteLine).join('\n')}${nl.left.length ? `\n(+${nl.left.length} older, not listed: ${nl.left.map(f => f.path).join(', ')})` : ''}` : '', file: dir, mode: 'lines' },
    { name: 'remembered', head: '## What you asked to remember', body: mem.map(m => `- ${cut(flat(m.text!), 300)}`).join('\n'), file: `${leanDir(home)}/memory/notes.jsonl`, mode: 'lines' },
  ]
  const noNotes = !notes && !progressText && !scratchNotesText && !nl.listed.length && !nl.left.length
  const missing = [!goalText && 'no goal (goal-set tN "<line>")', noNotes && `no notes (looked in ${dir}/notes.md, ${dir}/notes/*.md, ${dir}/scratch/*.md)`, !snap && `no snapshot (${snapshotFile(home, t.id)}: written at the end of the thread's next turn)`, !hist.lines.length && 'no report of this thread in the desk inbox'].filter((x): x is string => !!x)
  const tail = instrBlock(instr) // the desk's own instructions: last, whole, after the cap (but counted in the budget: the rest shrinks to make room)
  const sized = fitParts(parts, Math.max(2_000, (await handoverTokens(h, home)) * 4 - (tail ? tail.length + 2 : 0)))
  const base = cutPrompt(sized.map(partText).filter(Boolean).join('\n\n'))
  return { prompt: tail ? `${base}\n\n${tail}` : base, worktree: wt?.path, branch: wt?.branch, parts: tail ? [...sized, { name: 'instructions', head: INSTR_HEAD, body: tail.slice(INSTR_HEAD.length + 1), mode: 'fixed' as const }] : sized, missing, notes: { content: nl.content.map(f => f.path), listed: nl.listed.map(f => f.path), left: nl.left.map(f => f.path), scratchNotes: !!scratchNotesText } }
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
const CUT_ORDER = ['remembered', 'scratchlist', 'notes', 'progress', 'reports', 'scratchnotes', 'corrections', 'brief', 'preflight', 'snapshot'] // the first to lose text is the least needed
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
export async function preflightOf(h: Host, home: string, t: Thread): Promise<string> {
  try {
    const s = preflight ? await preflight(h, home, t) : ''
    return typeof s === 'string' ? s.trim() : ''
  } catch {
    return ''
  }
}

// which note files the handover used and which it found but left out (the reason is always the budget: the file limit, or the token budget)
export function notesRows(ho: Handover, dir: string): string[] {
  const n = ho.notes
  if (!n) return []
  const cutOf = (name: string) => !!ho.parts?.find(p => p.name === name && p.cut)
  const withCut = (f: string, cut: boolean) => (cut ? `${f} (its end only: budget)` : f)
  const used = [...n.content.map(f => withCut(f, f === 'notes.md' ? cutOf('notes') : cutOf('progress'))), ...(n.scratchNotes ? [withCut('scratch/notes.md', cutOf('scratchnotes'))] : [])]
  const rows = [`notes used: ${used.length ? used.join(', ') : 'none'}${n.listed.length ? `; by name (${READ_FIRST}): ${n.listed.join(', ')}${cutOf('scratchlist') ? ' (list cut: budget)' : ''}` : ''}`]
  if (n.left.length) rows.push(`notes found but left out: ${n.left.map(f => `${f} (budget: only the newest ${NOTE_FILES_MAX} notes files are listed; full text in ${dir}/${f})`).join('; ')}`)
  return rows
}

// `lean_doctor handover tN`: exactly what a fresh session would get, the tokens of each section, what is missing.
export async function handoverReport(h: Host, home: string, id: string): Promise<string> {
  const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
  if (!t || typeof t !== 'object') return `no thread ${id}`
  const queued = (await unconsumed(h, home, id).catch(() => ({ msgs: [] as Inbox[] }))).msgs
  const mode = await handoverMode(h, home)
  const ho = await buildHandover(h, home, t, 'This is a preview of the handover.', queued, false, mode)
  const other = await buildHandover(h, home, t, 'This is a preview of the handover.', queued, false, mode === 'core' ? 'full' : 'core')
  const budget = mode === 'core' ? CORE_TOKENS : await handoverTokens(h, home)
  const tok = (s: string) => Math.ceil(s.length / 4)
  const sizes = `modes (config handover.mode, now "${mode}"): core ~${tok((mode === 'core' ? ho : other).prompt)} tokens (budget ${CORE_TOKENS}) · full ~${tok((mode === 'full' ? ho : other).prompt)} tokens (budget ${await handoverTokens(h, home)})`
  const rows = (ho.parts ?? []).filter(p => p.body).map(p => `  ${p.name.padEnd(10)} ~${String(tok(partText(p))).padStart(5)} tokens${p.cut ? `  (cut: full text in ${p.file})` : ''}`)
  const all = tok(ho.prompt)
  const sum = (...names: string[]) => (ho.parts ?? []).filter(p => names.includes(p.name)).reduce((n, p) => n + tok(partText(p)), 0)
  // an overrun is never hidden: by how much, and the largest section (what is left once every cuttable section is at its floor)
  const big = [...(ho.parts ?? [])].filter(p => p.body).sort((a, b) => tok(partText(b)) - tok(partText(a)))[0]
  const over = all > budget ? `over budget by ${all - budget} tokens: the largest section is ${big?.name ?? '?'} (~${big ? tok(partText(big)) : 0} tokens${big?.mode === 'fixed' ? ', a fixed line: never cut' : ''}); the desk's instructions and the fixed lines are never cut` : ''
  return [
    `handover for ${id}: about ${all} tokens: brief ${sum('brief')}, corrections ${sum('corrections')}, notes ${sum('notes', 'progress', 'scratchrule', 'scratchnotes', 'scratchlist')}, snapshot ${sum('snapshot')}, preflight ${sum('preflight')}`,
    `${t.title}: ~${all} tokens of a budget of ${budget} (${mode === 'core' ? 'core mode' : 'config handoverTokens'}, the whole prompt)${over ? ` - ${over}` : ' - within budget'}`,
    sizes,
    'sections:',
    ...rows,
    ...notesRows(ho, `${threadsDir(home)}/${id}`),
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
