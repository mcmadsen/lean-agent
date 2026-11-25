// The automatic desk restart, the parts around it (the decision is deskcompact.ts autoRestartDesk, the restart itself restartDesk):
//  - the loop guard: an automatic restart only when the last one is more than 30 minutes ago and fewer than `desk.autoRestartPerDay` (default 12) happened in the last 24 h
//    (desk/auto-restarts.json); a blocked one says so ONCE per restart (a notice; the caller puts the amber status line) and waits for the button;
//  - the record the new desk finds at its start (desk/auto-started.json: when, why, which session it replaced) for its first notice;
//  - the old desk retiring itself: desk.json names ONE current desk session; any other desk session is retired (its timers and the hooks
//    that act do nothing, and it answers a prompt with one line). The new desk's start stamps `startedAt` into desk.json for that line.
import { homeDir, leanDir, readJson, writeJson } from './state'
import type { Host } from './state'
import { deskFile, deskState } from './delivery'
import { setNotice } from './notices'

export const AUTO_GAP_MS = 30 * 60_000
export const AUTO_MAX = 12 // config desk.autoRestartPerDay (default 12; was a fixed 4 until 1.0.30: a low desk.contextLimit reached it in a day)
async function autoMax(h: Host): Promise<number> {
  const cfg = await readJson<any>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const v = cfg && typeof cfg === 'object' ? (cfg.desk?.autoRestartPerDay ?? cfg['desk.autoRestartPerDay']) : undefined
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100 ? v : AUTO_MAX
}
export const AUTO_WINDOW_MS = 24 * 3_600_000
// A restart the USER asks for (the pane's Restart desk button, /lean-agent-restart-desk) ignores the two guards above (the gap and the per-day count are for AUTOMATIC
// restarts); its one limit is a hard floor: no desk restart of any kind within 60 s of the last one (desk/last-restart.json, written by restartDesk).
export const RESTART_FLOOR_MS = 60_000
export const noRestartNote = (ms: number): string => `next restart possible in ${Math.max(1, Math.ceil(ms / 1000))} s`
const floorFile = (home: string) => `${deskState(home)}/last-restart.json`
export async function noteRestartAt(h: Host): Promise<void> {
  await writeJson(h, floorFile(await homeDir(h)), { at: await h.clock.now() }).catch(() => undefined)
}
// ms until a restart is allowed again (0 = now)
export async function restartWaitMs(h: Host): Promise<number> {
  const v = await readJson<{ at?: unknown } | null>(h, floorFile(await homeDir(h)), null).catch(() => null)
  const at = typeof v?.at === 'number' ? v.at : 0
  const now = await h.clock.now()
  return at > 0 && now >= at ? Math.max(0, RESTART_FLOOR_MS - (now - at)) : 0
}
export const AUTO_FRESH_MS = 15 * 60_000 // the new desk's start finds its record this long
export const GUARD_NOTICE = 'desk-autorestart-guard'

export type AutoKind = 'context' | 'version' | 'model' | 'tools'
type Run = { at: number; kind: AutoKind; text: string }
type AutoLog = { runs: Run[]; said?: number }
const logFile = (home: string) => `${deskState(home)}/auto-restarts.json`
const startFile = (home: string) => `${deskState(home)}/auto-started.json`
const flat = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const KINDS = ['context', 'version', 'model', 'tools']
export const clockText = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`

export async function readAutoLog(h: Host): Promise<AutoLog> {
  const v = await readJson<Partial<AutoLog> | null>(h, logFile(await homeDir(h)), null)
  const runs = Array.isArray(v?.runs) ? v!.runs.filter((r): r is Run => !!r && typeof r.at === 'number' && KINDS.includes(String(r.kind)) && typeof r.text === 'string') : []
  return { runs, ...(typeof v?.said === 'number' ? { said: v.said } : {}) }
}
const writeAutoLog = async (h: Host, l: AutoLog): Promise<void> => writeJson(h, logFile(await homeDir(h)), l).catch(() => undefined)

export async function lastAutoRun(h: Host): Promise<Run | null> {
  const { runs } = await readAutoLog(h)
  return runs.reduce<Run | null>((a, r) => (!a || r.at > a.at ? r : a), null)
}

// null = an automatic restart may happen now; else why not (the text for the notice and the amber line)
export async function autoGuard(h: Host): Promise<string | null> {
  const now = await h.clock.now()
  const { runs } = await readAutoLog(h)
  const last = Math.max(0, ...runs.map(r => r.at))
  if (last && now >= last && now - last < AUTO_GAP_MS) return `the last automatic desk restart was ${Math.max(1, Math.round((now - last) / 60_000))} min ago (at most one every 30 min)`
  const n = runs.filter(r => now - r.at < AUTO_WINDOW_MS && r.at <= now).length
  const max = await autoMax(h)
  if (n >= max) return `${n} automatic desk restarts in the last 24 h (the limit is ${max}: config desk.autoRestartPerDay)`
  return null
}

// ONE notice per blocked restart (the same last-restart time says it once); true = it was said now
export async function sayGuardOnce(h: Host, why: string, need: string): Promise<boolean> {
  const log = await readAutoLog(h)
  const last = Math.max(0, ...log.runs.map(r => r.at))
  if (log.said === last && last > 0) return false
  await writeAutoLog(h, { ...log, said: last })
  await setNotice(h, GUARD_NOTICE, `the desk should restart (${need}) but not automatically: ${why}. Press Restart desk in the pane`)
  return true
}

export async function noteAutoRun(h: Host, kind: AutoKind, text: string): Promise<void> {
  const now = await h.clock.now()
  const log = await readAutoLog(h)
  await writeAutoLog(h, { runs: [...log.runs.filter(r => now - r.at < AUTO_WINDOW_MS), { at: now, kind, text: flat(text, 160) }].slice(-20) })
  await setNotice(h, GUARD_NOTICE, null)
}

// ---- the record for the new desk ------------------------------------------------------------------------------------------------
type Started = { at: number; reason: string; kind: AutoKind; from: string; cancelled?: boolean; taken?: string }
export async function writeAutoStart(h: Host, rec: { reason: string; kind: AutoKind; from: string }): Promise<void> {
  await writeJson(h, startFile(await homeDir(h)), { at: await h.clock.now(), reason: flat(rec.reason, 160), kind: rec.kind, from: rec.from } satisfies Started).catch(() => undefined)
}
export async function cancelAutoStart(h: Host): Promise<void> {
  const home = await homeDir(h)
  const cur = await readJson<Started | null>(h, startFile(home), null)
  if (cur) await writeJson(h, startFile(home), { ...cur, cancelled: true }).catch(() => undefined)
}
// the first desk session that is not the one that wrote it takes it, once (a resume of the same new desk says nothing again)
async function takeAutoStart(h: Host, sid: string): Promise<Started | null> {
  const home = await homeDir(h)
  const rec = await readJson<Started | null>(h, startFile(home), null)
  if (!rec || typeof rec.at !== 'number' || typeof rec.reason !== 'string' || rec.cancelled || rec.taken || !sid || rec.from === sid) return null
  const now = await h.clock.now()
  if (now < rec.at || now - rec.at > AUTO_FRESH_MS) return null
  await writeJson(h, startFile(home), { ...rec, taken: sid }).catch(() => undefined)
  return rec
}

// What the handover that was served lists as open: questions, requests, approvals, grants, threads (the same lines the old desk's mod wrote)
export function handoverDigest(body: string): string {
  const sec = (title: string): string[] => {
    const m = new RegExp(`\\n## ${title}[^\\n]*\\n([^]*?)(?=\\n## |\\n<!--|$)`).exec(`\n${body}`)
    return (m?.[1] ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('- ') || /^\| t\d+ /.test(l))
  }
  const parts: [string, string[]][] = [
    ['open question(s)', sec('Unanswered thread questions')],
    ['pending request(s)', sec('Pending requests')],
    ['pending approval(s)', sec('Pending approvals')],
    ['grant(s)', sec('Grants in force')],
    ['open thread(s)', sec('Open threads')],
  ]
  const have = parts.filter(([, l]) => l.length)
  if (!have.length) return ''
  const head = have.map(([n, l]) => `${l.length} ${n}`).join(', ')
  const items = have.filter(([n]) => !n.startsWith('open thread')).flatMap(([, l]) => l.slice(0, 2).map(x => flat(x.replace(/^- /, ''), 110)))
  return `the handover lists ${head}${items.length ? `: ${items.join(' | ')}` : ''}`.slice(0, 900)
}

// The lines of a desk session's start: the handover served (button or script alike), when the script started this desk why, what the handover
// lists, then the old desk's one reminder. `oldDesk`: oldDeskStep's text.
export async function deskStartLines(h: Host, sid: string, o: { served: string | null; body: string | null; oldDesk: string | null }): Promise<string[]> {
  await noteDeskStart(h, sid)
  const out: string[] = []
  if (o.served) out.push(o.served)
  const auto = await takeAutoStart(h, sid)
  if (auto) out.push(`this desk was started automatically at ${clockText(auto.at)} because ${auto.reason}; ${o.served ? 'the handover was read' : 'no handover was found (read desk/handover.md if it exists)'}`)
  const dig = o.served && o.body ? handoverDigest(o.body) : ''
  if (dig) out.push(dig)
  if (o.oldDesk) out.push(o.oldDesk)
  return out
}

// ---- the old desk retires itself --------------------------------------------------------------------------------------------------
type DeskRec = { sid?: string; startedAt?: number; startedSid?: string }
let retiredNow = false // the last look said: this session is not the current desk (notify.ts reads it: toasts are acts too)
export const isRetiredNow = (): boolean => retiredNow
export const resetAuto = (): void => {
  retiredNow = false
}

// the current desk is the session desk.json names; stamped with the time its start was seen (the old desk's line says when)
export async function noteDeskStart(h: Host, sid: string): Promise<void> {
  if (!sid) return
  try {
    const home = await homeDir(h)
    const cur = await readJson<DeskRec | null>(h, deskFile(home), null)
    if (cur && typeof cur === 'object' && cur.sid === sid && cur.startedSid !== sid) await writeJson(h, deskFile(home), { ...cur, startedAt: await h.clock.now(), startedSid: sid })
  } catch {
    /* the line says "earlier" */
  }
}

// null = this session is the current desk (or nothing says otherwise); else when the newer one started (0 = not known)
export async function retiredInfo(h: Host, sid: string): Promise<{ startedAt: number } | null> {
  try {
    if (!sid) return (retiredNow = false), null
    const home = await homeDir(h)
    const cur = await readJson<DeskRec | null>(h, deskFile(home), null)
    if (!cur || typeof cur.sid !== 'string' || !cur.sid || cur.sid === sid) return (retiredNow = false), null
    retiredNow = true
    return { startedAt: cur.startedSid === cur.sid && typeof cur.startedAt === 'number' ? cur.startedAt : 0 }
  } catch {
    return null
  }
}

export const retiredLine = (info: { startedAt: number }): string => {
  const line = `this desk was replaced by a newer one (started ${info.startedAt ? clockText(info.startedAt) : 'earlier'}): use the newer session`
  return `[lean-agent] ${line.charAt(0).toUpperCase()}${line.slice(1)}. Answer this prompt with exactly this one line and nothing else (no tool call, no other text): "${line}"`
}
