// The REAL base of a thread session (1.0.19): the tokens its first request carried before any work (input + cache read + cache creation of
// the first main-loop request: the engine's system prompt, the built-in tool schemas, the guide, the skills listing, lean-agent's tools). The
// thread's own mod writes it once per session from the usage of that request (register.tsx turn.step) into <lean home>/base.json, the newest
// reading of any thread: `lean_doctor overhead` shows it next to its text estimate and the start reply of a thread says it once it is known.
import { atomicWrite, homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { recordParts, requestText } from './ctxparts'
import type { Parts } from './ctxparts'

// 1.0.26: `tokens` is the FIRST REQUEST of the session (fixed parts + the first prompt + whatever the first turn loaded), not a base; the real
// fixed base comes from the breakdown at the first turn end (ctxparts.ts), kept here as `parts` when it is the same thread's session.
export type Base = { tokens: number; at: number; thread: string; tools: string; parts?: Parts }
export const baseFile = (home: string) => `${leanDir(home)}/base.json`
const seen = new Set<string>() // sessions whose first request was measured

export const baseOf = (u: any): number => (Number(u?.input_tokens) || 0) + (Number(u?.cache_read_input_tokens) || 0) + (Number(u?.cache_creation_input_tokens) || 0)

// the first main-loop request of a session; `tools`: the built-in tool list it was started with ('' = the full default set). Never throws.
export async function noteBase(h: Host, thread: string, sid: string, usage: unknown, tools: string): Promise<boolean> {
  try {
    const key = `${thread}:${sid}`
    if (!sid || seen.has(key)) return false
    const tokens = baseOf(usage)
    if (tokens <= 0) return false
    seen.add(key)
    await recordParts(h, thread, sid, { request: tokens }) // the thread's own record: its first request next to the breakdown to come
    if (seen.size > 200) seen.delete(seen.values().next().value as string)
    await atomicWrite(h, baseFile(await homeDir(h)), JSON.stringify({ tokens, at: await h.clock.now(), thread, tools } satisfies Base) + '\n')
    return true
  } catch {
    return false
  }
}
export const resetBase = () => seen.clear()

// the breakdown of the thread's first turn end goes next to the newest first-request reading when that reading is the same thread's
export async function attachParts(h: Host, thread: string, parts: Parts): Promise<boolean> {
  try {
    const home = await homeDir(h)
    const b = await readJson<Partial<Base> | null>(h, baseFile(home), null)
    if (!b || b.thread !== thread || typeof b.tokens !== 'number') return false
    await atomicWrite(h, baseFile(home), JSON.stringify({ ...b, parts }) + '\n')
    return true
  } catch {
    return false
  }
}

export async function readBase(h: Host): Promise<Base | null> {
  const b = await readJson<Partial<Base> | null>(h, baseFile(await homeDir(h)), null)
  return b && typeof b.tokens === 'number' && b.tokens > 0 ? { tokens: b.tokens, at: Number(b.at) || 0, thread: String(b.thread ?? ''), tools: String(b.tools ?? ''), ...(b.parts && typeof b.parts === 'object' ? { parts: b.parts as Parts } : {}) } : null
}

// "fixed base 28.2k (skills 7.9k, ...) + first prompt 25k = first request 53k (full built-in tool set; ...)"; without a breakdown: "first request 47k tokens (...)"
export const baseLine = (b: Base): string => requestText(b.tokens, b.parts, b.tools)
