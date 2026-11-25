// "Not logged in" is one fact for the whole desk, not a problem of one thread (1.0.33; field: four threads "ended at once" with no report, "ctx unknown", spend that did not move; the cause was the
// background sessions' login (expired / missing session); `claude auth login` fixed it, and nothing in the mod said so: only nudges, 8 turn ends in 5 minutes).
// By script, no model. The thread's own mod writes <thread>/turn-reason.json at every turn end (turnreason.ts): `auth` 'yes' when the engine named the login (classic.StopFailure's
// authentication_failed ... or an error text such as "not logged in" / "no session" / 401), 'maybe' when only the facts say it (no model call, ended within seconds, twice in a row).
// A thread with such a record is NOT nudged (continuepending.ts). The desk's tick (register.tsx, every 15 s) does the rest:
//   1. ONE alert when the first such thread shows up: "N threads cannot run: not logged in (t1, t2). Run claude auth login in a terminal, then restart them"; the notice stays in the pane
//      (key `auth-login`) and the state in desk/auth-alert.json; threads that join later are added to the notice, never alerted again.
//   2. When ANY thread's later turn has model usage the login works again: the notice and the state go, and every thread that was waiting (still open, same session, still failing) is restarted ONCE by
//      script with its task (leanThread auto-restart: never a closed or parked thread), one line says so.
//   3. `authHealth` / `authRows`: the finding the Health card and lean_doctor show (what is wrong and the fix).
import { homeDir, readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'
import { deskState } from './delivery'
import { setNotice } from './notices'
import { AUTH_FIX, readTurn } from './turnreason'
import type { Out } from './threads'

export type AuthState = { at: number; ids: string[]; kind: 'yes' | 'maybe' }
export const authFile = (home: string) => `${deskState(home)}/auth-alert.json`
export const AUTH_NOTICE = 'auth-login'
export const authText = (ids: string[], kind: 'yes' | 'maybe'): string =>
  kind === 'yes'
    ? `${ids.length} thread${ids.length === 1 ? '' : 's'} cannot run: not logged in (${ids.join(', ')}). Run claude auth login in a terminal, then restart them`
    : `${ids.length} thread${ids.length === 1 ? '' : 's'} ended at once with no model call (${ids.join(', ')}): check claude auth login / network, then restart them`
export const clearedText = (ids: string[]): string => `the login works again: ${ids.length ? `restarted ${ids.join(', ')} once with ${ids.length === 1 ? 'its' : 'their'} task` : 'nothing was waiting'}`

async function readState(h: Host, home: string): Promise<AuthState | null> {
  const s = await readJson<Partial<AuthState> | null>(h, authFile(home), null)
  return s && Number(s.at) > 0 && Array.isArray(s.ids) ? { at: Number(s.at), ids: s.ids.filter((x): x is string => typeof x === 'string'), kind: s.kind === 'maybe' ? 'maybe' : 'yes' } : null
}
type T = { id: string; state?: string; sid?: string; finished?: unknown }
async function scan(h: Host, home: string): Promise<{ failing: { id: string; kind: 'yes' | 'maybe'; sid: string }[]; workedAt: number }> {
  const failing: { id: string; kind: 'yes' | 'maybe'; sid: string }[] = []
  let workedAt = 0
  for (const e of await h.fs.list(threadsDir(home)).catch(() => [] as { name: string }[])) {
    if (!/^t\d+$/.test(e.name)) continue
    const tr = await readTurn(h, home, e.name)
    if (!tr) continue
    if (tr.usage || tr.steps > 0) workedAt = Math.max(workedAt, tr.at) // a request the model answered: the login works
    if (!tr.auth) continue
    const t = await readJson<T | null>(h, `${threadsDir(home)}/${e.name}/thread.json`, null)
    if (!t || t.state !== 'open' || !t.sid || t.finished || t.sid !== tr.sid) continue // closed, parked, finished or another session now: not waiting
    failing.push({ id: e.name, kind: tr.auth, sid: tr.sid })
  }
  return { failing, workedAt }
}

export type AuthDeps = { restart: (id: string, why: string) => Promise<Out> }
export async function authTick(h: Host, deps: AuthDeps): Promise<{ id: string; text: string }[]> {
  try {
    const home = await homeDir(h)
    const now = await h.clock.now()
    const have = await readState(h, home)
    const { failing, workedAt } = await scan(h, home)
    // the login works again: a later turn of any thread had model usage
    if (have && workedAt > have.at) {
      const restarted: string[] = []
      for (const f of failing) {
        const r = await deps.restart(f.id, 'Its previous session could not run (not logged in); the login works again, so this is a new session with the handover and its task.').catch(() => null)
        if (r?.ok) restarted.push(f.id)
      }
      await writeJson(h, authFile(home), {})
      await setNotice(h, AUTH_NOTICE, null).catch(() => undefined)
      return [{ id: 'auth', text: clearedText(restarted) }]
    }
    if (!failing.length) {
      if (have) {
        // nobody fails any more (closed, restarted by hand, a new session): the alert ends quietly
        await writeJson(h, authFile(home), {})
        await setNotice(h, AUTH_NOTICE, null).catch(() => undefined)
      }
      return []
    }
    const ids = failing.map(f => f.id)
    const kind: 'yes' | 'maybe' = failing.some(f => f.kind === 'yes') ? 'yes' : 'maybe'
    if (!have) {
      await writeJson(h, authFile(home), { at: now, ids, kind } satisfies AuthState)
      const text = authText(ids, kind)
      await setNotice(h, AUTH_NOTICE, text).catch(() => undefined)
      return [{ id: 'auth', text }] // the ONE alert
    }
    // later arrivals only change the standing notice
    if (ids.join(',') !== have.ids.join(',') || kind !== have.kind) {
      await writeJson(h, authFile(home), { ...have, ids, kind } satisfies AuthState)
      await setNotice(h, AUTH_NOTICE, authText(ids, kind)).catch(() => undefined)
    }
    return []
  } catch {
    return [] // a timer never throws
  }
}

// the finding for the Health card and lean_doctor: null when nothing waits for a login
export async function authHealth(h: Host): Promise<{ text: string; fix: string } | null> {
  try {
    const home = await homeDir(h)
    const { failing } = await scan(h, home)
    if (!failing.length) return null
    const ids = failing.map(f => f.id)
    const kind: 'yes' | 'maybe' = failing.some(f => f.kind === 'yes') ? 'yes' : 'maybe'
    return { text: authText(ids, kind), fix: `${AUTH_FIX} (in a terminal), then restart ${ids.join(', ')}; the desk restarts them once by itself when a thread's model call works again` }
  } catch {
    return null
  }
}
export async function authRows(h: Host): Promise<string[]> {
  const a = await authHealth(h)
  return a ? [`FIX  login: ${a.text}. Fix: ${a.fix}`] : []
}
