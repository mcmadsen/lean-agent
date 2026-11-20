// The desk pane. Top to bottom: the header (model chip, desk context against its limit, budget, version), "Needs you" (approvals,
// questions, reports ready to push, blocked threads, scripts waiting, the desk over its limit: each with its button on its card),
// one card per open thread, the inbox grouped by thread, goals, closed threads, More (projects, scripts), the footer actions.
// In the minimized widget form (e.props.placement 'widget') only a glance is drawn, with no button: clicks may not reach it.
// Opens by itself only in the desk and through /lean-agent anywhere. Never blank: a failure is drawn as a red line.
// Resume/Start/Restart/Close go through leanThread (the lean_thread tool), so the logic exists once.
import { OVER_PCT, READ_SHOWN, ackRows, loadView, resetViewCache, stateOf, threadStatus } from './view'
import { CONFIRM_MS, confirming, isOpen, patchUi, readUi, resetPaneUi } from './panestate'
import type { GoalTone, NeedRow, ThreadRow, View } from './view'
import { leanThread } from './threads'
import { fmtUntil } from './limits'
import { scriptTool } from './scripts'
import { hostOf } from './host'
import { skillStat } from './skilltrim'
import { exportFeedback } from './feedbackexport'
import { NEXT_STEP, bounded, openDesk, openThreadSession, setupCheck, setupFix, setupText } from './setup'
import type { Role } from './role'
import { kTokens, recentUser, restartDesk, sessionId } from './deskcompact'
import { openNewThread, openThreadPane } from './panelinks'
import { notifyTick } from './notify'

export const PANE = 'lean-agent'
export const VERSION = '1.0.11'
const NOTE_MS = 30_000 // the one-time "lean-agent set the model" line is drawn this long, then only the header chip carries it
const GROUP_ROWS = 20 // rows drawn in one unfolded inbox group
const NARROW = 50 // a body narrower than this (cells) gets the short forms
const TONE: Record<GoalTone, string> = { working: 'success', waiting: 'warning', stuck: 'error', quiet: 'inactive' }

let lastError = ''
let lastRefresh = ''
let notice = ''
const noteSeen = new Map<string, number>() // a model-change note -> when the pane first drew it
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
  noteSeen.clear()
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
      const r = await bounded($, restartDesk(host, { recent: () => recentUser($), sid: () => sessionId($), open: () => openDesk(host, e?.surface) }), 'restart desk', 45_000)
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
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
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
    const cols = Number(e.props?.bodyColumns) > 0 ? Number(e.props.bodyColumns) : 80
    const narrow = cols < NARROW
    // the minimized widget (desktop app): a glance, no button (clicks may not reach it), no setup check
    if (e.props?.placement === 'widget') {
      if (kind !== 'desk') {
        return (
          <Box flexDirection="column">
            <Text bold>lean-agent</Text>
            <Text dimColor>not the desk</Text>
          </Box>
        )
      }
      const th = v?.threads ?? []
      const working = th.filter(t => stateOf(t).word === 'working').length
      const stuck = th.filter(t => ['blocked', 'waiting', 'approval'].includes(stateOf(t).word)).length
      const needN = v?.needs.length ?? 0
      const dk = v?.desk
      const dpct = dk && dk.limit > 0 && dk.context > 0 ? `${Math.round((dk.context / dk.limit) * 100)}%` : 'n/a'
      return (
        <Box flexDirection="column">
          <Text bold>lean-agent</Text>
          <Text color={stuck ? 'error' : 'success'}>{`${working} running · ${stuck} blocked`}</Text>
          <Text color={needN ? 'warning' : undefined} dimColor={!needN}>{`${needN} need${needN === 1 ? 's' : ''} you`}</Text>
          <Text dimColor>{`desk context ${dpct} · today ${v?.spend ? `$${v.spend.today.toFixed(2)}` : 'n/a'}`}</Text>
          {errors.length > 0 && <Text color="error">{`error: ${short(errors[0]!, 60)}`}</Text>}
        </Box>
      )
    }
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
    // an inbox group: open by default when it has something unread; the press flips what is drawn now
    const toggleGroup = (from: string, dflt: boolean) => async () => {
      await patchUi($, u => ({ ...u, rows: { ...u.rows, [`g${from}`]: !(u.rows[`g${from}`] ?? dflt) } }))
      tell()
    }
    // a card's "Open" button: the thread's own detail pane (panelinks.ts)
    const openPaneOne = (id: string) => async () => {
      try {
        const r: any = await openThreadPane(host, e.surface, id)
        notice = r && typeof r.text === 'string' ? short(r.text, 200) : ''
        if (r && r.ok === false) lastError = notice
      } catch (err) {
        notice = lastError = `open ${id} failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`
      }
      tell()
    }
    const newThreadPress = async () => {
      try {
        const r: any = await openNewThread(host, e.surface)
        notice = r && typeof r.text === 'string' ? short(r.text, 200) : ''
        if (r && r.ok === false) lastError = notice
      } catch (err) {
        notice = lastError = `new thread failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`
      }
      tell()
    }
    // the anonymised feedback export (the /lean-agent-feedback command's function: one file, no network, never posts)
    const feedbackPress = async () => {
      try {
        const r = await bounded($, exportFeedback(host, $.plugin.root, { version: VERSION }), 'feedback export', 60_000)
        notice = short(r.text, 300)
        if (!r.ok) lastError = notice
      } catch (err) {
        notice = lastError = `Feedback export failed: ${String((err as Error)?.message ?? err).slice(0, 160)}. Nothing was posted.`
      }
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
    // Open tN: a thread blocked on an `approval` (Claude Code's permission check judges in the session that runs the command, and the
    // user's yes was given to the desk): its idle process is stopped (threads.ts action release), then the app's resume link opens the
    // thread's own session, where the user answers. One press: nothing is lost by it (an idle process only).
    const openOne = (id: string) => async () => {
      resetViewCache()
      const r = await bounded($, openThreadSession(host, id, () => leanThread(host, $.plugin.root, { action: 'release', tN: id }), e.surface), `open ${id}`, 60_000).catch(err => ({ ok: false, text: `open ${id} failed: ${String((err as Error)?.message ?? err).slice(0, 160)}` }))
      resetViewCache()
      notice = short(r.text, 200)
      if (!r.ok) lastError = notice
      tell()
    }
    // Restart desk: the handover is written now, then a new desk session is opened; this one stays until the user closes it
    const restartDeskPress = twoStep('restart:desk', async () => {
      resetViewCache()
      const r = await bounded($, restartDesk(host, { recent: () => recentUser($), sid: () => sessionId($), open: () => openDesk(host, e.surface) }), 'restart desk', 45_000).catch(err => ({ ok: false, text: `restart desk failed: ${String((err as Error)?.message ?? err).slice(0, 160)}` }))
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

    // ---- the inbox: grouped by thread, unread first, at most READ_SHOWN read rows per thread until "show all" ----
    // (read rows older than a week are not in `v.inbox`: archived, still in the inbox file)
    const inbox = v?.inbox ?? []
    const inboxOpen = isOpen(ui, 'inbox', true)
    type Row = (typeof inbox)[number]['unread'][number]
    const inboxRow = (a: Row) => {
      const ex = ui.rows[`a${a.n}`] === true
      return (
        <Box key={`a-${a.n}`} flexDirection="column">
          <Box flexWrap="wrap" columnGap={1}>
            <Button
              key={`row-${a.n}`}
              plain
              dimColor={!a.unread}
              label={`${ex ? '▾' : '▸'} ${a.unread ? '● ' : ''}${a.rec.kind === 'ask' ? '? ' : ''}${a.rec.superseded ? '↻ ' : ''}${short(a.rec.text, narrow ? 28 : 70)}`}
              onPress={toggleRow(`a${a.n}`)}
            />
            {a.unread && <Button key={`ack-${a.n}`} label="ack" onPress={act('ack', async () => ackRows(host, a.n))} />}
          </Box>
          {ex && (
            <Text wrap="wrap">
              {a.rec.superseded ? '(brief superseded by a later user message) ' : ''}
              {a.rec.text}
              {a.rec.options?.length ? ` [options: ${a.rec.options.join(' | ')}]` : ''}
            </Text>
          )}
        </Box>
      )
    }
    const inboxGroup = (g: (typeof inbox)[number]) => {
      const gOpen = ui.rows[`g${g.from}`] ?? g.unread.length > 0 // a thread with something unread is open, the others folded
      const all = ui.rows[`all${g.from}`] === true
      const shownRead = all ? g.read.slice(0, GROUP_ROWS) : g.read.slice(0, READ_SHOWN)
      const label = `${gOpen ? '▾' : '▸'} ${g.from}${g.title ? ` ${short(g.title, narrow ? 16 : 40)}` : ''} (${g.unread.length ? `${g.unread.length} unread${g.read.length ? `, ${g.read.length} read` : ''}` : `${g.read.length} read`})`
      const newest = [...g.unread, ...g.read].reduce((p, a) => (a.n > p.n ? a : p))
      return (
        <Box key={`grp-${g.from}`} flexDirection="column">
          <Button key={`grp-btn-${g.from}`} plain label={label} onPress={toggleGroup(g.from, g.unread.length > 0)} />
          {gOpen ? (
            <Box flexDirection="column">
              {g.unread.map(inboxRow)}
              {shownRead.map(inboxRow)}
              {g.read.length > READ_SHOWN && !all && <Button key={`answers-more-${g.from}`} plain label={`show all (${g.read.length} read)`} onPress={toggleRow(`all${g.from}`)} />}
              {all && g.read.length > READ_SHOWN && <Button key={`answers-less-${g.from}`} plain label="show fewer" onPress={toggleRow(`all${g.from}`)} />}
              {all && g.read.length > GROUP_ROWS && <Text dimColor>{`(${g.read.length - GROUP_ROWS} older not shown)`}</Text>}
            </Box>
          ) : (
            <Text dimColor>{`    ${short(newest.rec.text, narrow ? 28 : 70)}`}</Text>
          )}
        </Box>
      )
    }
    const unreadLabel = v?.unread ? `${v.unread} unread` : 'all read'
    // ---- Needs you: one card per thing that waits for the user, its button on the same card ----
    const needs = v?.needs ?? []
    const restartLabel = confirming(ui, 'restart:desk', now2) ? 'Confirm restart desk (a new desk session opens, this one stays)' : 'Restart desk'
    const needCard = (n: NeedRow) => {
      const tone = n.kind === 'blocked' ? 'error' : 'warning'
      const t = n.thread ? v?.threads.find(x => x.id === n.thread) : undefined
      const w = n.script
      return (
        <Box key={`need-${n.key}`} flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
          <Text color={tone} wrap="wrap">
            {n.text}
          </Text>
          <Box flexWrap="wrap" columnGap={1}>
            {n.kind === 'approval' && !!n.thread && (t?.working ? <Text dimColor>(it is working: wait until it stops)</Text> : <Button key={`open-${n.thread}`} label={`Open ${n.thread}`} onPress={openOne(n.thread)} />)}
            {(n.kind === 'question' || n.kind === 'push' || n.kind === 'blocked') && !!n.thread && <Button key={`pane-${n.thread}`} label="Open" onPress={openPaneOne(n.thread)} />}
            {!!w && <Button key={`sa-${w.name}`} label={confirming(ui, armKey(w, 'adopt'), now2) ? `Confirm adopt ${w.name}` : 'Adopt'} onPress={scriptDecide(w, 'adopt')} />}
            {!!w && <Button key={`sr-${w.name}`} label={confirming(ui, armKey(w, 'reject'), now2) ? `Confirm reject ${w.name}` : 'Reject'} onPress={scriptDecide(w, 'reject')} />}
            {n.kind === 'context' && <Button key="restart-desk-top" label={restartLabel} onPress={restartDeskPress} />}
          </Box>
        </Box>
      )
    }
    const needsBlock =
      needs.length > 0 ? (
        <Box flexDirection="column">
          <Text bold color="warning">{`Needs you (${needs.length})`}</Text>
          {needs.map(needCard)}
        </Box>
      ) : null

    // ---- a thread card: id and full title; one-word state with model, branch, review verdict and cost; the last report in one line; buttons ----
    const threadCard = (t: ThreadRow) => {
      const sc = stateOf(t)
      const quiet = sc.word === 'done' || sc.word === 'idle' || sc.word === 'parked'
      const review = t.review === 'green' ? { text: 'review green', color: 'success' } : t.review === 'red' ? { text: 'review not green', color: 'error' } : { text: 'no review', color: undefined }
      return (
        <Box key={`t-${t.id}`} flexDirection="column" borderStyle="round" borderColor={sc.color} borderDimColor={quiet} paddingX={1}>
          <Text bold wrap="wrap">
            {`${t.id} ${t.title}`}
          </Text>
          <Text wrap="wrap">
            {t.model ? <Text dimColor>{`${t.model}${t.effort ? `/${t.effort}` : ''} · `}</Text> : null}
            <Text bold color={sc.color}>{sc.word}</Text>
            {t.branch ? <Text dimColor>{` · ${t.branch}`}</Text> : null}
            <Text color={review.color} dimColor={!review.color}>{` · ${review.text}`}</Text>
            {t.cost > 0 ? <Text dimColor>{` · $${t.cost.toFixed(2)} today`}</Text> : null}
          </Text>
          {t.finished ? <Text dimColor>finished: next message starts a new session</Text> : null}
          {t.needsYou ? <Text color="warning">waiting for you: open it in the app</Text> : null}
          {t.pausedUntil ? <Text color="warning">{`paused until ${fmtUntil(t.pausedUntil, now2)}`}</Text> : null}
          <Text dimColor wrap="truncate-end">
            {short(t.lastReport, 200) || 'no report yet'}
          </Text>
          <Box flexWrap="wrap" columnGap={1}>
            <Button key={`view-${t.id}`} label="Open" onPress={openPaneOne(t.id)} />
            {t.resumable && <Button key={`resume-${t.id}`} label="Resume" onPress={thread('resume', t.id)} />}
            {t.resumable && <Button key={`start-${t.id}`} label="Start" onPress={thread('start', t.id)} />}
            {t.state === 'open' && (
              <Button
                key={`restart-${t.id}`}
                label={confirming(ui, `restart:${t.id}`, now2) ? (t.working ? `Confirm restart ${t.id} (it is working: the current step is lost)` : `Confirm restart ${t.id}`) : 'Restart'}
                onPress={restartOne(t.id)}
              />
            )}
            {!t.working && !t.needsYou && <Button key={`close-${t.id}`} label={confirming(ui, `close:${t.id}`, now2) ? `Confirm close ${t.id}` : 'Close'} onPress={closeOne(t.id)} />}
          </Box>
        </Box>
      )
    }

    // ---- header: the model chip, the desk's context against its limit, the budget, the version (small and dim) ----
    const desk = v?.desk
    const ctx = desk?.context ?? 0
    const limit = desk?.limit ?? 0
    const pct = limit > 0 ? Math.round((ctx / limit) * 100) : 0
    const overDesk = ctx > 0 && pct >= OVER_PCT
    const barColor = pct >= 100 ? 'error' : pct >= OVER_PCT ? 'warning' : 'success'
    // the one-time line "lean-agent set the model": drawn for NOTE_MS from its first draw, then the chip carries it
    const setNote = v?.deskModelSet ?? ''
    if (setNote && !noteSeen.has(setNote)) noteSeen.set(setNote, now2)
    const showSetNote = !!setNote && now2 - (noteSeen.get(setNote) ?? now2) < NOTE_MS
    const chip = desk?.model ? `${desk.model}${desk.effort ? `/${desk.effort}` : ''}${v?.deskModel ? ' ≠ pin' : setNote && !showSetNote ? ' (set by lean-agent)' : ''}` : ''
    const header = (
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap={1}>
          <Text bold>lean-agent</Text>
          {!!chip && (
            <Text key="chip" bold color={v?.deskModel ? 'warning' : 'claude'}>
              {`[${chip}]`}
            </Text>
          )}
          <Text key="budget" dimColor>
            {v?.spend ? `today $${v.spend.today.toFixed(2)} · 7d $${v.spend.week.toFixed(2)}` : 'budget n/a'}
          </Text>
        </Box>
        {/* the desk runs another model than its pin and the mod could not change it (deskmodel.ts): what to pick, at the top */}
        {!!v?.deskModel && <Text color="yellow">{v.deskModel}</Text>}
        {showSetNote && <Text dimColor>{setNote}</Text>}
        {ctx > 0 && limit > 0 ? (
          <Box flexWrap="wrap" columnGap={1}>
            <Progress key="ctx" label="desk context" value={ctx} max={limit} valueText={`${kTokens(ctx)} of ${kTokens(limit)}`} color={barColor} />
            {overDesk && <Button key="restart-desk" label={restartLabel} onPress={restartDeskPress} />}
          </Box>
        ) : (
          <Text dimColor>desk context: known after the next request</Text>
        )}
        <Text dimColor size="caption">
          lean-agent {VERSION} · refreshed {lastRefresh || 'never'}
          {lastError ? ` · last error: ${lastError}` : ''}
        </Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        {header}
        {problems.length > 0 ? problemRows : noteRows}
        {mcpBlock}
        {!!notice && !errors.includes(notice) && <Text color="yellow">{notice}</Text>}
        {errors.map((m, i) => (
          <Text key={`err-${i}`} color="red">
            error: {m}
          </Text>
        ))}
        {needsBlock}
        <Box flexWrap="wrap" columnGap={1}>
          {section('threads', `Threads (${v?.threads.length ?? 0})`, true)}
          {doneThreads.length >= 2 && closable.length > 0 && (
            <Button key="close-done" label={confirming(ui, 'close:done', now2) ? `Confirm close all done (${closable.length})` : `Close all done (${closable.length})`} onPress={closeDone} />
          )}
        </Box>
        {isOpen(ui, 'threads', true) && (
          <Box flexDirection="column">
            {v && !v.threads.length && <Text dimColor>No open threads.</Text>}
            {v?.threads.map(threadCard)}
          </Box>
        )}
        {section('inbox', `Inbox (${unreadLabel})`, true)}
        {inboxOpen && (
          <Box flexDirection="column">
            {!inbox.length && <Text dimColor>{v?.archived ? 'Nothing unread.' : 'Nothing from the threads yet.'}</Text>}
            {inbox.map(inboxGroup)}
            {!!v?.archived && <Text dimColor>{`${v.archived} read message(s) older than 7 days are archived (still in the inbox file)`}</Text>}
            {!!v?.unread && <Button key="ack-all" label="ack all" onPress={act('ack', async () => ackRows(host, 'all'))} />}
          </Box>
        )}
        {(v?.goals.length ?? 0) > 0 && section('goals', `Goals (${v?.goals.length ?? 0})`, true)}
        {(v?.goals.length ?? 0) > 0 && isOpen(ui, 'goals', true) && (
          <Box flexDirection="column">
            {v?.goals.map(g => (
              <Text key={`g-${g.id}`} color={TONE[g.tone]}>
                {g.id} {g.tone}: {short(g.text, narrow ? 40 : 90)}
              </Text>
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
        {section('more', `More (${v?.projects.length ?? 0} projects, ${(v?.scripts.candidates ?? 0) + (v?.scripts.adopted ?? 0)} scripts)`, false)}
        {isOpen(ui, 'more', false) && (
          <Box flexDirection="column">
            {v && !v.projects.length && <Text dimColor>No projects registered.</Text>}
            {v?.projects.map(p => (
              <Text key={`p-${p.name}`}>
                {p.name} · {p.private ? 'private' : 'open'} · {p.threads} thread(s)
                {p.stale > 0 ? <Text color="yellow"> · {p.stale} rule area(s) stale</Text> : null}
              </Text>
            ))}
            {!!v && (
              <Text dimColor={!v.scripts.candidates && !v.scripts.adopted} color={v.scripts.needsUpdate ? 'yellow' : undefined}>
                Scripts: {v.scripts.candidates} candidates, {v.scripts.adopted} adopted{v.scripts.needsUpdate ? `, ${v.scripts.needsUpdate} need an update` : ''}{v.scripts.waiting.length ? `, ${v.scripts.waiting.length} waiting for you` : ''}
              </Text>
            )}
          </Box>
        )}
        {setupRows}
        <Box flexWrap="wrap" columnGap={1}>
          <Button key="new-thread" label="New thread" onPress={newThreadPress} />
          <Button key="feedback" label="Feedback export" onPress={feedbackPress} />
          <Button key="repair" label="Setup / repair" onPress={runSetup} />
        </Box>
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
    // toasts for what needs the user and for done reports (notify.ts, no model); the first pass only records what is already there
    const tick = () => notifyTick(hostOf($), (text: string) => $.ui.toast(text)).then(() => undefined, () => undefined)
    void tick() // (not awaited: the session start must not wait for a second look at every thread)
    const n = $.clock.every(15_000, tick)
    cancels.push(() => n.cancel())
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
