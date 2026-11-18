import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { readJsonl } from './state'
import { EXPORT_CAP, exportFeedback, logRefusal, makeAnonymiser } from './feedbackexport'
import { resetLocks } from './threads'
import { resetViewCache } from './view'

// sensitive-looking text built from pieces: this file holds no real-looking path, address or key
const USERS = `/${'Users'}`
const HOMES = `/${'home'}`
const EMAIL = `dev${'@'}example.org`
const AKIA = `AKIA${'ABCDEFGHIJKLMNOP'}`
const GH = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}`
const LONG = 'Zq'.repeat(20)
const T0 = Date.UTC(2026, 10, 18, 14, 7)
const EXP = '/h/.lean-agent/feedback-export'
const ROOT = '/p'

function setup(home = '/h') {
  const h = fakeHost(null, { home })
  h.clock.t = T0
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.4' }))
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327 (Claude Code)\n' : '' })
  h.files.set(`${home}/.lean-agent/projects.json`, JSON.stringify({ alpha: { path: '/r/alpha' }, beta: { path: '/r/beta' } }))
  return h
}
const lean = (h: any, p: string) => `${h.home}/.lean-agent/${p}`
const jl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const run = (h: any, o: { notes?: string; version?: string } = {}) => exportFeedback(h.host, ROOT, { version: '1.0.4', ...o })
const read = (h: any, r: { path?: string }) => h.files.get(r.path!)!

// ---- the anonymiser, rule by rule -------------------------------------------------------------------------------------------
test('the home dir and any user\'s home folder (macOS or Linux style) become ~', async () => {
  const h = setup()
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('see /h/.lean-agent/x and /h')).toBe('see ~/.lean-agent/x and ~')
  expect(a.anonymise(`${USERS}/someone/code/a.ts then ${HOMES}/other/b and ${HOMES}/other`)).toBe('~/code/a.ts then ~/b and ~')
  expect(a.anonymise(`${HOMES}/other/b/c`)).toBe('~/b/c')
  expect(a.anonymise('/hx/not-home')).toBe('/hx/not-home')
})

test('emails, URLs (only the lean-agent repo stays), azure organisations', async () => {
  const a = await makeAnonymiser(setup().host)
  expect(a.anonymise(`mail ${EMAIL}.`)).toBe('mail <email>.')
  expect(a.anonymise('see https://github.com/mcmadsen/lean-agent/issues/12 and https://github.com/someone/else and http://x.example/a?b=1.')).toBe('see https://github.com/mcmadsen/lean-agent/issues/12 and <url> and <url>.')
  expect(a.anonymise('dev.azure.com/acme/widgets/_git/repo')).toBe('dev.azure.com/<org>/<org>/_git/repo')
  expect(a.anonymise('https://dev.azure.com/acme/widgets/_git/repo')).toBe('<url>')
  expect(a.anonymise('acme.visualstudio.com/widgets')).toBe('<org>.visualstudio.com/widgets')
})

test('project names become project-A, B ... through a stable local map that is never exported; a name inside a longer word is left', async () => {
  const h = setup()
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('alpha failed, beta ok, alpha-api and alpha/src, Alpha again, alphabet')).toBe('project-A failed, project-B ok, project-A-api and project-A/src, project-A again, alphabet')
  expect(JSON.parse(h.files.get(`${EXP}/projects.map.json`)!)).toEqual({ alpha: 'project-A', beta: 'project-B' })
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ gamma: {}, beta: {}, alpha: {} })) // another order, one more
  const b = await makeAnonymiser(h.host)
  expect(b.anonymise('gamma alpha beta')).toBe('project-C project-A project-B') // the labels stay with their names
  h.files.set('/h/.lean-agent/threads/t3/thread.json', JSON.stringify({ id: 't3', project: 'delta' })) // a thread's project counts too
  expect((await makeAnonymiser(h.host)).anonymise('delta t3')).toBe('project-D t3')
})

test('thread ids stay; hashes, ticket and PR numbers, tokens and keys are replaced', async () => {
  const a = await makeAnonymiser(setup().host)
  expect(a.anonymise('t12 and t3 reported')).toBe('t12 and t3 reported')
  expect(a.anonymise('commit abc1234def and 1234567 and 20261118')).toBe('commit <sha> and 1234567 and 20261118') // digits alone are not a hash
  expect(a.anonymise('PR #42, pull request 7, ticket 99, issue#5, #123, ABC-123, UTF-8, SHA-256')).toBe('PR #<id>, pull request <id>, ticket <id>, issue#<id>, #<id>, <id>, UTF-8, SHA-256')
  expect(a.anonymise(`key ${AKIA} and ${GH} and ${LONG}`)).toBe('key <secret> and <secret> and <secret>')
  expect(a.anonymise('token = "abcdefgh12345678" and password: hunter2hunter2 and Authorization: Bearer abcdef1234567890xyz')).toBe('token = "<secret>" and password: <secret> and Authorization: <secret>')
  expect(a.anonymise('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----')).toBe('<secret>')
})

test('the OS user name becomes <user> (as a word); running the anonymiser twice changes nothing', async () => {
  const h = setup('/q/zeldaquux')
  const a = await makeAnonymiser(h.host)
  expect(a.anonymise('zeldaquux-laptop and /q/zeldaquux/code')).toBe('<user>-laptop and ~/code')
  const all = `${USERS}/x/y alpha ${EMAIL} https://example.com PR #4 abc1234def ${AKIA} /q/zeldaquux zeldaquux t1`
  const once = a.anonymise(all)
  expect(a.anonymise(once)).toBe(once)
  const g = await makeAnonymiser(setup('/home/root').host) // a generic user name is not replaced as a word
  expect(g.anonymise('root cause')).toBe('root cause')
  const p = await makeAnonymiser((() => { const x = setup(); x.files.set('/h/.lean-agent/projects.json', JSON.stringify({ project: {} })); return x })().host)
  const once2 = p.anonymise('the project failed')
  expect(p.anonymise(once2)).toBe(once2) // a project called "project" does not eat its own label
})

// ---- the survival check -----------------------------------------------------------------------------------------------------
test('a private string the rules cannot catch makes the export refuse: nothing is written, no state changes, the rule is named, the string is not echoed', async () => {
  const h = setup('/q/zeldaquux')
  h.files.set('/q/zeldaquux/.lean-agent/feedback-drafts/2026-11-18-bug.md', '# bug\nthe laptop is called zeldaquuxbox and it hangs\n')
  const a = await makeAnonymiser(h.host)
  expect(a.missed('zeldaquuxbox')).toEqual(['user name']) // embedded in a longer word: the replacement leaves it, the check does not
  expect(a.missed('fine ~/code <user> project-A <url> <email>')).toEqual([])
  const r = await run(h)
  expect(r.ok).toBe(false)
  expect(r.text).toContain('refused')
  expect(r.text).toContain('user name')
  expect(r.text).not.toContain('zeldaquuxbox')
  expect([...h.files.keys()].some(k => k.includes('feedback-export/2'))).toBe(false)
  expect(h.files.has('/q/zeldaquux/.lean-agent/feedback-export/state.json')).toBe(false)
  expect(h.writes.some(w => w.endsWith('.md') && w.includes('feedback-export'))).toBe(false)
})

test('the check names each kind of miss', async () => {
  const h = setup('/q/zeldaquux')
  const a = await makeAnonymiser(h.host)
  expect(a.missed('/q/zeldaquux/code')).toContain('home directory')
  expect(a.missed(`${USERS}/x/y`)).toContain('/Users or /home path')
  expect(a.missed(`x ${EMAIL}`)).toContain('email address')
  expect(a.missed(`x ${AKIA}`)).toContain('token or key')
  expect(a.missed('https://example.com/a')).toContain('URL')
  expect(a.missed('dev.azure.com/acme/x')).toContain('azure organisation')
  expect(a.missed('the alpha repo')).toContain('project name')
})

// ---- the export -------------------------------------------------------------------------------------------------------------
test('the file has the environment, doctor problems and notes first; the path is returned; nothing is posted', async () => {
  const h = setup()
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.5' })) // installed newer than running
  const r = await run(h, { notes: `the desk froze in alpha, mail ${EMAIL}` })
  expect(r.ok).toBe(true)
  expect(r.path).toBe(`${EXP}/2026-11-18-1407.md`)
  expect(r.text).toContain(r.path!)
  expect(r.text).toContain('Nothing was posted')
  const t = read(h, r)
  expect(t.indexOf('## Notes')).toBeGreaterThan(-1)
  expect(t.indexOf('## Notes')).toBeLessThan(t.indexOf('## Environment'))
  expect(t).toContain('the desk froze in project-A, mail <email>')
  expect(t).toContain('lean-agent running: 1.0.4; installed: 1.0.5 (SKEW')
  expect(t).toContain('Claude Code: 2.1.327 (Claude Code)')
  expect(t).toContain('OS family: macOS (Darwin)')
  expect(t).toContain('## Doctor check: problems')
  expect(t).toMatch(/- desk folder/)
  expect(t).not.toContain('alpha')
  h.files.set(`${ROOT}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.4' }))
  expect(read(h, await run(h))).toContain('installed: 1.0.4')
  expect(read(h, await run(h))).not.toContain('SKEW')
})

test('LEAN-FEEDBACK since the last export: counts by status, texts grouped and de-duplicated with counts, most repeated first', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback.jsonl'), jl([
    { ts: 1, status: 'done' }, { ts: 2, status: 'done' }, { ts: 3, status: 'done', refused: 'git push was refused for t4' }, { ts: 4, status: 'partial', unverified: 'did not run the tests', unreached: 'the staging box' },
    { ts: 5, status: 'done', refused: 'Git push was  refused for t4' }, { ts: 6, kind: 'core-candidate', script: 'x' }, { ts: 7, status: 'failed', missing: true },
  ]))
  h.files.set(lean(h, 'gaps.jsonl'), jl([{ ts: 8, text: 'build flags for src/a.ts' }, { ts: 9, text: 'Build flags for src/a.ts ' }, { ts: 10, text: 'build  flags for SRC/A.ts' }, { ts: 11, text: 'which db does alpha use' }]))
  h.files.set(lean(h, 'alpha/gaps.jsonl'), jl([{ ts: 12, text: 'which db does alpha use' }]))
  const t = read(h, await run(h))
  expect(t).toContain('Reports: 6 (done 4, partial 1, failed 1)') // the core candidate row is not a report
  expect(t).toContain('done 4')
  expect(t).toContain('partial 1')
  expect(t).toContain('failed 1')
  expect(t).toContain('### missing')
  expect(t.indexOf('- (x3) build flags for src/a.ts')).toBeGreaterThan(-1)
  expect(t.indexOf('- (x3) build flags for src/a.ts')).toBeLessThan(t.indexOf('- (x2) which db does project-A use')) // most repeated first
  expect(t).toContain('### refused')
  expect(t).toContain('- (x2) git push was refused for t4')
  expect(t).toContain('### unverified\n\n- did not run the tests')
  expect(t).toContain('### unreached\n\n- the staging box')
})

test('guard refusals: grouped by text and agent type with counts', async () => {
  const h = setup()
  await logRefusal(h.host, { text: 'lean-agent: reader-haiku is read-only', agent: 'lean-agent:reader-haiku', tool: 'Edit', thread: 't1' })
  await logRefusal(h.host, { text: 'lean-agent: reader-haiku is read-only', agent: 'lean-agent:reader-haiku', tool: 'Edit' })
  await logRefusal(h.host, { text: 'lean-agent: reader-haiku is read-only', agent: 'lean-agent:worker-sonnet', tool: 'Edit' })
  await logRefusal(h.host, { text: 'strict mode: route this to a thread' })
  const rows = await readJsonl<any>(h.host, lean(h, 'logs/refusals.jsonl'))
  expect(rows).toHaveLength(4)
  expect(rows[0]).toMatchObject({ text: 'lean-agent: reader-haiku is read-only', agent: 'lean-agent:reader-haiku', tool: 'Edit', thread: 't1' })
  const t = read(h, await run(h))
  expect(t).toContain('## Guard refusals since the last export')
  expect(t).toContain('- (x2) [reader-haiku] lean-agent: reader-haiku is read-only')
  expect(t).toContain('- (x1) [worker-sonnet] lean-agent: reader-haiku is read-only')
  expect(t).toContain('- (x1) [session] strict mode: route this to a thread')
})

test('drafts, core candidates and blocked reports go in once; the next export has only what is new', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback-drafts/2026-11-18-a.md'), '# draft a\nsteps in alpha\n')
  h.files.set(lean(h, 'scripts/candidates/ledger-total/meta.json'), JSON.stringify({ name: 'ledger-total', status: 'candidate', core: true, purpose: 'Total the cost ledger', run: 'python3 {script} <ledger.jsonl>', inputs: ['ledger.jsonl'], outputs: ['stdout'], sha256: 'x', file: 'a.py' }))
  h.files.set(lean(h, 'scripts/candidates/plain/meta.json'), JSON.stringify({ name: 'plain', status: 'candidate', purpose: 'x', run: 'python3 {script}', inputs: ['x'], outputs: ['stdout'], sha256: 'y', file: 'a.py' }))
  h.files.set(lean(h, 'desk/inbox.jsonl'), jl([
    { ts: 1, from: 't1', kind: 'report', state: 'blocked', text: 'cannot reach the repo\nsecond line' }, { ts: 2, from: 't2', kind: 'report', state: 'working', text: 'fine' },
    { ts: 3, from: 't3', kind: 'report', state: 'blocked', text: 'needs a decision about alpha' }, { ts: 4, from: 't4', kind: 'ask', state: 'blocked', text: 'a question' },
  ]))
  const first = read(h, await run(h))
  expect(first).toContain('### 2026-11-18-a.md')
  expect(first).toContain('steps in project-A')
  expect(first).toContain('## Script candidates for lean-agent core')
  expect(first).toContain('ledger-total: Total the cost ledger')
  expect(first).not.toContain('- plain:')
  expect(first).toContain('- t3: needs a decision about project-A')
  expect(first).toContain('- t1: cannot reach the repo\n')
  expect(first).not.toContain('second line')
  expect(first).not.toContain('t2: fine')
  expect(first).not.toContain('a question')
  expect(JSON.parse(h.files.get(`${EXP}/state.json`)!)).toEqual({ at: T0, drafts: ['2026-11-18-a.md'], core: ['ledger-total'] })
  h.clock.t = T0 + 30_000 // the same minute: the file gets a suffix, nothing is overwritten
  h.files.set(lean(h, 'feedback-drafts/2026-11-18-b.md'), '# draft b\n')
  h.files.set(lean(h, 'desk/inbox.jsonl'), h.files.get(lean(h, 'desk/inbox.jsonl'))! + jl([{ ts: T0 + 10_000, from: 't9', kind: 'report', state: 'blocked', text: 'new block' }]))
  const second = await run(h)
  expect(second.path).toBe(`${EXP}/2026-11-18-1407-2.md`)
  const t = read(h, second)
  expect(t).toContain('### 2026-11-18-b.md')
  expect(t).not.toContain('2026-11-18-a.md')
  expect(t).not.toContain('Script candidates')
  expect(t).toContain('- t9: new block')
  expect(t).not.toContain('t1: cannot reach')
  expect(h.files.get(`${EXP}/2026-11-18-1407.md`)).toBe(first) // the first file is untouched
  expect(JSON.parse(h.files.get(`${EXP}/state.json`)!).drafts).toEqual(['2026-11-18-a.md', '2026-11-18-b.md'])
  // a third export with nothing new still works and says what it covers
  h.clock.t = T0 + 120_000
  const third = read(h, await run(h))
  expect(third).toContain('since the last export')
  expect(third).not.toContain('## Drafts')
})

test('a size cap of 40 KB: the oldest and least repeated items are summarised, long drafts are cut', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback-drafts/2026-11-18-long.md'), `# long\n${'a long draft line about nothing in particular\n'.repeat(5000)}`)
  h.files.set(lean(h, 'gaps.jsonl'), jl(Array.from({ length: 800 }, (_, i) => ({ ts: 100 + i, text: `gap number ${i} with a fairly long description of the missing context ${'x'.repeat(60)}` }))))
  h.files.set(lean(h, 'gaps.jsonl'), h.files.get(lean(h, 'gaps.jsonl'))! + jl(Array.from({ length: 5 }, () => ({ ts: 5000, text: 'the one that repeats' }))))
  const r = await run(h)
  expect(r.ok).toBe(true)
  const t = read(h, r)
  expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(EXPORT_CAP)
  expect(t).toContain('(truncated at')
  expect(t).toMatch(/_\.\.\. \d+ more entries summarised \(oldest \/ least repeated\)\._/)
  expect(t).toContain('- (x5) the one that repeats') // the repeated one survives the cut
  expect(t).not.toContain('gap number 0 ') // an old single one does not
})

test('no network and no posting: the only processes are claude --version, uname and the file helpers', async () => {
  const h = setup()
  h.files.set(lean(h, 'feedback-drafts/a.md'), '# x\n')
  await run(h, { notes: 'hello' })
  const used = new Set(h.calls.map(c => c.argv[0]))
  for (const bad of ['gh', 'curl', 'wget', 'git', 'ssh', 'nc', 'open']) expect(used.has(bad), bad).toBe(false)
  expect([...used].every(c => ['claude', 'uname', 'mkdir', 'mv', 'rm', 'tee', 'sleep'].includes(c!))).toBe(true)
  expect(h.calls.filter(c => c.argv[0] === 'claude').every(c => c.argv[1] === '--version')).toBe(true)
})

// ---- wiring -----------------------------------------------------------------------------------------------------------------
const PLUGIN = decodeURIComponent(new URL('..', (import.meta as any).url).pathname).replace(/\/$/, '')
async function session($: any, on: any, cwd: string) {
  const h = fakeHost(on)
  resetLocks()
  resetViewCache()
  h.clock.t = T0
  on('clock.after', () => new Promise(() => {}))
  on('clock.every', () => ({ value: { cancel() {} } }))
  h.files.set(`${PLUGIN}/templates/front-desk.md`, 'desk {{lean}}')
  h.files.set(`${PLUGIN}/templates/thread.md`, '# {{id}}')
  h.files.set(`${PLUGIN}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.4' }))
  h.claude.handler = (a: string[]) => ({ exitCode: 0, stdout: a[0] === '--version' ? '2.1.327' : a[0] === 'agents' ? '[]' : '' })
  h.files.set('/h/.lean-agent/projects.json', JSON.stringify({ alpha: { path: '/r/alpha' } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any)
  return h
}

test('/lean-agent-feedback works in any session: writes the file, prints its path, takes the notes as the argument', async ($, on) => {
  const h = await session($, on, '/h/.claude/spares/spare-abc') // a plain session
  const r: any = await $.command.run({ command: 'lean-agent-feedback', args: 'the opener failed in alpha' } as any)
  expect(r.text).toContain(`${EXP}/2026-11-18-1407.md`)
  const t = h.files.get(`${EXP}/2026-11-18-1407.md`)!
  expect(t).toContain('the opener failed in project-A')
  expect(t).not.toContain('alpha')
})

test('the desk\'s lean_doctor export writes the same file; a refusal is an error result', async ($, on) => {
  const h = await session($, on, '/h/lean-agent-desk')
  const r: any = await $.tool.call({ tool: 'mcp__lean-agent__lean_doctor', action: 'export', notes: 'from the desk' } as any)
  expect(r.isError).toBeUndefined()
  expect(r.result).toContain('feedback export written')
  expect(h.files.get(`${EXP}/2026-11-18-1407.md`)).toContain('from the desk')
})

test('a refused guard decision is logged for the export', async ($, on) => {
  const h = await session($, on, '/h/lean-agent-desk')
  const r: any = await $.tool.call({ tool: 'Edit', file_path: '/r/x.ts' } as any) // strict mode: the desk edits nothing
  expect(r.deny).toBeTruthy()
  const rows = await readJsonl<any>(h.host, '/h/.lean-agent/logs/refusals.jsonl')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ tool: 'Edit' })
  expect(rows[0].text).toContain('strict mode')
})
