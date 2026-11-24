// Work items and PRs belong to the task (workitems.ts, 1.0.31): extraction, set / correct, list text, the handover line, `continues`, one thread per work item,
// a follow-up to a done thread, the WI -> threads map, find. Synthetic names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { leanThread, resetLocks, unusedField } from './threads'
import { readItems, resetMemory } from './memory'
import { resetMemorySession } from './memoryindex'
import { extractRefs, parsePr, parseWorkItem, refsLine } from './workitems'

const SID = '11111111-2222-3333-4444-555555555555'
const ROOT = '/p'
const L = '/h/.lean-agent'

function world() {
  resetLocks()
  resetMemory()
  resetMemorySession()
  const h = fakeHost(null)
  h.files.set(`${L}/config.json`, '{"handover":{"mode":"core"}}')
  h.files.set(`${ROOT}/templates/thread.md`, '# {{id}} {{title}}')
  h.files.set(`${ROOT}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.5' }))
  const bg: string[][] = []
  const rows: any[] = []
  h.claude.handler = (a: string[]) => {
    if (a[0] === '--bg' && a.includes('--resume')) return { exitCode: 0, stdout: 'resumed\n' }
    if (a[0] === '--bg') { bg.push(a); return { exitCode: 0, stdout: `started ${SID}\n` } }
    if (a[0] === 'agents') return { exitCode: 0, stdout: JSON.stringify(rows) }
    return { exitCode: 0, stdout: '' }
  }
  const call = (i: any) => leanThread(h.host, ROOT, i.action === 'list' ? { verbose: true, ...i } : i)
  const row = (id: string): any => JSON.parse(h.files.get(`${L}/threads/${id}/thread.json`)!)
  const patch = (id: string, p: object) => h.files.set(`${L}/threads/${id}/thread.json`, JSON.stringify({ ...row(id), ...p }))
  const typed = (text: string) => h.store.set('desk.human.prompts', [{ text, ts: h.clock.t }])
  return { h, bg, rows, call, row, patch, typed }
}

test('extraction: the unambiguous forms are taken, a bare #123 and ambiguous texts are not', () => {
  expect(extractRefs('Fix WI 9840 please').workItem).toEqual({ id: 9840 })
  expect(extractRefs('see work item 9840').workItem).toEqual({ id: 9840 })
  expect(extractRefs('workitem #9840 is the bug').workItem).toEqual({ id: 9840 })
  expect(extractRefs('https://dev.azure.com/acme-org/project-A/_workitems/edit/9840').workItem).toEqual({ id: 9840, org: 'acme-org', project: 'project-A' })
  expect(extractRefs('the PR 5687 is open').pr).toEqual({ number: 5687 })
  expect(extractRefs('pull request 5687').pr).toEqual({ number: 5687 })
  expect(extractRefs('https://dev.azure.com/acme-org/project-A/_git/repo-x/pullrequest/5687').pr).toEqual({ number: 5687, host: 'azure', org: 'acme-org', project: 'project-A', repo: 'repo-x' })
  expect(extractRefs('https://github.com/acme/widgets/pull/321').pr).toEqual({ number: 321, host: 'github', repo: 'acme/widgets' })
  // rejected: a bare number, an issue-like hash, a word that only looks like it, a number in a longer word
  for (const bad of ['fix #123 soon', 'issue #9840', 'wifi 9840', 'version 9840', 'the 5687th try', 'AB#9840 only']) expect([bad, extractRefs(bad).workItem, extractRefs(bad).pr]).toEqual([bad, undefined, undefined])
  // two different work items: none is taken, a note says so
  const two = extractRefs('WI 1111 and WI 2222')
  expect(two.workItem).toBeUndefined()
  expect(two.notes[0]).toContain('several work items')
  expect(extractRefs('WI 1111 and work item 1111').workItem).toEqual({ id: 1111 })
  expect(parseWorkItem('#9840')).toEqual({ id: 9840 })
  expect(parseWorkItem('nonsense')).toContain('not a work item')
  expect(parsePr(5687)).toEqual({ number: 5687 })
  expect(parsePr('PR 5687')).toEqual({ number: 5687 })
  expect(refsLine({ workItem: { id: 9840, project: 'project-A' }, pr: { number: 5687 } })).toContain('work item: 9840 (project-A), PR: 5687')
  expect(refsLine({})).toBe('')
})

test('new: workitem and pr are stored on the row, shown in list; taken from the brief with a "say if wrong" line; a bare #123 is not taken', { timeoutMs: 20_000 }, async () => {
  const { h, call, row } = world()
  const a = await call({ action: 'new', title: 'worker telemetry', text: 'diagnose it', workitem: 9840 })
  expect(a.ok).toBe(true)
  expect(row('t1').workItem).toEqual({ id: 9840 })
  expect(a.text).not.toContain('say if wrong') // given, not taken
  const b = await call({ action: 'new', title: 'other', text: 'Fix the bug in work item 7001 and look at PR 5687 (not #123)' })
  expect(b.ok).toBe(true)
  expect(b.text).toContain('linked to WI 7001, PR 5687 (WI 7001 and PR 5687 taken from the brief): say if wrong (lean_thread set t2 workitem|pr <number|url|none>)')
  expect(row('t2')).toMatchObject({ workItem: { id: 7001 }, pr: { number: 5687 }, task: 'wi-7001' })
  const c = await call({ action: 'new', title: 'bare', text: 'see #123 and #9840' })
  expect(c.text).not.toContain('linked to')
  expect(row('t3').workItem).toBeUndefined()
  const l = await call({ action: 'list' })
  expect(l.text.split('\n').find((x: string) => x.startsWith('t2'))).toContain('WI 7001 · PR 5687')
  expect(l.text.split('\n').find((x: string) => x.startsWith('t3'))).not.toContain('WI')
  const short = await leanThread(h.host, ROOT, { action: 'list' })
  expect(short.text.split('\n').find((x: string) => x.startsWith('t1'))).toContain('WI 9840')
  expect(short.text.split('\n').find((x: string) => x.startsWith('t1'))!.length).toBeLessThan(200)
  expect((await call({ action: 'new', title: 'bad', text: 'x', workitem: 'nonsense' })).text).toContain('not a work item')
  expect(unusedField({ action: 'new', title: 't', workitem: 1, continues: 't1', force: true })).toBeNull()
  expect(unusedField({ action: 'set', tN: 't1', workitem: 1, pr: 2 })).toBeNull()
  expect(unusedField({ action: 'set', tN: 't1', title: 'x' })).toContain('does not use the field "title"')
})

test('new takes the references from the USER\'S typed prompt when the brief names none; two work items in a text link none', { timeoutMs: 20_000 }, async () => {
  const { call, row, typed } = world()
  typed('please look at the production telemetry bug, WI 9840 in project-A')
  const a = await call({ action: 'new', title: 'sql look', text: 'investigate the data' })
  expect(a.text).toContain("WI 9840 taken from the user's prompt")
  expect(row('t1').workItem).toEqual({ id: 9840 })
  const b = await call({ action: 'new', title: 'two', text: 'compare WI 1111 with WI 2222' })
  expect(b.text).toContain('several work items are named (1111, 2222): none was linked')
  expect(row('t2').workItem).toBeUndefined()
})

test('set tN workitem|pr corrects what a script took; none clears; the map file and find follow; the task memory item is made once', { timeoutMs: 20_000 }, async () => {
  const { h, call, row } = world()
  await call({ action: 'new', title: 'worker telemetry', text: 'look at WI 9840 (PR 5687)' })
  expect(JSON.parse(h.files.get(`${L}/workitems.json`)!)).toEqual({ wi: { '9840': ['t1'] }, pr: { '5687': ['t1'] } })
  const s = await call({ action: 'set', tN: 't1', workitem: 'https://dev.azure.com/acme-org/project-A/_workitems/edit/9841', pr: 'PR 5700' })
  expect(s.ok).toBe(true)
  expect(s.text).toBe('t1 now has WI 9841 · PR 5700')
  expect(row('t1')).toMatchObject({ workItem: { id: 9841, org: 'acme-org', project: 'project-A' }, pr: { number: 5700 }, task: 'wi-9841' })
  expect(JSON.parse(h.files.get(`${L}/workitems.json`)!)).toEqual({ wi: { '9841': ['t1'] }, pr: { '5700': ['t1'] } })
  expect((await call({ action: 'set', tN: 't1', pr: 'none' })).text).toBe('t1 now has WI 9841')
  expect(row('t1').pr).toBeUndefined()
  expect((await call({ action: 'set', tN: 't1', workitem: 'none' })).text).toBe('t1 now has no work item or PR')
  expect(JSON.parse(h.files.get(`${L}/workitems.json`)!)).toEqual({ wi: {}, pr: {} })
  expect((await call({ action: 'set', tN: 't1', workitem: 'junk' })).ok).toBe(false)
  expect((await call({ action: 'set', tN: 't1' })).ok).toBe(false)
  expect((await call({ action: 'set', tN: 't9', workitem: 5 })).text).toContain('no thread t9')
  // the task's memory item: a fact, source script, scope task:wi-9841, one item however often it is set
  await call({ action: 'set', tN: 't1', workitem: 9841 })
  await call({ action: 'set', tN: 't1', workitem: 9841, pr: 5700 })
  const items = (await readItems(h.host, '/h')).filter(i => i.scope === 'task:wi-9841')
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ kind: 'fact', source: 'script', status: 'active' })
  expect(items[0]!.text).toContain('work item 9841')
  expect(items[0]!.text).toContain('PR 5700')
})

test('find 9840 lists the threads that own it (id, title, state) before the matching lines', { timeoutMs: 20_000 }, async () => {
  const { call, patch } = world()
  await call({ action: 'new', title: 'worker telemetry', text: 'WI 9840 first look' })
  await call({ action: 'new', title: 'telemetry backend', text: 'backend part', workitem: 9840, force: true }).then(r => expect(r.ok).toBe(false)) // refused: no user words
  await call({ action: 'new', title: 'unrelated', text: 'mentions 9840 as a plain number' })
  patch('t1', { finished: 1 })
  const f = await call({ action: 'find', text: '9840' })
  expect(f.text.split('\n')[0]).toBe('owned by WI 9840: t1 "worker telemetry" (done)')
  expect(f.text).toContain('find "9840":')
  expect((await call({ action: 'find', text: 'WI 9840' })).text.split('\n')[0]).toContain('owned by WI 9840')
  expect((await call({ action: 'find', text: 'PR 9840' })).text).not.toContain('owned by')
})

test('the handover of a restart carries "work item: <id> (<project>), PR: <n>" in the core and the full mode', { timeoutMs: 20_000 }, async () => {
  const { h, bg, call } = world()
  await call({ action: 'new', title: 'worker telemetry', text: 'WI 9840 and PR 5687', workitem: 'https://dev.azure.com/acme-org/project-A/_workitems/edit/9840' })
  for (const mode of ['core', 'full']) {
    h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode } }))
    bg.length = 0
    const r = await call({ action: 'restart', tN: 't1' })
    expect(r.ok).toBe(true)
    const prompt = bg.at(-1)!.at(-1)!
    expect([mode, prompt.includes('work item: 9840 (project-A), PR: 5687')]).toEqual([mode, true])
  }
  await call({ action: 'new', title: 'plain', text: 'no refs here' })
  bg.length = 0
  await call({ action: 'restart', tN: 't2' })
  expect(bg.at(-1)!.at(-1)).not.toContain('work item:')
})

test('continues: tN inherits the work item and the PR, never the thread rules without inherit; a follow-on for the same work item without continues is refused', { timeoutMs: 20_000 }, async () => {
  const { h, call, row } = world()
  await call({ action: 'new', title: 'frontend fix', text: 'WI 9840, PR 5687', rules: ['keep the living plan doc up to date'] })
  const plain = await call({ action: 'new', title: 'backend fix', text: 'the backend part', continues: 't1' })
  expect(plain.ok).toBe(true)
  expect(plain.text).toContain('linked to WI 9840, PR 5687 (WI 9840 and PR 5687 inherited from t1)')
  expect(plain.text).not.toContain('say if wrong') // inherited, not guessed
  expect(row('t2')).toMatchObject({ workItem: { id: 9840 }, pr: { number: 5687 }, task: 'wi-9840' })
  expect((await readItems(h.host, '/h')).filter(i => i.scope === 'thread:t2')).toHaveLength(0) // no rules without inherit
  expect(JSON.parse(h.files.get(`${L}/workitems.json`)!).wi['9840']).toEqual(['t1', 't2'])
  const bad = await call({ action: 'new', title: 'x', text: 'y', continues: 't77' })
  expect(bad.text).toContain('no thread t77')
  expect((await call({ action: 'new', title: 'x', text: 'y', continues: 'frontend' })).text).toContain('continues names the thread')
  // inherit: true with continues needs the user's words, as for the rules of any thread
  expect((await call({ action: 'new', title: 'c', text: 'next', continues: 't1', inherit: true })).text).toContain("needs the user's own words")
  h.store.set('desk.human.prompts', [{ text: 'start it with the same rules as before', ts: h.clock.t }])
  const yes = await call({ action: 'new', title: 'c', text: 'next', continues: 't1', inherit: true })
  expect(yes.ok).toBe(true)
  expect(yes.text).toContain('1 inherited from t1 (the user asked)')
  expect((await readItems(h.host, '/h')).filter(i => i.scope === 'thread:t3' && i.kind === 'rule')).toHaveLength(1)
})

test('one thread per work item: new is refused with the owner and the way out; force needs the user\'s own words', { timeoutMs: 20_000 }, async () => {
  const { h, call, patch, typed } = world()
  await call({ action: 'new', title: 'worker telemetry', text: 'WI 9840' })
  patch('t1', { finished: 1 })
  const no = await call({ action: 'new', title: 'again', text: 'WI 9840 backend' })
  expect(no.ok).toBe(false)
  expect(no.text).toContain('t1 already owns WI 9840 (done): send it a follow-up (lean_thread send t1: it restarts with its handover)')
  expect(no.text).toContain('or pass force: true when the user said new thread')
  expect([...h.files.keys()].some(k => k.includes('/threads/t2/'))).toBe(false)
  // an explicit workitem is refused the same way; a parked and a closed owner too
  expect((await call({ action: 'new', title: 'again', text: 'x', workitem: 9840 })).text).toContain('t1 already owns WI 9840')
  patch('t1', { finished: undefined, state: 'closed' })
  expect((await call({ action: 'new', title: 'again', text: 'x', workitem: 9840 })).text).toContain('t1 already owns WI 9840 (closed)')
  // force without the user's words: refused; with them: allowed, and the reply says the work item has another thread
  const f1 = await call({ action: 'new', title: 'again', text: 'x', workitem: 9840, force: true })
  expect(f1.ok).toBe(false)
  expect(f1.text).toContain("force needs the user's own words")
  typed('open a new thread for it')
  const f2 = await call({ action: 'new', title: 'again', text: 'x', workitem: 9840, force: true })
  expect(f2.ok).toBe(true)
  expect(f2.text).toContain('WI 9840 also belongs to t1 (the user asked for a new thread)')
  expect(JSON.parse(h.files.get(`${L}/workitems.json`)!).wi['9840']).toEqual(['t1', 't2'])
  // a different work item is no conflict
  expect((await call({ action: 'new', title: 'other', text: 'WI 9999' })).ok).toBe(true)
})

test('send to a DONE thread restarts it by script with its handover and the text; send to a CLOSED thread of a work item reopens it', { timeoutMs: 20_000 }, async () => {
  const { h, bg, call, patch, row } = world()
  await call({ action: 'new', title: 'worker telemetry', text: 'WI 9840' })
  patch('t1', { finished: 1 })
  h.clock.t += 120_000 // (a message within 30 s of the start only queues)
  bg.length = 0
  const r = await call({ action: 'send', tN: 't1', text: 'also check the staging data' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('finished earlier: a new session was started with the handover')
  expect(bg).toHaveLength(1)
  expect(bg[0]!.at(-1)).toContain('work item: 9840')
  expect(bg[0]!.at(-1)).toContain('also check the staging data')
  expect(row('t1').finished).toBeUndefined()
  // closed: a follow-up reopens (a thread with no work item or PR stays closed, as before)
  await call({ action: 'close', tN: 't1' })
  expect(row('t1').state).toBe('closed')
  bg.length = 0
  const c = await call({ action: 'send', tN: 't1', text: 'one more question about the fix' })
  expect(c.ok).toBe(true)
  expect(c.text).toContain('t1 was closed: reopened as a new session with its handover and your text')
  expect(row('t1').state).toBe('open')
  expect(bg.at(-1)!.at(-1)).toContain('one more question about the fix')
  await call({ action: 'new', title: 'plain', text: 'nothing linked' })
  await call({ action: 'close', tN: 't2' })
  const p = await call({ action: 'send', tN: 't2', text: 'hello' })
  expect(p.text).toContain('t2 is closed: message queued, no wake')
})

test('a send of the mod itself (internal: a chaser, a timer, a tell) never reopens a closed thread that has a work item; the user\'s send does', { timeoutMs: 20_000 }, async () => {
  const { bg, call, row } = world()
  await call({ action: 'new', title: 'worker telemetry', text: 'WI 9840' })
  await call({ action: 'close', tN: 't1' })
  bg.length = 0
  const m = await call({ action: 'send', tN: 't1', text: '[lean-agent] chaser: report your status', internal: true } as any)
  expect(m.text).toContain('t1 is closed: message queued, no wake')
  expect(row('t1').state).toBe('closed')
  expect(bg).toHaveLength(0)
  const u = await call({ action: 'send', tN: 't1', text: 'one more question about the fix' })
  expect(u.text).toContain('t1 was closed: reopened')
  expect(row('t1').state).toBe('open')
})
