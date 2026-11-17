import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Diag, PaneData } from '../types'

const PANE = 'lean-agent'
const LEGACY_PANE = 'lean-agent-live-map' // the pane of the retired lean-agent-map plugin: closed if it is still there
const TITLE = 'lean-agent'
const FAST_MS = 5000
const SLOW_MS = 30000

const GREEN = '#3FB950'
const AMBER = '#F2A541'
const RED = '#F07167'
const MUTED = '#9AA3B2'
const BLUE = '#7AA2F7'

const data = atom({ plugin: 'lean-agent', key: 'data' } as const, null as PaneData | null, { shape: 'data-1' })

const EMPTY_DIAG: Diag = { state: 'starting…', error: '', bin: '', surface: '', lastOk: '' }
const diag = atom({ plugin: 'lean-agent', key: 'diag' } as const, EMPTY_DIAG, { shape: 'diag-1' })

// The only commands this mod ever runs: the lean-agent binary it resolved (pane --json, myq ack qN | --all),
// and the lookups that find that binary.
const PANE_ARGS = ['pane', '--json'] as const
const ACK_ALL = ['myq', 'ack', '--all'] as const
const QID = /^q\d+$/
const FIND_PATH = ['/bin/sh', '-c', 'command -v lean-agent'] as const
// The lean-agent plugin's own bin/lean-agent under the usual Claude plugin install dirs.
const FIND_PLUGIN = [
  '/bin/sh', '-c',
  'ls -1d "$HOME"/.claude/plugins/cache/*/lean-agent/*/bin/lean-agent "$HOME"/.claude/plugins/marketplaces/*/plugins/lean-agent/bin/lean-agent "$HOME"/.claude/plugins/*/lean-agent/bin/lean-agent 2>/dev/null | tail -n 1',
] as const
const FIND_LOGIN = [
  ['/bin/zsh', '-lc', 'command -v lean-agent'],
  ['/bin/bash', '-lc', 'command -v lean-agent'],
] as const

let resolved: string | null = null // the binary, once found (cached for the session)

let timer: { cancel: () => void } | null = null
let isBusy = false
let isActive = false
let isStale = false // a poll was asked for while one ran: run once more when it ends (an ack's refresh is never lost)

// Back to the start-up state (the module keeps its state for the session; specs reset it between cases).
export function resetState() {
  timer?.cancel()
  resolved = null
  timer = null
  isBusy = false
  isActive = false
  isStale = false
}

const STATE_COLOR: Record<string, string> = { working: GREEN, waiting: AMBER, stuck: RED, quiet: MUTED }

function parse(text: string): PaneData | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && v.service && Array.isArray(v.goals) && Array.isArray(v.answers) ? v : null
  } catch {
    return null
  }
}

const NOT_FOUND = 'lean-agent not found on PATH'

function firstLine(t: string): string {
  return (t || '').split('\n').find(l => l.trim() !== '')?.trim() ?? ''
}

function clock(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function find($: any, argv: readonly string[]): Promise<string> {
  try {
    const r = await $.process.run(argv)
    const line = r.exitCode === 0 ? firstLine(r.stdout) : ''
    return line.startsWith('/') || line === 'lean-agent' ? line : ''
  } catch {
    return ''
  }
}

// Once per session: lean-agent on PATH, then the plugin's install, then a login shell.
async function resolveBin($: any): Promise<string> {
  if (resolved) return resolved
  let bin = await find($, FIND_PATH)
  if (!bin) bin = await find($, FIND_PLUGIN)
  for (const argv of FIND_LOGIN) {
    if (bin) break
    bin = await find($, argv)
  }
  if (bin) resolved = bin
  return bin
}

async function setDiag($: any, patch: Partial<Diag>) {
  await update($, diag, d => ({ ...d, ...patch }))
}

// The status line shows the state even where no pane is placed.
async function status($: any, text: string) {
  try {
    await $.ui.status(`lean-agent: ${text}`)
  } catch {
    // a surface without a status line
  }
}

function stateText(d: Diag): string {
  return d.error !== '' ? d.error : d.state
}

function stop() {
  timer?.cancel()
  timer = null
}

// One poll, never overlapping; returns whether the service is up. Every outcome is a diagnosis, never a blank.
async function poll($: any): Promise<boolean> {
  if (isBusy) {
    isStale = true
    return true
  }
  isBusy = true
  let pane: PaneData | null = null
  let isUp = false
  let state = 'starting…'
  let error = ''
  let bin = ''
  try {
    bin = await resolveBin($)
    if (!bin) {
      const path = ((await $.env.get('PATH')) ?? '') as string
      error = `${NOT_FOUND} (${path.slice(0, 60) || 'PATH unset'})`
      state = 'lean-agent not found'
    } else {
      const j = await $.process.run([bin, ...PANE_ARGS])
      if (j.exitCode !== 0) {
        error = `lean-agent pane --json failed (exit ${j.exitCode}): ${firstLine(j.stderr)}`
        state = 'pane --json failed'
      } else {
        pane = parse(j.stdout)
        if (!pane) {
          error = `lean-agent pane --json failed (exit 0): ${firstLine(j.stderr) || 'unreadable output'}`
          state = 'pane --json failed'
        } else if (pane.service.up !== true) {
          state = 'service not running'
        } else {
          isUp = true
          state = 'ok'
        }
        if (pane) await setDiag($, { lastOk: clock() })
      }
    }
  } catch (err) {
    error = `lean-agent pane --json failed (exit ?): ${firstLine(String((err as Error)?.message ?? err))}`
    state = 'pane --json failed'
  } finally {
    isBusy = false
  }
  if (pane) await update($, data, () => pane)
  await setDiag($, { state, error, bin })
  const desk = pane?.desk?.label ?? ''
  await status($, desk ? `${state} · ${desk}` : state)
  if (isStale) {
    isStale = false
    return poll($)
  }
  return isUp
}

async function ack($: any, argv: readonly string[]) {
  const bin = resolved || (await resolveBin($))
  if (!bin) {
    await setDiag($, { error: NOT_FOUND })
    return
  }
  let failure = ''
  try {
    const r = await $.process.run([bin, ...argv])
    if (r.exitCode !== 0) failure = `lean-agent ${argv.join(' ')} failed (exit ${r.exitCode}): ${firstLine(r.stderr)}`
  } catch (err) {
    failure = `lean-agent ${argv.join(' ')} failed: ${firstLine(String((err as Error)?.message ?? err))}`
  }
  await poll($) // refreshes the pane (and clears the error of the last poll); the ack's own failure is shown after it
  if (failure) await setDiag($, { error: failure })
}

function schedule($: any, ms: number) {
  stop()
  timer = $.clock.after(ms, async () => {
    timer = null
    if (!isActive) return
    const panes = await $.ui.panes()
    const pane = panes.find((p: { id: string }) => p.id === PANE)
    if (!pane) return // closed: stop polling
    if (!pane.isPlaced) {
      schedule($, FAST_MS) // not visible: no process runs
      return
    }
    const isUp = await poll($)
    if (isActive && !timer) schedule($, isUp ? FAST_MS : SLOW_MS)
  })
}

async function openPane($: any) {
  try {
    const panes = await $.ui.panes()
    if (panes.some((p: { id: string }) => p.id === LEGACY_PANE)) await $.ui.close({ id: LEGACY_PANE })
  } catch {
    // nothing to close
  }
  void $.ui.open({ id: PANE, title: TITLE })
  isActive = true
  schedule($, 0)
}

async function toggle($: any, alias: boolean) {
  const panes = await $.ui.panes()
  const note = alias ? 'renamed to /lean-agent. ' : ''
  if (panes.some((p: { id: string }) => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return { text: `${note}lean-agent pane closed.` }
  }
  await openPane($)
  return { text: `${note}lean-agent pane opened.` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const role = await $.env.get('LEAN_AGENT_SESSION_ROLE')
    await setDiag($, { ...EMPTY_DIAG, surface: String((e as any).surface ?? '') })
    await status($, 'starting…')
    await poll($)
    // Auto-opens only in the front desk: the hosted main, or a local app session in the desk folder (its settings carry
    // LEAN_AGENT_DESK_FOLDER). Never in other sessions; everyone gets /lean-agent to open it on request.
    const deskFolder = await $.env.get('LEAN_AGENT_DESK_FOLDER')
    const isDesk = role === 'main' || (deskFolder === '1' && role !== 'thread')
    await $.command.register({ name: 'lean-agent', description: 'Show or hide the lean-agent pane (goals and answers)' })
    await $.command.register({ name: 'live-map', description: 'Renamed to /lean-agent' })
    if (!isDesk) return next(e)
    await openPane($)
    return next(e)
  })

  on('command.run', { command: 'lean-agent' }, async $ => toggle($, false))
  on('command.run', { command: 'live-map' }, async $ => toggle($, true))

  on('ui.close', async ($, e, next) => {
    const ran = await next(e)
    if (e.id === PANE) {
      isActive = false
      stop()
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await read($, data)
    const d = await read($, diag)
    const isOk = d.error === '' && d.state === 'ok'
    const svc = p?.service?.up ? 'service up' : 'service down'
    const header = `${svc} · ${p?.desk?.label ?? 'desk: ?'} · inbox ${p?.inbox ?? 0}`
    const goals = p?.goals ?? []
    const answers = p?.answers ?? []
    const unread = answers.filter(a => a.unread).length
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={isOk ? GREEN : d.error !== '' ? RED : AMBER}>{header}</Text>
        <Text bold>Goals ({goals.length})</Text>
        {p?.error ? <Text color={RED}>goals unavailable: {p.error}</Text> : goals.length === 0 && <Text color={MUTED}>No open goals.</Text>}
        {goals.map(g => (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={STATE_COLOR[g.state] ?? MUTED}>●</Text>
              <Text>{g.id} {g.ref}</Text>
              <Text color={MUTED}>{g.thread} · {g.state} · {g.quiet}</Text>
            </Box>
            <Text color={MUTED}>  {g.next}</Text>
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          <Text bold>Answers ({answers.length}, {unread} unread)</Text>
          {unread > 0 && <Button key="ack-all" label="ack all" onPress={async () => ack($, ACK_ALL)} />}
        </Box>
        {p?.error ? <Text color={RED}>answers unavailable: {p.error}</Text> : answers.length === 0 && <Text color={MUTED}>No answers yet.</Text>}
        {answers.map(a => (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={a.unread ? BLUE : MUTED}>{a.unread ? '● NEW' : '○'}</Text>
              <Text>{a.id} {a.q}</Text>
              {a.unread && QID.test(a.id) && <Button key={`ack-${a.id}`} label="ack" onPress={async () => ack($, ['myq', 'ack', a.id])} />}
            </Box>
            <Text color={a.unread ? undefined : MUTED}>  → {a.a}</Text>
            <Text color={MUTED}>  {a.thread} · {a.age} ago</Text>
          </Box>
        ))}
        <Text color={d.error !== '' ? RED : MUTED}>
          {stateText(d)} · last ok {d.lastOk || 'never'} · {d.bin || 'binary ?'} · surface {d.surface || '?'}
        </Text>
      </Box>
    )
  })
}
