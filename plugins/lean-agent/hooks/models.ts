// Which model and effort a session runs on. The desk is pinned (sonnet, high); a thread gets sonnet/medium unless the
// brief asks for more or less. config.json: `desk: { model, effort }`, `threads: { model, effort }` override the defaults.
import { atomicWrite, dirOf, leanDir, mkdirp, readJson } from './state'
import type { Host } from './state'

export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high'] as const
export type Choice = { model: string; effort: string }
export const DESK_DEFAULT: Choice = { model: 'sonnet', effort: 'high' }
export const THREAD_DEFAULT: Choice = { model: 'sonnet', effort: 'medium' }

const okModel = (m: unknown): m is string => typeof m === 'string' && (MODELS as readonly string[]).includes(m)
const okEffort = (e: unknown): e is string => typeof e === 'string' && (EFFORTS as readonly string[]).includes(e)

async function cfg(h: Host, home: string, key: 'desk' | 'threads'): Promise<Partial<Choice>> {
  const c = await readJson<Record<string, any>>(h, `${leanDir(home)}/config.json`, {})
  const v = c?.[key]
  return v && typeof v === 'object' ? v : {}
}

export async function deskChoice(h: Host, home: string): Promise<Choice> {
  const c = await cfg(h, home, 'desk')
  return { model: okModel(c.model) ? c.model : DESK_DEFAULT.model, effort: okEffort(c.effort) ? c.effort : DESK_DEFAULT.effort }
}

// a thread's choice: the call's, else the thread's recorded one, else config.json, else the default; a bad value is an error
export async function threadChoice(h: Host, home: string, given: { model?: string; effort?: string }, recorded?: Partial<Choice>): Promise<Choice | string> {
  if (given.model !== undefined && !okModel(given.model)) return `model must be one of ${MODELS.join(', ')}`
  if (given.effort !== undefined && !okEffort(given.effort)) return `effort must be one of ${EFFORTS.join(', ')}`
  const c = await cfg(h, home, 'threads')
  const pick = (g: string | undefined, r: string | undefined, conf: unknown, ok: (x: unknown) => boolean, d: string) => g ?? (ok(r) ? r! : ok(conf) ? (conf as string) : d)
  return {
    model: pick(given.model, recorded?.model, c.model, okModel, THREAD_DEFAULT.model),
    effort: pick(given.effort, recorded?.effort, c.effort, okEffort, THREAD_DEFAULT.effort),
  }
}

// The settings.json keys for a choice (`model`, `effortLevel`).
export const settingsKeys = (c: Choice) => ({ model: c.model, effortLevel: c.effort })

// Merge the two keys into a settings file, keeping every other key; a file that does not parse is left alone (false).
export async function mergeModelSettings(h: Host, path: string, c: Choice): Promise<boolean> {
  let cur: Record<string, unknown> = {}
  if (await h.fs.exists(path)) {
    try {
      const t = String(await h.fs.read(path))
      const v = t.trim() ? JSON.parse(t) : {}
      if (!v || typeof v !== 'object' || Array.isArray(v)) return false
      cur = v
    } catch {
      return false
    }
  }
  const next = { ...cur, ...settingsKeys(c) }
  if (JSON.stringify(next) === JSON.stringify(cur)) return true
  await mkdirp(h, dirOf(path))
  await atomicWrite(h, path, JSON.stringify(next, null, 2) + '\n')
  return true
}

export async function readModelSettings(h: Host, path: string): Promise<Partial<Choice> | null> {
  try {
    const v = JSON.parse(String(await h.fs.read(path)))
    return v && typeof v === 'object' ? { model: v.model, effort: v.effortLevel } : null
  } catch {
    return null
  }
}
