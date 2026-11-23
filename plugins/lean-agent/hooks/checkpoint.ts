// The checkpoint a thread can make itself (1.0.29; field: a thread near its context cap wrote "Next: my context is near its cap, so a fresh session continues ..." and
// ended its turn: the mod restarts only AT the limit and a thread cannot restart itself, so the thread, the desk and the user all waited).
//   lean_run {checkpoint: {next: "<the next step, 1-3 sentences>"}}  (the thread's own session only; register.tsx)
// The mod writes the state snapshot, checks that the thread wrote its notes since the warn line (scratch/notes.md or notes.md; else it writes `next` into scratch/next.md
// itself), records a marker <thread folder>/checkpoint.json {reason: 'checkpoint', next, ...} and answers "checkpoint saved. End your turn now ...". The desk's timer
// (checkpointTick) restarts the thread CHECKPOINT_IDLE_MS after the marker, by script: a fresh session with the core handover and `next` as its LAST instruction (the
// restart-text path); no desk message, no user step, no wait for the limit. Loop guard: one automatic restart per thread per 10 minutes (autorestart.json `last`, shared with
// the limit restart): a fresh session that asks again sooner gets a notice instead.
// The same restart is made for a turn that ANNOUNCES one ("Next: my context is near its cap, a fresh session continues ...", continuepending.ts) and for a report that asks
// the desk for a restart (register.tsx). One desk line per restart: "t7 restarted itself at 104k (checkpoint)".
import { homeDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { setNotice } from './notices'
import { buildSnapshot, writeSnapshot } from './snapshot'
import { kTokens, readContext } from './threadcontext'
import { readStop } from './contextstop'
import { NOTES_FILE } from './scratchnotes'
import { autoRestartOn, markerFile, MAX_TRIES, MIN_GAP_MS, stopGraceMs } from './autorestart'
import { isWorking } from './threads'
import type { AgentRow, Out, Thread } from './threads'

export const CHECKPOINT_IDLE_MS = 10_000 // the session must have ended its turn this long ago (the thread is told to end it at once)
export const NEXT_MAX = 600
export const NEXT_FILE = 'next.md'

export type CheckpointRec = { reason: 'checkpoint'; ts: number; sid: string; tokens: number; next: string; source: 'call' | 'announce' | 'report'; notes: boolean; tries?: number }
export const checkpointFile = (home: string, id: string) => `${threadsDir(home)}/${id}/checkpoint.json`
export const warnFile = (home: string, id: string) => `${threadsDir(home)}/${id}/warn-at.json`

export const savedText = (next: string) => `checkpoint saved. End your turn now: you are restarted automatically and continue with: ${next}`
export const restartedText = (id: string, tokens: number) => `${id} restarted itself${tokens > 0 ? ` at ${kTokens(tokens)}` : ''} (checkpoint)`
export const restartInstruction = (next: string) => `Continue now with: ${next}`
const guardText = (min: number) => `checkpoint refused: this thread was restarted ${min} min ago (one automatic restart per 10 minutes). Keep working from your notes; the mod restarts you at the context limit. Never end your turn asking the desk or the user for a restart.`

// ---- what announces a restart (pure; change the tables here, nowhere else) ----------------------------------------------------------
// ASKS: a text that asks for a fresh session / a restart of the thread itself. ANNOUNCE (a short announced "next:" line): the same plus the context-cap words.
// A bare "restart" is not enough ("next: restart the dev server" is a step); the restart has to be of the session, the thread or the context.
const ASKS = [
  /\b(?:fresh|new) session\b/,
  /\brestart(?:ed|ing)? (?:me|myself|this (?:session|thread)|my (?:session|thread)|the (?:session|thread)|t\d+)\b/,
  /\b(?:ask(?:ed|ing)?|request(?:ed|ing)?|need(?:s)?) (?:the )?desk (?:for|to) (?:a )?restart/,
  /\bplease restart (?:me|t\d+)\b/,
  /\bnear (?:its|the|my|our) (?:context )?(?:cap|limit)\b/,
  /\bcontext is (?:near|at|almost|nearly|close)\b/,
]
const ANNOUNCE = [...ASKS, /\bcontext (?:limit|cap)\b/, /\bout of context\b/]
export const asksRestart = (text: unknown): boolean => typeof text === 'string' && ASKS.some(re => re.test(text.toLowerCase()))
export const announcesRestart = (text: unknown): boolean => typeof text === 'string' && ANNOUNCE.some(re => re.test(text.toLowerCase()))

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

// ---- the warn line's time (the thread's own mod writes it once per session; "notes newer than the warn line") ----------------------------
export async function noteWarn(h: Host, id: string, sid: string): Promise<void> {
  try {
    const home = await homeDir(h)
    const w = await readJson<{ sid?: string } | null>(h, warnFile(home, id), null)
    if (w?.sid !== sid) await writeJson(h, warnFile(home, id), { sid, at: await h.clock.now() })
  } catch {
    /* no warn time: any notes file counts */
  }
}
async function warnAt(h: Host, home: string, id: string, sid: string): Promise<number> {
  const w = await readJson<{ sid?: string; at?: number } | null>(h, warnFile(home, id), null)
  return w?.sid === sid && typeof w.at === 'number' ? w.at : 0
}

// did the thread write notes since the warn line? scratch/notes.md or notes.md (in its folder)
async function notesFresh(h: Host, dir: string, since: number): Promise<boolean> {
  for (const p of [`${dir}/scratch/${NOTES_FILE}`, `${dir}/${NOTES_FILE}`]) {
    const s = await h.fs.stat(p).catch(() => null)
    if (s && s.kind === 'file' && Number(s.size) > 0 && (Number((s as { mtimeMs?: number }).mtimeMs) || 0) >= since) return true
  }
  return false
}

// ---- the request (the call, an announcing turn, a report) ----------------------------------------------------------------------------
export type CheckpointIn = { sid: string; next: string; source: CheckpointRec['source']; tokens?: number; snapshot?: { edited?: string[]; tasks?: unknown } }
export async function requestCheckpoint(h: Host, id: string, o: CheckpointIn): Promise<Out> {
  try {
    const home = await homeDir(h)
    const dir = `${threadsDir(home)}/${id}`
    const t = await readJson<Thread | null>(h, `${dir}/thread.json`, null)
    if (!t || t.state !== 'open' || !t.sid || t.finished || !o.sid || (t.sid !== o.sid && !t.sids?.includes(o.sid))) return { ok: false, text: 'checkpoint refused: it is for the open thread\'s own current session only' }
    const next = flat(String(o.next ?? '')).slice(0, NEXT_MAX)
    if (!next) return { ok: false, text: 'checkpoint refused: give next, the next step in 1-3 sentences (lean_run {checkpoint: {next: "..."}})' }
    if (!(await autoRestartOn(h, home))) return { ok: false, text: 'checkpoint refused: automatic restarts are off (threads.autoRestart): keep working from your notes; the mod stops you at the context limit' }
    if (await readStop(h, home, id, t.sid)) return { ok: true, text: 'you are already stopped at the context limit: the mod restarts you from the handover. End your turn now.' }
    const have = await readJson<Partial<CheckpointRec> | null>(h, checkpointFile(home, id), null)
    if (have && have.sid === t.sid && typeof have.next === 'string' && have.next) return { ok: true, text: savedText(have.next) } // asked twice: the first stands
    const now = await h.clock.now()
    const last = (await readJson<{ last?: { at?: number } } | null>(h, markerFile(home, id), null))?.last
    if (last && typeof last.at === 'number' && now - last.at < MIN_GAP_MS) return { ok: false, text: guardText(Math.max(0, Math.round((now - last.at) / 60_000))) }
    const ctx = o.tokens ?? (await readContext(h, home, t))?.tokens ?? 0
    if (o.snapshot) await writeSnapshot(h, home, await buildSnapshot(h, home, id, { sid: t.sid, tokens: ctx || null, edited: o.snapshot.edited, tasks: o.snapshot.tasks }))
    const notes = await notesFresh(h, dir, await warnAt(h, home, id, t.sid))
    if (!notes) await h.fs.write(`${dir}/scratch/${NEXT_FILE}`, `Next: ${next}\n\n(written by the mod at the checkpoint: no notes were written since the context warning; the first line is the next step)\n`)
    await writeJson(h, checkpointFile(home, id), { reason: 'checkpoint', ts: now, sid: t.sid, tokens: ctx, next, source: o.source, notes } satisfies CheckpointRec)
    return { ok: true, text: savedText(next) }
  } catch (e) {
    return { ok: false, text: `checkpoint failed: ${(e as Error)?.message ?? e}` }
  }
}

// ---- the desk's tick -----------------------------------------------------------------------------------------------------------------
export type CheckpointDeps = {
  agents: () => Promise<AgentRow[] | null>
  restart: (id: string, why: string, force: boolean, text: string) => Promise<Out> // text: the LAST instruction of the fresh session
}
export type CheckpointNotice = { id: string; text: string }

let ticking = false
export async function checkpointTick(h: Host, deps: CheckpointDeps): Promise<CheckpointNotice[]> {
  if (ticking) return []
  ticking = true
  try {
    return await tickOnce(h, deps)
  } catch {
    return [] // a timer never throws
  } finally {
    ticking = false
  }
}

async function tickOnce(h: Host, deps: CheckpointDeps): Promise<CheckpointNotice[]> {
  const home = await homeDir(h)
  const ids = (await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])).map(e => e.name).filter(n => /^t\d+$/.test(n))
  const out: CheckpointNotice[] = []
  let rows: AgentRow[] | null | undefined
  const grace = await stopGraceMs(h, home)
  for (const id of ids) {
    const p = await readJson<Partial<CheckpointRec> | null>(h, checkpointFile(home, id), null)
    if (!p || p.reason !== 'checkpoint' || typeof p.sid !== 'string' || typeof p.ts !== 'number' || typeof p.next !== 'string') continue
    const drop = () => writeJson(h, checkpointFile(home, id), {})
    const t = await readJson<Thread | null>(h, `${threadsDir(home)}/${id}/thread.json`, null)
    const now = await h.clock.now()
    if (!t || t.state !== 'open' || t.sid !== p.sid || t.finished || !(await autoRestartOn(h, home))) {
      await drop() // parked, closed, finished, another session (the limit restart came first) or switched off: stale
      continue
    }
    if (now - p.ts < CHECKPOINT_IDLE_MS) continue
    rows ??= await deps.agents()
    if (!rows) continue
    const row = rows.find(a => a.sid === p.sid)
    if (!row) {
      await drop()
      continue
    }
    if (row.waitingFor) continue // a real open prompt is the user's
    if (isWorking(row) && now - p.ts < grace) continue // idle first; after the grace minutes a session that still works is stopped (it was told to end its turn)
    const r = await deps.restart(id, `Checkpoint at ${kTokens(p.tokens ?? 0)}: the thread asked for a fresh session and continues with its next step (restarted by script).`, isWorking(row), restartInstruction(p.next))
    if (r.ok && (r.data as { fresh?: boolean } | undefined)?.fresh) {
      await drop()
      const mk = await readJson<Record<string, unknown> | null>(h, markerFile(home, id), null)
      await writeJson(h, markerFile(home, id), { last: { at: now, oldSid: p.sid }, ...(mk?.stopped ? { stopped: true } : {}) })
      await setNotice(h, `restart-${id}`, null)
      out.push({ id, text: restartedText(id, p.tokens ?? 0) })
    } else {
      const tries = (p.tries ?? 0) + 1
      if (tries >= MAX_TRIES) {
        await drop()
        const text = `${id}: the checkpoint restart failed ${tries} times (last reason: ${r.text.slice(0, 160)}). Say "restart ${id}" and the desk starts it fresh from the handover.`
        out.push({ id, text })
        await setNotice(h, `restart-${id}`, text)
      } else await writeJson(h, checkpointFile(home, id), { ...p, tries })
    }
  }
  return out
}
