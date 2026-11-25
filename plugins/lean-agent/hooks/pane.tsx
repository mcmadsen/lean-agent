// The desk pane (1.0.33: cards only, everything folded). EVERY block is a card (one border, one padding, the same fold) and nothing sits outside one: the header card
// (folded: ONE line "lean-agent · 1.2M tokens · window 1% · desk 37k/60k" with the fix chip and Restart desk), the Health card (findings, fixes, standing approvals, messages from
// senders without a thread), a notice card (the result of a press), the Sessions toolbar card (title, ack all; unfolded: the sort chips), ONE card per thread session (open, done
// or closed; folded = exactly two lines: title + state chip, then "N new", "N to decide", cost, context bar, age, Open), the "show more" card, More (goals, projects, scripts)
// and the actions card. Everything starts folded, a session that needs you too: only the user's tap unfolds (pane.foldAll false brings the old auto-unfold of a decision back).
// In the minimized widget form (e.props.placement 'widget') only a glance is drawn, with no button: clicks may not reach it.
// Opens by itself only in the desk and through /lean-agent anywhere. Never blank: a failure is drawn as a red line.
// Resume/Start/Restart/Close go through leanThread (the lean_thread tool), so the logic exists once.
import { ACTION_CARD_MAX, OVER_PCT, READ_SHOWN, ackRows, loadView, resetViewCache, stateOf, threadStatus } from './view'
import { CONFIRM_MS, confirming, isOpen, patchUi, readUi, resetPaneUi } from './panestate'
import type { ClosedRow, GoalTone, NeedRow, NoticeRow, ThreadRow, View } from './view'
import { leanThread } from './threads'
import { homeDir } from './state'
import { dismissedKeys, dkey, recordDismiss } from './dismissstore'
import type { DItem } from './dismissstore'
import { fmtUntil } from './limits'
import { scriptTool } from './scripts'
import { hostOf } from './host'
import { skillStat } from './skilltrim'
import { exportFeedback } from './feedbackexport'
import { destText, feedbackConfig } from './feedbackdest'
import { NEXT_STEP, bounded, infoOf, missingOf, openDesk, openThreadSession, setupCheck, setupFix, setupText } from './setup'
import type { Role } from './role'
import { kTokens, recentUser, restartingNow, sessionId, userRestartDesk } from './deskcompact'
import { noRestartNote, restartWaitMs } from './deskauto'
import { openNewThread, openThreadPane } from './panelinks'
import { notifyTick } from './notify'
// grantModelApproval is called from here and from nowhere else: only the user's press in this pane approves an expensive model (expensive.ts)
import { denyRequest, grantModelApproval, removeRequest } from './expensive'
import type { ModelRequest } from './expensive'
// answerAction is called from here and from the desk's AskUserQuestion hook (bindAnswers) and from nowhere else: only the user's press or the
// user's answer to the desk's question approves a thread's remote write (deskactions.ts)
import { answerAction, approveAction, revokeGrant, standingLabelOf } from './deskactions'
import { cancelHeld, sendHeldNow } from './sendhold'
import { revokeOwn, revokeWrites } from './deskwrites'
import { ARROW, SORTS, SORT_LABEL, ageText, canHide, capItems, effectiveDir, isHidden, itemsOf, paneConfig, readHidden, saveHidden, saveSort, saveSortDir, sortItems } from './panelist'
import type { Item, SortKey } from './panelist'
import { closedText, deskText, foldedText, headerText } from './formatusage'
import { healthSummary } from './panehealth'
import { setNotice } from './notices'
import { grantByHuman, paneLine, revokeSelfEdit } from './selfedit'
import { NARROW as NARROW_BRIEF, RETRY_LABEL, selfEditLabel } from './denial'
import type { ActionView } from './deskactions'

export const PANE = 'lean-agent'
export const VERSION = '1.0.33'
const NOTE_MS = 30_000 // the one-time "lean-agent set the model" line is drawn this long, then only the header chip carries it
const GROUP_ROWS = 20 // rows drawn in one unfolded inbox group
const NARROW = 50 // a body narrower than this (cells) gets the short forms
const TONE: Record<GoalTone, string> = { working: 'success', waiting: 'warning', stuck: 'error', quiet: 'inactive' }

let lastError = ''
let lastRefresh = ''
let notice = ''
const noteSeen = new Map<string, number>() // a model-change note -> when the pane first drew it
// setup state: the last doctor check (kept 30 s; any press drops it), the lines of the last fix, a press in flight
let chk: { at: number; problems: string[]; notes: string[]; info?: string[]; mcp?: string[]; failed?: boolean } | null = null
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

// The presses that DECIDE something, once (1.0.33): the desk pane's session cards and a thread's own pane (threadpane.tsx, handed this factory by register.tsx) draw
// different buttons but run the SAME code. They stay in this file on purpose: only the user's press in the pane approves (skills-contract.test.sh names the callers).
export type DecideEnv = {
  host: any
  root: string
  say: (text: string, bad: boolean) => void
  tell: () => void
  twoStep: (key: string, run: () => Promise<void>) => () => Promise<void>
}
export function makeDecisions(env: DecideEnv) {
  const { host, root, say: sayModel, tell, twoStep } = env
  // ---- a request for an expensive model (expensive.ts): Approve / Deny press twice; Start on sonnet instead starts it on the default ----
  const tellThread = (r: ModelRequest, text: string) => (r.thread === 'desk' ? Promise.resolve() : leanThread(host, root, { action: 'send', tN: r.thread, text, internal: true }).then(() => undefined, () => undefined))
  // the action that goes on after an approval or on sonnet: what a tool call asked for (a new thread is started now), nothing for a guard refusal
  const retryOf = (r: ModelRequest, model?: string) => ({ action: r.action === 'new' ? 'start' : r.action, tN: r.thread, ...(model ? { model } : r.asked ? { model: r.model, ...(r.effort ? { effort: r.effort } : {}) } : {}) })
  const approveModel = (r: ModelRequest) =>
    twoStep(`model:approve:${r.id}`, async () => {
      resetViewCache()
      try {
        await grantModelApproval(host, { scope: r.thread, model: r.model, reason: r.reason })
      } catch (err) {
        sayModel(`approve failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`, true)
        return tell()
      }
      await removeRequest(host, r.id)
      let said = `${r.thread === 'desk' ? 'the desk' : r.thread} may use ${r.family} (until it closes, at most 24 h)`
      if (r.origin === 'tool') {
        const out = await leanThread(host, root, retryOf(r) as any).catch(err => ({ ok: false, text: `${r.action} ${r.thread} failed: ${String((err as Error)?.message ?? err).slice(0, 120)}` }))
        said += `; ${out.text}`
        resetViewCache()
        sayModel(said, !out.ok)
      } else {
        await tellThread(r, `The user approved ${r.family} for this thread in the pane (until it closes, at most 24 h): you may retry what was refused.`)
        sayModel(`${said}; ${r.thread === 'desk' ? 'retry it' : `${r.thread} was told it may retry`}`, false)
      }
      tell()
    })
  const denyModel = (r: ModelRequest) =>
    twoStep(`model:deny:${r.id}`, async () => {
      await denyRequest(host, r.id)
      if (r.origin !== 'tool') await tellThread(r, `The user denied ${r.family} for this thread: do not retry it; go on without it or report.`)
      sayModel(`denied ${r.family} for ${r.thread === 'desk' ? 'the desk' : r.thread}`, false)
      tell()
    })
  const onSonnet = (r: ModelRequest) => async () => {
    resetViewCache()
    await removeRequest(host, r.id)
    const out = await leanThread(host, root, retryOf({ ...r, action: r.action === 'resume' ? 'restart' : r.action }, 'sonnet') as any).catch(err => ({ ok: false, text: `${r.action} ${r.thread} on sonnet failed: ${String((err as Error)?.message ?? err).slice(0, 120)}` }))
    resetViewCache()
    sayModel(out.text, !out.ok)
    tell()
  }
  const dismissModel = (r: ModelRequest) => async () => {
    await removeRequest(host, r.id)
    tell()
  }
  // ---- a thread's request for a remote write (deskactions.ts): the same decision as the desk's question, pressed twice. Approve sends it
  // at once (the mod, once, exactly the text on the card); Deny tells the thread. Nothing here is a model's call. ----
  const tellAction = (thread: string, text: string) => leanThread(host, root, { action: 'send', tN: thread, text, internal: true }).then(() => undefined)
  const approveWrite = (a: ActionView) =>
    twoStep(`action:approve:${a.id}`, async () => {
      resetViewCache()
      const said = a.state === 'approved' ? { ok: true, text: '' } : await answerAction(host, a.id, 'approve', 'pane', tellAction)
      if (!said.ok) {
        sayModel(said.text, true)
        return tell()
      }
      const out = await approveAction(host, a.id, tellAction)
      resetViewCache()
      sayModel(out.text, !out.ok)
      tell()
    })
  // the third choice (a status change only): the same human decision, and the mod stores the signed grant (deskactions.ts, inside answerAction only)
  const approveWriteStanding = (a: ActionView) =>
    twoStep(`action:standing:${a.id}`, async () => {
      resetViewCache()
      // a request already approved once (the plain Approve, in the dialog): the first answer wins, so it is sent once as approved and NO 24 h approval is made (and this says so)
      const already = a.state === 'approved'
      const said = already ? { ok: true, text: '' } : await answerAction(host, a.id, 'approve', 'pane', tellAction, true)
      if (!said.ok) {
        sayModel(said.text, true)
        return tell()
      }
      const out = await approveAction(host, a.id, tellAction)
      resetViewCache()
      sayModel(already ? `${out.text}; it had already been approved once with the plain Approve, so NO 24 h approval was made (the first answer wins): the thread's next request of this kind asks again` : `${out.text}; this kind of write on this ${a.kind.startsWith('ado-workitem') ? 'work item' : 'PR'} is allowed for 24 h (Revoke in the pane; your own approved send is not counted in its 40 writes)`, !out.ok)
      tell()
    })
  const revokeStanding = (grant: string) => async () => {
    resetViewCache()
    const out = await revokeGrant(host, grant)
    resetViewCache()
    sayModel(out.text, !out.ok)
    tell()
  }
  // the user's written approvals (deskwrites.ts): the pane's Revoke only takes power away
  const revokeWritten = (grant: string) => async () => {
    resetViewCache()
    const out = await revokeWrites(host, { id: grant })
    resetViewCache()
    sayModel(out.text, !out.ok)
    tell()
  }
  // a classifier denial has no prompt (denial.ts): the user's press here is a human answer the mod can trust, so it makes the same grant as the words do
  const selfEditPress = (id: string) => async () => {
    resetViewCache()
    const out = await grantByHuman(host, id, 'pane')
    if (out.ok) await leanThread(host, root, { action: 'send', tN: id, text: `[lean-agent] The user let you edit your worktree yourself (their choice in the pane). Do the step yourself with your own Edit / Write / Read / Grep / Glob inside your worktree, then continue and report.`, internal: true }).catch(() => undefined)
    resetViewCache()
    sayModel(out.text, !out.ok)
    tell()
  }
  const retryPress = (id: string) => async () => {
    resetViewCache()
    const out = await leanThread(host, root, { action: 'send', tN: id, text: `[lean-agent] The user chose: retry the worker with a narrower brief. ${NARROW_BRIEF}.`, internal: true }).catch(() => ({ ok: false, text: `retry ${id} failed` }))
    resetViewCache()
    sayModel(out.ok ? `${id} was told to retry with a narrower brief` : out.text, !out.ok)
    tell()
  }
  const revokeSelfEditPress = (grant: string) => async () => {
    resetViewCache()
    const out = await revokeSelfEdit(host, { id: grant })
    resetViewCache()
    sayModel(out.text, !out.ok)
    tell()
  }
  const denyWrite = (a: ActionView) =>
    twoStep(`action:deny:${a.id}`, async () => {
      resetViewCache()
      const out = await answerAction(host, a.id, 'deny', 'pane', tellAction)
      resetViewCache()
      sayModel(out.text, !out.ok)
      tell()
    })
  // ---- covered replies in their hold window (sendhold.ts): Send now sends the exact text at once, Cancel drops it and tells the thread no ----
  const holdNow = (id: string) => async () => {
    resetViewCache()
    await sendHeldNow(host, id)
    tell()
  }
  const holdCancel = (id: string) => async () => {
    resetViewCache()
    const out = await cancelHeld(host, id)
    const den = out.ok ? await answerAction(host, id, 'deny', 'pane', tellAction) : out
    resetViewCache()
    sayModel(den.ok ? out.text : den.text, !den.ok)
    tell()
  }
  return { approveModel, denyModel, onSonnet, dismissModel, approveWrite, approveWriteStanding, revokeStanding, revokeWritten, selfEditPress, retryPress, revokeSelfEditPress, denyWrite, holdNow, holdCancel }
}

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
      const r = await bounded($, userRestartDesk(host, { recent: () => recentUser($), sid: () => sessionId($), open: () => openDesk(host, e?.surface) }), 'restart desk', 45_000)
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
    // every block of the pane is a card (1.0.33): the same border and padding; `color` is the amber / red border, `dim` the quiet one (the default without a color)
    const cardProps = (o: { color?: string; dim?: boolean } = {}) => ({ flexDirection: 'column' as const, borderStyle: 'round' as const, borderColor: o.color, borderDimColor: o.dim ?? !o.color, paddingX: 1 })
    const card = (key: string, children: any, o: { color?: string; dim?: boolean } = {}) => (
      <Box key={key} {...cardProps(o)}>
        {children}
      </Box>
    )
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
      const stuck = th.filter(t => ['blocked', 'waiting', 'waiting for answer', 'approval', 'stuck', 'stalled'].includes(stateOf(t).word)).length
      const needN = v?.needs.length ?? 0
      const dk = v?.desk
      const dpct = dk && dk.limit > 0 && dk.context > 0 ? `${Math.round((dk.context / dk.limit) * 100)}%` : 'n/a'
      return (
        <Box flexDirection="column">
          <Text bold>lean-agent</Text>
          <Text color={stuck ? 'error' : 'success'}>{`${working} running · ${stuck} blocked`}</Text>
          <Text color={needN ? 'warning' : undefined} dimColor={!needN}>{`${needN} need${needN === 1 ? 's' : ''} you`}</Text>
          <Text dimColor>{`desk context ${dpct} · ${deskText(v?.spend)}`}</Text>
          {errors.length > 0 && <Text color="error">{`error: ${short(errors[0]!, 60)}`}</Text>}
        </Box>
      )
    }
    if (!chk || now - chk.at > CHECK_MS) {
      checking ??= (async () => {
        try {
          const c = await bounded($, setupCheck(host, $.plugin.root), 'check', 20_000)
          chk = { at: now, problems: c.problems, notes: c.notes, info: infoOf(c.checked), mcp: c.mcp }
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
    // "lean-agent is not set up" only when the setup itself is missing; everything else the doctor found is a finding (fix vs info)
    const missing = missingOf(problems)
    const fixes0 = [...problems.filter(p => !missing.includes(p)), ...notes]
    const info0 = chk?.info ?? []
    // Dismiss on a line at the top (a notice, a doctor finding, the plan-window line): one press, nothing was decided by it. The line is hidden
    // until its text changes (a doctor finding), the next threshold or the next day (a budget or plan-window alert). `show` brings them back.
    const homeP = await homeDir(host)
    const goneDesk = await dismissedKeys(host, homeP, ['desk']).catch(() => new Set<string>())
    const showHidden = (await readUi($)).rows.dismissed === true
    const isGone = (i: DItem) => goneDesk.has(dkey(i))
    const docId = (m: string): DItem => ({ thread: 'desk', kind: 'notice', id: `doctor:${m}` })
    // one row per fact (1.0.30): a doctor line about what the header or a notice already says is not shown a second time
    const deskRowShown = !!v && v.desk.limit > 0 && v.desk.context > 0 && Math.round((v.desk.context / v.desk.limit) * 100) >= OVER_PCT
    const oldDeskShown = (v?.notices ?? []).some(n => /old desk session/.test(n.text))
    const dupFact = (m: string) => (deskRowShown && /desk compaction|desk context|restart the desk/.test(m)) || (oldDeskShown && /old desk session/.test(m))
    const fixes = (showHidden ? fixes0 : fixes0.filter(m => !isGone(docId(m)))).filter(m => !dupFact(m))
    const info = (showHidden ? info0 : info0.filter(m => !isGone(docId(m)))).filter(m => !dupFact(m))
    const dismissLine = (items: DItem[]) => async () => {
      try {
        for (const i of items) await recordDismiss(host, homeP, i, i.id.slice(i.id.indexOf(':') + 1))
      } catch (err) {
        notice = lastError = `dismiss failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`
      }
      resetViewCache()
      $.ui.invalidate('ui.render')
    }
    const clearNotice = async () => {
      notice = ''
      lastError = ''
      $.ui.invalidate('ui.render')
    }
    // the plan-window line is an alert only from 80 %: dismissed until a window crosses the next level or the day ends
    const winLevels = (v?.window ?? '').match(/\d+(?=%)/g)?.map(p => (Number(p) >= 90 ? 90 : Number(p) >= 80 ? 80 : 0)) ?? []
    const winId: DItem = { thread: 'desk', kind: 'notice', id: `window:${new Date(now).toISOString().slice(0, 10)}:${winLevels.join(',')}` }
    const winAlert = winLevels.some(l => l > 0)
    const winGone = winAlert && isGone(winId)
    const localHidden = fixes0.filter(m => isGone(docId(m))).length + info0.filter(m => isGone(docId(m))).length + (winGone ? 1 : 0)
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
      chk = { at: await host.clock.now(), problems: o.problems, notes: o.notes, info: infoOf(o.checked), mcp: o.mcp }
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
    // what the doctor found beyond the setup, in a session that is not the desk: "Doctor: N findings (F fix)", the fix rows red, the info rows dim; Run fix only when
    // something needs a fix. (The desk draws the same findings in its Health card, one line each, see below.)
    const nFindings = fixes.length + info.length
    const doctorRows =
      nFindings > 0 ? (
        <Box flexDirection="column">
          <Box flexWrap="wrap" columnGap={1}>
            <Text bold color={fixes.length ? 'warning' : undefined}>{`Doctor: ${nFindings} finding${nFindings === 1 ? '' : 's'} (${fixes.length} fix)`}</Text>
            {fixes.length > 0 && <Button key="doctor-fix" label="Run fix" onPress={runSetup} />}
            <Button key="doctor-dismiss" label="Dismiss" onPress={dismissLine([...fixes, ...info].filter(m => !isGone(docId(m))).map(docId))} />
          </Box>
          {fixes.map((m, i) => (
            <Text key={`df-${i}`} color="error">
              {short(m, 160)}
            </Text>
          ))}
          {info.map((m, i) => (
            <Text key={`di-${i}`} dimColor>
              {short(m, 160)}
            </Text>
          ))}
        </Box>
      ) : null
    if (kind !== 'desk') {
      // a session that is not the desk: setup first (or the way to the desk), the desk's own view only in the desk
      // (1.0.33: every block is a card here too)
      return (
        <Box flexDirection="column">
          {missing.length > 0
            ? card('setup', problemRows, { color: 'warning' })
            : (
                <Box key="not-desk" {...cardProps()}>
                  <Text bold>This is not the desk</Text>
                  {doctorRows}
                  <Text>{NEXT_STEP}</Text>
                  <Box>
                    <Button key="open-desk" label="Open desk" onPress={openIt} />
                    <Button key="rerun-setup" label="Re-run setup" onPress={runSetup} />
                  </Box>
                </Box>
              )}
          {mcp.length > 0 ? card('mcp', mcpBlock, { color: 'warning' }) : null}
          {setupRows.length > 0 ? card('setup-rows', setupRows) : null}
          {!!notice ? card('notice', <Text color="yellow">{notice}</Text>, { color: 'warning' }) : null}
          {card('footer', footer)}
        </Box>
      )
    }
    const thread = (action: 'resume' | 'start', tN: string) => act(`${action} ${tN}`, () => leanThread(host, $.plugin.root, { action, tN }))

    // ---- view state: folded sections, expanded rows, a pending confirm (kept in $.state, see panestate.ts) ----
    const ui = await readUi($)
    const cfgPane = await paneConfig(host) // pane.sort, pane.maxSessions, pane.healthOpen
    const tell = () => $.ui.invalidate('ui.render')
    const toggleSection = (name: string, dflt: boolean) => async () => {
      await patchUi($, u => ({ ...u, open: { ...u.open, [name]: !isOpen(u, name, dflt) } }))
      tell()
    }
    const toggleRow = (key: string) => async () => {
      await patchUi($, u => ({ ...u, rows: { ...u.rows, [key]: !u.rows[key] } }))
      tell()
    }
    // a cardless inbox group: folded by default (dflt); the press flips what is drawn now
    const toggleGroup = (from: string, dflt: boolean) => async () => {
      await patchUi($, u => ({ ...u, rows: { ...u.rows, [`g${from}`]: !(u.rows[`g${from}`] ?? dflt) } }))
      tell()
    }
    // a card's "Open" button: the thread's own detail pane (panelinks.ts)
    const openPaneOne = (id: string) => async () => {
      try {
        const r: any = await openThreadPane($, e.surface, id)
        notice = r && typeof r.text === 'string' ? short(r.text, 200) : ''
        if (r && r.ok === false) lastError = notice
      } catch (err) {
        notice = lastError = `open ${id} failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`
      }
      tell()
    }
    const newThreadPress = async () => {
      try {
        const r: any = await openNewThread($, e.surface)
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
    // the title button of a foldable card: one line, cut with an ellipsis so the chips beside it stay on the line (`beside` = cells the rest of the line needs)
    const foldTitle = (name: string, label: string, dflt: boolean, beside = 0, dim = false) => (
      <Button key={`sec-${name}`} plain dimColor={dim} label={short(`${isOpen(ui, name, dflt) ? '▾' : '▸'} ${label}`, Math.max(14, cols - 4 - beside))} onPress={toggleSection(name, dflt)} />
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
    // Dismiss on a Needs-you card (two presses): the user acknowledged THIS item (dismissstore.ts: who/when/what in the history, nobody is told);
    // the card goes until a NEWER item of its kind arrives, the record behind it stays. One mechanism for every kind of card.
    const dismissCard = (n: NeedRow) =>
      twoStep(`dismiss:${n.key}`, async () => {
        try {
          await recordDismiss(host, await homeDir(host), n.dk!, n.text)
          notice = `dismissed: ${short(n.text, 100)} (a newer one will show again)`
        } catch (err) {
          notice = lastError = `dismiss failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`
        }
        resetViewCache()
        tell()
      })
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
    // (1.0.33: one tap, no second confirm; the answer is a notice card. The 30 min gap and the per-day count are for automatic restarts only: userRestartDesk keeps the 60 s floor)
    const restartDeskPress = async () => {
      resetViewCache()
      const run = bounded($, userRestartDesk(host, { recent: () => recentUser($), sid: () => sessionId($), open: () => openDesk(host, e.surface) }), 'restart desk', 45_000).catch(err => ({ ok: false, text: `restart desk failed: ${String((err as Error)?.message ?? err).slice(0, 160)}` }))
      tell() // (the pane draws "restarting…" while it runs)
      const r = await run
      notice = short(r.text, 200)
      if (!r.ok) lastError = notice
      tell()
    }
    const closeDone = twoStep('close:done', () => closeIds('done'))
    // ---- a request for an expensive model (expensive.ts): Approve / Deny press twice; Start on sonnet instead starts it on the default ----
    const sayModel = (text: string, bad: boolean) => {
      notice = short(text, 300)
      if (bad) lastError = notice
    }
    // the presses that decide something live once, above (makeDecisions): the same code runs from a thread's own pane
    const { approveModel, denyModel, onSonnet, dismissModel, approveWrite, approveWriteStanding, revokeStanding, revokeWritten, selfEditPress, retryPress, revokeSelfEditPress, denyWrite, holdNow, holdCancel } = makeDecisions({ host, root: $.plugin.root, say: sayModel, tell, twoStep })
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
    // 1.0.32: there is no global inbox: a message is on the card of the thread it came from (open, done or closed: every thread is a row of the list);
    // only senders without a thread (the desk, the mod, an unknown id) are drawn in the Health card
    const cardIds = new Set([...(v?.threads ?? []).map(t => t.id), ...(v?.closed ?? []).map(c => c.id)])
    const inboxOf = new Map(inbox.map(g => [g.from, g] as const))
    const cardless = inbox.filter(g => !cardIds.has(g.from))
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
    // one thread's rows, as drawn when unfolded (a card's inbox part and a cardless group): unread first, then up to READ_SHOWN read, "show all", capped at GROUP_ROWS
    const inboxRows = (g: (typeof inbox)[number]) => {
      const all = ui.rows[`all${g.from}`] === true
      const unreadShown = g.unread.slice(0, GROUP_ROWS)
      const shownRead = all ? g.read.slice(0, Math.max(0, GROUP_ROWS - unreadShown.length)) : g.read.slice(0, READ_SHOWN)
      return (
        <Box flexDirection="column">
          {unreadShown.map(inboxRow)}
          {shownRead.map(inboxRow)}
          {g.read.length > READ_SHOWN && !all && <Button key={`answers-more-${g.from}`} plain label={`show all (${g.read.length} read)`} onPress={toggleRow(`all${g.from}`)} />}
          {all && g.read.length > READ_SHOWN && <Button key={`answers-less-${g.from}`} plain label="show fewer" onPress={toggleRow(`all${g.from}`)} />}
          {g.unread.length > GROUP_ROWS && <Text dimColor>{`(${g.unread.length - GROUP_ROWS} older unread not shown)`}</Text>}
          {all && g.read.length > shownRead.length && <Text dimColor>{`(${g.read.length - shownRead.length} older not shown)`}</Text>}
        </Box>
      )
    }
    const inboxGroup = (g: (typeof inbox)[number]) => {
      const gOpen = ui.rows[`g${g.from}`] ?? false // folded by default, even with something unread: the header carries the unread count
      const label = `${gOpen ? '▾' : '▸'} ${g.from}${g.title ? ` ${short(g.title, narrow ? 16 : 40)}` : ''} (${g.unread.length ? `${g.unread.length} unread${g.read.length ? `, ${g.read.length} read` : ''}` : `${g.read.length} read`})`
      const newest = [...g.unread, ...g.read].reduce((p, a) => (a.n > p.n ? a : p))
      return (
        <Box key={`grp-${g.from}`} flexDirection="column">
          <Button key={`grp-btn-${g.from}`} plain label={label} onPress={toggleGroup(g.from, false)} />
          {gOpen ? (
            inboxRows(g)
          ) : (
            <Text dimColor>{`    ${short(newest.rec.text, narrow ? 28 : 70)}`}</Text>
          )}
        </Box>
      )
    }
    // ---- Needs you: one card per thing that waits for the user, its button on the same card (1.0.32: on the thread's own card, or in Health) ----
    const needs = v?.needs ?? []
    // the footer action names where the export goes (config.json feedback.destination); the default (local) keeps the plain label
    const fbCfg = await feedbackConfig(host, homeP).catch(() => null)
    const feedbackLabel = fbCfg && fbCfg.dest !== 'local' ? `Feedback export (${destText(fbCfg)})` : 'Feedback export'
    // "N dismissed" and its "show" toggle: the dismissed items are not counted above; show brings them back into this view (dim, no buttons)
    const dismissedRows = v?.dismissed ?? []
    const dismissedN = dismissedRows.length + (v?.dismissedNotices.length ?? 0) + localHidden
    const dismissLine_ =
      dismissedN > 0 ? (
        <Box key="dismissed-line" flexWrap="wrap" columnGap={1}>
          <Text dimColor>{`${dismissedN} dismissed`}</Text>
          <Button key="dismissed-toggle" plain label={showHidden ? 'hide' : 'show'} onPress={toggleRow('dismissed')} />
        </Box>
      ) : null
    // `nested`: drawn inside its thread's unfolded card, whose line 2 already has Open tN (one button of that key)
    const needCard = (n: NeedRow, hidden = false, nested = false) => {
      if (hidden)
        return (
          <Box key={`need-${n.key}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor wrap="wrap">{`${n.text} (dismissed: a newer one will show again)`}</Text>
          </Box>
        )
      // red only when something is broken (a blocked thread, the desk's model); amber is the label and the chip, the body is the normal text color
      const tone = n.kind === 'blocked' && !n.key.startsWith('waiting:') ? 'error' : n.kind === 'deskmodel' ? 'error' : 'warning'
      const chipText = n.kind === 'question' ? 'question' : n.kind === 'push' ? 'ready to push' : n.kind === 'stalled' ? 'stalled' : n.kind === 'deskmodel' ? 'desk model' : n.kind === 'denial' || (n.kind === 'blocked' && !n.key.startsWith('waiting:')) ? 'blocked' : 'needs you'
      const t = n.thread ? v?.threads.find(x => x.id === n.thread) : undefined
      const w = n.script
      const mr = n.request
      const ar = n.action
      return (
        <Box key={`need-${n.key}`} flexDirection="column" borderStyle="round" borderColor={tone} borderDimColor paddingX={1}>
          <Box flexWrap="wrap" columnGap={1}>
            <Text bold color={tone}>{`[${chipText}]`}</Text>
            {n.kind === 'approval' && !!n.thread && !nested && (t?.working ? <Text dimColor>(it is working: wait until it stops)</Text> : <Button key={`open-${n.thread}`} label={`Open ${n.thread}`} onPress={openOne(n.thread)} />)}
            {n.kind === 'denial' && !!n.thread && <Button key={`denial-self-${n.thread}`} label={selfEditLabel(n.thread)} onPress={selfEditPress(n.thread)} />}
            {n.kind === 'denial' && !!n.thread && <Button key={`denial-retry-${n.thread}`} label={RETRY_LABEL} onPress={retryPress(n.thread)} />}
            {(n.kind === 'question' || n.kind === 'push' || n.kind === 'blocked') && !!n.thread && <Button key={`pane-${n.thread}`} label="Open" onPress={openPaneOne(n.thread)} />}
            {!!w && <Button key={`sa-${w.name}`} label={confirming(ui, armKey(w, 'adopt'), now2) ? `Confirm adopt ${w.name}` : 'Adopt'} onPress={scriptDecide(w, 'adopt')} />}
            {!!w && <Button key={`sr-${w.name}`} label={confirming(ui, armKey(w, 'reject'), now2) ? `Confirm reject ${w.name}` : 'Reject'} onPress={scriptDecide(w, 'reject')} />}
            {!!mr && mr.state === 'pending' && <Button key={`model-approve-${mr.id}`} label={confirming(ui, `model:approve:${mr.id}`, now2) ? `Confirm approve ${mr.family} for ${mr.thread}` : 'Approve'} onPress={approveModel(mr)} />}
            {!!mr && mr.state === 'pending' && <Button key={`model-deny-${mr.id}`} label={confirming(ui, `model:deny:${mr.id}`, now2) ? `Confirm deny ${mr.family}` : 'Deny'} onPress={denyModel(mr)} />}
            {!!mr && mr.origin === 'tool' && <Button key={`model-sonnet-${mr.id}`} label="Start on sonnet instead" onPress={onSonnet(mr)} />}
            {!!mr && mr.state === 'denied' && <Button key={`model-dismiss-${mr.id}`} label="Dismiss" onPress={dismissModel(mr)} />}
            {n.kind === 'model' && !!n.thread && <Button key={`pane-${n.thread}`} label="Open" onPress={openPaneOne(n.thread)} />}
            {!!ar && !(ar.state === 'pending' && ar.text.length > ACTION_CARD_MAX) && <Button key={`action-approve-${ar.id}`} label={confirming(ui, `action:approve:${ar.id}`, now2) ? `Confirm: send this text for ${ar.thread}` : ar.state === 'approved' ? 'Send now' : 'Approve'} onPress={approveWrite(ar)} />}
            {!!ar && ar.state === 'pending' && !!ar.standing && !(ar.text.length > ACTION_CARD_MAX) && <Button key={`action-standing-${ar.id}`} label={confirming(ui, `action:standing:${ar.id}`, now2) ? `Confirm: ${standingLabelOf(ar.kind).replace(/^Approve/, 'send')}` : standingLabelOf(ar.kind)} onPress={approveWriteStanding(ar)} />}
            {!!ar && ar.state === 'pending' && <Button key={`action-deny-${ar.id}`} label={confirming(ui, `action:deny:${ar.id}`, now2) ? `Confirm deny for ${ar.thread}` : 'Deny'} onPress={denyWrite(ar)} />}
            {!!ar && !!n.thread && <Button key={`pane-${n.thread}`} label="Open" onPress={openPaneOne(n.thread)} />}
            {n.kind === 'stalled' && !!n.thread && <Button key={`pane-${n.thread}`} label="Open" onPress={openPaneOne(n.thread)} />}
            {!!n.dk && !(mr && mr.state === 'denied') && <Button key={`dismiss-${n.dk.thread}-${n.dk.kind}${['model', 'action', 'script'].includes(n.dk.kind) ? `-${n.dk.id.split(':')[0]}` : ''}`} label={confirming(ui, `dismiss:${n.key}`, now2) ? `Confirm dismiss ${n.thread ?? 'it'}` : 'Dismiss'} onPress={dismissCard(n)} />}
          </Box>
          <Text wrap="wrap">{n.text}</Text>
          {!!ar && ar.state === 'pending' && ar.items && ar.items.length > 0 && reviewLines(ar)}
          {!!ar && ar.state === 'pending' && ar.text.length > ACTION_CARD_MAX && <Text color="warning" wrap="wrap">{`Approve in the desk question: this card cannot approve it (${ar.text.length} characters, the question shows all of it).`}</Text>}
          {!!ar && ar.state === 'pending' && (ar.items?.length || ar.text.length > ACTION_CARD_MAX) ? <Button key={`action-full-${ar.id}`} plain label={ui.rows[`full${ar.id}`] ? 'hide full text' : 'show full text'} onPress={toggleRow(`full${ar.id}`)} /> : null}
          {!!ar && ar.state === 'pending' && ui.rows[`full${ar.id}`] === true && <Text wrap="wrap">{ar.text}</Text>}
        </Box>
      )
    }
    // a review batch (1.0.29 data): the comments numbered, grouped by file, each one line (anchor + the first 120 characters)
    const reviewLines = (a: ActionView) => {
      const groups = new Map<string, NonNullable<ActionView['items']>>()
      for (const it of a.items ?? []) groups.set(it.file, [...(groups.get(it.file) ?? []), it])
      return [...groups].map(([file, list]) => (
        <Box key={`ri-${a.id}-${file}`} flexDirection="column">
          <Text bold>{`${file || 'General comments (no file)'} (${list.length})`}</Text>
          {list.map(it => (
            <Text key={`ri-${a.id}-${it.n}`} wrap="wrap">{`  ${it.n}. ${it.where}: ${short(it.text, 120)}`}</Text>
          ))}
        </Box>
      ))
    }
    // ---- covered replies in their hold window (sendhold.ts): the exact text, the countdown, Send now and Cancel ----
    // (1.0.32: each hold is drawn on its thread's card, which is unfolded while the hold lasts)
    const holdsOf = (id: string) => (v?.holds ?? []).filter(x => x.thread === id)
    const holdRows = (id: string) =>
      holdsOf(id).map(x => (
        <Box key={`hold-${x.id}`} flexWrap="wrap" columnGap={1}>
          <Text color="yellow" wrap="wrap">{`${x.thread}: goes out in ${Math.max(0, Math.ceil((x.until - Date.now()) / 1000))} s: ${x.text}`}</Text>
          <Button key={`hold-now-${x.id}`} label="Send now" onPress={holdNow(x.id)} />
          <Button key={`hold-cancel-${x.id}`} label="Cancel" onPress={holdCancel(x.id)} />
        </Box>
      ))
    // ---- the user's standing approvals (deskactions.ts): what the mod sent under one, and the grants still active, each with a Revoke button ----
    const stand = v?.standing
    const sentGrants = new Set((stand?.sent ?? []).map(s => s.grant).filter(Boolean))
    const standingBlock =
      stand && (stand.sent.length > 0 || stand.grants.length > 0) ? (
        <Box key="standing-approvals" flexDirection="column">
          {stand.sent.map(s => (
            <Box key={`std-sent-${s.ts}-${s.thread}`} flexWrap="wrap" columnGap={1}>
              <Text wrap="wrap">{`${s.thread}: ${s.text}`}</Text>
              {!!s.grant && <Button key={`std-revoke-${s.grant}-${s.ts}`} label="Revoke" onPress={revokeStanding(s.grant)} />}
            </Box>
          ))}
          {stand.grants.filter(g => !sentGrants.has(g.id)).map(g => (
            <Box key={`std-grant-${g.id}`} flexWrap="wrap" columnGap={1}>
              <Text dimColor wrap="wrap">{`${g.thread}: standing approval for status changes on ${g.scope.replace(/^(Azure DevOps|GitHub) /, '')} until ${new Date(g.exp).toISOString().slice(11, 16)} UTC`}</Text>
              <Button key={`std-revoke-${g.id}`} label="Revoke" onPress={revokeStanding(g.id)} />
            </Box>
          ))}
        </Box>
      ) : null
    // ---- the user's written approvals (deskwrites.ts): each write sent under one with its exact text, and the grants still live, each with Revoke ----
    const wr = v?.writes
    const wrSent = new Set((wr?.sent ?? []).map(s => s.grant).filter(Boolean))
    const writtenBlock =
      wr && (wr.sent.length > 0 || wr.grants.length > 0) ? (
        <Box key="written-approvals" flexDirection="column">
          {wr.sent.map(s => (
            <Box key={`wr-sent-${s.ts}-${s.thread}`} flexWrap="wrap" columnGap={1}>
              <Text wrap="wrap">{`${s.thread}: ${s.text}`}</Text>
              {!!s.grant && <Button key={`wr-revoke-${s.grant}-${s.ts}`} label="Revoke" onPress={revokeWritten(s.grant)} />}
            </Box>
          ))}
          {wr.grants.filter(g => !wrSent.has(g.id)).map(g => (
            <Box key={`wr-grant-${g.id}`} flexWrap="wrap" columnGap={1}>
              <Text dimColor wrap="wrap">{`${g.thread}: your instruction '${g.quote.slice(0, 80)}' allows ${g.kinds.join(', ')} on ${g.scope.replace(/^(Azure DevOps|GitHub) /, '')} (${g.used}/${g.cap} writes) until ${new Date(g.exp).toISOString().slice(11, 16)} UTC`}</Text>
              <Button key={`wr-revoke-${g.id}`} label="Revoke" onPress={revokeWritten(g.id)} />
            </Box>
          ))}
        </Box>
      ) : null
    // ---- the threads the user let edit their worktree themselves (selfedit.ts): the user's words, and a Revoke button ----
    const se = v?.selfEdit
    const selfEditBlock =
      se && se.grants.length > 0 ? (
        <Box key="self-edit-grants" flexDirection="column">
          {se.grants.map(g => (
            <Box key={`se-grant-${g.id}`} flexWrap="wrap" columnGap={1}>
              <Text dimColor wrap="wrap">{`${paneLine(g)} until ${new Date(g.exp).toISOString().slice(11, 16)} UTC`}</Text>
              <Button key={`se-revoke-${g.id}`} label="Revoke" onPress={revokeSelfEditPress(g.id)} />
            </Box>
          ))}
        </Box>
      ) : null

    // ---- the session list (1.0.33): EVERY session is a card (open, done or closed), all folded on startup; only the user's tap unfolds one ----
    // A folded card is exactly two lines, the same for every state: line 1 = title (cut with an ellipsis, one line) + the state chip; line 2 = "N new", "N to decide",
    // cost, a small context bar (a working / waiting thread), the age of its last activity, and Open at the right end. Unfolded: the rest (last report, the decisions as
    // nested cards, buttons, messages). A decision to take (Approve / Deny, a held send) does NOT unfold its card: the "N to decide" chip says it (pane.foldAll false
    // brings the old auto-unfold back).
    const expanded = (id: string) => ui.rows[`x${id}`] === true
    const toggleCard = (id: string) => toggleRow(`x${id}`)
    const showMessages = (id: string) => async () => {
      await patchUi($, u => ({ ...u, rows: { ...u.rows, [`x${id}`]: true, [`inb${id}`]: true } }))
      tell()
    }
    // a tap on another sort chip changes the sort; a tap on the ACTIVE chip (or on the direction chip) flips the direction (the choice is then explicit: asc or desc)
    const flipDir = async () => {
      await saveSortDir(host, effectiveDir(cfgPane) === 'asc' ? 'desc' : 'asc')
      tell()
    }
    const sortPress = (k: SortKey) => async () => {
      if (k === cfgPane.sort) return flipDir()
      await saveSort(host, k)
      tell()
    }
    // Hide / Unhide (1.0.33): a completed session (done or closed) the user hides is only drawn again when it is no longer completed or has something unread or waiting; nothing is
    // closed or deleted. The set is kept in the mod's store (panelist.ts). `itemById` and `hiddenIds` are set below, where the list is built.
    const hidePress = (id: string, hide: boolean) => async () => {
      const at = itemById.get(id)?.activity ?? 0
      await saveHidden(host, cur => {
        const next = { ...cur }
        if (hide) next[id] = at
        else delete next[id]
        return next
      })
      tell()
    }
    const hideCtl = (id: string) => {
      const i = itemById.get(id)
      const un = hiddenIds.has(id)
      const can = !!i && canHide(i, { unread: unreadIds.has(id), held: holdsOf(id).length > 0 })
      return {
        chip: un ? <Button key={`unhide-${id}`} plain label="Unhide" onPress={hidePress(id, false)} /> : can ? <Button key={`hide-${id}`} plain label="Hide" onPress={hidePress(id, true)} /> : null,
        button: un ? <Button key={`unhide-more-${id}`} label="Unhide" onPress={hidePress(id, false)} /> : can ? <Button key={`hide-more-${id}`} label="Hide" onPress={hidePress(id, true)} /> : null,
      }
    }
    // a thread's messages: the "N new" chip (a tap shows them), Show / Hide messages, ack for the whole card, the rows themselves
    const messagePieces = (id: string) => {
      const grp = inboxOf.get(id)
      const unfolded = !!grp && ui.rows[`inb${id}`] === true
      return {
        newChip: grp?.unread.length ? <Button key={`new-${id}`} plain label={`${grp.unread.length} new`} onPress={showMessages(id)} /> : null,
        buttons: grp
          ? [
              <Button key={`inbox-toggle-${id}`} plain label={unfolded ? 'Hide messages' : 'Show messages'} onPress={toggleRow(`inb${id}`)} />,
              grp.unread.length > 0 ? (
                <Button
                  key={`ack-card-${id}`}
                  label={`ack ${grp.unread.length}`}
                  onPress={act('ack', async () => {
                    for (const a of grp.unread.slice(0, GROUP_ROWS)) await ackRows(host, a.n) // (only the rows the card shows: an unread row that was never drawn is not read)
                  })}
                />
              ) : null,
            ]
          : [],
        body: unfolded && grp ? inboxRows(grp) : null,
      }
    }
    // the context bar of a card: small, with the number
    const ctxBar = (t: ThreadRow) => {
      const cm = t.ctx ? /(\d+)k\/(\d+)k/.exec(t.ctx) : null
      const color = t.ctxLevel === 'over' ? 'error' : t.ctxLevel === 'warn' ? 'warning' : 'success'
      if (cm) {
        const cells = Math.max(0, Math.min(8, Math.round((Number(cm[1]) / Math.max(1, Number(cm[2]))) * 8)))
        return <Text key={`ctx-${t.id}`} color={color}>{`ctx ${'█'.repeat(cells)}${'░'.repeat(8 - cells)} ${cm[1]}k/${cm[2]}k${t.keep ? ' · keep' : ''}`}</Text>
      }
      return t.ctx ? <Text key={`ctx-${t.id}`} color={t.ctxLevel === 'over' ? 'error' : t.ctxLevel === 'warn' ? 'warning' : undefined} dimColor={t.ctxLevel === 'ok'}>{`${t.ctx}${t.keep ? ' · keep' : ''}`}</Text> : null
    }
    const goalOf = (id: string) => v?.goals.find(g => g.id === id)
    const DECIDE: string[] = ['action', 'model', 'denial']
    // the one shape of a session card, whatever the thread's state: two lines, then (unfolded) the details
    const sessionCard = (o: { id: string; title: string; open: boolean; chips: any[]; chipLen: number; line2: any[]; primary: any; color?: string; dim: boolean; details: any }) =>
      {
        const hc = hideCtl(o.id)
        return (
          <Box key={`t-${o.id}`} {...cardProps({ color: o.color, dim: o.dim })}>
            <Box key="line1" flexWrap="nowrap" columnGap={1}>
              <Button key={`card-${o.id}`} plain label={short(`${o.open ? '▾' : '▸'} ${o.id} ${o.title}`, Math.max(14, cols - 4 - o.chipLen - 1))} onPress={toggleCard(o.id)} />
              {o.chips}
            </Box>
            <Box key="line2" flexWrap="nowrap" columnGap={1} justifyContent="space-between">
              <Box flexWrap="nowrap" columnGap={1} flexShrink={1}>
                {o.line2}
                {hc.chip}
              </Box>
              {o.primary}
            </Box>
            {o.open && `▾ ${o.id} ${o.title}`.length > Math.max(14, cols - 4 - o.chipLen - 1) ? <Text key="full-title" wrap="wrap">{o.title}</Text> : null}
            {o.details}
            {o.open && hc.button ? (
              <Box key="hide-row" flexWrap="wrap" columnGap={1}>
                {hc.button}
              </Box>
            ) : null}
          </Box>
        )
      }
    const threadRow = (t: ThreadRow) => {
      const sc = stateOf(t)
      const myNeeds = needs.filter(n => n.thread === t.id)
      const held = holdsOf(t.id)
      const decideN = Math.max(myNeeds.filter(n => DECIDE.includes(n.kind)).length + held.length, t.pending ? 1 : 0)
      const open = expanded(t.id) || (!cfgPane.foldAll && decideN > 0)
      const blockedWord = ['blocked', 'stuck', 'stalled'].includes(sc.word)
      // the status chip: working / needs you / done / restarting (amber is the chip, never the body)
      const chipWord = ['waiting', 'approval', 'asking'].includes(sc.word) ? 'needs you' : sc.word
      const live = !['done', 'done (finishing)', 'idle', 'parked'].includes(sc.word) // (a context bar only for a thread that is working or waiting)
      const chip = (
        <Text key="state" bold color={sc.color}>
          {`[${chipWord}]`}
        </Text>
      )
      // "idle, no report N min" (endnudge.ts): a second chip beside the status chip
      const noRepChip = t.noReport ? (
        <Text key="norep" bold color="warning">
          {`[${t.noReport}]`}
        </Text>
      ) : null
      const review = t.review === 'green' ? { text: 'review green', color: 'success' } : t.review === 'red' ? { text: 'review not green', color: t.done || t.ready ? 'error' : undefined } : { text: 'no review', color: undefined }
      const costNode = t.costBadge ? <Text color={t.costOver ? 'warning' : undefined} dimColor={!t.costOver}>{t.costLine ?? `window ${t.costBadge} tokens`}</Text> : t.cost > 0 ? <Text dimColor>{closedText(t.cost)}</Text> : null
      const age = <Text dimColor>{ageText(t.activity ?? t.recTs, now2)}</Text>
      const openBtn = <Button key={`view-${t.id}`} label="Open" onPress={openPaneOne(t.id)} />
      const resumeBtn = t.resumable && <Button key={`resume-${t.id}`} label="Resume" onPress={thread('resume', t.id)} />
      const restartBtn = t.state === 'open' && (
        <Button
          key={`restart-${t.id}`}
          label={confirming(ui, `restart:${t.id}`, now2) ? (t.working ? `Confirm restart ${t.id} (it is working: the current step is lost)` : `Confirm restart ${t.id}`) : blockedWord ? 'Restart' : 'Restart from handover'}
          onPress={restartOne(t.id)}
        />
      )
      const closeBtn = !t.working && !t.needsYou && <Button key={`close-${t.id}`} label={confirming(ui, `close:${t.id}`, now2) ? `Confirm close ${t.id}` : 'Close'} onPress={closeOne(t.id)} />
      const startBtn = t.resumable && <Button key={`start-${t.id}`} label="Start new session" onPress={thread('start', t.id)} />
      const msg = messagePieces(t.id)
      // Open at the right end of line 2, always; a thread blocked on an `approval` that is not working: Open tN (the idle process is released, then its own session opens)
      const approvalOpen = !!t.approval && !t.working
      const primary = approvalOpen ? <Button key={`open-${t.id}`} label={`Open ${t.id}`} onPress={openOne(t.id)} /> : openBtn
      const goal = goalOf(t.id)
      // ONE line for "what is wrong with this session": the stale / live note, else the waiting-for-you line (the decision cards below say it themselves)
      const statusLine = t.liveNote ? (
        <Text color={sc.word === 'stuck' ? 'error' : 'warning'} wrap="wrap">{t.liveNote}</Text>
      ) : t.needsYou && myNeeds.length === 0 ? (
        <Text color="warning">waiting for you: open it in the app</Text>
      ) : null
      const details = open ? (
        <Box key="details" flexDirection="column">
          <Box flexWrap="wrap" columnGap={1}>
            {t.model ? <Text dimColor>{`${t.model}${t.effort ? `/${t.effort}` : ''}`}</Text> : null}
            {t.keepGoing ? <Text color="cyan">keep-going</Text> : null}
            {t.rules ? <Text dimColor>{`${t.rules} rule${t.rules > 1 ? 's' : ''}`}</Text> : null}
            {t.agents ? <Text dimColor>{t.agents}</Text> : null}
            {t.branch ? <Text dimColor>{t.branch}</Text> : null}
            <Text color={review.color} dimColor={!review.color}>{review.text}</Text>
          </Box>
          {t.finished ? <Text dimColor>finished: the next message starts a new session</Text> : null}
          {statusLine}
          {t.pending && myNeeds.length === 0 ? <Text color="warning" wrap="wrap">{t.pending}</Text> : null}
          {t.pausedUntil ? <Text color="warning">{`paused until ${fmtUntil(t.pausedUntil, now2)}`}</Text> : null}
          {goal ? <Text dimColor wrap="wrap">{`goal (${goal.tone}): ${short(goal.text, 160)}`}</Text> : null}
          <Text dimColor wrap="wrap">
            {short(t.lastReport, 200) || 'no report yet'}
          </Text>
          {myNeeds.map(n => needCard(n, false, true))}
          {holdRows(t.id)}
          <Box flexWrap="wrap" columnGap={1}>
            {blockedWord ? [restartBtn, resumeBtn, startBtn, closeBtn] : [resumeBtn, startBtn, restartBtn, closeBtn]}
            {msg.buttons}
          </Box>
          {msg.body}
        </Box>
      ) : null
      const attention = chipWord === 'needs you' || blockedWord || myNeeds.length > 0 || !!t.pending || !!t.noReport
      return sessionCard({
        id: t.id,
        title: t.title,
        open,
        chips: [chip, noRepChip],
        chipLen: chipWord.length + 2 + (t.noReport ? t.noReport.length + 3 : 0),
        line2: [msg.newChip, decideN > 0 ? <Text key={`decide-${t.id}`} bold color="warning">{`${decideN} to decide`}</Text> : null, costNode, live ? ctxBar(t) : null, age],
        primary,
        color: blockedWord ? sc.color : attention ? 'warning' : undefined,
        dim: !blockedWord,
        details,
      })
    }
    // a closed thread: the same card (title, [closed], "N new", cost, "closed 3 h ago", Open); a tap unfolds Reopen, its last line and its messages
    const closedRow = (c: ClosedRow) => {
      const open = expanded(c.id)
      const msg = messagePieces(c.id)
      return sessionCard({
        id: c.id,
        title: c.title,
        open,
        chips: [
          <Text key="state" bold color="inactive">
            [closed]
          </Text>,
        ],
        chipLen: 'closed'.length + 2,
        line2: [msg.newChip, c.cost > 0 ? <Text dimColor>{closedText(c.cost)}</Text> : null, <Text dimColor>{`closed ${ageText(c.activity, now2)}`}</Text>],
        primary: <Button key={`view-${c.id}`} label="Open" onPress={openPaneOne(c.id)} />,
        dim: true,
        details: open ? (
          <Box key="details" flexDirection="column">
            {c.last ? <Text dimColor wrap="wrap">{short(c.last, 300)}</Text> : null}
            <Box flexWrap="wrap" columnGap={1}>
              <Button key={`reopen-${c.id}`} label="Reopen" onPress={reopen(c.id)} />
              {msg.buttons}
            </Box>
            {msg.body}
          </Box>
        ) : null,
      })
    }
    const sortedAll = sortItems(itemsOf(v?.threads ?? [], v?.closed ?? [], needs), cfgPane.sort, effectiveDir(cfgPane))
    const unreadIds = new Set(inbox.filter(g => g.unread.length > 0).map(g => g.from))
    // the hidden completed sessions (panelist.ts isHidden): out of the list unless the "N hidden" chip was tapped (then they are drawn folded, with Unhide)
    const hiddenSet = await readHidden(host)
    const itemById = new Map(sortedAll.map(i => [i.id, i] as const))
    const hiddenIds = new Set(sortedAll.filter(i => isHidden(i, hiddenSet, { unread: unreadIds.has(i.id), held: holdsOf(i.id).length > 0 })).map(i => i.id))
    const hiddenShown = ui.rows.hiddenShown === true
    const allItems = hiddenShown ? sortedAll : sortedAll.filter(i => !hiddenIds.has(i.id))
    const hideableNow = allItems.filter(i => !hiddenIds.has(i.id) && canHide(i, { unread: unreadIds.has(i.id), held: holdsOf(i.id).length > 0 }))
    const hiddenUnread = [...hiddenIds].reduce((n, id) => n + (inboxOf.get(id)?.unread.length ?? 0), 0) // (a hidden session has nothing unread by rule: this says so if it ever does)
    const hideCompleted = async () => {
      await saveHidden(host, cur => ({ ...cur, ...Object.fromEntries(hideableNow.map(i => [i.id, i.activity] as const)) }))
      tell()
    }
    const showAllRows = ui.rows.sessionsAll === true
    const capped = showAllRows ? { shown: allItems, hidden: 0 } : capItems(allItems, cfgPane.maxSessions, (i: Item) => i.needs || unreadIds.has(i.id) || holdsOf(i.id).length > 0)
    const sessionRow = (i: Item) => (i.t ? threadRow(i.t) : closedRow(i.c!))

    // ---- header: ONE compact block: the model chip, the budget, the plan window, the desk's context with the Health chip, the version ----
    const desk = v?.desk
    const ctx = desk?.context ?? 0
    const limit = desk?.limit ?? 0
    const pct = limit > 0 ? Math.round((ctx / limit) * 100) : 0
    const overDesk = ctx > 0 && pct >= OVER_PCT
    const barColor = pct >= 100 ? 'error' : pct >= OVER_PCT ? 'warning' : 'success'
    // the one-time line "lean-agent set the model": drawn (in Health) for NOTE_MS from its first draw, then the chip carries it
    const setNote = v?.deskModelSet ?? ''
    if (setNote && !noteSeen.has(setNote)) noteSeen.set(setNote, now2)
    const showSetNote = !!setNote && now2 - (noteSeen.get(setNote) ?? now2) < NOTE_MS
    const chip = desk?.model ? `${desk.model}${desk.effort ? `/${desk.effort}` : ''}${v?.deskModel ? ' ≠ pin' : setNote && !showSetNote ? ' (set by lean-agent)' : ''}` : ''
    // the plan window: a small bar with the number ("5h window: 83% used, resets ..."), the rest of the line dim (an amber line at 83 % looked like a warning)
    const winM = /^([^:|]+):\s*(\d+)%( used)?,?\s*(.*)$/.exec(v?.window ?? '')
    const winPct = winM ? Math.min(100, Number(winM[2])) : undefined
    const winLabel = winM?.[1]?.trim() ?? ''
    const winRest = winM?.[4] ?? ''

    // ---- Health (1.0.32): every warning, finding and fix in ONE card, folded on startup (pane.healthOpen). Three groups: needs a fix, standing approvals, info ----
    const hNotices = showHidden ? [...(v?.notices ?? []), ...(v?.dismissedNotices ?? [])] : (v?.notices ?? [])
    const isHid = (nt: NoticeRow) => !!v?.dismissedNotices.includes(nt)
    const infoNotices = hNotices.filter(n => n.info)
    const otherNotices = hNotices.filter(n => !n.info)
    const row = (key: string, chipText: string, tone: string | undefined, text: string, buttons: any[] = [], dim = false) => (
      <Box key={key} flexWrap="wrap" columnGap={1}>
        {chipText ? (
          <Text bold color={tone}>
            {`[${chipText}]`}
          </Text>
        ) : null}
        <Text wrap="wrap" dimColor={dim}>
          {text}
        </Text>
        {buttons}
      </Box>
    )
    // the standing own-PR grant (ownpr.ts): the user's own default, so information; Revoke takes the default away and removes the line
    const revokeOwnPress = (nt: NoticeRow) => async () => {
      resetViewCache()
      const n = await revokeOwn(host, { thread: nt.thread ?? '' }, 'user, pane').catch(() => 0)
      if (n > 0) for (const o of (v?.notices ?? []).filter(x => x.info && x.thread === nt.thread && /^ownpr/.test(x.key))) await setNotice(host, o.key, null) // (every own-PR line of that thread: the default is gone)
      resetViewCache()
      sayModel(n > 0 ? `${nt.thread} no longer sends its own PR replies without a question` : `nothing to revoke for ${nt.thread}: it owns no PR now`, n === 0)
      tell()
    }
    const looseNeeds = needs.filter(n => !n.thread || !(v?.threads ?? []).some(t => t.id === n.thread)) // (no card to carry them: a script waiting, the desk's own model request)
    const fixItems: any[] = []
    if (missing.length > 0) fixItems.push(<Box key="h-setup" flexDirection="column">{problemRows}</Box>)
    if (mcp.length > 0) fixItems.push(<Box key="h-mcp" flexDirection="column">{mcpBlock}</Box>)
    for (const [i, m] of errors.entries())
      fixItems.push(
        <Text key={`err-${i}`} color="red">
          error: {m}
        </Text>,
      )
    for (const nt of otherNotices.filter(n => !isHid(n))) {
      const bad = !nt.budget && !nt.warn
      fixItems.push(
        <Box key={`nt-${nt.key}`} flexWrap="wrap" columnGap={1}>
          {bad ? (
            <Text color="error" wrap="wrap">{`error: ${nt.text}`}</Text>
          ) : (
            <>
              <Text bold color="warning">
                {nt.budget ? '[budget]' : '[fix]'}
              </Text>
              <Text wrap="wrap">{nt.budget ? nt.text : short(nt.text.replace(/^lean-agent:\s*/, ''), 160)}</Text>
            </>
          )}
          <Button key={`notice-dismiss-${nt.key}`} label="Dismiss" onPress={dismissLine([nt.dk])} />
        </Box>,
      )
    }
    // (1.0.33) the limit is a warning level only: above it the desk goes on, this ONE amber finding says so; from 80 % the same finding in softer words; nothing red, nothing repeated
    if (overDesk && !desk?.restarting) fixItems.push(row('h-restart', 'restart desk', 'warning', ctx >= limit ? `above its limit (${kTokens(ctx)} of ${kTokens(limit)}): press Restart desk when it suits you (the handover is ready)` : `desk context ${kTokens(ctx)} of ${kTokens(limit)}: press Restart desk when it suits you (the handover is ready)`))
    // the desk runs another model than its pin and the mod could not change it (deskmodel.ts): what to pick
    if (v?.deskModel && !v.deskModelRed) fixItems.push(row('h-deskmodel', 'desk model', 'warning', v.deskModel))
    for (const [i, m] of fixes.entries()) fixItems.push(row(`df-${i}`, 'fix', 'warning', short(m, 160), [<Button key={`doctor-dismiss-fix-${i}`} label="Dismiss" onPress={dismissLine([docId(m)])} />]))
    for (const n of looseNeeds) fixItems.push(needCard(n)) // (a script waiting, the desk's own model request: no thread card to carry them)
    const unreadGroups = cardless.filter(g => g.unread.length > 0)
    fixItems.push(...unreadGroups.map(inboxGroup)) // (messages from senders without a thread: the desk, the mod, an unknown id; each group says "N unread")
    const standN = (stand?.sent.length ?? 0) + (stand?.grants.filter(g => !sentGrants.has(g.id)).length ?? 0) + (wr?.sent.length ?? 0) + (wr?.grants.filter(g => !wrSent.has(g.id)).length ?? 0) + (se?.grants.length ?? 0) + infoNotices.filter(n => !isHid(n)).length
    const standItems: any[] = [
      standingBlock,
      writtenBlock,
      selfEditBlock,
      ...infoNotices.map(nt => {
        const hid = isHid(nt)
        return row(`own-${nt.key}`, '', undefined, `${short(nt.text, 160)}${hid ? ' (dismissed)' : ''}`, hid ? [] : [/^ownpr/.test(nt.key) ? <Button key={`own-revoke-${nt.key}`} label="Revoke" onPress={revokeOwnPress(nt)} /> : null, <Button key={`notice-dismiss-${nt.key}`} label="Dismiss" onPress={dismissLine([nt.dk])} />], hid)
      }),
    ].filter(Boolean)
    const infoItems: any[] = []
    for (const [i, m] of info.entries()) infoItems.push(row(`di-${i}`, '', undefined, short(m, 160), [<Button key={`doctor-dismiss-info-${i}`} label="Dismiss" onPress={dismissLine([docId(m)])} />], true))
    if (showSetNote) infoItems.push(row('h-setnote', '', undefined, setNote, [], true))
    // which case applies, in words (pin applied at start / the app chose it and the pin could not be applied / you chose it by hand); the red row carries the failure
    if (v?.deskModelStatus && !v.deskModel && !showSetNote) infoItems.push(row('h-modelstatus', '', undefined, v.deskModelStatus, [], true))
    if (overDesk && desk?.restarting) infoItems.push(row('h-restarting', '', undefined, `restarting the desk (context ${kTokens(ctx)} of ${kTokens(limit)}): a new session opens by itself`, [], true))
    for (const nt of otherNotices.filter(isHid)) infoItems.push(row(`nt-${nt.key}`, '', undefined, `${short(nt.text, 160)} (dismissed)`, [], true))
    for (const g of cardless.filter(x => x.unread.length === 0)) infoItems.push(inboxGroup(g))
    if (v?.archived && cardless.length > 0) infoItems.push(row('h-archived', '', undefined, `${v.archived} read message(s) older than 7 days are archived (still in the inbox file)`, [], true))
    // below the groups, not counted: the dismissed list with its show / hide, and the lines of the last setup run
    const trailing: any[] = [...(showHidden ? dismissedRows : []).map(n => needCard(n, true)), dismissLine_, ...lastSetup.map((l, i) => row(`su-${i}`, '', undefined, l, [], true))].filter(Boolean)
    const blocker = missing.length > 0 || errors.length > 0 || otherNotices.some(n => !isHid(n) && !n.budget && !n.warn) || looseNeeds.some(n => n.kind === 'deskmodel')
    const hs = healthSummary({ fix: fixItems.length, standing: standN, info: infoItems.length, blocker })
    const healthDflt = cfgPane.healthOpen || missing.length > 0 || errors.length > 0 // (a missing setup and a failed load are never hidden: the pane is never blank)
    const healthUnfolded = isOpen(ui, 'health', healthDflt)
    const openHealth = async () => {
      await patchUi($, u => ({ ...u, open: { ...u.open, health: true } }))
      tell()
    }
    const group = (key: string, heading: string, items: any[], extra: any[] = []) =>
      items.length > 0 ? (
        <Box key={key} flexDirection="column">
          <Box flexWrap="wrap" columnGap={1}>
            <Text bold>{heading}</Text>
            {extra}
          </Box>
          {items}
        </Box>
      ) : null
    const healthCard = (
      <Box key="health" {...cardProps({ color: hs.tone === 'error' ? 'error' : hs.tone === 'warning' ? 'warning' : undefined, dim: hs.tone === 'quiet' })}>
        <Box key="health-line" flexWrap="nowrap" columnGap={1}>
          {foldTitle('health', hs.label, healthDflt, hs.extra ? hs.extra.length + 1 : 0, hs.tone === 'quiet')}
          {!!hs.extra && <Text dimColor>{hs.extra}</Text>}
        </Box>
        {healthUnfolded && (
          <Box key="health-body" flexDirection="column">
            {group('g-fix', 'Needs a fix', fixItems, fixes.length > 0 ? [<Button key="doctor-fix" label="Run fix" onPress={runSetup} />] : [])}
            {group('g-standing', 'Standing approvals', standItems)}
            {group('g-info', 'Info', infoItems)}
            {trailing}
            {fixItems.length + standItems.length + infoItems.length + trailing.length === 0 && <Text dimColor>Nothing to fix.</Text>}
          </Box>
        )}
      </Box>
    )
    // ---- the header card (1.0.33): folded it is ONE line (name, today's cost, the 5 h window, the desk's context) with the fix chip and the Restart desk button at its right end;
    // unfolded: the model chip, 7 d, the window bar with its reset time and snapshot age, the desk context bar, the version line ----
    const lastErrorShown = !!lastError && !errors.includes(lastError) && notice !== lastError
    const headerOpen = isOpen(ui, 'header', false)
    const winShown = !!v?.window && (!winGone || showHidden)
    // above its limit the desk's own figure comes right after the name ("lean-agent · desk 230k of 200k - Restart desk · 1.2M tokens ..."), so a narrow line cuts the usage, not the warning
    const deskBit = ctx > 0 && limit > 0 ? (ctx >= limit ? `desk ${kTokens(ctx)} of ${kTokens(limit)} - Restart desk` : `desk ${kTokens(ctx)}/${kTokens(limit)}`) : ''
    const restBits = [foldedText(v?.spend), winShown && winPct !== undefined ? `${winLabel.split(/\s+/)[0] || 'window'} ${winPct}%` : '']
    const foldedBits = (ctx > 0 && limit > 0 && ctx >= limit ? ['lean-agent', deskBit, ...restBits] : ['lean-agent', ...restBits, deskBit]).filter(Boolean)
    // Restart desk: always here (1.0.33), one tap (no second confirm), the same restart path as the automatic one (handover first, then the new desk). While a restart runs, or
    // for 60 s after the last one, a dim line says so instead of the button (the 30 min gap and the per-day count are for AUTOMATIC restarts only).
    const restarting = restartingNow()
    const restartWait = restarting ? 0 : await restartWaitMs(host)
    const restartText = restarting ? 'restarting…' : restartWait > 0 ? noRestartNote(restartWait) : ''
    const restartCtl = restartText ? (
      <Text key="restart-desk-state" dimColor>
        {restartText}
      </Text>
    ) : (
      <Button key="restart-desk" label="Restart desk" variant={overDesk ? 'primary' : undefined} onPress={restartDeskPress} />
    )
    const fixLabel = `${fixItems.length} ${fixItems.length === 1 ? 'fix' : 'fixes'}`
    const fixChip = fixItems.length > 0 ? <Button key="health-chip" label={fixLabel} onPress={openHealth} /> : null
    const rightLen = (fixItems.length > 0 ? fixLabel.length + 3 : 0) + (restartText ? restartText.length : 'Restart desk'.length + 2) + 2
    const headerCard = headerOpen ? (
        <Box key="header" {...cardProps({ color: lastErrorShown ? 'error' : undefined })}>
          <Box key="h-line" flexWrap="nowrap" columnGap={1} justifyContent="space-between">
            <Box flexWrap="wrap" columnGap={1} flexShrink={1}>
              <Button key="sec-header" plain label="▾ lean-agent" onPress={toggleSection('header', false)} />
              {!!chip && (
                <Text key="chip" bold color={v?.deskModel ? 'warning' : 'claude'}>
                  {`[${chip}]`}
                </Text>
              )}
              <Text key="budget" dimColor>
                {headerText(v?.spend)}
              </Text>
            </Box>
            {restartCtl}
          </Box>
          {winShown && (
            <Box key="h-window" flexWrap="wrap" columnGap={1}>
              {winPct !== undefined ? (
                <>
                  <Progress key="win" label={winLabel} value={winPct} max={100} valueText={`${winPct}%`} color={winPct >= 100 ? 'error' : winPct >= 90 ? 'warning' : 'success'} />
                  <Text dimColor>{winRest}</Text>
                </>
              ) : (
                <Text dimColor>{v!.window}</Text>
              )}
              {winAlert && !winGone && <Button key="window-dismiss" label="Dismiss" onPress={dismissLine([winId])} />}
            </Box>
          )}
          <Box key="h-ctx" flexWrap="wrap" columnGap={1}>
            {ctx > 0 && limit > 0 ? <Progress key="ctx" label="desk context" value={ctx} max={limit} valueText={`${kTokens(ctx)} of ${kTokens(limit)}`} color={barColor} /> : <Text dimColor>desk context: known after the next request</Text>}
            {fixChip}
          </Box>
          <Text key="h-version" dimColor size="caption">
            lean-agent {VERSION} · refreshed {lastRefresh || 'never'}
            {lastErrorShown ? ` · last error: ${lastError}` : ''}
          </Text>
        </Box>
      ) : (
        <Box key="header" {...cardProps({ color: lastErrorShown ? 'error' : undefined })}>
          <Box key="h-line" flexWrap="nowrap" columnGap={1} justifyContent="space-between">
            <Box flexWrap="nowrap" flexShrink={1}>
              <Button key="sec-header" plain label={short(`▸ ${foldedBits.join(' · ')}`, Math.max(14, cols - 4 - rightLen))} onPress={toggleSection('header', false)} />
            </Box>
            <Box flexWrap="nowrap" columnGap={1}>
              {fixChip}
              {restartCtl}
            </Box>
          </Box>
        </Box>
      )
    // a one-line result of a press (closed t3, a restart's answer): a card with its Dismiss
    const noticeCard =
      !!notice && !errors.includes(notice)
        ? card(
            'notice',
            <Box flexWrap="wrap" columnGap={1}>
              <Text color="yellow">{notice}</Text>
              <Button key="notice-dismiss" label="Dismiss" onPress={clearNotice} />
            </Box>,
            { color: 'warning' },
          )
        : null
    // ---- the Sessions toolbar card: folded = its title (with the sort named) and ack all; unfolded = the sort chips and Close all done ----
    const toolbarOpen = isOpen(ui, 'toolbar', false)
    const dir = effectiveDir(cfgPane)
    const toolbarTitle = `Sessions (${allItems.length})${v?.unread ? ` · ${v.unread} unread${hiddenUnread > 0 ? ` (${hiddenUnread} hidden)` : ''}` : ''} · sorted by ${SORT_LABEL[cfgPane.sort]} ${ARROW[dir]}`
    const hiddenLabel = hiddenShown ? `showing ${hiddenIds.size} hidden` : `${hiddenIds.size} hidden`
    const toolbarCard = (
      <Box key="toolbar" {...cardProps()}>
        <Box key="tb-line" flexWrap="nowrap" columnGap={1} justifyContent="space-between">
          <Box flexWrap="nowrap" flexShrink={1}>
            {foldTitle('toolbar', toolbarTitle, false, (v?.unread ? 'ack all'.length + 3 : 0) + (hiddenIds.size > 0 ? hiddenLabel.length + 3 : 0))}
          </Box>
          <Box flexWrap="nowrap" columnGap={1}>
            {hiddenIds.size > 0 && <Button key="hidden-chip" label={hiddenLabel} onPress={toggleRow('hiddenShown')} />}
            {!!v?.unread && <Button key="ack-all" label="ack all" onPress={act('ack', async () => ackRows(host, 'all'))} />}
          </Box>
        </Box>
        {toolbarOpen && (
          <Box key="tb-more" flexDirection="column">
            <Box flexWrap="wrap" columnGap={1}>
              <Text dimColor>sort:</Text>
              {SORTS.map(k => (
                <Button key={`sort-${k}`} plain dimColor={cfgPane.sort !== k} label={`${cfgPane.sort === k ? '● ' : ''}${SORT_LABEL[k]}${cfgPane.sort === k ? ` ${ARROW[dir]}` : ''}`} onPress={sortPress(k)} />
              ))}
              <Button key="sort-dir" label={`${ARROW[dir]} ${dir}`} onPress={flipDir} />
            </Box>
            {hideableNow.length > 0 && (
              <Box flexWrap="wrap" columnGap={1}>
                <Button key="hide-completed" label={`Hide all completed (${hideableNow.length})`} onPress={hideCompleted} />
              </Box>
            )}
            {doneThreads.length >= 2 && closable.length > 0 && (
              <Box flexWrap="wrap" columnGap={1}>
                <Button key="close-done" label={confirming(ui, 'close:done', now2) ? `Confirm close all done (${closable.length})` : `Close all done (${closable.length})`} onPress={closeDone} />
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
    const moreOpen = isOpen(ui, 'more', false)
    const moreCard = (
      <Box key="more" {...cardProps()}>
        {foldTitle('more', `More (${v?.goals.length ?? 0} goals, ${v?.projects.length ?? 0} projects, ${(v?.scripts.candidates ?? 0) + (v?.scripts.adopted ?? 0)} scripts)`, false)}
        {moreOpen && (
          <Box key="more-body" flexDirection="column">
            {v?.goals.map(g => (
              <Text key={`g-${g.id}`} color={TONE[g.tone]}>
                {g.id} {g.tone}: {short(g.text, narrow ? 40 : 90)}
              </Text>
            ))}
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
      </Box>
    )
    return (
      <Box flexDirection="column">
        {headerCard}
        {noticeCard}
        {healthCard}
        {toolbarCard}
        {v && !allItems.length ? card('empty', <Text dimColor>No threads yet.</Text>) : null}
        {capped.shown.map(sessionRow)}
        {capped.hidden > 0 || (showAllRows && allItems.length > cfgPane.maxSessions)
          ? card(
              'sessions-cap',
              capped.hidden > 0 ? <Button key="sessions-more" plain label={`show more (${capped.hidden} older)`} onPress={toggleRow('sessionsAll')} /> : <Button key="sessions-less" plain label="show fewer" onPress={toggleRow('sessionsAll')} />,
            )
          : null}
        {moreCard}
        {card(
          'actions',
          <Box flexWrap="wrap" columnGap={1}>
            <Button key="new-thread" label="New thread" onPress={newThreadPress} />
            <Button key="feedback" label={feedbackLabel} onPress={feedbackPress} />
            <Button key="repair" label="Setup / repair" onPress={runSetup} />
          </Box>,
        )}
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
