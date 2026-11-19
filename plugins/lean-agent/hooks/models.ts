// Which model and effort a session runs on. The desk is pinned (opus, high: the user's decision; config.json `desk` wins); a thread gets sonnet/high unless the
// brief asks for more or less. config.json: `desk: { model, effort }`, `threads: { model, effort }` override the defaults.
import { atomicWrite, dirOf, leanDir, mkdirp, readJson } from './state'
import type { Host } from './state'

export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high'] as const
export type Choice = { model: string; effort: string }
export const DESK_DEFAULT: Choice = { model: 'opus', effort: 'high' } // the alias `opus` is the latest Opus; config.json `desk` overrides
export const THREAD_DEFAULT: Choice = { model: 'sonnet', effort: 'high' }

// `claude-sonnet-5-5` and `sonnet` are the same family; a name of no known family is returned as it is
export const modelFamily = (m: string): string => (/haiku/i.test(m) ? 'haiku' : /sonnet/i.test(m) ? 'sonnet' : /opus/i.test(m) ? 'opus' : m)

const okModel = (m: unknown): m is string => typeof m === 'string' && (MODELS as readonly string[]).includes(m)
const okEffort = (e: unknown): e is string => typeof e === 'string' && (EFFORTS as readonly string[]).includes(e)

async function cfg(h: Host, home: string, key: 'desk' | 'threads'): Promise<Partial<Choice>> {
  const c = await readJson<Record<string, any>>(h, `${leanDir(home)}/config.json`, {})
  const v = c?.[key]
  return v && typeof v === 'object' ? v : {}
}

// does config.json set the desk's model (then that wins over the default, and a pin that differs from the default is the user's own)?
export async function deskModelConfigured(h: Host, home: string): Promise<boolean> {
  return okModel((await cfg(h, home, 'desk')).model)
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

// The Claude app opens a file only inside the session's folders ("This file is outside this session's folders"): the desk folder's
// settings list ~/.lean-agent in permissions.additionalDirectories so the desk can open the feedback export, handovers and
// reviews there. Merged, never replaced: every other key (and every other directory the user listed) stays. A file that does not
// parse is left alone (false).
export async function mergeAdditionalDirectory(h: Host, path: string, dir: string): Promise<boolean> {
  let cur: Record<string, any> = {}
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
  const perms = cur.permissions && typeof cur.permissions === 'object' && !Array.isArray(cur.permissions) ? cur.permissions : {}
  const dirs: unknown[] = Array.isArray(perms.additionalDirectories) ? perms.additionalDirectories : []
  if (dirs.includes(dir)) return true
  const next = { ...cur, permissions: { ...perms, additionalDirectories: [...dirs, dir] } }
  await mkdirp(h, dirOf(path))
  await atomicWrite(h, path, JSON.stringify(next, null, 2) + '\n')
  return true
}

// Is `dir` in the settings file's permissions.additionalDirectories? (A missing or unparsable file: no.)
export async function hasAdditionalDirectory(h: Host, path: string, dir: string): Promise<boolean> {
  try {
    const v = JSON.parse(String(await h.fs.read(path)))
    const dirs = v?.permissions?.additionalDirectories
    return Array.isArray(dirs) && dirs.includes(dir)
  } catch {
    return false
  }
}

export async function readModelSettings(h: Host, path: string): Promise<Partial<Choice> | null> {
  try {
    const v = JSON.parse(String(await h.fs.read(path)))
    return v && typeof v === 'object' ? { model: v.model, effort: v.effortLevel } : null
  } catch {
    return null
  }
}
