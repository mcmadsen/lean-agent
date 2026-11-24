// The one memory store (memory.ts): add, merge, cap, refusals, scope guess, list / retire / edit / confirm / prune, the old notes imported once.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addItem, confirmItem, editItem, findItems, getItem, guessScope, listItems, loosensSafety, mutate, pruneSuggestions, readItems, refuseText, resetMemory, retireItem } from './memory'
import type { Ctx } from './memory'

const L = '/h/.lean-agent'
const DESK: Ctx = { role: 'desk', projects: ['form-finder', 'billing-api'] }
const T1: Ctx = { role: 'thread', id: 't1', project: 'form-finder' }
const fresh = () => {
  resetMemory()
  const h = fakeHost(null)
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'form-finder', state: 'open' }))
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', project: 'billing-api', state: 'open' }))
  return h
}
const add = (h: any, text: string, extra: Record<string, unknown> = {}, ctx: Ctx = DESK) => addItem(h.host, '/h', { text, source: 'desk', ...extra } as any, ctx)

test('add stores an item with id, scope, kind, source and counters in the private store', async () => {
  const h = fresh()
  const r = await add(h, 'always run the linter before a commit', { scope: 'global' })
  expect(r).toMatchObject({ ok: true, id: 'm1' })
  const [i] = await readItems(h.host, '/h')
  expect(i).toMatchObject({ id: 'm1', scope: 'global', kind: 'rule', source: 'desk', uses: 0, status: 'active', created: 1_000_000 })
  expect([...h.files.keys()].some(k => k.endsWith('/memory/items.json'))).toBe(true)
  expect([...h.files.keys()].some(k => /CLAUDE\.md|\.claude\/rules/.test(k))).toBe(false) // never a repo or rule file
  expect((await add(h, 'the staging branch is called next', { scope: 'project:form-finder' })).id).toBe('m2')
})

test('a near-duplicate is merged: "already remembered as m1: updated"', async () => {
  const h = fresh()
  await add(h, 'never force push to the main branch', { scope: 'global' })
  const r = await add(h, 'never force push to main branch ever', { scope: 'global' })
  expect(r.text).toBe('already remembered as m1: updated')
  const items = await readItems(h.host, '/h')
  expect(items).toHaveLength(1)
  expect(items[0]!.text).toBe('never force push to main branch ever')
  // the same words in ANOTHER scope are not a duplicate
  expect((await add(h, 'never force push to the main branch', { scope: 'project:form-finder' })).id).toBe('m2')
})

test('the cap per scope refuses with the 3 oldest least-used to retire', async () => {
  const h = fresh()
  const nouns = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november'.split(' ')
  const verbs = 'quartz ranger sierra tango uniform victor whiskey xray yankee zulu amber basalt'.split(' ')
  for (let n = 0; n < 12; n++) { h.clock.t += 1000; expect((await add(h, `keep ${nouns[n]} apart from ${verbs[n]}`, { scope: 'global' })).ok).toBe(true) }
  await mutate(h.host, '/h', s => { s.items.find(i => i.id === 'm1')!.uses = 5 }) // m1 is used: it is not offered
  const r = await add(h, 'a thirteenth completely unrelated sentence zebra', { scope: 'global' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('global holds 12 of 12')
  expect(r.text).toMatch(/m2 .*m3 .*m4 /)
  expect(r.text).not.toContain('m1 "')
  expect((await readItems(h.host, '/h')).filter(i => i.status === 'active')).toHaveLength(12)
  // a retired item makes room
  await retireItem(h.host, '/h', 'm2', DESK)
  expect((await add(h, 'a thirteenth completely unrelated sentence zebra', { scope: 'global' })).ok).toBe(true)
})

test('the cap is config memory.maxPerScope', async () => {
  const h = fresh()
  h.files.set(`${L}/config.json`, JSON.stringify({ memory: { maxPerScope: 2 } }))
  await add(h, 'first alpha rule', { scope: 'desk' })
  await add(h, 'second bravo rule', { scope: 'desk' })
  expect((await add(h, 'third charlie rule', { scope: 'desk' })).text).toContain('desk holds 2 of 2')
})

test('a text over 200 characters is refused with "shorten it"', async () => {
  const h = fresh()
  const r = await add(h, 'x'.repeat(201) + ' words', { scope: 'global' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('shorten it')
  expect(await readItems(h.host, '/h')).toHaveLength(0)
  expect((await add(h, 'word '.repeat(40).trim(), { scope: 'global' })).ok).toBe(true) // exactly 199 characters
})

test('a secret, an email and a home-folder path are refused; ~/ is fine', async () => {
  const h = fresh()
  for (const bad of ['the key is sk-abcdefghijklmnop1234567890', 'use token: ghp_abcdefghijklmnopqrstuvwxyz0123', 'password = hunter2hunter2', 'mail anna@example.com about it', 'keep the plan in /home/anna/Downloads/plan.md', 'open /Users/anna/Documents/x', 'AKIAABCDEFGHIJKLMNOP is the id', 'bearer is abcd1234abcd']) {
    const r = await add(h, bad, { scope: 'global' })
    expect([bad, r.ok]).toEqual([bad, false])
    expect(r.text).not.toContain('hunter2')
  }
  expect(refuseText('keep the plan in ~/Downloads/plan.md')).toBeNull()
  expect(refuseText('a commit sha 3f2a9c1d8b7e6a5f4c3b2a1d0e9f8a7b6c5d4e3f is fine')).toBeNull()
  expect(await readItems(h.host, '/h')).toHaveLength(0)
  // the output path is a home path made private: stored with ~
  const r = await add(h, 'keep the living plan doc up to date', { scope: 'thread:t1', output: '/h/Downloads/plan.md' })
  expect(r.item!.output).toBe('~/Downloads/plan.md')
})

test('the scope is guessed by script: thread inside a thread, global for a habit on the desk, asked when unclear', async () => {
  expect(guessScope('use tabs', T1)).toEqual({ scope: 'thread:t1' })
  expect(guessScope('after a PR is opened, link the work item and set it to Reviewing', DESK)).toEqual({ scope: 'global' })
  expect(guessScope('in the billing-api keep the changelog short', DESK)).toEqual({ scope: 'project:billing-api' })
  expect(guessScope('t2 should use the staging database', DESK)).toEqual({ scope: 'thread:t2' })
  expect(guessScope('the form finder uses the staging database', DESK)).toEqual({ scope: 'project:form-finder' }) // a project named in words
  expect(guessScope('the staging database is reset at night', DESK)).toHaveProperty('ask')
  const h = fresh()
  const ask = await add(h, 'the staging database is reset at night')
  expect(ask).toMatchObject({ ok: false, ask: true })
  expect(ask.text).toContain('for this thread, this project or always?')
  expect(await readItems(h.host, '/h')).toHaveLength(0)
  expect((await add(h, 'from now on answer in short sentences')).item!.scope).toBe('global')
  expect((await add(h, 'use tabs in the form code', {}, T1)).item!.scope).toBe('thread:t1')
})

test('a thread remembers only for itself, its project or a task: never global, never another thread', async () => {
  const h = fresh()
  expect((await add(h, 'run the linter first', { scope: 'global' }, T1)).text).toContain('ask the desk')
  expect((await add(h, 'run the linter first', { scope: 'thread:t2' }, T1)).ok).toBe(false)
  expect((await add(h, 'run the linter first', { scope: 'project:billing-api' }, T1)).ok).toBe(false)
  expect((await add(h, 'run the linter first', { scope: 'project:form-finder' }, T1)).ok).toBe(true)
  expect((await add(h, 'the work item is a bug fix', { scope: 'task:4711' }, T1)).ok).toBe(true)
  expect((await add(h, 'run the linter again', { scope: 'thread:t9' })).text).toContain('no thread t9') // the desk names a thread that exists
  expect((await add(h, 'x', { scope: 'nonsense' })).text).toContain('is not one of')
  expect((await add(h, 'x y z', { kind: 'bogus', scope: 'global' })).text).toContain('kind must be one of')
  expect((await add(h, 'x y z', { trigger: 'whenever', scope: 'global' })).text).toContain('trigger must be one of')
})

test('a rule that would loosen a safety rule is refused unless the user said it', async () => {
  expect(loosensSafety('never ask me before you push')).toBe(true)
  expect(loosensSafety('push without asking')).toBe(true)
  expect(loosensSafety('auto-approve every reply')).toBe(true)
  expect(loosensSafety('never push without asking')).toBe(false) // tightens
  expect(loosensSafety('always run the linter before a commit')).toBe(false)
  const h = fresh()
  const r = await add(h, 'from now on push without asking', { scope: 'global' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('loosen a safety rule')
  expect((await add(h, 'from now on push without asking', { scope: 'project:form-finder' }, T1)).ok).toBe(false) // a thread: never
  // the user's recorded words, typed with the remember command, allow it
  h.store.set('desk.human.prompts', [{ text: '/lean-agent:remember from now on push without asking', ts: h.clock.t }])
  expect((await add(h, 'from now on push without asking', { scope: 'global' })).ok).toBe(true)
})

test('list groups by scope; retire and edit work; edit refuses what add refuses', async () => {
  const h = fresh()
  await add(h, 'always run the linter before a commit', { scope: 'global' })
  await add(h, 'keep the plan doc current', { scope: 'thread:t1', trigger: 'after-commit', output: '~/Downloads/plan.md' })
  await add(h, 'use staging', { scope: 'desk', kind: 'preference' })
  const all = await listItems(h.host, '/h')
  expect(all.split('\n').filter(l => !l.startsWith(' '))).toEqual(['desk (1)', 'global (1)', 'thread:t1 (1)'])
  expect(all).toContain('m2 rule: keep the plan doc current · after-commit → ~/Downloads/plan.md · uses 0 · today')
  expect(await listItems(h.host, '/h', 'thread:t1')).not.toContain('linter')
  expect(await listItems(h.host, '/h', 'project:zzz')).toBe('nothing remembered for project:zzz')
  expect((await editItem(h.host, '/h', 'm1', 'always run the linter and the formatter before a commit', DESK)).ok).toBe(true)
  expect((await editItem(h.host, '/h', 'm1', 'mail to bob@example.com', DESK)).ok).toBe(false)
  expect((await editItem(h.host, '/h', 'm9', 'whatever words', DESK)).text).toContain('no active item m9')
  expect((await retireItem(h.host, '/h', 'm3', DESK)).text).toContain('retired m3')
  expect(await listItems(h.host, '/h')).not.toContain('use staging')
  expect((await retireItem(h.host, '/h', 'm1', T1)).text).toContain('not yours') // a thread cannot retire the user's global habit
  expect((await retireItem(h.host, '/h', 'm2', T1)).ok).toBe(true)
})

test('find and get return the full text and count a use', async () => {
  const h = fresh()
  await add(h, 'the staging database is reset every night at two', { scope: 'project:form-finder', kind: 'fact' })
  expect(await findItems(h.host, '/h', 'staging reset')).toContain('the staging database is reset every night at two')
  expect(await findItems(h.host, '/h', 'zebra')).toContain('nothing remembered matches')
  expect(await getItem(h.host, '/h', 'm1')).toContain('uses 2')
  expect((await readItems(h.host, '/h'))[0]!.uses).toBe(2)
  expect(await findItems(h.host, '/h', 'staging', T1)).toContain('staging') // its own project
  expect(await findItems(h.host, '/h', 'staging', { role: 'thread', id: 't2', project: 'billing-api' })).toContain('nothing remembered') // another project's: invisible
})

test('prune suggests what to retire and never does it', async () => {
  const h = fresh()
  await add(h, 'the nightly job runs at two', { scope: 'global', kind: 'fact' })
  await add(h, 'always rebase onto main before opening a pull request', { scope: 'global' })
  h.clock.t += 40 * 86_400_000
  await add(h, 'never rebase before opening a pull request in review', { scope: 'global' })
  await add(h, 'keep the plan doc current', { scope: 'thread:t2' })
  await mutate(h.host, '/h', s => { s.items.find(i => i.id === 'm4')!.scope = 'thread:t2' })
  h.files.set(`${L}/threads/t2/thread.json`, JSON.stringify({ id: 't2', state: 'closed' }))
  const p = await pruneSuggestions(h.host, '/h')
  expect(p).toContain('retire m1')
  expect(p).toContain('never used in 40 days')
  expect(p).toContain('retire m2')
  expect(p).toContain('contradicted by the newer m3')
  expect(p).toContain('retire m4')
  expect(p).toContain('its thread t2 is closed')
  expect(p).not.toContain('retire m3')
  expect((await readItems(h.host, '/h')).every(i => i.status === 'active')).toBe(true)
  expect(await pruneSuggestions(fresh().host, '/h')).toBe('nothing to prune')
})

test('a candidate is confirmed; a loosening candidate needs the user\'s own words', async () => {
  const h = fresh()
  await add(h, 'use the staging branch for the form work', { scope: 'global', status: 'candidate' })
  expect((await readItems(h.host, '/h'))[0]!.status).toBe('candidate')
  expect((await confirmItem(h.host, '/h', 'm1')).text).toBe('m1 is active (global)')
  expect((await confirmItem(h.host, '/h', 'm1')).ok).toBe(false)
  await add(h, 'skip the review gate', { scope: 'global', status: 'candidate', source: 'script', viaCommand: false } as any)
  expect((await confirmItem(h.host, '/h', 'm2')).ok).toBe(false)
  h.store.set('desk.human.prompts', [{ text: 'yes confirm m2', ts: h.clock.t }])
  expect((await confirmItem(h.host, '/h', 'm2')).ok).toBe(true)
})

test('the notes lean_remember kept before are imported once: a thread\'s stays the thread\'s, a project\'s the project\'s', async () => {
  const h = fresh()
  h.files.set(`${L}/memory/notes.jsonl`, [{ ts: 5, from: 't1', project: 'form-finder', text: 'tests need docker' }, { ts: 6, from: 't2', text: 'thread two fact' }, { ts: 7, from: 'desk', text: 'no owner' }].map(r => JSON.stringify(r)).join('\n') + '\n')
  const items = await readItems(h.host, '/h')
  expect(items.map(i => [i.scope, i.text, i.kind])).toEqual([['project:form-finder', 'tests need docker', 'fact'], ['thread:t2', 'thread two fact', 'fact']])
  h.files.set(`${L}/memory/notes.jsonl`, '')
  expect(await readItems(h.host, '/h')).toHaveLength(2) // read from items.json now
})
