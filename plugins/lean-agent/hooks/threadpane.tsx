// The thread detail pane: one pane per thread (`lean-agent-thread-<tN>`, titled "tN · <title>"), opened from the desk pane's buttons
// through openThreadPane. Several may be open at once; each draw reads its own thread's data (threaddetail.ts), so they never share a
// view. Buttons: Open session (the 1.0.10 "Open tN" path), Restart and Close (two presses), Refresh. All logic is the lean_thread
// tool's own code (leanThread), so it exists once. A closed or missing thread draws a short message, never a blank pane.
import { BRIEF_MAX, loadThreadDetail, resetThreadCache, threadTitle } from './threaddetail'
import type { ThreadDetail } from './threaddetail'
import { leanThread } from './threads'
import { CONFIRM_MS } from './panestate'
import { bounded, openThreadSession } from './setup'
import { resetViewCache } from './view'
import { hostOf } from './host'
import type { Role } from './role'

export const THREAD_PANE_PREFIX = 'lean-agent-thread-'
export const threadPaneId = (id: string) => `${THREAD_PANE_PREFIX}${id}`
// the thread a pane id belongs to, or null (another pane, or an id that is no thread number)
export const threadOfPane = (requestId: unknown): string | null => {
  const m = typeof requestId === 'string' ? /^lean-agent-thread-(t\d{1,9})$/.exec(requestId) : null
  return m ? m[1]! : null
}

const BRIEF_LINES = 4 // brief lines drawn until expanded
const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/\s+/g, ' ')
const usd = (n: number) => `$${n.toFixed(2)}`
const stamp = (ts: number) => (Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ') : '?')
const msg = (err: unknown, n = 160) => String((err as Error)?.message ?? err).slice(0, n)

// per-pane view state: which rows are expanded, a pending two-press, the last notice. Module state (a mod reload closes the panes'
// folds, never data); resetThreadPanes() is called with the other pane state at a session start.
type PaneState = { open: Set<string>; confirm: { key: string; until: number } | null; notice: string; bad: boolean; surface?: string }
const panes = new Map<string, PaneState>()
const stateOf = (id: string): PaneState => {
  let s = panes.get(id)
  if (!s) panes.set(id, (s = { open: new Set(), confirm: null, notice: '', bad: false }))
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

// ---- the draw ----
// Never blank: anything the draw throws becomes one red line (the pane's own rule, as in pane.tsx)
export async function drawThreadPane($: any, e: any, id: string, roleOf: () => Role): Promise<any> {
  try {
    return await paint($, e, id, roleOf)
  } catch (err) {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text bold>{id}</Text>
        <Text color="red">{`error: could not draw ${id}: ${msg(err)}`}</Text>
      </Box>
    )
  }
}

async function paint($: any, e: any, id: string, roleOf: () => Role): Promise<any> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const host = hostOf($)
  const st = stateOf(id)
  const surface = typeof e?.surface === 'string' && e.surface ? e.surface : st.surface
  const tell = () => $.ui.invalidate('ui.render')
  if (roleOf().kind !== 'desk') {
    return (
      <Box flexDirection="column">
        <Text bold>{id}</Text>
        <Text>Thread panes belong to the desk: open this from the desk session&apos;s pane.</Text>
      </Box>
    )
  }
  let d: ThreadDetail | null = null
  let fatal = ''
  try {
    d = await loadThreadDetail(host, id)
  } catch (err) {
    fatal = `could not read ${id}: ${msg(err)}`
  }
  if (!d) {
    return (
      <Box flexDirection="column">
        <Text bold>{id}</Text>
        <Text color={fatal ? 'red' : 'yellow'}>{fatal || `${id} does not exist (no such thread).`}</Text>
        <Button key="refresh" label="Refresh" onPress={async () => { resetThreadCache(); tell() }} />
      </Box>
    )
  }
  if (d.state === 'closed') {
    return (
      <Box flexDirection="column">
        <Text bold>
          {id} · {short(d.title, 60)}
        </Text>
        <Text dimColor>{id} is closed. Reopen it from the desk pane to work on it again.</Text>
      </Box>
    )
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
  const toggle = (key: string) => async () => {
    if (st.open.has(key)) st.open.delete(key)
    else st.open.add(key)
    tell()
  }
  const settle = () => {
    resetViewCache()
    resetThreadCache()
  }
  const openSession = async () => {
    st.confirm = null
    settle()
    const r = await bounded($, openThreadSession(host, id, () => leanThread(host, $.plugin.root, { action: 'release', tN: id }), surface), `open ${id}`, 60_000).catch(err => ({ ok: false, text: `open ${id} failed: ${msg(err)}` }))
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

  const runLabel = d.run === 'unknown' ? 'session unknown (claude agents failed)' : d.live === 'stuck' ? 'stuck' : d.run
  const briefLines = d.brief.split('\n').map(l => l.trimEnd())
  const cut = d.brief.length >= BRIEF_MAX // the data keeps the first BRIEF_MAX characters of brief.md
  const briefMore = briefLines.length > BRIEF_LINES || cut
  const briefOpen = st.open.has('brief')
  const row = (key: string, label: string, body: string, dim = false) => {
    const on = st.open.has(key)
    return (
      <Box key={`row-${key}`} flexDirection="column">
        <Button key={`btn-${key}`} plain dimColor={dim} label={`${on ? '▾' : '▸'} ${label}`} onPress={toggle(key)} />
        {on && <Text>{body}</Text>}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text bold>
        {id} · {short(d.title, 70)}
      </Text>
      <Text>
        {d.state} · {runLabel}
        {d.finished ? ' · finished (the next message starts a new session)' : ''} · {d.model ? `${d.model}/${d.effort ?? '?'}` : 'model not recorded'} · project: {d.project || 'none'}
      </Text>
      {!!d.ctx && <Text color={d.ctx.level === 'over' ? 'red' : d.ctx.level === 'warn' ? 'yellow' : undefined} dimColor={d.ctx.level === 'ok' || d.ctx.level === 'unknown'}>{`${d.ctx.text}${d.keep ? ' · keep mode: a done session is resumed until the limit' : ''}${d.ctx.level === 'over' ? ' · over the limit: the next message starts a new session' : ''}`}</Text>}
      {!!d.liveNote && <Text color={d.live === 'stuck' ? 'red' : 'yellow'}>{d.liveNote}</Text>}
      {d.needsYou && <Text color="yellow">It waits for you in its own session: press Open session.</Text>}
      {!!d.approval && <Text color="yellow">{`needs your yes: ${short(d.approval, 160)}`}</Text>}
      <Text bold>Goal</Text>
      <Text dimColor={!d.goal}>{d.goal ? short(d.goal, 200) : 'no goal set'}</Text>
      <Text bold>Brief</Text>
      <Text>{(briefOpen ? briefLines : briefLines.slice(0, BRIEF_LINES)).join('\n') || '(empty)'}</Text>
      {briefMore && <Button key="brief-more" plain label={briefOpen ? '▾ show less' : `▸ show all (${briefLines.length} lines${cut ? `, cut at ${BRIEF_MAX} characters; the rest is in brief.md` : ''})`} onPress={toggle('brief')} />}
      <Text bold>Work</Text>
      {d.worktree ? (
        <Text color={d.worktree.exists ? undefined : 'yellow'}>
          {`branch ${d.worktree.branch ?? '(not recorded)'} · worktree ${d.worktree.path}${d.worktree.exists ? '' : ' (gone)'}`}
        </Text>
      ) : (
        <Text dimColor>no worktree registered for this thread</Text>
      )}
      {d.diff ? (
        <Box flexDirection="column">
          <Text dimColor>{`diff against ${d.diff.base}: ${d.diff.summary || 'no changes'}`}</Text>
          {d.diff.files.map((f, i) => (
            <Text key={`df-${i}`} dimColor>
              {`  ${f}`}
            </Text>
          ))}
          {d.diff.more > 0 && <Text dimColor>{`  … and ${d.diff.more} more file(s)`}</Text>}
        </Box>
      ) : (
        !!d.diffNote && <Text dimColor>{d.diffNote}</Text>
      )}
      <Text bold>Review</Text>
      {d.review ? (
        <Box flexDirection="column">
          <Text color={d.review.verdict === 'green' ? 'green' : d.review.verdict === 'none' ? undefined : 'yellow'} dimColor={d.review.verdict === 'none'}>
            {d.review.verdict === 'none'
              ? `no review recorded for HEAD ${d.review.sha.slice(0, 8)}`
              : `HEAD ${d.review.sha.slice(0, 8)}: ${d.review.verdict}${d.review.verdict === 'unverified' ? ' (the record says green, its signature does not check)' : ''}${d.review.passes ? ` · ${d.review.passes} pass(es)` : ''}${d.review.ts ? ` · ${stamp(d.review.ts)}` : ''}`}
          </Text>
          {d.review.verdict !== 'none' && !d.review.findings.length && <Text dimColor>no open findings</Text>}
          {d.review.findings.map((f, i) => (
            <Text key={`rf-${i}`} color="yellow">
              {short(f, 200)}
            </Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>{d.worktree ? 'no HEAD to look up a review for' : 'no worktree, so no review record to look up'}</Text>
      )}
      <Text bold>Cost</Text>
      <Text dimColor={!d.cost}>{d.cost ? `today ${usd(d.cost.today)} · total ${usd(d.cost.total)} (the ledger's rollup, the last 120 days)` : 'cost not available'}</Text>
      <Text bold>{`Reports (${d.reports.length}${d.reportsTotal > d.reports.length ? ` of ${d.reportsTotal}` : ''}, newest first)`}</Text>
      {!d.reports.length && <Text dimColor>No reports yet.</Text>}
      {d.reports.map(r => row(`r${r.n}`,`${stamp(r.ts)} ${r.kind === 'ask' ? '? ' : ''}${r.state ? `[${r.state}] ` : ''}${short(r.text, 70)}`, r.text, r.kind !== 'ask' && r.state !== 'blocked'))}
      <Text bold>{`Queued messages (${d.queuedTotal})`}</Text>
      {!d.queued.length && <Text dimColor>None queued.</Text>}
      {d.queued.map((q, i) => row(`q${d.queuedTotal - d.queued.length + i}`,`${stamp(q.ts)} ${q.from ? `[${q.from}] ` : ''}${short(q.text, 70)}`, q.text))}
      {d.queuedTotal > d.queued.length && <Text dimColor>{`(${d.queuedTotal - d.queued.length} older not shown)`}</Text>}
      <Box>
        <Button key="open-session" label="Open session" onPress={openSession} />
        <Button key="restart" label={armed('restart') ? (d.working ? `Confirm restart ${id} (it is working: the current step is lost)` : `Confirm restart ${id}`) : 'Restart'} onPress={restart} />
        {d.working || d.needsYou ? <Text dimColor>{d.needsYou ? 'waiting for you' : d.run === 'unknown' ? 'session unknown: not closed on a guess' : 'busy'}</Text> : <Button key="close" label={armed('close') ? `Confirm close ${id}` : 'Close'} onPress={close} />}
        <Button key="refresh" label="Refresh" onPress={refresh} />
      </Box>
      {!!st.notice && <Text color={st.bad ? 'red' : 'yellow'}>{st.notice}</Text>}
      {d.errors.map((m, i) => (
        <Text key={`err-${i}`} color="red">
          {`error: ${m}`}
        </Text>
      ))}
    </Box>
  )
}
