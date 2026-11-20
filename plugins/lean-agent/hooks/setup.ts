// Setup without a model turn: the pane's button, the /lean-agent-setup command and lean_doctor `fix` all go through
// setupFix, so there is one code path. doctor.fix is idempotent, so running it again is safe.
import { check, fix } from './doctor'
import { deskDir, homeDir, readJson, realPath, threadsDir } from './state'
import type { Host } from './state'

// `mcp`: what the doctor's `MCP ` rows say (an MCP server needs a variable the desk and threads do not have): not a repair a press
// can make, so it is neither a problem nor a note; it needs a value from the user (lean_doctor mcp-env, asked by the desk)
export type SetupOut = { fixed: string[]; checked: string[]; problems: string[]; notes: string[]; mcp?: string[] }

// a step that hangs is given up after `ms` (the engine's own timer, so it works in the mod); the work itself runs on
export function bounded<T>($: any, p: Promise<T>, label: string, ms = 5_000): Promise<T> {
  let timer: any
  let limit: Promise<never> | null = null
  try {
    limit = new Promise<never>((_, rej) => {
      timer = $.clock.after(ms, () => rej(new Error(`${label} timed out`)))
    })
  } catch {
    /* no timer: the step runs unbounded */
  }
  return (limit ? Promise.race([p, limit]) : p).finally(() => {
    try {
      timer?.cancel?.()
    } catch {
      /* already fired */
    }
  })
}

// the `FIX ` lines of a doctor check, without their marker
const fixLines = (lines: string[]): string[] => lines.filter(l => l.startsWith('FIX')).map(l => l.replace(/^FIX\s+/, ''))
// what no setup press can repair: the host is not macOS, `claude` is not on the app's PATH, or a session runs old code or an
// unexpected model (the user closes it and starts a new one)
const UNFIXABLE = /needs Claude Desktop|not on PATH|start a new session|close it and|lean-agent pins|lean-agent started it/
export const problemsOf = (lines: string[]): string[] => fixLines(lines).filter(l => !UNFIXABLE.test(l))
export const notesOf = (lines: string[]): string[] => fixLines(lines).filter(l => UNFIXABLE.test(l))

export const mcpOf = (lines: string[]): string[] => lines.filter(l => l.startsWith('MCP ')).map(l => l.replace(/^MCP\s+/, ''))

export async function setupCheck(h: Host, root: string): Promise<{ checked: string[]; problems: string[]; notes: string[]; mcp: string[] }> {
  const checked = await check(h, root)
  return { checked, problems: problemsOf(checked), notes: notesOf(checked), mcp: mcpOf(checked) }
}

// repair, then check again. One run at a time: a press, the command and lean_doctor that arrive meanwhile share it.
let inFlight: Promise<SetupOut> | null = null
export function setupFix(h: Host, root: string): Promise<SetupOut> {
  if (!inFlight) {
    inFlight = (async () => {
      const f = await fix(h, root)
      return { fixed: f.lines, ...(await setupCheck(h, root)) }
    })().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

export const NEXT_STEP = 'Next: press "Open desk" in /lean-agent, or start a new session in ~/lean-agent-desk.'

// the lines /lean-agent-setup prints
export function setupText(o: SetupOut, isDesk: boolean): string {
  const out = [...o.fixed]
  if (o.problems.length || o.notes.length) out.push('Still to fix:', ...[...o.problems, ...o.notes].map(p => `  - ${p}`))
  if (!o.problems.length) out.push(isDesk ? 'lean-agent is set up.' : `lean-agent is set up, but this is not the desk. ${NEXT_STEP}`)
  if (o.mcp?.length) out.push('MCP servers that need a value (the desk asks you; or tell it "set NAME to ..."):', ...o.mcp.map(p => `  - ${p}`))
  return out.join('\n')
}

// Is the Claude app running? GUI apps have a minimal PATH, so pgrep is called by absolute path. null = the check itself failed.
async function appRunning(h: Host): Promise<boolean | null> {
  try {
    for (const argv of [['/usr/bin/pgrep', '-x', 'Claude'], ['/usr/bin/pgrep', '-f', '/Claude.app/Contents/MacOS/Claude']]) {
      const x = (await h.process.run(argv)).exitCode
      if (x === 0) return true
      if (x !== 1) return null // pgrep: 1 = no match; anything else = the check itself failed
    }
    return false
  } catch {
    return null
  }
}

// The deep link the Claude app opens a new session in a folder with (what `claude --desktop` does itself: the CLI refuses to run
// it when its output is captured, as it is from the mod, so the mod opens the link with the system opener instead).
export const newSessionLink = (folder: string): string => `claude://code/new?folder=${encodeURIComponent(folder)}`

// the system opener for a URL, as argv (no shell): `open` on macOS, xdg-open on Linux, and on Windows rundll32's URL handler
// (explorer.exe exits 1 on success, and `cmd /c start` would need the URL parsed by cmd)
export type Platform = 'mac' | 'windows' | 'linux'
export async function platformOf(h: Host): Promise<Platform> {
  try {
    const r = await h.process.run(['uname', '-s'])
    const n = (r.stdout || '').trim()
    if (r.exitCode === 0 && n) return n === 'Darwin' ? 'mac' : /^(MINGW|MSYS|CYGWIN|Windows)/i.test(n) ? 'windows' : 'linux'
  } catch {
    /* no uname: Windows has none */
  }
  return (await h.env.get('OS').catch(() => undefined)) === 'Windows_NT' ? 'windows' : 'linux'
}
export const openerArgv = (p: Platform, url: string): string[] => (p === 'mac' ? ['open', url] : p === 'windows' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url])

const firstLine = (s: string | undefined): string => ((s ?? '').split('\n').map(x => x.trim()).find(Boolean) ?? '').slice(0, 200).replace(/\.+$/, '')
// a process that could not be started at all (not installed), as opposed to one that started and then timed out or failed
const NOT_STARTED = /ENOENT|not found|spawn|no such file/i

// The app's deep link that resumes one session (the pane's "Open tN": the user answers the permission check in the thread's own session).
export const resumeLink = (sid: string): string => `claude://resume?session=${encodeURIComponent(sid)}`

// After the opener returned 0 the mod cannot know what the app showed: it may not resolve a `claude --bg` session id with the resume link
// and start a new session in the thread folder instead. So the reply says what to look for and how to reach the session another way.
async function verifyNote(h: Host, id: string, sid: string): Promise<string> {
  const t = await readJson<{ title?: unknown } | null>(h, `${threadsDir(await homeDir(h))}/${id}/thread.json`, null).catch(() => null)
  const title = typeof t?.title === 'string' ? t.title.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  const name = title ? `${id} · ${title}` : id // the name the thread's session was started with (threads.ts label)
  return `The opener cannot tell whether the app showed the right session: if a new desk opened instead, close it; the thread's session is in the app's session list as '${name}'. In a terminal: claude attach ${sid}`
}

// Open tN: `release` stops the thread's idle process and says its session id (threads.ts action release; a working thread, a session
// outside the thread folder or a process that does not go away are refused there, and nothing is opened), then the resume link goes to
// the system opener (same argv, no shell, as openDesk). A failing opener answers with the hand-made way.
export async function openThreadSession(h: Host, id: string, release: () => Promise<{ ok: boolean; text: string; data?: unknown }>, surface?: string): Promise<{ ok: boolean; text: string }> {
  const plat = await platformOf(h)
  // (checked first: nothing is stopped when there is no app to open the session in)
  if (plat === 'mac' && surface !== 'desktop' && (await appRunning(h)) === false) return { ok: false, text: `The Claude app is not running: open it, then press Open ${id} again.` }
  const r = await release()
  if (!r.ok) return { ok: false, text: r.text }
  const sid = String((r.data as { sid?: unknown } | undefined)?.sid ?? '')
  if (!sid) return { ok: false, text: `${id} has no session to open` }
  const argv = openerArgv(plat, resumeLink(sid))
  const by = `open ${id} from the session list in the Claude app by hand`
  try {
    const x = await h.process.run(argv, { timeoutMs: 15_000 })
    if (x.exitCode === 0) return { ok: true, text: `${id} opened in the Claude app: answer there. ${await verifyNote(h, id, sid)}` }
    return { ok: false, text: `Could not open the Claude app: ${firstLine(x.stderr) || firstLine(x.stdout) || `${argv[0]} exited ${x.exitCode}`}; ${by}` }
  } catch (e) {
    return { ok: false, text: `Could not open the Claude app: ${firstLine(String((e as Error)?.message ?? e)) || `${argv[0]} failed`}; ${by}` }
  }
}

// Opens the desk in the Claude app: a new session in the desk folder through the app's deep link, and never launches the app
// itself: without a running app there is nothing to open it in (checked on macOS; a pane drawn on the 'desktop' surface is inside
// the app, so the check is skipped; if the check itself errors the link is opened anyway). `claude --desktop` is only the last
// fallback, for a system whose opener cannot be started at all.
export async function openDesk(h: Host, surface?: string): Promise<{ ok: boolean; text: string }> {
  const dir = deskDir(await homeDir(h))
  if (!(await h.fs.exists(dir))) return { ok: false, text: 'The desk folder is missing: press Set up first.' }
  const plat = await platformOf(h)
  if (plat === 'mac' && surface !== 'desktop' && (await appRunning(h)) === false) return { ok: false, text: 'The Claude app is not running: open it, then press Open desk again.' }
  const argv = openerArgv(plat, newSessionLink(await realPath(h, dir)))
  const by = 'start a new session in ~/lean-agent-desk by hand'
  let spawnError = ''
  try {
    // (bounded: xdg-open can block on some desktops; rundll32 exits 0 even when no handler is registered, which cannot be told apart)
    const r = await h.process.run(argv, { timeoutMs: 15_000 })
    if (r.exitCode === 0) return { ok: true, text: 'Desk opened in the Claude app.' }
    return { ok: false, text: `Could not open the Claude app: ${firstLine(r.stderr) || firstLine(r.stdout) || `${argv[0]} exited ${r.exitCode}`}; ${by}` }
  } catch (e) {
    spawnError = firstLine(String((e as Error)?.message ?? e))
    // started but failed (a timeout): the CLI fallback could open a second window, so it is not tried
    if (!NOT_STARTED.test(spawnError)) return { ok: false, text: `Could not open the Claude app: ${spawnError || `${argv[0]} failed`}; ${by}` }
  }
  // the opener could not be started (not installed): the CLI's own way, which works only where its output is not captured
  try {
    const r = await h.process.run(['claude', '--desktop'], { cwd: dir })
    if (r.exitCode === 0) return { ok: true, text: 'Desk opened in the Claude app.' }
    return { ok: false, text: `Could not open the Claude app: ${spawnError || `${argv[0]} could not be started`}; claude --desktop: ${firstLine(r.stderr) || firstLine(r.stdout) || `exited ${r.exitCode}`}; ${by}` }
  } catch (e) {
    return { ok: false, text: `Could not open the Claude app: ${spawnError || `${argv[0]} could not be started`}; claude --desktop: ${firstLine(String((e as Error)?.message ?? e))}; ${by}` }
  }
}
