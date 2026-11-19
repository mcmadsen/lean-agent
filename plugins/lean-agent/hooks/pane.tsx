// The desk pane (design 2.5): goals, answers with ack, threads with Resume/Start, footer. Opens by itself only in the
// desk and through /lean-agent anywhere. Never blank: a failure is drawn as a red line. Resume/Start go through
// leanThread (the lean_thread tool), so the logic exists once.
import { ackRows, loadView, resetViewCache, threadStatus } from './view'
import { CONFIRM_MS, confirming, isOpen, patchUi, readUi, resetPaneUi } from './panestate'
import type { GoalTone, View } from './view'
import { leanThread } from './threads'
import { fmtUntil } from './limits'
import { scriptTool } from './scripts'
import { hostOf } from './host'
import { skillStat } from './skilltrim'
import { exportFeedback } from './feedbackexport'
import { NEXT_STEP, bounded, openDesk, setupCheck, setupFix, setupText } from './setup'
import type { Role } from './role'
import { contextSize, deskNote, kTokens, recentUser, restartDesk } from './deskcompact'

export const PANE = 'lean-agent'
export const VERSION = '1.0.7'
const ANSWERS_SHOWN = 5 // Answers: the newest rows drawn until "show all"
const GROUP_MIN = 8 // "show all" groups the rows by thread when there are more than this
const GROUP_ROWS = 20 // rows drawn in one unfolded group
const TONE: Record<GoalTone, string> = { working: 'green', waiting: 'yellow', stuck: 'red', quiet: 'gray' }

let lastError = ''
let lastRefresh = ''
let notice = ''
// setup state: the last doctor check (kept 30 s; any press drops it), the lines of the last fix, a press in flight
let chk: { at: number; problems: string[]; notes: string[]; mcp?: string[]; failed?: boolean } | null = null
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
  resetPaneUi()
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

  // /lean-agent-restart-desk: the desk's handover is written now and a new desk session is opened; desk only
  on('command.run', { command: 'lean-agent-restart-desk' }, async ($: any, e: any) => {
    if (roleOf().kind !== 'desk') return { text: 'This is not the desk: run /lean-agent-restart-desk in the desk session.' }
    try {
      const host = hostOf($)
      const r = await bounded($, restartDesk(host, { recent: () => recentUser($), open: () => openDesk(host, e?.surface) }), 'restart desk', 45_000)
      return { text: r.text }
    } catch (err) {
      return { text: `Restart desk failed: ${String((err as Error)?.message ?? err).slice(0, 200)}` }
    }
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

  // /lean-agent-feedback [notes]: ONE anonymised export file, written by the mod (no model turn, no network, never posts); any role
  on('command.run', { command: 'lean-agent-feedback' }, async ($: any, e: any) => {
    try {
      const o = await bounded($, exportFeedback(hostOf($), $.plugin.root, { notes: typeof e?.args === 'string' ? e.args : undefined, version: VERSION }), 'feedback export', 60_000)
      return { text: o.text }
    } catch (err) {
      return { text: `Feedback export failed: ${String((err as Error)?.message ?? err).slice(0, 200)}. Nothing was posted.` }
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
          chk = { at: now, problems: c.problems, notes: c.notes, mcp: c.mcp }
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
      chk = { at: await host.clock.now(), problems: o.problems, notes: o.notes, mcp: o.mcp }
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
    // an MCP server that needs a variable (a site, a domain): the pane has no text field, so it names what is missing and the desk asks
    const mcp = chk?.mcp ?? []
    const mcpBlock = mcp.length > 0 && (
      <Box flexDirection="column">
        <Text bold color="yellow">
          MCP servers that need a value
        </Text>
        {mcp.map((m, i) => (
          <Text key={`mcp-${i}`} color="yellow">
            {short(m, 160)}
          </Text>
        ))}
        <Text dimColor>Tell the desk: &quot;set NAME to ...&quot; (a site or domain, not a secret).</Text>
      </Box>
    )
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
          {mcpBlock}
          {setupRows}
          {!!notice && <Text color="yellow">{notice}</Text>}
          {footer}
        </Box>
      )
    }
    const thread = (action: 'resume' | 'start', tN: string) => act(`${action} ${tN}`, () => leanThread(host, $.plugin.root, { action, tN }))

    // ---- view state: folded sections, expanded rows, a pending confirm (kept in $.state, see panestate.ts) ----
    const ui = await readUi($)
    const tell = () => $.ui.invalidate('ui.render')
    const toggleSection = (name: string, dflt: boolean) => async () => {
      await patchUi($, u => ({ ...u, open: { ...u.open, [name]: !isOpen(u, name, dflt) } }))
      tell()
    }
    const toggleRow = (key: string) => async () => {
      await patchUi($, u => ({ ...u, rows: { ...u.rows, [key]: !u.rows[key] } }))
      tell()
    }
    const setMore = (more: boolean) => async () => {
      await patchUi($, u => ({ ...u, more }))
      tell()
    }
    const section = (name: string, label: string, dflt: boolean) => (
      <Button key={`sec-${name}`} plain label={`${isOpen(ui, name, dflt) ? '▾' : '▸'} ${label}`} onPress={toggleSection(name, dflt)} />
    )

    // ---- two-step confirm: the first press arms the button for CONFIRM_MS, the second does it ----
    const twoStep = (key: string, run: () => Promise<void>) => async () => {
      const t0 = await host.clock.now()
      const cur = await readUi($)
      if (!confirming(cur, key, t0)) {
        await patchUi($, u => ({ ...u, confirm: { key, until: t0 + CONFIRM_MS } }))
        tell()
        return
      }
      await patchUi($, u => ({ ...u, confirm: null }))
      await run()
    }
    // the second press looks again: nothing that is working now is closed (a close stops the session)
    const closeIds = async (ids: string[] | 'done') => {
      resetViewCache()
      const fresh = await loadView(host)
      const want = ids === 'done' ? fresh.threads.filter(t => t.done && !t.working && !t.needsYou) : fresh.threads.filter(t => ids.includes(t.id))
      const closed: string[] = []
      const skipped: string[] = []
      for (const t of want) {
        if (t.working || t.needsYou) {
          skipped.push(t.id)
          continue
        }
        const r = await leanThread(host, $.plugin.root, { action: 'close', tN: t.id })
        if (r.ok) closed.push(t.id)
        else skipped.push(`${t.id} (${short(r.text, 60)})`)
      }
      resetViewCache()
      notice = [closed.length ? `closed ${closed.join(', ')}` : '', skipped.length ? `not closed: ${skipped.join(', ')}` : '', !want.length ? 'nothing to close' : ''].filter(Boolean).join('; ')
      if (skipped.length) lastError = notice
      tell()
    }
    const closeOne = (id: string) => twoStep(`close:${id}`, () => closeIds([id]))
    // Restart: the session is stopped (a working one too) and a NEW one starts with the handover (threads.ts action restart)
    const restartOne = (id: string) =>
      twoStep(`restart:${id}`, async () => {
        resetViewCache()
        const r = await leanThread(host, $.plugin.root, { action: 'restart', tN: id })
        resetViewCache()
        notice = short(r.text, 200)
        if (!r.ok) lastError = notice
        tell()
      })
    // Restart desk: the handover is written now, then a new desk session is opened; this one stays until the user closes it
    const restartDeskPress = twoStep('restart:desk', async () => {
      resetViewCache()
      const r = await bounded($, restartDesk(host, { recent: () => recentUser($), open: () => openDesk(host, e.surface) }), 'restart desk', 45_000).catch(err => ({ ok: false, text: `restart desk failed: ${String((err as Error)?.message ?? err).slice(0, 160)}` }))
      notice = short(r.text, 200)
      if (!r.ok) lastError = notice
      tell()
    })
    const closeDone = twoStep('close:done', () => closeIds('done'))
    const reopen = (id: string) => act(`reopen ${id}`, () => leanThread(host, $.plugin.root, { action: 'reopen', tN: id }))
    // a script the auditor judged adopt that the mod's rules did not adopt on their own: the user's two presses decide (logged as the
    // user's decision; a secret or privacy finding is never adopted, whatever is pressed)
    // (the press is bound to the text that was shown: its sha256 is in the arm key and in the decision, so a script proposed again
    // under the same name between the two presses is refused, not adopted)
    const armKey = (w: { name: string; sha: string; update?: string }, verdict: 'adopt' | 'reject') => `script:${verdict}:${w.name}:${w.update ?? ''}:${w.sha.slice(0, 12)}`
    const scriptDecide = (w: { name: string; sha: string; update?: string }, verdict: 'adopt' | 'reject') =>
      twoStep(armKey(w, verdict), async () => {
        const r = await scriptTool(host, { kind: 'desk' }, { action: 'decide', name: w.name, verdict, sha: w.sha, reason: 'decided in the pane', confirm: true })
        resetViewCache()
        notice = short(r.text, 200)
        if (!r.ok) lastError = notice
        tell()
      })

    // threads whose last report is done and whose session is not working: what "Close all done" closes
    const doneThreads = (v?.threads ?? []).filter(t => t.done)
    const closable = doneThreads.filter(t => !t.working && !t.needsYou)
    const now2 = now

    // ---- answers: newest few; "show all" shows every row, grouped by thread when there are many ----
    const answers = v?.answers ?? []
    const ansOpen = isOpen(ui, 'answers', true)
    const answerRow = (a: (typeof answers)[number]) => {
      const ex = ui.rows[`a${a.n}`] === true
      return (
        <Box key={`a-${a.n}`} flexDirection="column">
          <Box>
            <Button
              key={`row-${a.n}`}
              plain
              dimColor={!a.unread}
              label={`${ex ? '▾' : '▸'} ${a.unread ? '● ' : ''}${a.rec.kind === 'ask' ? '? ' : ''}${a.rec.superseded ? '↻ ' : ''}${a.rec.from}: ${short(a.rec.text, 70)}`}
              onPress={toggleRow(`a${a.n}`)}
            />
            {a.unread && <Button key={`ack-${a.n}`} label="ack" onPress={act('ack', async () => ackRows(host, a.n))} />}
          </Box>
          {ex && (
            <Text>
              {a.rec.superseded ? '(brief superseded by a later user message) ' : ''}
              {a.rec.text}
              {a.rec.options?.length ? ` [options: ${a.rec.options.join(' | ')}]` : ''}
            </Text>
          )}
        </Box>
      )
    }
    const groups = (() => {
      const by = new Map<string, typeof answers>()
      for (const a of answers) by.set(a.rec.from, [...(by.get(a.rec.from) ?? []), a])
      // groups with something unread first, then the one with the newest row
      return [...by.entries()].sort(([, x], [, y]) => Number(y.some(a => a.unread)) - Number(x.some(a => a.unread)) || Math.max(...y.map(a => a.n)) - Math.max(...x.map(a => a.n)))
    })()
    const answerBody = !answers.length ? (
      <Text dimColor>Nothing from the threads yet.</Text>
    ) : !ui.more ? (
      <Box flexDirection="column">
        {answers.slice(0, ANSWERS_SHOWN).map(answerRow)}
        {answers.length > ANSWERS_SHOWN && <Button key="answers-more" plain label={`show all (${answers.length})`} onPress={setMore(true)} />}
      </Box>
    ) : answers.length <= GROUP_MIN ? (
      <Box flexDirection="column">
        {answers.map(answerRow)}
        <Button key="answers-less" plain label="show fewer" onPress={setMore(false)} />
      </Box>
    ) : (
      <Box flexDirection="column">
        {groups.map(([from, rows]) => {
          const unreadN = rows.filter(a => a.unread).length
          const gOpen = ui.rows[`g${from}`] === true
          const newest = rows.reduce((p, a) => (a.n > p.n ? a : p), rows[0]!)
          return (
            <Box key={`grp-${from}`} flexDirection="column">
              <Button key={`grp-btn-${from}`} plain label={`${gOpen ? '▾' : '▸'} ${from} (${rows.length}${unreadN ? `, ${unreadN} unread` : ''})`} onPress={toggleRow(`g${from}`)} />
              {gOpen ? rows.slice(0, GROUP_ROWS).map(answerRow) : <Text dimColor>{`    ${short(newest.rec.text, 70)}`}</Text>}
              {gOpen && rows.length > GROUP_ROWS && <Text dimColor>{`    (${rows.length - GROUP_ROWS} older not shown)`}</Text>}
            </Box>
          )
        })}
        <Button key="answers-less" plain label="show fewer" onPress={setMore(false)} />
      </Box>
    )
    const unreadLabel = v?.unread ? `, ${v.unread} unread` : ''
    return (
      <Box flexDirection="column">
        {problems.length > 0 ? problemRows : noteRows}
        {mcpBlock}
        {section('goals', `Goals (${v?.goals.length ?? 0})`, (v?.goals.length ?? 0) > 0)}
        {isOpen(ui, 'goals', (v?.goals.length ?? 0) > 0) && (
          <Box flexDirection="column">
            {v && !v.goals.length && <Text dimColor>No open goals.</Text>}
            {v?.goals.map(g => (
              <Text key={`g-${g.id}`} color={TONE[g.tone]}>
                {g.id} {g.tone}: {short(g.text)}
              </Text>
            ))}
          </Box>
        )}
        {section('answers', `Answers (${v?.total ?? 0}${unreadLabel})`, true)}
        {ansOpen && (
          <Box flexDirection="column">
            {v?.openQuestions.map(q => (
              <Text key={`q-${q.q}`} color="yellow">
                open ? {q.from ?? 'desk'}: {short(q.question ?? '', 70)}
              </Text>
            ))}
            {answerBody}
            {!!v?.unread && <Button key="ack-all" label="ack all" onPress={act('ack', async () => ackRows(host, 'all'))} />}
          </Box>
        )}
        {section('projects', `Projects (${v?.projects.length ?? 0})`, false)}
        {isOpen(ui, 'projects', false) && (
          <Box flexDirection="column">
            {v && !v.projects.length && <Text dimColor>No projects registered.</Text>}
            {v?.projects.map(p => (
              <Text key={`p-${p.name}`}>
                {p.name} · {p.private ? 'private' : 'open'} · {p.threads} thread(s)
                {p.stale > 0 ? <Text color="yellow"> · {p.stale} rule area(s) stale</Text> : null}
              </Text>
            ))}
          </Box>
        )}
        {!!v && (
          <Text dimColor={!v.scripts.candidates && !v.scripts.adopted} color={v.scripts.needsUpdate ? 'yellow' : undefined}>
            Scripts: {v.scripts.candidates} candidates, {v.scripts.adopted} adopted{v.scripts.needsUpdate ? `, ${v.scripts.needsUpdate} need an update` : ''}{v.scripts.waiting.length ? `, ${v.scripts.waiting.length} waiting for you` : ''}
          </Text>
        )}
        {v?.scripts.waiting.slice(0, 8).map(w => (
          <Box key={`sw-${w.name}-${w.update ?? ''}`}>
            <Text color="yellow">
              {w.name}{w.update ? ` ${w.update}` : ''} ({w.project}) waits for you: <Text dimColor>{short(w.why, 60)}</Text>
            </Text>
            <Button key={`sa-${w.name}`} label={confirming(ui, armKey(w, 'adopt'), now2) ? `Confirm adopt ${w.name}` : 'Adopt'} onPress={scriptDecide(w, 'adopt')} />
            <Button key={`sr-${w.name}`} label={confirming(ui, armKey(w, 'reject'), now2) ? `Confirm reject ${w.name}` : 'Reject'} onPress={scriptDecide(w, 'reject')} />
          </Box>
        ))}
        <Box>
          {section('threads', `Threads (${v?.threads.length ?? 0})`, true)}
          {doneThreads.length >= 2 && closable.length > 0 && (
            <Button key="close-done" label={confirming(ui, 'close:done', now2) ? `Confirm close all done (${closable.length})` : `Close all done (${closable.length})`} onPress={closeDone} />
          )}
        </Box>
        {isOpen(ui, 'threads', true) && (
          <Box flexDirection="column">
            {v && !v.threads.length && <Text dimColor>No open threads.</Text>}
            {v?.threads.map(t => (
              <Box key={`t-${t.id}`}>
                <Text>
                  {t.id}{t.model ? ` · ${t.model}/${t.effort}` : ''} {short(t.title, 30)} [{t.run}] <Text dimColor>{short(t.last, 50)}</Text>
                  {t.finished ? <Text dimColor> finished: next message starts a new session</Text> : null}
                  {t.needsYou ? <Text color="yellow"> needs you: open it in the app</Text> : null}
                  {t.pausedUntil ? <Text color="yellow"> paused until {fmtUntil(t.pausedUntil, now2)}</Text> : null}
                </Text>
                {t.resumable && <Button key={`resume-${t.id}`} label="Resume" onPress={thread('resume', t.id)} />}
                {t.resumable && <Button key={`start-${t.id}`} label="Start" onPress={thread('start', t.id)} />}
                {t.state === 'open' && (
                  <Button
                    key={`restart-${t.id}`}
                    label={confirming(ui, `restart:${t.id}`, now2) ? (t.working ? `Confirm restart ${t.id} (it is working: the current step is lost)` : `Confirm restart ${t.id}`) : 'Restart'}
                    onPress={restartOne(t.id)}
                  />
                )}
                {t.working || t.needsYou ? (
                  <Text dimColor>{t.needsYou ? 'waiting for you' : 'busy'}</Text>
                ) : (
                  <Button key={`close-${t.id}`} label={confirming(ui, `close:${t.id}`, now2) ? `Confirm close ${t.id}` : 'Close'} onPress={closeOne(t.id)} />
                )}
              </Box>
            ))}
          </Box>
        )}
        {section('closed', `Closed (${v?.closed.length ?? 0})`, false)}
        {isOpen(ui, 'closed', false) && (
          <Box flexDirection="column">
            {v && !v.closed.length && <Text dimColor>No closed threads.</Text>}
            {v?.closed.map(c => (
              <Box key={`c-${c.id}`}>
                <Text dimColor>
                  {c.id} {short(c.title, 30)} {short(c.last, 40)}
                </Text>
                <Button key={`reopen-${c.id}`} label="Reopen" onPress={reopen(c.id)} />
              </Box>
            ))}
          </Box>
        )}
        {errors.map((m, i) => (
          <Text key={`err-${i}`} color="red">
            error: {m}
          </Text>
        ))}
        <Box>
          <Button key="repair" label="Setup / repair" onPress={runSetup} />
          <Button key="restart-desk" label={confirming(ui, 'restart:desk', now2) ? 'Confirm restart desk (a new desk session opens, this one stays)' : 'Restart desk'} onPress={restartDeskPress} />
        </Box>
        {setupRows}
        {!!notice && !errors.includes(notice) && <Text color="yellow">{notice}</Text>}
        <Text dimColor>
          lean-agent {VERSION} · refreshed {lastRefresh || 'never'} · last error: {lastError || 'none'} · budget today: {v?.budget ?? 'n/a'}
          {contextSize() > 0 ? ` · desk context ${kTokens(contextSize())}` : ''}
        </Text>
        {!!deskNote() && <Text color="yellow">{deskNote()}</Text>}
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
