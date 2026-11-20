// Structural reading of a Bash command for PRIVATE projects (guard.ts). The command is lexed like a shell would:
// quotes, escapes, heredocs, here-strings and redirections are consumed as DATA (so `echo "gh pr create"`, a heredoc
// with an apostrophe, `> "$f"` and `<<< "$o"` never matter); only the PROGRAM of each simple command is inspected,
// after env assignments and wrappers (sudo, command, env, exec, nohup, timeout, xargs, find -exec ...). Substitutions
// $(...) / `...` / bash -c / eval / sh heredocs are scanned recursively. Detected: git push, git remote add|set-url,
// lean-agent outward commands, a gh/az WRITE (read-only subcommands are an allow-list matched by position), and a
// variable / substitution used as a program name. A command that cannot be lexed is judged by token only.
// pushes: the words after `push` of every git push found; known=false when the subcommand could not be determined (fail closed)
export type Push = { args: string[]; known: boolean }
export type Verdict = { push: boolean; write: boolean; unsure: boolean; pushes: Push[] }

const EXP = '\u0001' // stands for any expansion inside a word
const PUSH_TEXT = /\bgit\b[^;&|\n]*\bpush\b/
// cheap whole-text check for private projects (ssh/flock/parallel are parsed; python -c, other interpreters' strings and eval with variables are not: documented residual risk).
// It runs on the command with quoted strings and heredoc bodies stripped, and matches `git push` / `gh <create|comment|merge>`
// only at COMMAND positions (start, ; & && || | ( $( ` newline, after env assignments and env/sudo/command/exec/nohup/time
// prefixes), so `git commit -m 'add push notifications'`, `git log --grep=push` and `ls src/gh && git merge main` pass.
// The ways to skip the pre-push backstop (-c core.hooksPath, GIT_CONFIG_*) are matched on the raw text.
export function stripData(c: string): string {
  let out = c.replace(/<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, m => m.slice(0, m.indexOf('\n')) + '\n')
  out = out.replace(/'[^']*'|"(?:\\[\s\S]|[^"\\])*"/g, '""')
  return out
}
const CMD = String.raw`(?:^|[;&|(\n\x60]|\$\()[ \t]*(?:(?:\w+=\S*|(?:env|sudo|command|exec|nohup|time)(?:[ \t]+-\S+)*)[ \t]+)*(?:\S*/)?`
const GIT_PUSH = new RegExp(CMD + String.raw`git(?:[ \t]+(?:-[Cc][ \t]+\S+|-\S+))*[ \t]+push\b`)
const GH_WRITE = new RegExp(CMD + String.raw`gh(?:[ \t]+(?:-R[ \t]+\S+|--repo[ \t]+\S+|-\S+))*[ \t]+(?:[\w-]+[ \t]+)?(?:create|comment|merge)\b`)
const SKIP_HOOK = /(^|[\s'"])-c\s*["']?core\.hooksPath|\bGIT_CONFIG_(COUNT|KEY_\d*|PARAMETERS)/i
export function privateText(c: string): boolean {
  const d = stripData(c)
  return GIT_PUSH.test(d) || GH_WRITE.test(d) || SKIP_HOOK.test(c)
}
const LEAN_OUT = /\blean-agent\b[^;&|\n]*(\bworktree\s+push\b|\bpr\s+create\b|\breview\b[^;&|\n]*--(post|comment)\b)/
const GHAZ = /(^|[^\w./-])(gh|az)($|[^\w-])/
const DYNAMIC = /(^|[;&|(`\n]|\$\()\s*(\w+=\S*\s+)*["']?\$[\w{(]/
const VALUE_FLAGS = new Set(['-R', '--repo', '--hostname', '--subscription', '-o', '--output', '--query', '--organization', '--org', '--project', '--resource-group', '-g'])
const GH_READ: Record<string, string[]> = { pr: ['view', 'list', 'diff', 'checks', 'status'], issue: ['view', 'list', 'status'], search: ['prs', 'issues', 'repos', 'commits', 'code'], repo: ['view', 'list'], run: ['view', 'list'], auth: ['status'] }
const KW = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', '{', '}', 'time'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'])
// programs that run a command given among their own arguments (the git word is looked for anywhere after them)
const SCAN_ANY = new Set(['ssh', 'flock', 'parallel', 'chroot', 'strace', 'su', 'runuser', 'script', 'sg', 'newgrp', 'systemd-run', 'nsenter', 'unshare', 'proot'])
const PLAIN_WRAP = new Set(['exec', 'nohup', 'builtin', 'nice', 'ionice', 'stdbuf', 'setsid', 'unbuffer', 'chronic', 'watch'])

class Bad extends Error {}
type Seg = { words: string[]; docs: string[] }

function ghDenied(rest: string[]): boolean {
  const pos: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i]!
    if (VALUE_FLAGS.has(x)) i++
    else if (!x.startsWith('-')) pos.push(x)
  }
  if (!pos.length) return false // gh, gh --version, gh --help: no subcommand, nothing to write
  if (pos[0] === 'help' || pos[0] === 'version') return false
  if (pos[0] === 'api') {
    const m = rest.map((x, i) => (/^(-X|--method)$/.test(x) ? rest[i + 1] : /^(-X|--method)=/.test(x) ? x.split('=')[1] : /^-X\S/.test(x) ? x.slice(2) : '')).filter(Boolean).pop()
    if (m) return !/^GET$/i.test(m)
    return rest.some(x => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(x) || /^-[fF]\S/.test(x))
  }
  if (pos.length === 1 && GH_READ[pos[0]!]) return false // `gh pr`: help text
  return !(GH_READ[pos[0]!]?.includes(pos[1] ?? ''))
}
function azDenied(rest: string[]): boolean {
  let i = 0
  while (i < rest.length && rest[i]!.startsWith('-')) i += VALUE_FLAGS.has(rest[i]!) ? 2 : 1
  const pos: string[] = []
  for (; i < rest.length && !rest[i]!.startsWith('-'); i++) pos.push(rest[i]!)
  if (!pos.length || pos[0] === 'version' || pos[0] === 'help') return false
  return !/^(list|show|query|get|list-.*|show-.*)$/.test(pos[pos.length - 1]!)
}

// The desk's read-only forge commands (strict mode): ONE plain command whose program is gh or az and that the SAME classification
// the private-project guard uses (ghDenied / azDenied) calls read-only, narrowed to PR status: gh pr view|list|status, gh search prs,
// az repos pr list|show. No leading option (the subcommand sits at a fixed position) and no flag that opens a browser, takes a
// template or writes a file (--web, --output-file, --out*, --file, --template).
const FORGE_FLAG = /^(-w|--web|--template|-t|--output-file|--out(put)?-?file|--file|--out)(=|$)/
export function readOnlyForge(w: string[]): boolean {
  const [prog, a, b, c] = w
  if (prog !== 'gh' && prog !== 'az') return false
  // also: an @file value for az (it reads the file; gh's `--author @me` is fine), --debug/--verbose (request headers), a bundled short flag with w or t (-cw)
  if (w.some(x => FORGE_FLAG.test(x) || (prog === 'az' && /^@|=@/.test(x)) || /^--(debug|verbose)$/.test(x) || /^-[a-zA-Z]*[wt][a-zA-Z]*$/.test(x))) return false
  if (prog === 'gh') return !ghDenied(w.slice(1)) && ((a === 'pr' && ['view', 'list', 'status'].includes(b ?? '')) || (a === 'search' && b === 'prs'))
  return !azDenied(w.slice(1)) && a === 'repos' && b === 'pr' && (c === 'list' || c === 'show')
}

// index of the ')' closing a $( that starts at c[from] (just after the opening paren)
function closeParen(c: string, from: number): number {
  let depth = 1
  let q = ''
  for (let i = from; i < c.length; i++) {
    const ch = c[i]!
    if (q) { if (ch === q) q = ''; else if (q === '"' && ch === '\\') i++ }
    else if (ch === '\\') i++
    else if (ch === '"' || ch === "'") q = ch
    else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return i
  }
  throw new Bad()
}
function closeBrace(c: string, from: number): number {
  const j = c.indexOf('}', from)
  if (j < 0) throw new Bad()
  return j
}
function closeTick(c: string, from: number): number {
  for (let i = from; i < c.length; i++) {
    if (c[i] === '\\') i++
    else if (c[i] === '`') return i
  }
  throw new Bad()
}
// substitutions inside text that the shell would still expand (an unquoted heredoc body)
function subsOf(text: string, depth: number, v: Verdict) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') { const j = closeParen(text, i + 2); scan(text.slice(i + 2, j), depth + 1, v); i = j }
    else if (text[i] === '`') { const j = closeTick(text, i + 1); scan(text.slice(i + 1, j), depth + 1, v); i = j }
  }
}
function ansi(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{1,2})|\\([0-7]{1,3})|\\(.)/g, (_, h, o, ch) => (h ? String.fromCharCode(parseInt(h, 16)) : o ? String.fromCharCode(parseInt(o, 8)) : ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
}

function lex(c: string, depth: number, v: Verdict): Seg[] {
  const segs: Seg[] = []
  let seg: Seg = { words: [], docs: [] }
  let cur = ''
  let has = false
  let redir = 0 // 1: the next word is a redirect target (dropped), 2: a here-string (kept as data for shells)
  const pend: { seg: Seg; delim: string; raw: boolean; strip: boolean }[] = []
  const endWord = () => {
    if (has) {
      if (redir === 2) seg.docs.push(cur)
      else if (!redir) seg.words.push(cur)
      redir = 0
    }
    cur = ''
    has = false
  }
  const endSeg = () => {
    endWord()
    redir = 0
    if (seg.words.length || seg.docs.length) segs.push(seg)
    seg = { words: [], docs: [] }
  }
  const n = c.length
  for (let i = 0; i < n; i++) {
    const ch = c[i]!
    if (ch === '\\') { if (c[i + 1] !== '\n') { cur += c[i + 1] ?? ''; has = true } i++; continue }
    if (ch === "'") { const j = c.indexOf("'", i + 1); if (j < 0) throw new Bad(); cur += c.slice(i + 1, j); has = true; i = j; continue }
    if (ch === '"') {
      has = true
      let j = i + 1
      for (; j < n && c[j] !== '"'; j++) {
        const d = c[j]!
        if (d === '\\') { const e = c[j + 1] ?? ''; cur += /["\\$`]/.test(e) ? e : '\\' + e; j++ }
        else if (d === '$' && c[j + 1] === '(' && c[j + 2] !== '(') { const k = closeParen(c, j + 2); scan(c.slice(j + 2, k), depth + 1, v); cur += EXP; j = k }
        else if (d === '$' && c[j + 1] === '(') { const k = closeParen(c, j + 2); cur += EXP; j = k }
        else if (d === '$' && c[j + 1] === '{') { const k = closeBrace(c, j + 2); cur += EXP; j = k }
        else if (d === '$' && /[\w@*#?!$-]/.test(c[j + 1] ?? '')) { cur += EXP; j++; while (/\w/.test(c[j] ?? '') && /\w/.test(c[j + 1] ?? '')) j++ }
        else if (d === '`') { const k = closeTick(c, j + 1); scan(c.slice(j + 1, k), depth + 1, v); cur += EXP; j = k }
        else cur += d
      }
      if (j >= n) throw new Bad()
      i = j
      continue
    }
    if (ch === '$') {
      const nx = c[i + 1] ?? ''
      has = true
      if (nx === "'") { let j = i + 2; while (j < n && c[j] !== "'") j += c[j] === '\\' ? 2 : 1; if (j >= n) throw new Bad(); cur += ansi(c.slice(i + 2, j)); i = j; continue }
      if (nx === '(' && c[i + 2] === '(') { const j = closeParen(c, i + 2); cur += EXP; i = j; continue }
      if (nx === '(') { const j = closeParen(c, i + 2); scan(c.slice(i + 2, j), depth + 1, v); cur += EXP; i = j; continue }
      if (nx === '{') { const j = closeBrace(c, i + 2); cur += EXP; i = j; continue }
      if (/[\w@*#?!$-]/.test(nx)) { cur += EXP; i++; while (/\w/.test(c[i] ?? '') && /\w/.test(c[i + 1] ?? '')) i++; continue }
      cur += '$'
      continue
    }
    if (ch === '`') { const j = closeTick(c, i + 1); scan(c.slice(i + 1, j), depth + 1, v); cur += EXP; has = true; i = j; continue }
    if (ch === ' ' || ch === '\t') { endWord(); continue }
    if (ch === '\n' || ch === '\r') {
      endWord()
      if (ch === '\n' && pend.length) {
        let pos = i + 1
        for (const p of pend) {
          const lines: string[] = []
          while (pos <= n) {
            let e = c.indexOf('\n', pos)
            if (e < 0) e = n
            const line = c.slice(pos, e)
            pos = e + 1
            if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) break
            lines.push(line)
          }
          const body = lines.join('\n')
          p.seg.docs.push(body)
          if (!p.raw) subsOf(body, depth, v)
        }
        pend.length = 0
        i = pos - 1
      }
      endSeg()
      continue
    }
    if (ch === '#' && !has) { while (i + 1 < n && c[i + 1] !== '\n') i++; continue }
    if (ch === '&' && c[i + 1] === '>') { endWord(); i += c[i + 2] === '>' ? 2 : 1; redir = 1; continue }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') { endSeg(); continue }
    if (ch === '<' || ch === '>') {
      if (has && /^\d+$/.test(cur)) { cur = ''; has = false } else endWord()
      if (ch === '<' && c[i + 1] === '<' && c[i + 2] === '<') { i += 2; redir = 2; continue }
      if (ch === '<' && c[i + 1] === '<') {
        i += 2
        let strip = false
        if (c[i] === '-') { strip = true; i++ }
        while (c[i] === ' ' || c[i] === '\t') i++
        let delim = ''
        let raw = false
        for (; i < n && !/[\s;&|()<>]/.test(c[i]!); i++) {
          const d = c[i]!
          if (d === "'" || d === '"') { raw = true; const j = c.indexOf(d, i + 1); if (j < 0) throw new Bad(); delim += c.slice(i + 1, j); i = j }
          else if (d === '\\') { raw = true; delim += c[++i] ?? '' }
          else delim += d
        }
        i--
        pend.push({ seg, delim, raw, strip })
        continue
      }
      if (c[i + 1] === ch || c[i + 1] === '&' || c[i + 1] === '|') i++
      if (c[i + 1] === '&') i++
      redir = 1
      continue
    }
    cur += ch
    has = true
  }
  endSeg()
  return segs
}

const base = (x: string) => x.slice(x.lastIndexOf('/') + 1)
const isAssign = (x: string) => /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(x)

function segEval(seg: Seg, depth: number, v: Verdict) {
  const w = seg.words
  let i = 0
  const skipFlags = (withValue: RegExp) => { while (i < w.length && w[i]!.startsWith('-') && w[i] !== '--') i += withValue.test(w[i]!) ? 2 : 1 }
  for (let guard = 0; guard < 50; guard++) {
    if (i >= w.length) return
    const x = w[i]!
    if (isAssign(x)) { i++; continue }
    const b = base(x)
    if (b.includes(EXP)) { v.write = true; return } // a variable / substitution as the program name
    if (KW.has(x)) { i++; continue }
    if (b === 'sudo' || b === 'doas') { i++; skipFlags(/^-(u|g|h|p|C|r|t|U|D|R)$/); continue }
    if (b === 'command') { i++; while (i < w.length && w[i]!.startsWith('-')) { if (/^-[a-zA-Z]*[vV]/.test(w[i]!)) return; i++ } continue }
    if (b === 'env') {
      i++
      while (i < w.length && (w[i]!.startsWith('-') || isAssign(w[i]!))) {
        if (w[i] === '-S' || w[i] === '--split-string') { if (w[i + 1] !== undefined) scan(w[i + 1]!, depth + 1, v); return }
        i += /^-(u|C)$/.test(w[i]!) ? 2 : 1
      }
      continue
    }
    if (b === 'timeout') { i++; skipFlags(/^-(k|s)$/); i++; continue }
    if (b === 'xargs') { i++; skipFlags(/^-(I|n|P|L|d|E|s|a)$/); continue }
    if (PLAIN_WRAP.has(b)) { i++; skipFlags(/^-(n|p|c|i|o|e|d)$/); continue }
    if (b === 'find') {
      for (let k = i; k < w.length; k++) {
        if (/^-(exec|execdir|ok|okdir)$/.test(w[k]!)) {
          const cmd: string[] = []
          for (k++; k < w.length && w[k] !== ';' && w[k] !== '+'; k++) cmd.push(w[k]!)
          segEval({ words: cmd, docs: [] }, depth, v)
        }
      }
      return
    }
    if (b === 'eval') { scan(w.slice(i + 1).join(' '), depth + 1, v); return }
    if (SHELLS.has(b)) {
      const rest = w.slice(i + 1)
      const k = rest.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
      if (k >= 0 && rest[k + 1] !== undefined) scan(rest[k + 1]!, depth + 1, v)
      else if (!seg.docs.length && !rest.some(a => !a.startsWith('-'))) v.unsure = true // script arrives on stdin
      for (const d of seg.docs) scan(d, depth + 1, v)
      return
    }
    if (b === 'gh') { if (ghDenied(w.slice(i + 1))) v.write = true; return }
    if (b === 'az') { if (azDenied(w.slice(i + 1))) v.write = true; return }
    if (b === 'lean-agent') { if (LEAN_OUT.test('lean-agent ' + w.slice(i + 1).join(' '))) v.write = true; return }
    if (b === 'git') {
      let j = i + 1
      while (j < w.length && w[j]!.startsWith('-')) j += /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)$/.test(w[j]!) ? 2 : 1
      if (w[j] === 'push') { v.push = true; v.pushes.push({ args: w.slice(j + 1), known: true }) }
      else if (w[j]?.includes(EXP)) { v.push = true; v.pushes.push({ args: w.slice(j + 1), known: false }) }
      if (w[j] === 'remote') { const k = w.slice(j + 1).find(a => !a.startsWith('-')); if (k === 'add' || k === 'set-url') v.write = true }
      return
    }
    if (SCAN_ANY.has(b)) {
      for (let k = i + 1; k < w.length; k++) {
        if (base(w[k]!) === 'git') { segEval({ words: w.slice(k), docs: [] }, depth, v); return }
        if (/\s/.test(w[k]!)) scan(w[k]!, depth + 1, v)
      }
    }
    return
  }
}

function scan(c: string, depth: number, v: Verdict) {
  if (depth > 8) throw new Bad()
  for (const s of lex(c, depth, v)) segEval(s, depth, v)
}

export function analyze(c: string): Verdict {
  const v: Verdict = { push: false, write: false, unsure: false, pushes: [] }
  try {
    scan(c, 0, v)
  } catch (e) {
    if (!(e instanceof Bad)) throw e
    v.unsure = true
  }
  if (v.unsure) {
    if (GHAZ.test(c) || DYNAMIC.test(c) || LEAN_OUT.test(c)) v.write = true
    if (PUSH_TEXT.test(c)) { v.push = true; v.pushes.push({ args: [], known: false }) }
  }
  return v
}

// A pipeline of plain simple commands as word lists (quotes resolved), or null for anything the scanner cannot PROVE plain.
// The general lexer above drops redirections and flattens ; & | ( ), so it cannot prove "no redirect"; this scanner is strict
// instead: outside quotes words and the pipe `|` are accepted (no ; & < > ( ) backtick $ * ? [ \ ! # newline, no `||`, no
// empty segment, no word-initial ~, no `{a,b}` / `{1..3}` brace expansion; `HEAD~1` and `@{u}` are plain); inside single quotes everything is data; inside double quotes
// `$` and backtick are refused. Globs, braces and tildes must be quoted (then they
// are data for the program) or not used.
// Opt-in (the readers' and the reviewer's command set, guard.ts): `glob` lets an unquoted * ? [ ] through, and the word that carries one
// comes back with GLOB_MARK in front, so the caller expands it itself and checks every match; `devnull` lets the exact word `2>/dev/null`
// (stderr thrown away, nothing else) through. Nothing else changes: any other redirect, `>`, `<`, `&`, `!` or `\` still returns null.
export const GLOB_MARK = '\u0001'
export const isGlobWord = (w: string) => w.startsWith(GLOB_MARK)
export function plainPipeline(c: string, opts: { glob?: boolean; devnull?: boolean } = {}): string[][] | null {
  const segs: string[][] = []
  let words: string[] = []
  let cur = ''
  let has = false
  let globbed = false
  const endWord = () => { if (has) words.push(globbed ? GLOB_MARK + cur : cur); cur = ''; has = false; globbed = false }
  const endSeg = (): boolean => { endWord(); if (!words.length) return false; segs.push(words); words = []; return true }
  const n = c.length
  for (let i = 0; i < n; i++) {
    const ch = c[i]!
    if (ch === "'") { const j = c.indexOf("'", i + 1); if (j < 0) return null; cur += c.slice(i + 1, j); has = true; i = j; continue }
    if (ch === '"') {
      has = true
      let j = i + 1
      for (; j < n && c[j] !== '"'; j++) {
        const d = c[j]!
        if (d === '$' || d === '`') return null
        if (d === '\\') { const e = c[j + 1] ?? ''; if (e === '"' || e === '\\') cur += e; else cur += '\\' + e; j++; continue } // bash keeps other backslashes literally ("a\|b")
        cur += d
      }
      if (j >= n) return null
      i = j
      continue
    }
    if (ch === ' ' || ch === '\t') { endWord(); continue }
    if (ch === '|') { if (c[i + 1] === '|' || !endSeg()) return null; continue }
    if (ch === '{') { // `@{u}` is literal; `{a,b}` / `{1..3}` would be expanded by the shell
      const j = c.indexOf('}', i)
      const inner = j < 0 ? ',' : c.slice(i + 1, j)
      if (j < 0 || /,|\.\.|[\s;&<>|`$'"]/.test(inner)) return null
      cur += c.slice(i, j + 1); has = true; i = j
      continue
    }
    if (ch === '~' && !has) return null // tilde expansion only at the start of a word (`HEAD~1` is plain)
    if (ch === '~') { cur += ch; continue }
    if (ch === '>' && opts.devnull && cur === '2' && has && !globbed && c.startsWith('>/dev/null', i) && /^(?:[\s|]|$)/.test(c.slice(i + 10, i + 11))) { // the whole word is `2>/dev/null`
      cur = ''
      has = false
      i += 9
      continue
    }
    if (opts.glob && /[*?[\]]/.test(ch)) { cur += ch; has = true; globbed = true; continue }
    if (/[;&<>()`$}*?[\]\\!\n\r#]/.test(ch)) return null
    cur += ch
    has = true
  }
  if (!endSeg()) return null
  return segs
}

// The words of ONE plain simple command (quotes resolved), or null for anything else: a pipe, several commands, a redirect,
// an expansion or substitution, an unquoted glob. It is plainPipeline with exactly one segment, so the proof of "plain" is the
// same strict scanner (a redirect is refused there, not dropped).
export function plainWords(c: string): string[] | null {
  const segs = plainPipeline(c)
  return segs && segs.length === 1 ? segs[0]! : null
}
