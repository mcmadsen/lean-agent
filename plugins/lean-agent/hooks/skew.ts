// Version skew. A session keeps the hooks module it loaded at start, while skills, agents and templates are read again from
// the plugin folder: after `claude plugin update` a long-lived session runs OLD code against NEW text (a 1.0.3 guard that
// refuses what the 1.0.4 explorer skill promises). The mod knows its own version (`running`, set once by register.tsx from
// pane.tsx VERSION) and compares it with the installed one; a difference is shown (status line, one prompt line, doctor).
import { homeDir, readJson, threadsDir } from './state'
import type { Host } from './state'

export const running = { version: '' } // the version of this code; '' = unknown (specs, helpers used alone)
export const setRunning = (v: string) => {
  running.version = v
}

const CACHE_MS = 60_000
let cache: { at: number; key: string; installed: string | null } | null = null
export const resetSkew = () => {
  cache = null
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
const parts = (v: string) => v.split(/[-+]/)[0]!.split('.').map(Number)
// -1, 0, 1 (a pre-release suffix is ignored)
export function compareVersions(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1
  return 0
}

async function manifestVersion(h: Host, file: string): Promise<string | null> {
  try {
    const v = JSON.parse(String(await h.fs.read(file)))?.version
    return typeof v === 'string' && SEMVER.test(v) ? v : null
  } catch {
    return null
  }
}

// The installed version: the highest of (1) the plugin root's own manifest (the folder the engine says the plugin lives in:
// a stable path moves with an update) and (2) Claude Code's install registry (~/.claude/plugins/installed_plugins.json,
// the entries of a plugin called lean-agent: the update writes the new version there even when this session still has
// the old folder). null = neither could be read.
export async function installedVersion(h: Host, root: string): Promise<string | null> {
  const found: string[] = []
  const m = await manifestVersion(h, `${root.replace(/\/+$/, '')}/.claude-plugin/plugin.json`)
  if (m) found.push(m)
  try {
    const home = await homeDir(h)
    const reg = JSON.parse(String(await h.fs.read(`${home}/.claude/plugins/installed_plugins.json`)))
    const plugins = reg?.plugins && typeof reg.plugins === 'object' ? reg.plugins : reg
    for (const [k, list] of Object.entries<any>(plugins ?? {})) {
      if (k.split('@')[0] !== 'lean-agent') continue
      for (const e of Array.isArray(list) ? list : [list]) {
        const v = typeof e?.version === 'string' ? e.version : null
        if (v && SEMVER.test(v)) found.push(v)
      }
    }
  } catch {
    /* no registry: the manifest alone decides */
  }
  return found.sort(compareVersions).pop() ?? null
}

// The install keys (`lean-agent@<marketplace>`) in Claude Code's registry: what `enabledPlugins` names to switch the plugin off
// for one run (compare's clean column). Empty = not installed (a dev copy loaded by folder).
export async function installedKeys(h: Host): Promise<string[]> {
  try {
    const reg = JSON.parse(String(await h.fs.read(`${await homeDir(h)}/.claude/plugins/installed_plugins.json`)))
    const plugins = reg?.plugins && typeof reg.plugins === 'object' ? reg.plugins : reg
    return Object.keys(plugins ?? {}).filter(k => k.split('@')[0] === 'lean-agent')
  } catch {
    return []
  }
}

// ---- what a THREAD's session really runs ----
// The thread's own mod writes `running` {version, sid, at} into thread.json when its session starts (role.ts recordRunning): its own
// VERSION, the code that session loaded. thread.json `version` is only what the DESK saw installed when it started the session, so a
// session that loaded an older plugin than the one installed was recorded as the new version and nobody could tell. `running` counts
// only for the session the record names (a restart replaces the session; the old record is then stale and ignored).
export type RunningRec = { version: string; sid: string; at: number }
export function runningOf(t: { sid?: string; running?: unknown } | null | undefined): string {
  const r = t?.running as Partial<RunningRec> | undefined
  if (!r || typeof r.version !== 'string' || !SEMVER.test(r.version) || typeof r.sid !== 'string' || !r.sid) return ''
  return t?.sid && r.sid === t.sid ? r.version : '' // (the older session's id is in `sids`, never `sid`: its record is stale)
}
export const runsText = (run: string, installed: string) => `running ${run}, installed ${installed}`
// '' = same, or either one unknown
export const threadSkew = (run: string, installed: string | null): string => (run && installed && compareVersions(run, installed) !== 0 ? runsText(run, installed) : '')

// The open threads (not parked, closing or closed) whose current session runs another lean-agent version than the installed one (the doctor's rows).
export async function skewedThreads(h: Host, root: string): Promise<{ id: string; run: string; installed: string }[]> {
  const installed = await installedVersion(h, root)
  if (!installed) return []
  const dir = threadsDir(await homeDir(h))
  const out: { id: string; run: string; installed: string }[] = []
  for (const e of await h.fs.list(dir).catch(() => [] as { name: string }[])) {
    if (!/^t\d+$/.test(e.name)) continue
    const t = await readJson<{ state?: string; sid?: string; running?: unknown } | null>(h, `${dir}/${e.name}/thread.json`, null)
    // only a thread with a session that can still run: a closed one is never reopened for this, and a parked one has no session (its record is
    // the ended one's; the session it gets at its next wake loads whatever is installed then)
    if (!t || t.state !== 'open') continue
    const run = runningOf(t)
    if (threadSkew(run, installed)) out.push({ id: e.name, run, installed })
  }
  return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
}

// What the user can do when a session started on an older plugin than the installed one. The cause: lean-agent pins nothing (the thread
// settings only switch OTHER plugins off, checked in threads.ts threadSettings), and the plugin cache keeps every version's folder, so an
// older path still works; the Claude background service that starts `claude --bg` sessions keeps the plugin state it loaded when it
// started and hands it to every session it starts until it is restarted. lean-agent never restarts a service itself.
export const SKEW_CAUSE =
  'cause: lean-agent pins no version (a thread\'s settings only switch other plugins off); the Claude background service that starts `claude --bg` sessions keeps the plugin it loaded when it started, and the plugin cache still holds the older version. ' +
  'What you can do: when no thread is working, quit and reopen the Claude app (that restarts the service), then restart the thread from the pane. lean-agent never restarts services itself'

// The doctor's ONE row for the threads whose session loaded an older plugin than the installed one (1.0.33; field: five identical rows of
// 600 characters, one per thread). One thread: its own row. Several: one row naming each with the version it runs, the restart step for every
// one of them (lean_thread restart <id>: a new session with its handover; only open threads are listed, a closed one is never reopened and a
// parked one has no session), and the one thing that makes the restart useless (the service still holds the old plugin).
export function skewRow(older: { id: string; run: string; installed: string }[]): string {
  if (!older.length) return ''
  const first = older[0]!
  if (older.length === 1) return `thread ${first.id} ${runsText(first.run, first.installed)}: its session loaded the older plugin; do not ask it for what ${first.installed} added. ${SKEW_CAUSE}`
  const names = older.map(s => `${s.id} (${s.run})`).join(', ')
  const ids = older.map(s => s.id).join(' ')
  const latest = older.map(s => s.installed).sort(compareVersions).pop()!
  return `${older.length} threads run an older plugin than the installed ${latest}: ${names}; their sessions loaded the older plugin: do not ask them for what ${latest} added. ${SKEW_CAUSE.replace('restart the thread from the pane', `restart each one (lean_thread restart <id> for ${ids}: a new session with its handover; if it still runs the older version after that, the service was not restarted)`)}`
}

export const skewText = (run: string, installed: string) =>
  `lean-agent code ${run} is running but ${installed} is installed: start a new session (threads: close and Start)`

// The skew sentence, or null (same or older install, or either one unknown). Cached for a minute: cheap enough for every turn.
export async function skewNote(h: Host, root: string, run: string = running.version): Promise<string | null> {
  if (!run) return null
  const now = await h.clock.now()
  const key = `${root}\0${run}`
  if (!cache || cache.key !== key || now - cache.at > CACHE_MS || now < cache.at) cache = { at: now, key, installed: await installedVersion(h, root) }
  const inst = cache.installed
  return inst && compareVersions(inst, run) > 0 ? skewText(run, inst) : null // only a NEWER install: a dev copy or a rollback is not skew
}
