// The ledger and its rollup. ledger.jsonl is append-only (one row per model request, written by budget.ts `record`); this
// module is the ONE reader: it understands both row schemas, folds rows into per-day aggregates kept in rollup.json, and
// rotates the file. Nothing here ever deletes or rewrites a ledger row: rotation is a rename.
//
//   1.0 row:  {ts: ms, role, tN?, agentId?, agent?, model, in?, out?, cache_read?, cache_write?, usd}   (zero fields are left out)
//   0.45 row: {ts: ISO string, model, role? (the worker role), thread?, project, usage: {input_tokens, cache_creation_input_tokens,
//              cache_read_input_tokens, output_tokens}, cost_usd: number|null, ...} (about 2 KB each: the bulk of an old ledger)
//
// Files: ledger.jsonl (the current one), ledger-YYYY-MM.jsonl (a past month, renamed), ledger-legacy.jsonl (a file that starts
// with a 0.45 row, renamed once). The rollup remembers a byte offset per file, so each sync reads only what is new; it is
// rebuilt from the files when it is missing, damaged, or a file is shorter than its offset.
import { atomicWrite, homeDir, leanDir, readJson } from './state'
import type { Host } from './state'
import { withFolderLock } from './folderlock'
import { setNotice } from './notices'

export const LEDGER = 'ledger.jsonl'
export const LEDGER_RE = /^ledger(?:-legacy|-\d{4}-\d{2})?(?:-\d+)?\.jsonl$/
export const ROLLUP = 'rollup.json'
export const KEEP_DAYS = 120 // days kept in the rollup
const enc = new TextEncoder()
const dec = new TextDecoder()

export const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10)

// ---- rows ------------------------------------------------------------------------------------------------------
// effort / tmodel: a thread's row carries the effort and model the thread was started with (absent on older rows and on 0.45 rows)
export type Norm = { ts: number; role: string; tN: string; agent: string; model: string; in: number; out: number; cr: number; cw: number; usd: number; legacy: boolean; effort?: string; tmodel?: string }
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const shortAgent = (a: string) => a.replace(/^lean-agent:/, '')

// One row of either schema, or null (not a ledger row).
export function normalizeRow(o: unknown): Norm | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, any>
  if (typeof r.ts === 'number' && Number.isFinite(r.ts) && Math.abs(r.ts) <= 8.64e15 && typeof r.usd === 'number') { // (a ts that is no date would throw in dayOf: a damaged row)
    return { ts: r.ts, role: str(r.role) || 'unknown', tN: str(r.tN) || '-', agent: shortAgent(str(r.agent)) || 'main', model: str(r.model) || '?', in: num(r.in), out: num(r.out), cr: num(r.cache_read), cw: num(r.cache_write), usd: r.usd, legacy: false, ...(str(r.effort) ? { effort: str(r.effort) } : {}), ...(str(r.tmodel) ? { tmodel: str(r.tmodel) } : {}) }
  }
  if (typeof r.ts === 'string' && ('cost_usd' in r || (r.usage && typeof r.usage === 'object'))) {
    const iso = /(?:Z|[+-]\d\d:?\d\d)$/.test(r.ts) ? r.ts : `${r.ts}Z` // 0.45 wrote naive times: read as UTC
    const ts = Date.parse(iso)
    if (!Number.isFinite(ts)) return null
    const u = r.usage && typeof r.usage === 'object' ? r.usage : {}
    return { ts, role: 'unknown', tN: str(r.thread) || '-', agent: str(r.role) || 'main', model: str(r.model) || '?', in: num(u.input_tokens), out: num(u.output_tokens), cr: num(u.cache_read_input_tokens), cw: num(u.cache_creation_input_tokens), usd: num(r.cost_usd), legacy: true }
  }
  return null
}

// ---- aggregates ------------------------------------------------------------------------------------------------
export type Agg = [usd: number, input: number, output: number, cacheRead: number, cacheWrite: number, requests: number]
export type Dim = Record<string, Agg>
// rm: `role|model`; rmm: the same, main requests only; tme: the rows of a real thread that carry an effort (written since this version; a
// row or a day folded earlier has none), keyed `tN|model|effort` = the thread's own choice (thread.json)
export type Day = { t: Agg; model: Dim; agent: Dim; role: Dim; tN: Dim; rm: Dim; rmm: Dim; tme?: Dim }
// files: bytes folded per ledger file; ids: the start of each file's first line (a file is the same file only while its start is)
export type Rollup = { v: 2; files: Record<string, number>; ids: Record<string, string>; days: Record<string, Day>; rows: number; legacy: number; bad: number }
const ID_LEN = 256
const idOf = (text: string) => text.split('\n')[0]!.slice(0, ID_LEN) // the first line (a 1.0 row is one line of about 150 bytes)

export const zero = (): Agg => [0, 0, 0, 0, 0, 0]
export function addTo(a: Agg, r: Norm) {
  a[0] += r.usd
  a[1] += r.in
  a[2] += r.out
  a[3] += r.cr
  a[4] += r.cw
  a[5] += 1
}
export function merge(a: Agg, b: Agg) {
  for (let i = 0; i < 6; i++) a[i] = (a[i] ?? 0) + (b[i] ?? 0)
}
const bump = (d: Dim, k: string, r: Norm) => addTo((d[k] ??= zero()), r)
const emptyDay = (): Day => ({ t: zero(), model: {}, agent: {}, role: {}, tN: {}, rm: {}, rmm: {} })
export const emptyRollup = (): Rollup => ({ v: 2, files: {}, ids: {}, days: {}, rows: 0, legacy: 0, bad: 0 })

export function addRow(ro: Rollup, r: Norm) {
  const d = (ro.days[dayOf(r.ts)] ??= emptyDay())
  addTo(d.t, r)
  bump(d.model, r.model, r)
  bump(d.agent, r.agent, r)
  bump(d.role, r.role, r)
  bump(d.tN, r.tN, r)
  bump(d.rm, `${r.role}|${r.model}`, r)
  if (r.agent === 'main') bump(d.rmm, `${r.role}|${r.model}`, r) // the session's own requests: a worker's model is chosen per call
  if (r.role === 'thread' && /^t\d{1,9}$/.test(r.tN) && r.effort) bump((d.tme ??= {}), `${r.tN}|${r.tmodel || r.model}|${r.effort}`, r) // a worker's rows count for the thread's choice (compare's throw-away t9<time> folders are no thread)
  ro.rows++
  if (r.legacy) ro.legacy++
}

// Fold the complete lines of `text` (a torn last line waits); returns the bytes consumed. A line that is not a ledger row counts as bad.
export function foldText(ro: Rollup, text: string): number {
  const end = text.lastIndexOf('\n') + 1
  if (!end) return 0
  for (const line of text.slice(0, end).split('\n')) {
    if (!line.trim()) continue
    let row: Norm | null = null
    try {
      row = normalizeRow(JSON.parse(line))
    } catch {
      /* damaged line */
    }
    if (row) addRow(ro, row)
    else ro.bad++
  }
  return enc.encode(text.slice(0, end)).length
}

// ---- files -----------------------------------------------------------------------------------------------------
export async function fileSize(h: Host, path: string): Promise<number | null> {
  const st = await h.fs.stat(path).catch(() => null)
  if (typeof st?.size === 'number') return st.size
  if (!st) return null
  const r = await h.process.run(['wc', '-c', path]).catch(() => null) // engines whose stat has no size
  const n = r && r.exitCode === 0 ? parseInt(r.stdout.trim(), 10) : NaN
  return Number.isFinite(n) ? n : null
}
// the text of `path` from byte `offset` (a whole read at 0, else `tail -c +N`: a big ledger is never read again from the top)
export async function readFrom(h: Host, path: string, offset: number): Promise<string> {
  if (offset <= 0) {
    // `$.fs.read` rejects a file over 4 MiB (a 27 MB ledger): the whole text then comes from `tail -c +1`, never as an empty string
    try {
      return String((await h.fs.read(path)) ?? '')
    } catch {
      const r = await h.process.run(['tail', '-c', '+1', path]).catch(() => null)
      if (r && r.exitCode === 0) return r.stdout
      throw new Error(`${path} could not be read`) // never '': an unreadable ledger is not an empty one (the caller leaves its offset alone)
    }
  }
  const r = await h.process.run(['tail', '-c', `+${offset + 1}`, path]).catch(() => null)
  if (r && r.exitCode === 0) return r.stdout
  return dec.decode(enc.encode(String((await h.fs.read(path)) ?? '')).subarray(offset)) // (rejects when it cannot be read either)
}
export async function ledgerFiles(h: Host, home: string): Promise<string[]> {
  const names = (await h.fs.list(leanDir(home)).catch(() => [])).filter(f => f.kind !== 'dir' && LEDGER_RE.test(f.name)).map(f => f.name)
  if (!names.includes(LEDGER)) names.push(LEDGER)
  return names.sort()
}

// ---- the rollup ------------------------------------------------------------------------------------------------
const rollupFile = (home: string) => `${leanDir(home)}/${ROLLUP}`
function valid(r: any): r is Rollup {
  return !!r && r.v === 2 && r.files && typeof r.files === 'object' && r.ids && typeof r.ids === 'object' && r.days && typeof r.days === 'object' && Number.isFinite(r.rows)
}
// the same id from the file itself (whole first line, then the same cut: bytes and characters never disagree)
const head = async (h: Host, path: string): Promise<string> => idOf(String((await h.process.run(['head', '-n', '1', path]).catch(() => null))?.stdout ?? ''))
const prune = (ro: Rollup, now: number) => {
  const keep = Object.keys(ro.days).sort().slice(-KEEP_DAYS)
  for (const d of Object.keys(ro.days)) if (!keep.includes(d) && d < dayOf(now)) delete ro.days[d]
}

// Bring the rollup up to date with every ledger file: only bytes past each file's offset are read. A file shorter than its
// offset (truncated by hand) or a damaged rollup starts the whole fold again. Returns the rollup (also written when it changed).
export async function syncRollup(h: Host, now?: number): Promise<Rollup> {
  const home = await homeDir(h)
  const t = now ?? (await h.clock.now())
  const stored = await readJson<unknown>(h, rollupFile(home), null)
  let ro: Rollup = valid(stored) ? stored : emptyRollup()
  let rebuilt = !valid(stored)
  const names = await ledgerFiles(h, home)
  for (let pass = 0; pass < 3; pass++) {
    let changed = rebuilt
    let shrank = false
    const sizes = new Map<string, number | null>()
    for (const n of names) sizes.set(n, await fileSize(h, `${leanDir(home)}/${n}`))
    // a recorded file that is gone was renamed (rotation by another session, a crash between the rename and the rollup's write,
    // or by hand): an unrecorded file that starts with the same bytes is it, and keeps its offset (nothing is folded twice)
    const gone = Object.keys(ro.files).filter(g => !sizes.get(g) && sizes.get(g) !== 0)
    for (const n of names) {
      if (!gone.length || n in ro.files || sizes.get(n) == null) continue
      const id = await head(h, `${leanDir(home)}/${n}`)
      const from = gone.find(g => id && ro.ids[g] === id)
      if (from) {
        ro.files[n] = ro.files[from]!
        ro.ids[n] = id
        delete ro.files[from]
        delete ro.ids[from]
        gone.splice(gone.indexOf(from), 1)
        changed = true
      }
    }
    for (const n of names) {
      const path = `${leanDir(home)}/${n}`
      const size = sizes.get(n)
      if (size == null) continue
      const off = ro.files[n] ?? 0
      if (size < off) { shrank = true; break }
      if (size === off) continue
      // longer than folded: the same file only if it still starts as it did (a fresh file that outgrew an old offset does not)
      if (off > 0 && ro.ids[n] !== undefined && (await head(h, path)) !== ro.ids[n]) { shrank = true; break }
      let text: string
      try {
        text = await readFrom(h, path, off)
      } catch {
        continue // unreadable now: its offset stays, the rows are folded when it can be read (never "empty")
      }
      const used = foldText(ro, text)
      if (used > 0 && off === 0) ro.ids[n] = idOf(text)
      ro.files[n] = off + used
      changed = true
    }
    if (shrank) { ro = emptyRollup(); rebuilt = true; continue }
    if (changed) {
      prune(ro, t)
      await atomicWrite(h, rollupFile(home), JSON.stringify(ro)).catch(() => undefined)
    }
    return ro
  }
  return ro
}

// ---- rotation --------------------------------------------------------------------------------------------------
export const firstRow = async (h: Host, path: string): Promise<Norm | null> => {
  const r = await h.process.run(['head', '-n', '1', path]).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  try {
    return normalizeRow(JSON.parse(r.stdout.trim()))
  } catch {
    return null
  }
}
async function free(h: Host, home: string, base: string): Promise<string> {
  for (let i = 1; ; i++) {
    const n = i === 1 ? `${base}.jsonl` : `${base}-${i}.jsonl`
    if (!(await h.fs.exists(`${leanDir(home)}/${n}`).catch(() => false))) return n
  }
}

// ledger.jsonl that starts with a 0.45 row moves to ledger-legacy.jsonl (once: the fresh file starts with a 1.0 row); one that
// starts in a past month moves to ledger-YYYY-MM.jsonl. A rename only: a writer that appends meanwhile lands in the old file
// (read through its offset) or creates the fresh one, and no row is lost. The rollup is brought up to date first and the
// offset follows the file to its new name, so nothing is counted twice. Returns what it did (empty = nothing to do).
async function rotateWhole(h: Host, info: { target?: string; legacy?: boolean } = {}): Promise<string[]> {
  const home = await homeDir(h)
  const cur = `${leanDir(home)}/${LEDGER}`
  const size = await fileSize(h, cur)
  if (!size) return []
  const first = await firstRow(h, cur)
  if (!first) return []
  const month = dayOf(await h.clock.now()).slice(0, 7)
  const target = first.legacy ? await free(h, home, 'ledger-legacy') : dayOf(first.ts).slice(0, 7) < month ? await free(h, home, `ledger-${dayOf(first.ts).slice(0, 7)}`) : null
  if (!target) return []
  const ro = await syncRollup(h)
  if ((await firstRow(h, cur))?.ts !== first.ts) return [] // another session rotated it meanwhile
  const r = await h.process.run(['mv', '-n', cur, `${leanDir(home)}/${target}`]) // -n: never replace a file another session just made
  if (r.exitCode !== 0) return []
  // `mv -n` skips without an error on some systems: the file must really have moved (the target exists, and ledger.jsonl is gone
  // or is a fresh file) before the rollup follows it
  const there = await fileSize(h, `${leanDir(home)}/${target}`)
  if (there === null || ((await fileSize(h, cur)) !== null && (await firstRow(h, cur))?.ts === first.ts)) return []
  if (ro.files[LEDGER] !== undefined) {
    ro.files[target] = ro.files[LEDGER]!
    if (ro.ids[LEDGER] !== undefined) ro.ids[target] = ro.ids[LEDGER]!
    delete ro.files[LEDGER]
    delete ro.ids[LEDGER]
    // (if this write is lost, or another sync ran in between, the next sync finds the renamed file by its start: syncRollup)
    await atomicWrite(h, rollupFile(home), JSON.stringify(ro)).catch(() => undefined)
  }
  await h.store.set('ledger-today', null).catch(() => undefined) // budget.ts: its byte offset belonged to the file that just moved
  info.target = target
  info.legacy = first.legacy
  return [`ledger.jsonl (${(size / 1e6).toFixed(1)} MB) moved to ${target}${first.legacy ? ' (it starts with a 0.45 row)' : ''}; stats still read it`]
}

// ---- split by row format -----------------------------------------------------------------------------------------
// 1.0.5 moved the WHOLE file when it started with a 0.45 row, so that day's 1.0 rows went to ledger-legacy.jsonl with it. Now only the
// 0.45 rows stay in the legacy file: its 1.0 rows (a new row = a numeric `ts` and `usd`) go back to ledger.jsonl. Idempotent and
// resumable (a legacy file that already holds 1.0 rows is repaired the same way), lossless (nothing is deleted before it is written
// elsewhere, a file that changed meanwhile is left alone), and the rollup is reset (its offsets belong to the old files).
const isNew = (line: string): boolean => {
  try {
    const r = normalizeRow(JSON.parse(line))
    return !!r && !r.legacy
  } catch {
    return false
  }
}
const LEGACY_RE = /^ledger-legacy(?:-\d+)?\.jsonl$/
const ROT = '.rot'

// chunked `tee -a` (one O_APPEND write per chunk; a row is never split). The 1.0 rows are only ever APPENDED to ledger.jsonl: every live
// session appends there at each model request, and a rewrite (tmp + mv) could swallow a row written in between. Their order in the file
// does not matter (the rollup is by day).
async function append(h: Host, path: string, text: string): Promise<boolean> {
  const rows = text.split('\n')
  rows.pop()
  // chunks of whole rows under 4 KB: one read and one write of `tee` each, so a live session's own append never lands inside a row
  const chunks: string[] = []
  let cur = ''
  for (const row of rows) {
    if (cur && cur.length + row.length + 1 > 4096) { chunks.push(cur); cur = '' }
    cur += `${row}\n`
  }
  if (cur) chunks.push(cur)
  for (const c of chunks) {
    const r = await h.process.run(['tee', '-a', path], { stdin: c })
    if (r.exitCode !== 0) return false
  }
  return true
}

// Append the rows that `path` does not hold yet (a retry after a crash never writes one twice); false = the file could not be read whole
// or the append failed: nothing more is done.
async function appendNew(h: Host, path: string, rows: string[]): Promise<boolean> {
  const size = await fileSize(h, path)
  const have = size ? await readFrom(h, path, 0) : ''
  if (size && enc.encode(have).length !== size) return false
  const there = new Set(have.split('\n'))
  const fresh = rows.filter(l => !there.has(l))
  // (a file that ends in a torn line, no newline: the first new row would be glued to it and lost to every reader)
  return !fresh.length || (await append(h, path, (have && !have.endsWith('\n') ? '\n' : '') + fresh.join('\n') + '\n'))
}

// Returns {kept, moved, done}: the 1.0 rows appended to ledger.jsonl and the file rewritten with the 0.45 (and unreadable) rows only;
// kept 0 = nothing to do; done false = the rows were copied but the rewrite failed (a retry does not append them twice: rows already in
// ledger.jsonl are skipped). null = it was not safe (the file could not be read whole, or changed meanwhile): nothing was touched.
// Order: stage the old rows (tmp), append the 1.0 rows, swap the file; a crash between the last two leaves the 1.0 rows in both files,
// which the retry (the next start) repairs without a duplicate.
async function splitLegacy(h: Host, home: string, name: string): Promise<{ kept: number; moved: number; done: boolean } | null> {
  const path = `${leanDir(home)}/${name}`
  const cur = `${leanDir(home)}/${LEDGER}`
  const size0 = await fileSize(h, path)
  if (!size0) return { kept: 0, moved: 0, done: true }
  const text = await readFrom(h, path, 0)
  if (enc.encode(text).length !== size0) return null // a read that did not return the whole file is never treated as the whole file
  const lines = text.split('\n').filter(l => l.trim())
  const keep = lines.filter(isNew)
  if (!keep.length) return { kept: 0, moved: 0, done: true }
  // a 1.0 row of THIS month goes to ledger.jsonl; an older one to its own ledger-YYYY-MM.jsonl: ledger.jsonl must not start in a past
  // month, or the next start would rotate the whole file (today's rows with it) away again. (A `ts` that is no date goes to ledger.jsonl.)
  const month = dayOf(await h.clock.now()).slice(0, 7)
  const targets = new Map<string, string[]>()
  for (const l of keep) {
    let m = month
    try {
      m = dayOf(normalizeRow(JSON.parse(l))!.ts).slice(0, 7)
    } catch {
      /* not a date: stays in the current ledger */
    }
    const file = m < month ? `ledger-${m}.jsonl` : LEDGER
    targets.set(file, [...(targets.get(file) ?? []), l])
  }
  const old = lines.filter(l => !isNew(l))
  const oldText = old.length ? old.join('\n') + '\n' : ''
  const tmp = `${path}${ROT}`
  const drop = () => h.process.run(['rm', '-f', tmp]).catch(() => undefined)
  await h.fs.write(tmp, oldText)
  if (((await fileSize(h, tmp)) ?? 0) !== enc.encode(oldText).length) { await drop(); return null }
  if ((await fileSize(h, path)) !== size0) { await drop(); return null } // another process appended to it meanwhile: the next start tries again
  for (const [file, rows] of targets) if (!(await appendNew(h, file === LEDGER ? cur : `${leanDir(home)}/${file}`, rows))) { await drop(); return null }
  const r = await h.process.run(['mv', '-f', tmp, path])
  return { kept: keep.length, moved: old.length, done: r.exitCode === 0 }
}

export const REPAIR_V = 1 // store key 'ledger-repair.v': the scan for 1.0 rows inside legacy files (1.0.5's whole-file move) ran once
export async function rotateLedger(h: Host): Promise<string[]> {
  const home = await homeDir(h)
  // the common start (a ledger of this month, a repair already done) is one stat and one head, no lock
  const repairDue = (await h.store.get('ledger-repair.v').catch(() => undefined)) !== REPAIR_V
  if (!repairDue) {
    const cur = `${leanDir(home)}/${LEDGER}`
    if (!(await fileSize(h, cur))) return []
    const first = await firstRow(h, cur)
    if (!first || (!first.legacy && dayOf(first.ts).slice(0, 7) >= dayOf(await h.clock.now()).slice(0, 7))) return []
  }
  return withFolderLock(h, `${leanDir(home)}/.ledger-lock`, async () => {
    const lines: string[] = []
    let split = false
    const info: { target?: string; legacy?: boolean } = {}
    const whole = await rotateWhole(h, info)
    if (whole.length && !info.legacy) lines.push(...whole)
    let ok = true // the repair is marked done only when every legacy file was clean or split
    if (whole.length && info.legacy && info.target) {
      const s = await splitLegacy(h, home, info.target).catch(() => null)
      if (s?.kept) { split = true; lines.push(`ledger rotated: ${s.moved} 0.45 row(s) moved to ledger-legacy.jsonl, ${s.kept} 1.0 row(s) kept in ledger.jsonl; stats read every ledger file`) }
      else lines.push(...whole) // nothing to split, or it was not safe: the whole file sits in the legacy file as before, and says so
    }
    // a legacy file that already holds 1.0 rows (1.0.5 moved them there): repaired at the next start
    for (const f of (await h.fs.list(leanDir(home)).catch(() => [])).map(x => x.name).filter(n => LEGACY_RE.test(n)).sort()) {
      try {
        const path = `${leanDir(home)}/${f}`
        const size = (await fileSize(h, path)) ?? 0
        if (!size) continue
        const tail = await readFrom(h, path, Math.max(0, size - 16_384)) // 1.0.5 left its 1.0 rows at the end
        if (!tail.split('\n').some(l => l.trim() && isNew(l))) continue
        const s = await splitLegacy(h, home, f)
        if (!s || !s.done) ok = false // tried again at the next start
        if (s?.kept) { split = true; lines.push(`ledger repaired: ${s.kept} 1.0 row(s) moved from ${f} back to ledger.jsonl, ${s.moved} 0.45 row(s) stay in ${f}${s.done ? '' : ' (the rewrite of the file failed: tried again at the next start)'}`) }
      } catch {
        ok = false
      }
    }
    if (split) {
      await atomicWrite(h, rollupFile(home), JSON.stringify(emptyRollup())).catch(() => undefined) // offsets belong to the files as they were: refold
      await h.store.set('ledger-today', null).catch(() => undefined)
    }
    // (a failed or unsafe split also un-marks an earlier success: the next start looks again, whichever branch found it)
    await h.store.set('ledger-repair.v', ok ? REPAIR_V : undefined).catch(() => undefined)
    return lines
  })
}

// The desk's notice (notices.ts: the pane lists it) for a rotation or a repair; replaced by the next one, removed by clearRotationNotice
export async function announceRotation(h: Host, lines: string[]): Promise<void> {
  if (lines.length) await setNotice(h, 'ledger-rotation', lines.join(' | '))
}
export const clearRotationNotice = (h: Host): Promise<void> => setNotice(h, 'ledger-rotation', null)
