// The thread's own pane (1.0.33: cards only, everything folded): one pane per thread (`lean-agent-thread-<tN>`, titled "tN · <title>"), opened from the desk pane's buttons through
// openThreadPane. Several may be open at once; each draw reads its own thread's data (threaddetail.ts, threadcards.ts and the desk's view for the decisions), so they never share a view.
// EVERY block is a card (one border, one padding, the desk pane's fold: a title button with the chevron, chips on the same line, the user's tap kept in the mod's store) and nothing sits
// outside one: STATUS, REPORT, TO DECIDE, MESSAGES, TASK, RULES, FILES and HEALTH (quiet grey, highlighted only when something needs a fix), plus a notice card for the answer of a press.
// Folded, a card is ONE line (title cut with an ellipsis, chips right). Open session, Resume, Start new session, Restart from handover, Close and Refresh are in the STATUS card; Approve /
// Deny / Send now / Dismiss in TO DECIDE (the SAME presses as the desk pane's: pane.tsx makeDecisions, handed over by register.tsx); ack in MESSAGES; Remove and Revoke in RULES.
// All logic is the lean_thread tool's own code (leanThread), so it exists once. A closed or missing thread draws one card, never a blank pane. pane.foldAll false unfolds TO DECIDE when
// something waits.
import { BRIEF_MAX, loadThreadDetail, resetThreadCache, threadTitle } from './threaddetail'
import type { ThreadDetail } from './threaddetail'
import { loadThreadExtra, openTasks } from './threadcards'
import type { ThreadExtra } from './threadcards'
import { leanThread } from './threads'
import { CONFIRM_MS, patchUi, readUi } from './panestate'
import { bounded, openThreadSession } from './setup'
import { ACTION_CARD_MAX, READ_SHOWN, ackRows, loadView, resetViewCache, stateOf as rowState } from './view'
import type { NeedRow, View } from './view'
import { homeDir } from './state'
import { ageText, paneConfig } from './panelist'
import { healthSummary } from './panehealth'
import { hostOf } from './host'
import { ENDED_AT_ONCE } from './threadstate'
import { recordDismiss } from './dismissstore'
import { standingLabelOf } from './deskactions'
import { ruleAction } from './threadrules'
import { RETRY_LABEL, selfEditLabel } from './denial'
import { paneLine } from './selfedit'
import { fmtUntil } from './limits'
import { sizeText } from './scratchnotes'
import type { makeDecisions as MakeDecisions } from './pane'
import type { Role } from './role'

export const THREAD_PANE_PREFIX = 'lean-agent-thread-'
export const threadPaneId = (id: string) => `${THREAD_PANE_PREFIX}${id}`
// the thread a pane id belongs to, or null (another pane, or an id that is no thread number)
export const threadOfPane = (requestId: unknown): string | null => {
  const m = typeof requestId === 'string' ? /^lean-agent-thread-(t\d{1,9})$/.exec(requestId) : null
  return m ? m[1]! : null
}

const BRIEF_LINES = 4 // brief lines drawn until expanded
const TODO_SHOWN = 12
const GROUP_ROWS = 20
const NARROW = 50 // a body narrower than this (cells) drops the context bar and the age from the status line
const TONE = { working: 'success', waiting: 'warning', stuck: 'error', quiet: 'inactive' } as const
const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/\s+/g, ' ')
const usd = (n: number) => `$${n.toFixed(2)}`
const stamp = (ts: number) => (Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ') : '?')
const msg = (err: unknown, n = 160) => String((err as Error)?.message ?? err).slice(0, n)

// per-pane view state that is not worth the store: a pending two-press, the last notice. Module state (a mod reload drops it, never data); resetThreadPanes() is called with the
// other pane state at a session start. The FOLDS are in the mod's store (panestate.ts rows `tp:<tN>:<card>`), so they survive a refresh and a mod reload.
type PaneState = { confirm: { key: string; until: number } | null; notice: string; bad: boolean; surface?: string }
const panes = new Map<string, PaneState>()
const stateOf = (id: string): PaneState => {
  let s = panes.get(id)
  if (!s) panes.set(id, (s = { confirm: null, notice: '', bad: false }))
  return s
}
export const resetThreadPanes = () => {
  panes.clear()
  resetThreadCache()
}

// The first argument is the engine `$` (a render or press handler's own) or the thin host `hostOf($)`: both answer `ui.open` (the engine
// wants `$` spelled `$.ui.open(...)`, so the parameter is named `$` for both). Returns the pane's id; a pane for a thread that does not
// exist still opens and says so.
export async function openThreadPane($: any, surface: string | undefined, id: string): Promise<{ ok: boolean; text: string; pane: string }> {
  const pane = threadPaneId(id)
  if (!threadOfPane(pane)) return { ok: false, text: `${id} is not a thread number`, pane }
  const s = stateOf(id)
  if (surface) s.surface = surface
  let title = id
  try {
    const t = await threadTitle(hostOf($), id)
    if (t) title = `${id} · ${short(t, 40)}`
  } catch {
    /* the title stays the bare id */
  }
  try {
    await $.ui.open({ id: pane, title })
    return { ok: true, text: `${id} opened in its own pane`, pane }
  } catch (err) {
    return { ok: false, text: `could not open the pane of ${id}: ${msg(err)}`, pane }
  }
}

const cardProps = (o: { color?: string; dim?: boolean } = {}) => ({ flexDirection: 'column' as const, borderStyle: 'round' as const, borderColor: o.color, borderDimColor: o.dim ?? !o.color, paddingX: 1 })

// ---- the draw ----
// Never blank: anything the draw throws becomes one red card (the pane's own rule, as in pane.tsx)
export async function drawThreadPane($: any, e: any, id: string, roleOf: () => Role, decide?: typeof MakeDecisions): Promise<any> {
  try {
    return await paint($, e, id, roleOf, decide)
  } catch (err) {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box key="error" {...cardProps({ color: 'error' })}>
          <Text bold>{id}</Text>
          <Text color="red">{`error: could not draw ${id}: ${msg(err)}`}</Text>
        </Box>
      </Box>
    )
  }
}

async function paint($: any, e: any, id: string, roleOf: () => Role, decide?: typeof MakeDecisions): Promise<any> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const host = hostOf($)
  const st = stateOf(id)
  const surface = typeof e?.surface === 'string' && e.surface ? e.surface : st.surface
  const tell = () => $.ui.invalidate('ui.render')
  const cols = Number(e?.props?.bodyColumns) > 0 ? Number(e.props.bodyColumns) : 80
  const one = (key: string, children: any[], o: { color?: string; dim?: boolean } = {}) => (
    <Box flexDirection="column">
      <Box key={key} {...cardProps(o)}>
        {children}
      </Box>
    </Box>
  )
  if (roleOf().kind !== 'desk') {
    return one('not-desk', [
      <Text key="t" bold>{id}</Text>,
      <Text key="m">Thread panes belong to the desk: open this from the desk session&apos;s pane.</Text>,
    ])
  }
  let d: ThreadDetail | null = null
  let fatal = ''
  try {
    d = await loadThreadDetail(host, id)
  } catch (err) {
    fatal = `could not read ${id}: ${msg(err)}`
  }
  if (!d) {
    return one('missing', [
      <Text key="t" bold>{id}</Text>,
      <Text key="m" color={fatal ? 'red' : 'yellow'}>{fatal || `${id} does not exist (no such thread).`}</Text>,
      <Button key="refresh" label="Refresh" onPress={async () => { resetThreadCache(); tell() }} />,
    ], { color: fatal ? 'error' : 'warning' })
  }
  if (d.state === 'closed') {
    return one('closed', [
      <Text key="t" bold>
        {id} · {short(d.title, 60)}
      </Text>,
      <Text key="m" dimColor>{id} is closed. Reopen it from the desk pane to work on it again.</Text>,
    ])
  }
  const now = await host.clock.now()
  const armed = (key: string) => !!st.confirm && st.confirm.key === key && now < st.confirm.until
  // the first press arms the button for CONFIRM_MS, the second does it (a press of another button drops the first)
  const twoStep = (key: string, run: () => Promise<void>) => async () => {
    const t0 = await host.clock.now()
    if (!(st.confirm && st.confirm.key === key && t0 < st.confirm.until)) {
      st.confirm = { key, until: t0 + CONFIRM_MS }
      tell()
      return
    }
    st.confirm = null
    await run()
  }
  const say = (text: string, bad: boolean) => {
    st.notice = short(text, 200)
    st.bad = bad
    tell()
  }
  const settle = () => {
    resetViewCache()
    resetThreadCache()
  }
  let v: View | null = null
  try {
    v = await loadView(host)
  } catch {
    /* the desk's view failed: the cards that need it say less, the thread's own data is still drawn */
  }
  const x: ThreadExtra = await loadThreadExtra(host, id)
  const ui = await readUi($)
  const cfg = await paneConfig(host)
  const home = await homeDir(host)
  const row = v?.threads.find(t => t.id === id)
  const D = decide ? decide({ host, root: $.plugin.root, say, tell, twoStep }) : null

  // ---- the fold of a card: kept in the mod's store (a tap is a press, never a render) ----
  const fkey = (n: string) => `tp:${id}:${n}`
  const isOn = (n: string, dflt = false) => ui.rows[fkey(n)] ?? dflt
  const toggle = (n: string, dflt = false) => async () => {
    await patchUi($, u => ({ ...u, rows: { ...u.rows, [fkey(n)]: !(u.rows[fkey(n)] ?? dflt) } }))
    tell()
  }
  const unfold = (n: string) => async () => {
    await patchUi($, u => ({ ...u, rows: { ...u.rows, [fkey(n)]: true } }))
    tell()
  }
  // a foldable card: line 1 = the title button (cut with an ellipsis so the chips stay on the line) + the chips; the body only unfolded
  const fold = (name: string, o: { title: string; chips?: any[]; chipLen?: number; color?: string; dim: boolean; dflt?: boolean; body: any }) => {
    const open = isOn(name, o.dflt ?? false)
    return (
      <Box key={`c-${name}`} {...cardProps({ color: o.color, dim: o.dim })}>
        <Box key="line" flexWrap="nowrap" columnGap={1}>
          <Button key={`sec-${name}`} plain dimColor={o.dim} label={short(`${open ? '▾' : '▸'} ${o.title}`, Math.max(14, cols - 4 - (o.chipLen ?? 0) - 1))} onPress={toggle(name, o.dflt ?? false)} />
          {o.chips}
        </Box>
        {open ? o.body : null}
      </Box>
    )
  }
  // an expandable line inside a card (a report, a message, an inbox row)
  const line = (key: string, label: string, body: string, dim = false, extra: any = null) => {
    const ex = isOn(key)
    return (
      <Box key={`row-${key}`} flexDirection="column">
        <Box flexWrap="wrap" columnGap={1}>
          <Button key={`btn-${key}`} plain dimColor={dim} label={`${ex ? '▾' : '▸'} ${label}`} onPress={toggle(key)} />
          {extra}
        </Box>
        {ex && <Text wrap="wrap">{body}</Text>}
      </Box>
    )
  }

  // ---- presses (the lean_thread tool's own code) ----
  const openSession = async () => {
    st.confirm = null
    settle()
    const r = await bounded($, openThreadSession(host, id, () => leanThread(host, $.plugin.root, { action: 'release', tN: id }), surface), `open ${id}`, 60_000).catch(err => ({ ok: false, text: `open ${id} failed: ${msg(err)}` }))
    settle()
    say(r.text, !r.ok)
  }
  const go = (action: 'resume' | 'start') => async () => {
    settle()
    const r = await leanThread(host, $.plugin.root, { action, tN: id }).catch(err => ({ ok: false, text: `${action} ${id} failed: ${msg(err)}` }))
    settle()
    say(r.text, !r.ok)
  }
  const restart = twoStep('restart', async () => {
    settle()
    const r = await leanThread(host, $.plugin.root, { action: 'restart', tN: id }).catch(err => ({ ok: false, text: `restart ${id} failed: ${msg(err)}` }))
    settle()
    say(r.text, !r.ok)
  })
  // the second press looks again: nothing that is working now (or waits for the user) is closed, a close stops the session
  const close = twoStep('close', async () => {
    settle()
    const fresh = await loadThreadDetail(host, id).catch(() => null)
    if (!fresh || fresh.state === 'closed') return say(`${id} is already closed`, false)
    if (fresh.working || fresh.needsYou) return say(`${id} is ${fresh.needsYou ? 'waiting for you' : 'working'}: not closed`, true)
    const r = await leanThread(host, $.plugin.root, { action: 'close', tN: id }).catch(err => ({ ok: false, text: `close ${id} failed: ${msg(err)}` }))
    settle()
    say(r.text, !r.ok)
  })
  const refresh = async () => {
    st.confirm = null
    st.notice = ''
    settle()
    tell()
  }
  const ack = (n: number | number[]) => async () => {
    resetViewCache()
    for (const k of Array.isArray(n) ? n : [n]) await ackRows(host, k)
    tell()
  }
  const dismissNeed = (n: NeedRow) =>
    twoStep(`dismiss:${n.key}`, async () => {
      try {
        await recordDismiss(host, home, n.dk!, n.text)
        st.notice = short(`dismissed: ${n.text} (a newer one will show again)`, 200)
        st.bad = false
      } catch (err) {
        st.notice = short(`dismiss failed: ${msg(err)}`, 200)
        st.bad = true
      }
      resetViewCache()
      tell()
    })
  const removeRule = (rid: string) =>
    twoStep(`rule:${rid}`, async () => {
      const r = await ruleAction(host, home, { tN: id, text: rid, on: false }).catch(err => ({ ok: false, text: `remove ${rid} failed: ${msg(err)}` }))
      resetViewCache()
      say(r.text, !r.ok)
    })

  // ---- the facts every card shares ----
  const t = row
  const sc = t ? rowState(t) : null
  const runLabel = d.run === 'unknown' ? 'session unknown (claude agents failed)' : d.live === 'stuck' ? 'stuck' : d.run
  const blockedWord = !!sc && ['blocked', 'stuck', 'stalled'].includes(sc.word)
  // the state chip, the words of the desk's card: working / needs you / done / ... (amber is the chip, never the body)
  const derived = d.needsYou || d.approval ? { word: 'needs you', color: 'warning' } : d.denial ? { word: 'blocked', color: 'error' } : d.live === 'stuck' ? { word: 'stuck', color: 'error' } : d.run === 'unknown' ? { word: 'unknown', color: 'inactive' } : d.run === 'parked' ? { word: 'parked', color: 'inactive' } : d.working ? { word: 'working', color: 'success' } : d.finished ? { word: 'done', color: 'inactive' } : { word: d.run, color: 'inactive' }
  const chipWord = sc ? (['waiting', 'approval', 'asking'].includes(sc.word) ? 'needs you' : sc.word) : derived.word
  const chipColor = sc ? sc.color : derived.color
  const reasonField = ((t as any)?.reason ?? (t as any)?.endReason ?? (t as any)?.endedReason) as unknown // (the hotfix's reason line, read tolerantly: not there = not shown)
  const reasonText = typeof reasonField === 'string' && reasonField.trim() ? reasonField.trim() : ''

  // ---- 1. STATUS ----
  const costTxt = d.costBadge ? d.costBadge : d.cost && d.cost.today > 0 ? usd(d.cost.today) : ''
  const cm = d.ctx ? /(\d+)k\/(\d+)k/.exec(d.ctx.text) : null
  const cells = cm ? Math.max(0, Math.min(8, Math.round((Number(cm[1]) / Math.max(1, Number(cm[2]))) * 8))) : 0
  const ctxTxt = d.ctx && d.run !== 'parked' && !narrowLine() ? (cm ? `ctx ${'█'.repeat(cells)}${'░'.repeat(8 - cells)} ${cm[1]}k/${cm[2]}k${d.keep ? ' · keep' : ''}` : d.ctx.text) : ''
  const ctxColor = d.ctx?.level === 'over' ? 'error' : d.ctx?.level === 'warn' ? 'warning' : cm ? 'success' : undefined
  const activityAt = t?.activity ?? t?.recTs ?? d.reports[0]?.ts ?? 0
  const ageTxt = narrowLine() ? '' : ageText(activityAt, now)
  function narrowLine() {
    return cols < NARROW
  }
  const stChipLen = `[${chipWord}]`.length + (costTxt ? costTxt.length + 1 : 0) + (ctxTxt ? ctxTxt.length + 1 : 0) + (ageTxt ? ageTxt.length + 1 : 0)
  const fullTitle = `${id} ${d.title}`
  const statusBody = (
    <Box key="status-body" flexDirection="column">
      {`▾ ${fullTitle}`.length > Math.max(14, cols - 4 - stChipLen - 1) ? <Text key="full-title" wrap="wrap">{d.title}</Text> : null}
      <Text key="what" dimColor wrap="wrap">
        {`${d.state} · ${runLabel}${d.finished ? (d.keep ? ' · finished (keep mode: the next message resumes it until the context limit)' : ' · finished (the next message starts a new session)') : ''} · ${d.model ? `${d.model}/${d.effort ?? '?'}` : 'model not recorded'} · project: ${d.project || 'none'}${t?.keepGoing ? ' · keep-going' : ''}`}
      </Text>
      {d.ctx?.level === 'over' ? <Text key="over" color="error" wrap="wrap">{`${d.ctx.text}: over the limit, the next message starts a new session`}</Text> : null}
      {t?.pausedUntil ? <Text key="paused" color="warning">{`paused until ${fmtUntil(t.pausedUntil, now)}`}</Text> : null}
      {d.cost ? (
        <Text key="cost" dimColor wrap="wrap">
          {`${d.costLine ?? `today ${usd(d.cost.today)}`} · total ${usd(d.cost.total)} (the ledger's rollup, the last 120 days)`}
        </Text>
      ) : (
        <Text key="cost" dimColor>cost not available</Text>
      )}
      {d.worktree ? (
        <Text key="work" color={d.worktree.exists ? undefined : 'yellow'} wrap="wrap">
          {`branch ${d.worktree.branch ?? '(not recorded)'} · worktree ${d.worktree.path}${d.worktree.exists ? '' : ' (gone)'}`}
        </Text>
      ) : (
        <Text key="work" dimColor>no worktree registered for this thread</Text>
      )}
      <Text key="started" dimColor>{`started ${x.created ? stamp(x.created) : '?'} · ${x.restarts} restart${x.restarts === 1 ? '' : 's'}`}</Text>
      <Box key="status-buttons" flexWrap="wrap" columnGap={1}>
        <Button key="open-session" label="Open session" onPress={openSession} />
        {t?.resumable ? <Button key="resume" label="Resume" onPress={go('resume')} /> : null}
        {t?.resumable ? <Button key="start-new" label="Start new session" onPress={go('start')} /> : null}
        <Button key="restart" label={armed('restart') ? (d.working ? `Confirm restart ${id} (it is working: the current step is lost)` : `Confirm restart ${id}`) : blockedWord ? 'Restart' : 'Restart from handover'} onPress={restart} />
        {d.working || d.needsYou ? <Text dimColor>{d.needsYou ? 'waiting for you' : d.run === 'unknown' ? 'session unknown: not closed on a guess' : 'busy'}</Text> : <Button key="close" label={armed('close') ? `Confirm close ${id}` : 'Close'} onPress={close} />}
        <Button key="refresh" label="Refresh" onPress={refresh} />
      </Box>
    </Box>
  )
  const statusCard = fold('status', {
    title: fullTitle,
    chips: [
      <Text key="state" bold color={chipColor}>{`[${chipWord}]`}</Text>,
      costTxt ? <Text key="cost" dimColor>{costTxt}</Text> : null,
      ctxTxt ? <Text key="ctx" color={ctxColor} dimColor={!ctxColor}>{ctxTxt}</Text> : null,
      ageTxt ? <Text key="age" dimColor>{ageTxt}</Text> : null,
    ],
    chipLen: stChipLen,
    color: blockedWord ? chipColor : undefined,
    dim: !blockedWord,
    body: statusBody,
  })

  // ---- 2. REPORT ---- the last report (or question) with its state, "synthesised" when the last line is script-made, and WHY there is none ("ended at once", "no report N min")
  const last = d.reports[0]
  const lastText = last?.text ?? t?.lastReport ?? ''
  const parts = d.liveNote.split(' · ').filter(Boolean)
  const endedAtOnce = parts.some(p => p.includes(ENDED_AT_ONCE))
  const repState = last ? (last.kind === 'ask' ? 'asked' : last.state || 'report') : ''
  const repColor = repState === 'blocked' ? 'error' : repState === 'asked' ? 'warning' : repState === 'done' ? 'success' : undefined
  const repChips: any[] = []
  let repChipLen = 0
  const repChip = (key: string, text: string, o: { color?: string; bold?: boolean; dim?: boolean } = {}) => {
    repChips.push(<Text key={key} bold={o.bold} color={o.color} dimColor={o.dim}>{text}</Text>)
    repChipLen += text.length + 1
  }
  if (repState) repChip('rs', `[${repState}]`, { bold: true, color: repColor, dim: !repColor })
  if (t?.synth) repChip('synth', '[synthesised]', { color: 'warning' })
  if (t?.noReport) repChip('norep', `[${t.noReport}]`, { bold: true, color: 'warning' })
  if (endedAtOnce) repChip('ended', '[ended at once]', { bold: true, color: 'warning' })
  if (last) repChip('rage', ageText(last.ts, now), { dim: true })
  const older = d.reports.slice(1)
  const reportCard = fold('report', {
    title: `Report: ${lastText ? short(lastText, 80) : 'none yet'}`,
    chips: repChips,
    chipLen: repChipLen,
    color: t?.noReport || endedAtOnce ? 'warning' : undefined,
    dim: !(t?.noReport || endedAtOnce),
    body: (
      <Box key="report-body" flexDirection="column">
        <Text key="last" wrap="wrap" dimColor={!lastText}>{lastText || 'No reports yet.'}</Text>
        {t?.synth ? <Text key="synth-note" dimColor wrap="wrap">This line was made by the mod from the last tool result; the thread did not write it.</Text> : null}
        {t?.noReport ? <Text key="norep-note" color="warning" wrap="wrap">{`${t.noReport}: the turn ended with no report (the mod nudges the thread once)`}</Text> : null}
        {endedAtOnce ? <Text key="ended-note" color="warning" wrap="wrap">{ENDED_AT_ONCE}</Text> : null}
        {reasonText ? <Text key="reason" color="warning" wrap="wrap">{short(reasonText, 200)}</Text> : null}
        {older.length > 0 ? <Text key="older" dimColor>{`Earlier reports (${older.length}${d.reportsTotal > d.reports.length ? ` of ${d.reportsTotal - 1}` : ''}, newest first)`}</Text> : null}
        {older.map(r => line(`r${r.n}`, `${stamp(r.ts)} ${r.kind === 'ask' ? '? ' : ''}${r.state ? `[${r.state}] ` : ''}${short(r.text, 70)}`, r.text, r.kind !== 'ask' && r.state !== 'blocked'))}
      </Box>
    ),
  })

  // ---- 3. TO DECIDE ---- everything that waits for the user on THIS thread: its requests (a remote write, a model), a denial, a question, a held send, the session's own prompt
  const myNeeds = (v?.needs ?? []).filter(n => n.thread === id)
  const held = (v?.holds ?? []).filter(h => h.thread === id)
  const hasKind = (k: string) => myNeeds.some(n => n.kind === k)
  const needNode = (n: NeedRow) => {
    const tone = n.kind === 'blocked' && !n.key.startsWith('waiting:') ? 'error' : 'warning'
    const chipText = n.kind === 'question' ? 'question' : n.kind === 'push' ? 'ready to push' : n.kind === 'stalled' ? 'stalled' : n.kind === 'denial' || (n.kind === 'blocked' && !n.key.startsWith('waiting:')) ? 'blocked' : n.kind === 'model' ? 'model' : n.kind === 'action' ? 'write' : n.kind === 'approval' ? 'needs your yes' : 'needs you'
    const mr = n.request
    const ar = n.action
    const tooLong = !!ar && ar.state === 'pending' && ar.text.length > ACTION_CARD_MAX
    return (
      <Box key={`need-${n.key}`} {...cardProps({ color: tone })}>
        <Box flexWrap="wrap" columnGap={1}>
          <Text bold color={tone}>{`[${chipText}]`}</Text>
          {n.kind === 'approval' ? (d!.working ? <Text dimColor>(it is working: wait until it stops)</Text> : <Button key={`decide-open-${id}`} label="Open session" onPress={openSession} />) : null}
          {n.kind === 'denial' && D ? <Button key={`denial-self-${id}`} label={selfEditLabel(id)} onPress={D.selfEditPress(id)} /> : null}
          {n.kind === 'denial' && D ? <Button key={`denial-retry-${id}`} label={RETRY_LABEL} onPress={D.retryPress(id)} /> : null}
          {!!mr && D && mr.state === 'pending' ? <Button key={`model-approve-${mr.id}`} label={armed(`model:approve:${mr.id}`) ? `Confirm approve ${mr.family} for ${mr.thread}` : 'Approve'} onPress={D.approveModel(mr)} /> : null}
          {!!mr && D && mr.state === 'pending' ? <Button key={`model-deny-${mr.id}`} label={armed(`model:deny:${mr.id}`) ? `Confirm deny ${mr.family}` : 'Deny'} onPress={D.denyModel(mr)} /> : null}
          {!!mr && D && mr.origin === 'tool' ? <Button key={`model-sonnet-${mr.id}`} label="Start on sonnet instead" onPress={D.onSonnet(mr)} /> : null}
          {!!mr && D && mr.state === 'denied' ? <Button key={`model-dismiss-${mr.id}`} label="Dismiss" onPress={D.dismissModel(mr)} /> : null}
          {!!ar && D && !tooLong ? <Button key={`action-approve-${ar.id}`} label={armed(`action:approve:${ar.id}`) ? `Confirm: send this text for ${ar.thread}` : ar.state === 'approved' ? 'Send now' : 'Approve'} onPress={D.approveWrite(ar)} /> : null}
          {!!ar && D && ar.state === 'pending' && !!ar.standing && !tooLong ? <Button key={`action-standing-${ar.id}`} label={armed(`action:standing:${ar.id}`) ? `Confirm: ${standingLabelOf(ar.kind).replace(/^Approve/, 'send')}` : standingLabelOf(ar.kind)} onPress={D.approveWriteStanding(ar)} /> : null}
          {!!ar && D && ar.state === 'pending' ? <Button key={`action-deny-${ar.id}`} label={armed(`action:deny:${ar.id}`) ? `Confirm deny for ${ar.thread}` : 'Deny'} onPress={D.denyWrite(ar)} /> : null}
          {!!n.dk && !(mr && mr.state === 'denied') ? <Button key={`dismiss-${n.key}`} label={armed(`dismiss:${n.key}`) ? `Confirm dismiss ${id}` : 'Dismiss'} onPress={dismissNeed(n)} /> : null}
        </Box>
        <Text wrap="wrap">{n.text}</Text>
        {!!ar && ar.state === 'pending' && ar.items && ar.items.length > 0 ? ar.items.map(it => <Text key={`ri-${ar.id}-${it.n}`} wrap="wrap">{`  ${it.n}. ${it.file || 'general'} ${it.where}: ${short(it.text, 120)}`}</Text>) : null}
        {tooLong ? <Text color="warning" wrap="wrap">{`Approve in the desk question: this card cannot approve it (${ar!.text.length} characters, the question shows all of it).`}</Text> : null}
      </Box>
    )
  }
  const decideNodes: any[] = myNeeds.map(needNode)
  // the facts the thread's own data holds that the desk's view did not turn into a card (the view failed, or the state changed between the two reads)
  if (d.approval && !hasKind('approval'))
    decideNodes.push(
      <Box key="need-approval" {...cardProps({ color: 'warning' })}>
        <Box flexWrap="wrap" columnGap={1}>
          <Text bold color="warning">[needs your yes]</Text>
          {d.working ? <Text dimColor>(it is working: wait until it stops)</Text> : <Button key={`decide-open-${id}`} label="Open session" onPress={openSession} />}
        </Box>
        <Text wrap="wrap">{short(d.approval, 160)}</Text>
      </Box>,
    )
  if (d.denial && !hasKind('denial'))
    decideNodes.push(
      <Box key="need-denial" {...cardProps({ color: 'warning' })}>
        <Text bold color="warning">[blocked]</Text>
        <Text wrap="wrap">{d.denial}</Text>
      </Box>,
    )
  if (d.needsYou && !d.approval && myNeeds.length === 0)
    decideNodes.push(
      <Box key="need-session" {...cardProps({ color: 'warning' })}>
        <Box flexWrap="wrap" columnGap={1}>
          <Text bold color="warning">[needs you]</Text>
          <Button key={`decide-open-${id}`} label="Open session" onPress={openSession} />
        </Box>
        <Text wrap="wrap">It waits for you in its own session: press Open session.</Text>
      </Box>,
    )
  for (const h of held)
    decideNodes.push(
      <Box key={`hold-${h.id}`} {...cardProps({ color: 'warning' })}>
        <Box flexWrap="wrap" columnGap={1}>
          <Text bold color="warning">[held send]</Text>
          {D ? <Button key={`hold-now-${h.id}`} label="Send now" onPress={D.holdNow(h.id)} /> : null}
          {D ? <Button key={`hold-cancel-${h.id}`} label="Cancel" onPress={D.holdCancel(h.id)} /> : null}
        </Box>
        <Text wrap="wrap">{`goes out in ${Math.max(0, Math.ceil((h.until - Date.now()) / 1000))} s: ${h.text}`}</Text>
      </Box>,
    )
  const decideN = decideNodes.length
  const decideChip = decideN > 0 ? `${decideN} to decide` : ''
  const decideCard = fold('decide', {
    title: 'To decide',
    chips: decideN > 0 ? [<Text key="n" bold color="warning">{decideChip}</Text>] : [<Text key="n" dimColor>nothing waits</Text>],
    chipLen: decideN > 0 ? decideChip.length : 'nothing waits'.length,
    color: decideN > 0 ? 'warning' : undefined,
    dim: decideN === 0,
    dflt: !cfg.foldAll && decideN > 0,
    body: (
      <Box key="decide-body" flexDirection="column">
        {decideNodes.length ? decideNodes : <Text dimColor>Nothing waits for you on {id}.</Text>}
      </Box>
    ),
  })

  // ---- 4. MESSAGES ---- to the thread (queued / delivered / consumed / failed) and from it (unread first, ack)
  const grp = v?.inbox.find(g => g.from === id)
  const unreadN = grp?.unread.length ?? 0
  const waitingN = x.msgs.filter(m => m.state === 'queued' || m.state === 'delivered').length
  const failedN = x.msgs.filter(m => m.state === 'failed').length
  const fromTotal = grp ? grp.unread.length + grp.read.length : 0
  const msgsAll = isOn('inbox-all')
  const unreadShown = grp?.unread.slice(0, GROUP_ROWS) ?? []
  const readShown = grp ? (msgsAll ? grp.read.slice(0, Math.max(0, GROUP_ROWS - unreadShown.length)) : grp.read.slice(0, READ_SHOWN)) : []
  const inRow = (a: NonNullable<typeof grp>['unread'][number]) =>
    line(`a${a.n}`, `${a.unread ? '● ' : ''}${a.rec.kind === 'ask' ? '? ' : ''}${a.rec.superseded ? '↻ ' : ''}${short(a.rec.text, cols < NARROW ? 28 : 70)}`, `${a.rec.superseded ? '(brief superseded by a later user message) ' : ''}${a.rec.text}${a.rec.options?.length ? ` [options: ${a.rec.options.join(' | ')}]` : ''}`, !a.unread, a.unread ? <Button key={`ack-${a.n}`} label="ack" onPress={ack(a.n)} /> : null)
  const msgChips: any[] = []
  let msgChipLen = 0
  if (unreadN > 0) {
    msgChips.push(<Button key="new-msgs" plain label={`${unreadN} new`} onPress={unfold('messages')} />)
    msgChipLen += `${unreadN} new`.length + 1
  }
  if (waitingN > 0) {
    msgChips.push(<Text key="queued" color="warning">{`${waitingN} queued`}</Text>)
    msgChipLen += `${waitingN} queued`.length + 1
  }
  if (failedN > 0) {
    msgChips.push(<Text key="failed" bold color="error">{`${failedN} failed`}</Text>)
    msgChipLen += `${failedN} failed`.length + 1
  }
  const msgCount = x.msgsTotal + fromTotal
  const messagesCard = fold('messages', {
    title: `Messages (${msgCount})`,
    chips: msgChips,
    chipLen: msgChipLen,
    dim: unreadN === 0 && waitingN === 0 && failedN === 0,
    color: failedN > 0 ? 'error' : unreadN > 0 || waitingN > 0 ? 'warning' : undefined,
    body: (
      <Box key="messages-body" flexDirection="column">
        {msgCount === 0 ? <Text dimColor>No messages.</Text> : null}
        {x.msgs.length > 0 ? <Text key="to" dimColor>{`to ${id}`}</Text> : null}
        {x.msgs.map(m => line(`m${m.n}`, `${stamp(m.at)} [${m.state}] ${m.answer ? '(answer) ' : ''}${short(m.text, 70)}`, `${m.text}${m.state === 'failed' ? ` (failed: ${m.failed ?? 'not delivered'})` : ''}`, m.state === 'consumed'))}
        {x.msgsTotal > x.msgs.length ? <Text key="to-more" dimColor>{`(${x.msgsTotal - x.msgs.length} older not shown)`}</Text> : null}
        {grp ? <Text key="from" dimColor>{`from ${id}`}</Text> : null}
        {unreadShown.map(inRow)}
        {readShown.map(inRow)}
        {grp && grp.read.length > READ_SHOWN && !msgsAll ? <Button key="inbox-more" plain label={`show all (${grp.read.length} read)`} onPress={toggle('inbox-all')} /> : null}
        {msgsAll && grp && grp.read.length > READ_SHOWN ? <Button key="inbox-less" plain label="show fewer" onPress={toggle('inbox-all')} /> : null}
        {grp && grp.unread.length > GROUP_ROWS ? <Text dimColor>{`(${grp.unread.length - GROUP_ROWS} older unread not shown)`}</Text> : null}
        {unreadN > 0 ? (
          <Box key="ack-row" flexWrap="wrap" columnGap={1}>
            <Button key="ack-card" label={`ack ${unreadN}`} onPress={ack(unreadShown.map(a => a.n))} />
          </Box>
        ) : null}
      </Box>
    ),
  })

  // ---- 5. TASK ---- the goal, the brief (first lines until expanded) and the open items of the thread's task list
  const goalRow = v?.goals.find(g => g.id === id)
  const briefLines = d.brief.split('\n').map(l => l.trimEnd())
  const cut = d.brief.length >= BRIEF_MAX // the data keeps the first BRIEF_MAX characters of brief.md
  const briefMore = briefLines.length > BRIEF_LINES || cut
  const briefOpen = isOn('brief')
  const open = openTasks(x)
  const taskChips: any[] = []
  let taskChipLen = 0
  if (goalRow) {
    taskChips.push(<Text key="goal" color={TONE[goalRow.tone]}>{`[goal ${goalRow.tone}]`}</Text>)
    taskChipLen += `[goal ${goalRow.tone}]`.length + 1
  }
  if (open.length > 0) {
    taskChips.push(<Text key="todos" dimColor>{`${open.length} open`}</Text>)
    taskChipLen += `${open.length} open`.length + 1
  }
  const taskCard = fold('task', {
    title: `Task: ${short(d.goal || briefLines[0] || d.title, 70)}`,
    chips: taskChips,
    chipLen: taskChipLen,
    dim: true,
    body: (
      <Box key="task-body" flexDirection="column">
        <Text key="goal-text" dimColor={!d.goal} wrap="wrap">{d.goal ? `goal: ${short(d.goal, 200)}` : 'no goal set'}</Text>
        <Text key="brief">{(briefOpen ? briefLines : briefLines.slice(0, BRIEF_LINES)).join('\n') || '(empty)'}</Text>
        {briefMore ? <Button key="brief-more" plain label={briefOpen ? '▾ show less' : `▸ show all (${briefLines.length} lines${cut ? `, cut at ${BRIEF_MAX} characters; the rest is in brief.md` : ''})`} onPress={toggle('brief')} /> : null}
        {x.tasks.length > 0 ? <Text key="todo-head" dimColor>{`Task list (${open.length} open of ${x.tasks.length})`}</Text> : null}
        {x.tasks.slice(0, TODO_SHOWN).map((k, i) => (
          <Text key={`todo-${i}`} dimColor={!open.includes(k)} wrap="wrap">{`${open.includes(k) ? '☐' : '☑'} ${short(k.text, 120)}`}</Text>
        ))}
        {x.tasks.length > TODO_SHOWN ? <Text dimColor>{`(${x.tasks.length - TODO_SHOWN} more not shown)`}</Text> : null}
      </Box>
    ),
  })

  // ---- 6. RULES ---- the thread's standing rules (Remove; a change goes through the desk: the pane has no text field) and the user's standing approvals for it (Revoke)
  const stand = v?.standing
  const sentGrants = new Set((stand?.sent ?? []).map(s => s.grant).filter(Boolean))
  const wr = v?.writes
  const wrSent = new Set((wr?.sent ?? []).map(s => s.grant).filter(Boolean))
  const apprNodes: any[] = []
  for (const s of (stand?.sent ?? []).filter(s => s.thread === id))
    apprNodes.push(
      <Box key={`std-sent-${s.ts}`} flexWrap="wrap" columnGap={1}>
        <Text wrap="wrap">{s.text}</Text>
        {s.grant && D ? <Button key={`std-revoke-${s.grant}-${s.ts}`} label="Revoke" onPress={D.revokeStanding(s.grant)} /> : null}
      </Box>,
    )
  for (const g of (stand?.grants ?? []).filter(g => g.thread === id && !sentGrants.has(g.id)))
    apprNodes.push(
      <Box key={`std-grant-${g.id}`} flexWrap="wrap" columnGap={1}>
        <Text dimColor wrap="wrap">{`standing approval for status changes on ${g.scope.replace(/^(Azure DevOps|GitHub) /, '')} until ${new Date(g.exp).toISOString().slice(11, 16)} UTC`}</Text>
        {D ? <Button key={`std-revoke-${g.id}`} label="Revoke" onPress={D.revokeStanding(g.id)} /> : null}
      </Box>,
    )
  for (const s of (wr?.sent ?? []).filter(s => s.thread === id))
    apprNodes.push(
      <Box key={`wr-sent-${s.ts}`} flexWrap="wrap" columnGap={1}>
        <Text wrap="wrap">{s.text}</Text>
        {s.grant && D ? <Button key={`wr-revoke-${s.grant}-${s.ts}`} label="Revoke" onPress={D.revokeWritten(s.grant)} /> : null}
      </Box>,
    )
  for (const g of (wr?.grants ?? []).filter(g => g.thread === id && !wrSent.has(g.id)))
    apprNodes.push(
      <Box key={`wr-grant-${g.id}`} flexWrap="wrap" columnGap={1}>
        <Text dimColor wrap="wrap">{`your instruction '${g.quote.slice(0, 80)}' allows ${g.kinds.join(', ')} on ${g.scope.replace(/^(Azure DevOps|GitHub) /, '')} (${g.used}/${g.cap} writes) until ${new Date(g.exp).toISOString().slice(11, 16)} UTC`}</Text>
        {D ? <Button key={`wr-revoke-${g.id}`} label="Revoke" onPress={D.revokeWritten(g.id)} /> : null}
      </Box>,
    )
  for (const g of (v?.selfEdit?.grants ?? []).filter(g => g.thread === id))
    apprNodes.push(
      <Box key={`se-grant-${g.id}`} flexWrap="wrap" columnGap={1}>
        <Text dimColor wrap="wrap">{`${paneLine(g)} until ${new Date(g.exp).toISOString().slice(11, 16)} UTC`}</Text>
        {D ? <Button key={`se-revoke-${g.id}`} label="Revoke" onPress={D.revokeSelfEditPress(g.id)} /> : null}
      </Box>,
    )
  const rulesCard = fold('rules', {
    title: `Rules (${x.rules.length})`,
    chips: apprNodes.length > 0 ? [<Text key="appr" dimColor>{`${apprNodes.length} approval${apprNodes.length === 1 ? '' : 's'}`}</Text>] : [],
    chipLen: apprNodes.length > 0 ? `${apprNodes.length} approvals`.length : 0,
    dim: true,
    body: (
      <Box key="rules-body" flexDirection="column">
        {x.rules.map(r => (
          <Box key={`rule-${r.id}`} flexWrap="wrap" columnGap={1}>
            <Text wrap="wrap">{`${r.id} ${short(r.text, 140)}`}</Text>
            <Button key={`rule-remove-${r.id}`} label={armed(`rule:${r.id}`) ? `Confirm remove ${r.id}` : 'Remove'} onPress={removeRule(r.id)} />
          </Box>
        ))}
        <Text key="rules-hint" dimColor wrap="wrap">
          {x.rules.length ? `To change a rule, tell the desk: "edit ${x.rules[0]!.id} <new text>" (the pane has no text field).` : `No standing rules. To add one, tell the desk: "rule ${id} <text>".`}
        </Text>
        {apprNodes.length > 0 ? <Text key="appr-head" dimColor>Standing approvals</Text> : null}
        {apprNodes}
      </Box>
    ),
  })

  // ---- 7. FILES ---- what the thread changed (the diff against its base and the review of HEAD), its scratch notes and drafts
  const changedN = d.diff ? d.diff.files.length + d.diff.more : 0
  const rv = d.review
  const filesChips: any[] = []
  let filesChipLen = 0
  const addChip = (key: string, text: string, color?: string, dim = false) => {
    filesChips.push(<Text key={key} color={color} dimColor={dim}>{text}</Text>)
    filesChipLen += text.length + 1
  }
  if (changedN > 0) addChip('changed', `${changedN} changed`, undefined, true)
  if (x.scratch.length > 0) addChip('scratch', `${x.scratch.length} scratch`, undefined, true)
  if (rv && rv.verdict === 'green') addChip('review', '[review green]', 'success')
  else if (rv && rv.verdict !== 'none') addChip('review', `[review ${rv.verdict}]`, 'warning')
  const filesCard = fold('files', {
    title: 'Files',
    chips: filesChips,
    chipLen: filesChipLen,
    dim: true,
    body: (
      <Box key="files-body" flexDirection="column">
        {d.diff ? (
          <Box key="diff" flexDirection="column">
            <Text dimColor>{`diff against ${d.diff.base}: ${d.diff.summary || 'no changes'}`}</Text>
            {d.diff.files.map((f, i) => (
              <Text key={`df-${i}`} dimColor>
                {`  ${f}`}
              </Text>
            ))}
            {d.diff.more > 0 ? <Text dimColor>{`  … and ${d.diff.more} more file(s)`}</Text> : null}
          </Box>
        ) : (
          <Text dimColor wrap="wrap">{d.diffNote || 'no diff'}</Text>
        )}
        {rv ? (
          <Box key="review" flexDirection="column">
            <Text color={rv.verdict === 'green' ? 'green' : rv.verdict === 'none' ? undefined : 'yellow'} dimColor={rv.verdict === 'none'}>
              {rv.verdict === 'none'
                ? `no review recorded for HEAD ${rv.sha.slice(0, 8)}`
                : `HEAD ${rv.sha.slice(0, 8)}: ${rv.verdict}${rv.verdict === 'unverified' ? ' (the record says green, its signature does not check)' : ''}${rv.passes ? ` · ${rv.passes} pass(es)` : ''}${rv.ts ? ` · ${stamp(rv.ts)}` : ''}`}
            </Text>
            {rv.verdict !== 'none' && !rv.findings.length ? <Text dimColor>no open findings</Text> : null}
            {rv.findings.map((f, i) => (
              <Text key={`rf-${i}`} color="yellow" wrap="wrap">
                {short(f, 200)}
              </Text>
            ))}
          </Box>
        ) : (
          <Text dimColor>{d.worktree ? 'no HEAD to look up a review for' : 'no worktree, so no review record to look up'}</Text>
        )}
        {x.scratch.length > 0 ? <Text key="scratch-head" dimColor>{`Scratch notes and drafts (${x.scratch.length})`}</Text> : <Text key="scratch-none" dimColor>No scratch files.</Text>}
        {x.scratch.map(f => (
          <Text key={`sf-${f.name}`} dimColor wrap="wrap">
            {`  ${f.name} (${sizeText(f.size)})${f.first ? `: ${short(f.first, 80)}` : ''}`}
          </Text>
        ))}
      </Box>
    ),
  })

  // ---- 8. HEALTH ---- this thread only: quiet grey when nothing is wrong, highlighted (amber, red for a real blocker) only with a fix
  const wtGone = !!d.worktree && !d.worktree.exists
  const fixNodes: any[] = []
  const fixRow = (key: string, text: string, color?: string) =>
    fixNodes.push(
      <Box key={key} flexWrap="wrap" columnGap={1}>
        <Text bold color="warning">[fix]</Text>
        <Text wrap="wrap" color={color}>{text}</Text>
      </Box>,
    )
  for (const [i, m] of [...d.errors, ...x.errors].entries()) fixNodes.push(<Text key={`err-${i}`} color="red" wrap="wrap">{`error: ${m}`}</Text>)
  for (const [i, p] of parts.filter(p => !p.includes(ENDED_AT_ONCE)).entries()) fixRow(`live-${i}`, p, d.live === 'stuck' ? 'red' : undefined)
  if (wtGone) fixRow('wt-gone', `the worktree ${d.worktree!.path} is gone`)
  if (d.ctx?.level === 'over') fixRow('ctx-over', `${d.ctx.text}: over the limit`)
  const infoNodes: any[] = []
  const info = (key: string, text: string) => infoNodes.push(<Text key={key} dimColor wrap="wrap">{text}</Text>)
  if (x.refusals.n > 0) info('refusals', `${x.refusals.n} guard refusal${x.refusals.n === 1 ? '' : 's'} in the last 24 h${x.refusals.last ? ` (last: ${short(x.refusals.last, 100)})` : ''}`)
  if (d.run === 'unknown') info('unknown', 'session unknown (claude agents failed): not closed on a guess')
  const blocker = d.errors.length > 0 || x.errors.length > 0 || d.live === 'stuck'
  const hs = healthSummary({ fix: fixNodes.length, standing: 0, info: infoNodes.length, blocker })
  const healthCard = fold('health', {
    title: hs.label,
    chips: [hs.chip ? <Text key="fix" bold color={hs.tone === 'error' ? 'error' : 'warning'}>{hs.chip}</Text> : null, hs.extra ? <Text key="extra" dimColor>{hs.extra}</Text> : null],
    chipLen: (hs.chip ? hs.chip.length + 1 : 0) + (hs.extra ? hs.extra.length + 1 : 0),
    color: hs.tone === 'error' ? 'error' : hs.tone === 'warning' ? 'warning' : undefined,
    dim: hs.tone === 'quiet',
    body: (
      <Box key="health-body" flexDirection="column">
        {fixNodes}
        {infoNodes}
        {fixNodes.length + infoNodes.length === 0 ? <Text dimColor>Nothing to fix.</Text> : null}
      </Box>
    ),
  })

  const noticeCard = st.notice ? (
    <Box key="notice" {...cardProps({ color: st.bad ? 'error' : 'warning' })}>
      <Box flexWrap="wrap" columnGap={1}>
        <Text color={st.bad ? 'red' : 'yellow'}>{st.notice}</Text>
        <Button key="notice-dismiss" label="Dismiss" onPress={async () => { st.notice = ''; tell() }} />
      </Box>
    </Box>
  ) : null
  return (
    <Box flexDirection="column">
      {noticeCard}
      {statusCard}
      {reportCard}
      {decideCard}
      {messagesCard}
      {taskCard}
      {rulesCard}
      {filesCard}
      {healthCard}
    </Box>
  )
}
