// The config keys of the 1.0.31 budget and window awareness (README "Budget and window awareness"): read the way every other key is read, nested
// ({"review": {"maxUsd": 25}}) or flat ({"review.maxUsd": 25}). A value that is not a finite number in its range is the default (never a guess).
import { homeDir } from './state'
import type { Host } from './state'
import { readConfig } from './budget'

export const KEYS = {
  'review.askAboveUsd': { type: 'number', dflt: 5, min: 0, max: 1000, what: 'a review expected to cost more than this (USD) is not started until the user said yes (lean_ask), then prepare with confirm: true' },
  'review.maxUsd': { type: 'number', dflt: 25, min: 0, max: 10000, what: 'a review expected to cost more than this (USD) is refused unless confirm: true' },
  'review.preflight': { type: 'boolean', dflt: true, what: 'prepare compares the prepared file count with the forge PR file count before any reviewer starts' },
  'review.preflightMinFiles': { type: 'number', dflt: 20, min: 1, max: 100000, what: 'the forge count check never stops a review of at most this many prepared files' },
  'review.preflightRatio': { type: 'number', dflt: 3, min: 1, max: 100, what: 'prepared files above max(minFiles, ratio x forge files) stop the review (wrong range)' },
  'window.throttleAbove': { type: 'number', dflt: 70, min: 1, max: 100, what: 'percent of the 5-hour window above which new agents are haiku only and low priority threads wait' },
  'window.blockAbove': { type: 'number', dflt: 92, min: 1, max: 100, what: 'percent of the 5-hour window above which no new thread or reviewer fan-out starts (priority urgent excepted)' },
  'window.capFiveHourPct': { type: 'number', dflt: null, min: 1, max: 100, what: 'your own cap in percent of the 5-hour window: at it all new work is held until the window resets (default none)' },
  'threads.softCheckpointTokens': { type: 'number', dflt: 80000, min: 20000, max: 400000, what: 'a work thread this big is told once to checkpoint at its next boundary (a stalled one is checkpointed by script)' },
  'threads.softUsd': { type: 'number', dflt: 8, min: 0, max: 10000, what: 'per-thread soft budget in USD from the ledger: 80% one nudge, 100% told to report and stop (0 = off)' },
  'desk.contextLimit': { type: 'number', dflt: 60000, min: 20000, max: 400000, what: 'the desk restarts (automatic restart) at this many context tokens' },
} as const
export type Key = keyof typeof KEYS

// the raw value of "a.b": nested first, then the flat name
export async function cfgRaw(h: Host, key: string): Promise<unknown> {
  const cfg = (await readConfig(h, await homeDir(h)).catch(() => ({}))) as Record<string, unknown>
  const [a, b] = key.split('.') as [string, string]
  const nested = cfg?.[a] && typeof cfg[a] === 'object' ? (cfg[a] as Record<string, unknown>)[b] : undefined
  return nested ?? cfg?.[key]
}

// a number key: its value when finite and within [min, max], else the default; null when the default is "none" and no valid value is set
export async function cfgNum(h: Host, key: Key): Promise<number | null> {
  const k = KEYS[key] as { dflt: number | null; min?: number; max?: number }
  const v = await cfgRaw(h, key)
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= (k.min ?? -Infinity) && n <= (k.max ?? Infinity) ? n : k.dflt
}

export async function cfgBool(h: Host, key: Key): Promise<boolean> {
  const v = await cfgRaw(h, key)
  return v === false || v === 'false' ? false : v === true || v === 'true' ? true : (KEYS[key].dflt as unknown as boolean)
}
