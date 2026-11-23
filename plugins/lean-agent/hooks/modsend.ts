// The desk's own `$.session.send` (deliver-to-thread.ts) runs the engine's SendMessage tool as a tool call, which the desk's strict mode (guard.ts) would deny like any
// tool outside DESK_TOOLS. The mod marks its own send for the duration of the call; guard.ts lets SendMessage through only then, and only for a line that carries
// the mod's prefix. The desk MODEL's own SendMessage call is still refused (a message to a thread goes through `lean_thread send`).
export const MOD_SEND_PREFIX = '[lean-agent] message from the desk'
let depth = 0
export async function asMod<T>(f: () => Promise<T>): Promise<T> {
  depth++
  try {
    return await f()
  } finally {
    depth--
  }
}
export const modSending = (e: { [k: string]: any }): boolean => depth > 0 && typeof e.message === 'string' && e.message.startsWith(MOD_SEND_PREFIX)
