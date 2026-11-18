// The desk pane (design 2.5): goals, answers with ack, threads with Resume/Start, footer. Opens by itself only in the
// desk and through /lean-agent anywhere. Never blank: a failure is drawn as a red line. Resume/Start go through
// leanThread (the lean_thread tool), so the logic exists once.
import { ackRows, loadView, resetViewCache, threadStatus } from './view'
import type { GoalTone, View } from './view'
import { leanThread } from './threads'
import { hostOf } from './host'
import { skillStat } from './skilltrim'
import { NEXT_STEP, bounded, openDesk, setupCheck, setupFix, setupText } from './setup'
import type { Role } from './role'

export const PANE = 'lean-agent'
export const VERSION = '1.0.4'
const TONE: Record<GoalTone, string> = { working: 'green', waiting: 'yellow', stuck: 'red', quiet: 'gray' }

let lastError = ''
let lastRefresh = ''
let notice = ''
// setup state: the last doctor check (kept 30 s; any press drops it), the lines of the last fix, a press in flight
let chk: { at: number; problems: string[]; notes: string[]; failed?: boolean } | null = null
let checking: Promise<void> | null = null // a check in flight (a second pane shares it)
let lastSetup: string[] = []
let busy = false
const CHECK_MS = 30_000
// the pane's remembered doctor check is stale after a setup run elsewhere (the command, lean_doctor)
export const dropSetupCheck = () => {
  chk = null
}
export const resetPaneState = () => {
  chk = null
  checking = null
  lastSetup = []
  busy = false
  lastError = ''
  lastRefresh = ''
  notice = ''
  resetViewCache()
}

export async function openPane($: any): Promise<void> {
  await $.ui.open({ id: PANE, title: 'lean-agent' })
}

const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/\s+/g, ' ')

export function registerPane(on: any, roleOf: () => Role = () => ({ kind: 'plain' })) {
  // the pane opens by itself in the desk only; the mod's own session.start hook calls this after the role is known
  on('command.run', { command: 'lean-agent' }, async ($: any) => {
    await openPane($)
    return { text: 'lean-agent pane opened.' }
  })

  // /lean-agent-setup: check + fix with no model turn and no lean_doctor tool, in every session
  on('command.run', { command: 'lean-agent-setup' }, async ($: any) => {
    try {
      const o = await bounded($, setupFix(hostOf($), $.plugin.root), 'setup', 60_000)
      chk = null
      return { text: setupText(o, roleOf().kind === 'desk') }
    } catch (err) {
      return { text: `setup failed: ${String((err as Error)?.message ?? err).slice(0, 200)}` }
    }
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
    const kind = roleOf().kind
    const now = await host.clock.now()
    if (!chk || now - chk.at > CHECK_MS) {
      checking ??= (async () => {
        try {
          const c = await bounded($, setupCheck(host, $.plugin.root), 'check', 20_000)
          chk = { at: now, problems: c.problems, notes: c.notes }
        } catch (err) {
          chk = { at: now, problems: [], notes: [`check failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`], failed: true }
        }
      })().finally(() => {
        checking = null
      })
      await checking
    }
    const problems = chk?.problems ?? []
    const notes = chk?.notes ?? []
    // one press at a time; a press that finds a run in flight does nothing
    const setupPress = (label: string, f: () => Promise<{ ok: boolean; text: string } | void>) => async () => {
      if (busy) {
        notice = 'Setup is already running…'
        $.ui.invalidate('ui.render')
        return
      }
      busy = true
      try {
        const r = await bounded($, Promise.resolve(f()), label, label === 'open desk' ? 15_000 : 60_000)
        notice = r?.text ?? ''
      } catch (err) {
        notice = lastError = `${label} failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`
      } finally {
        busy = false
      }
      $.ui.invalidate('ui.render')
    }
    const runSetup = setupPress('setup', async () => {
      resetViewCache()
      const o = await setupFix(host, $.plugin.root)
      lastSetup = o.fixed
      chk = { at: await host.clock.now(), problems: o.problems, notes: o.notes }
    })
    const openIt = setupPress('open desk', () => openDesk(host, e.surface))
    const setupRows = lastSetup.map((l, i) => (
      <Text key={`su-${i}`} dimColor>
        {l}
      </Text>
    ))
    const footer = (
      <Text dimColor>
        lean-agent {VERSION} · refreshed {lastRefresh || 'never'} · last error: {lastError || 'none'}
        {kind === 'desk' ? ` · skills: ${skillStat()}` : ''}
      </Text>
    )
    const noteRows = notes.map((m, i) => (
      <Text key={`nt-${i}`} color="red">
        {m}
      </Text>
    ))
    const problemRows = (
      <Box flexDirection="column">
        <Text bold color="yellow">
          lean-agent is not set up
        </Text>
        <Button key="setup" label="Set up lean-agent" onPress={runSetup} />
        {problems.map((m, i) => (
          <Text key={`pb-${i}`} color="red">
            {m}
          </Text>
        ))}
        {noteRows}
      </Box>
    )
    if (kind !== 'desk') {
      // a session that is not the desk: setup first (or the way to the desk), the desk's own view only in the desk
      return (
        <Box flexDirection="column">
          {problems.length > 0 ? (
            problemRows
          ) : (
            <Box flexDirection="column">
              <Text bold>This is not the desk</Text>
              {noteRows}
              <Text>{NEXT_STEP}</Text>
              <Box>
                <Button key="open-desk" label="Open desk" onPress={openIt} />
                <Button key="rerun-setup" label="Re-run setup" onPress={runSetup} />
              </Box>
            </Box>
          )}
          {setupRows}
          {!!notice && <Text color="yellow">{notice}</Text>}
          {footer}
        </Box>
      )
    }
    const thread = (action: 'resume' | 'start', tN: string) => act(`${action} ${tN}`, () => leanThread(host, $.plugin.root, { action, tN }))
    return (
      <Box flexDirection="column">
        {problems.length > 0 ? problemRows : noteRows}
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
              {a.rec.superseded ? '↻ brief superseded: ' : ''}
              {a.rec.from}: {short(a.rec.text, 70)}
            </Text>
            {a.unread && <Button key={`ack-${a.n}`} label="ack" onPress={act('ack', async () => ackRows(host, a.n))} />}
          </Box>
        ))}
        {!!v?.unread && <Button key="ack-all" label="ack all" onPress={act('ack', async () => ackRows(host, 'all'))} />}
        <Text bold>Projects</Text>
        {v && !v.projects.length && <Text dimColor>No projects registered.</Text>}
        {v?.projects.map(p => (
          <Text key={`p-${p.name}`}>
            {p.name} · {p.private ? 'private' : 'open'} · {p.threads} thread(s)
            {p.stale > 0 ? <Text color="yellow"> · {p.stale} rule area(s) stale</Text> : null}
          </Text>
        ))}
        {!!v && (
          <Text dimColor={!v.scripts.candidates && !v.scripts.adopted}>
            Scripts: {v.scripts.candidates} candidates, {v.scripts.adopted} adopted
          </Text>
        )}
        <Text bold>Threads</Text>
        {v && !v.threads.length && <Text dimColor>No open threads.</Text>}
        {v?.threads.map(t => (
          <Box key={`t-${t.id}`}>
            <Text>
              {t.id}{t.model ? ` · ${t.model}/${t.effort}` : ''} {short(t.title, 30)} [{t.run}] <Text dimColor>{short(t.last, 50)}</Text>
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
        <Button key="repair" label="Setup / repair" onPress={runSetup} />
        {setupRows}
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
// the role-dependent part of the pane: the desk opens it, a thread gets a status line; returns the timers' cancels
export async function paneRole($: any, role: { kind: string; id?: string }): Promise<Array<() => void>> {
  const cancels: Array<() => void> = []
  if (role.kind === 'desk') {
    await openPane($).catch(() => undefined)
    const t = $.clock.every(5_000, () => $.ui.invalidate('ui.render'))
    cancels.push(() => t.cancel())
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
    const t = $.clock.every(5_000, tick)
    cancels.push(() => t.cancel())
  }
  return cancels
}
