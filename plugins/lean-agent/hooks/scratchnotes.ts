// Notes before the cap (1.0.26). A thread that reads a lot has learned things a restart would have to learn again: the reading was not kept. So
//   - at the warn level (threadWarnTokens, default 100k = 83% of the limit) the thread gets ONE line in its next tool result: write what you have
//     learned to scratch/notes.md now, one short section per source (what it says, what you still need);
//   - the state snapshot lists the thread's scratch files (name, size, first line) and the handover carries scratch/notes.md (within the handover
//     budget) plus that list, with the instruction to read them and NOT to re-read the sources they cover;
//   - the hard stop text says the same in a few words.
// Pure text helpers plus one reader of the thread's scratch folder (the subagents' findings files, answers.ts, live there too).
import { kTokens } from './threadcontext'
import type { Host } from './state'

export const NOTES_FILE = 'notes.md'
export const SCRATCH_LIST_MAX = 20
export const SCRATCH_NOTES_MAX = 3_000 // chars of notes.md the handover carries (its end)

// the one line, said once per session (register.tsx), in the next tool result at or over the warn level
export const warnLine = (tokens: number, limit: number): string =>
  `ctx ${kTokens(tokens)} of ${kTokens(limit)}: write what you learned to scratch/notes.md, then call lean_run checkpoint {next: <the next step>}: the mod restarts you at once and you continue with it. Never end your turn asking the desk or the user for a restart`

// said by the hard stop in a few words
export const STOP_NOTES = 'your reading is kept in scratch/notes.md and the scratch files'

export const HANDOVER_RULE = 'read scratch/notes.md and the first lines of the listed scratch files (their summaries); do NOT re-read the sources they cover, that is what filled the last session'

export type ScratchFile = { name: string; size: number; first: string }
// a reviewer's JSON block the mod saved when the reviewer answered (reviewsave.ts): listed right after notes.md, so a restart finds it
export const reviewBlock = (name: string): boolean => /^review-[\w.-]+-\d+\.json$/.test(name)

// the files of <thread folder>/scratch (not folders), largest list capped; the first non-empty line of each is its summary. Never throws.
export async function scratchList(h: Host, dir: string): Promise<ScratchFile[]> {
  try {
    const out: ScratchFile[] = []
    const rows = (await h.fs.list(`${dir}/scratch`)).filter(r => r && r.kind === 'file' && /^[\w.-]{1,80}$/.test(r.name)).sort((a, b) => (a.name === NOTES_FILE ? -1 : b.name === NOTES_FILE ? 1 : reviewBlock(a.name) !== reviewBlock(b.name) ? (reviewBlock(a.name) ? -1 : 1) : a.name < b.name ? -1 : 1))
    for (const r of rows.slice(0, SCRATCH_LIST_MAX)) {
      const size = Number((await h.fs.stat(`${dir}/scratch/${r.name}`).catch(() => null))?.size) || 0
      let first = ''
      if (size > 0 && size <= 400_000) {
        const text = String(await h.fs.read(`${dir}/scratch/${r.name}`).catch(() => ''))
        first = (text.split('\n').find(l => l.trim()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
      }
      out.push({ name: r.name, size, first })
    }
    return out
  } catch {
    return []
  }
}

// "- notes.md (1.2 kB): ## src/a.ts ..." one line per file
export const sizeText = (n: number): string => (n < 1000 ? `${n} B` : `${Math.round(n / 100) / 10} kB`)
export const listText = (list: ScratchFile[]): string => list.map(f => `- ${f.name} (${sizeText(f.size)})${f.first ? `: ${f.first}` : ''}`).join('\n')

// the tail of scratch/notes.md for the handover ('' when there is none)
export async function scratchNotes(h: Host, dir: string): Promise<string> {
  const t = String(await h.fs.read(`${dir}/scratch/${NOTES_FILE}`).catch(() => '')).replace(/\r/g, '').trim()
  return t.length <= SCRATCH_NOTES_MAX ? t : '…' + t.slice(t.length - SCRATCH_NOTES_MAX)
}

// once per session: the line when the size is at or over the warn level (and the thread is not stopped: the stop has its own text)
// (1.0.27: and once more at 90% of the limit; the register.tsx caller appends what fills the context, contextstat.ts breakdownText)
const warned = new Set<string>()
const warnedHigh = new Set<string>()
export const HIGH_SHARE = 0.9
export const warnReset = () => {
  warned.clear()
  warnedHigh.clear()
}
export const warnedAlready = (sid: string): boolean => warned.has(sid) && warnedHigh.has(sid)
export function takeWarn(sid: string, tokens: number | null | undefined, l: { limit: number; warn: number }): string | null {
  if (!sid || typeof tokens !== 'number' || tokens <= l.warn) return null
  const high = tokens > l.limit * HIGH_SHARE
  if (warned.has(sid) && (!high || warnedHigh.has(sid))) return null // (one line when both levels are passed at once)
  if (warned.size >= 200) warned.clear()
  if (warnedHigh.size >= 200) warnedHigh.clear()
  warned.add(sid)
  if (high) warnedHigh.add(sid)
  return warnLine(tokens, l.limit)
}
