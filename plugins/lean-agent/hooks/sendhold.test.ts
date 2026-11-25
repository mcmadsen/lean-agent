// A covered request must not send unseen or against a newer instruction (sendhold.ts): synthetic ids, names and numbers only.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { addActionRequest, listActions, resetActions, runStanding } from './deskactions'
import { allowWrites, runGranted } from './deskwrites'
import { recordHumanPrompt } from './humanprompts'
import { cancelHeld, holdLines, holdSeconds, holdsTick, holdsView, sendHeldNow } from './sendhold'
import { leanThread, resetLocks } from './threads'

const TOKEN = 'SECRET-TOKEN-0123456789'
const L = '/h/.lean-agent'
const T0 = 5_000_000
const REPLY = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, thread: 7, body: 'Fixed in the next commit.' }
const STATUS = { org: 'acme', project: 'Shop App', repo: 'shop-api', pr: 42, thread: 7, status: 'fixed' }

async function setup(config: unknown = undefined) {
  const h = fakeHost(null)
  resetLocks()
  resetActions()
  h.clock.t = T0
  h.files.set(`${L}/threads/t5/thread.json`, JSON.stringify({ id: 't5', title: 'x', project: 'app', state: 'open', sid: '', created: 1, lastWake: T0 - 3_600_000, delivered: 0 }))
  h.files.set(`${L}/projects.json`, JSON.stringify({ app: { path: '/r/app' } }))
  if (config !== undefined) h.files.set(`${L}/config.json`, JSON.stringify(config))
  h.git.handler = a => (a.includes('get-url') ? { exitCode: 0, stdout: 'https://dev.azure.com/acme/Shop%20App/_git/shop-api\n' } : { exitCode: 1, stdout: '' })
  h.exec.handler = argv => (argv[0] === 'az' ? { exitCode: 0, stdout: `${TOKEN}\n` } : argv[0] === 'curl' ? { exitCode: 0, stdout: JSON.stringify({ id: 77, url: 'https://dev.azure.com/acme/_apis/x/77' }) } : { exitCode: 127, stdout: '', stderr: 'unknown' })
  const writers = () => h.calls.filter(c => c.argv[0] === 'curl')
  const say = (text: string) => recordHumanPrompt(h.host, { text, wait: false, origin: { kind: 'composer' } })
  const told: string[] = []
  const tell = async (thread: string, text: string) => void told.push(`${thread}|${text}`)
  const run = async (id: string) => (await runStanding(h.host, id)) ?? (await runGranted(h.host, id))
  // the user's written instruction (a grant), then the desk delivered it to the thread: nothing newer is pending
  expect(await say('please fix the comments on PR 42')).toBe(true)
  expect((await allowWrites(h.host, 't5', { pr: 42 })).ok).toBe(true)
  h.clock.t += 2_000
  h.files.set(`${L}/threads/t5/delivered-at.json`, JSON.stringify({ at: h.clock.t }))
  return { h, writers, say, told, tell, run }
}
type S = Awaited<ReturnType<typeof setup>>
const ask = async (s: S, params: Record<string, unknown>, kind = 'ado-pr-reply') => {
  const made = await addActionRequest(s.h.host, 't5', { kind, params, why: 'the PR needs it' })
  expect(made.ok, made.text).toBe(true)
  return made.request!.id
}
const tick = (s: S) => holdsTick(s.h.host, { run: s.run, tell: s.tell })

test('a recorded prompt newer than the last delivery (within 30 min) holds the covered request: not sent, asked as usual, said to the desk', { timeoutMs: 20_000 }, async () => {
  const s = await setup()
  s.h.clock.t += 5_000
  await s.say('wait, do not promise the refactor in the reply, only fix the typo')
  const id = await ask(s, REPLY)
  const r = await s.run(id)
  expect(r).toEqual({ sent: false, line: 'a newer instruction from you may not have reached t5: wait, do not promise the refactor in the reply, only fix the typo' })
  expect(s.writers()).toHaveLength(0)
  expect((await listActions(s.h.host)).find(a => a.id === id)?.state).toBe('pending') // the user is asked as usual
  expect(await holdLines(s.h.host)).toContain('not sent: t5: a newer instruction from you may not have reached t5')
  expect(await holdLines(s.h.host)).toBeNull() // said once
  // a status change is held by the same rule
  const st = await ask(s, STATUS, 'ado-pr-thread-status')
  expect((await s.run(st))?.sent).toBe(false)
  // 80 characters at most
  const long = await setup()
  long.h.clock.t += 5_000
  await long.say('x'.repeat(200))
  expect(((await long.run(await ask(long, REPLY)))?.line ?? '').endsWith(`${'x'.repeat(79)}…`)).toBe(true)
})

test('a prompt that was delivered, one older than 30 minutes, or none: no hold by the newer-instruction rule', { timeoutMs: 20_000 }, async () => {
  const s = await setup({ actions: { holdSeconds: 0 } })
  s.h.clock.t += 5_000
  await s.say('also mention the test')
  s.h.files.set(`${L}/threads/t5/delivered-at.json`, JSON.stringify({ at: s.h.clock.t + 1_000 })) // the desk delivered it afterwards
  s.h.clock.t += 2_000
  expect((await s.run(await ask(s, REPLY)))?.sent).toBe(true)
  const old = await setup({ actions: { holdSeconds: 0 } })
  old.h.clock.t += 5_000
  await old.say('an old instruction')
  old.h.clock.t += 31 * 60_000
  expect((await old.run(await ask(old, REPLY)))?.sent).toBe(true)
  expect(old.writers()).toHaveLength(1)
})

test('hold window: a covered reply waits actions.holdSeconds (default 30), its exact text is shown, and it is sent when the window ends', { timeoutMs: 20_000 }, async () => {
  const s = await setup()
  const id = await ask(s, REPLY)
  const r = await s.run(id)
  expect(r?.sent).toBe(true)
  expect(r?.line).toBe(`held 30 s before sending, then it goes out unless you cancel (the pane has Send now / Cancel; lean_thread action-cancel ${id} with text = your reason; on: true extends the hold once by 30 s): Fixed in the next commit.`)
  expect(s.writers()).toHaveLength(0)
  const [x] = await holdsView(s.h.host)
  expect(x).toMatchObject({ id, thread: 't5', text: 'Fixed in the next commit.', until: s.h.clock.t + 30_000 })
  expect(await holdLines(s.h.host)).toContain('t5: 30 s until this goes out: Fixed in the next commit.')
  s.h.clock.t += 20_000
  expect(await tick(s)).toEqual([])
  expect(s.writers()).toHaveLength(0)
  expect(await holdLines(s.h.host)).toContain('10 s until this goes out')
  s.h.clock.t += 11_000
  const notes = await tick(s)
  expect(s.writers()).toHaveLength(1)
  expect(notes[0]!.text).toContain('sent under your instruction')
  expect(await tick(s)).toEqual([]) // once
  expect(s.writers()).toHaveLength(1)
  expect(await holdsView(s.h.host)).toEqual([])
})

test('status-only kinds and actions.holdSeconds 0 are not held', { timeoutMs: 20_000 }, async () => {
  const s = await setup()
  expect((await s.run(await ask(s, STATUS, 'ado-pr-thread-status')))?.sent).toBe(true)
  expect(s.writers()).toHaveLength(1)
  const z = await setup({ actions: { holdSeconds: 0 } })
  expect((await z.run(await ask(z, REPLY)))?.line).toContain('sent under your instruction')
  expect(z.writers()).toHaveLength(1)
  const c = await setup({ actions: { holdSeconds: 5 } })
  expect((await c.run(await ask(c, REPLY)))?.line).toContain('held 5 s')
})

test('Cancel (the pane) and action-cancel (the desk): nothing is sent, the thread is told, the request stays pending for the user\'s own answer', { timeoutMs: 20_000 }, async () => {
  const s = await setup()
  const id = await ask(s, REPLY)
  await s.run(id)
  const o = await cancelHeld(s.h.host, id, s.tell)
  expect(o).toEqual({ ok: true, text: `cancelled ${id}: nothing was sent; t5 was told (by the user); the request stays pending for the user's own answer` })
  expect(s.told.join('\n')).toContain('was cancelled by the user before it was sent')
  expect((await listActions(s.h.host)).find(a => a.id === id)?.state).toBe('pending')
  s.h.clock.t += 40_000
  expect(await tick(s)).toEqual([])
  expect(s.writers()).toHaveLength(0)
  expect(await cancelHeld(s.h.host, id)).toMatchObject({ ok: false })
  // through the desk's tool
  const id2 = await ask(s, { ...REPLY, thread: 8 })
  await s.run(id2)
  const r = await leanThread(s.h.host, '/p', { action: 'action-cancel', id: id2 })
  expect(r.ok, r.text).toBe(true)
  s.h.clock.t += 40_000
  await tick(s)
  expect(s.writers()).toHaveLength(0)
  expect((await leanThread(s.h.host, '/p', { action: 'action-cancel', id: 'a1-1' })).ok).toBe(false)
})

test('1.0.35: the thread is told WHO cancelled: the desk with its reason, or the user; the desk can extend one hold once', { timeoutMs: 20_000 }, async () => {
  const s = await setup()
  const a = await ask(s, REPLY)
  await s.run(a)
  // the desk cancels (lean_thread action-cancel, text = reason): the notice says so, with the reason
  const sent: string[] = []
  const r = await leanThread(s.h.host, '/p', { action: 'action-cancel', id: a, text: 'it contradicts the PR description' })
  expect(r.ok, r.text).toBe(true)
  expect(r.text).toContain('by the desk')
  const direct = await setup()
  const b = await ask(direct, REPLY)
  await direct.run(b)
  await cancelHeld(direct.h.host, b, direct.tell, { who: 'desk', reason: 'it contradicts the PR description' })
  sent.push(...direct.told)
  expect(sent.join('\n')).toContain('was cancelled by the desk before sending: it contradicts the PR description.')
  expect(sent.join('\n')).not.toContain('by the user')
  // no reason given
  const nr = await setup()
  const c = await ask(nr, REPLY)
  await nr.run(c)
  await cancelHeld(nr.h.host, c, nr.tell, { who: 'desk' })
  expect(nr.told.join('\n')).toContain('cancelled by the desk before sending: no reason given.')
  // the user (the default, the pane's Cancel) is named as the user
  const u = await setup()
  const d = await ask(u, REPLY)
  await u.run(d)
  await cancelHeld(u.h.host, d, u.tell)
  expect(u.told.join('\n')).toContain('cancelled by the user before it was sent')
  expect(u.told.join('\n')).not.toContain('by the desk')
  // extend once: the window grows by one hold length, a second extension is refused, then it goes out
  const x = await setup()
  const e = await ask(x, REPLY)
  await x.run(e)
  const w0 = (await holdsView(x.h.host))[0]!.until
  const first = await leanThread(x.h.host, '/p', { action: 'action-cancel', id: e, on: true })
  expect(first.ok, first.text).toBe(true)
  expect((await holdsView(x.h.host))[0]!.until).toBe(w0 + 30_000)
  const second = await leanThread(x.h.host, '/p', { action: 'action-cancel', id: e, on: true })
  expect(second.ok).toBe(false)
  expect(second.text).toContain('already extended once')
  x.h.clock.t += 40_000 // past the first window, inside the extension
  expect(await tick(x)).toEqual([])
  expect(x.writers()).toHaveLength(0)
  x.h.clock.t += 30_000
  await tick(x)
  expect(x.writers()).toHaveLength(1)
  expect((await leanThread(x.h.host, '/p', { action: 'action-cancel', id: e, on: true })).ok).toBe(false) // gone
})

test('1.0.35: actions.holdSeconds is clamped to 5..600 (0 stays "no window" for a hand-written file)', { timeoutMs: 20_000 }, async () => {
  const at = async (v: unknown) => holdSeconds((await setup({ actions: { holdSeconds: v } })).h.host)
  expect(await at(1)).toBe(5)
  expect(await at(5)).toBe(5)
  expect(await at(120)).toBe(120)
  expect(await at(9999)).toBe(600)
  expect(await at(0)).toBe(0)
  expect(await at('x')).toBe(30)
  expect(await at(-3)).toBe(30)
  expect(await holdSeconds((await setup()).h.host)).toBe(30)
})

test('Send now ends the window at once: the desk timer sends it without waiting', { timeoutMs: 20_000 }, async () => {
  const s = await setup()
  const id = await ask(s, REPLY)
  await s.run(id)
  expect(await sendHeldNow(s.h.host, id)).toBe(true)
  expect(s.writers()).toHaveLength(0)
  await tick(s)
  expect(s.writers()).toHaveLength(1)
  expect(await sendHeldNow(s.h.host, id)).toBe(false)
})

test('during the window: a newer prompt stops the send and asks; a thread that was parked meanwhile is not sent to', { timeoutMs: 20_000 }, async () => {
  const s = await setup()
  const id = await ask(s, REPLY)
  await s.run(id)
  s.h.clock.t += 10_000
  await s.say('actually say nothing about the typo')
  s.h.clock.t += 21_000
  const notes = await tick(s)
  expect(s.writers()).toHaveLength(0)
  expect(notes[0]!.text).toContain('a newer instruction from you may not have reached t5')
  expect(s.told.join('\n')).toContain('was held and then not sent')
  expect((await listActions(s.h.host)).find(a => a.id === id)?.state).toBe('pending')
  // parked while held
  const p = await setup()
  const id2 = await ask(p, REPLY)
  await p.run(id2)
  await leanThread(p.h.host, '/p', { action: 'park', tN: 't5' })
  p.h.clock.t += 31_000
  const n2 = await tick(p)
  expect(p.writers()).toHaveLength(0)
  expect(n2[0]!.text).toContain('was not sent (the thread is parked)')
})
