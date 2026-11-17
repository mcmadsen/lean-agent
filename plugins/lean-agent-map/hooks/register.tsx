import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Diag, MapView } from '../types'

const PANE = 'lean-agent-live-map'
const TITLE = 'Live map'
const FAST_MS = 2000
const SLOW_MS = 10000

const TEAL = '#2EC4B6'
const AMBER = '#F2A541'
const BLUE = '#7AA2F7'
const RED = '#F07167'
const MUTED = '#9AA3B2'

const EMPTY: MapView = { snap: null, svg: '', isDown: true }
const view = atom({ plugin: 'lean-agent-map', key: 'view' } as const, EMPTY, {
  shape: 'view-1',
})
const isPaused = atom(
  { plugin: 'lean-agent-map', key: 'isPaused' } as const,
  false,
  { shape: 'paused-1' },
)
const waiting = atom({ plugin: 'lean-agent-map', key: 'waiting' } as const, '', {
  shape: 'waiting-1',
})

const EMPTY_DIAG: Diag = { state: 'starting…', error: '', bin: '', surface: '', lastOk: '' }
const diag = atom({ plugin: 'lean-agent-map', key: 'diag' } as const, EMPTY_DIAG, {
  shape: 'diag-1',
})

// The only commands this mod ever runs: the lean-agent binary it resolved (map --json, map --svg --mini, waiting),
// and the lookups that find that binary.
const JSON_ARGS = ['map', '--json'] as const
const SVG_ARGS = ['map', '--svg', '--mini', '--width', '380', '--height', '220'] as const
const WAITING_ARGS = ['waiting'] as const
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

const GLYPH = { working: '●', attention: '◐', failed: '✕', idle: '○' } as const
type Health = keyof typeof GLYPH

function healthOf(n: { state: string; undelivered?: boolean }): Health {
  if (n.undelivered || ['undelivered', 'orphaned', 'dead', 'failed', 'bad', 'error'].includes(n.state)) return 'failed'
  if (['waiting', 'stuck', 'blocked', 'attention', 'queued', 'warn'].includes(n.state)) return 'attention'
  if (['active', 'alive', 'running', 'working', 'busy'].includes(n.state)) return 'working'
  return 'idle'
}

// The agents (threads) with their current tool and live session (worker) count.
function agentRows(snap: MapView['snap']) {
  const nodes = snap?.nodes ?? []
  return nodes
    .filter(n => n.kind === 'thread')
    .map(n => {
      const now = n.activity?.now
      return {
        label: n.label,
        health: healthOf(n),
        tool: typeof now === 'string' ? now : (now?.tool ?? ''),
        sessions: nodes.filter(w => w.kind === 'worker' && w.parent === n.id && w.state !== 'done').length,
      }
    })
}

function planText(snap: MapView['snap']): string {
  const ws = snap?.plan?.windows ?? []
  const w = ws.find(x => x.name === 'five_hour') ?? ws[0]
  return w ? `${w.label} ${Math.round(w.pct)}%` : ''
}

function parse(text: string): MapView['snap'] {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && v.service ? v : null
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
    await $.ui.status(`lean-agent map: ${text}`)
  } catch {
    // a surface without a status line
  }
}

// "desk: external, attached 3m ago" (empty when the desk is hosted or unknown); reports waiting for an idle desk are counted.
function deskLine(snap: MapView["snap"] | null | undefined): string {
  const d = snap?.service?.desk
  if (!d || d.mode !== 'external') return ''
  const base = d.attached ? `desk: external, attached ${d.age ?? '?'}` : 'desk: external, not attached'
  return d.pending ? `${base} · ${d.pending} waiting for you` : base
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
  if (isBusy) return true
  isBusy = true
  let snap: MapView['snap'] = null
  let svg = ''
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
      const j = await $.process.run([bin, ...JSON_ARGS])
      if (j.exitCode !== 0) {
        error = `lean-agent map --json failed (exit ${j.exitCode}): ${firstLine(j.stderr)}`
        state = 'map --json failed'
      } else {
        snap = parse(j.stdout)
        if (!snap) {
          error = `lean-agent map --json failed (exit 0): ${firstLine(j.stderr) || 'unreadable output'}`
          state = 'map --json failed'
        } else if (snap.service.up !== true) {
          state = 'service not running'
        } else {
          isUp = true
          const s = await $.process.run([bin, ...SVG_ARGS])
          if (s.exitCode === 0 && s.stdout.includes('<svg')) svg = s.stdout
          state = snap.nodes.length === 0 ? 'no data yet' : 'ok'
          await setDiag($, { lastOk: clock() })
        }
      }
    }
  } catch (err) {
    error = `lean-agent map --json failed (exit ?): ${firstLine(String((err as Error)?.message ?? err))}`
    state = 'map --json failed'
  } finally {
    isBusy = false
  }
  await update($, view, () => ({ snap, svg, isDown: !isUp }))
  await setDiag($, { state, error, bin })
  await status($, deskLine(snap) ? `${state} · ${deskLine(snap)}` : state)
  return isUp
}

function schedule($: any, ms: number) {
  stop()
  timer = $.clock.after(ms, async () => {
    timer = null
    if (!isActive) return
    const panes = await $.ui.panes()
    const pane = panes.find((p: { id: string }) => p.id === PANE)
    if (!pane) return // closed: stop polling
    if (!pane.isPlaced || (await read($, isPaused))) {
      schedule($, FAST_MS)
      return
    }
    const isUp = await poll($)
    if (isActive && !timer) schedule($, isUp ? FAST_MS : SLOW_MS)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const role = await $.env.get('LEAN_AGENT_SESSION_ROLE')
    await setDiag($, { ...EMPTY_DIAG, surface: String((e as any).surface ?? '') })
    await status($, 'starting…')
    const isUp = await poll($)
    // The front desk, or no role while the service is up. Everyone gets /live-map.
    const isDesk = role === 'main' || (isUp && (role === undefined || role === ''))
    await $.command.register({
      name: 'live-map',
      description: 'Show or hide the live map pane',
    })
    if (!isDesk) return next(e)

    isActive = true
    await update($, isPaused, () => false)
    void $.ui.open({ id: PANE, title: TITLE })
    schedule($, 0)

    return next(e)
  })

  on('command.run', { command: 'live-map' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some((p: { id: string }) => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Live map closed.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    isActive = true
    schedule($, 0)

    return { text: 'Live map opened.' }
  })

  on('ui.close', async ($, e, next) => {
    const ran = await next(e)
    if (e.id === PANE) {
      isActive = false
      stop()
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const v = await read($, view)
    const d = await read($, diag)
    const paused = await read($, isPaused)
    const inboxText = await read($, waiting)
    const snap = v.snap
    const svc = snap?.service
    const state = stateText(d)
    const isOk = d.error === '' && d.state === 'ok'
    const pill = isOk ? (paused ? 'Paused' : 'Live') : d.error !== '' ? 'Problem' : d.state
    const pillColor = isOk ? (paused ? MUTED : TEAL) : d.error !== '' ? RED : AMBER
    const head = svc?.up
      ? `Socket listening · ${svc.socket_ms ?? '?'} ms · CPU ${svc.cpu_pct ?? '?'}%`
      : `Service down · socket not listening${svc?.socket ? ` at ${svc.socket}` : ''}`
    const moving = (snap?.moving ?? []).slice(0, 8)
    const inbox = snap?.inbox ?? 0
    const alt =
      `${snap?.nodes.length ?? 0} nodes: ` +
      (snap?.nodes ?? []).map(n => `${n.label} ${n.state}`).join(', ') +
      (moving.length
        ? `. Latest: ${moving.slice(0, 3).map(m => `${m.dir === 'to' ? 'to' : 'from'} ${m.node} ${m.text}`).join('; ')}`
        : '. Nothing moving.')
    const footer = (
      <Text color={MUTED}>
        {`${state} · bin ${d.bin || '?'} · surface ${e.surface ?? d.surface ?? '?'} · last ok ${d.lastOk || 'never'}`}
      </Text>
    )
    const diagnosis = isOk ? null : (
      <Text color={d.error !== '' ? RED : AMBER} bold>
        {state}
      </Text>
    )

    // Only the desktop is known to draw Svg; the resolve table may still hand one out elsewhere.
    if (!Svg || e.surface !== 'desktop') {
      const rows = agentRows(snap)
      const tot = snap?.totals
      const plan = planText(snap)
      return (
        <Box flexDirection="column">
          <Text bold>{`● lean-agent · ${snap ? `${snap.nodes.length} nodes` : state}`}</Text>
          {diagnosis}
          {rows.map(r => (
            <Text>
              {`${GLYPH[r.health]} ${r.label}${r.tool ? ` · ${r.tool}` : ''} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}`}
            </Text>
          ))}
          <Text>
            {`Inbox ${inbox} · ${rows.length} agents · ${rows.reduce((n, r) => n + r.sessions, 0)} sessions`}
            {tot ? ` · ${tot.tools_per_min ?? 0} tools/min · ${tot.usd_today ?? 0} USD today` : ''}
          </Text>
          {plan !== '' && <Text>{`Plan ${plan}`}</Text>}
          {moving.map(m => (
            <Text>
              {m.dir === 'to' ? '→' : '←'} {m.node} {m.text} {Math.round(m.age_s)} s
            </Text>
          ))}
          {footer}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Live map</Text>
          <Text color={pillColor} bold>
            {pill}
          </Text>
        </Box>
        {diagnosis}
        <Text color={MUTED}>{head}</Text>
        {deskLine(snap) ? <Text color={MUTED}>{deskLine(snap)}</Text> : null}
        {v.svg !== '' && (
          <Svg source={v.svg} alt={alt} width={380} height={220} isInteractive />
        )}
        <Text bold>Moving now</Text>
        {moving.length === 0 && <Text color={MUTED}>Nothing moving.</Text>}
        {moving.map(m => (
          <Box flexDirection="row" gap={1}>
            <Text color={m.dir === 'to' ? TEAL : AMBER}>
              {m.dir === 'to' ? '→' : '←'}
            </Text>
            <Text color={MUTED}>{m.node}</Text>
            <Text>{m.text}</Text>
            <Text color={MUTED}>{Math.round(m.age_s)} s</Text>
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          <Text color={inbox > 0 ? AMBER : MUTED}>
            Inbox {inbox} · threads waiting on you
          </Text>
          <Button
            key="inbox"
            label="Show inbox"
            onPress={async () => {
              const bin = resolved || (await resolveBin($))
              if (!bin) {
                await update($, waiting, () => NOT_FOUND)
                return
              }
              const r = await $.process.run([bin, ...WAITING_ARGS])
              await update($, waiting, () => r.stdout || r.stderr || 'Nothing waiting.')
            }}
          />
        </Box>
        {inboxText !== '' && <Text color={BLUE}>{inboxText}</Text>}
        <Box flexDirection="row" gap={1}>
          <Button
            key="pause"
            label={paused ? 'Resume' : 'Pause'}
            onPress={async () => {
              await update($, isPaused, p => !p)
            }}
          />
        </Box>
        {footer}
      </Box>
    )
  })
}
