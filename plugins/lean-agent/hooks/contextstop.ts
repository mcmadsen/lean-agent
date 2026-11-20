// The hard stop at the context limit (1.0.19; field: a thread that had "checkpointed" kept working and reported the checkpoint again at every
// turn). Once a thread's context is AT or OVER `threadTokens` (the figure of session.measure at a turn end, and `$.session.usage()` every
// 10 tool calls of the main loop, so a long turn cannot run past it) the thread's own mod: writes the snapshot, ONE record to the desk per
// session (autorestart.ts hardStop), and then refuses every further tool call of the thread itself except `lean_report` with one line (the
// refusal record, rule `context-limit`). Workers already running finish; their results are put into the snapshot's pending list by script
// (snapshot.ts), never acted on. The record of the stop is <thread folder>/contextstop.json, keyed by session: never a second record for the
// same session.
import { readJson, readJsonl, writeJson, homeDir, threadsDir } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import type { DeskRec } from './delivery'
import { kTokens } from './threadcontext'
import type { SnapPending } from './snapshot'

export const STOP_RULE = 'context-limit'
export type StopRec = { sid: string; at: number; tokens: number; limit: number; notices: number; pending: SnapPending[] }
export const stopFile = (home: string, id: string) => `${threadsDir(home)}/${id}/contextstop.json`

export const stopLine = (tokens: number, limit: number) =>
  `context limit reached (${kTokens(tokens)} of ${kTokens(limit)}): your state is saved. End your turn now; a fresh session continues from the handover. Do not start workers or report again.`
export const stopRecordText = (tokens: number, limit: number) => `context ${kTokens(tokens)} over the limit ${kTokens(limit)}: state saved, restart me`

export async function readStop(h: Host, home: string, id: string, sid: string): Promise<StopRec | null> {
  const r = await readJson<Partial<StopRec> | null>(h, stopFile(home, id), null)
  if (!r || typeof r !== 'object' || r.sid !== sid || typeof r.tokens !== 'number') return null // (an unknown session id '' is a key too: a turn end without one must not write a record every turn)
  return { sid, at: Number(r.at) || 0, tokens: r.tokens, limit: Number(r.limit) || 0, notices: Number(r.notices) || 0, pending: Array.isArray(r.pending) ? r.pending : [] }
}
export const writeStop = (h: Host, home: string, id: string, rec: StopRec) => writeJson(h, stopFile(home, id), rec)

// ---- a report that is only a checkpoint / context-size notice (the chatter the mod's own record replaces) ----
const NOTICE = /\b(check-?point(ed|ing)?|restart me|context (size|limit|window|is|at|over|reached)|over (the|my) (context )?limit|\d+\s?k(\s+tokens)?\b[^.\n]{0,40}\b(context|limit))/i
export const isNotice = (text: unknown, state: unknown): boolean => {
  const t = typeof text === 'string' ? text.trim() : ''
  return !!t && t.length <= 400 && NOTICE.test(t) && state !== 'done' && state !== 'blocked'
}

// exempt from the stop: the last report or question of the thread is a question to the user, or `blocked` (it waits for an answer)
export async function isExempt(h: Host, home: string, id: string): Promise<boolean> {
  const recs = (await readJsonl<DeskRec>(h, `${deskState(home)}/inbox.jsonl`)).filter(r => r.from === id && (r.kind === 'report' || r.kind === 'ask') && !(r as any).mod)
  const last = recs[recs.length - 1]
  return !!last && (last.kind === 'ask' || last.state === 'blocked')
}

const nameOf = (tool: unknown) => String(tool ?? '').replace(/^mcp__lean-agent__/, '')

// The gate for ONE tool call of the thread's own main loop (never a worker's). null = let it through. `deny`: the refusal line.
export async function stopGate(h: Host, id: string, st: { sid: string; tokens: number; limit: number }, e: { tool?: unknown; text?: unknown; state?: unknown }): Promise<{ deny: string } | null> {
  const deny = { deny: stopLine(st.tokens, st.limit) }
  const name = nameOf(e.tool)
  if (name !== 'lean_report' && name !== 'lean_ask') return deny
  const home = await homeDir(h)
  const exempt = await isExempt(h, home, id).catch(() => false)
  if (name === 'lean_ask') return exempt ? null : deny
  if (exempt || !isNotice(e.text, e.state)) return null
  // a checkpoint / context notice: accepted once, then answered with the stop line instead of being delivered
  const rec = await readStop(h, home, id, st.sid)
  if (!rec) return deny
  if (rec.notices >= 1) return deny
  await writeStop(h, home, id, { ...rec, notices: rec.notices + 1 })
  return null
}

// a worker's result (the subagent ended after the stop): kept for the fresh session, never acted on; false = nothing recorded
export async function notePending(h: Host, id: string, sid: string, p: SnapPending): Promise<boolean> {
  try {
    const home = await homeDir(h)
    const rec = await readStop(h, home, id, sid)
    if (!rec || !p.text.trim()) return false
    await writeStop(h, home, id, { ...rec, pending: [...rec.pending, { agent: p.agent, text: p.text.slice(0, 600) }].slice(-10) })
    return true
  } catch {
    return false
  }
}
