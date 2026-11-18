// Delivery desk <-> threads (design 2.3). Pure helpers over a Host; register.tsx wires them to the engine.
// Desk -> thread: threads/tN/inbox.jsonl (a line's id is its 1-based position). The thread reads lines past
// max(thread.json.delivered, consumed.json.n) and marks them consumed, so each line is delivered once.
// Thread -> desk: desk/inbox.jsonl (reports, questions), read marker desk/inbox-read.json.
import { appendJsonl, atomicWrite, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import type { Inbox, Thread } from './threads'
import { checkStale, recordLearn, rulesStats, slugOk, syncRules } from './rules'
import { writeReview } from './reviews'

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
export type DeskRec = { ts: number; from: string; kind: 'report' | 'ask'; text: string; state?: string; options?: string[]; superseded?: boolean }
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
  { name: 'lean_review', description: 'Record the review verdict for a commit (the push gate reads it; only this tool can write it). green only when tests pass and no blocker/major finding is open.', inputSchema: obj({ project: { type: 'string' }, sha: { type: 'string', description: 'full HEAD sha that was reviewed' }, green: { type: 'boolean' }, passes: { type: 'number' }, findings: { type: 'array', items: { type: 'string' } } }, ['project', 'sha', 'green']) },
  { name: 'lean_report', description: 'Report progress or the result to the desk. state: working | blocked | done. A done report is a handover for whoever continues the thread: branch, worktree path, last commit, pushed or not, open items, next step.', inputSchema: obj({ text: { type: 'string' }, state: { type: 'string', enum: ['working', 'blocked', 'done'] }, superseded: { type: 'boolean', description: 'true: the brief you were given is superseded by a later message from the user (say which in text); the desk shows it' } }, ['text']) },
  { name: 'lean_ask', description: 'Ask the user a question through the desk, with optional answer options.', inputSchema: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question']) },
  { name: 'lean_goal', description: 'Update the goal this thread serves (one line).', inputSchema: obj({ update: { type: 'string' } }, ['update']) },
  { name: 'lean_remember', description: 'Save a durable fact for future sessions.', inputSchema: obj({ text: { type: 'string' }, project: { type: 'string' } }, ['text']) },
  {
    name: 'lean_rules',
    description: 'Learned project rules: sync (copy rules and recipe skills into a checkout or worktree), stale (areas to re-learn), record (area, globs, sha, lines after learning), stats (which rules load).',
    inputSchema: obj({ action: { type: 'string', enum: ['sync', 'stale', 'record', 'stats'] }, project: { type: 'string' }, repo: { type: 'string', description: 'absolute path of the checkout or worktree' }, area: { type: 'string' }, globs: { type: 'array', items: { type: 'string' } }, sha: { type: 'string' }, lines: { type: 'number' } }, ['action']),
  },
]

export async function threadTool(h: Host, id: string, name: string, i: any): Promise<{ ok: boolean; text: string }> {
  try {
    const home = await homeDir(h)
    const ts = await h.clock.now()
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    if (name === 'lean_report') {
      if (!str(i.text)) return { ok: false, text: 'lean_report needs text' }
      await appendJsonl(h, `${deskState(home)}/inbox.jsonl`, { ts, from: id, kind: 'report', text: str(i.text), state: str(i.state) || 'working', ...(i.superseded === true ? { superseded: true } : {}) } satisfies DeskRec)
      const missing = str(i.state) === 'done' ? handoverGaps(str(i.text)) : []
      return { ok: true, text: missing.length >= 3 ? `reported to the desk. Reminder: a done report is the handover (a closed thread is reopened as a new session from it): also say ${missing.join(', ')}.` : 'reported to the desk' }
    }
    if (name === 'lean_ask') {
      if (!str(i.question)) return { ok: false, text: 'lean_ask needs a question' }
      const options = Array.isArray(i.options) ? i.options.filter((x: unknown) => typeof x === 'string') : undefined
      await appendJsonl(h, `${leanDir(home)}/questions.jsonl`, { ts, from: id, question: str(i.question), options, answered: false })
      await appendJsonl(h, `${deskState(home)}/inbox.jsonl`, { ts, from: id, kind: 'ask', text: str(i.question), options } satisfies DeskRec)
      return { ok: true, text: 'question sent; the answer arrives as a desk message' }
    }
    if (name === 'lean_review') {
      const project = str(i.project) || (await readJson<Partial<Thread>>(h, `${tdir(home, id)}/thread.json`, {})).project || ''
      const file = await writeReview(h, { project, sha: str(i.sha), green: i.green === true, passes: Number(i.passes) || undefined, findings: Array.isArray(i.findings) ? i.findings.filter((x: unknown) => typeof x === 'string') : undefined })
      return { ok: true, text: `review recorded (${i.green === true ? 'green' : 'not green'}) in ${file}` }
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
      if (i.action === 'record') {
        if (!str(i.area) || !Array.isArray(i.globs) || !str(i.sha)) return { ok: false, text: 'record needs area, globs and sha' }
        await recordLearn(h, project, str(i.area), { globs: i.globs.filter((x: unknown) => typeof x === 'string'), sha: str(i.sha), lines: Number(i.lines) || 0 })
        return { ok: true, text: 'recorded' }
      }
      if (!repo.startsWith('/')) return { ok: false, text: `${i.action} needs repo (an absolute path)` }
      if (i.action === 'sync') return { ok: true, text: JSON.stringify(await syncRules(h, project, repo)) }
      if (i.action === 'stale') return { ok: true, text: JSON.stringify(await checkStale(h, project, repo)) }
      return { ok: false, text: `unknown lean_rules action ${String(i.action)}` }
    }
    return { ok: false, text: `unknown tool ${name}` }
  } catch (e) {
    return { ok: false, text: `${name} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` }
  }
}

// ---- desk side -----------------------------------------------------------------------------------------------
export async function unreadReports(h: Host): Promise<{ recs: DeskRec[]; upTo: number }> {
  const home = await homeDir(h)
  const all = await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)
  const read = (await readJson<{ n: number }>(h, `${deskState(home)}/inbox-read.json`, { n: 0 })).n || 0
  return { recs: all.slice(read), upTo: all.length }
}

export async function markRead(h: Host, upTo: number): Promise<void> {
  await writeJson(h, `${deskState(await homeDir(h))}/inbox-read.json`, { n: upTo })
}

// a done report carries the hint that closing is the desk's job (a thread cannot close itself)
export const renderReports = (recs: DeskRec[]) =>
  recs.map(r => `[lean-agent] ${r.kind === 'ask' ? 'question' : 'report'} from ${r.from}${r.state ? ` (${r.state})` : ''}${r.superseded ? ' [brief superseded by a later user message]' : ''}: ${r.text}${r.options?.length ? ` [options: ${r.options.join(' | ')}]` : ''}${r.kind === 'report' && r.state === 'done' ? ` (close ${r.from} when nothing is left)` : ''}`).join('\n')

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
    const { recs, upTo } = await unreadReports(h)
    if (!worthRelay(recs)) return false
    const was = upTo - recs.length
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
