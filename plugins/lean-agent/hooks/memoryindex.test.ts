// Retrieval without bloat (memoryindex.ts): the index under its token budget, relevant reminders, triggers, the restart prompt and the desk handover.
// Synthetic names and numbers throughout.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addItem, readItems, resetMemory, tok } from './memory'
import type { Ctx } from './memory'
import { eventOf, indexText, memoryIndex, relevantLine, relevantOnPrompt, resetMemorySession, resetTurn, sessionIndex, triggerLine, triggerOnTool } from './memoryindex'
import { memorySection } from './extras'
import { buildHandover, CORE_TOKENS } from './handover'
import { memoryPull } from './memorytool'

const L = '/h/.lean-agent'
const DESK: Ctx = { role: 'desk', projects: ['form-finder'] }
const T1: Ctx = { role: 'thread', id: 't1', project: 'form-finder', tasks: ['4711'] }
const world = () => {
  resetMemory()
  resetMemorySession()
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'form finder', project: 'form-finder', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', title: 'billing', project: 'billing-api', state: 'open', sid: 's2', created: 1, lastWake: 0, delivered: 0 }))
  h.files.set(`${L}/threads/t1/brief.md`, 'build the form finder\n')
  return h
}
const add = async (h: any, text: string, scope: string, extra: Record<string, unknown> = {}) => {
  h.clock.t += 1000
  const r = await addItem(h.host, '/h', { text, scope, source: 'desk', ...extra } as any, DESK)
  expect([text, r.ok]).toEqual([text, true])
  return r.id!
}

test('the index ranks thread > task > project > global, lists rules only, and never shows another thread\'s or project\'s', async () => {
  const h = world()
  await add(h, 'answer in short sentences', 'global')
  await add(h, 'the changelog stays short', 'project:form-finder')
  await add(h, 'the work item is a bug fix: say so in the PR title', 'task:4711', { kind: 'rule' })
  await add(h, 'keep the plan doc current', 'thread:t1')
  await add(h, 'a billing rule nobody else sees', 'project:billing-api')
  await add(h, 'a rule for thread two only', 'thread:t2')
  await add(h, 'the staging database resets at night', 'project:form-finder', { kind: 'fact' })
  const ix = await memoryIndex(h.host, '/h', T1)
  const lines = ix.text.split('\n')
  expect(lines[0]).toContain('Standing orders from the user')
  expect(lines.slice(1, 5).map(l => l.replace(/^- m\d+ \((\w+)\).*/, '$1'))).toEqual(['thread', 'task', 'project', 'global'])
  expect(ix.text).not.toMatch(/billing|thread two/)
  expect(ix.text).not.toContain('resets at night') // a fact: not in the index
  expect(lines[5]).toBe('1 facts and decisions: lean_run {pull: "memory", section: "<words>"}') // but the thread is told they exist
  // the desk sees its own and the user's habits
  await add(h, 'use the staging branch', 'desk')
  const d = await memoryIndex(h.host, '/h', DESK)
  expect(d.text).toContain('answer in short sentences')
  expect(d.text).toContain('use the staging branch')
  expect(d.text).not.toContain('keep the plan doc current')
  expect(d.text).not.toContain('lean_memory find') // nothing cut, no facts of its own: no footer
})

test('the token budget cuts the lowest-ranked lines and the last line says "+N more: lean_memory find"', async () => {
  const h = world()
  for (let n = 0; n < 12; n++) await add(h, Array.from({ length: 20 }, (_, k) => `qz${n}x${k}`).join(' '), n < 3 ? 'desk' : 'global', { kind: 'rule' }) // 12 orders of about 140 characters, no word in common
  const full = await memoryIndex(h.host, '/h', DESK, { budget: 10_000 })
  expect(full.more).toBe(0)
  expect(full.shown).toHaveLength(12)
  const cut = await memoryIndex(h.host, '/h', DESK) // the default 400
  expect(cut.tokens).toBeLessThanOrEqual(400)
  expect(cut.shown.length).toBeLessThan(12)
  expect(cut.shown.length).toBeGreaterThan(3)
  expect(cut.text.split('\n').pop()).toBe(`+${12 - cut.shown.length} more: lean_memory find <words>`)
  expect(cut.shown.slice(0, 3).sort()).toEqual(['m1', 'm2', 'm3']) // the desk's own first
  h.files.set(`${L}/config.json`, JSON.stringify({ memory: { indexTokens: 120 } }))
  const small = await memoryIndex(h.host, '/h', DESK)
  expect(small.tokens).toBeLessThanOrEqual(120)
  expect(small.shown.length).toBeLessThan(cut.shown.length)
  expect(small.text.split('\n').pop()).toMatch(/^\+\d+ more: lean_memory find/)
})

test('measured: the index of 12 typical standing orders in tokens', async () => {
  const h = world()
  const typical = [
    'after a PR is opened, link the work item and set it to Reviewing', 'answer in short sentences, no recap of what I just said', 'never force push; ask before any push', 'run the linter and the unit tests before every commit',
    'use tabs in the form code', 'name branches fix/<id>-<slug>', 'keep the living plan doc up to date', 'write commit messages in the imperative, 50 characters', 'ask which environment before running a migration', 'prefer small PRs, one concern each',
    'the changelog stays one line per change', 'report in at most five lines when a thread is done',
  ]
  for (const t of typical) await add(h, t, 'global')
  const ix = await memoryIndex(h.host, '/h', DESK)
  ;(globalThis as any).console?.log(`memory index for 12 items: ${ix.tokens} tokens (${ix.text.length} characters, ${ix.shown.length} shown, budget 400)`)
  expect(ix.shown).toHaveLength(12)
  expect(ix.tokens).toBeLessThanOrEqual(400)
  expect(ix.more).toBe(0)
})

test('relevant reminders: a match not in the index, at most 3, once per session, nothing otherwise', async () => {
  const h = world()
  await add(h, 'always run the linter first', 'global') // in the index
  await add(h, 'the staging database resets every night at two', 'project:form-finder', { kind: 'fact' })
  await add(h, 'the staging environment needs the VPN', 'project:form-finder', { kind: 'fact' })
  await add(h, 'staging deploys go through the release pipeline only', 'project:form-finder', { kind: 'decision' })
  await add(h, 'staging data is anonymised monthly by the data team', 'project:form-finder', { kind: 'fact' })
  await add(h, 'the billing api uses cents', 'project:billing-api', { kind: 'fact' })
  expect(await relevantLine(h.host, '/h', T1, 'what time does the weather change today')).toBeNull() // no match: nothing
  const line = (await relevantLine(h.host, '/h', T1, 'is the staging database reset tonight, and does the staging environment need the VPN?'))!
  expect(line.startsWith('memory: ')).toBe(true)
  expect(line.split(' | ')).toHaveLength(2) // the database and the VPN items
  expect(line).toContain('resets every night')
  expect(line).not.toContain('linter') // already in the index: not repeated
  expect(line).not.toContain('cents') // another project's
  expect(tok(line)).toBeLessThanOrEqual(300)
  expect(await relevantLine(h.host, '/h', T1, 'is the staging database reset tonight?')).toBeNull() // reminded once in this session
  resetMemorySession()
  const three = (await relevantLine(h.host, '/h', T1, 'staging staging database environment deploys data anonymised release pipeline VPN reset'))!
  expect(three.split(' | ').length).toBeLessThanOrEqual(3)
  expect((await readItems(h.host, '/h')).filter(i => i.uses > 0).length).toBeGreaterThanOrEqual(2) // a reminder is a use
})

test('an item the budget cut from the index can still be reminded by relevance', async () => {
  const h = world()
  h.files.set(`${L}/config.json`, JSON.stringify({ memory: { indexTokens: 60 } }))
  await add(h, 'the user wants the changelog short and one line per change always', 'global')
  await add(h, 'the user wants commit messages in the imperative mood and short', 'global')
  await add(h, 'the user wants releases tagged only from the main branch after review', 'global')
  const ix = await memoryIndex(h.host, '/h', DESK)
  expect(ix.more).toBeGreaterThan(0)
  const hidden = (await readItems(h.host, '/h')).find(i => !ix.shown.includes(i.id))!
  const line = await relevantLine(h.host, '/h', DESK, hidden.text)
  expect(line).toContain(hidden.id)
})

test('triggers: a rule gets one line at its event with the output path, once per turn', async () => {
  const h = world()
  await add(h, 'keep the living plan doc up to date', 'thread:t1', { trigger: 'after-commit', output: '~/Downloads/plan.md' })
  await add(h, 'run the full suite before a push', 'global', { trigger: 'before-push' })
  await add(h, 'link the work item and set it to Reviewing', 'global', { trigger: 'on-pr-open' })
  const c = (await triggerLine(h.host, '/h', T1, 'after-commit'))!
  expect(c).toBe('memory trigger (after-commit): m1 keep the living plan doc up to date -> update ~/Downloads/plan.md')
  expect(await triggerLine(h.host, '/h', T1, 'after-commit')).toBeNull() // once per turn
  expect(await triggerLine(h.host, '/h', T1, 'before-push')).toBeNull() // never more than one line per turn
  resetTurn()
  expect(await triggerLine(h.host, '/h', T1, 'before-push')).toContain('run the full suite before a push')
  resetTurn()
  expect(await triggerLine(h.host, '/h', T1, 'on-pr-open')).toContain('link the work item')
  resetTurn()
  expect(await triggerLine(h.host, '/h', T1, 'after-step')).toBeNull() // nothing has that trigger
  expect(await triggerLine(h.host, '/h', { role: 'thread', id: 't2', project: 'billing-api' }, 'after-commit')).toBeNull() // another thread: never
  expect((await readItems(h.host, '/h')).find(i => i.id === 'm1')!.uses).toBe(1)
})

test('keyword triggers fire on the prompt that names the word', async () => {
  const h = world()
  await add(h, 'a migration needs the DBA sign-off first', 'global', { trigger: 'keyword:migration' })
  expect(await triggerLine(h.host, '/h', DESK, 'keyword', 'please run the weekly report')).toBeNull()
  expect(await triggerLine(h.host, '/h', DESK, 'keyword', 'run the Migration for the users table')).toContain('DBA sign-off')
})

test('which tool call is which event', () => {
  expect(eventOf('Bash', { command: 'git -C /w/app commit -m "x"' })).toBe('after-commit')
  expect(eventOf('Bash', { command: 'git push origin fix-x' })).toBe('before-push')
  expect(eventOf('Bash', { command: 'gh pr create --title x' })).toBe('on-pr-open')
  expect(eventOf('Bash', { command: 'az repos pr create --title x' })).toBe('on-pr-open')
  expect(eventOf('Bash', { command: 'git status' })).toBeNull()
  expect(eventOf('TaskUpdate', { status: 'completed' })).toBe('after-step')
  expect(eventOf('TaskUpdate', { status: 'in_progress' })).toBeNull()
  expect(eventOf('mcp__lean-agent__lean_run', { checkpoint: { next: 'x' } })).toBe('after-step')
  expect(eventOf('mcp__lean-agent__lean_review', { level: 'full' })).toBe('before-push')
  expect(eventOf('mcp__lean-agent__lean_thread', { action: 'push', pr: { title: 'x' } })).toBe('on-pr-open')
  expect(eventOf('mcp__lean-agent__lean_thread', { action: 'push' })).toBe('before-push')
  expect(eventOf('Read', {})).toBeNull()
})

test('the session section and the prompt hooks: thread and desk, nothing when there is nothing', async () => {
  const h = world()
  expect(await memorySection(h.host, { kind: 'thread', id: 't1' })).toBeNull()
  expect(await memorySection(h.host, { kind: 'plain' })).toBeNull()
  await add(h, 'keep the plan doc current', 'thread:t1', { trigger: 'after-commit' })
  await add(h, 'answer in short sentences', 'global')
  const s = (await memorySection(h.host, { kind: 'thread', id: 't1' }))!
  expect(s).toContain('# lean-agent memory')
  expect(s).toContain('keep the plan doc current')
  expect(s).toContain('answer in short sentences')
  expect(await memorySection(h.host, { kind: 'thread', id: 't2' })).not.toContain('plan doc') // never in another thread
  expect(await memorySection(h.host, { kind: 'desk' })).toContain('answer in short sentences')
  expect(await memorySection(h.host, { kind: 'desk' })).not.toContain('plan doc')
  await add(h, 'the form finder reads the staging database', 'project:form-finder', { kind: 'fact' })
  expect(await relevantOnPrompt(h.host, { kind: 'thread', id: 't1' }, 'the form finder reads which staging database?')).toContain('memory: m3')
  resetTurn()
  expect(await triggerOnTool(h.host, { kind: 'thread', id: 't1' }, 'Bash', { command: 'git commit -m x' })).toContain('after-commit')
  expect(await triggerOnTool(h.host, { kind: 'thread', id: 't1' }, 'Bash', { command: 'ls' })).toBeNull()
})

test('the restart prompt carries the index inside the core budget (thread rules rank first)', async () => {
  const h = world()
  const rec = (o: Record<string, unknown>) => JSON.stringify(o) + '\n'
  h.files.set(`${L}/threads/t1/brief.md`, 'build the form finder\n' + 'BRIEFLINE '.repeat(150))
  h.files.set(`${L}/desk/inbox.jsonl`, Array.from({ length: 25 }, (_, i) => rec({ ts: 100 + i, from: 't1', kind: 'report', state: 'working', text: `REPORT-${i}: ` + 'detail '.repeat(200) })).join(''))
  h.files.set(`${L}/threads/t1/inbox.jsonl`, Array.from({ length: 8 }, (_, i) => rec({ ts: 300 + i, from: 'desk', text: `CORRECTION-${i} ` + 'c'.repeat(500) })).join(''))
  h.git.handler = () => ({ exitCode: 1, stdout: '' })
  await add(h, 'keep the living plan doc up to date in ~/Downloads/plan.md', 'thread:t1', { trigger: 'after-commit', output: '~/Downloads/plan.md' })
  for (const t of ['prefer short answers over long ones', 'run lints before each commit', 'name branches after the ticket', 'tag releases from main only', 'ask before dropping any table', 'log decisions in the plan doc', 'review diffs with stat first', 'keep functions under forty lines', 'write specs before the fix', 'close threads when finished']) await add(h, t, 'global')
  const t = { id: 't1', title: 'form finder', project: 'form-finder', state: 'open', sid: 's1', created: 1, lastWake: 0, delivered: 0 }
  const ho = await buildHandover(h.host, '/h', t as any, 'The session was restarted.', [])
  expect(ho.prompt).toContain('## Standing orders')
  expect(ho.prompt).toContain('keep the living plan doc up to date')
  expect(ho.prompt).toContain('[after-commit -> ~/Downloads/plan.md]')
  expect(ho.prompt.indexOf('keep the living plan doc')).toBeLessThan(ho.prompt.indexOf('prefer short answers')) // rank 1: first
  expect(tok(ho.prompt)).toBeLessThanOrEqual(CORE_TOKENS)
  expect(ho.prompt.startsWith('Resume the work now')).toBe(true)
  const full = await buildHandover(h.host, '/h', t as any, 'x', [], false, 'full')
  expect(full.prompt).toContain('## Standing orders')
  // another thread's restart does not get t1's rule
  const t2 = { id: 't2', title: 'billing', project: 'billing-api', state: 'open', sid: 's2', created: 1, lastWake: 0, delivered: 0 }
  const other = await buildHandover(h.host, '/h', t2 as any, 'x', [])
  expect(other.prompt).not.toContain('living plan doc')
  expect(other.prompt).toContain('prefer short answers')
})

test('what the last session injected is recorded for lean_doctor memory', async () => {
  const h = world()
  await add(h, 'answer in short sentences', 'global')
  await sessionIndex(h.host, { kind: 'thread', id: 't1' })
  const rec = JSON.parse(h.files.get(`${L}/memory/last.json`)!)
  expect(rec.t1).toMatchObject({ indexItems: 1, more: 0, reminders: 0 })
  expect(rec.t1.indexTokens).toBeGreaterThan(10)
  await add(h, 'the staging database resets at night', 'project:form-finder', { kind: 'fact' })
  await relevantLine(h.host, '/h', T1, 'does the staging database reset at night?', 't1')
  expect(JSON.parse(h.files.get(`${L}/memory/last.json`)!).t1).toMatchObject({ reminders: 1 })
})

test('lean_run pull memory: a list, then the full text of what matches', async () => {
  const h = world()
  await add(h, 'the staging database resets every night at two', 'project:form-finder', { kind: 'fact' })
  await add(h, 'answer in short sentences', 'global')
  expect(await memoryPull(h.host, '/h', 't1', '')).toContain('answer in short sentences')
  expect(await memoryPull(h.host, '/h', 't1', 'staging reset')).toContain('resets every night at two')
  expect(await indexText(h.host, '/h', 'desk')).toContain('answer in short sentences')
})
