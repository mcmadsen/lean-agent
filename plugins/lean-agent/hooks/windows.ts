// The plan window (the 5 hour and the 7 day rate-limit windows of the subscription). `$.session.usage()` carries rateLimits
// [{kind: five_hour | seven_day, percentUsed, resetsAt}]; the engine raises session.measure when a window moves a point. Any session's mod
// snapshots them to <lean home>/desk/windows.json (atomic, no model turn). From that file: the first line of `lean_doctor stats`
// (windowLine, also for the pane), the desk's notices at 80 % and 90 % (once per window), and a warning on `new` / `start` replies above
// config window.holdAbove (default 85).
import { atomicWrite, leanDir, readJson } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import { fmtUntil } from './limits'

export type Win = { kind: 'five_hour' | 'seven_day'; percentUsed: number; resetsAt: number } // resetsAt: ms since the epoch
export type WinSnap = { v: 1; at: number; windows: Win[] }

export const HOLD_ABOVE = 85
export const NOTICE_AT = [80, 90]
const REFRESH_MS = 120_000 // an unchanged reading is rewritten no more often than this (the snapshot age stays honest)
export const windowsFile = (home: string) => `${deskState(home)}/windows.json`
const notifiedFile = (home: string) => `${deskState(home)}/windows-notified.json`

// Tolerant: `usage` is whatever `$.session.usage()` returned; a window of another kind or without a number is skipped.
export function parseWindows(usage: unknown): Win[] {
  const list = (usage as { rateLimits?: unknown } | null | undefined)?.rateLimits
  if (!Array.isArray(list)) return []
  const out: Win[] = []
  for (const w of list) {
    const kind = (w as any)?.kind
    const pct = Number((w as any)?.percentUsed)
    const raw = (w as any)?.resetsAt
    const at = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''))
    if ((kind !== 'five_hour' && kind !== 'seven_day') || !Number.isFinite(pct)) continue
    out.push({ kind, percentUsed: Math.max(0, Math.min(100, pct)), resetsAt: Number.isFinite(at) ? at : 0 })
  }
  return out
}

export async function readWindows(h: Host, home: string): Promise<WinSnap | null> {
  const s = await readJson<Partial<WinSnap> | null>(h, windowsFile(home), null)
  return s && typeof s === 'object' && Array.isArray(s.windows) && typeof s.at === 'number' ? { v: 1, at: s.at, windows: parseWindows({ rateLimits: s.windows }) } : null
}

// Snapshot the windows; false when nothing was written (no windows in `usage`, nothing moved, or the write failed).
export async function recordWindows(h: Host, usage: unknown): Promise<boolean> {
  const windows = parseWindows(usage)
  if (!windows.length) return false
  try {
    const home = await h.env.get('HOME')
    if (!home) return false
    const have = await readWindows(h, home.replace(/\/+$/, ''))
    const now = await h.clock.now()
    const same = have && have.windows.length === windows.length && windows.every(w => have.windows.some(x => x.kind === w.kind && Math.floor(x.percentUsed) === Math.floor(w.percentUsed) && x.resetsAt === w.resetsAt))
    if (same && now - have!.at < REFRESH_MS) return false
    await atomicWrite(h, windowsFile(home.replace(/\/+$/, '')), JSON.stringify({ v: 1, at: now, windows } satisfies WinSnap, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

const dur = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
const ageOf = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'under a minute old' : m < 120 ? `${m} min old` : `${Math.round(m / 60)} h old`
}

// "5h window: 78% used, resets 14:20 (in 1h 13m) | 7d: 41% (snapshot 3 min old)". For the stats header and the pane.
export async function windowLine(h: Host): Promise<string> {
  try {
    const home = (await h.env.get('HOME'))?.replace(/\/+$/, '')
    const snap = home ? await readWindows(h, home) : null
    if (!snap || !snap.windows.length) return 'plan window: not measured yet (every session writes it at the end of a turn; the first reading comes with the next turn of any session)'
    const now = await h.clock.now()
    const one = (w: Win, label: string, long: boolean) => {
      const reset = w.resetsAt
      if (reset && reset <= now) return `${label}: reset at ${fmtUntil(reset, now)} passed (was ${Math.round(w.percentUsed)}%), measured again at the next turn end`
      return `${label}: ${Math.round(w.percentUsed)}%${long ? ' used' : ''}${long && reset ? `, resets ${fmtUntil(reset, now)} (in ${dur(reset - now)})` : ''}`
    }
    const five = snap.windows.find(w => w.kind === 'five_hour')
    const seven = snap.windows.find(w => w.kind === 'seven_day')
    return `${[five && one(five, '5h window', true), seven && one(seven, '7d', false)].filter(Boolean).join(' | ')} (snapshot ${ageOf(now - snap.at)})`
  } catch {
    return 'plan window: unreadable (desk/windows.json); it is written again at the next turn end'
  }
}

// ---- the desk's notices ----------------------------------------------------------------------------------------------------------
// Each window crosses 80 % and 90 % once per window (a window is its kind and reset time): the notice names the threads working now.
export async function windowTick(h: Host, deps: { working: () => Promise<string[]> }): Promise<string[]> {
  const home = (await h.env.get('HOME'))?.replace(/\/+$/, '')
  if (!home) return []
  const snap = await readWindows(h, home)
  if (!snap) return []
  const now = await h.clock.now()
  const done = await readJson<Record<string, number>>(h, notifiedFile(home), {})
  const seen: Record<string, number> = done && typeof done === 'object' ? { ...done } : {}
  const out: string[] = []
  let working: string[] | null = null
  for (const w of snap.windows) {
    if (w.resetsAt && w.resetsAt <= now) continue // a spent window is read again after its reset
    const key = `${w.kind}@${w.resetsAt}`
    const level = Math.max(0, ...NOTICE_AT.filter(n => w.percentUsed >= n))
    if (!level || (seen[key] ?? 0) >= level) continue
    seen[key] = level
    working ??= await deps.working().catch(() => [])
    out.push(`${w.kind === 'five_hour' ? '5h' : '7d'} plan window ${Math.round(w.percentUsed)}% used (past ${level}%${w.resetsAt ? `, resets ${fmtUntil(w.resetsAt, now)} in ${dur(w.resetsAt - now)}` : ''}); working now: ${working.length ? working.join(', ') : 'no thread'}`)
  }
  if (out.length) {
    for (const k of Object.keys(seen)) if (Number(k.split('@')[1]) < now - 8 * 86_400_000) delete seen[k] // old windows are forgotten
    await atomicWrite(h, notifiedFile(home), JSON.stringify(seen, null, 2) + '\n').catch(() => undefined)
  }
  return out
}

// ---- the hold warning on new / start ---------------------------------------------------------------------------------------------
export async function holdAbove(h: Host, home: string): Promise<number> {
  const cfg = await readJson<{ window?: { holdAbove?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null)
  const n = Number(cfg?.window?.holdAbove)
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : HOLD_ABOVE
}

// '' when no window is above the limit; else one sentence the reply of `new` / `start` carries. A warning, never a refusal.
export async function holdWarning(h: Host, home: string): Promise<string> {
  try {
    const snap = await readWindows(h, home)
    if (!snap) return ''
    const now = await h.clock.now()
    const lim = await holdAbove(h, home)
    const hot = snap.windows.filter(w => w.percentUsed > lim && (!w.resetsAt || w.resetsAt > now))
    if (!hot.length) return ''
    const w = hot.sort((a, b) => b.percentUsed - a.percentUsed)[0]!
    return `WARNING plan window: ${w.kind === 'five_hour' ? '5h' : '7d'} ${Math.round(w.percentUsed)}% used (hold above ${lim}%${w.resetsAt ? `, resets ${fmtUntil(w.resetsAt, now)} in ${dur(w.resetsAt - now)}` : ''}): new work may hit the limit; consider waiting or telling the user`
  } catch {
    return ''
  }
}
