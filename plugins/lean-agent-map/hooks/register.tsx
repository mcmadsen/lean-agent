import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { MapView } from '../types'

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

// The only commands this mod ever runs.
const JSON_ARGV = ['lean-agent', 'map', '--json'] as const
const SVG_ARGV = [
  'lean-agent', 'map', '--svg', '--mini', '--width', '380', '--height', '220',
] as const
const OPEN_ARGV = ['lean-agent', 'map', '--open'] as const
const WAITING_ARGV = ['lean-agent', 'waiting'] as const

let timer: { cancel: () => void } | null = null
let isBusy = false
let isActive = false

function parse(text: string): MapView['snap'] {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && v.service ? v : null
  } catch {
    return null
  }
}

function stop() {
  timer?.cancel()
  timer = null
}

// One poll, never overlapping; returns whether the service is up.
async function poll($: any): Promise<boolean> {
  if (isBusy) return true
  isBusy = true
  try {
    const j = await $.process.run(JSON_ARGV)
    const snap = j.exitCode === 0 ? parse(j.stdout) : null
    const isUp = !!snap && snap.service.up === true
    let svg = ''
    if (isUp) {
      const s = await $.process.run(SVG_ARGV)
      if (s.exitCode === 0 && s.stdout.includes('<svg')) svg = s.stdout
    }
    await update($, view, () => ({ snap, svg, isDown: !isUp }))
    return isUp
  } catch {
    await update($, view, () => ({ snap: null, svg: '', isDown: true }))
      return false
    } finally {
      isBusy = false
    }
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
    let isUp = false
    try {
      const r = await $.process.run(JSON_ARGV)
      const snap = r.exitCode === 0 ? parse(r.stdout) : null
      isUp = !!snap && snap.service.up === true
    } catch {
      isUp = false
    }
    const isDesk = role === 'main' || (isUp && (role === undefined || role === ''))
    if (!isDesk) return next(e)

    isActive = true
    await $.command.register({
      name: 'live-map',
      description: 'Show or hide the live map pane',
    })
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
    const paused = await read($, isPaused)
    const inboxText = await read($, waiting)
    const snap = v.snap
    const svc = snap?.service
    const pill = v.isDown ? 'Service down' : paused ? 'Paused' : 'Live'
    const pillColor = v.isDown ? RED : paused ? MUTED : TEAL
    const head = svc?.up
      ? `Socket listening · ${svc.socket_ms ?? '?'} ms · CPU ${svc.cpu_pct ?? '?'}%`
      : 'Socket not listening'
    const moving = (snap?.moving ?? []).slice(0, 8)
    const inbox = snap?.inbox ?? 0
    const alt =
      `${snap?.nodes.length ?? 0} nodes: ` +
      (snap?.nodes ?? []).map(n => `${n.label} ${n.state}`).join(', ') +
      (moving.length
        ? `. Latest: ${moving.slice(0, 3).map(m => `${m.dir === 'to' ? 'to' : 'from'} ${m.node} ${m.text}`).join('; ')}`
        : '. Nothing moving.')

    const summary = (
      <Box flexDirection="column">
        <Text bold>Live map</Text>
        <Text>
          {head} [{pill}]
        </Text>
        <Text>Inbox {inbox} · threads waiting on you</Text>
        {moving.map(m => (
          <Text>
            {m.dir === 'to' ? '→' : '←'} {m.node} {m.text} {Math.round(m.age_s)} s
          </Text>
        ))}
      </Box>
    )
    if (e.surface !== 'desktop') return summary

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Live map</Text>
          <Text color={pillColor} bold>
            {pill}
          </Text>
        </Box>
        <Text color={MUTED}>{head}</Text>
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
              const r = await $.process.run(WAITING_ARGV)
              await update($, waiting, () => r.stdout || r.stderr || 'Nothing waiting.')
            }}
          />
        </Box>
        {inboxText !== '' && <Text color={BLUE}>{inboxText}</Text>}
        <Box flexDirection="row" gap={1}>
          <Button
            key="open"
            label="Open full map"
            onPress={async () => {
              await $.process.run(OPEN_ARGV)
            }}
          />
          <Button
            key="pause"
            label={paused ? 'Resume' : 'Pause'}
            onPress={async () => {
              await update($, isPaused, p => !p)
            }}
          />
        </Box>
      </Box>
    )
  })
}
