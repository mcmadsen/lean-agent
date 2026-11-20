// A done report is checked by script before it counts (1.0.20; field: a thread reported "done, draft saved at ~/Downloads/<file>.md", the Write had
// been refused, the file did not exist, and the desk had already closed the thread). Every path in the report text that looks like an output file
// must exist: absolute or ~/..., with an extension, after words like saved / written / created / at / in, or in backticks. `~` is the user's home;
// a path under the thread's worktree or the lean home is an ordinary absolute path and is checked the same way. Not outputs, so never checked:
// URLs, a path next to a word that says it is gone (deleted, removed, renamed ...), and a path git tracks as deleted. A worker's "written" is not
// proof: only the file is. lean_report refuses the done state when one is missing (delivery.ts threadTool), so no done record exists for the desk's
// auto-close (finish.ts doneSession) to act on before the check passed.
import { homeDir } from './state'
import type { Host } from './state'

const PATH = /(?<![\w./:~@-])(?:~\/|\/)[^\s`'"<>()[\]{},;|*?]+/g
const EXT = /\.[A-Za-z0-9]{1,10}$/
const LEAD = /\b(saved|save|written|write|wrote|created|create|generated|exported|output|outputs|stored|placed|put|file|draft|report|at|in|to|as|into)\b[^.\n]{0,40}$/i
const GONE = /\b(delet\w*|remov\w*|renam\w*|no longer|gone|obsolete|dropp\w*)\b/i
export const MAX_CHECKED = 12

// the paths of a done report text that claim to be output files, `~` resolved against `home`; [] when none
export function outputClaims(text: string, home: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(PATH)) {
    const raw = m[0].replace(/[.:!?]+$/, '')
    if (!EXT.test(raw)) continue
    const at = m.index ?? 0
    const lineStart = text.lastIndexOf('\n', at - 1) + 1
    const before = text.slice(Math.max(lineStart, at - 60), at)
    const after = text.slice(at + m[0].length, at + m[0].length + 24).split('\n')[0]!
    const ticked = text[at - 1] === '`'
    if (!ticked && !LEAD.test(before.replace(PATH, 'X'))) continue // (an earlier path of the same list does not end the lead)
    if (GONE.test(before.slice(-40)) || GONE.test(after)) continue // a source file named in a diff summary as deleted
    const p = raw.startsWith('~/') ? `${home}/${raw.slice(2)}` : raw
    if (!found.includes(p)) found.push(p)
    if (found.length >= MAX_CHECKED) break
  }
  return found
}

// does git track the path as deleted (a committed or a pending deletion)? false when git cannot say
async function trackedDeleted(h: Host, path: string): Promise<boolean> {
  try {
    let dir = path.slice(0, path.lastIndexOf('/')) || '/'
    for (let n = 0; n < 12 && dir.length > 1 && !(await h.fs.exists(dir)); n++) dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
    if (!(await h.fs.exists(dir))) return false
    const st = await h.process.run(['git', '-C', dir, 'status', '--porcelain', '--', path])
    if (st.exitCode === 0 && st.stdout.split('\n').some(l => /^( D|D |DD|AD)\s/.test(l))) return true
    const lg = await h.process.run(['git', '-C', dir, 'log', '-1', '--format=%h', '--diff-filter=D', '--', path])
    return lg.exitCode === 0 && lg.stdout.trim().length > 0
  } catch {
    return false
  }
}

// the claimed output paths that do not exist; [] = the report may count as done
export async function missingOutputs(h: Host, text: string): Promise<string[]> {
  const home = await homeDir(h).catch(() => '')
  const missing: string[] = []
  for (const p of outputClaims(text, home)) {
    if (await h.fs.exists(p).catch(() => true)) continue // (an unreadable check never refuses a report)
    if (await trackedDeleted(h, p)) continue
    missing.push(p)
  }
  return missing
}

export const notDoneText = (missing: string[]): string =>
  `not done: ${missing[0]} does not exist; write it (a worker's 'written' is not proof) or drop the claim${missing.length > 1 ? `. Also missing: ${missing.slice(1).join(', ')}` : ''}. Nothing was reported.`
