// 1.0.26 files for the user's folders: a thread writes to scratch/, the mod copies (deliver.ts)
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { recordHumanPrompt } from './humanprompts'
import { leanThread, resetLocks, unusedField } from './threads'
import { bindDeliverAnswers, deliver, deliverQuestion, eperm } from './deliver'

const L = '/h/.lean-agent'
const FILE = `${L}/threads/t5/scratch/report.md`
const HOUR = 3_600_000

function setup(opts: { fail?: string } = {}) {
  const h = fakeHost(null)
  resetLocks()
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(FILE, '# the report\n')
  h.files.set(`${L}/threads/t6/scratch/other.md`, 'not t5')
  h.files.set(`${L}/desk/reports/r1.md`, 'desk report')
  h.files.set(`${L}/worktrees.json`, JSON.stringify({ 'app/x': { path: `${L}/worktrees/app/x`, repo: '/r', branch: 'x', thread: 't5' } }))
  h.files.set(`${L}/worktrees/app/x/out/export.csv`, 'a,b')
  for (const f of ['Downloads', 'Desktop', 'Documents', 'Projects/out']) h.files.set(`/h/${f}/.keep`, '')
  const state = { fail: opts.fail ?? '' }
  h.exec.handler = argv => {
    if (argv[0] !== 'cp') return { exitCode: 127, stdout: '', stderr: 'unknown' }
    if (state.fail) return { exitCode: 1, stdout: '', stderr: state.fail }
    const [src, dest] = [argv[argv.length - 2]!, argv[argv.length - 1]!]
    if (h.files.has(dest)) return { exitCode: 1, stdout: '', stderr: 'exists' }
    h.files.set(dest, h.files.get(src)!)
    return { exitCode: 0, stdout: '' }
  }
  const say = (text: string, origin: unknown = { kind: 'composer' }) => recordHumanPrompt(h.host, { text, wait: false, origin })
  return { h, host: h.host, say, state }
}
const copies = (s: ReturnType<typeof setup>) => s.h.calls.filter(c => c.argv[0] === 'cp').map(c => c.argv)

test('allowed when a recorded human prompt names the folder: the file is copied by argv (no shell), the quote and the full path are said', async () => {
  const s = setup()
  await s.say('please put the report in Downloads when it is ready')
  const r = await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain('copied report.md to /h/Downloads/report.md')
  expect(r.text).toContain('your words: "please put the report in Downloads')
  expect(s.h.files.get('/h/Downloads/report.md')).toBe('# the report\n')
  expect(copies(s)).toEqual([['cp', '-n', '--', FILE, '/h/Downloads/report.md']])
  expect(s.h.files.get(`${L}/threads/t5/history.jsonl`)).toContain('delivered')
  // other destinations: its own words, "save", a typed absolute folder, the thread's worktree and the desk reports folder as sources
  await s.say('save the draft please')
  expect((await deliver(s.host, { tN: 't5', file: FILE, to: 'Desktop', name: 'draft.md' })).ok).toBe(true)
  expect(s.h.files.has('/h/Desktop/draft.md')).toBe(true)
  const t = setup()
  await t.say('copy it to /h/Projects/out')
  expect((await deliver(t.host, { tN: 't5', file: `${L}/worktrees/app/x/out/export.csv`, to: '/h/Projects/out' })).ok).toBe(true)
  expect((await deliver(t.host, { tN: 't5', file: `${L}/desk/reports/r1.md`, to: '~/Projects/out' })).ok).toBe(true)
})

test('without the user\'s words (none, too old, another folder, a relayed text) the desk is told to ask: the question names the file and the folder, nothing is copied', async () => {
  const s = setup()
  const a = await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })
  expect(a.ok).toBe(false)
  expect(a.text).toContain('ask with AskUserQuestion')
  expect(a.text).toContain('"Save report.md (from t5) to Downloads?"')
  expect((a.data as any).ask.options.map((o: any) => o.label)).toEqual(['Save it', 'Do not save'])
  await s.say('the downloads are full of junk') // lower case is still the word: this one DOES name the folder
  await s.say('nothing about folders here')
  const t = setup()
  await t.say('what a day')
  await t.say('put the report in Documents', { kind: 'plugin' }) // not the user's
  expect((await deliver(t.host, { tN: 't5', file: FILE, to: 'Downloads' })).ok).toBe(false)
  const u = setup()
  await u.say('put it in Downloads')
  u.h.clock.t += 25 * HOUR
  expect((await deliver(u.host, { tN: 't5', file: FILE, to: 'Downloads' })).ok).toBe(false)
  expect(copies(u)).toEqual([])
  const v = setup()
  await v.say('put the notes in Documents')
  expect((await deliver(v.host, { tN: 't5', file: FILE, to: 'Desktop' })).ok).toBe(false) // another folder's word does not cover Desktop
})

test('the human\'s answer to the canonical question allows that one copy; a bent question or another label does not', async () => {
  const s = setup()
  const a: any = await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })
  const q = a.data.ask
  expect(q).toEqual(deliverQuestion('t5', 'report.md', 'Downloads'))
  const asked = [{ question: q.question, options: q.options }]
  await bindDeliverAnswers(s.host, asked, { [q.question]: 'Do not save' })
  await bindDeliverAnswers(s.host, asked, { [q.question]: 'yes' })
  await bindDeliverAnswers(s.host, [{ question: q.question, options: [{ ...q.options[0], description: 'everything' }, q.options[1]] }], { [q.question]: 'Save it' })
  await bindDeliverAnswers(s.host, [{ question: 'Save evil.md (from t5) to Downloads?', options: q.options }], { 'Save evil.md (from t5) to Downloads?': 'Save it' })
  expect((await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })).ok).toBe(false)
  const notes = await bindDeliverAnswers(s.host, asked, { [q.question]: 'Save it' })
  expect(notes.join()).toContain('call lean_thread deliver again')
  const r = await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain('copied report.md to /h/Downloads/report.md')
  expect((await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })).ok).toBe(false) // one copy only: asked again
})

test('never overwrites: an existing name gets -2, then -3; the original is untouched', async () => {
  const s = setup()
  await s.say('save it to Downloads')
  s.h.files.set('/h/Downloads/report.md', 'the user\'s own file')
  const a = await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })
  expect(a.text).toContain('/h/Downloads/report-2.md')
  expect(a.text).toContain('nothing was overwritten')
  const b = await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })
  expect(b.text).toContain('/h/Downloads/report-3.md')
  expect(s.h.files.get('/h/Downloads/report.md')).toBe('the user\'s own file')
  s.h.files.set('/h/Downloads/archive.tar.gz', 'x')
  expect((await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads', name: 'archive.tar.gz' })).text).toContain('/h/Downloads/archive.tar-2.gz')
})

test('EPERM says exactly what macOS needs; another failure says what failed', async () => {
  const s = setup({ fail: 'cp: /h/Downloads/report.md: Operation not permitted' })
  await s.say('save it to Downloads')
  const r = await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })
  expect(r.ok).toBe(false)
  expect(r.text).toBe('macOS blocks the Claude app from Downloads: System Settings > Privacy & Security > Files and Folders (or Full Disk Access): allow the Claude app, then retry')
  expect(r.text).toBe(eperm('Downloads'))
  s.state.fail = 'cp: disk full'
  expect((await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads' })).text).toContain('copy to Downloads failed: cp: disk full')
})

test('a file outside the thread\'s scratch folder, its worktrees and the desk reports, and a destination outside the user\'s folders, are refused', async () => {
  const s = setup()
  await s.say('save everything to Downloads and /etc and /h/.ssh and /h/.lean-agent/x')
  for (const file of ['/etc/passwd', '/h/.ssh/id_rsa', `${L}/config.json`, `${L}/threads/t6/scratch/other.md`, `${L}/threads/t5/scratch/../../t6/scratch/other.md`, `${L}/threads/t5/thread.json`, `${L}/worktrees/app/other.md`, '/h/Documents/.keep', 'relative/x.md', `${L}/threads/t5/scratch`]) {
    const r = await deliver(s.host, { tN: 't5', file, to: 'Downloads' })
    expect(r.ok, file).toBe(false)
  }
  for (const to of ['/etc', '/h', '/h/.ssh', `${L}/x`, '/h/Projects/../.ssh', 'Library', '/tmp/x', '']) expect((await deliver(s.host, { tN: 't5', file: FILE, to })).ok, to).toBe(false)
  expect((await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads', name: '../x.md' })).ok).toBe(false)
  expect((await deliver(s.host, { tN: 't5', file: FILE, to: 'Downloads', name: '.bashrc' })).ok).toBe(false)
  expect((await deliver(s.host, { tN: 't9', file: FILE, to: 'Downloads' })).text).toContain('no thread t9')
  expect(copies(s)).toEqual([])
})

test('the lean_thread action takes tN, file, to, name and nothing else', async () => {
  const s = setup()
  expect(unusedField({ action: 'deliver', tN: 't5', file: FILE, to: 'Downloads', name: 'a.md' })).toBeNull()
  expect(unusedField({ action: 'deliver', tN: 't5', file: FILE, to: 'Downloads', text: 'x' })).toContain('does not use the field "text"')
  expect(unusedField({ action: 'send', tN: 't5', text: 'x', file: FILE })).toContain('does not use the field "file"')
  await s.say('save it to Downloads')
  const o: any = await leanThread(s.host, '/p', { action: 'deliver', tN: 't5', file: FILE, to: 'Downloads' })
  expect(o.ok, o.text).toBe(true)
  const no: any = await leanThread(s.host, '/p', { action: 'deliver', tN: 't5', file: '/etc/passwd', to: 'Downloads' })
  expect(no.ok).toBe(false)
})
