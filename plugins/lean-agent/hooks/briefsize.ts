// The desk is warned BEFORE it starts an oversized thread (1.0.26; script, never a refusal). `lean_thread new` / `start` / `send` lint the brief:
//   (a) the file and folder paths named in it are resolved against the project (existing files only) and their sizes summed (bytes / 4 = tokens;
//       a folder counts its files, not recursive, up to FOLDER_FILES);
//   (b) fan-out words ("all", "every", "full", "each of") are counted, and so are the sources named (a list of 5 or more);
//   (c) the thread's free context is its limit minus its FIXED base (ctxparts.ts; unknown: DEFAULT_BASE).
// When the named sources exceed half the free context, or the count rule fires, the reply and the brief get one line saying to split the task:
// a READING thread that writes a summary file and a WRITING thread that reads only that file.
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'

export const LINT_SHARE = 0.5
export const DEFAULT_BASE = 40_000
export const FOLDER_FILES = 50
export const MAX_PATHS = 60
const FILE_EXT = 'md|markdown|txt|ts|tsx|js|jsx|mjs|json|ya?ml|toml|py|rs|go|java|kt|cs|rb|php|html|css|sql|sh|log|csv'
// one whole token: a path with a slash (`a/b.ext`, `./x`, `/abs/y`, `dir/`) or a bare file name with a known extension
const PATH = new RegExp(`^(?:(?:~\\/|\\/|\\.{1,2}\\/)?[\\w.@+-]+(?:\\/[\\w.@+-]+)*\\/[\\w.@+-]*|[\\w-][\\w.-]*\\.(?:${FILE_EXT}))$`)
const FAN = /\b(all|every|full|each of)\b/gi
const k = (n: number) => `${Math.max(1, Math.round(n / 1000))}k`

// the path-like words of a brief (no URL), distinct, in order. Token by token on the first SCAN_CHARS (a brief can be huge: a regex over the
// whole text backtracked quadratically on a long run of word characters).
export const SCAN_CHARS = 40_000
const TOKEN_MAX = 300
export function pathWords(text: string): string[] {
  const out: string[] = []
  for (const raw of text.slice(0, SCAN_CHARS).split(/[\s,;()<>"'`]+/)) {
    const w = raw.replace(/[.,;:!?)\]]+$/, '')
    if (w.length < 3 || w.length > TOKEN_MAX || w.includes('://') || !PATH.test(w)) continue
    if (!out.includes(w)) out.push(w)
    if (out.length >= MAX_PATHS) break
  }
  return out
}
export const fanWords = (text: string): string[] => [...text.matchAll(FAN)].map(m => m[1]!.toLowerCase())

// bytes of the existing files the words name: absolute (or ~/) as written, relative ones under each root; a folder counts its files
export async function sourceBytes(h: Host, words: string[], roots: string[], home: string): Promise<{ bytes: number; files: number; found: number }> {
  let bytes = 0
  let files = 0
  let found = 0
  const seen = new Set<string>()
  const size = async (p0: string): Promise<boolean> => {
    const p = p0.length > 1 ? p0.replace(/\/+$/, '') : p0
    if (seen.has(p)) return true
    const st = await h.fs.stat(p).catch(() => null)
    if (!st) return false
    seen.add(p)
    if (st.kind === 'file') {
      bytes += Number(st.size) || 0
      files++
    } else if (st.kind === 'dir' || st.kind === 'directory') {
      const rows = (await h.fs.list(p).catch(() => [])).filter(r => r && r.kind === 'file').slice(0, FOLDER_FILES)
      for (const r of rows) {
        const fs = await h.fs.stat(`${p.replace(/\/$/, '')}/${r.name}`).catch(() => null)
        if (fs) { bytes += Number(fs.size) || 0; files++ }
      }
    } else return false
    return true
  }
  for (const w of words) {
    const cands = w.startsWith('~/') ? [`${home}/${w.slice(2)}`] : w.startsWith('/') ? [w] : roots.map(r => `${r.replace(/\/$/, '')}/${w.replace(/^\.\//, '')}`)
    for (const c of cands) if (await size(c)) { found++; break }
  }
  return { bytes, files, found }
}

export type Lint = { line: string; tokens: number; free: number; sources: number }
export const lintLine = (tokens: number, free: number): string =>
  `this task reads about ${k(tokens)} tokens of sources into a thread with ${k(free)} free: split it: a READING thread that writes a summary file (one section per source) and a WRITING thread that reads only that file`

// the free context: the limit minus the fixed base (unknown: DEFAULT_BASE)
export const freeOf = (limit: number, fixed?: number | null): number => Math.max(0, limit - (typeof fixed === 'number' && fixed > 0 ? fixed : DEFAULT_BASE))

export async function briefLint(h: Host, text: string, roots: string[], o: { limit: number; fixed?: number | null }): Promise<Lint | null> {
  try {
    const words = pathWords(text)
    const fan = fanWords(text)
    const src = words.length ? await sourceBytes(h, words, roots, await homeDir(h)) : { bytes: 0, files: 0, found: 0 }
    const tokens = Math.round(src.bytes / 4)
    const free = freeOf(o.limit, o.fixed)
    const big = tokens > free * LINT_SHARE
    const count = src.found >= 5 || (fan.length >= 2 && src.found >= 2) // (sources that exist: "and/or" is not one)
    if (!big && !count) return null
    const why = !big ? ` (${src.found} sources named${fan.length ? `, fan-out words: ${[...new Set(fan)].join(', ')}` : ''})` : ''
    return { line: lintLine(tokens, free) + why, tokens, free, sources: src.found }
  } catch {
    return null
  }
}

// the roots a brief's relative paths are tried under: the project's path (projects.json) and the thread's worktree (worktrees.json)
export async function lintRoots(h: Host, project: string, thread?: string): Promise<string[]> {
  try {
    const home = await homeDir(h)
    const out: string[] = []
    const projs = await readJson<Record<string, { path?: unknown }>>(h, `${leanDir(home)}/projects.json`, {})
    const p = project && projs && typeof projs === 'object' ? projs[project]?.path : undefined
    if (typeof p === 'string' && p.startsWith('/')) out.push(p)
    if (thread) {
      const wts = await readJson<Record<string, { path?: unknown; thread?: unknown }>>(h, `${leanDir(home)}/worktrees.json`, {})
      for (const w of Object.values(wts && typeof wts === 'object' ? wts : {})) if (w && w.thread === thread && typeof w.path === 'string') out.unshift(w.path)
    }
    return out
  } catch {
    return []
  }
}

// "free context 78k (limit 120k, base 42k)" (+ the probe hint when the base is over 40k) for the start reply
export function freeText(limit: number, fixed?: number | null): string {
  const base = typeof fixed === 'number' && fixed > 0 ? fixed : DEFAULT_BASE
  const known = typeof fixed === 'number' && fixed > 0
  const head = `free context ${k(freeOf(limit, fixed))} (limit ${k(limit)}, base ${known ? '' : '~'}${k(base)}${known ? '' : ' assumed'})`
  return base > DEFAULT_BASE ? `${head}; run lean_doctor overhead probe to see what the base is made of` : head
}
