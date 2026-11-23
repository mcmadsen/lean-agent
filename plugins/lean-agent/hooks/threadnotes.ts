// The thread's own notes, wherever it kept them (the handover's lookup used to know only threads/tN/notes.md): `notes.md`, every `*.md` in
// `notes/` and in `scratch/` (one level). The handover carries the content of notes.md and notes/progress.md (else the newest file of notes/),
// the rest by name, size and first line, newest first, at most NOTE_FILES_MAX files in all; `lean_doctor handover tN` says which it used and
// which it found but left out. Never throws.
import type { Host } from './state'

export const NOTE_FILES_MAX = 6
export const READ_FIRST = 'read these before re-reading sources'
export type NoteFile = { path: string; size: number; mtime: number; first: string } // path is relative to the thread's folder
export type NotesLookup = {
  content: NoteFile[] // the files whose text the handover carries (notes.md, notes/progress.md or the newest of notes/)
  listed: NoteFile[] // the other files, by name
  left: NoteFile[] // found, but over the NOTE_FILES_MAX limit
}

async function describe(h: Host, dir: string, rel: string): Promise<NoteFile | null> {
  const st = await h.fs.stat(`${dir}/${rel}`).catch(() => null)
  if (!st || st.kind === 'dir') return null
  const size = Number(st.size) || 0
  let first = ''
  if (size > 0 && size <= 400_000) {
    const text = String(await h.fs.read(`${dir}/${rel}`).catch(() => ''))
    first = (text.split('\n').find(l => l.trim()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
  }
  return { path: rel, size, mtime: 0, first }
}

// The host reports no modification times: `ls -1td <files>` (the same on Linux, macOS and BSD) lists the given files newest first. A file the
// answer does not name (ls failed, or not available) gets no rank and falls back to name order.
async function rankByTime(h: Host, dir: string, files: NoteFile[]): Promise<void> {
  if (files.length < 2) return
  try {
    const r = await h.process.run(['ls', '-1td', ...files.map(f => `${dir}/${f.path}`)], { timeoutMs: 5_000 })
    if (r.exitCode !== 0) return
    const order = r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    for (const f of files) {
      const i = order.indexOf(`${dir}/${f.path}`)
      f.mtime = i < 0 ? 0 : order.length - i // bigger = newer
    }
  } catch {
    /* no ranks: name order */
  }
}

const newestFirst = (a: NoteFile, b: NoteFile) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

async function mdIn(h: Host, dir: string, sub: string): Promise<NoteFile[]> {
  const rows = await h.fs.list(`${dir}/${sub}`).catch(() => [])
  const out: NoteFile[] = []
  for (const r of rows.filter(x => x && x.kind === 'file' && /^[\w.-]{1,80}\.md$/i.test(x.name)).slice(0, 60)) {
    const f = await describe(h, dir, `${sub}/${r.name}`)
    if (f) out.push(f)
  }
  return out
}

export async function lookupNotes(h: Host, dir: string): Promise<NotesLookup> {
  try {
    const top = await describe(h, dir, 'notes.md')
    const notes = await mdIn(h, dir, 'notes')
    const scratch = await mdIn(h, dir, 'scratch')
    await rankByTime(h, dir, [...notes, ...scratch])
    notes.sort(newestFirst)
    const progress = notes.find(f => f.path === 'notes/progress.md') ?? notes[0]
    const content = [top, progress].filter((f): f is NoteFile => !!f)
    // scratch/notes.md has its own section (scratchnotes.ts); it is not listed twice
    const rest = [...notes, ...scratch].filter(f => !content.includes(f) && f.path !== 'scratch/notes.md').sort(newestFirst)
    const room = Math.max(0, NOTE_FILES_MAX - content.length - (scratch.some(f => f.path === 'scratch/notes.md') ? 1 : 0))
    return { content, listed: rest.slice(0, room), left: rest.slice(room) }
  } catch {
    return { content: [], listed: [], left: [] }
  }
}

const kb = (n: number) => (n < 1000 ? `${n} B` : `${Math.round(n / 100) / 10} kB`)
export const noteLine = (f: NoteFile) => `- ${f.path} (${kb(f.size)})${f.first ? `: ${f.first}` : ''}`
