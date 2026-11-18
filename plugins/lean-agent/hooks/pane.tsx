// The desk pane (design 2.5): goals, answers with ack, threads with Resume/Start, footer. Opens by itself only in the
// desk and through /lean-agent anywhere. Never blank: a failure is drawn as a red line. Resume/Start go through
// leanThread (the lean_thread tool), so the logic exists once.
import { ackRows, loadView, resetViewCache, threadStatus } from './view'
import type { GoalTone, View } from './view'
import { leanThread } from './threads'
import { hostOf } from './host'

export const PANE = 'lean-agent'
export const VERSION = '1.0.0'
const TONE: Record<GoalTone, string> = { working: 'green', waiting: 'yellow', stuck: 'red', quiet: 'gray' }

let lastError = ''
let lastRefresh = ''
let notice = ''
export const resetPaneState = () => {
  lastError = ''
  lastRefresh = ''
  notice = ''
  resetViewCache()
}

export async function openPane($: any): Promise<void> {
  await $.ui.open({ id: PANE, title: 'lean-agent' })
}

const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/\s+/g, ' ')

export function registerPane(on: any) {
  // the pane opens by itself in the desk only; the mod's own session.start hook calls this after the role is known
  on('command.run', { command: 'lean-agent' }, async ($: any) => {
    await openPane($)
    return { text: 'lean-agent pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($: any, e: any) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const host = hostOf($)
    let v: View | null = null
    let fatal = ''
    try {
      v = await loadView(host)
      lastRefresh = new Date(await host.clock.now()).toISOString().slice(11, 19)
    } catch (err) {
      fatal = String((err as Error)?.message ?? err).slice(0, 200)
    }
    const errors = [...(v?.errors ?? []), ...(fatal ? [fatal] : [])]
    lastError = errors[0] ?? ''
    const act = (label: string, f: () => Promise<unknown>) => async () => {
      try {
        resetViewCache()
        const r: any = await f()
        notice = r && r.ok === false ? String(r.text) : ''
        if (notice) lastError = notice
      } catch (err) {
        notice = lastError = `${label} failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`
      }
      $.ui.invalidate('ui.render')
    }
    const thread = (action: 'resume' | 'start', tN: string) => act(`${action} ${tN}`, () => leanThread(host, $.plugin.root, { action, tN }))
    return (
      <Box flexDirection="column">
        <Text bold>Goals</Text>
        {v && !v.goals.length && <Text dimColor>No open goals.</Text>}
        {v?.goals.map(g => (
          <Text key={`g-${g.id}`} color={TONE[g.tone]}>
            {g.id} {g.tone}: {short(g.text)}
          </Text>
        ))}
        <Text bold>Answers{v ? ` (${v.unread} unread)` : ''}</Text>
        {v?.openQuestions.map(q => (
          <Text key={`q-${q.q}`} color="yellow">
            open ? {q.from ?? 'desk'}: {short(q.question ?? '', 70)}
          </Text>
        ))}
        {v && !v.answers.length && <Text dimColor>Nothing from the threads yet.</Text>}
        {v?.answers.map(a => (
          <Box key={`a-${a.n}`}>
            <Text dimColor={!a.unread}>
              {a.rec.kind === 'ask' ? '? ' : ''}
              {a.rec.from}: {short(a.rec.text, 70)}
            </Text>
            {a.unread && <Button key={`ack-${a.n}`} label="ack" onPress={act('ack', async () => ackRows(host, a.n))} />}
          </Box>
        ))}
        {!!v?.unread && <Button key="ack-all" label="ack all" onPress={act('ack', async () => ackRows(host, 'all'))} />}
        <Text bold>Threads</Text>
        {v && !v.threads.length && <Text dimColor>No open threads.</Text>}
        {v?.threads.map(t => (
          <Box key={`t-${t.id}`}>
            <Text>
              {t.id} {short(t.title, 30)} [{t.run}] <Text dimColor>{short(t.last, 50)}</Text>
            </Text>
            {t.resumable && <Button key={`resume-${t.id}`} label="Resume" onPress={thread('resume', t.id)} />}
            {t.resumable && <Button key={`start-${t.id}`} label="Start" onPress={thread('start', t.id)} />}
          </Box>
        ))}
        {errors.map((m, i) => (
          <Text key={`err-${i}`} color="red">
            error: {m}
          </Text>
        ))}
        {!!notice && !errors.includes(notice) && <Text color="yellow">{notice}</Text>}
        <Text dimColor>
          lean-agent {VERSION} · refreshed {lastRefresh || 'never'} · last error: {lastError || 'none'} · budget today: {v?.budget ?? 'n/a'}
        </Text>
      </Box>
    )
  })
}

// Called by the mod's session.start once the role is known: /lean-agent exists everywhere, the pane opens by itself
// only in the desk (and refreshes every 5 s); a thread gets its status line instead.
export async function paneStart($: any, role: { kind: string; id?: string }): Promise<Array<() => void>> {
  await $.command.register({ name: 'lean-agent', description: 'Open the lean-agent desk pane (goals, answers, threads)' })
  return paneRole($, role)
}

// the role-dependent part of the pane: the desk opens it, a thread gets a status line; returns the timers' cancels
export async function paneRole($: any, role: { kind: string; id?: string }): Promise<Array<() => void>> {
  const cancels: Array<() => void> = []
  if (role.kind === 'desk') {
    await openPane($).catch(() => undefined)
    cancels.push($.clock.every(5_000, () => $.ui.invalidate('ui.render')).cancel)
  } else if (role.kind === 'thread' && role.id) {
    const id = role.id
    const tick = async () => {
      try {
        $.ui.status(await threadStatus(hostOf($), id))
      } catch (err) {
        $.ui.status(`${id} · status error: ${String((err as Error)?.message ?? err).slice(0, 80)}`)
      }
    }
    await tick()
    cancels.push($.clock.every(5_000, tick).cancel)
  }
  return cancels
}
