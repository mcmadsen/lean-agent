// Version skew. A session keeps the hooks module it loaded at start, while skills, agents and templates are read again from
// the plugin folder: after `claude plugin update` a long-lived session runs OLD code against NEW text (a 1.0.3 guard that
// refuses what the 1.0.4 explorer skill promises). The mod knows its own version (`running`, set once by register.tsx from
// pane.tsx VERSION) and compares it with the installed one; a difference is shown (status line, one prompt line, doctor).
import { homeDir } from './state'
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
