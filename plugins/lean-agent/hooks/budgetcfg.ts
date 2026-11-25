// The config keys of the budget and window awareness (README "Budget and window awareness"): read the way every other key is read, nested
// ({"review": {"maxTokens": 10000000}}) or flat ({"review.maxTokens": 10000000}). A value that is not a finite number in its range is the default (never a guess).
// Since 1.0.33 every budget is in usage tokens (usage.ts); the USD keys are gone (configkeys.ts DEPRECATED).
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import type { Config } from './budget'

// config.json, whole (budget.ts re-exports it: every reader takes it from there)
export const readConfig = (h: Host, home: string) => readJson<Config>(h, `${leanDir(home)}/config.json`, {})

export const KEYS = {
  'review.askAboveTokens': { type: 'number', dflt: 2_000_000, min: 0, max: 1e12, what: 'a review expected to use more than this many usage tokens is not started until the user said yes (lean_ask), then prepare with confirm: true' },
  'review.maxTokens': { type: 'number', dflt: 10_000_000, min: 0, max: 1e12, what: 'a review expected to use more than this many usage tokens is refused unless confirm: true' },
  'budget.windowTokens': { type: 'number', dflt: null, min: 0, max: 1e12, what: 'optional cap in usage tokens per current 5-hour window: at it all new work is held until the window resets (none by default; 0 = none)' },
  'budget.allTimeTokens': { type: 'number', dflt: null, min: 0, max: 1e12, what: 'optional cap in usage tokens since budget.since: at it all new work is held until you raise it or start again (none by default; 0 = none)' },
  'stats.showUsd': { type: 'boolean', dflt: false, what: 'add one line to lean_doctor stats with the estimated cost at API list prices' },
  'review.preflight': { type: 'boolean', dflt: true, what: 'prepare compares the prepared file count with the forge PR file count before any reviewer starts' },
  'review.preflightMinFiles': { type: 'number', dflt: 20, min: 1, max: 100000, what: 'the forge count check never stops a review of at most this many prepared files' },
  'review.preflightRatio': { type: 'number', dflt: 3, min: 1, max: 100, what: 'prepared files above max(minFiles, ratio x forge files) stop the review (wrong range)' },
  'window.throttleAbove': { type: 'number', dflt: 70, min: 1, max: 100, what: 'percent of the 5-hour window above which new agents are haiku only and low priority threads wait' },
  'window.blockAbove': { type: 'number', dflt: 92, min: 1, max: 100, what: 'percent of the 5-hour window above which no new thread or reviewer fan-out starts (priority urgent excepted)' },
  'window.capFiveHourPct': { type: 'number', dflt: null, min: 1, max: 100, what: 'your own cap in percent of the 5-hour window: at it all new work is held until the window resets (default none)' },
  'threads.softCheckpointTokens': { type: 'number', dflt: 80000, min: 20000, max: 400000, what: 'a work thread this big is told once to checkpoint at its next boundary (a stalled one is checkpointed by script)' },
  'threads.softTokens': { type: 'number', dflt: null, min: 0, max: 1e12, what: 'per-thread soft budget in usage tokens from the ledger: 80% one nudge, 100% a desk notice (raise / park / continue); the thread goes on (default none; 0 = none)' },
  'tasks.splitHintTokens': { type: 'number', dflt: 60000, min: 0, max: 10000000, what: 'the split hint for a big brief needs the named files to add up to at least this many tokens (bytes / 4); none when it names no files (0 = no floor)' },
  'threads.hardTokens': { type: 'number', dflt: null, min: 0, max: 1e12, what: 'per-thread hard cap in usage tokens from the ledger: at it the thread is told to report and stop and its new Agent calls are refused (default none; 0 = none)' },
  'desk.contextLimit': { type: 'number', dflt: 200000, min: 20000, max: 1000000, what: 'the pane warns at this many desk context tokens (the desk restarts itself there only with desk.autoRestart true; never beyond 90% of the model window)' },
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
