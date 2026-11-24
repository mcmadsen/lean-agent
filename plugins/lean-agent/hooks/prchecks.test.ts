// 1.0.31: a repo's PR guidelines by script (template headings, title pattern, owners, cached by the hash of the source files), the lint of a PR text, and the checks before a PR is
// created: size, secrets in the diff, draft without a green run. Synthetic repos in the fake host; canned git output; nothing leaves the process.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { guideOf, guideText, lintPr, parseOwners, prTitleOf, templateHeadings, titleStyle } from './prguide'
import { createChecks, greenRun, noteRun, numstatTotals, runPrGuide, scanDiff, sizeNote } from './prchecks'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const TEMPLATE = '<!-- ## Hidden -->\n# Pull request\n\n## Summary\n<!-- what and why -->\n\n## Test plan\n\n## Screenshots (optional)\n\n```\n## Not a heading\n```\n'
const CONV = ['feat(api): add the export endpoint', 'fix(ui): keep the focus ring', 'chore: bump the build image', 'docs: explain the cache', 'fix: handle an empty list', 'feat!: drop the old route']

type World = { titles: string[]; bodies?: string[]; logs: number; diff: string; numstat: string; head: string }
function repo(files: Record<string, string>, w: Partial<World> = {}) {
  const h = fakeHost(null)
  const world: World = { titles: CONV, logs: 0, diff: '', numstat: '', head: SHA, ...w }
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({}))
  for (const [p, t] of Object.entries(files)) h.files.set(`/r/${p}`, t)
  h.git.handler = a => {
    const s = a.join(' ')
    if (s.includes('refs/remotes/origin/HEAD')) return { exitCode: 0, stdout: 'origin/main\n' }
    if (s.includes('rev-parse --verify')) return { exitCode: 0, stdout: SHA + '\n' }
    if (s.includes('rev-parse HEAD')) return { exitCode: 0, stdout: world.head + '\n' }
    if (a.includes('log')) {
      world.logs++
      return { exitCode: 0, stdout: world.titles.map((t, i) => `${t}\x1f${world.bodies?.[i] ?? ''}\x1e`).join('\n') }
    }
    if (a.includes('diff')) return a.includes('--numstat') ? { exitCode: 0, stdout: world.numstat } : { exitCode: 0, stdout: world.diff }
    return { exitCode: 1, stdout: '' }
  }
  return { h, world }
}

test('the template: headings in order, the lone top heading and comments / code fences are not sections, "(optional)" is not required', () => {
  expect(templateHeadings(TEMPLATE)).toEqual({ headings: ['Summary', 'Test plan', 'Screenshots (optional)'], required: ['Summary', 'Test plan'] })
  expect(templateHeadings('no headings here')).toEqual({ headings: [], required: [] })
})

test('CODEOWNERS: the handles, the default reviewers are the * rule; comments are ignored', () => {
  expect(parseOwners('# owners\n* @acme/core dev@acme.test\n/ui/ @acme/ui # the ui\nplain words\n')).toEqual({ owners: ['@acme/core', 'dev@acme.test', '@acme/ui'], reviewers: ['@acme/core', 'dev@acme.test'] })
})

test('titles: "Merged PR 12: x" and "x (#12)" are titles, a plain merge commit names none; the style needs 5 titles and 60% of them', () => {
  expect(prTitleOf('Merged PR 12: AB#7 add it')).toBe('AB#7 add it')
  expect(prTitleOf('fix: the thing (#42)')).toBe('fix: the thing')
  expect(prTitleOf('Merge pull request #3 from o/feat')).toBeNull()
  expect(titleStyle(CONV)).toMatchObject({ kind: 'conventional', example: 'feat(api): add the export endpoint' })
  expect(titleStyle(CONV.slice(0, 4)).kind).toBe('none')
  expect(titleStyle(['AB#1 a', 'AB#2 b', '3 c', 'AB#4 d', 'AB#5 e', 'misc'])).toMatchObject({ kind: 'workitem' })
  expect(titleStyle(['PROJ-1: a', 'PROJ-22: b', 'PROJ-3: c', 'PROJ-4: d', 'PROJ-5: e']).example).toBe('PROJ-1: a')
  expect(titleStyle(['a thing', 'another thing', 'one more', 'again', 'and so on', 'feat: one']).kind).toBe('none')
})

test('guideOf reads the Azure DevOps and GitHub places, CONTRIBUTING and CODEOWNERS; cached under the hash of the source files: a changed file re-reads, an unchanged one does not', async () => {
  const { h, world } = repo({ '.azuredevops/pull_request_template.md': TEMPLATE, 'CONTRIBUTING.md': 'be kind', '.github/CODEOWNERS': '* @acme/core\n' }, { bodies: CONV.map((_, i) => (i < 3 ? 'Related work items: #12' : '')) })
  const a = await guideOf(h.host, 'app', '/r')
  expect(a.cached).toBe(false)
  expect(a.guide).toMatchObject({ headings: ['Summary', 'Test plan', 'Screenshots (optional)'], required: ['Summary', 'Test plan'], owners: ['@acme/core'], reviewers: ['@acme/core'], contributing: ['CONTRIBUTING.md'], workitems: true })
  expect(a.guide.title.kind).toBe('conventional')
  expect(a.guide.sources.sort()).toEqual(['.azuredevops/pull_request_template.md', '.github/CODEOWNERS', 'CONTRIBUTING.md'])
  expect(world.logs).toBe(1)
  const b = await guideOf(h.host, 'app', '/r')
  expect(b.cached).toBe(true)
  expect(world.logs).toBe(1) // the history is not read again
  h.files.set('/r/.azuredevops/pull_request_template.md', `${TEMPLATE}\n## Risks\n`)
  const c = await guideOf(h.host, 'app', '/r')
  expect(c.cached).toBe(false)
  expect(c.guide.required).toEqual(['Summary', 'Test plan', 'Risks'])
  expect(guideText(c.guide)).toContain('description sections: Summary | Test plan | Screenshots (optional) | Risks')
})

test('a repo with a .github template folder, a docs template and a size cap: the first template, capped at 20k characters', async () => {
  const big = `## Summary\n${'x'.repeat(30_000)}\n## After the cap\n`
  const { h } = repo({ '.github/PULL_REQUEST_TEMPLATE/default.md': big })
  const g = (await guideOf(h.host, 'app', '/r')).guide
  expect(g.headings).toEqual(['Summary'])
  const { h: d } = repo({ 'docs/pull_request_template.md': '## Why\n' })
  expect((await guideOf(d.host, 'app', '/r')).guide.required).toEqual(['Why'])
  const { h: n } = repo({})
  expect((await guideOf(n.host, 'app', '/r')).guide).toMatchObject({ headings: [], sources: [], owners: [] })
})

test('lintPr names the exact missing parts: the title pattern, every empty required section, the work item, the test evidence line', () => {
  const g = { sources: [], headings: ['Summary', 'Test plan'], required: ['Summary', 'Test plan'], title: titleStyle(CONV), workitems: true, owners: [], reviewers: [], contributing: [], hash: 'x' }
  const body = '## Summary\nAdds the export endpoint.\n\n## Test plan\n<!-- how -->\n'
  const missing = lintPr(g, { title: 'Add export', body }, { evidence: '412 passed' })
  expect(missing).toHaveLength(4)
  expect(missing[0]).toContain('conventional-commit pattern (like "feat(api): add the export endpoint")')
  expect(missing[1]).toBe('the description section "Test plan" is missing or empty (the PR template has it)')
  expect(missing[2]).toContain('no work item is linked')
  expect(missing[3]).toContain('no test evidence line in the description (the last run: 412 passed)')
  const ok = '## Summary\nAdds it. AB#12\n\n## Test plan\nTested: npm test, 412 passed.\n'
  expect(lintPr(g, { title: 'feat(api): add export', body: ok }, { evidence: '412 passed' })).toEqual([])
  expect(lintPr({ ...g, title: titleStyle([]), workitems: false, required: [] }, { title: 'whatever', body: '' })).toEqual([]) // no guideline, nothing to refuse
  expect(lintPr(g, { title: 'feat: x', body: '## summary:\nok AB#1\n## Test plan\n- [ ]\n' }, {}).join('|')).toContain('"Test plan" is missing or empty') // a bare checkbox is empty; the heading's case and colon do not matter
})

test('size: warn above 400 lines or 15 files (generated files do not count); refuse nothing', () => {
  expect(sizeNote(15, 400)).toBeNull()
  expect(sizeNote(16, 10)).toBe('large PR: consider splitting; 16 files / 10 lines')
  expect(sizeNote(2, 401)).toBe('large PR: consider splitting; 2 files / 401 lines')
  expect(numstatTotals('10\t5\tsrc/a.ts\n-\t-\timg.png\n9000\t1\tpackage-lock.json\n3\t0\ttests/__snapshots__/a.snap\n')).toEqual({ files: 2, lines: 15 })
})

test('secrets: private keys, tokens, connection strings and passwords in URLs are found in ADDED lines with file:line; placeholders, removed lines and an allow marker are not', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +10,4 @@',
    '+const ok = 1', '+-----BEGIN RSA PRIVATE KEY-----', '+const k = "AKIAIOSFODNN7EXAMPLQ"', '-const old = "ghp_' + 'a'.repeat(36) + '"',
    'diff --git a/cfg/db.ini b/cfg/db.ini', '--- /dev/null', '+++ b/cfg/db.ini', '@@ -0,0 +1,5 @@',
    '+Server=db.internal;Database=shop;User Id=app;Password=hunter2hunter2;', '+url=postgres://app:s3cr3tvalue@db.internal/shop', '+url2=postgres://user:password@localhost/x', '+Server=x;Password=<your password>;', '+token = "ghp_' + 'b'.repeat(36) + '" # lean-agent: allow-secret',
  ].join('\n')
  expect(scanDiff(diff)).toEqual([
    { file: 'src/a.ts', line: 11, what: 'a private key' },
    { file: 'src/a.ts', line: 12, what: 'an AWS access key id' },
    { file: 'cfg/db.ini', line: 1, what: 'a connection string with a password' },
    { file: 'cfg/db.ini', line: 2, what: 'a URL with a password in it' },
  ])
  expect(scanDiff('+++ b/a.ts\n@@ -1 +1 @@\n+const apiKey = "' + 'Zx9'.repeat(8) + '"\n+const apiKey2 = "your-api-key-goes-here-123456"\n')).toEqual([{ file: 'a.ts', line: 1, what: 'a hard-coded secret' }])
})

const IN = { dir: '/r', project: 'app', thread: 't1', sha: SHA, remote: 'origin', base: 'main', title: 'feat(api): add the export endpoint', body: '## Summary\nx\n\n## Test plan\nTested.\n', draft: undefined as boolean | undefined }
const TEMPLATE_FILES = { '.github/pull_request_template.md': TEMPLATE }

test('createChecks: a PR text that does not follow the guidelines is refused with the exact parts; the secrets scan refuses with file:line; a clean one passes', async () => {
  const { h, world } = repo(TEMPLATE_FILES)
  const bad = await createChecks(h.host, { ...IN, title: 'Add export', body: '## Summary\nx\n' })
  expect(bad.ok).toBe(false)
  expect(!bad.ok && bad.text).toContain('the title does not follow')
  expect(!bad.ok && bad.text).toContain('the description section "Test plan" is missing or empty')
  expect(!bad.ok && bad.text).toContain('the approval is kept')
  world.diff = '+++ b/src/a.ts\n@@ -1 +5 @@\n+const k = "AKIAIOSFODNN7EXAMPLQ"\n'
  const sec = await createChecks(h.host, IN)
  expect(!sec.ok && sec.text).toContain('src/a.ts:5 (an AWS access key id)')
  world.diff = ''
  expect((await createChecks(h.host, IN)).ok).toBe(true)
})

test('createChecks: no recorded green test run proposes a DRAFT with the reason; draft false overrides; a green run on this commit opens it ready; size is a note', async () => {
  const { h, world } = repo({})
  world.numstat = '300\t200\tsrc/a.ts\n'
  const a = await createChecks(h.host, IN)
  expect(a.ok && a.draft).toBe(true)
  expect(a.ok && a.notes.join(' ')).toContain('opened as a DRAFT: no green test run is recorded for a1b2c3d4')
  expect(a.ok && a.notes.join(' ')).toContain('large PR: consider splitting; 1 files / 500 lines')
  expect((await createChecks(h.host, { ...IN, draft: false })).ok && ((await createChecks(h.host, { ...IN, draft: false })) as any).draft).toBe(false)
  await noteRun(h.host, 't1', '/r', 1, 'FAIL 2 tests') // a red run does not count
  expect(await greenRun(h.host, 't1', SHA)).toBeNull()
  await noteRun(h.host, 't1', '/r', 0, 'ok: 412 passed')
  expect(await greenRun(h.host, 't1', SHA)).toMatchObject({ line: 'ok: 412 passed', exit: 0 })
  const b = await createChecks(h.host, IN)
  expect(b.ok && b.draft).toBe(false)
  world.head = 'b'.repeat(40) // a run on another commit proves nothing for this one
  await noteRun(h.host, 't1', '/r', 0, 'ok')
  expect(await greenRun(h.host, 't1', SHA)).toMatchObject({ line: 'ok: 412 passed' })
  expect(await greenRun(h.host, 't1', 'c'.repeat(40))).toBeNull()
})

test('createChecks: a green run is asked for as evidence when the description says nothing about tests; config pr.checks switches single checks or all off', async () => {
  const { h, world } = repo({})
  await noteRun(h.host, 't1', '/r', 0, 'ok: 412 passed')
  const r = await createChecks(h.host, { ...IN, title: 'x', body: 'Adds the endpoint.' })
  expect(!r.ok && r.text).toContain('no test evidence line in the description (the last run: ok: 412 passed)') // even a repo with no template: the run is on record, say so
  expect((await createChecks(h.host, { ...IN, title: 'fix: x', body: 'Adds the endpoint. Tested: 412 passed.' })).ok).toBe(true)
  world.diff = '+++ b/a.ts\n@@ -1 +1 @@\n+-----BEGIN PRIVATE KEY-----\n'
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ pr: { checks: { secrets: false } } }))
  expect((await createChecks(h.host, IN)).ok).toBe(true)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify({ pr: { checks: false } }))
  const off = await createChecks(h.host, { ...IN, title: 'whatever', body: '' })
  expect(off.ok && off.draft).toBe(false) // every check off: not even the draft proposal
  expect(off.ok && off.notes).toEqual([])
})

test('lean_run pr-guide: the guideline record, the lint of a given text, and the last green run; a folder that is not given or registered is refused', async () => {
  const { h } = repo(TEMPLATE_FILES)
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ id: 't1', project: 'app' }))
  h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ 'app/feat': { path: '/r', thread: 't1' } }))
  const text = await runPrGuide(h.host, 't1', true, undefined)
  expect(text).toContain('description sections: Summary | Test plan | Screenshots (optional)')
  expect(text).toContain('title: conventional commit, like "feat(api): add the export endpoint"')
  expect(text).toContain('no green test run is recorded for this commit')
  const linted = await runPrGuide(h.host, 't1', { title: 'nope', body: '## Summary\nx' }, '/r')
  expect(linted).toContain('lint: refused:')
  expect(linted).toContain('the description section "Test plan" is missing or empty')
  expect(await runPrGuide(h.host, 't1', { title: 'fix: it', body: '## Summary\nx\n## Test plan\nTested.' }, '/r')).toContain('lint: the title and the description follow the guidelines')
  await expect(runPrGuide(h.host, 't9', true, undefined)).rejects.toThrow('pass cwd')
})
