// State helpers: every file the mod keeps lives under ~/.lean-agent (resolved from $HOME at run time).
// The engine's $.fs has no rename or append, so atomic replace is write-temp + `mv -f` (argv, no shell)
// and append is `tee -a` (one O_APPEND write per record).

export type Host = {
  fs: {
    read: (p: string) => Promise<any>
    write: (p: string, t: string) => Promise<void>
    exists: (p: string) => Promise<boolean>
    list: (p?: string) => Promise<{ name: string; kind: string }[]>
    stat: (p: string, o?: { resolve?: boolean }) => Promise<{ kind: string; realPath?: string; size?: number }>
  }
  process: { run: (argv: readonly string[], init?: any) => Promise<{ exitCode: number; stdout: string; stderr: string }> }
  env: { get: (n: string) => Promise<string | undefined> }
  clock: { now: () => Promise<number> }
  store: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> } // the mod's own key-value store (not a file)
  ui?: { open: (pane: { id: string; title?: string }) => Promise<unknown> } // set by hostOf($) only (the fake host in the specs has none)
}

let seq = 0

export async function homeDir($: Host): Promise<string> {
  const h = await $.env.get('HOME')
  if (!h) throw new Error('HOME is not set')
  return h.replace(/\/+$/, '')
}

export async function realPath($: Host, p: string): Promise<string> {
  try {
    const s = await $.fs.stat(p, { resolve: true })
    return (s.realPath ?? p).replace(/(.)\/+$/, '$1')
  } catch {
    return p
  }
}

export const leanDir = (home: string) => `${home}/.lean-agent`
export const deskDir = (home: string) => `${home}/lean-agent-desk`
export const threadsDir = (home: string) => `${leanDir(home)}/threads`

export function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export async function mkdirp($: Host, dir: string): Promise<void> {
  const r = await $.process.run(['mkdir', '-p', dir])
  if (r.exitCode !== 0) throw new Error(`mkdir ${dir} failed`)
}

// Replace `path` with `text` so a concurrent reader sees the old or the new file, never half of one.
export async function atomicWrite($: Host, path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${++seq}-${Math.floor(Math.random() * 1e9).toString(36)}`
  await $.fs.write(tmp, text) // creates the directory
  const r = await $.process.run(['mv', '-f', tmp, path])
  if (r.exitCode !== 0) {
    await $.process.run(['rm', '-f', tmp])
    throw new Error(`atomic write to ${path} failed`)
  }
}

export const writeJson = ($: Host, path: string, v: unknown) => atomicWrite($, path, JSON.stringify(v, null, 2) + '\n')

export async function appendJsonl($: Host, path: string, rec: unknown): Promise<void> {
  await mkdirp($, dirOf(path))
  const r = await $.process.run(['tee', '-a', path], { stdin: JSON.stringify(rec) + '\n' })
  if (r.exitCode !== 0) throw new Error(`append to ${path} failed`)
}

async function readText($: Host, path: string): Promise<string | null> {
  try {
    const v = await $.fs.read(path)
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

// Tolerant reads: a missing, empty or damaged file gives the fallback, never an exception.
export async function readJson<T>($: Host, path: string, fallback: T): Promise<T> {
  const t = await readText($, path)
  if (t === null || !t.trim()) return fallback
  try {
    return JSON.parse(t) as T
  } catch {
    return fallback
  }
}

export async function readJsonl<T = unknown>($: Host, path: string): Promise<T[]> {
  const t = await readText($, path)
  if (!t) return []
  const out: T[] = []
  for (const line of t.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      /* a torn or damaged line is skipped */
    }
  }
  return out
}
