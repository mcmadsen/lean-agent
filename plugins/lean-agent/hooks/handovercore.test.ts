// Pull mode (handover.ts core, pull.ts): the first prompt holds only what changes behaviour (<= 1500 tokens, with 25 reports and a big snapshot);
// the rest is a pull list; a pull returns a section, not the whole store. Synthetic ids, names and paths.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { buildHandover, handoverMode, handoverReport, setPreflight, CORE_TOKENS } from './handover'
import { pullText, sectionOf, headingsOf } from './pull'
import { snapshotFile } from './snapshot'

const L = '/h/.lean-agent'
const T1 = `${L}/threads/t1`
const THREAD = { id: 't1', title: 'fix login', project: 'app', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0 }
const rec = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'
const tok = (s: string) => Math.ceil(s.length / 4)

function world(mode?: 'core' | 'full') {
  const h = fakeHost(null)
  h.clock.t = 1_000_000
  h.files.set(`${T1}/thread.json`, JSON.stringify(THREAD))
  h.files.set(`${T1}/brief.md`, 'fix the login bug\n' + 'BRIEFLINE '.repeat(150) + '\nTAIL-OF-THE-BRIEF')
  h.files.set(`${L}/worktrees.json`, JSON.stringify({ a: { path: '/w/app', branch: 'fix-x', thread: 't1' } }))
  if (mode) h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode } }))
  const reports = Array.from({ length: 25 }, (_, i) => rec({ ts: 100 + i, from: 't1', kind: 'report', state: 'working', text: `REPORT-${i}: ` + 'detail '.repeat(200) }))
  h.files.set(`${L}/desk/inbox.jsonl`, reports.join('') + rec({ ts: 200, from: 't1', kind: 'ask', text: 'which database should the login use? (OPEN-QUESTION)' }))
  h.files.set(`${T1}/inbox.jsonl`, Array.from({ length: 8 }, (_, i) => rec({ ts: 300 + i, from: 'desk', text: `CORRECTION-${i} ` + 'c'.repeat(500) })).join(''))
  h.files.set(`${T1}/notes.md`, '# Notes\n## findings\nNOTES-FINDINGS the login is in src/auth.ts\n## open items\nNOTES-OPEN ask about the db\n### sub\nNOTES-SUB detail\n## later\nNOTES-LATER')
  h.files.set(snapshotFile('/h', 't1'), JSON.stringify({ v: 1, id: 't1', at: 999_000, sid: 's1', dir: '/w/app', branch: 'fix-x', head: 'abc1234567890def', status: Array.from({ length: 40 }, (_, i) => ` M src/file${i}.ts`), diffStat: Array.from({ length: 40 }, (_, i) => ` src/file${i}.ts | 2 +-`).join('\n') + '\n 40 files changed, 40 insertions(+), 40 deletions(-)', edited: Array.from({ length: 40 }, (_, i) => `/w/app/src/file${i}.ts`), tasks: [{ text: 'old step', status: 'completed' }, { text: 'write the login spec', status: 'in_progress' }], lastReport: { ts: 1, state: 'working', text: 'SNAPSHOT-REPORT ' + 'r'.repeat(1400) }, questions: [], tokens: 90_000 }))
  h.git.handler = () => ({ exitCode: 1, stdout: '' })
  setPreflight(async () => 'PREFLIGHT-LINE ' + 'p'.repeat(2000))
  return h
}

test('core is the default; handover.mode "full" is the bounded prompt', async () => {
  const h = world()
  expect(await handoverMode(h.host, '/h')).toBe('core')
  h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode: 'full' } }))
  expect(await handoverMode(h.host, '/h')).toBe('full')
  h.files.set(`${L}/config.json`, JSON.stringify({ handover: { mode: 'nonsense' } }))
  expect(await handoverMode(h.host, '/h')).toBe('core')
  setPreflight(null)
})

test('core prompt with 25 reports and a big snapshot: <= 1500 tokens, every behaviour-critical item inside, no reports / snapshot / preflight / notes', async () => {
  const h = world()
  const ho = await buildHandover(h.host, '/h', THREAD as any, 'The session was restarted.', [])
  setPreflight(null)
  const p = ho.prompt
  expect(tok(p)).toBeLessThanOrEqual(CORE_TOKENS)
  expect(p.startsWith('Resume the work now (task: fix the login bug)')).toBe(true) // (1) the task-first line
  expect(p).toContain('BRIEFLINE')
  expect(p).not.toContain('TAIL-OF-THE-BRIEF') // (2) only the first 600 characters
  expect(p).toContain('## Corrections since the brief') // (3) newest last, at most 5
  expect(p.match(/CORRECTION-\d/g)).toEqual(['CORRECTION-3', 'CORRECTION-4', 'CORRECTION-5', 'CORRECTION-6', 'CORRECTION-7'])
  expect(p).toContain('3 older messages omitted')
  expect(p).toContain('200-t1-ask') // (4) the open question, with its id, verbatim
  expect(p).toContain('which database should the login use? (OPEN-QUESTION)')
  expect(p).toContain('branch fix-x · HEAD abc1234567 · dirty: yes (40 paths) · 40 files changed, 40 insertions(+), 40 deletions(-)') // (5)
  expect(p).toContain('[in_progress] write the login spec') // (6) the next step
  expect(p).toContain('Read only what the next step needs from the pull list; a pull returns a section, not the whole store.') // (7)
  expect(p).toContain(`brief in full: read ${T1}/brief.md (3 lines`)
  expect(p).toContain('earlier reports: lean_run {pull: "reports"} lists 26') // 25 reports and the question
  expect(p).toMatch(/last 3 digests: \/h\/\.lean-agent\/desk\/reports\/\d+-t1-report\.md/)
  expect(p).toContain(`notes: ${T1}/notes.md`)
  expect(p).toContain(`state snapshot: ${snapshotFile('/h', 't1')}`)
  expect(p).toContain('preflight: lean_run {pull: "preflight"}')
  for (const never of ['REPORT-', 'SNAPSHOT-REPORT', 'PREFLIGHT-LINE', 'NOTES-FINDINGS', 'src/file7.ts']) expect(p).not.toContain(never)
})

test('lean_doctor handover shows both modes\' sizes; core is far smaller than full', async () => {
  const h = world()
  const text = await handoverReport(h.host, '/h', 't1')
  const m = /core ~(\d+) tokens \(budget 1500\) · full ~(\d+) tokens \(budget 6000\)/.exec(text)
  setPreflight(null)
  expect(m).not.toBeNull()
  expect(Number(m![1])).toBeLessThanOrEqual(1500)
  expect(Number(m![2])).toBeGreaterThan(Number(m![1]))
  expect(text).toContain('within budget')
  const f = world('full')
  expect(await handoverReport(f.host, '/h', 't1')).toContain('now "full"')
  setPreflight(null)
})

test('pull: headings and sections; a section returns only that section', () => {
  const doc = '# Notes\n## findings\nA\nB\n## open items\nC\n### sub\nD\n## later\nE'
  expect(headingsOf(doc).map(x => `${x.line}:${x.title}`)).toEqual(['1:Notes', '2:findings', '5:open items', '7:sub', '9:later'])
  expect(sectionOf(doc, 'open items')).toBe('## open items\nC\n### sub\nD') // through the sub-heading, up to the next of the same level
  expect(sectionOf(doc, 'FIND')).toBe('## findings\nA\nB')
  expect(sectionOf(doc, 'nothing')).toBeNull()
})

test('pull reports / notes / snapshot / preflight / brief return sections, never the whole store', async () => {
  const h = world()
  const list = await pullText(h.host, '/h', 't1', 'reports')
  expect(list).toContain('26 reports of t1')
  expect(list).not.toContain('last 30 listed') // 26 fit in the list
  expect(list.split('\n').length).toBe(27)
  expect(list.length).toBeLessThan(26 * 130) // one line each, not the texts
  const one = await pullText(h.host, '/h', 't1', 'reports', '3')
  expect(one).toContain('REPORT-2: ')
  expect(one).not.toContain('REPORT-3: ')
  expect(await pullText(h.host, '/h', 't1', 'reports', '-1')).toContain('OPEN-QUESTION')
  expect(await pullText(h.host, '/h', 't1', 'reports', 'REPORT-9:')).toContain('REPORT-9: ')
  const heads = await pullText(h.host, '/h', 't1', 'notes')
  expect(heads).toContain('L2 ## findings')
  expect(heads).not.toContain('NOTES-FINDINGS')
  const sec = await pullText(h.host, '/h', 't1', 'notes', 'open items')
  expect(sec).toContain('NOTES-OPEN')
  expect(sec).toContain('NOTES-SUB')
  expect(sec).not.toContain('NOTES-FINDINGS')
  expect(sec).not.toContain('NOTES-LATER')
  const fields = await pullText(h.host, '/h', 't1', 'snapshot')
  expect(fields).toContain('status: 41 line(s)')
  const snap = await pullText(h.host, '/h', 't1', 'snapshot', 'tasks')
  expect(snap).toContain('[in_progress] write the login spec')
  expect(snap).not.toContain('src/file7.ts')
  expect(await pullText(h.host, '/h', 't1', 'snapshot', 'nope')).toContain('unknown snapshot field nope')
  const pre = await pullText(h.host, '/h', 't1', 'preflight', 'PREFLIGHT')
  expect(pre).toContain('PREFLIGHT-LINE')
  expect(await pullText(h.host, '/h', 't1', 'preflight', 'absent-word')).toContain('no line contains')
  const brief = await pullText(h.host, '/h', 't1', 'brief')
  expect(brief).toContain('3 lines')
  expect(await pullText(h.host, '/h', 't1', 'bogus')).toContain('kind must be one of')
  setPreflight(null)
})
