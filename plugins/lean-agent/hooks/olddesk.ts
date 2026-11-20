// The desk that "Restart desk" left behind. No engine call closes a session, and the old desk is a Desktop (SDK) session: `claude rm` and
// `claude stop` act on BACKGROUND sessions, so neither is assumed to reach it. What the mod does instead:
//  - restartDesk records the old session's id and title here (desk/old-desk.json) BEFORE the new desk opens;
//  - the new desk's session start, and then at most once per new desk turn, say "archive it in the Claude app (right-click, Archive)"
//    (the pane lists the notice `old-desk` until it is settled; the doctor has a note row) until `claude agents --json --all` no longer
//    lists the old id as an active row;
//  - a desk session usually never appears in that listing. Then the mod cannot tell whether it was archived: the reminder stops by itself
//    24 h after "restarted at", or when the user dismisses it (lean_doctor dismiss-old-desk). It cannot repeat forever;
//  - `claude rm <old id>` is tried ONLY when the listing has that exact id as a background-kind row that is not working and runs in the desk
//    folder (rm also removes a worktree the session was started in): never otherwise, never with --discard-unpushed / --force-remove-worktree,
//    never for the new desk. Its result is logged in the record (`log`).
// The mod never kills the Claude app and never restarts a service.
import { homeDir, readJson, realPath, writeJson, deskDir } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import { setNotice } from './notices'
import { isWorking } from './threads'
import type { AgentRow } from './threads'

export const NOTICE_KEY = 'old-desk'
export const UNLISTED_MS = 24 * 3_600_000 // an old desk the listing never shows: the reminder ends this long after the restart
export const SEEN_MS = 7 * 24 * 3_600_000 // an old desk the listing keeps showing as active: the reminder ends this long after the restart
const LOG_MAX = 10

export type OldDesk = {
  sid: string
  title: string
  restartedAt: number
  newSid?: string // the desk session that took over (the one the reminders are for)
  seen?: number // ms the listing last showed the old id as an active row
  said?: number // reminders given
  dismissed?: number
  done?: { at: number; why: string }
  rm?: { at: number; ok: boolean; text: string }
  log?: string[]
}
const file = (home: string) => `${deskState(home)}/old-desk.json`
const SID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/ // goes into an argv: a plain token that cannot be read as a flag
const flat = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export async function readOldDesk(h: Host): Promise<OldDesk | null> {
  const r = await readJson<OldDesk | null>(h, file(await homeDir(h)), null)
  return r && typeof r === 'object' && typeof r.sid === 'string' && SID.test(r.sid) && typeof r.restartedAt === 'number' ? r : null
}
async function save(h: Host, r: OldDesk): Promise<void> {
  await writeJson(h, file(await homeDir(h)), { ...r, log: (r.log ?? []).slice(-LOG_MAX) }).catch(() => undefined)
}
const logLine = async (h: Host, r: OldDesk, text: string): Promise<void> => {
  r.log = [...(r.log ?? []), `${new Date(await h.clock.now()).toISOString().slice(0, 16).replace('T', ' ')} UTC ${text}`.slice(0, 240)].slice(-LOG_MAX)
}

// ---- the listing: `claude agents --json --all` ---------------------------------------------------------------------
type Row = AgentRow & { ids: string[]; kind: string; archived: boolean }
// null = the listing failed or was not JSON (never read as "the session is gone")
export async function listRows(h: Host): Promise<Row[] | null> {
  let r
  try {
    r = await h.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: 15_000 }) // (a hung service must not hang a desk turn; a timeout is a failed listing)
  } catch {
    return null
  }
  if (r.exitCode !== 0) return null
  let v: any
  try {
    v = JSON.parse(r.stdout)
  } catch {
    return null
  }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? (v.agents ?? v.sessions ?? v.items) : null
  if (!Array.isArray(list)) return null
  const out: Row[] = []
  for (const x of list) {
    if (!x || typeof x !== 'object') continue
    const ids = [x.sessionId, x.session_id, x.id].filter((i: unknown): i is string => typeof i === 'string' && !!i)
    if (!ids.length) continue
    const status = String(x.status ?? x.state ?? '').toLowerCase()
    const state = String(x.state ?? '').toLowerCase()
    out.push({
      sid: ids[0]!,
      ids,
      name: String(x.name ?? ''),
      cwd: String(x.cwd ?? ''),
      status,
      startedAt: Number(x.startedAt ?? x.started_at ?? 0) || 0,
      pid: Number(x.pid) || 0,
      id: String(x.id ?? ''),
      state,
      waitingFor: x.waitingFor == null || x.waitingFor === false ? '' : String(x.waitingFor).slice(0, 120),
      kind: String(x.kind ?? '').toLowerCase(),
      archived: x.archived === true || status === 'archived' || state === 'archived',
    })
  }
  return out
}
const rowOf = (rows: Row[], sid: string): Row | undefined => rows.find(r => r.ids.includes(sid))
// an active row: listed and not archived (a stopped background session is still in the app's list: still active here)
const isActive = (r: Row | undefined): r is Row => !!r && !r.archived

// the title the old desk has in the listing, '' when it is not listed (best effort, never throws)
export async function titleOf(h: Host, sid: string): Promise<string> {
  try {
    const row = rowOf((await listRows(h)) ?? [], sid)
    return flat(row?.name, 80)
  } catch {
    return ''
  }
}

// ---- record (restartDesk, before the new desk opens) --------------------------------------------------------------
export async function recordOldDesk(h: Host, sid: string, title = ''): Promise<boolean> {
  if (!SID.test(sid)) return false
  try {
    const rec: OldDesk = { sid, title: flat(title, 80), restartedAt: await h.clock.now() }
    await logLine(h, rec, 'restart desk: this desk session is recorded as the old desk')
    await writeJson(h, file(await homeDir(h)), rec)
    await setNotice(h, NOTICE_KEY, null) // a notice about an earlier restart ends with the new record
    return true
  } catch {
    return false
  }
}

const shortId = (sid: string) => sid.slice(0, 8)
const who = (r: OldDesk) => `${r.title ? `'${r.title}' ` : ''}(${shortId(r.sid)})`
const HOW = 'archive it in the Claude app (right-click it in the session list, Archive)'
export const reminder = (r: OldDesk, listed: boolean): string =>
  listed
    ? `the old desk session ${who(r)} is still open in the Claude app: ${HOW}`
    : `the old desk session ${who(r)} is not in \`claude agents\` (a desktop session usually is not), so the mod cannot tell whether it is archived: ${HOW}, if you have not. This reminder stops 24 h after the restart, or when dismissed (lean_doctor dismiss-old-desk)`

// `claude rm` only for a session that is certainly a background one that is not working (see the header). true = it ran and succeeded.
async function tryRm(h: Host, rec: OldDesk, row: Row, mySid: string): Promise<boolean> {
  if (rec.rm) return false // once
  if (rec.sid === mySid || rec.sid === rec.newSid) return false // never the running desk
  if (!row.ids.includes(rec.sid)) return false
  if (row.kind !== 'background' && row.kind !== 'bg') return false
  if (isWorking(row) || row.pid > 0 || row.waitingFor) return false
  const home = await homeDir(h)
  const desk = await realPath(h, deskDir(home))
  if (!row.cwd || (await realPath(h, row.cwd)) !== desk) return false
  const r = await h.process.run(['claude', 'rm', rec.sid], { timeoutMs: 15_000 }).catch(() => null) // (no flag at all: never --discard-unpushed, never --force-remove-worktree)
  const ok = !!r && r.exitCode === 0
  rec.rm = { at: await h.clock.now(), ok, text: r ? flat(r.stderr || r.stdout, 120) || `exit ${r.exitCode}` : 'claude rm could not be started' }
  await logLine(h, rec, `claude rm ${shortId(rec.sid)}: ${ok ? 'removed from the list (the conversation is kept)' : `failed (${rec.rm.text})`}`)
  return ok
}

async function settle(h: Host, rec: OldDesk, why: string): Promise<void> {
  rec.done = { at: await h.clock.now(), why }
  await logLine(h, rec, `settled: ${why}`)
  await save(h, rec)
  await setNotice(h, NOTICE_KEY, null)
}

let skipTurn = false // the session start already said it: the first turn of that session does not repeat it
// Called by the new desk: `start` at its session start, `turn` at each of its turns. Returns the line for its next prompt (or null).
// A session that is the old desk itself, an unknown id, a settled or dismissed record: nothing happens (and no process is run).
export async function oldDeskStep(h: Host, sid: string, phase: 'start' | 'turn'): Promise<string | null> {
  try {
    if (phase === 'turn' && skipTurn) {
      skipTurn = false
      return null
    }
    const rec = await readOldDesk(h)
    if (!rec || rec.done || rec.dismissed || !sid || sid === rec.sid) return null
    const now = await h.clock.now()
    // however it was seen, the reminder is not forever: 24 h for a desk the listing never showed, 7 days for one it showed as active
    // (the `archived` marker of a row is an assumption about the listing: without it only this cap or a dismiss ends the reminder)
    if (now - rec.restartedAt > (rec.seen ? SEEN_MS : UNLISTED_MS)) {
      await settle(h, rec, rec.seen ? 'still listed as active after 7 days; the reminder window is over' : 'never listed in claude agents; the 24 h reminder window is over')
      return null
    }
    if (rec.newSid !== sid) {
      rec.newSid = sid
      await logLine(h, rec, `new desk session ${shortId(sid)} started`)
    }
    let rows = await listRows(h)
    if (!rows) {
      // the listing failed: nothing is concluded from it, but a never-seen old desk still ends 24 h after the restart
      if (!rec.seen && now - rec.restartedAt > UNLISTED_MS) {
        await settle(h, rec, 'never listed in claude agents; the 24 h reminder window is over')
        return null
      }
    } else {
      let row = rowOf(rows, rec.sid)
      if (isActive(row) && (await tryRm(h, rec, row, sid))) {
        rows = (await listRows(h)) ?? rows
        row = rowOf(rows, rec.sid)
        if (!isActive(row)) {
          await settle(h, rec, 'claude rm removed it from the list')
          return `the old desk session ${who(rec)} was removed from the app's list with claude rm (its conversation is kept)`
        }
      }
      if (isActive(row)) rec.seen = now
      else if (rec.seen) {
        await settle(h, rec, 'no longer an active row in claude agents')
        return null
      } else if (now - rec.restartedAt > UNLISTED_MS) {
        await settle(h, rec, 'never listed in claude agents; the 24 h reminder window is over')
        return null
      }
    }
    const text = reminder(rec, !!rec.seen)
    rec.said = (rec.said ?? 0) + 1
    await save(h, rec)
    await setNotice(h, NOTICE_KEY, `lean-agent: the old desk session ${who(rec)} is not archived: ${HOW}${rec.seen ? '' : '; the mod cannot see whether you did (dismiss: lean_doctor)'}`)
    if (phase === 'start') skipTurn = true
    return text
  } catch {
    return null // a reminder that cannot be worked out changes nothing
  }
}
export const resetOldDesk = (): void => {
  skipTurn = false
}

// The user says they dealt with it (or never want to hear of it): the notice and the reminders end.
export async function dismissOldDesk(h: Host, why = 'dismissed by the user'): Promise<{ ok: boolean; text: string }> {
  const rec = await readOldDesk(h)
  if (!rec) return { ok: false, text: 'no old desk session is recorded' }
  if (rec.done || rec.dismissed) return { ok: true, text: `the old desk session ${who(rec)} is already settled` }
  rec.dismissed = await h.clock.now()
  await logLine(h, rec, why)
  await save(h, rec)
  await setNotice(h, NOTICE_KEY, null)
  return { ok: true, text: `dismissed: no more reminders about the old desk session ${who(rec)}` }
}

// the doctor's lines (read-only: no listing is run here)
export async function oldDeskRows(h: Host): Promise<string[]> {
  const rec = await readOldDesk(h)
  if (!rec) return []
  const at = new Date(rec.restartedAt).toISOString().slice(0, 16).replace('T', ' ')
  const out: string[] = []
  if (!rec.done && !rec.dismissed) out.push(`note old desk session ${who(rec)}, replaced at ${at} UTC, is not known to be archived: ${HOW}; ${rec.seen ? 'the last listing showed it as an active row' : 'it never appeared in `claude agents --json --all`, so the mod cannot tell: the reminder ends 24 h after the restart, or run lean_doctor dismiss-old-desk'}`)
  if (rec.rm) out.push(`note claude rm of the old desk at ${new Date(rec.rm.at).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${rec.rm.ok ? 'removed from the list' : `failed: ${rec.rm.text}`}`)
  return out
}
