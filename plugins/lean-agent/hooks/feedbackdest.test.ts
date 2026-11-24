import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { destText, feedbackConfig } from './feedbackdest'
import { exportFeedback } from './feedbackexport'

const T0 = Date.UTC(2026, 10, 18, 14, 7)
const ROOT = '/p'
const EXP = '/h/.lean-agent/feedback-export'
const NAME = 'lean-agent-feedback-2026-11-18-1407.md'

function setup(conf?: unknown) {
  const h = fakeHost(null, { home: '/h' })
  h.clock.t = T0
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.4' }))
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327 (Claude Code)\n' : '' })
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ alpha: { path: '/r/alpha' } }))
  h.files.set('/h/.lean-agent/feedback-drafts/2026-11-18-bug.md', '# the opener failed in alpha\nit hung for a minute\n')
  if (conf !== undefined) h.files.set('/h/.lean-agent/config.json', JSON.stringify(conf))
  return h
}
const run = (h: any) => exportFeedback(h.host, ROOT, { version: '1.0.4' })
const cps = (h: any) => h.calls.filter((c: any) => c.argv[0] === 'cp')

test('config: the default is local; destination and folder are read nested or flat; a bad value falls back to local with a problem', async () => {
  expect(await feedbackConfig(setup().host, '/h')).toMatchObject({ dest: 'local', folder: '', set: false, problems: [] })
  expect(await feedbackConfig(setup({ feedback: { destination: 'folder', folder: '~/Downloads' } }).host, '/h')).toMatchObject({ dest: 'folder', folder: '~/Downloads', set: true, problems: [] })
  expect(await feedbackConfig(setup({ 'feedback.destination': 'folder+github', 'feedback.folder': '~/Downloads' }).host, '/h')).toMatchObject({ dest: 'folder+github', folder: '~/Downloads', problems: [] })
  const bad = await feedbackConfig(setup({ feedback: { destination: 'email' } }).host, '/h')
  expect(bad.dest).toBe('local')
  expect(bad.problems[0]).toContain('local, folder, github, folder+github')
  expect((await feedbackConfig(setup({ feedback: { destination: 'folder' } }).host, '/h')).problems[0]).toContain('feedback.folder is not set')
  expect((await feedbackConfig(setup({ feedback: { destination: 'github', folder: 7 } }).host, '/h')).problems[0]).toContain('feedback.folder must be a path')
  expect(destText({ dest: 'folder', folder: '~/Downloads' })).toBe('exports to ~/Downloads')
  expect(destText({ dest: 'github', folder: '' })).toBe('exports, then asks to post to GitHub')
})

test('the doctor row: none on a default install, the destination once set, FIX for a bad value', async () => {
  expect((await check(setup().host, ROOT)).some(r => r.includes('feedback export'))).toBe(false)
  const ok = (await check(setup({ feedback: { destination: 'folder', folder: '~/Downloads' } }).host, ROOT)).find(r => r.includes('feedback export'))!
  expect(ok).toMatch(/^ok\s+feedback export exports to ~\/Downloads$/)
  const fix = (await check(setup({ feedback: { destination: 'nowhere' } }).host, ROOT)).find(r => r.includes('feedback export'))!
  expect(fix).toMatch(/^FIX\s/)
})

test('local (the default and an explicit "local"): the file in the export folder only, today\'s words, no copy', async () => {
  for (const conf of [undefined, { feedback: { destination: 'local', folder: '~/Downloads' } }]) {
    const h = setup(conf)
    h.made.add('/h/Downloads')
    const r = await run(h)
    expect(r.text).toMatch(/^Feedback export written: \/h\/\.lean-agent\/feedback-export\/2026-11-18-1407\.md \(\d+ KB, anonymised\)\. Nothing was posted\. Paste it to the maintainers, or ask the desk to post it\.$/)
    expect(cps(h).length).toBe(0)
    expect([...h.files.keys()].some(k => k.startsWith('/h/Downloads'))).toBe(false)
  }
})

test('folder: the anonymised file is copied ONCE as lean-agent-feedback-<stamp>.md; the copy is the same text; nothing is posted', async () => {
  const h = setup({ feedback: { destination: 'folder', folder: '~/Downloads' } })
  h.made.add('/h/Downloads')
  const r = await run(h)
  expect(r.ok).toBe(true)
  expect(r.copy).toBe(`/h/Downloads/${NAME}`)
  expect(r.text).toContain(`Copied to /h/Downloads/${NAME}.`)
  expect(r.text).toContain('Nothing was posted.')
  expect(cps(h).length).toBe(1)
  expect(cps(h)[0].argv).toEqual(['cp', '-n', '--', `${EXP}/2026-11-18-1407.md`, `/h/Downloads/${NAME}`])
  const copy = h.files.get(`/h/Downloads/${NAME}`)!
  expect(copy).toBe(h.files.get(`${EXP}/2026-11-18-1407.md`))
  expect(copy).toContain('project-A')
  expect(copy).not.toContain('alpha')
  expect(h.calls.some((c: any) => ['gh', 'curl', 'git'].includes(c.argv[0]))).toBe(false)
})

test('folder: an existing file is never overwritten (-2, -3), a user file keeps its text', async () => {
  const h = setup({ feedback: { destination: 'folder', folder: '~/Downloads' } })
  h.made.add('/h/Downloads')
  h.files.set(`/h/Downloads/${NAME}`, 'mine')
  const a = await run(h)
  expect(a.copy).toBe(`/h/Downloads/${NAME.replace('.md', '-2.md')}`)
  h.clock.t = T0 // same minute again: the export file itself gets -2, the folder copy -3
  const b = await run(h)
  expect(b.copy).toBe(`/h/Downloads/${NAME.replace('.md', '-3.md')}`)
  expect(h.files.get(`/h/Downloads/${NAME}`)).toBe('mine')
})

test('folder: a missing folder, a file instead of a folder, a read-only folder, a refused folder and no folder all fall back to the local copy with the reason', async () => {
  const miss = setup({ feedback: { destination: 'folder', folder: '~/Downloads' } }) // no such folder
  const r1 = await run(miss)
  expect(r1.ok).toBe(true)
  expect(r1.copy).toBeUndefined()
  expect(r1.text).toContain(`folder ~/Downloads does not exist: written to ${EXP}/2026-11-18-1407.md.`)
  expect(cps(miss).length).toBe(0)
  const file = setup({ feedback: { destination: 'folder', folder: '~/Downloads' } })
  file.files.set('/h/Downloads', 'a file')
  expect((await run(file)).text).toContain('~/Downloads is not a folder: written to')
  const ro = setup({ feedback: { destination: 'folder', folder: '~/Downloads' } })
  ro.made.add('/h/Downloads')
  ro.noWrite.add('/h/Downloads')
  const r3 = await run(ro)
  expect(r3.text).toContain('folder ~/Downloads is not writable')
  expect(r3.text).toContain('written to')
  expect([...ro.files.keys()].some(k => k.startsWith('/h/Downloads/'))).toBe(false)
  for (const folder of ['/etc', '~/.ssh', '~/.lean-agent/x', 'Downloads/..']) {
    const h = setup({ feedback: { destination: 'folder', folder } })
    h.made.add('/etc')
    const r = await run(h)
    expect(r.text, folder).toContain('written to')
    expect(r.copy, folder).toBeUndefined()
  }
  const none = await run(setup({ feedback: { destination: 'folder' } }))
  expect(none.text).toContain('feedback.folder is not set: written to')
})

test('a private string that survives anonymising writes nothing anywhere: not the local file, not the folder', async () => {
  const h = fakeHost(null, { home: '/q/zeldaquux' })
  h.clock.t = T0
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.4' }))
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327\n' : '' })
  h.files.set('/q/zeldaquux/.lean-agent/config.json', JSON.stringify({ feedback: { destination: 'folder+github', folder: '~/Downloads' } }))
  h.files.set('/q/zeldaquux/.lean-agent/feedback-drafts/2026-11-18-bug.md', '# bug\nthe laptop is called zeldaquuxbox\n')
  h.made.add('/q/zeldaquux/Downloads')
  const faulty = (real: any) => ({ anonymise: (t: string) => real.anonymise(t).replace(/<user>/g, 'zeldaquux'), name: real.name, missed: real.missed })
  const r = await exportFeedback(h.host, ROOT, { version: '1.0.4' }, { wrap: faulty })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('not written')
  expect([...h.files.keys()].some(k => k.includes('/Downloads/') || k.includes('feedback-export/2'))).toBe(false)
  expect(h.calls.some((c: any) => ['cp', 'gh'].includes(c.argv[0]))).toBe(false)
  expect(h.store.size).toBe(0)
})
