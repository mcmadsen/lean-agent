// The REAL base of a thread session (1.0.19): the tokens its first request carried before any work (input + cache read + cache creation of
// the first main-loop request: the engine's system prompt, the built-in tool schemas, the guide, the skills listing, lean-agent's tools). The
// thread's own mod writes it once per session from the usage of that request (register.tsx turn.step) into <lean home>/base.json, the newest
// reading of any thread: `lean_doctor overhead` shows it next to its text estimate and the start reply of a thread says it once it is known.
import { atomicWrite, homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { kTokens } from './threadcontext'

export type Base = { tokens: number; at: number; thread: string; tools: string }
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
    if (seen.size > 200) seen.delete(seen.values().next().value as string)
    await atomicWrite(h, baseFile(await homeDir(h)), JSON.stringify({ tokens, at: await h.clock.now(), thread, tools } satisfies Base) + '\n')
    return true
  } catch {
    return false
  }
}
export const resetBase = () => seen.clear()

export async function readBase(h: Host): Promise<Base | null> {
  const b = await readJson<Partial<Base> | null>(h, baseFile(await homeDir(h)), null)
  return b && typeof b.tokens === 'number' && b.tokens > 0 ? { tokens: b.tokens, at: Number(b.at) || 0, thread: String(b.thread ?? ''), tools: String(b.tools ?? '') } : null
}

// "measured base: 47k tokens before any work (full built-in tool set; threads.tools can cut it)"
export const baseLine = (b: Base): string => `measured base ${kTokens(b.tokens)} tokens on every request, before any work (${b.tools ? `built-in tools: ${b.tools}` : 'full built-in tool set; config threads.tools can cut it'})`
