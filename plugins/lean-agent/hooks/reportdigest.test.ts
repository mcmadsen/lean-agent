// A thread's report reaches the DESK as a digest (reportdigest.ts), on every path: the direct send, the auto relay, the inbox read. Synthetic data only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { directLine, relayReports, renderReports, takeReports, threadTool } from './delivery'
import { digestable, reportChars, sentenceCut } from './reportdigest'
import { sectionOf } from './threadask'

const sentence = 'The parser now accepts the new header form. '
const LONG = sentence.repeat(40).trim() // ~1.7k characters of whole sentences
const CFG = '/h/.lean-agent/config.json'

test('sentenceCut: the first n characters cut at a sentence end; no sentence end early enough = a hard cut with an ellipsis; short text whole', () => {
  const c = sentenceCut(LONG, 400)
  expect(c.length).toBeLessThanOrEqual(400)
  expect(c.endsWith('form.')).toBe(true)
  expect(sentenceCut('short.', 400)).toBe('short.')
  const hard = sentenceCut('x'.repeat(1000), 400)
  expect(hard.length).toBe(400)
  expect(hard.endsWith('…')).toBe(true)
  expect(sentenceCut(`${'a'.repeat(397)}😀😀 tail`, 398)).not.toMatch(/[\ud800-\udbff]…?$/) // never a lone surrogate
})

test('reportChars: default 400, desk.reportChars sets it, 0 means the full text, junk falls back', async () => {
  const h = fakeHost(null)
  expect(await reportChars(h.host)).toBe(400)
  h.files.set(CFG, '{"desk":{"reportChars":150}}')
  expect(await reportChars(h.host)).toBe(150)
  h.files.set(CFG, '{"desk":{"reportChars":0}}')
  expect(await reportChars(h.host)).toBe(0)
  h.files.set(CFG, '{"desk":{"reportChars":"lots"}}')
  expect(await reportChars(h.host)).toBe(400)
})

test('only a plain report longer than the limit is digested: a question, a blocked report, an approval or an action request keep their full text', () => {
  const base = { kind: 'report' as const, state: 'done', text: LONG }
  expect(digestable(base, 400)).toBe(true)
  expect(digestable({ ...base, text: 'short' }, 400)).toBe(false)
  expect(digestable(base, 0)).toBe(false)
  expect(digestable({ ...base, kind: 'ask' }, 400)).toBe(false)
  expect(digestable({ ...base, state: 'blocked' }, 400)).toBe(false)
  expect(digestable({ ...base, approval: 'push t1' }, 400)).toBe(false)
})

test('direct send: a long done report arrives as thread id, state, the first 400 characters at a sentence end, the parts, the file path; its size is pinned', async () => {
  const line = directLine({ ts: 5, from: 't7', kind: 'report', state: 'done', text: LONG }, '/h/.lean-agent/desk/reports/5-t7-report.md', { chars: 400, parts: ['sha: abcdef1234', 'branch: fix-x', 'review: green'] }).line
  expect(line).toContain('[lean-agent] t7 done: The parser now accepts')
  expect(line).toContain('\n  sha: abcdef1234\n  branch: fix-x\n  review: green')
  expect(line).toContain('/h/.lean-agent/desk/reports/5-t7-report.md')
  expect(line).toContain('lean_thread report t7 full: true')
  expect(line).toMatch(/<!-- lean:r=5:t7:report -->$/)
  expect(line.length).toBeLessThan(900) // 400 text + the pointer + three part lines + hints: it cannot grow back to the old 1500+
  expect(line).not.toContain(LONG.slice(0, 600))
})

test('direct send through the tool: the long report goes out as a digest, its full text is in the file, and the row counts as delivered', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/desk.json', '{"sid":"d"}')
  const lines: string[] = []
  const r = await threadTool(h.host, 't7', 'lean_report', { text: LONG, state: 'done' }, async (_s, t) => void lines.push(t))
  expect(r.text).toContain('not handed over again')
  expect(lines).toHaveLength(1)
  expect(lines[0]!.length).toBeLessThan(800)
  expect(lines[0]).toContain('/h/.lean-agent/desk/reports/')
  const file = [...h.files.entries()].find(([k]) => /reports\/\d+-t7-report\.md$/.test(k))
  expect(file?.[1]).toContain(LONG)
  // a short report is sent whole, no pointer
  await threadTool(h.host, 't7', 'lean_report', { text: 'short note, all done.', state: 'done' }, async (_s, t) => void lines.push(t))
  expect(lines[1]).toContain('short note, all done.')
  expect(lines[1]).not.toContain('cut:')
})

test('desk.reportChars 0 sends the full text as before (up to the old 1500 cut)', async () => {
  const h = fakeHost(null)
  h.files.set(CFG, '{"desk":{"reportChars":0}}')
  h.files.set('/h/.lean-agent/desk.json', '{"sid":"d"}')
  const lines: string[] = []
  await threadTool(h.host, 't7', 'lean_report', { text: 'a'.repeat(1400), state: 'done' }, async (_s, t) => void lines.push(t))
  expect(lines[0]).toContain('a'.repeat(1400))
})

test('a question and a blocked report keep their whole text through the digest', async () => {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/desk.json', '{"sid":"d"}')
  const lines: string[] = []
  const ask = `${'context '.repeat(100)}which database should it use?`
  await threadTool(h.host, 't7', 'lean_ask', { question: ask, options: ['a', 'b'] }, async (_s, t) => void lines.push(t))
  expect(lines[0]).toContain('which database should it use? [options: a | b]')
  h.clock.t += 10
  const blocked = `${'detail '.repeat(100)}push t7 to origin?`
  await threadTool(h.host, 't7', 'lean_report', { text: blocked, state: 'blocked', approval: 'git push origin b' }, async (_s, t) => void lines.push(t))
  expect(lines[1]).toContain('push t7 to origin?')
  expect(lines[1]).toContain('git push origin b')
})

test('the inbox read path (takeReports) and the auto relay hand over the digest, with the file written and the pointer to it', async () => {
  const h = fakeHost(null)
  await threadTool(h.host, 't7', 'lean_report', { text: LONG, state: 'done' }) // no send: inbox only
  h.clock.t += 10
  await threadTool(h.host, 't8', 'lean_ask', { question: `${'q '.repeat(300)}really?` })
  const text = (await takeReports(h.host))!
  const [rep, ask] = text.split('\n') as [string, string]
  expect(rep).toContain('report from t7 (done): The parser now accepts')
  expect(rep.length).toBeLessThan(900)
  expect(rep).toMatch(/\/h\/\.lean-agent\/desk\/reports\/\d+-t7-report\.md/)
  expect(ask).toContain('really?')
  expect(ask.length).toBeGreaterThan(600) // the question is whole
  const path = /(\/h\/\.lean-agent\/desk\/reports\/\d+-t7-report\.md)/.exec(rep)![1]!
  expect(h.files.get(path)).toContain(LONG)
  // the relay
  h.clock.t += 10
  await threadTool(h.host, 't9', 'lean_report', { text: LONG, state: 'done' })
  const sent: string[] = []
  expect(await relayReports(h.host, { busy: false, last: 0, submit: async t => void sent.push(t) })).toBe(true)
  for (let n = 0; n < 30; n++) await Promise.resolve()
  expect(sent[0]).toContain('report from t9 (done): The parser now accepts')
  expect(sent[0]!.length).toBeLessThan(1300)
  // reportChars 0: the full text, as before
  h.files.set(CFG, '{"desk":{"reportChars":0}}')
  h.clock.t += 10
  await threadTool(h.host, 't9', 'lean_report', { text: LONG, state: 'done' })
  expect((await takeReports(h.host))!).toContain(LONG)
  expect(renderReports([{ ts: 1, from: 't1', kind: 'report', state: 'done', text: LONG }])).toContain(LONG) // no digest argument = full text
})

test('lean_thread report tN: section returns one section of the last report, full: true the whole text', () => {
  const text = '# Result\nall green\n\n## Open items\n- one\n- two\n\n## Next\nmerge'
  expect(sectionOf(text, 'open')).toEqual({ title: 'Open items', body: '- one\n- two' })
  expect(sectionOf(text, 'result')).toEqual({ title: 'Result', body: 'all green\n\n## Open items\n- one\n- two\n\n## Next\nmerge' }) // (a higher heading holds its subsections)
  expect(sectionOf(text, 'nothing')).toEqual({ titles: ['Result', 'Open items', 'Next'] })
})
