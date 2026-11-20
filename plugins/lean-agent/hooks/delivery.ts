// Delivery desk <-> threads (design 2.3). Pure helpers over a Host; register.tsx wires them to the engine.
// Desk -> thread: threads/tN/inbox.jsonl (a line's id is its 1-based position). The thread reads lines past
// max(thread.json.delivered, consumed.json.n) and marks them consumed, so each line is delivered once.
// Thread -> desk: desk/inbox.jsonl (reports, questions), read marker desk/inbox-read.json.
import { appendJsonl, atomicWrite, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import type { Inbox, Thread } from './threads'
import { MAX_EXPLORERS, checkRules, checkStale, recordRule, rulesStats, slugOk, verifyRules } from './rules'
import { syncWithScripts } from './rulelines'
import { readConfig } from './budget'
import { reviewTool } from './reviewtool'
import { lessonLines } from './reviewlessons'
import { fillProfile, profileText } from './profile'
import { readRegistry, registerOwn, staleEntries } from './worktreereg'

const tdir = (home: string, id: string) => `${threadsDir(home)}/${id}`
export const deskState = (home: string) => `${leanDir(home)}/desk`

// read-then-mark runs one at a time per key (the mod is one process), so overlapping calls never hand over the same lines
const tails = new Map<string, Promise<unknown>>()
function serial<T>(key: string, f: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(f, f)
  tails.set(key, run.catch(() => undefined))
  return run
}

// every writer of goals.json (lean_goal, the desk's goal-set/-clear, the chaser) reads and writes under this one lock
export const goalsLocked = <T>(f: () => Promise<T>): Promise<T> => serial('goals', f)

export type Consumed = { n: number }
export const WAKE_MARK = /<!--\s*lean:n=(\d+)\s*-->/

export const wakeMark = (n: number) => `<!-- lean:n=${n} -->`

async function consumedN(h: Host, home: string, id: string): Promise<number> {
  const c = await readJson<Consumed>(h, `${tdir(home, id)}/consumed.json`, { n: 0 })
  return Number.isFinite(c.n) ? c.n : 0
}

export async function markConsumed(h: Host, home: string, id: string, n: number): Promise<void> {
  if (n > (await consumedN(h, home, id))) await writeJson(h, `${tdir(home, id)}/consumed.json`, { n } satisfies Consumed)
}

// Lines the session has not seen yet, with the count to mark once they are handed over.
export async function unconsumed(h: Host, home: string, id: string): Promise<{ msgs: Inbox[]; upTo: number }> {
  const t = await readJson<Thread | null>(h, `${tdir(home, id)}/thread.json`, null)
  const all = await readJsonl<Inbox>(h, `${tdir(home, id)}/inbox.jsonl`)
  const from = Math.max(t?.delivered ?? 0, await consumedN(h, home, id))
  return { msgs: all.slice(from), upTo: all.length }
}

const render = (msgs: Inbox[]) => msgs.map(m => `[lean-agent] message from ${m.from || 'the desk'}: ${m.text}`).join('\n')

// Thread side, after a tool call: the batch as extra context, marked consumed first (once only).
export async function takeBatch(h: Host, id: string): Promise<string | null> {
  return serial(`batch:${id}`, async () => {
    const home = await homeDir(h)
    const { msgs, upTo } = await unconsumed(h, home, id)
    if (!msgs.length) return null
    await markConsumed(h, home, id, upTo)
    return render(msgs)
  })
}

// Thread side, a prompt: a wake prompt names its inbox position; those lines are already in the prompt.
export async function consumeWake(h: Host, id: string, prompt: string): Promise<boolean> {
  const m = WAKE_MARK.exec(prompt)
  if (!m) return false
  await markConsumed(h, await homeDir(h), id, Number(m[1]))
  return true
}

// ---- thread -> desk ------------------------------------------------------------------------------------------
// approval: a blocked thread's exact command or action that Claude Code's permission check denied and the USER must approve in the
// thread's own session (the pane shows "tN needs your yes in its own session" with an Open tN button; the desk never performs it)
export type DeskRec = { ts: number; from: string; kind: 'report' | 'ask'; text: string; state?: string; options?: string[]; superseded?: boolean; approval?: string }
export const APPROVAL_MAX = 300
export const approvalOf = (r: DeskRec): string => (r.kind === 'report' && r.state === 'blocked' && typeof r.approval === 'string' ? r.approval.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, APPROVAL_MAX) : '')
export const approvalHint = (r: DeskRec): string => (approvalOf(r) ? ` [needs the user's yes in ${r.from}'s own session: ${approvalOf(r)}; tell the user to press "Open ${r.from}" in the pane and answer there; do not run it yourself]` : '')
export type Tool = { name: string; description: string; inputSchema: unknown }

// what a done report should carry so a fresh session can take over: the fields a text does not mention (a heuristic on words)
const HANDOVER_FIELDS: [string, RegExp][] = [
  ['the branch', /\bbranch\b/i],
  ['the worktree path', /worktree|\/worktrees\//i],
  ['the last commit', /\bcommit|\b[0-9a-f]{7,40}\b/i],
  ['pushed or not', /\bpush(ed)?\b/i],
  ['the open items', /\bopen (items?|questions?)\b|\bnothing (is )?(left|open)\b|\bremaining\b|\bleft to do\b/i],
  ['the next step', /\bnext\b/i],
]
export const handoverGaps = (text: string): string[] => HANDOVER_FIELDS.filter(([, re]) => !re.test(text)).map(([w]) => w)

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required })
export const THREAD_TOOLS: Tool[] = [
  {
    name: 'lean_review',
    description: 'The strict review\'s script side. action prepare (project, base, head, branch): the brief computed from the diff without a model (new symbols and files, edited tests, defaulted parameters, module state, changed exports, declines, a re-review\'s open findings), the reviewer model by risk and whether a second opinion comes first. action record (default; project, sha, base, green, review = the reviewer\'s JSON block, second, passes, branch): records the verdict for a commit (the push gate reads it; only this tool can write it); green is REFUSED, with the reason, when a new symbol has no reuse entry, an edited test no coverage entry, a second-opinion candidate no answer, or a blocker/major finding is open. action decline (project, branch or all, kind, symbol, why): a finding the user decided not to fix; later reviews do not raise it again. The project\'s learned review lessons (the checklist and the shared helpers earlier human reviews found), no model involved: action lessons (project, base, head or paths, goal, repo, budget): the text block for the reviewer\'s prompt, chosen from the changed files and the diff; learn (checklist, helpers {name, where, what}, replace [{old, new}], source): add lines, near-duplicates skipped; lessons-list; lessons-rm (which); lessons-undo (the last batch); lessons-verify (repo, apply): helper lines whose code cannot be found.',
    inputSchema: obj({
      action: { type: 'string', enum: ['prepare', 'record', 'decline', 'lessons', 'learn', 'lessons-list', 'lessons-rm', 'lessons-undo', 'lessons-verify'] },
      project: { type: 'string' },
      sha: { type: 'string', description: 'record: full HEAD sha that was reviewed' },
      base: { type: 'string', description: 'prepare, record, lessons: the base branch or sha (default for prepare and lessons: the default branch)' },
      head: { type: 'string', description: 'prepare, lessons: the head (default HEAD)' },
      branch: { type: 'string', description: 'the branch under review (declines and re-reviews are kept per branch)' },
      since: { type: 'string', description: 'prepare, record: the last reviewed sha (default: found from the earlier record)' },
      green: { type: 'boolean', description: 'record: true asks for a green record; the tool checks it' },
      review: { type: 'object', description: 'record: the reviewer\'s JSON block, as it wrote it' },
      second: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, candidate: { type: 'string' } } }, description: 'record: the second opinion\'s candidates (each must be answered in review.reuse)' },
      model: { type: 'string', description: 'record: the reviewer model used' },
      passes: { type: 'number' },
      findings: { type: 'array', items: { type: 'string' }, description: 'record without review: open findings as text (never green)' },
      all: { type: 'boolean', description: 'decline: every branch of the project' },
      kind: { type: 'string', description: 'decline: the finding category (duplication, scope, ...)' },
      symbol: { type: 'string', description: 'decline: the symbol the finding is about' },
      path: { type: 'string', description: 'decline: the file (with text, instead of a symbol)' },
      text: { type: 'string', description: 'decline: the finding\'s wording (with path, instead of a symbol)' },
      why: { type: 'string', description: 'decline: the user\'s reason' },
      repo: { type: 'string', description: 'lessons, lessons-verify: absolute path of the checkout (default: the registered project\'s path)' },
      paths: { type: 'array', items: { type: 'string' }, description: 'lessons: changed paths relative to the repo (instead of or besides base/head)' },
      goal: { type: 'string', description: 'lessons: the change\'s goal; its words select lessons too' },
      budget: { type: 'number', description: 'lessons: tokens (default config.json review.lessonTokens, 3200)' },
      checklist: { type: 'array', items: { type: 'string' }, description: 'learn: general checklist lines' },
      helpers: { type: 'array', items: { type: 'object' }, description: 'learn: shared helpers {name, where (path relative to the repo), what}' },
      replace: { type: 'array', items: { type: 'object' }, description: 'learn: corrections {old, new}' },
      source: { type: 'string', description: 'learn: where the lines come from' },
      which: { type: 'string', description: 'lessons-rm: the number from lessons-list, or a unique piece of the text' },
      apply: { type: 'boolean', description: 'lessons-verify: remove the flagged lines' },
    }, ['project']),
  },
  { name: 'lean_report', description: 'Report progress or the result to the desk. state: working | blocked | done. A done report is a handover for whoever continues the thread: branch, worktree path, last commit, pushed or not, open items, next step. Done ends this session: when your turn ends it is stopped, and a later message starts a NEW session that reads the handover (not this conversation).', inputSchema: obj({ text: { type: 'string' }, state: { type: 'string', enum: ['working', 'blocked', 'done'] }, superseded: { type: 'boolean', description: 'true: the brief you were given is superseded by a later message from the user (say which in text); the desk shows it' }, important: { type: 'boolean', description: 'true: a working progress report the desk should see at once (done, blocked and questions always reach it directly)' }, approval: { type: 'string', description: 'state blocked only: the exact command or action Claude Code\'s permission check denied and the user must approve in YOUR session (the pane shows an Open button for the user; never retry it another way)' } }, ['text']) },
  { name: 'lean_ask', description: 'Ask the user a question through the desk, with optional answer options.', inputSchema: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question']) },
  { name: 'lean_goal', description: 'Update the goal this thread serves (one line).', inputSchema: obj({ update: { type: 'string' } }, ['update']) },
  { name: 'lean_remember', description: 'Save a durable fact for future sessions.', inputSchema: obj({ text: { type: 'string' }, project: { type: 'string' } }, ['text']) },
  { name: 'lean_compare', description: 'Compare a project clean vs as a lean-agent thread: mode task runs one read-only task both ways and a haiku judge compares them (costs money: only when the brief says so); overhead and history as lean_doctor compare.', inputSchema: obj({ project: { type: 'string' }, mode: { type: 'string', enum: ['task', 'overhead', 'history'] }, task: { type: 'string', description: 'task mode: the read-only task' }, model: { type: 'string' }, maxUsd: { type: 'number', description: 'task mode: cap per run (default 1)' } }, ['mode']) },
  {
    name: 'lean_rules',
    description: 'Learned project rules: check (dry run: lines and chars per rule against the caps, before any sync), sync (copy rules and recipe skills into a checkout, or with all: true into every worktree of the project; one summary line per checkout), stale (areas to re-learn), record (area, globs, sha, relies, covered_by after learning; lines are counted from the file), verify (do the names a rule mentions still exist in the repo), stats (which rules load).',
    inputSchema: obj({
      action: { type: 'string', enum: ['sync', 'stale', 'record', 'stats', 'check', 'verify'] },
      project: { type: 'string' },
      repo: { type: 'string', description: 'absolute path of the checkout or worktree (sync, stale, verify)' },
      area: { type: 'string', description: 'record: the area (its rule file is rules/<area>.md); verify: only this rule' },
      globs: { type: 'array', items: { type: 'string' }, description: 'record: the paths the area covers (several globs wire an area to the ones it depends on)' },
      sha: { type: 'string' },
      lines: { type: 'number', description: 'record: ignored (counted from the file); a differing value is reported' },
      relies: { type: 'array', items: { type: 'string' }, description: 'record: files and symbols the rule relies on (written to its footer as relies-on:)' },
      covered_by: { type: 'string', description: 'record: the repo doc that already covers this area: no rule file, never stale' },
      all: { type: 'boolean', description: 'sync: every worktree of the project, not just repo' },
      verbose: { type: 'boolean', description: 'sync: every path copied/removed/skipped, as JSON' },
    }, ['action']),
  },
  {
    name: 'lean_profile',
    description: 'The project profile: which MCP servers and plugins its threads load (the rest is deferred, still found by ToolSearch). show: the profile and what this project\'s threads really used; fill: add what they used (the learn skill does this after learning).',
    inputSchema: obj({ action: { type: 'string', enum: ['show', 'fill'] }, project: { type: 'string', description: 'default: this thread\'s project' } }, ['action']),
  },
  {
    name: 'lean_worktree',
    description: 'The worktree registry (worktrees.json). register: register this thread\'s worktree (one made by the worktree skill or by plain `git worktree add`; it must be a linked worktree of the project\'s repository, on a branch); a key held by a worktree that is gone is replaced, one held by a live worktree gets a suffixed key, and a refusal says why. list: the entries and which are stale. The desk\'s push needs the thread\'s worktree registered.',
    inputSchema: obj({ action: { type: 'string', enum: ['register', 'list'] }, path: { type: 'string', description: 'register: absolute path of the worktree\'s top folder' }, project: { type: 'string', description: 'default: this thread\'s project' }, shared: { type: 'boolean', description: 'register: another thread may use it too' } }, ['action']),
  },
]

// ---- thread -> desk, direct --------------------------------------------------------------------------------------------
// The inbox stays the source of truth (pane, dedupe, fallback). On top of it a done / blocked report and every question is ALSO
// sent to the desk's session with `$.session.send` (an idle desk starts a turn for it; a busy one reads it at its next step). The line
// carries a hidden row key; the desk's `session.receive` hook reads it and marks that inbox row delivered, so the next prompt does not
// hand it over a second time. No desk session id known, or a refused send: the inbox alone, and the tool result says so.
export type Send = (sid: string, text: string) => Promise<{ isDelivered: boolean; reason?: string } | void>
export const deskFile = (home: string) => `${leanDir(home)}/desk.json`
const DELIVERED = (home: string) => `${deskState(home)}/inbox-delivered.json`
const ROW_KEY = /<!--\s*lean:r=(\d+):(t\d+):(report|ask)\s*-->\s*$/ // the LAST thing on the line: text a thread wrote can never carry it there
const oneLine = (s: string, n: number) => (s.replace(/\s+/g, ' ').trim().length > n ? s.replace(/\s+/g, ' ').trim().slice(0, n - 1) + '…' : s.replace(/\s+/g, ' ').trim())
// A REPORT longer than this is sent cut. The full text is first written to its own file, desk/reports/<ts>-<from>-<kind>.md (plain lines the
// desk can Read; the inbox is one JSON line per row), and the cut line names that file and carries the row key too: the row counts as
// delivered and the full report is NOT handed over a second time at the next prompt (a long done report used to arrive twice). The
// pane's Answers list still shows it. When the file cannot be written the cut line has no key and the row stays unread (nothing is lost).
// A question is cut only far past that (ASK_MAX, the real question may be its last sentence), by the same file and pointer; its options
// are clamped to OPTIONS_MAX characters in the line (the file has them all).
export const DIRECT_MAX = 1500
export const ASK_MAX = 8000
const OPTIONS_MAX = 1000
export const reportFile = (home: string, r: { ts: number; from: string; kind: 'report' | 'ask' }) => `${deskState(home)}/reports/${r.ts}-${r.from}-${r.kind}.md` // (the kind: a report and a question of one thread in one millisecond never share a file)

export async function recordDeskSid(h: Host, sid: string): Promise<void> {
  if (!sid) return
  const home = await homeDir(h)
  const cur = await readJson<{ sid?: string }>(h, deskFile(home), {})
  if (cur?.sid !== sid) await writeJson(h, deskFile(home), { ...(cur && typeof cur === 'object' ? cur : {}), sid })
}

// The line sent to the desk. `cut`: a report longer than DIRECT_MAX (cut, with a pointer). `keyed`: the line carries the row key, so the
// row may be marked delivered: always, except a cut report whose full text has no file (`file` = the display path of the written
// file; none = it could not be written).
export function directLine(r: { ts: number; from: string; kind: 'report' | 'ask'; state?: string; text: string; options?: string[] }, file?: string): { line: string; cut: boolean; keyed: boolean } {
  const flat = r.text.replace(/\s+/g, ' ').trim().replace(/<!--|-->/g, '‹comment›') // no comment marker of a thread's can pose as the key
  const max = r.kind === 'ask' ? ASK_MAX : DIRECT_MAX
  const opts = r.options?.length ? r.options.join(' | ') : ''
  const textCut = flat.length > max
  const cut = textCut || opts.length > OPTIONS_MAX // (the ONE place that decides: tellDesk asks directLine, then writes the file)
  const keyed = !cut || !!file
  const head = `[lean-agent] ${r.from} ${r.kind === 'ask' ? 'asking' : r.state === 'done' ? 'done' : r.state === 'blocked' ? 'blocked' : 'progress'}: `
  const tail = `${opts ? ` [options: ${opts.length > OPTIONS_MAX ? `${opts.slice(0, OPTIONS_MAX - 1).replace(/[\ud800-\udbff]$/, '')}…` : opts}]` : ''}${approvalHint(r)}${r.kind === 'report' && r.state === 'done' ? ` (close ${r.from} when nothing is left)` : ''}`
  const pointer = file ? `(cut: the full text is in ${file}: Read it; the pane's Answers list has it too)` : '(cut: the full report is in the desk inbox / pane)'
  const body = textCut ? `${flat.slice(0, max - 1).replace(/[\ud800-\udbff]$/, '')}… ${pointer}` : cut ? `${flat} ${pointer}` : flat
  return { line: `${head}${body}${tail}${keyed ? ` <!-- lean:r=${r.ts}:${r.from}:${r.kind} -->` : ''}`, cut, keyed }
}

// desk/reports/ is pruned when a new full-text file is written, at most once an hour: files older than 30 days (by the time in the file
// name), then everything past the newest 500. Only files this module names (`<ts>-t<N>-<report|ask>.md`); never the file just written;
// never an error to the send.
export const REPORT_DAYS = 30
export const REPORT_KEEP = 500
export const REPORT_PRUNE_MS = 3_600_000
export async function pruneReports(h: Host, home: string, keep: string): Promise<number> {
  try {
    const now = await h.clock.now()
    const last = await h.store.get('reports-prune.t')
    if (typeof last === 'number' && now >= last && now - last < REPORT_PRUNE_MS) return 0
    await h.store.set('reports-prune.t', now)
    const dir = `${deskState(home)}/reports`
    const files = (await h.fs.list(dir)).flatMap(f => (f.kind === 'file' && /^\d+-t\d+-(?:report|ask)\.md$/.test(f.name) ? [{ path: `${dir}/${f.name}`, ts: Number(f.name.slice(0, f.name.indexOf('-'))) }] : [])).sort((a, b) => b.ts - a.ts)
    const drop = files.filter((f, i) => (i >= REPORT_KEEP || f.ts < now - REPORT_DAYS * 86_400_000) && f.path !== keep).map(f => f.path)
    for (let i = 0; i < drop.length; i += 50) await h.process.run(['rm', '-f', ...drop.slice(i, i + 50)])
    return drop.length
  } catch {
    return 0
  }
}

async function setKey(h: Host, home: string, key: string, on: boolean): Promise<void> {
  await serial('reports', async () => {
    const cur = await readJson<{ keys?: string[] }>(h, DELIVERED(home), {})
    const keys = (Array.isArray(cur?.keys) ? cur.keys : []).filter(k => k !== key)
    await writeJson(h, DELIVERED(home), { keys: (on ? [...keys, key] : keys).slice(-500) })
  })
}

// '' = nothing to add to the tool result (not sent on purpose); else the sentence to append.
// The row is marked delivered BEFORE the send (a desk that reads its inbox meanwhile must not hand it over a second time) and
// unmarked again if the send fails or is refused.
async function tellDesk(h: Host, home: string, send: Send | undefined, rec: { ts: number; from: string; kind: 'report' | 'ask'; state?: string; text: string; options?: string[]; approval?: string }, important: boolean): Promise<string> {
  if (!send) return ''
  const worth = rec.kind === 'ask' || rec.state === 'done' || rec.state === 'blocked' || important
  if (!worth) return ''
  const sid = (await readJson<{ sid?: string }>(h, deskFile(home), {}))?.sid
  if (!sid) return ' (the desk session id is not known yet: it reads this from its inbox)'
  // a long text: its full text goes to its own file first (the cut line points at it, by absolute path). `from` must be a thread id: it
  // is part of the file name. No file (bad name, write failed): the cut line is unkeyed and the row stays unread.
  const first = directLine(rec)
  let file: string | undefined
  if (first.cut && /^t\d+$/.test(rec.from)) {
    const path = reportFile(home, rec)
    const body = rec.kind === 'ask' ? `# Question from ${rec.from}\n\n${rec.text.trim()}\n${rec.options?.length ? `\nOptions:\n${rec.options.map(o => `- ${o}`).join('\n')}\n` : ''}` : `# Report from ${rec.from} (${rec.state ?? 'progress'})\n\n${rec.text.trim()}\n`
    file = await atomicWrite(h, path, body).then(() => path, () => undefined)
    if (file) await pruneReports(h, home, file)
  }
  const { line, cut, keyed } = file ? directLine(rec, file) : first
  const key = `${rec.ts}:${rec.from}:${rec.kind}`
  try {
    if (keyed) await setKey(h, home, key, true)
    const r = await send(sid, line)
    if (r && r.isDelivered === false) {
      if (keyed) await setKey(h, home, key, false)
      // refused: nothing points at the file, and the unread row hands the full text over at the next prompt (a send that THREW may have
      // reached the desk, so its file stays for the pruning)
      if (file) await h.process.run(['rm', '-f', file]).catch(() => undefined)
      return ` (direct send to the desk refused: ${oneLine(String(r.reason ?? 'no reason'), 120)}; it reads this from its inbox)`
    }
    return !cut ? ' (also sent to the desk)' : keyed ? ' (sent to the desk cut short; the full report is in a file the desk can read, and is not handed over again)' : ' (sent to the desk cut short; the full report is in its inbox and is handed over at its next prompt)'
  } catch (e) {
    if (keyed) await setKey(h, home, key, false).catch(() => undefined)
    return ` (direct send to the desk failed: ${oneLine(String((e as Error)?.message ?? e), 120)}; it reads this from its inbox)`
  }
}

// Desk side, a delivery from our own plugin arrived: its row is delivered, so no prompt hands it over again (idempotent: the sender
// marked it before sending).
export async function markDelivered(h: Host, text: string): Promise<boolean> {
  const m = ROW_KEY.exec(text)
  if (!m) return false
  const home = await homeDir(h)
  const k = `${m[1]}:${m[2]}:${m[3]}`
  if (!(await deliveredKeys(h, home)).has(k)) await setKey(h, home, k, true)
  return true
}
async function deliveredKeys(h: Host, home: string): Promise<Set<string>> {
  const cur = await readJson<{ keys?: string[] }>(h, DELIVERED(home), {})
  return new Set(Array.isArray(cur?.keys) ? cur.keys : [])
}
const keyOf = (r: DeskRec) => `${r.ts}:${r.from}:${r.kind}`

// ---- a report that could not be written -------------------------------------------------------------------------------
// The record of the last one is written with `fs.write` (no process is spawned: the failure was usually that) and shown by the doctor.
export type ReportFailure = { ts: number; thread: string; error: string; text: string }
const FAILURE = (home: string) => `${leanDir(home)}/report-failure.json`
const msgOf = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 300)
// null = written; else the exact error(s)
async function writeReport(h: Host, home: string, rec: DeskRec): Promise<string | null> {
  const file = `${deskState(home)}/inbox.jsonl`
  try {
    await appendJsonl(h, file, rec)
    return null
  } catch (e1) {
    // only a spawn that was refused is tried again (with the home folder as cwd): any other failure may have written the line already
    if (!/ENOENT|spawn|is gone/i.test(msgOf(e1))) return msgOf(e1)
    const homed: Host = { ...h, process: { run: (argv, init) => h.process.run(argv, { ...init, cwd: home }) } }
    try {
      await appendJsonl(homed, file, rec)
      return null
    } catch (e2) {
      const a = msgOf(e1)
      const b = msgOf(e2)
      return a === b ? a : `${a}; again with the home folder: ${b}`
    }
  }
}
// one record per thread (a failure of one thread never hides another's), kept 24 h
export const FAILURE_KEEP_MS = 24 * 3_600_000
async function failures(h: Host, home: string): Promise<Record<string, ReportFailure>> {
  const f = await readJson<Record<string, ReportFailure> | null>(h, FAILURE(home), null)
  return f && typeof f === 'object' && !Array.isArray(f) ? f : {}
}
async function noteReportFailure(h: Host, home: string, f: ReportFailure): Promise<void> {
  try {
    await h.fs.write(FAILURE(home), JSON.stringify({ ...(await failures(h, home)), [f.thread]: { ...f, text: f.text.slice(0, 500) } }) + '\n')
  } catch {
    /* the thread has the text and the error either way */
  }
}
async function clearReportFailure(h: Host, home: string, thread: string): Promise<void> {
  try {
    const all = await failures(h, home)
    if (all[thread]) {
      delete all[thread]
      await h.fs.write(FAILURE(home), JSON.stringify(all) + '\n')
    }
  } catch {
    /* best effort */
  }
}
// the failures of the last 24 h, oldest first (the doctor shows them)
export async function reportFailures(h: Host): Promise<ReportFailure[]> {
  const now = await h.clock.now()
  return Object.values(await failures(h, await homeDir(h)))
    .filter(f => f && typeof f.thread === 'string' && typeof f.error === 'string' && typeof f.ts === 'number' && now - f.ts < FAILURE_KEEP_MS)
    .sort((a, b) => a.ts - b.ts)
}

export async function threadTool(h: Host, id: string, name: string, i: any, send?: Send): Promise<{ ok: boolean; text: string }> {
  try {
    const home = await homeDir(h)
    const ts = await h.clock.now()
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    if (name === 'lean_report') {
      if (!str(i.text)) return { ok: false, text: 'lean_report needs text' }
      // A report is never lost: a failed write is tried once more with the user's home as the working folder (a session whose own folder
      // is gone makes every spawn fail); when that fails too the thread gets the text back with the exact error, to paste to the user
      const approval = str(i.state) === 'blocked' ? str(i.approval).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, APPROVAL_MAX) : '' // only a blocked report can wait for the user's yes
      const rec = { ts, from: id, kind: 'report', text: str(i.text), state: str(i.state) || 'working', ...(i.superseded === true ? { superseded: true } : {}), ...(approval ? { approval } : {}) } satisfies DeskRec
      const failed = await writeReport(h, home, rec)
      if (failed) {
        await noteReportFailure(h, home, { ts, thread: id, error: failed, text: rec.text })
        return { ok: false, text: `lean_report FAILED: the desk did NOT get this report (${failed}). Paste the text below to the user in your final message, and say the report failed.\n--- report (${rec.state}) ---\n${rec.text}` }
      }
      await clearReportFailure(h, home, id)
      const isDone = str(i.state) === 'done'
      const missing = isDone ? handoverGaps(str(i.text)) : []
      const sent = await tellDesk(h, home, send, { ts, from: id, kind: 'report', state: str(i.state) || 'working', text: str(i.text), ...(approval ? { approval } : {}) }, i.important === true)
      const base = missing.length >= 3 ? `reported to the desk${sent}. Reminder: a done report is the handover (the next session of this thread starts from it): also say ${missing.join(', ')}.` : `reported to the desk${sent}`
      const over = 'This session is over once your turn ends (a later message starts a new session from this report): finish only what is left, then stop.'
      return { ok: true, text: isDone ? `${base}${base.endsWith('.') ? ' ' : '. '}${over}` : base }
    }
    if (name === 'lean_ask') {
      if (!str(i.question)) return { ok: false, text: 'lean_ask needs a question' }
      const options = Array.isArray(i.options) ? i.options.filter((x: unknown) => typeof x === 'string') : undefined
      await appendJsonl(h, `${leanDir(home)}/questions.jsonl`, { ts, from: id, question: str(i.question), options, answered: false })
      await appendJsonl(h, `${deskState(home)}/inbox.jsonl`, { ts, from: id, kind: 'ask', text: str(i.question), options } satisfies DeskRec)
      const sent = await tellDesk(h, home, send, { ts, from: id, kind: 'ask', text: str(i.question), options }, true)
      return { ok: true, text: `question sent${sent}; the answer arrives as a desk message` }
    }
    if (name === 'lean_review') {
      const project = str(i.project) || (await readJson<Partial<Thread>>(h, `${tdir(home, id)}/thread.json`, {})).project || ''
      return reviewTool(h, project, i)
    }
    if (name === 'lean_goal') {
      if (!str(i.update)) return { ok: false, text: 'lean_goal needs update' }
      await goalsLocked(async () => {
        const goals = await readJson<Record<string, { text: string; ts: number }>>(h, `${leanDir(home)}/goals.json`, {})
        goals[id] = { text: str(i.update), ts }
        await writeJson(h, `${leanDir(home)}/goals.json`, goals)
      })
      return { ok: true, text: 'goal updated' }
    }
    if (name === 'lean_remember') {
      if (!str(i.text)) return { ok: false, text: 'lean_remember needs text' }
      await appendJsonl(h, `${leanDir(home)}/memory/notes.jsonl`, { ts, from: id, project: str(i.project), text: str(i.text) })
      return { ok: true, text: 'remembered' }
    }
    if (name === 'lean_rules') {
      const th = await readJson<Partial<Thread>>(h, `${tdir(home, id)}/thread.json`, {})
      const project = str(i.project) || (th.project ?? '')
      if (!slugOk(project)) return { ok: false, text: 'lean_rules needs a project name' }
      const repo = str(i.repo)
      if (i.action === 'stats') return { ok: true, text: JSON.stringify(await rulesStats(h, project)) }
      if (i.action === 'check') {
        const lim = Number(((await readConfig(h, home)) as any)?.learn?.maxExplorers)
        return { ok: true, text: [...(await checkRules(h, project, Number.isInteger(lim) && lim > 0 ? lim : MAX_EXPLORERS)).lines, ...(await lessonLines(h, project).catch(() => [] as string[]))].join('\n') }
      }
      if (i.action === 'record') {
        if (!str(i.area) || !Array.isArray(i.globs) || !str(i.sha)) return { ok: false, text: 'record needs area, globs and sha' }
        if (str(i.area) !== '_project' && !slugOk(str(i.area))) return { ok: false, text: 'record: the area must be a plain name (letters, digits, . _ -)' }
        const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
        const covered = str(i.covered_by) || str(i.coveredBy) || str(i['covered-by'])
        return { ok: true, text: await recordRule(h, project, str(i.area), { globs: strs(i.globs) ?? [], sha: str(i.sha), lines: typeof i.lines === 'number' ? i.lines : undefined, relies: strs(i.relies), coveredBy: covered || undefined }) }
      }
      if (!repo.startsWith('/')) return { ok: false, text: `${i.action} needs repo (an absolute path)` }
      if (i.action === 'sync') {
        // the adopted scripts' rule lines are rebuilt first (rulelines.ts), then every checkout asked for is synced (1.0.6's all / verbose)
        const r = await syncWithScripts(h, project, repo, i.all === true)
        return { ok: true, text: i.verbose === true ? JSON.stringify(r.detail) : r.lines.join('\n') }
      }
      if (i.action === 'stale') return { ok: true, text: JSON.stringify(await checkStale(h, project, repo)) }
      if (i.action === 'verify') return { ok: true, text: (await verifyRules(h, project, repo, str(i.area) || undefined)).lines.join('\n') }
      return { ok: false, text: `unknown lean_rules action ${String(i.action)}` }
    }
    if (name === 'lean_worktree') {
      const th = await readJson<Partial<Thread>>(h, `${tdir(home, id)}/thread.json`, {})
      if (i.action === 'list') {
        const { reg, damaged } = await readRegistry(h, home)
        if (damaged) return { ok: false, text: 'worktrees.json is not a JSON object (damaged)' }
        const stale = new Map((await staleEntries(h)).map(s => [s.key, s.why]))
        const rows = Object.entries(reg).map(([k, e]) => `${k} | ${typeof e?.path === 'string' ? e.path : '?'} | ${typeof e?.thread === 'string' ? e.thread : '-'} | ${stale.has(k) ? `STALE: ${stale.get(k)}` : 'ok'}`)
        return { ok: true, text: rows.length ? rows.join('\n') : 'no worktrees registered' }
      }
      if (i.action !== 'register') return { ok: false, text: `unknown lean_worktree action ${String(i.action)}` }
      const project = str(i.project) || (th.project ?? '')
      if (!slugOk(project)) return { ok: false, text: 'lean_worktree register needs a project name (this thread has none)' }
      const r = await registerOwn(h, home, { project, path: str(i.path), thread: id, shared: i.shared === true })
      return { ok: r.ok, text: r.text }
    }
    if (name === 'lean_profile') {
      const own = (await readJson<Partial<Thread>>(h, `${tdir(home, id)}/thread.json`, {})).project ?? ''
      const project = str(i.project) || own
      if (!slugOk(project)) return { ok: false, text: 'lean_profile needs a project name (this thread has none)' }
      if (project !== own && i.action === 'fill') return { ok: false, text: `lean_profile fill changes this thread's own project${own ? ` (${own})` : ' (this thread has none)'} only: ask the desk for ${project}` }
      if (i.action === 'fill') return await fillProfile(h, home, project)
      if (i.action === 'show') return { ok: true, text: await profileText(h, home, project) }
      return { ok: false, text: `unknown lean_profile action ${String(i.action)}` }
    }
    return { ok: false, text: `unknown tool ${name}` }
  } catch (e) {
    return { ok: false, text: `${name} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` }
  }
}

// ---- desk side -----------------------------------------------------------------------------------------------
// `from` is the real read pointer (rows before it were handed over); recs skips rows the desk already got as a direct message
export async function unreadReports(h: Host): Promise<{ recs: DeskRec[]; upTo: number; from: number }> {
  const home = await homeDir(h)
  const all = await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)
  const read = (await readJson<{ n: number }>(h, `${deskState(home)}/inbox-read.json`, { n: 0 })).n || 0
  const got = await deliveredKeys(h, home) // rows the desk already received as a direct message
  return { recs: all.slice(read).filter(r => !got.has(keyOf(r))), upTo: all.length, from: read }
}

export async function markRead(h: Host, upTo: number): Promise<void> {
  await writeJson(h, `${deskState(await homeDir(h))}/inbox-read.json`, { n: upTo })
}

// a done report carries the hint that closing is the desk's job (a thread cannot close itself)
export const renderReports = (recs: DeskRec[]) =>
  recs.map(r => `[lean-agent] ${r.kind === 'ask' ? 'question' : 'report'} from ${r.from}${r.state ? ` (${r.state})` : ''}${r.superseded ? ' [brief superseded by a later user message]' : ''}: ${r.text}${r.options?.length ? ` [options: ${r.options.join(' | ')}]` : ''}${approvalHint(r)}${r.kind === 'report' && r.state === 'done' ? ` (close ${r.from} when nothing is left)` : ''}`).join('\n')

// ---- relay to an idle desk ---------------------------------------------------------------------------------
// $.prompt.submit starts a desk turn of its own once the session is idle. Only what needs the user or ends a thread is worth a
// turn: a question, or a report that is done or blocked; `working` progress waits for the user's next message.
export const RELAY_GAP_MS = 60_000
export const BUSY_MAX_MS = 15 * 60_000 // a turn that never reported its end (aborted) stops blocking the relay after this
export const worthRelay = (recs: DeskRec[]) => recs.some(r => r.kind === 'ask' || r.state === 'done' || r.state === 'blocked')
export const RELAY_LEAD = '[lean-agent] Threads reported while you were idle. Relay this to the user now: ask each question with AskUserQuestion and send the answer to its thread; when a thread is done and the user needs nothing more, close it and clear its goal.'

// One relay: hands ALL unread reports to `submit` (marked read first; marked unread again if the submit is refused). Returns whether it
// submitted. `busy` (a desk turn runs) and `last` (the previous relay, ms) debounce it. Never for progress alone.
export async function relayReports(h: Host, o: { busy: boolean; last: number; submit: (text: string) => Promise<unknown> }): Promise<boolean> {
  if (o.busy) return false
  return serial('reports', async () => {
    if ((await h.clock.now()) - o.last < RELAY_GAP_MS) return false
    const { recs, upTo, from } = await unreadReports(h)
    if (!worthRelay(recs)) return false
    const was = from // a refused submit rewinds to the real pointer (delivered rows are not part of recs)
    await markRead(h, upTo)
    Promise.resolve()
      .then(() => o.submit(`${RELAY_LEAD}\n${renderReports(recs)}`))
      // refused: they show again at the next prompt, unless something was marked read meanwhile (then nothing is rewound: no repeats)
      .catch(() => serial('reports', async () => { if ((await readJson<{ n: number }>(h, `${deskState(await homeDir(h))}/inbox-read.json`, { n: 0 })).n === upTo) await markRead(h, was); else redo.push(...recs) }).catch(() => undefined))
    return true
  })
}

let redo: DeskRec[] = [] // relayed reports whose submit was refused after the marker had moved on: handed over with the next ones

// Desk busy (a tool call) or the user typing: hand over pending reports once.
export async function takeReports(h: Host): Promise<string | null> {
  return serial('reports', async () => {
    const { recs, upTo } = await unreadReports(h)
    const back = redo.splice(0)
    if (!recs.length && !back.length) return null
    await markRead(h, upTo)
    return renderReports([...back, ...recs])
  })
}

// The desk's 10 s sweep: threads with unconsumed messages that are not running are woken (wake itself refuses a
// running thread and a second wake inside 30 s). Returns the ids it tried.
export async function sweep(h: Host, wake: (id: string) => Promise<unknown>): Promise<string[]> {
  const home = await homeDir(h)
  const tried: string[] = []
  let ents: { name: string }[] = []
  try {
    ents = await h.fs.list(threadsDir(home))
  } catch {
    return tried
  }
  for (const e of ents.filter(x => /^t\d+$/.test(x.name))) {
    const t = await readJson<Thread | null>(h, `${tdir(home, e.name)}/thread.json`, null)
    if (!t || t.state !== 'open' || !t.sid) continue
    if ((await unconsumed(h, home, e.name)).msgs.length) {
      tried.push(e.name)
      await wake(e.name)
    }
  }
  return tried
}
