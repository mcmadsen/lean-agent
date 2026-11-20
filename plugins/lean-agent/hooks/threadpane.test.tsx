// The thread detail pane: its data (threaddetail.ts), what it draws with full and with empty data, its buttons, several panes at once.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { resetViewCache } from './view'
import { hostOf } from './host'
import { writeReview } from './reviews'
import { loadThreadDetail, parseStat, resetThreadCache } from './threaddetail'
import { openThreadPane, resetThreadPanes, threadOfPane, threadPaneId } from './threadpane'

const SID = '11111111-2222-3333-4444-555555555555'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const WT = '/h/.lean-agent/worktrees/app/feat-one'
const ROOT = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
const DAY = 86_400_000
const paneProps = { title: 't', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const pane = (id: string, surface = 'terminal') => ({ plugin: 'lean-agent', component: 'Pane', requestId: threadPaneId(id), surface, props: paneProps }) as any
const inDesk = ($: any) => $.session.start({ cwd: '/h/lean-agent-desk', surface: 'desktop', isInteractive: true } as any)
const ok = (stdout = '') => ({ exitCode: 0, stdout })
const no = { exitCode: 1, stdout: '' }

// A world: t1 with everything (brief, goal, worktree, review, cost, 12 reports, 2 queued messages), t2 with nothing, t3 closed.
function world(on: any = null, o: { full?: boolean; rows?: any[] } = {}) {
  resetLocks()
  resetViewCache()
  resetThreadCache()
  resetThreadPanes()
  const h = fakeHost(on)
  h.clock.t = 5 * DAY + 1000
  const f = (p: string, v: unknown) => h.files.set(`/h/.lean-agent/${p}`, typeof v === 'string' ? v : JSON.stringify(v))
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  f('threads/t2/thread.json', { id: 't2', title: 'empty one', project: '', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 })
  f('threads/t3/thread.json', { id: 't3', title: 'gone one', project: '', state: 'closed', sid: '', created: 1, lastWake: 0, delivered: 0 })
  if (o.full !== false) {
    f('threads/t1/thread.json', { id: 't1', title: 'add the widget', project: 'app', state: 'open', sid: SID, created: 1, lastWake: 0, delivered: 0, model: 'sonnet', effort: 'high' })
    f('threads/t1/brief.md', ['Add the widget to the settings page.', 'Keep the old layout.', 'Line three', 'Line four', 'Line five tail', ''].join('\n'))
    f('threads/t1/inbox.jsonl', [{ ts: 100, text: 'please also rename it', from: 'desk' }, { ts: 200, text: 'and add a test' }].map(r => JSON.stringify(r)).join('\n') + '\n')
    f('goals.json', { t1: { text: 'widget merged', ts: 1 } })
    f('projects.json', { app: { path: '/r/app' } })
    f('worktrees.json', { 'app/feat-one': { path: WT, repo: '/r/app', branch: 'feat-one', thread: 't1' } })
    h.files.set(`${WT}/.git`, 'gitdir: /r/app/.git/worktrees/feat-one')
    const recs = Array.from({ length: 12 }, (_, i) => ({ ts: 1000 + i, from: 't1', kind: 'report', state: i === 11 ? 'done' : 'working', text: `report number ${i + 1}` }))
    f('desk/inbox.jsonl', [...recs, { ts: 5000, from: 't9', kind: 'report', text: 'other thread' }].map(r => JSON.stringify(r)).join('\n') + '\n')
    // spend: today $1.25 and $0.75 two days ago for t1, $9 for another thread today
    const row = (ts: number, tN: string, usd: number) => JSON.stringify({ ts, role: 'thread', tN, model: 'sonnet', usd })
    f('ledger.jsonl', [row(h.clock.t - 10, 't1', 1.25), row(h.clock.t - 2 * DAY, 't1', 0.75), row(h.clock.t - 20, 't9', 9)].join('\n') + '\n')
  }
  h.git.handler = a => {
    let rest = a.slice(2) // after `-C <path>`
    while (rest[0] === '-c') rest = rest.slice(2) // and the `-c key=value` pairs
    if (rest[0] === 'rev-parse' && rest[1] === 'HEAD') return ok(`${HEAD}\n`)
    if (rest[0] === 'rev-parse' && rest.includes('--verify')) {
      const ref = String(rest[rest.length - 1]).replace(/\^\{commit\}$/, '')
      return ref === HEAD ? ok(HEAD) : ref === 'main' || ref === BASE ? ok(BASE) : no
    }
    if (rest[0] === 'merge-base') return ok(BASE)
    if (rest[0] === 'diff' && rest.includes('--stat')) return ok(' src/widget.ts | 30 ++++++++++++\n test/widget.test.ts | 12 +++++\n 2 files changed, 42 insertions(+)\n')
    return no
  }
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents') return ok(JSON.stringify(o.rows ?? []))
    if (a[0] === '--bg') return ok(`started ${SID}\n`)
    return ok()
  }
  if (on) {
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
    // the pane reads through the engine's store: the review key lives in the fake host's store (writeReview), so the two are one
    on('store.get', (_: any, e: any) => ({ value: h.store.get(e.key) }))
    on('store.set', (_: any, e: any) => { h.store.set(e.key, e.value); return { value: undefined } })
  }
  return h
}
const idleRow = (o: Record<string, unknown> = {}) => ({ sessionId: SID, id: SID.slice(0, 8), name: 't1 · x', cwd: '/h/.lean-agent/threads/t1', startedAt: 1, status: 'idle', state: 'done', ...o })
const text = async (ui: any, re: RegExp) => !!(await ui.find({ type: 'Text', text: re }))

test('pane ids: only lean-agent-thread-tN names a thread', () => {
  expect(threadPaneId('t7')).toBe('lean-agent-thread-t7')
  expect(threadOfPane('lean-agent-thread-t7')).toBe('t7')
  for (const x of ['lean-agent', 'lean-agent-new-thread', 'lean-agent-thread-', 'lean-agent-thread-7', 'lean-agent-thread-t7x', undefined, 5]) expect(threadOfPane(x)).toBeNull()
})

test('parseStat: files, the summary line, and a long list cut with "+N more"', () => {
  expect(parseStat(' a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n')).toEqual({ files: ['a.ts | 2 +-'], more: 0, summary: '1 file changed, 1 insertion(+), 1 deletion(-)' })
  const many = Array.from({ length: 40 }, (_, i) => ` f${i}.ts | 1 +`).join('\n') + '\n 40 files changed, 40 insertions(+)\n'
  const r = parseStat(many)
  expect([r.files.length, r.more, r.summary]).toEqual([12, 28, '40 files changed, 40 insertions(+)'])
  expect(parseStat('')).toEqual({ files: [], more: 0, summary: '' })
})

test('data, full: brief, goal, worktree, diff stat against the base, the signed review for HEAD, cost today and total, 10 newest reports, queued', async () => {
  const h = world()
  await writeReview(h.host, { project: 'app', sha: HEAD, green: true, passes: 2, findings: ['1. [minor] src/widget.ts:3 name the option -> rename'], base: 'main' })
  const d = (await loadThreadDetail(h.host, 't1'))!
  expect(d.errors).toEqual([])
  expect([d.title, d.project, d.state, d.model, d.effort]).toEqual(['add the widget', 'app', 'open', 'sonnet', 'high'])
  expect(d.brief.split('\n')[0]).toBe('Add the widget to the settings page.')
  expect(d.goal).toBe('widget merged')
  expect(d.worktree).toEqual({ path: WT, branch: 'feat-one', exists: true })
  expect(d.diff?.summary).toBe('2 files changed, 42 insertions(+)')
  expect(d.diff?.files).toEqual(['src/widget.ts | 30 ++++++++++++', 'test/widget.test.ts | 12 +++++'])
  // the worktree path comes from a file a thread can write: no fsmonitor, no hooks of that repo
  expect(h.calls.some(c => c.argv.join(' ') === `git -C ${WT} -c core.fsmonitor=false -c core.hooksPath=/dev/null diff --stat --no-color --no-ext-diff ${BASE}...HEAD`)).toBe(true)
  expect(d.review).toMatchObject({ sha: HEAD, verdict: 'green', passes: 2, findings: ['1. [minor] src/widget.ts:3 name the option -> rename'] })
  expect(d.cost).toEqual({ today: 1.25, total: 2 })
  expect(d.reportsTotal).toBe(12)
  expect(d.reports.map(r => r.text)).toEqual(Array.from({ length: 10 }, (_, i) => `report number ${12 - i}`)) // newest first, only t1's
  expect(d.queued.map(q => q.text)).toEqual(['please also rename it', 'and add a test'])
  expect(d.run).toBe('idle')
})

test('data: a review whose signature does not check is "unverified", never green; a missing one is "none"; a bad base falls back to the default branch', async () => {
  const h = world()
  h.files.set(`/h/.lean-agent/app/reviews/${HEAD}.json`, JSON.stringify({ green: true, sha: HEAD, project: 'app', sig: 'forged', base: 'gone-branch' }))
  const d = (await loadThreadDetail(h.host, 't1'))!
  expect(d.review?.verdict).toBe('unverified')
  expect(d.diff?.summary).toBe('2 files changed, 42 insertions(+)') // base 'gone-branch' does not resolve: the default branch is used
  h.files.delete(`/h/.lean-agent/app/reviews/${HEAD}.json`)
  resetThreadCache()
  expect((await loadThreadDetail(h.host, 't1'))!.review?.verdict).toBe('none')
})

test('data: a hostile base in the review record (an option, a range) never reaches git; the default branch is used instead', async () => {
  const h = world()
  for (const base of ['--output=/h/pwned', 'a..b', '-x', 'main --stat']) {
    resetThreadCache()
    h.files.set(`/h/.lean-agent/app/reviews/${HEAD}.json`, JSON.stringify({ green: false, sha: HEAD, project: 'app', base }))
    const d = (await loadThreadDetail(h.host, 't1'))!
    expect(d.diff?.summary, base).toBe('2 files changed, 42 insertions(+)')
    expect(h.calls.filter(c => c.argv[0] === 'git').some(c => c.argv.some(x => x.includes('--output') || x === base)), base).toBe(false)
  }
})

test('data: the git answer is kept 15 s, dropped by Refresh, and a failed diff is not kept', async () => {
  const h = world()
  const diffs = () => h.calls.filter(c => c.argv.includes('--stat')).length
  await loadThreadDetail(h.host, 't1')
  await loadThreadDetail(h.host, 't1')
  expect(diffs()).toBe(1)
  h.clock.t += 16_000
  await loadThreadDetail(h.host, 't1')
  expect(diffs()).toBe(2)
  resetThreadCache()
  await loadThreadDetail(h.host, 't1')
  expect(diffs()).toBe(3)
  const real = h.git.handler
  h.git.handler = (a, c) => (a.includes('--stat') ? no : real(a, c))
  resetThreadCache()
  expect((await loadThreadDetail(h.host, 't1'))!.diffNote).toContain('did not answer')
  h.git.handler = real
  expect((await loadThreadDetail(h.host, 't1'))!.diff?.summary).toBe('2 files changed, 42 insertions(+)') // the failure was not remembered
})

test('data, empty: no worktree, no reports, no queue, no goal; closed and missing threads', async () => {
  const h = world()
  const d = (await loadThreadDetail(h.host, 't2'))!
  expect(d.errors).toEqual([])
  expect([d.worktree, d.diff, d.review, d.reports, d.queued, d.goal]).toEqual([undefined, undefined, undefined, [], [], ''])
  expect(d.diffNote).toContain('no worktree')
  expect(d.cost).toEqual({ today: 0, total: 0 })
  expect(d.brief).toBe('empty one') // no brief.md: the title
  expect((await loadThreadDetail(h.host, 't3'))!.state).toBe('closed')
  expect(await loadThreadDetail(h.host, 't99')).toBeNull()
  expect(await loadThreadDetail(h.host, '../x')).toBeNull()
})

test('data: a worktree that is gone is said, not diffed; an unreadable session listing counts as working', async () => {
  const h = world()
  h.files.delete(`${WT}/.git`)
  const d = (await loadThreadDetail(h.host, 't1'))!
  expect(d.worktree?.exists).toBe(false)
  expect(d.diffNote).toContain('is gone')
  expect(h.calls.some(c => c.argv[0] === 'git')).toBe(false)
  h.claude.handler = () => ({ exitCode: 1, stdout: '' })
  resetThreadCache()
  const u = (await loadThreadDetail(h.host, 't1'))!
  expect([u.run, u.working]).toEqual(['unknown', true])
})

test('draw, full: every section, the buttons, and only the 10 newest reports (older ones are counted)', async ($, on) => {
  world(on)
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  expect(await text(ui, /t1 · add the widget/)).toBe(true)
  expect(await text(ui, /open · idle · sonnet\/high · project: app/)).toBe(true)
  expect(await text(ui, /widget merged/)).toBe(true)
  expect(await text(ui, /Keep the old layout\./)).toBe(true)
  expect(await text(ui, /Line four/)).toBe(true)
  expect(await text(ui, /Line five tail/)).toBe(false) // the brief shows its first 4 lines until expanded
  expect(await text(ui, /branch feat-one · worktree \/h\/\.lean-agent\/worktrees\/app\/feat-one/)).toBe(true)
  expect(await text(ui, /diff against bbbbbbbbbbbb: 2 files changed, 42 insertions\(\+\)/)).toBe(true)
  expect(await text(ui, /src\/widget\.ts \| 30/)).toBe(true)
  expect(await text(ui, /no review recorded for HEAD aaaaaaaa/)).toBe(true)
  expect(await text(ui, /today \$1\.25 · total \$2\.00/)).toBe(true)
  expect(await text(ui, /Reports \(10 of 12, newest first\)/)).toBe(true)
  expect(await text(ui, /Queued messages \(2\)/)).toBe(true)
  expect(await ui.find({ type: 'Button', text: /report number 12/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /report number 3$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: /report number 2$/ })).toBeFalsy()
  for (const t of ['Open session', 'Restart', 'Close', 'Refresh']) expect(await ui.find({ type: 'Button', text: t })).toBeTruthy()
  await ui.unmount()
})

test('draw: a report row and the brief expand and fold; the review shows green with its open findings', async ($, on) => {
  const h = world(on)
  await writeReview(h.host, { project: 'app', sha: HEAD, green: true, passes: 3, findings: ['1. [minor] src/widget.ts:3 name the option'], base: 'main' })
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  expect(await text(ui, new RegExp(`HEAD aaaaaaaa: green · 3 pass\\(es\\)`))).toBe(true)
  expect(await text(ui, /1\. \[minor\] src\/widget\.ts:3 name the option/)).toBe(true)
  await ui.press({ key: 'brief-more' })
  expect(await text(ui, /Line five tail/)).toBe(true)
  await ui.press({ key: 'brief-more' })
  expect(await text(ui, /Line five tail/)).toBe(false)
  expect(await text(ui, /^report number 12$/)).toBe(false)
  await ui.press({ key: 'btn-r11' })
  expect(await text(ui, /^report number 12$/)).toBe(true)
  await ui.unmount()
})

test('draw, empty: a thread with nothing to show draws every section as a short line, never blank', async ($, on) => {
  world(on)
  await inDesk($)
  const ui = await $.ui.mount(pane('t2'))
  expect(await text(ui, /t2 · empty one/)).toBe(true)
  expect(await text(ui, /no goal set/)).toBe(true)
  expect(await text(ui, /no worktree registered/)).toBe(true)
  expect(await text(ui, /no worktree, so no review record/)).toBe(true)
  expect(await text(ui, /No reports yet\./)).toBe(true)
  expect(await text(ui, /None queued\./)).toBe(true)
  expect(await text(ui, /today \$0\.00 · total \$0\.00/)).toBe(true)
  expect(await ui.find({ type: 'Button', text: 'Refresh' })).toBeTruthy()
  await ui.unmount()
})

test('draw: a closed thread and a missing thread each show one short message and no action buttons', async ($, on) => {
  world(on)
  await inDesk($)
  const closed = await $.ui.mount(pane('t3'))
  expect(await text(closed, /t3 is closed\. Reopen it from the desk pane/)).toBe(true)
  expect(await closed.find({ type: 'Button', text: 'Restart' })).toBeFalsy()
  await closed.unmount()
  const gone = await $.ui.mount(pane('t99'))
  expect(await text(gone, /t99 does not exist/)).toBe(true)
  expect(await gone.find({ type: 'Button', text: 'Close' })).toBeFalsy()
  await gone.unmount()
})

test('draw: outside the desk the pane says so (the buttons belong to the desk)', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/h/.claude/spares/spare-x', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount(pane('t1'))
  expect(await text(ui, /belong to the desk/)).toBe(true)
  expect(await ui.find({ type: 'Button', text: 'Close' })).toBeFalsy()
  await ui.unmount()
})

test('Restart and Close need two presses; Refresh drops the notice; the first press changes nothing', async ($, on) => {
  const h = world(on, { rows: [idleRow({ pid: undefined, status: undefined, state: 'stopped' })] })
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  const bg = () => h.claudeCalls().filter(a => a[0] === '--bg').length
  await ui.press({ key: 'restart' })
  expect(await ui.find({ type: 'Button', text: 'Confirm restart t1' })).toBeTruthy()
  expect(bg()).toBe(0)
  await ui.press({ key: 'restart' })
  expect(bg()).toBe(1)
  expect(await text(ui, /t1 started/)).toBe(true)
  await ui.press({ key: 'refresh' })
  expect(await text(ui, /t1 started/)).toBe(false)
  await ui.press({ key: 'close' })
  expect(await ui.find({ type: 'Button', text: 'Confirm close t1' })).toBeTruthy()
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).state).toBe('open')
  await ui.press({ key: 'close' })
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).state).toBe('closed')
  await ui.unmount()
})

test('Close: armed while the thread was idle, then it starts working: the second press looks again and closes nothing', async ($, on) => {
  const rows: any[] = [idleRow({ pid: undefined, status: undefined, state: 'stopped' })]
  const h = world(on, { rows })
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  await ui.press({ key: 'close' })
  expect(await ui.find({ type: 'Button', text: 'Confirm close t1' })).toBeTruthy()
  rows[0] = idleRow({ status: 'busy', state: 'working', pid: 42 })
  await ui.press({ key: 'close' })
  expect(await text(ui, /t1 is working: not closed/)).toBe(true)
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).state).toBe('open')
  expect(h.claudeCalls().some(a => a[0] === 'stop')).toBe(false)
  await ui.unmount()
})

test('a thread that waits for the user says so and cannot be closed from the pane; an unreadable listing says "session unknown"', async ($, on) => {
  const h = world(on, { rows: [idleRow({ status: 'idle', state: 'blocked', waitingFor: 'a permission prompt', pid: 42 })] })
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  expect(await text(ui, /waits for you in its own session/)).toBe(true)
  expect(await text(ui, /^waiting for you$/)).toBe(true)
  expect(await ui.find({ type: 'Button', text: 'Close' })).toBeFalsy()
  h.claude.handler = () => ({ exitCode: 1, stdout: '' })
  resetThreadCache()
  await ui.press({ key: 'refresh' })
  expect(await text(ui, /session unknown/)).toBe(true)
  expect(await ui.find({ type: 'Button', text: 'Close' })).toBeFalsy()
  await ui.unmount()
})

test('an expanded report stays on the same report when a newer one arrives', async ($, on) => {
  const h = world(on)
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  await ui.press({ key: 'btn-r11' }) // the newest, "report number 12"
  expect(await text(ui, /^report number 12$/)).toBe(true)
  h.files.set('/h/.lean-agent/desk/inbox.jsonl', (h.files.get('/h/.lean-agent/desk/inbox.jsonl') ?? '') + JSON.stringify({ ts: 9000, from: 't1', kind: 'report', state: 'working', text: 'arrived later' }) + '\n')
  await ui.press({ key: 'refresh' })
  expect(await text(ui, /^report number 12$/)).toBe(true) // still open
  expect(await text(ui, /^arrived later$/)).toBe(false) // the new one is folded
  expect(await ui.find({ type: 'Button', text: /arrived later/ })).toBeTruthy()
  await ui.unmount()
})

test('a working thread has no Close button and its Restart says the current step is lost', async ($, on) => {
  const h = world(on, { rows: [idleRow({ status: 'busy', state: 'working', pid: 42 })] })
  await inDesk($)
  const ui = await $.ui.mount(pane('t1'))
  expect(await ui.find({ type: 'Button', text: 'Close' })).toBeFalsy()
  expect(await text(ui, /^busy$/)).toBe(true)
  await ui.press({ key: 'restart' })
  expect(await ui.find({ type: 'Button', text: /Confirm restart t1 \(it is working: the current step is lost\)/ })).toBeTruthy()
  expect(JSON.parse(h.files.get('/h/.lean-agent/threads/t1/thread.json')!).state).toBe('open')
  await ui.unmount()
})

test('Open session: the idle process is stopped, then the resume link goes to the opener', async ($, on) => {
  const rows: any[] = [idleRow({ pid: 42 })]
  const h = world(on, { rows })
  const order: string[] = []
  h.claude.handler = (a: string[]) => {
    if (a[0] === 'agents') return ok(JSON.stringify(rows))
    if (a[0] === 'stop') {
      order.push('stop')
      for (const r of rows) { delete r.pid; r.state = 'stopped'; delete r.status }
      return ok('stopped')
    }
    return ok()
  }
  h.opener.handler = (a: string[]) => { order.push(`open ${a[a.length - 1]}`); return ok() }
  await inDesk($)
  const ui = await $.ui.mount(pane('t1', 'desktop'))
  await ui.press({ key: 'open-session' })
  expect(order).toEqual(['stop', `open claude://resume?session=${SID}`])
  expect(await text(ui, /t1 opened in the Claude app/)).toBe(true)
  await ui.unmount()
})

test('several panes at once: each draws its own thread and its own two-press', async ($, on) => {
  world(on)
  await inDesk($)
  const a = await $.ui.mount(pane('t1'))
  const b = await $.ui.mount(pane('t2'))
  expect(await text(a, /t1 · add the widget/)).toBe(true)
  expect(await text(b, /t2 · empty one/)).toBe(true)
  expect(await text(a, /t2 · empty one/)).toBe(false)
  expect(await text(b, /widget merged/)).toBe(false)
  await a.press({ key: 'restart' })
  expect(await a.find({ type: 'Button', text: 'Confirm restart t1' })).toBeTruthy()
  expect(await b.find({ type: 'Button', text: /Confirm restart/ })).toBeFalsy() // t2's button is not armed by t1's press
  expect(await b.find({ type: 'Button', text: 'Restart' })).toBeTruthy()
  await a.unmount()
  await b.unmount()
})

test('openThreadPane opens lean-agent-thread-<tN> titled "tN · <title>" (the thin host answers ui.open as the engine $ does); a bad id is refused', async () => {
  const h = world()
  const opened: any[] = []
  const $ = { ...h.host, ui: { open: async (p: any) => { opened.push(p); return { isPlaced: true } } } } // what hostOf($) is
  expect(await openThreadPane($, 'desktop', 't1')).toMatchObject({ ok: true, pane: 'lean-agent-thread-t1' })
  expect(await openThreadPane($, undefined, 't2')).toMatchObject({ ok: true })
  expect(await openThreadPane($, undefined, 't99')).toMatchObject({ ok: true }) // a missing thread still opens: the pane says so
  expect(opened).toEqual([
    { id: 'lean-agent-thread-t1', title: 't1 · add the widget' },
    { id: 'lean-agent-thread-t2', title: 't2 · empty one' },
    { id: 'lean-agent-thread-t99', title: 't99' },
  ])
  expect(await openThreadPane($, undefined, 'x1')).toMatchObject({ ok: false })
  expect(await openThreadPane($, undefined, 't1; rm')).toMatchObject({ ok: false })
  expect(opened).toHaveLength(3)
  const broken = { ...h.host, ui: { open: async () => { throw new Error('no pane for you') } } }
  expect(await openThreadPane(broken, undefined, 't1')).toMatchObject({ ok: false, text: expect.stringContaining('no pane for you') })
})

test('hostOf($) carries ui.open for the desk pane\'s buttons', async ($) => {
  expect(typeof hostOf($).ui?.open).toBe('function')
})
