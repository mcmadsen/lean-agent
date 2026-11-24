// The desk that "Restart desk" left behind. No engine call archives a session, and a Desktop (SDK) desk is not in `claude agents`, so the
// mod cannot close it. A desk started with `claude --bg` IS listed, and `claude stop` / `claude rm` reach it. What the mod does:
//  - restartDesk records the old session's id and title here (desk/old-desk.json) AFTER the handover is saved and BEFORE the new desk opens;
//  - the new desk's session start, then at most once per new desk turn, say "archive it in the Claude app (right-click, Archive)"
//    (the pane lists the notice `old-desk` until it is settled; the doctor has a note row) until `claude agents --json --all` no longer
//    lists the old id as an active row;
//  - a desk session usually never appears in that listing. Then the mod cannot tell whether it was archived: the reminder stops by itself
//    24 h after "restarted at", or when the user dismisses it (lean_doctor dismiss-old-desk). It cannot repeat forever;
//  - config desk.closeOld (stop by default | remove | off): when the listing has the recorded id as an ACTIVE background row that runs in the
//    desk folder, the new desk's start runs `claude stop <id>` (remove: then `claude rm <id>` once the row shows no pid). Only the recorded id,
//    only after the handover was saved and only from a different (the new) session; a row that is working is never stopped (the next desk
//    turn tries again, 3 tries in all, then the reminder stays); a failure is logged, never thrown, and the reminder stays. closedAt / how
//    are recorded so it happens once. A stopped or removed desk is not mentioned again; one that is stopped but still listed gets one quiet line.
// Never --discard-unpushed / --force-remove-worktree, never the new desk, never a thread. The mod never kills the Claude app and never restarts a service.
import { homeDir, leanDir, readJson, realPath, writeJson, deskDir } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import { setNotice } from './notices'
import { isWorking, listAgents } from './threads'
import type { AgentRow } from './threads'

export const NOTICE_KEY = 'old-desk'
export const UNLISTED_MS = 24 * 3_600_000 // an old desk the listing never shows: the reminder ends this long after the restart
export const SEEN_MS = 7 * 24 * 3_600_000 // an old desk the listing keeps showing as active: the reminder ends this long after the restart
export const CLOSE_TRIES = 3 // desk.closeOld: attempts (a working row, a failed stop) before the mod falls back to the reminder
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
  handover?: boolean // set by recordOldDesk, which only runs after the handover was written: no close without it
  tries?: number // desk.closeOld attempts that did not close it (working row, failed stop)
  closedAt?: number // desk.closeOld: the old desk was stopped (how: stop) or stopped and removed (how: remove); done once
  how?: 'stop' | 'remove'
  quiet?: boolean // stopped but still listed: the one quiet line is out, the first desk turn after it ends the reminder
  log?: string[]
}
const file = (home: string) => `${deskState(home)}/old-desk.json`
export type CloseMode = 'stop' | 'remove' | 'off'
// config desk.closeOld (nested or flat spelling); anything else is the default, stop
export async function closeMode(h: Host): Promise<CloseMode> {
  const cfg = await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const v = cfg && typeof cfg === 'object' ? (cfg.desk?.closeOld ?? cfg['desk.closeOld']) : undefined
  return v === 'remove' || v === 'off' ? v : 'stop'
}
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
// the one parser of `claude agents --json --all` is threads.ts (parseAgents / listAgents); this adds the 15 s timeout (a hung service must not
// hang a desk turn; a timeout is a failed listing)
type Row = AgentRow
// null = the listing failed or was not JSON (never read as "the session is gone")
export async function listRows(h: Host): Promise<Row[] | null> {
  try {
    return await listAgents(h, 15_000)
  } catch {
    return null
  }
}
const hasId = (r: Row, sid: string) => r.sid === sid || r.id === sid
const rowOf = (rows: Row[], sid: string): Row | undefined => rows.find(r => hasId(r, sid))
// an active row: listed and not archived (a stopped background session is still in the app's list: still active here)
const isActive = (r: Row | undefined): r is Row => !!r && !r.archived && r.status !== 'archived' && r.state !== 'archived'

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
    const rec: OldDesk = { sid, title: flat(title, 80), restartedAt: await h.clock.now(), handover: true } // (only called once the handover was written)
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

// ---- desk.closeOld: stop (and remove) the old desk when it is a background session ---------------------------------------------------
// the exact recorded id as a background row that runs in the desk folder (rm also removes a worktree the session was started in): a desktop
// session, another folder, a partial id, or no folder is never closed
async function closable(h: Host, rec: OldDesk, row: Row | undefined): Promise<boolean> {
  if (!row || row.sid !== rec.sid) return false
  if (row.kind !== 'background' && row.kind !== 'bg') return false
  const desk = await realPath(h, deskDir(await homeDir(h)))
  return !!row.cwd && (await realPath(h, row.cwd)) === desk
}
const failed = (r: { exitCode: number; stdout?: string; stderr?: string } | null, what: string) => (r ? flat(r.stderr || r.stdout, 120) || `exit ${r.exitCode}` : `${what} could not be started`)

// One try. 'done' = closed (rec.closedAt / how are set), 'again' = counted as a try (working, a failed stop: the next desk turn tries again,
// CLOSE_TRIES in all), 'no' = nothing to do or not allowed. Never throws, and never touches a row that is working.
async function closeOld(h: Host, rec: OldDesk, row: Row, mySid: string, mode: CloseMode): Promise<'done' | 'again' | 'no'> {
  try {
    if (mode === 'off' || rec.closedAt || !rec.handover) return 'no' // (handover: recordOldDesk ran, so the handover was saved)
    if (!mySid || mySid === rec.sid || rec.newSid !== mySid) return 'no' // only from the new desk, never the old one itself
    if ((rec.tries ?? 0) >= CLOSE_TRIES || !(await closable(h, rec, row))) return 'no'
    const miss = async (text: string): Promise<'again'> => {
      rec.tries = (rec.tries ?? 0) + 1
      await logLine(h, rec, `desk.closeOld ${mode}: ${text} (try ${rec.tries} of ${CLOSE_TRIES})`)
      return 'again'
    }
    if (isWorking(row) || row.waitingFor) return await miss('the old desk is working, not stopped')
    if (row.pid > 0) {
      // look again right before the stop: a desk that went busy since the listing is never stopped
      const l = await listRows(h)
      const fresh = l ? rowOf(l, rec.sid) : undefined
      if (!l) return await miss('cannot list sessions (claude agents failed), so nothing is stopped')
      if (!isActive(fresh) || !(await closable(h, rec, fresh))) return 'no'
      if (isWorking(fresh) || fresh.waitingFor) return await miss('the old desk is working, not stopped')
      row = fresh
      const st = await h.process.run(['claude', 'stop', rec.sid], { timeoutMs: 15_000 }).catch(() => null)
      if (!st || st.exitCode !== 0) return await miss(`claude stop ${shortId(rec.sid)} failed (${failed(st, 'claude stop')})`)
      let cur: Row | undefined = row
      for (let n = 0; n < 5; n++) {
        const l = await listRows(h)
        cur = l ? rowOf(l, rec.sid) : cur
        if (l && (!cur || cur.pid === 0)) break
        if (n < 4) await h.process.run(['sleep', '1']).catch(() => undefined)
      }
      if (cur && cur.pid > 0) return await miss(`still running after claude stop ${shortId(rec.sid)}`)
      row = cur ?? row
      await logLine(h, rec, `claude stop ${shortId(rec.sid)}: stopped`)
    } else await logLine(h, rec, 'the old desk was already stopped')
    rec.closedAt = await h.clock.now()
    rec.how = 'stop'
    // remove: once, and only now that the row shows no pid. (no flag at all: never --discard-unpushed, never --force-remove-worktree)
    if (mode === 'remove' && !rec.rm && row.pid === 0 && (await closable(h, rec, row))) {
      const r = await h.process.run(['claude', 'rm', rec.sid], { timeoutMs: 15_000 }).catch(() => null)
      const ok = !!r && r.exitCode === 0
      rec.rm = { at: await h.clock.now(), ok, text: ok ? 'removed' : failed(r, 'claude rm') }
      await logLine(h, rec, `claude rm ${shortId(rec.sid)}: ${ok ? 'removed from the list (the conversation is kept)' : `failed (${rec.rm.text})`}`)
      if (ok) rec.how = 'remove'
    }
    return 'done'
  } catch (e) {
    rec.tries = (rec.tries ?? 0) + 1
    await logLine(h, rec, `desk.closeOld ${mode}: failed (${flat((e as Error)?.message, 80)}) (try ${rec.tries} of ${CLOSE_TRIES})`).catch(() => undefined)
    return 'again'
  }
}

async function settle(h: Host, rec: OldDesk, why: string): Promise<void> {
  rec.done = { at: await h.clock.now(), why }
  await logLine(h, rec, `settled: ${why}`)
  await save(h, rec)
  await setNotice(h, NOTICE_KEY, null)
}

let skipTurn = false // the session start already said it: the first turn of that session does not repeat it
const QUIET = 'stopped; archive it in the app when you like'
// Called by the new desk: `start` at its session start, `turn` at each of its turns. Returns the line for its next prompt (or null).
// A session that is the old desk itself, an unknown id, a settled or dismissed record: nothing happens (and no process is run).
export async function oldDeskStep(h: Host, sid: string, phase: 'start' | 'turn'): Promise<string | null> {
  try {
    const skip = phase === 'turn' && skipTurn // the first turn after the start that said it: no repeat (a pending close retry still runs)
    if (skip) skipTurn = false
    const rec = await readOldDesk(h)
    if (!rec || rec.done || rec.dismissed || !sid || sid === rec.sid) return null
    if (rec.quiet) {
      // stopped but still listed: its one quiet line was shown, the first desk turn after it ends it
      await settle(h, rec, 'stopped by desk.closeOld; the user was told once')
      return null
    }
    const mode = await closeMode(h)
    if (skip && !(rec.tries && !rec.closedAt && mode !== 'off')) return null
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
      if (isActive(row) && (await closeOld(h, rec, row, sid, mode)) === 'done') {
        rows = (await listRows(h)) ?? rows
        row = rowOf(rows, rec.sid)
        if (!isActive(row)) {
          await settle(h, rec, rec.how === 'remove' ? 'desk.closeOld: stopped and removed from the list' : 'desk.closeOld: stopped, and it is no longer an active row')
          return null // closed: nothing to remind
        }
        rec.quiet = true // stopped but still listed (a stop keeps the app's row): ONE quiet line, then it ends
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
    if (rec.quiet) {
      const line = `the old desk session ${who(rec)} is ${QUIET}`
      await save(h, rec)
      await setNotice(h, NOTICE_KEY, `lean-agent: ${line}`)
      if (phase === 'start') skipTurn = true
      return skip ? null : line
    }
    const text = reminder(rec, !!rec.seen)
    if (skip) {
      await save(h, rec) // (a retry on the skipped turn: its tries are kept, the reminder is not repeated)
      return null
    }
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
  // what desk.closeOld did (info rows, never an error): the user sees why there is no reminder
  if (rec.closedAt && rec.how) out.push(`note old desk: ${rec.how === 'remove' ? 'removed' : 'stopped'} (desk.closeOld ${rec.how})`)
  if (!rec.done && !rec.dismissed && !rec.closedAt) out.push(`note old desk session ${who(rec)}, replaced at ${at} UTC, is not known to be archived: ${HOW}; ${rec.seen ? 'the last listing showed it as an active row' : 'it never appeared in `claude agents --json --all`, so the mod cannot tell: the reminder ends 24 h after the restart, or run lean_doctor dismiss-old-desk'}`)
  // never in the listing: a desktop session the mod can neither see nor close (the row above is today's reminder text)
  if (!rec.closedAt && !rec.done && !rec.dismissed && !rec.seen && rec.handover) out.push('note old desk: desktop session, archive it in the app')
  if (rec.rm && !(rec.rm.ok && rec.how === 'remove')) out.push(`note claude rm of the old desk at ${new Date(rec.rm.at).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${rec.rm.ok ? 'removed from the list' : `failed: ${rec.rm.text}`}`)
  return out
}
