// An interpreter run on a SCRIPT FILE: `python3 deploy.py`, `node tools/post.js`, `bash run.sh` (1.0.35). The guard already reads the string of `python3 -c` / `node -e`
// (shell.ts, forgewrite.ts); a forge write hidden in a file was invisible. The text of the file is scanned by the SAME detector (forgewrite.ts forgeTextWrite: az / gh
// writes, curl -X POST ... at a forge host) and a run that holds a forge write is refused with the action-kind hint.
// Reads only what it can prove is the thread's own: a file that exists inside the thread's worktree (lean_worktree registry) or its scratch folder, at most 200 KB,
// text (a NUL byte = binary, skipped). A file outside those folders, a missing, a huge or a binary one, a path with a variable or a glob, a file that cannot be read: nothing
// is refused on a guess.
import { homeDir, leanDir } from './state'
import type { Host } from './state'
import { forgeHint, forgeRefusal, forgeTextWrite } from './forgewrite'
import { worktreeRoots } from './denial'
import { tried } from './orchestrate'

export const SCRIPT_MAX = 200_000
const BIN = /^(?:python[\d.]*|node(?:js)?|bash|sh|zsh|dash)$/
const WRAP = /^(?:sudo|env|time|nohup|exec|command|nice|stdbuf|setsid)$/
const INLINE = /^(?:-c|-e|-p|-m|--eval|--print|--command|--module)$/ // the code is a string (guarded as before) or a module, no file
const TAKES_VALUE = /^(?:-W|-X|-r|--require|--import|--loader|--experimental-loader|-o|\+o|--rcfile|--init-file|--input-type|--stack-size)$/

// the script file words of the interpreter runs in a command (python3 / python / node / bash / sh <file>), as written
export function scriptFiles(command: string): string[] {
  const out: string[] = []
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const w = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(x => x.replace(/^(["'])(.*)\1$/, '$2'))
    let i = 0
    while (i < w.length && (/^\w+=/.test(w[i]!) || WRAP.test(w[i]!))) {
      const wrapper = WRAP.test(w[i]!)
      i++
      while (wrapper && i < w.length && w[i]!.startsWith('-')) i++ // (`sudo -n python3 x.py`: the wrapper's own flags)
    }
    if (!BIN.test((w[i] ?? '').split('/').pop()!)) continue
    for (let j = i + 1; j < w.length; j++) {
      const a = w[j]!
      if (INLINE.test(a)) break
      if (a === '-') continue // a script on stdin
      if (/^[<>0-9]*[<>]/.test(a)) break // a redirect or a heredoc: the script comes from there
      if (a.startsWith('-')) {
        if (TAKES_VALUE.test(a)) j++
        continue
      }
      if (!/[$`*?[\]{}~]/.test(a)) out.push(a) // (a variable, a glob, a tilde: not a file we can name)
      break
    }
  }
  return out
}

const norm = (p: string, cwd: string): string => {
  const out: string[] = []
  for (const s of (p.startsWith('/') ? p : `${cwd}/${p}`).split('/')) {
    if (!s || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return '/' + out.join('/')
}
const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`)

// the refusal text when a script file this command runs holds a forge write, else null. `thread`: the calling thread (its worktrees and scratch are the readable folders)
export async function scriptForgeWrite($: Host, o: { thread?: string; cwd: string }, command: string): Promise<string | null> {
  try {
    const files = scriptFiles(command)
    if (!files.length || !o.thread) return null
    const home = await homeDir($)
    const roots = [`${leanDir(home)}/threads/${o.thread}/scratch`, ...(await worktreeRoots($, o.thread, '')).map(r => norm(r, '/'))]
    for (const f of files) {
      const abs = norm(f, o.cwd || '/')
      const st = await $.fs.stat(abs, { resolve: true }).catch(() => null)
      if (!st || st.kind !== 'file') continue
      const real = typeof st.realPath === 'string' && st.realPath.startsWith('/') ? norm(st.realPath, '/') : abs
      if (!roots.some(r => under(abs, r) && under(real, r))) continue // outside the thread's own folders (a link out of them too): not read
      if (typeof st.size === 'number' && st.size > SCRIPT_MAX) continue
      const text = await $.fs.read(abs).catch(() => null)
      if (typeof text !== 'string' || text.length > SCRIPT_MAX || text.includes('\u0000')) continue
      const fw = forgeTextWrite(text)
      if (fw) return forgeRefusal() + forgeHint(text) + ` (the script ${f.split('/').pop()} makes a forge write: ${fw})` + tried(fw)
    }
  } catch {
    /* nothing is refused on a guess */
  }
  return null
}
