// Setup without a model turn: the pane's button, the /lean-agent-setup command and lean_doctor `fix` all go through
// setupFix, so there is one code path. doctor.fix is idempotent, so running it again is safe.
import { check, fix } from './doctor'
import { deskDir, homeDir } from './state'
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

// Opens the desk the way the login agent does (`claude --desktop` in the desk folder), and never launches the Claude app
// itself: without a running app there is nothing to open it in. A pane drawn on the 'desktop' surface is inside the app,
// so the app is running and the check is skipped; if the check itself errors, `claude --desktop` is tried anyway.
export async function openDesk(h: Host, surface?: string): Promise<{ ok: boolean; text: string }> {
  const dir = deskDir(await homeDir(h))
  if (!(await h.fs.exists(dir))) return { ok: false, text: 'The desk folder is missing: press Set up first.' }
  if (surface !== 'desktop' && (await appRunning(h)) === false) return { ok: false, text: 'The Claude app is not running: open it, then press Open desk again.' }
  let r: { exitCode: number; stdout?: string; stderr?: string }
  try {
    r = await h.process.run(['claude', '--desktop'], { cwd: dir })
  } catch (e) {
    return { ok: false, text: `claude --desktop failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` }
  }
  if (r.exitCode === 0) return { ok: true, text: 'Desk opened in the Claude app.' }
  const why = (r.stderr || r.stdout || '').trim().slice(0, 200)
  return { ok: false, text: `claude --desktop exited ${r.exitCode}${why ? `: ${why}` : ''}. Start a new session in ~/lean-agent-desk instead.` }
}
