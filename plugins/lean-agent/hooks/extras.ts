// Small desk/thread services: project memory for the prompt, handoff notes at compaction, answers recorded against
// open questions, and the scheduled sends. Pure helpers over a Host; register.tsx wires them to the engine.
import { appendJsonl, atomicWrite, homeDir, leanDir, readJson, readJsonl, threadsDir, writeJson } from './state'
import type { Host } from './state'
import type { Role } from './role'
import { deskState } from './delivery'
import { sessionIndex } from './memoryindex'

// ---- memory (prompt.compose, session section) ----------------------------------------------------------------
// 1.0.31: the one memory store (memory.ts): the standing orders of the desk or a thread as a session section, under a token budget (memoryindex.ts);
// facts and decisions are not in it (found by words or reminded by relevance)
export async function memorySection(h: Host, role: Role): Promise<string | null> {
  const ix = await sessionIndex(h, role)
  return ix ? `# lean-agent memory\n${ix}` : null
}

// ---- handoff notes on compaction -----------------------------------------------------------------------------
const textOf = (v: any): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(textOf).join(' ') : v && typeof v === 'object' ? textOf(v.text ?? v.content ?? '') : '')

export async function writeCompactNotes(h: Host, role: Role, messages: readonly any[]): Promise<void> {
  if (role.kind !== 'thread' && role.kind !== 'desk') return
  const home = await homeDir(h)
  const file = role.kind === 'thread' ? `${threadsDir(home)}/${role.id}/notes.md` : `${deskState(home)}/notes.md`
  const goals = await readJson<Record<string, { text?: string }>>(h, `${leanDir(home)}/goals.json`, {})
  const goal = role.kind === 'thread' ? goals[role.id]?.text : undefined
  const tail = (messages ?? []).slice(-6).map(m => `- ${String(m?.role ?? '?')}: ${textOf(m?.content ?? m).replace(/\s+/g, ' ').trim().slice(0, 300)}`).filter(l => l.length > 8)
  const prev = ((await h.fs.read(file).catch(() => '')) as string) || ''
  const when = new Date(await h.clock.now()).toISOString()
  await atomicWrite(h, file, `${typeof prev === 'string' ? prev.replace(/\n*$/, '\n') : ''}\nCompacted ${when}${goal ? `\nGoal: ${goal}` : ''}\n${tail.join('\n')}\n`)
}

// ---- answers against open questions --------------------------------------------------------------------------
// A question's id is its 1-based line in questions.jsonl; a message the desk sends to its thread answers the
// oldest open one, recorded in answers.jsonl.
// answers.jsonl is read here (and by openQuestions): a question with a row there is closed. The text itself reaches
// the thread through lean_thread send (its inbox); this only closes the question.
export async function openQuestions(h: Host): Promise<{ q: number; from?: string; question?: string }[]> {
  const home = await homeDir(h)
  const qs = await readJsonl<{ from?: string; question?: string }>(h, `${leanDir(home)}/questions.jsonl`)
  const done = new Set((await readJsonl<{ q: number }>(h, `${leanDir(home)}/answers.jsonl`)).map(a => a.q))
  return qs.flatMap((q, n) => (q && !done.has(n + 1) ? [{ q: n + 1, from: q.from, question: q.question }] : []))
}

export async function recordAnswer(h: Host, thread: string, text: string): Promise<number | null> {
  const home = await homeDir(h)
  const qs = await openQuestions(h)
  const open = qs.find(q => q.from === thread)
  if (!open) return null
  await appendJsonl(h, `${leanDir(home)}/answers.jsonl`, { ts: await h.clock.now(), q: open.q, thread, text })
  return open.q
}

// ---- scheduled sends -----------------------------------------------------------------------------------------
// scheduled.jsonl: {at: <ms epoch | ISO time>, tN, text}; a line is sent once, at or after its time, only while the
// desk runs (the sent line numbers are kept in scheduled-done.json).
export async function runSchedule(h: Host, send: (id: string, text: string) => Promise<unknown>): Promise<string[]> {
  const home = await homeDir(h)
  const rows = await readJsonl<{ at?: number | string; tN?: string; text?: string }>(h, `${leanDir(home)}/scheduled.jsonl`)
  if (!rows.length) return []
  const file = `${leanDir(home)}/scheduled-done.json`
  const done = new Set((await readJson<{ n: number[] }>(h, file, { n: [] })).n)
  const now = await h.clock.now()
  const sent: string[] = []
  for (const [i, r] of rows.entries()) {
    if (done.has(i + 1) || !r || !/^t\d+$/.test(String(r.tN)) || !String(r.text ?? '').trim()) continue
    const at = typeof r.at === 'number' ? r.at : Date.parse(String(r.at))
    if (!Number.isFinite(at) || at > now) continue
    done.add(i + 1)
    await writeJson(h, file, { n: [...done] }) // marked first: a failed send is not repeated every tick
    await send(r.tN!, String(r.text))
    sent.push(r.tN!)
  }
  return sent
}
