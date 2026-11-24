// A synthesised last line (1.0.32; field: a thread whose LAST event was a tool result with no assistant text had nothing to show in the list, the user saw an empty row).
// The thread's own mod remembers the last tool result of the main loop in memory (tool name + the first SYNTH_CHARS characters); at a turn end that came with no assistant
// text, it is written to <thread folder>/synth-line.json {at, text}; a turn end WITH text clears it. The list (`lean_thread list`) and the pane show it in place of a
// missing last line, marked "synthesised". It is display only: never a record in the desk inbox, never a report, never silences the idle alert (threadstate.ts idleNoReport,
// endnudge.ts endDue read the inbox, not this file). Shown only while the session is idle and the line is newer than the thread's last report.
import { readJson, threadsDir, writeJson } from './state'
import type { Host } from './state'

export const SYNTH_CHARS = 100
export const SYNTH_MARK = 'synthesised'
export const synthFile = (home: string, id: string) => `${threadsDir(home)}/${id}/synth-line.json`
let last: { at: number; tool: string; text: string } | null = null
export const resetSynth = () => {
  last = null
}
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
// the main loop's tool result (a thread's own call, not a worker's): remembered in memory only
// A tool that returns file, web or other servers' content shows its name only (a line must not carry file content or a secret into the list); long token-like strings are cut
const CONTENT_TOOL = /^(?:Read|Grep|Glob|NotebookRead|WebFetch|WebSearch)$|^mcp__(?!lean-agent__)/
export const noteToolResult = (tool: string, text: string, now: number): void => {
  const body = CONTENT_TOOL.test(tool) ? '(content not shown)' : flat(text).replace(/[A-Za-z0-9+/_=-]{32,}/g, '…').slice(0, SYNTH_CHARS)
  last = { at: now, tool: tool.replace(/^mcp__lean-agent__/, '') || 'tool', text: body }
}
export const synthLine = (tool: string, text: string): string => `${tool}: ${flat(text).slice(0, SYNTH_CHARS) || '(no output)'}`
// the turn end: no assistant text and a tool result of THIS turn came last = the line; any other turn end clears it. Never throws.
export async function noteSynthAtTurnEnd(h: Host, home: string, id: string, o: { lastText: string | null; since: number }): Promise<void> {
  try {
    const line = !o.lastText && last && last.at >= o.since ? { at: last.at, text: synthLine(last.tool, last.text) } : {}
    await writeJson(h, synthFile(home, id), line)
  } catch {
    /* display only */
  }
}
// the line to show for a thread: only while its turn has ended (idle) and it is newer than the last report; null otherwise
export async function readSynth(h: Host, home: string, id: string, o: { idle: boolean; lastReportTs: number }): Promise<string | null> {
  if (!o.idle) return null
  const s = await readJson<{ at?: number; text?: string } | null>(h, synthFile(home, id), null)
  return s && typeof s.text === 'string' && s.text && Number(s.at) > o.lastReportTs ? s.text : null
}
export const synthDisplay = (text: string): string => `${text} (${SYNTH_MARK})`
