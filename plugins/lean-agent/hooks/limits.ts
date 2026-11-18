// Usage-limit auto-resume (docs/usage-limit-resume.md): a thread whose session is blocked by the account's usage limit is resumed by
// the desk after the reset (+2 min), once per reset, never for a parked or closed thread. This file holds the pure parts (reset
// time from text or from the engine's rate-limit windows), the per-thread record and the desk's tick; threads.ts does the stop and
// the resume (the `limit-resume` action) inside the thread's lock.
import { homeDir, leanDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'

export const RESUME_DELAY_MS = 2 * 60_000
export const MAX_AHEAD_MS = 8 * 86_400_000 // a weekly window is the longest
export const STALE_AFTER_MS = 6 * 3_600_000 // a recorded reset this long past is not trusted any more
export const PAST_OK_MS = 6 * 3_600_000 // text naming a time this recently past: the reset already happened
export const SAME_RESET_MS = 10 * 60_000 // two reset times this close are one reset (the engine's figure can move by seconds)
export const MAX_TRIES = 3
export const RECHECK_MS = 5 * 60_000 // a blocked session that showed no limit line is looked at again after this
export const LIMIT_PROMPT = 'The usage limit reset; check your worktree state and continue.'

export type LimitRec = {
  resetAt: number
  seenAt: number
  source: 'mod' | 'logs'
  sid: string
  line?: string // the matched limit sentence (source logs)
  count?: number // how many limit lines the log held then (source logs)
  resumedFor?: number
  resumedAt?: number
  tries?: number
  error?: string
  cancelled?: string
}

// state "blocked" with nothing it waits for (a permission prompt sets waitingFor: that one needs the user)
export const isLimitRow = (a: { state: string; waitingFor: string } | undefined) => !!a && a.state === 'blocked' && !a.waitingFor

// ---- reset time from text ------------------------------------------------------------------------------------------------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const monthOf = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase())

type Offset = (utcMs: number) => number // zone offset in ms at that instant

// null = the zone is unknown (never guessed)
function zoneOffset(zone: string | undefined): Offset | null {
  if (!zone) return ms => -new Date(ms).getTimezoneOffset() * 60_000 // the machine's own zone
  const z = zone.trim()
  if (/^(utc|gmt|z)$/i.test(z)) return () => 0
  const fixed = /^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(z)
  if (fixed) {
    const mins = Number(fixed[2]) * 60 + Number(fixed[3] ?? 0)
    if (Number(fixed[2]) > 14 || Number(fixed[3] ?? 0) > 59) return null
    return () => (fixed[1] === '-' ? -mins : mins) * 60_000
  }
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,2}$/.test(z)) return null
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    return ms => {
      const p: Record<string, number> = {}
      for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value)
      return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000
    }
  } catch {
    return null
  }
}

// wall clock in a zone -> instant (two passes: the offset at the guess, then at the result, which settles a DST edge)
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, off: Offset): number {
  const guess = Date.UTC(y, mo, d, h, mi)
  const t1 = guess - off(guess)
  return guess - off(t1)
}

// "4pm (UTC)", "16:00", "Nov 20, 4:30pm (Europe/Berlin)", "20 Nov 16:00", "in 2h 30m" -> ms, or null. `seenAt`: when the limit
// was first seen; a time without a date is its next occurrence after that.
export function parseResetText(text: string, seenAt: number): number | null {
  if (String(text ?? '').length > MAX_RESETS) return null
  let s = String(text ?? '').replace(/[│┃|]+\s*$/, '').trim()
  const rel = /\bin\s+(?:(\d{1,3})\s*h(?:ours?|rs?)?)?\s*(?:(\d{1,3})\s*m(?:in(?:ute)?s?)?)?\b/i.exec(s)
  if (rel && (rel[1] || rel[2]) && /^\s*in\b/i.test(s)) {
    const at = seenAt + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000
    return at > seenAt && at <= seenAt + MAX_AHEAD_MS ? at : null
  }
  let zone: string | undefined
  const zm = /\(([^)]*)\)\s*[.!]?\s*$/.exec(s)
  if (zm) {
    zone = zm[1]!.trim()
    s = s.slice(0, zm.index).trim()
  }
  s = s.replace(/[.!]+$/, '').replace(/^at\s+/i, '').trim()
  const off = zoneOffset(zone)
  if (!off) return null

  let month = -1
  let day = 0
  let year = 0
  const md = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b[\s,·\-]*(?:at\s+)?/.exec(s)
  const dm = md ? null : /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?\b[\s,·\-]*(?:at\s+)?/.exec(s)
  if (md) {
    month = monthOf(md[1]!)
    day = Number(md[2])
    year = Number(md[3] ?? 0)
    s = s.slice(md[0].length)
  } else if (dm) {
    month = monthOf(dm[2]!)
    day = Number(dm[1])
    year = Number(dm[3] ?? 0)
    s = s.slice(dm[0].length)
  }
  if ((md || dm) && (month < 0 || day < 1 || day > 31)) return null

  const tm = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$|^(\d{1,2}):(\d{2})$/i.exec(s.trim())
  if (!tm) return null
  let hour: number
  let minute: number
  if (tm[3]) {
    hour = Number(tm[1])
    minute = Number(tm[2] ?? 0)
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (tm[3].toLowerCase() === 'p' ? 12 : 0)
  } else {
    hour = Number(tm[4])
    minute = Number(tm[5])
    if (hour > 23) return null
  }
  if (minute > 59) return null

  const wall = new Date(seenAt + off(seenAt)) // the seen moment on the zone's wall clock (read through the UTC fields)
  let at: number
  if (month >= 0) {
    const y = year || wall.getUTCFullYear()
    at = wallToUtc(y, month, day, hour, minute, off)
    if (!year && at < seenAt - 86_400_000) at = wallToUtc(y + 1, month, day, hour, minute, off)
    if (new Date(at + off(at)).getUTCDate() !== day) return null // 31 Feb and friends
  } else {
    at = wallToUtc(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour, minute, off)
    // A bare time is a session window's end, a few hours ahead at most: today's occurrence only just past means the limit has reset
    // already (the desk was off or the machine asleep when it was hit), so that one counts; anything older means the next one.
    if (at <= seenAt && seenAt - at > PAST_OK_MS) at = wallToUtc(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1, hour, minute, off)
  }
  // a reset at most PAST_OK_MS past is a reset that already happened (due now); further past is no answer
  return at > seenAt - PAST_OK_MS && at <= seenAt + MAX_AHEAD_MS ? at : null
}

// ---- the limit line in `claude logs` output --------------------------------------------------------------------------------
const ANSI = /\x1b\[[0-9;?]{0,40}[ -/]{0,10}[@-~]|\x1b\][^\x07]{0,200}\x07/g
const MAX_LINE = 500 // the limit sentence is short; a longer line is not it (and the log is untrusted text: bounded work per line)
const MAX_RESETS = 80
// the last limit sentence of the output: "You've hit your session limit · resets 4pm (UTC)", "usage limit reached ... resets at 4pm"
// `count`: how many such lines the output holds (a limit hit again adds one: the way to tell a new limit from an old line that
// is still in the log)
export function findLimitLine(out: string): { line: string; resets: string; count: number } | null {
  const lines = String(out ?? '').replace(ANSI, '').split('\n')
  let last: { line: string; resets: string } | null = null
  let count = 0
  for (const raw of lines) {
    if (raw.length > 4 * MAX_LINE) continue
    const l = raw.replace(/[│┃╭╮╰╯─]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (l.length > MAX_LINE) continue
    const m =/\bhit your\b[^\n]*?\blimit\b[^\n]*?\bresets?\b\s*(?:at\s+)?(.+)$/i.exec(l) ?? /\busage limit (?:reached|hit)\b[^\n]*?\bresets?\b\s*(?:at\s+)?(.+)$/i.exec(l)
    if (m && m[1] && m[1].length <= MAX_RESETS) {
      last = { line: l.slice(0, 200), resets: m[1].trim() }
      count++
    }
  }
  return last ? { ...last, count } : null
}

// ---- reset time from the engine's rate-limit windows -----------------------------------------------------------------------
export function limitFromUsage(usage: unknown, now: number): number | null {
  const list = (usage as { rateLimits?: unknown } | null | undefined)?.rateLimits
  if (!Array.isArray(list)) return null
  let best = 0
  for (const w of list) {
    const pct = Number((w as any)?.percentUsed)
    const at = Date.parse(String((w as any)?.resetsAt ?? ''))
    if (Number.isFinite(pct) && pct >= 100 && Number.isFinite(at) && at > best) best = at
  }
  return best > now - STALE_AFTER_MS && best <= now + MAX_AHEAD_MS ? best : null
}

// ---- the record ------------------------------------------------------------------------------------------------------------
export const limitFile = (home: string, id: string) => `${threadsDir(home)}/${id}/limit.json`

export async function readLimit(h: Host, home: string, id: string): Promise<LimitRec | null> {
  const r = await readJson<Partial<LimitRec> | null>(h, limitFile(home, id), null)
  return r && typeof r === 'object' && Number.isFinite(r.resetAt) && typeof r.sid === 'string' && (r.source === 'mod' || r.source === 'logs') ? (r as LimitRec) : null
}
export const writeLimit = (h: Host, home: string, id: string, rec: LimitRec) => writeJson(h, limitFile(home, id), rec)

// this record may drive a resume for this session: same session, a reset not long past
export const usable = (r: LimitRec | null, sid: string, now: number): r is LimitRec => !!r && r.sid === sid && r.resetAt > now - STALE_AFTER_MS
// this reset was already dealt with (resumed, or the thread was parked or closed meanwhile)
export const handled = (r: LimitRec) => !!r.cancelled || r.resumedFor === r.resetAt
export const sameReset = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= SAME_RESET_MS
// the record the pane shows as "paused until": usable, not handled, not out of tries
export const pausedRec = (r: LimitRec | null, sid: string, now: number): LimitRec | null => (usable(r, sid, now) && !handled(r) && (r.tries ?? 0) < MAX_TRIES ? r : null)

// "16:00", or "Nov 20 16:00" when it is not today (the desk machine's clock)
export function fmtUntil(at: number, now: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`
  const n = new Date(now)
  return d.toDateString() === n.toDateString() ? t : `${MONTHS[d.getMonth()]!.replace(/^./, c => c.toUpperCase())} ${d.getDate()} ${t}`
}

// ---- the desk's tick ---------------------------------------------------------------------------------------------------------
export type TickRow = { sid: string; id: string; state: string; waitingFor: string }
export type TickDeps = {
  agents: () => Promise<TickRow[] | null>
  logs: (row: TickRow) => Promise<string | null>
  resume: (tN: string) => Promise<{ ok: boolean; text: string; data?: unknown }>
}
const checked = new Map<string, number>() // sid -> when `claude logs` last showed no limit line
export const resetLimitCache = () => checked.clear()

// Returns what it did, one line per thread (for the log and the tests).
export async function limitTick(h: Host, deps: TickDeps): Promise<string[]> {
  const home = await homeDir(h)
  const cfg = await readJson<{ desk?: { autoResume?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null)
  if (cfg?.desk?.autoResume === false) return []
  const rows = await deps.agents()
  if (!rows) return []
  const now = await h.clock.now()
  const did: string[] = []
  let ents: { name: string }[] = []
  try {
    ents = await h.fs.list(threadsDir(home))
  } catch {
    return did
  }
  for (const e of ents.filter(x => /^t\d+$/.test(x.name))) {
    const id = e.name
    const t = await readJson<{ state?: string; sid?: string } | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    if (!t) continue
    let rec = await readLimit(h, home, id)
    if (t.state !== 'open') {
      // parked, closing or closed: never auto-resumed, not even after a later reopen
      if (rec && !handled(rec)) await writeLimit(h, home, id, { ...rec, cancelled: String(t.state) })
      continue
    }
    if (!t.sid) continue
    const row = rows.find(a => a.sid === t.sid)
    if (!isLimitRow(row)) continue
    // find the reset: the thread's own mod may have written it; else the log's limit line
    if (!usable(rec, t.sid, now) || handled(rec)) {
      if (now - (checked.get(t.sid) ?? 0) < RECHECK_MS) continue
      const text = await deps.logs(row!)
      const found = text ? findLimitLine(text) : null
      checked.set(t.sid, now) // (whatever comes out: the log is read again no sooner than RECHECK_MS)
      // a reset already dealt with leaves its line in the log: the same line, not more of them, is that limit again (read later, the
      // text would parse to another day). A record from the thread's mod has no line: the line is the same when it explains its reset.
      // (also for a record of another session id, after a resume that started a copy, and for one that went stale unhandled)
      const old = rec && (handled(rec) || rec.resetAt <= now - STALE_AFTER_MS)
      if (found && rec && old && (rec.line !== undefined ? found.line === rec.line && found.count <= (rec.count ?? 1) : sameReset(parseResetText(found.resets, rec.seenAt), rec.resetAt))) continue
      const resetAt = found ? parseResetText(found.resets, now) : null
      if (!found || !resetAt) {
        if (found) did.push(`${id}: limit line seen, reset time not understood`)
        continue
      }
      checked.delete(t.sid)
      rec = { resetAt, seenAt: now, source: 'logs', sid: t.sid, line: found.line, count: found.count }
      await writeLimit(h, home, id, rec)
      did.push(`${id}: usage limit until ${new Date(resetAt).toISOString()}`)
    }
    if (!usable(rec, t.sid, now) || handled(rec) || (rec.tries ?? 0) >= MAX_TRIES) continue
    if (now < rec.resetAt + RESUME_DELAY_MS) continue
    // due: mark first (never twice for one reset), then resume; a resume that did not start gives the mark back
    await writeLimit(h, home, id, { ...rec, resumedFor: rec.resetAt, resumedAt: now })
    const r = await deps.resume(id)
    if (r.ok) {
      did.push(`${id}: ${(r.data as { resumed?: boolean } | undefined)?.resumed ? 'resumed after the usage limit' : 'not resumed: ' + r.text.slice(0, 120)}`)
    } else {
      const { resumedFor: _x, resumedAt: _y, ...rest } = rec
      await writeLimit(h, home, id, { ...rest, tries: (rec.tries ?? 0) + 1, error: r.text.slice(0, 200) })
      did.push(`${id}: resume after the usage limit failed (${(rec.tries ?? 0) + 1}/${MAX_TRIES}): ${r.text.slice(0, 120)}`)
    }
  }
  return did
}
