// Setup without a model turn: the pane's button, the /lean-agent-setup command and lean_doctor `fix` all go through
// setupFix, so there is one code path. doctor.fix is idempotent, so running it again is safe.
import { check, fix } from './doctor'
import { deskDir, homeDir } from './state'
import type { Host } from './state'

export type SetupOut = { fixed: string[]; checked: string[]; problems: string[] }

// the `FIX ` lines of a doctor check, without their marker
export const problemsOf = (lines: string[]): string[] => lines.filter(l => l.startsWith('FIX')).map(l => l.replace(/^FIX\s+/, ''))

export async function setupCheck(h: Host, root: string): Promise<{ checked: string[]; problems: string[] }> {
  const checked = await check(h, root)
  return { checked, problems: problemsOf(checked) }
}

// repair, then check again
export async function setupFix(h: Host, root: string): Promise<SetupOut> {
  const f = await fix(h, root)
  return { fixed: f.lines, ...(await setupCheck(h, root)) }
}

export const NEXT_STEP = 'Next: press "Open desk" in /lean-agent, or start a new session in ~/lean-agent-desk.'

// the lines /lean-agent-setup prints
export function setupText(o: SetupOut, isDesk: boolean): string {
  const out = [...o.fixed]
  if (o.problems.length) out.push('Still to fix:', ...o.problems.map(p => `  - ${p}`))
  else out.push(isDesk ? 'lean-agent is set up.' : `lean-agent is set up, but this is not the desk. ${NEXT_STEP}`)
  return out.join('\n')
}

// Opens the desk the way the login agent does (`claude --desktop` in the desk folder), and never launches the Claude app
// itself: without a running app there is nothing to open it in.
export async function openDesk(h: Host): Promise<{ ok: boolean; text: string }> {
  const dir = deskDir(await homeDir(h))
  if (!(await h.fs.exists(dir))) return { ok: false, text: 'The desk folder is missing: press Set up first.' }
  const app = await h.process.run(['pgrep', '-x', 'Claude']).catch(() => ({ exitCode: 1 }) as any)
  if (app.exitCode !== 0) return { ok: false, text: 'The Claude app is not running: open it, then press Open desk again.' }
  const r = await h.process.run(['claude', '--desktop'], { cwd: dir })
  return r.exitCode === 0 ? { ok: true, text: 'Desk opened in the Claude app.' } : { ok: false, text: `claude --desktop exited ${r.exitCode}: start a new session in ~/lean-agent-desk instead.` }
}
