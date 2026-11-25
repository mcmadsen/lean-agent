// A forge WRITE made by script (curl / wget / az rest / az repos|boards|devops|pipelines write subcommands / gh api with a write method /
// gh pr|issue comment|review|edit ...) against Azure DevOps or GitHub. A thread and a subagent never make one: the write is an action KIND the
// thread requests with lean_report (deskactions.ts), the user approves, the mod sends it. This module is the ONE detector used by the refusal
// (orchestrate.ts, guard.ts), the brief lint (thread tool) and the stale-memory retirement (memory load, doctor). The refusal text lists the kinds
// FROM THE TABLE, never by hand. 1.0.34: az / gh are judged by the READ allow-list (forgecli.ts): only a read verb runs, every other form is a write.
//   forgeCommandWrite(command)  a shell command (guards): the scanner of shell.ts finds az / gh at a PROGRAM position (also inside bash -c, eval, $(...),
//                               xargs, a python -c string ...), so `git commit -m "docs: gh pr create"` and `echo gh pr create` are data, not writes
//   isForgeWrite(text)          prose, a brief, a memory item: text based, az / gh anywhere in the text
import { ACTION_KINDS } from './deskactions'
import { DATA, HOST, METHOD, textForgeWrite } from './forgecli'
import { analyze } from './shell'
import { appendJsonl, atomicWrite, homeDir, leanDir } from './state'
import type { Host } from './state'

// the kinds as one line, from the action table: `ado-pr-reply (optional status) | ado-pr-thread-status | ... | batch`
export const kindsLine = (): string => Object.entries(ACTION_KINDS).map(([k, p]) => (/optional status/.test(p) ? `${k} (optional status)` : k)).join(' | ')
export const forgeRefusal = (): string => `forge writes go through the desk: lean_report with action {kind: ${kindsLine().split(' | ').join('|')}}; the user approves, the mod sends it. Reads: lean_run ci, or a reader.`
export const briefLintLine = (): string => `this brief asks for a forge write by script; a thread cannot: it must request an action kind (${kindsLine()})`
export const RETIRED_NOTE = '(retired: forge writes go through action kinds)'
// a remembered item (memory, handover) that describes a forge write by script is not passed on as it is: it becomes the retired note, counted
let retiredSeen = 0
export const retiredAtLoad = (): number => retiredSeen
export function retireText(text: string): string {
  if (!isForgeWrite(text)) return text
  retiredSeen++
  return RETIRED_NOTE
}
// the store (memory/notes.jsonl): how many items describe a forge write by script, and `lean_doctor fix` retiring them in place (a backup file is kept)
const notesFile = async (h: Host): Promise<string> => `${leanDir(await homeDir(h))}/memory/notes.jsonl`
const readNotes = async (h: Host): Promise<string> => {
  const r = await h.fs.read(await notesFile(h)).catch(() => '')
  return typeof r === 'string' ? r : ''
}
const forgeNote = (line: string): { row: Record<string, unknown> } | null => {
  try {
    const o = JSON.parse(line) as Record<string, unknown>
    return o && typeof o === 'object' && typeof o.text === 'string' && o.text !== RETIRED_NOTE && isForgeWrite(o.text) ? { row: o } : null
  } catch {
    return null
  }
}
export async function staleMemoryCount(h: Host): Promise<number> {
  return (await readNotes(h)).split('\n').filter(l => forgeNote(l)).length
}
export async function retireMemory(h: Host): Promise<string> {
  const file = await notesFile(h)
  const raw = await readNotes(h)
  let n = 0
  const lines = raw.split('\n').map(l => {
    const f = forgeNote(l)
    if (!f) return l
    n++
    return JSON.stringify({ ...f.row, text: RETIRED_NOTE })
  })
  if (!n) return 'remembered items: none describe a forge write by script'
  const ts = await h.clock.now()
  const backup = `${file}.bak-${ts}`
  await atomicWrite(h, backup, raw)
  await atomicWrite(h, file, lines.join('\n'))
  await appendJsonl(h, `${leanDir(await homeDir(h))}/logs/doctor.jsonl`, { ts, kind: 'memory-retired', items: n, backup })
  return `remembered items: retired ${n} that described a forge write by script (they now say "${RETIRED_NOTE}"; backup ${backup})`
}
export const FORGE_RULE = 'forge-write'
export const forgeRefusalHead = /^forge writes go through the desk/

// curl / wget at a forge host with a method that is not GET or a body (text based: the host and the flags may be anywhere in the command)
function fetchWrite(t: string): string | null {
  const fetch = /(?:^|[^\w.-])(?:[\w.~-]*\/)*(curl|wget)(?![\w-])/.exec(t) // (a path to the program counts: /usr/bin/curl)
  return fetch && HOST.test(t) && (METHOD.test(t) || DATA.test(t)) ? fetch[1]! : null
}
const clean = (c: string): string => c.replace(/\\\r?\n/g, ' ')

// the label of the first forge write in a TEXT ("az repos", "gh pr", "curl"), or null (prose, brief, memory: az / gh anywhere in it)
export const forgeTextWrite = (text: string): string | null => fetchWrite(clean(text)) ?? textForgeWrite(text)
export const isForgeWrite = (text: string): boolean => forgeTextWrite(text) !== null

// the label of the first forge write in a SHELL COMMAND, or null. az / gh at a program position are judged by the read allow-list; a command the scanner cannot
// read (unbalanced quotes, a script on stdin) and a variable as the program name that names gh / az fall back to the text scan
export function forgeCommandWrite(command: string): string | null {
  const t = clean(command)
  const c = fetchWrite(t)
  if (c) return c
  const a = analyze(t)
  if (a.forge) return a.forge
  if (a.unsure) return textForgeWrite(t)
  if (a.dynamic && /\b(gh|az)\b|\b(repos|boards|pipelines)\s+\w|\bpr\s+(create|merge|comment|review|edit|close|update)\b/i.test(t)) return 'gh|az'
  return null
}
// the action kind that does the same write, when one does (a hint appended to the refusal)
const KIND_FOR: Array<[RegExp, string]> = [
  [/\bpr\s+work-item\s+add\b/, 'ado-pr-workitem-link'], [/\bpr\s+work-item\s+remove\b/, 'ado-pr-workitem-unlink'], [/\bpr\s+set-vote\b/, 'ado-pr-vote'], [/\bpr\s+reviewer\b/, 'ado-pr-reviewer'],
  [/\bpr\s+update\b/, 'ado-pr-update'], [/\bwork-item\s+update\b/, 'ado-workitem-update'], [/\bwork-item\s+create\b/, 'ado-workitem-create'],
]
export function forgeHint(command: string): string {
  const t = command.replace(/['"]\s*,\s*['"]/g, ' ')
  const k = KIND_FOR.find(([re]) => re.test(t))
  return k ? ` (closest kind: ${k[1]})` : ''
}
