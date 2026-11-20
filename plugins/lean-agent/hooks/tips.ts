// The desk's coaching tip (prompt.submit, desk only; intents.ts decides, never a model; it never blocks anything): when what the user
// typed matches a direct command's intent, the turn gets ONE line to add to the reply: "Tip: do this directly with /lean-agent:review <pr>".
// At most once per command per day, silent for 7 days after the user used that command directly, one tip per turn, off with
// config.json `"tips": false`. What was shown and used lives in the mod's store.
import type { Host } from './state'
import { homeDir } from './state'
import { readConfig } from './budget'
import { directUse, intentOf } from './intents'

export const DAY_MS = 24 * 60 * 60 * 1000
export const QUIET_MS = 7 * DAY_MS
type Seen = Record<string, { shown?: number; used?: number }>
const KEY = 'tips.seen'

const load = async (h: Host): Promise<Seen> => {
  const v = await h.store.get(KEY).catch(() => undefined)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Seen) : {}
}

export async function takeTip(h: Host, text: unknown): Promise<string | null> {
  if (typeof text !== 'string' || !text.trim()) return null
  const cfg = (await readConfig(h, await homeDir(h)).catch(() => ({}))) as { tips?: unknown }
  if (cfg?.tips === false || cfg?.tips === 'off') return null
  const now = await h.clock.now()
  const seen = await load(h)
  const direct = directUse(text)
  if (direct) { // the user already calls it directly: silent for a week
    seen[direct] = { ...seen[direct], used: now }
    await h.store.set(KEY, seen).catch(() => undefined)
    return null
  }
  if (/^\s*\[lean-agent\]/.test(text) || /^\s*</.test(text)) return null // a relayed report or a system message is not the user's request
  const it = intentOf(text, id => { const s = seen[id]; return !!s && ((s.used !== undefined && now - s.used < QUIET_MS) || (s.shown !== undefined && now - s.shown < DAY_MS)) })
  if (!it) return null
  seen[it.id] = { ...seen[it.id], shown: now }
  await h.store.set(KEY, seen).catch(() => undefined)
  return `[lean-agent tip, one line] After you have answered, end your reply with this line exactly, and say nothing more about it: Tip: do this directly with ${it.example}`
}
