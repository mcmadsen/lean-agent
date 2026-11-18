// Delivery desk <-> threads (design 2.3). Pure helpers over a Host; register.tsx wires them to the engine.
// Desk -> thread: threads/tN/inbox.jsonl (a line's id is its 1-based position). The thread reads lines past
// max(thread.json.delivered, consumed.json.n) and marks them consumed, so each line is delivered once.
// Thread -> desk: desk/inbox.jsonl (reports, questions), read marker desk/inbox-read.json.
import { appendJsonl, atomicWrite, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import type { Inbox, Thread } from './threads'

const tdir = (home: string, id: string) => `${threadsDir(home)}/${id}`
export const deskState = (home: string) => `${leanDir(home)}/desk`

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
  const home = await homeDir(h)
  const { msgs, upTo } = await unconsumed(h, home, id)
  if (!msgs.length) return null
  await markConsumed(h, home, id, upTo)
  return render(msgs)
}

// Thread side, a prompt: a wake prompt names its inbox position; those lines are already in the prompt.
export async function consumeWake(h: Host, id: string, prompt: string): Promise<boolean> {
  const m = WAKE_MARK.exec(prompt)
  if (!m) return false
  await markConsumed(h, await homeDir(h), id, Number(m[1]))
  return true
}

// ---- thread -> desk ------------------------------------------------------------------------------------------
export type DeskRec = { ts: number; from: string; kind: 'report' | 'ask'; text: string; state?: string; options?: string[] }
export type Tool = { name: string; description: string; inputSchema: unknown }

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required })
export const THREAD_TOOLS: Tool[] = [
  { name: 'lean_report', description: 'Report progress or the result to the desk. state: working | blocked | done.', inputSchema: obj({ text: { type: 'string' }, state: { type: 'string', enum: ['working', 'blocked', 'done'] } }, ['text']) },
  { name: 'lean_ask', description: 'Ask the user a question through the desk, with optional answer options.', inputSchema: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question']) },
  { name: 'lean_goal', description: 'Update the goal this thread serves (one line).', inputSchema: obj({ update: { type: 'string' } }, ['update']) },
  { name: 'lean_remember', description: 'Save a durable fact for future sessions.', inputSchema: obj({ text: { type: 'string' }, project: { type: 'string' } }, ['text']) },
]

export async function threadTool(h: Host, id: string, name: string, i: any): Promise<{ ok: boolean; text: string }> {
  try {
    const home = await homeDir(h)
    const ts = await h.clock.now()
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    if (name === 'lean_report') {
      if (!str(i.text)) return { ok: false, text: 'lean_report needs text' }
      await appendJsonl(h, `${deskState(home)}/inbox.jsonl`, { ts, from: id, kind: 'report', text: str(i.text), state: str(i.state) || 'working' } satisfies DeskRec)
      return { ok: true, text: 'reported to the desk' }
    }
    if (name === 'lean_ask') {
      if (!str(i.question)) return { ok: false, text: 'lean_ask needs a question' }
      const options = Array.isArray(i.options) ? i.options.filter((x: unknown) => typeof x === 'string') : undefined
      await appendJsonl(h, `${leanDir(home)}/questions.jsonl`, { ts, from: id, question: str(i.question), options, answered: false })
      await appendJsonl(h, `${deskState(home)}/inbox.jsonl`, { ts, from: id, kind: 'ask', text: str(i.question), options } satisfies DeskRec)
      return { ok: true, text: 'question sent; the answer arrives as a desk message' }
    }
    if (name === 'lean_goal') {
      if (!str(i.update)) return { ok: false, text: 'lean_goal needs update' }
      const goals = await readJson<Record<string, { text: string; ts: number }>>(h, `${leanDir(home)}/goals.json`, {})
      goals[id] = { text: str(i.update), ts }
      await writeJson(h, `${leanDir(home)}/goals.json`, goals)
      return { ok: true, text: 'goal updated' }
    }
    if (name === 'lean_remember') {
      if (!str(i.text)) return { ok: false, text: 'lean_remember needs text' }
      await appendJsonl(h, `${leanDir(home)}/memory/notes.jsonl`, { ts, from: id, project: str(i.project), text: str(i.text) })
      return { ok: true, text: 'remembered' }
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

export const renderReports = (recs: DeskRec[]) =>
  recs.map(r => `[lean-agent] ${r.kind === 'ask' ? 'question' : 'report'} from ${r.from}${r.state ? ` (${r.state})` : ''}: ${r.text}${r.options?.length ? ` [options: ${r.options.join(' | ')}]` : ''}`).join('\n')

// Desk busy (a tool call) or the user typing: hand over pending reports once.
export async function takeReports(h: Host): Promise<string | null> {
  const { recs, upTo } = await unreadReports(h)
  if (!recs.length) return null
  await markRead(h, upTo)
  return renderReports(recs)
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
