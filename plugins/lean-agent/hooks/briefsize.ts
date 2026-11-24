// The desk is warned BEFORE it starts an oversized thread (1.0.26; script, never a refusal). `lean_thread new` / `start` / `send` lint the brief:
//   (a) the file and folder paths named in it are resolved against the project (existing files only) and their sizes summed (bytes / 4 = tokens;
//       a folder counts its files, not recursive, up to FOLDER_FILES);
//   (b) fan-out words ("all", "every", "full", "each of") are counted, and so are the sources named (a list of 5 or more);
//   (c) the thread's free context is its limit minus its FIXED base (ctxparts.ts; unknown: DEFAULT_BASE).
// When the named sources exceed half the free context, or the count rule fires, the reply and the brief get one line saying to split the task:
// a READING thread that writes a summary file and a WRITING thread that reads only that file. 1.0.32: only sources the brief names count (paths, folders,
// globs that exist; binary and generated files are left out); no hint at all when it names none, or below config tasks.splitHintTokens (60000); the line says what
// was counted. The unit is bytes / 4 from the size the engine's fs.stat reports for each file: no running counter of any kind goes into it.
import { homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { scratchList } from './scratchnotes'
import { cfgNum } from './budgetcfg'

export const LINT_SHARE = 0.5
export const DEFAULT_BASE = 40_000
export const SPLIT_HINT_TOKENS = 60_000 // the default of config tasks.splitHintTokens
export const FOLDER_FILES = 50
export const MAX_PATHS = 60
const FILE_EXT = 'md|markdown|txt|ts|tsx|js|jsx|mjs|json|ya?ml|toml|py|rs|go|java|kt|cs|rb|php|html|css|sql|sh|log|csv'
// one whole token: a path with a slash (`a/b.ext`, `./x`, `/abs/y`, `dir/`) or a bare file name with a known extension
// (a glob such as `src/**/*.ts` is a path word too: `*` is allowed inside a segment, expanded by sourceBytes)
const PATH = new RegExp(`^(?:(?:~\\/|\\/|\\.{1,2}\\/)?[\\w.@+*-]+(?:\\/[\\w.@+*-]+)*\\/[\\w.@+*-]*|[\\w*-][\\w.*-]*\\.(?:${FILE_EXT}))$`)
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
// Files a thread never reads as text are not counted (1.0.31 counted a folder's every file: a build folder of bundles, source maps and packages
// read as ~22M tokens): images, archives, packages (zip, crx, vsix), fonts, compiled output, source maps, lock files, minified bundles. They are
// reported as `skipped`, so the line says what it left out.
const SKIP_FILE = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|tar|rar|jar|war|crx|vsix|xpi|exe|dll|so|dylib|bin|wasm|class|o|a|node|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|map|lock|lockb|sqlite3?|db|pyc)$|\.min\.(js|css)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/i
export const isUnread = (name: string): boolean => SKIP_FILE.test(name)
// ---- globs ------------------------------------------------------------------------------------------------------------------------
export const GLOB_DEPTH = 4
export const GLOB_FILES = 200
const segRe = (s: string): RegExp => new RegExp(`^${s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
const isDirKind = (k: string) => k === 'dir' || k === 'directory'
// the files a glob path matches: `*` inside one segment, `**` for any folders below (up to GLOB_DEPTH), at most GLOB_FILES files
export async function globFiles(h: Host, pattern: string): Promise<string[]> {
  const segs = pattern.split('/')
  const first = segs.findIndex(s => s.includes('*'))
  if (first < 1) return []
  const out: string[] = []
  const walk = async (base: string, rest: string[], depth: number): Promise<void> => {
    if (out.length >= GLOB_FILES || depth > GLOB_DEPTH || !rest.length) return
    const [s, ...tail] = rest as [string, ...string[]]
    const rows = ((await h.fs.list(base).catch(() => [])) as { name: string; kind: string }[]).filter(r => r && typeof r.name === 'string')
    if (s === '**') {
      await walk(base, tail, depth) // zero folders
      for (const r of rows) if (isDirKind(r.kind) && r.name !== 'node_modules' && r.name !== '.git') await walk(`${base}/${r.name}`, rest, depth + 1)
      return
    }
    const re = segRe(s)
    for (const r of rows) {
      if (out.length >= GLOB_FILES) return
      if (!re.test(r.name)) continue
      if (!tail.length) { if (r.kind === 'file') out.push(`${base}/${r.name}`) }
      else if (isDirKind(r.kind) && r.name !== 'node_modules' && r.name !== '.git') await walk(`${base}/${r.name}`, tail, depth + 1)
    }
  }
  await walk(segs.slice(0, first).join('/') || '/', segs.slice(first), 0)
  return [...new Set(out)]
}

export type Sources = { bytes: number; files: number; found: number; skipped: number; largest: { name: string; bytes: number }[] }
export async function sourceBytes(h: Host, words: string[], roots: string[], home: string): Promise<Sources> {
  let bytes = 0
  let files = 0
  let found = 0
  let skipped = 0
  const all: { name: string; bytes: number }[] = []
  const seen = new Set<string>() // a file named on its own and again through its folder is counted once
  const add = (p: string, n: number): void => {
    if (seen.has(`f:${p}`)) return
    seen.add(`f:${p}`)
    if (isUnread(p)) { skipped++; return }
    bytes += n
    files++
    all.push({ name: p.split('/').pop() ?? p, bytes: n })
  }
  const size = async (p0: string): Promise<boolean> => {
    const p = p0.length > 1 ? p0.replace(/\/+$/, '') : p0
    if (seen.has(p)) return true
    const st = await h.fs.stat(p).catch(() => null)
    if (!st) return false
    seen.add(p)
    if (st.kind === 'file') add(p, Number(st.size) || 0)
    else if (st.kind === 'dir' || st.kind === 'directory') {
      const rows = (await h.fs.list(p).catch(() => [])).filter(r => r && r.kind === 'file').slice(0, FOLDER_FILES)
      for (const r of rows) {
        const cp = `${p.replace(/\/$/, '')}/${r.name}`
        const fs = await h.fs.stat(cp).catch(() => null)
        if (fs) add(cp, Number(fs.size) || 0)
      }
    } else return false
    return true
  }
  for (const w of words) {
    const cands = w.startsWith('~/') ? [`${home}/${w.slice(2)}`] : w.startsWith('/') ? [w] : roots.map(r => `${r.replace(/\/$/, '')}/${w.replace(/^\.\//, '')}`)
    if (w.includes('*')) {
      // a glob: the files it matches (not recursive past GLOB_DEPTH folders, never node_modules or .git), each counted once
      for (const c of cands) {
        const hit = await globFiles(h, c)
        if (!hit.length) continue
        found++
        for (const f of hit) {
          const st = await h.fs.stat(f).catch(() => null)
          if (st && st.kind === 'file') add(f, Number(st.size) || 0)
        }
        break
      }
      continue
    }
    for (const c of cands) if (await size(c)) { found++; break }
  }
  return { bytes, files, found, skipped, largest: all.sort((a, b) => b.bytes - a.bytes).slice(0, 3) }
}

export type Lint = { line: string; tokens: number; free: number; sources: number }
export const lintLine = (tokens: number, free: number): string =>
  `this task reads about ${k(tokens)} tokens of sources into a thread with ${k(free)} free: split it: a READING thread that writes a summary file (one section per source) and a WRITING thread that reads only that file`
const mb = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`)
// what the estimate counted, so the thread can split sensibly: files, bytes, tokens (bytes / 4), the largest files, what was left out
export const countedText = (s: Sources, tokens: number): string =>
  `counted ${s.files} file${s.files === 1 ? '' : 's'} from ${s.found} named source${s.found === 1 ? '' : 's'}, ${mb(s.bytes)}, bytes / 4 = ${k(tokens)} tokens${s.largest.length ? `; largest: ${s.largest.map(x => `${x.name} ${mb(x.bytes)}`).join(', ')}` : ''}${s.skipped ? `; ${s.skipped} binary or generated file${s.skipped === 1 ? '' : 's'} not counted` : ''}`

// the free context: the limit minus the fixed base (unknown: DEFAULT_BASE)
export const freeOf = (limit: number, fixed?: number | null): number => Math.max(0, limit - (typeof fixed === 'number' && fixed > 0 ? fixed : DEFAULT_BASE))

export async function briefLint(h: Host, text: string, roots: string[], o: { limit: number; fixed?: number | null }): Promise<Lint | null> {
  try {
    const words = pathWords(text)
    const fan = fanWords(text)
    const src: Sources = words.length ? await sourceBytes(h, words, roots, await homeDir(h)) : { bytes: 0, files: 0, found: 0, skipped: 0, largest: [] }
    const tokens = Math.round(src.bytes / 4)
    const free = freeOf(o.limit, o.fixed)
    if (!src.found) return null // the brief names no file, folder or glob that exists: nothing to estimate, no hint
    const floor = (await cfgNum(h, 'tasks.splitHintTokens').catch(() => null)) ?? SPLIT_HINT_TOKENS // config tasks.splitHintTokens (0 = no floor)
    if (tokens < floor) return null // a small estimate never gets the hint, however many sources or fan-out words
    const big = tokens > free * LINT_SHARE
    const count = src.found >= 5 || (fan.length >= 2 && src.found >= 2) // (sources that exist: "and/or" is not one)
    if (!big && !count) return null
    const why = !big ? ` (${src.found} sources named${fan.length ? `, fan-out words: ${[...new Set(fan)].join(', ')}` : ''})` : ''
    return { line: `${lintLine(tokens, free)}${why} (${countedText(src, tokens)})`, tokens, free, sources: src.found }
  } catch {
    return null
  }
}

// A WORKER brief over BRIEF_SOFT characters (the hard cap is workers.briefChars, 3000) while the thread has scratch / notes files: one soft hint
// in the Agent call's result (1.0.27; never a refusal): point at the file instead of restating it.
export const BRIEF_SOFT = 1_500
export const briefHintText = (file: string, chars: number): string => `brief of ${chars} characters: point at ${file} instead of restating it (workers read files cheaply)`
export async function briefHint(h: Host, prompt: string, threadDir: string): Promise<string | null> {
  if (prompt.length <= BRIEF_SOFT) return null
  const scratch = await scratchList(h, threadDir)
  const file = scratch[0] ? `${threadDir}/scratch/${scratch[0].name}` : (await h.fs.exists(`${threadDir}/notes.md`).catch(() => false)) ? `${threadDir}/notes.md` : ''
  return file ? briefHintText(file, prompt.length) : null
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
