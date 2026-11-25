// Subagents answer short, their findings go to a file (1.0.26). A reader's or worker's findings that came back into a thread in full were the
// biggest single cost of a docs thread: a background subagent's result notification is not cut to the job schema (no hook sees it), so the
// only place a long answer can still be stopped is the subagent's own stop event (classic.SubagentStop: `block` makes it continue).
//   - classic.SubagentStart tells the subagent its file: `<thread folder>/scratch/<job>-<short id>.md` (additionalContext; the Agent call's input is
//     never changed, auto mode rejects a call whose input a hook changed)
//   - classic.SubagentStop: an answer longer than `workers.answerChars` (default 1200) is answered ONCE with "write the full findings to <path>
//     and answer again with the path and at most 5 lines"; a second long answer is let through and counted (rule `answer-too-long`)
// Pure rules plus a little in-memory state (the paths told, the subagents already asked); nothing here touches a tool call.
import { appendJsonl, homeDir, leanDir, readJson, readJsonl } from './state'
import type { Host } from './state'

export const ANSWER_CHARS = 1200
export const ANSWER_LINES = 5
export const ANSWER_RULE = 'answer-too-long'
// A second long answer is let through: nothing was refused, so it is a COUNTER (counters.jsonl, shown by `lean_doctor stats`), never a row of
// refusals.jsonl (the feedback export and `lean_doctor refusals` list those as refusals).
export const COUNTERS = 'counters.jsonl'
export async function countLongAnswer(h: Host, a: { agent: string; chars: number; thread?: string }): Promise<void> {
  await appendJsonl(h, `${leanDir(await homeDir(h))}/${COUNTERS}`, { ts: await h.clock.now(), rule: ANSWER_RULE, agent: a.agent.replace(/^lean-agent:/, ''), chars: a.chars, ...(a.thread ? { thread: a.thread } : {}) })
}
// the stats lines: second long answers let through in the window, by agent type, and the longest
export async function longAnswerLines(h: Host, now: number, days: number): Promise<string[]> {
  const since = now - days * 86_400_000
  const by = new Map<string, number>()
  let n = 0
  let max = 0
  for (const r of await readJsonl<{ ts?: number; rule?: string; agent?: string; chars?: number }>(h, `${leanDir(await homeDir(h))}/${COUNTERS}`)) {
    if (r?.rule !== ANSWER_RULE || typeof r.ts !== 'number' || r.ts < since) continue
    n++
    by.set(String(r.agent ?? '?'), (by.get(String(r.agent ?? '?')) ?? 0) + 1)
    if (typeof r.chars === 'number') max = Math.max(max, r.chars)
  }
  if (!n) return []
  const who = [...by].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a, c]) => `${a} ${c}`).join(', ')
  return [`long answers let through after one reminder (${days}d): ${n} (${who}); longest ${max} characters (workers.answerChars ${ANSWER_CHARS} is a reminder, not a refusal)`]
}

// the machine lines at the end of an answer (the mod's own records) are not the answer's text
const MACHINE_LINE = /^\s*`?(LEAN-FEEDBACK|LEAN-AUDIT)\b/
// the subagents this rule is for: every lean-agent one (the thread's readers, workers, reviewer, auditor, explorer)
export const isLeanAgent = (t: unknown): boolean => /^(lean-agent:)?(reader|worker|reviewer|auditor|explorer)(-|$)/.test(String(t ?? ''))
const bare = (t: string) => t.replace(/^lean-agent:/, '')

// config.json `workers.answerChars`: a whole number >= 100 (nested or flat key), anything else is the default
export function answerCharsOf(cfg: any): number {
  const v = cfg && typeof cfg === 'object' ? (cfg['workers.answerChars'] ?? cfg.workers?.answerChars) : undefined
  return typeof v === 'number' && Number.isFinite(v) && v >= 100 ? Math.floor(v) : ANSWER_CHARS
}
export async function loadAnswerChars(h: Host): Promise<number> {
  try {
    return answerCharsOf(await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, {}))
  } catch {
    return ANSWER_CHARS
  }
}

// ---- the file a subagent writes its findings to ----------------------------------------------------------------------------------
const JOB_WORD: Record<string, string> = { reviewer: 'review', auditor: 'audit', explorer: 'explore' }
const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'agent'
export const shortId = (agentId: string): string => agentId.replace(/[^A-Za-z0-9]/g, '').slice(-6).toLowerCase() || 'x'
export const scratchPath = (threadDir: string, job: string, agentId: string): string => `${threadDir}/scratch/${safe(job)}-${shortId(agentId)}.md`

// The Agent call comes first (tool.call: it knows the job), the subagent's own start later (its id is known only there): a small queue per
// thread pairs them by subagent type, oldest first.
const calls = new Map<string, { type: string; job: string }[]>() // thread folder -> Agent calls not yet started
const paths = new Map<string, string>() // subagent id -> its file
const asked = new Set<string>() // subagents already asked once to shorten their answer
const MAX = 300
export function answersReset(): void {
  calls.clear()
  paths.clear()
  asked.clear()
}
export function noteAgentCall(threadDir: string, subagentType: string, job: string | null): void {
  if (!isLeanAgent(subagentType)) return
  const q = calls.get(threadDir) ?? []
  q.push({ type: bare(subagentType), job: job ?? JOB_WORD[bare(subagentType)] ?? bare(subagentType).replace(/^(reader|worker)-.*/, '$1') })
  calls.set(threadDir, q.slice(-20))
}
const trim = <T>(m: Map<string, T> | Set<string>) => {
  if (m.size >= MAX) m.delete(m.keys().next().value as string)
}
// the subagent started: its file (told once) and the line it gets as context
export function startAgent(threadDir: string, agentId: string, agentType: string): string | null {
  if (!agentId || !isLeanAgent(agentType)) return null
  const known = paths.get(agentId)
  let path = known
  if (!path) {
    const q = calls.get(threadDir) ?? []
    const i = q.findIndex(c => c.type === bare(agentType))
    const job = i >= 0 ? q[i]!.job : bare(agentType)
    if (i >= 0) q.splice(i, 1)
    path = scratchPath(threadDir, job, agentId)
    trim(paths)
    paths.set(agentId, path)
  }
  return startLine(path)
}
export const startLine = (path: string): string =>
  `[lean-agent] findings longer than a few lines go to a file: ${path} (the folder exists; a Bash redirect or Write there is allowed). Your final answer is that path plus at most ${ANSWER_LINES} lines: the conclusion, pass/fail, what is missing. A long answer is sent back to you once.`

// ---- the stop event -----------------------------------------------------------------------------------------------------------------
export const answerLength = (text: string): number => text.split('\n').filter(l => !MACHINE_LINE.test(l)).join('\n').trim().length
export const answerBlock = (n: number, path: string): string =>
  `your answer is ${n} characters: write the full findings to ${path} and answer again with the path and at most ${ANSWER_LINES} lines`

export type StopAnswer = { block?: string; tooLong?: { chars: number; path: string } } | null
// null: nothing to say. `block`: the first long answer (sent back once). `tooLong`: the second long answer of the same subagent, let through and counted.
// `usedBudget`: the subagent used its whole tool-call budget (orchestrate.ts hitBudget): its answer IS the report (the json block, it cannot write a
// file any more), and a block there would cost the turn it no longer has (1.0.35): the first long answer is let through and counted.
export function stopAnswer(threadDir: string, agentId: string, agentType: string, text: unknown, limit: number, usedBudget = false): StopAnswer {
  if (!agentId || !isLeanAgent(agentType) || typeof text !== 'string') return null
  const n = answerLength(text)
  if (n <= limit) return null
  const path = paths.get(agentId) ?? scratchPath(threadDir, bare(agentType), agentId)
  if (asked.has(agentId) || usedBudget) return { tooLong: { chars: n, path } }
  trim(asked)
  asked.add(agentId)
  return { block: answerBlock(n, path) }
}
// a subagent that ended is forgotten (a resumed one gets a new start event)
export function answersEnd(agentId: string): void {
  paths.delete(agentId)
  asked.delete(agentId)
}
