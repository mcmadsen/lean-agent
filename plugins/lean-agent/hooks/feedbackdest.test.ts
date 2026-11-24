import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { check } from './doctor'
import { destText, feedbackConfig } from './feedbackdest'
import { REPO_URL, exportFeedback } from './feedbackexport'
import { DESK_THREAD, FEEDBACK_REPO, addActionRequest, answerAction, approveAction, bindAnswers, checkAction, listActions, questionOf, resetActions, standingCover, standingEligible } from './deskactions'

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

// ---- github: a typed desk action, never automatic ----------------------------------------------------------------------------------
const URL_OUT = 'https://github.com/mcmadsen/lean-agent/issues/9001\n'
function gh(h: any, o: { auth?: number; create?: number } = {}) {
  const seen: { argv: string[]; body: string | undefined }[] = []
  h.gh.handler = (a: string[]) => {
    if (a[0] === 'auth') return { exitCode: o.auth ?? 0, stdout: '', stderr: '' }
    const f = a[a.indexOf('--body-file') + 1]
    seen.push({ argv: a, body: f ? h.files.get(f) : undefined })
    return { exitCode: o.create ?? 0, stdout: o.create ? '' : `Creating issue in mcmadsen/lean-agent\n\n${URL_OUT}`, stderr: o.create ? 'HTTP 401: bad credentials' : '' }
  }
  return seen
}
const github = (dest = 'github') => {
  resetActions()
  const h = setup({ feedback: { destination: dest, folder: '~/Downloads' } })
  h.made.add('/h/Downloads')
  return h
}
const created = (h: any) => h.calls.filter((c: any) => c.argv[0] === 'gh' && c.argv[1] === 'issue')

test('github: the export ends with ONE desk request holding the exact title and the full anonymised body; nothing is posted until the user approves', async () => {
  const h = github()
  const seen = gh(h)
  const r = await run(h)
  expect(r.ok).toBe(true)
  const local = h.files.get(`${EXP}/2026-11-18-1407.md`)!
  const [v] = await listActions(h.host)
  expect(v).toMatchObject({ thread: DESK_THREAD, kind: 'gh-issue-create', state: 'pending' })
  expect(r.text).toContain(`request ${v!.id} waits for the user's Approve`)
  expect(r.text).toContain('public issue on mcmadsen/lean-agent')
  expect(v!.headline).toBe('post a public issue on mcmadsen/lean-agent: "the opener failed in project-A"')
  expect(v!.text).toBe(`Title: the opener failed in project-A\n\n${local}`)
  expect(local).not.toContain('alpha')
  const q = questionOf(v!)
  expect(q.question).toContain('the desk wants to post a public issue on mcmadsen/lean-agent')
  expect(q.question).toContain(local.trim().slice(0, 60))
  expect(q.options.map(o => o.label)).toEqual(['Approve', 'Deny', 'Edit first'])
  expect(seen.length).toBe(0) // gh auth status ran, `gh issue create` did not
  expect(created(h).length).toBe(0)
  expect(cps(h).length).toBe(0) // destination github alone does not copy to a folder
  expect((await listActions(h.host)).length).toBe(1)
})

test('github: Approve (the pane press) runs gh issue create by argv with the fixed repo, a body file and the title; the file is removed; one approval sends once', async () => {
  const h = github()
  const seen = gh(h)
  await run(h)
  const [v] = await listActions(h.host)
  const local = h.files.get(`${EXP}/2026-11-18-1407.md`)!
  expect((await approveAction(h.host, v!.id)).ok).toBe(false) // no Approve on record: refused
  expect(created(h).length).toBe(0)
  expect((await answerAction(h.host, v!.id, 'approve', 'pane')).ok).toBe(true)
  const out = await approveAction(h.host, v!.id)
  expect(out).toEqual({ ok: true, text: 'posted: https://github.com/mcmadsen/lean-agent/issues/9001' })
  expect(seen.length).toBe(1)
  const argv = seen[0]!.argv
  expect(argv.slice(0, 6)).toEqual(['issue', 'create', '--repo', 'mcmadsen/lean-agent', '--title', 'the opener failed in project-A'])
  expect(argv[6]).toBe('--body-file')
  expect(argv.length).toBe(8)
  expect(seen[0]!.body).toBe(local) // the file held exactly the anonymised export
  expect(h.files.has(argv[7]!)).toBe(false) // and was removed
  expect((await approveAction(h.host, v!.id)).ok).toBe(false) // once
  expect(created(h).length).toBe(1)
})

test('github: the desk\'s own question, answered Approve, is bound to the request id; a Deny posts nothing', async () => {
  const h = github()
  const seen = gh(h)
  await run(h)
  const [v] = await listActions(h.host)
  const q = questionOf(v!)
  const qq = { question: q.question, options: q.options }
  expect((await bindAnswers(h.host, [qq], { [qq.question]: 'Approve' })).join(' ')).toContain(`approved ${v!.id}`)
  expect((await approveAction(h.host, v!.id)).ok).toBe(true)
  expect(seen.length).toBe(1)
  const d = github()
  const seen2 = gh(d)
  await run(d)
  const [w] = await listActions(d.host)
  await answerAction(d.host, w!.id, 'deny', 'pane')
  expect((await approveAction(d.host, w!.id)).ok).toBe(false)
  expect(seen2.length).toBe(0)
})

test('github: a failing gh keeps the request approved and unused, says how to log in; a lost answer is marked used (never posted twice)', async () => {
  const h = github()
  gh(h, { create: 1 })
  await run(h)
  const [v] = await listActions(h.host)
  await answerAction(h.host, v!.id, 'approve', 'pane')
  const out = await approveAction(h.host, v!.id)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('gh issue create failed')
  expect(out.text).toContain('gh auth login')
  expect(out.text).toContain('stays approved')
  expect([...h.files.keys()].some(k => k.includes('.issue-body-'))).toBe(false)
})

test('folder+github: the folder copy is made at once, the post still waits for Approve', async () => {
  const h = github('folder+github')
  gh(h)
  const r = await run(h)
  expect(r.copy).toBe(`/h/Downloads/${NAME}`)
  expect(cps(h).length).toBe(1)
  expect(r.text).toContain('Copied to')
  expect(r.text).toContain('waits for the user\'s Approve')
  expect(created(h).length).toBe(0)
  // folder missing + github: the local copy stays, the request is still offered
  const m = setup({ feedback: { destination: 'folder+github', folder: '~/Downloads' } })
  gh(m)
  const r2 = await run(m)
  expect(r2.text).toContain('does not exist: written to')
  expect(r2.text).toContain('waits for the user\'s Approve')
})

test('github: gh missing or not logged in says so, offers nothing, keeps the local and the folder copy', async () => {
  const none = github('folder+github') // the fake answers 127 for gh by default
  const r1 = await run(none)
  expect(r1.ok).toBe(true)
  expect(r1.text).toContain('Not offered for posting: gh is not installed')
  expect(r1.copy).toBe(`/h/Downloads/${NAME}`)
  expect(none.files.has(`${EXP}/2026-11-18-1407.md`)).toBe(true)
  expect((await listActions(none.host)).length).toBe(0)
  const out = github()
  gh(out, { auth: 1 })
  const r2 = await run(out)
  expect(r2.text).toContain('Not offered for posting: gh is not logged in to github.com (run: gh auth login)')
  expect((await listActions(out.host)).length).toBe(0)
})

test('the repo is FIXED: another repo, a look-alike, a title or body that does not fit are refused; a thread cannot ask, the desk cannot ask a thread\'s kind, a batch cannot hold it', async () => {
  const h = github()
  const p = { repo: 'mcmadsen/lean-agent', title: 'Feedback 1.0.31 x', body: 'text' }
  expect(checkAction({ kind: 'gh-issue-create', params: p }).ok).toBe(true)
  expect(REPO_URL.test(`https://github.com/${FEEDBACK_REPO}`)).toBe(true) // the anonymiser's repo rule and the issue's fixed repo are the same repo
  for (const repo of ['other/repo', 'mcmadsen/lean-agent-x', 'mcmadsen/lean-agent/issues', 'MCMADSEN/lean-agent', 'mcmadsen/lean-agent#x', '']) {
    const c = checkAction({ kind: 'gh-issue-create', params: { ...p, repo } })
    expect([repo, c.ok]).toEqual([repo, false])
    if (!c.ok) expect(c.text).toContain('mcmadsen/lean-agent only')
  }
  for (const bad of [{ title: '' }, { title: '-x' }, { title: 'a'.repeat(121) }, { body: '  ' }, { body: 'x'.repeat(45_001) }, { extra: 1 }]) expect(checkAction({ kind: 'gh-issue-create', params: { ...p, ...bad } }).ok, JSON.stringify(bad).slice(0, 30)).toBe(false)
  h.files.set('/h/.lean-agent/threads/t5/thread.json', '{}')
  expect((await addActionRequest(h.host, 't5', { kind: 'gh-issue-create', params: p })).ok).toBe(false) // a thread
  expect((await addActionRequest(h.host, DESK_THREAD, { kind: 'gh-pr-comment', params: { repo: 'a/b', pr: 1, body: 'x' } })).ok).toBe(false) // the desk, a thread's kind
  expect(checkAction({ kind: 'batch', params: { items: [{ kind: 'gh-issue-create', params: p }] }, items: [{ kind: 'gh-issue-create', params: p }] }).ok).toBe(false)
  expect((await listActions(h.host)).length).toBe(0)
})

test('never covered: no standing approval, grant, rule or own-PR default can send a public issue', async () => {
  const h = github()
  const p = { repo: 'mcmadsen/lean-agent', title: 'Feedback 1.0.31 x', body: 'text' }
  expect(standingEligible('gh-issue-create', p)).toBe(false)
  expect(await standingCover(h.host, DESK_THREAD, 'gh-issue-create', p)).toBeNull()
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ feedback: { destination: 'github' }, actions: { standing: [{ project: 'lean-agent', kinds: ['gh-issue-create'], statuses: ['fixed'] }] } }))
  expect(await standingCover(h.host, DESK_THREAD, 'gh-issue-create', p)).toBeNull()
  const seen = gh(h)
  await run(h)
  const [v] = await listActions(h.host)
  expect(v!.standing).toBeUndefined()
  expect(questionOf(v!).options.length).toBe(3)
  expect((await answerAction(h.host, v!.id, 'approve', 'pane', undefined, true)).ok).toBe(false) // no fourth choice
  expect(seen.length).toBe(0)
})
