// 1.0.35 (items 5 to 8 of the "mechanical work from models to scripts" request): ONE continue path for a parked / closed thread, model and effort in `set`, repeated waiting reports
// recorded and not forwarded, and the desk saving a draft without a thread. Synthetic names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { threadTool } from './delivery'
import { saveDraft, DRAFT_MAX } from './deliver'
import { modelChangeTick, pendingChange } from './modelnext'
import { normText, sameReport, waitTarget } from './repeatreport'
import { leanThread, resetLocks, unusedField } from './threads'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'
const T = `${L}/threads/t1`

function setup() {
  resetLocks()
  const h = fakeHost(null)
  h.files.set(`${L}/config.json`, '{"handover":{"mode":"full"}}')
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  const state = { rows: [] as any[], agentsFail: false }
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg') return { exitCode: 0, stdout: `started ${SID}\n` }
    if (a[0] === 'agents' && a[1] === '--json') return state.agentsFail ? { exitCode: 1, stdout: '', stderr: 'boom' } : { exitCode: 0, stdout: JSON.stringify(state.rows) }
    return { exitCode: 0, stdout: '' }
  }
  const call = (i: any) => leanThread(h.host, ROOT, i)
  const thread = () => JSON.parse(h.files.get(`${T}/thread.json`)!)
  const bg = () => h.claudeCalls().filter(a => a[0] === '--bg')
  return { h, state, call, thread, bg }
}
type S = ReturnType<typeof setup>
const started = async (s: S) => {
  await s.call({ action: 'new', title: 'a', text: 'brief' })
  s.h.clock.t += 60_000
}

// ---- item 5: one continue path --------------------------------------------------------------------------------------------------------------
test('5: a desk send to a PARKED thread reopens and wakes it in one call and says so; an internal send leaves it parked', async () => {
  const s = setup()
  await started(s)
  await s.call({ action: 'park', tN: 't1' })
  const quiet = await s.call({ action: 'send', tN: 't1', text: 'a chaser nudge', internal: true })
  expect(quiet.text).toContain('is parked: message queued, no wake')
  expect(s.thread().state).toBe('parked')
  const r = await s.call({ action: 'send', tN: 't1', text: 'please continue with the tests' })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain('t1 was parked: reopened and woken with your text')
  expect(s.thread().state).toBe('open')
  expect(s.h.claudeCalls().filter(a => a.includes('--resume'))).toHaveLength(1)
})

test('5: a parked thread whose wake fails stays parked and the text stays queued', async () => {
  const s = setup()
  await started(s)
  await s.call({ action: 'park', tN: 't1' })
  s.state.agentsFail = true
  const r = await s.call({ action: 'send', tN: 't1', text: 'please continue' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('stays parked')
  expect(s.thread().state).toBe('parked')
})

test('5: a desk send to a CLOSED thread (no work item or PR: closed by mistake) reopens it as a new session; an internal send never does', async () => {
  const s = setup()
  await started(s)
  await s.call({ action: 'close', tN: 't1' })
  s.state.rows = []
  const internal = await s.call({ action: 'send', tN: 't1', text: 'a timer line', internal: true })
  expect(internal.text).toContain('closed')
  expect(s.thread().state).toBe('closed')
  expect(s.bg()).toHaveLength(1)
  const r = await s.call({ action: 'send', tN: 't1', text: 'sorry, that was a mistake: go on' })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain('t1 was closed: reopened as a new session')
  expect(s.thread().state).toBe('open')
  expect(s.bg()).toHaveLength(2)
  expect(s.bg()[1]!.at(-1)).toContain('go on')
})

test('5: a desk send to a thread that reported done starts a new session with the handover (the done rule), and an open idle one is simply woken', async () => {
  const s = setup()
  await started(s)
  const t = s.thread()
  s.h.files.set(`${T}/thread.json`, JSON.stringify({ ...t, finished: 5 }))
  s.state.rows = []
  const r = await s.call({ action: 'send', tN: 't1', text: 'one more thing' })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain('finished earlier: a new session was started with the handover')
  expect(s.bg()).toHaveLength(2)
  // an idle open one: a plain wake (resume), no reopen words
  const w = setup()
  await started(w)
  w.state.rows = [{ sessionId: SID, name: 'x', cwd: 'x', status: 'idle', startedAt: 1 }]
  const o = await w.call({ action: 'send', tN: 't1', text: 'carry on' })
  expect(o.text).not.toContain('reopened')
  expect(w.h.claudeCalls().filter(a => a.includes('--resume'))).toHaveLength(1)
})

// ---- item 6: model and effort in set --------------------------------------------------------------------------------------------------------
test('6: set stores a model / effort for the next restart, the list says so, the restart applies it once and clears it', async () => {
  const s = setup()
  await started(s)
  const r = await s.call({ action: 'set', tN: 't1', model: 'haiku' })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain('model sonnet -> haiku at next restart')
  expect(s.thread().nextModel).toBe('haiku')
  expect(s.thread().model).toBe('sonnet') // the running session is untouched
  expect((await s.call({ action: 'set', tN: 't1', effort: 'low' })).text).toContain('model sonnet -> haiku, effort high -> low at next restart')
  const list = await s.call({ action: 'list' })
  expect(list.text).toContain('model sonnet -> haiku, effort high -> low at next restart')
  expect((await s.call({ action: 'list', verbose: true })).text).toContain('at next restart')
  // restart now: the fresh session starts on haiku / low and the stored change is gone
  s.state.rows = []
  const re = await s.call({ action: 'restart', tN: 't1' })
  expect(re.ok, re.text).toBe(true)
  const argv = s.bg()[1]!
  expect(argv.slice(0, 7)).toEqual(['--bg', '-n', 't1 · a (2)', '--model', 'haiku', '--effort', 'low'])
  expect([s.thread().model, s.thread().effort, s.thread().nextModel, s.thread().nextEffort]).toEqual(['haiku', 'low', undefined, undefined])
  expect((await s.call({ action: 'list' })).text).not.toContain('at next restart')
})

test('6: set refuses a bad model, opus (it needs the user\'s approval), and a same value clears a pending change', async () => {
  const s = setup()
  await started(s)
  expect((await s.call({ action: 'set', tN: 't1', model: 'gpt' })).ok).toBe(false)
  const o = await s.call({ action: 'set', tN: 't1', model: 'opus' })
  expect(o.ok).toBe(false)
  expect(o.text).toContain('restart t1 with model opus and reason')
  expect(s.thread().nextModel).toBeUndefined()
  await s.call({ action: 'set', tN: 't1', model: 'haiku' })
  const back = await s.call({ action: 'set', tN: 't1', model: 'sonnet' })
  expect(back.text).toContain('already on that model')
  expect(s.thread().nextModel).toBeUndefined()
  expect(unusedField({ action: 'set', tN: 't1', model: 'haiku', effort: 'low' })).toBeNull()
  expect(unusedField({ action: 'set', tN: 't1', model: 'haiku', file: '/x' })).toContain('does not use the field')
  expect(pendingChange({ model: 'sonnet', nextModel: 'haiku' })).toBe('model sonnet -> haiku at next restart')
  expect(pendingChange({})).toBe('')
})

test('6: the desk timer restarts a thread with a stored change once its session has been idle for 20 s: never a working one, once, retried after 10 min', async () => {
  const s = setup()
  await started(s)
  await s.call({ action: 'set', tN: 't1', effort: 'low' })
  const row = (status: string, state?: string) => ({ sid: SID, status, ...(state ? { state } : {}) }) as any
  let rows: any[] = [row('busy', 'working')]
  const restarts: string[] = []
  const deps = { agents: async () => rows, restart: async (id: string, why: string) => (restarts.push(`${id}|${why}`), { ok: true, text: 'restarted', data: { fresh: true } }) }
  expect(await modelChangeTick(s.h.host, '/h', deps)).toEqual([])
  expect(restarts).toEqual([]) // working: nothing
  rows = [row('idle', 'idle')]
  await modelChangeTick(s.h.host, '/h', deps) // first idle sighting
  expect(restarts).toEqual([])
  s.h.clock.t += 10_000
  await modelChangeTick(s.h.host, '/h', deps)
  expect(restarts).toEqual([]) // not 20 s yet
  s.h.clock.t += 15_000
  const n = await modelChangeTick(s.h.host, '/h', deps)
  expect(restarts).toHaveLength(1)
  expect(restarts[0]).toContain('t1|The user changed its settings (effort high -> low)')
  expect(n[0]!.text).toContain('applied by one restart from the handover')
  // a gone session needs no tick: its next start reads the change
  rows = []
  s.h.clock.t += 60_000
  await modelChangeTick(s.h.host, '/h', deps)
  expect(restarts).toHaveLength(1)
})

// ---- item 7: repeated waiting reports --------------------------------------------------------------------------------------------------------
test('7: the same "still waiting" report is recorded and not forwarded; the list says "waiting for worker since ... (N repeats)"; a changed state goes through', async () => {
  const s = setup()
  await started(s)
  const inbox = () => (s.h.files.get(`${L}/desk/inbox.jsonl`) ?? '').split('\n').filter(Boolean).length
  const rep = (state: string, text: string) => threadTool(s.h.host, 't1', 'lean_report', { state, text })
  const a = await rep('working', 'Still waiting for the worker (w3), started 13:42.')
  expect(a.ok).toBe(true)
  expect(inbox()).toBe(1)
  const b = await rep('working', 'still waiting for the worker (w4), started 14:10')
  expect(b.ok).toBe(true)
  expect(b.text).toContain('NOT sent to the desk again')
  expect(b.text).toContain('1 repeat')
  const c = await rep('working', 'Still waiting for worker. Nothing new.')
  expect(c.text).toContain('2 repeats')
  expect(inbox()).toBe(1) // recorded, never written to the desk's inbox again
  const list = await s.call({ action: 'list' })
  expect(list.text).toMatch(/t1 waiting for worker since \d\d:\d\d \(2 repeats\)/)
  // news: progress text around the wait, another state, a question, an action: all forwarded
  await rep('working', 'Worker finished 3 of 5 files; still waiting for the worker to do the rest of the long list of files and then the tests too, plenty more text here so it is not a plain wait line at all, it is progress that the desk may want to read in full, and it goes on for well past two hundred and forty characters.')
  expect(inbox()).toBe(2)
  await rep('blocked', 'Still waiting for the worker?')
  expect(inbox()).toBe(3)
  await rep('done', 'Still waiting for the worker')
  expect(inbox()).toBe(4)
  expect((await s.call({ action: 'list' })).text).not.toContain('repeats')
})

test('7: normalised text equality and the wait target, as pure functions', () => {
  expect(normText('Still waiting for worker w3 (13:42).')).toBe(normText('still WAITING for worker w9 (09:05)'))
  expect(waitTarget('Still waiting for the worker to finish the edits.')).toBe('worker')
  expect(waitTarget('waiting on CI, nothing else')).toBe('ci')
  expect(waitTarget('all done')).toBe('')
  const prev = { state: 'working', norm: normText('waiting for the worker'), target: 'worker', since: 1, last: 1, repeats: 0 }
  expect(sameReport(prev, 'working', 'Waiting for the worker.')).toBe(true)
  expect(sameReport(prev, 'working', 'Waiting for the reviewer.')).toBe(false)
  expect(sameReport(prev, 'blocked', 'Waiting for the worker.')).toBe(false)
  expect(sameReport(null, 'working', 'Waiting for the worker.')).toBe(false)
})

// ---- item 8: the desk saves a draft ----------------------------------------------------------------------------------------------------------
function draftWorld(cfg: object | null = { feedback: { destination: 'folder', folder: '~/Downloads' } }) {
  resetLocks()
  const h = fakeHost(null)
  if (cfg) h.files.set(`${L}/config.json`, JSON.stringify(cfg))
  h.files.set('/h/Downloads/.keep', '')
  return h
}

test('8: save-draft writes the desk\'s text into feedback.folder: one file a call, never overwritten, a safe .md / .txt name, at most 256 KB', async () => {
  const h = draftWorld()
  const a = await saveDraft(h.host, { text: '# draft\nthe menu hides the setting', name: 'menu.md' })
  expect(a.ok, a.text).toBe(true)
  expect(a.text).toContain('/h/Downloads/menu.md')
  expect(h.files.get('/h/Downloads/menu.md')).toBe('# draft\nthe menu hides the setting\n')
  const b = await saveDraft(h.host, { text: 'second version', name: 'menu.md' })
  expect(b.ok, b.text).toBe(true)
  expect(h.files.get('/h/Downloads/menu.md')).toBe('# draft\nthe menu hides the setting\n') // untouched
  expect(h.files.get('/h/Downloads/menu-2.md')).toBe('second version\n')
  expect(b.text).toContain('nothing was overwritten')
  expect((await saveDraft(h.host, { text: 'no name given' })).text).toContain('feedback-draft.md')
  for (const bad of ['../up.md', 'a/b.md', '.hidden.md', 'run.sh', 'a b.md', 'x..md', '', '/etc/passwd']) {
    const r = await saveDraft(h.host, { text: 'x', name: bad || undefined })
    if (bad === '') continue // (an empty name means the default)
    expect([bad, r.ok]).toEqual([bad, false])
  }
  expect((await saveDraft(h.host, { text: '   ' })).text).toContain('needs text')
  const big = await saveDraft(h.host, { text: 'x'.repeat(DRAFT_MAX + 1), name: 'big.md' })
  expect(big.ok).toBe(false)
  expect(big.text).toContain('at most 262144 bytes')
  expect(h.files.has('/h/Downloads/big.md')).toBe(false)
  expect((await saveDraft(h.host, { text: 'x'.repeat(DRAFT_MAX), name: 'edge.md' })).ok).toBe(true)
})

test('8: save-draft needs the feedback folder the user chose once, refuses another folder, a missing folder and a hidden / lean-agent folder', async () => {
  expect((await saveDraft(draftWorld(null).host, { text: 'x' })).text).toContain('feedback.destination is local')
  expect((await saveDraft(draftWorld({ feedback: { destination: 'folder' } }).host, { text: 'x' })).text).toContain('feedback.folder is not set')
  const other = draftWorld()
  other.files.set('/h/Elsewhere/.keep', '')
  expect((await saveDraft(other.host, { text: 'x', to: '/h/Elsewhere' })).text).toContain('goes only to feedback.folder')
  expect((await saveDraft(other.host, { text: 'x', to: 'feedback' })).ok).toBe(true)
  expect((await saveDraft(draftWorld({ feedback: { destination: 'folder', folder: '~/Missing' } }).host, { text: 'x' })).text).toContain('does not exist')
  expect((await saveDraft(draftWorld({ feedback: { destination: 'folder', folder: '~/.hidden' } }).host, { text: 'x' })).ok).toBe(false)
  expect((await saveDraft(draftWorld({ feedback: { destination: 'folder', folder: '~/.lean-agent/feedback-export' } }).host, { text: 'x' })).ok).toBe(false)
})

test('8: lean_thread save-draft takes text and name only, and works with no thread at all', async () => {
  const h = draftWorld()
  const r = await leanThread(h.host, ROOT, { action: 'save-draft', text: 'hello', name: 'note.txt' })
  expect(r.ok, r.text).toBe(true)
  expect(h.files.get('/h/Downloads/note.txt')).toBe('hello\n')
  expect(unusedField({ action: 'save-draft', text: 'x', name: 'a.md' })).toBeNull()
  expect(unusedField({ action: 'save-draft', text: 'x', file: '/a' })).toContain('does not use the field')
})
