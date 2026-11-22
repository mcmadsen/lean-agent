// Small messages: an oversized Bash / MCP result is cut before it enters a thread's conversation (cap.ts).
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { resetLocks } from './threads'
import { DEFAULT_CAP, capChars, capResult, capStats, cutText } from './cap'
import { statsText } from './stats'
import { MAX_FILES, pruneOutput } from './output'

const L = '/h/.lean-agent'
const OUT = `${L}/output` // the one output folder (the Bash line squeeze saves there too)
// n characters in lines of 1000 (few lines: the older line-based squeeze of Bash output, which runs first, leaves them alone)
const big = (n: number, line = 'line of output number') => Array.from({ length: Math.ceil(n / 1000) }, (_, i) => `${line} ${i} `.padEnd(999, '.')).join('\n').slice(0, n)
const outFiles = (h: any) => [...h.files.keys()].filter((k: string) => k.startsWith(OUT + '/'))

test('a Bash result over the cap keeps head and tail, the full text is a file in the thread folder, one pointer line says where', async () => {
  const h = fakeHost(null)
  h.clock.t = 1_000_000
  const stdout = big(50_000)
  const r: any = { result: { stdout, stderr: '', interrupted: false, isImage: false }, ref: 3 }
  const out = await capResult(h.host, 't1', 'Bash', r)
  expect(out).not.toBe(r)
  expect(out.ref).toBe(3)
  expect(out.result.interrupted).toBe(false) // the shape and the other fields are kept
  expect(out.result.stderr).toBe('')
  expect(out.result.stdout.length).toBeLessThan(DEFAULT_CAP)
  expect(out.result.stdout.startsWith(stdout.slice(0, 200))).toBe(true)
  expect(out.result.stdout).toContain(stdout.slice(-100).split('\n').pop()!)
  const files = outFiles(h)
  expect(files.length).toBe(1)
  expect(h.files.get(files[0]!)).toBe(stdout)
  const pointers = out.result.stdout.split('\n').filter((l: string) => l.startsWith('[lean-agent:'))
  expect(pointers.length).toBe(1)
  expect(pointers[0]).toContain(files[0])
  expect(pointers[0]).toContain('Read it if you need more')
  expect(pointers[0]).toContain(`from ${stdout.length} to`)
})

test('stderr over the cap is cut the same way; the file holds both', async () => {
  const h = fakeHost(null)
  const err = big(30_000, 'error line')
  const out = await capResult(h.host, 't1', 'Bash', { result: { stdout: 'ok\n', stderr: err } })
  expect(out.result.stdout).toBe('ok\n')
  expect(out.result.stderr.length).toBeLessThan(DEFAULT_CAP)
  const f = h.files.get(outFiles(h)[0]!)!
  expect(f).toContain('--- stderr ---')
  expect(f.endsWith(err)).toBe(true)
})

test('MCP text blocks, a plain string and an array of blocks are cut the same way; other blocks stay', async () => {
  const h = fakeHost(null)
  const text = big(40_000)
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
  const a: any = await capResult(h.host, 't1', 'mcp__sentry__issues', { result: { content: [{ type: 'text', text }, image], isError: false } })
  expect(a.result.content[1]).toBe(image)
  expect(a.result.content[0].type).toBe('text')
  expect(a.result.content[0].text.length).toBeLessThan(DEFAULT_CAP)
  expect(a.result.content[0].text).toContain('Read it if you need more')
  expect(a.result.isError).toBe(false)
  const b: any = await capResult(h.host, 't1', 'mcp__sentry__issues', { result: text })
  expect(typeof b.result).toBe('string')
  expect(b.result.length).toBeLessThan(DEFAULT_CAP)
  const c: any = await capResult(h.host, 't1', 'mcp__sentry__issues', { result: [{ type: 'text', text }, image] })
  expect(Array.isArray(c.result)).toBe(true)
  expect(c.result[1]).toBe(image)
  expect(c.result[0].text.length).toBeLessThan(DEFAULT_CAP)
  expect(outFiles(h).length).toBe(3)
})

test('under the cap, or not a result to touch: returned unchanged (the same object), nothing saved', async () => {
  const h = fakeHost(null)
  const huge = big(50_000)
  const same = async (tool: string, r: any, thread = 't1') => {
    expect(await capResult(h.host, thread, tool, r)).toBe(r)
  }
  await same('Bash', { result: { stdout: big(19_000), stderr: '' } })
  await same('Edit', { result: { stdout: huge } })
  await same('Write', { result: huge })
  await same('Read', { result: huge })
  await same('mcp__lean-agent__lean_report', { result: huge })
  await same('Bash', { result: { stdout: huge }, isError: true })
  await same('Bash', { result: huge }) // a failed call's result is its error text
  await same('Bash', { deny: 'no' })
  await same('mcp__x__y', { result: { content: [{ type: 'text', text: huge }], isError: true } })
  await same('Bash', { result: { stdout: huge } }, 'desk')
  await same('Bash', { result: { stdout: huge } }, 'plain')
  expect(outFiles(h).length).toBe(0)
  expect(h.files.has(`${L}/capped.jsonl`)).toBe(false)
})

test('config toolResultChars: a custom cap, 0 = off, below 2000 or junk = the default', async () => {
  const h = fakeHost(null)
  expect(await capChars(h.host)).toBe(DEFAULT_CAP)
  h.files.set(`${L}/config.json`, JSON.stringify({ toolResultChars: 5000 }))
  expect(await capChars(h.host)).toBe(5000)
  const r = { result: { stdout: big(8000), stderr: '' } }
  const out: any = await capResult(h.host, 't1', 'Bash', r)
  expect(out.result.stdout.length).toBeLessThan(5500)
  h.files.set(`${L}/config.json`, JSON.stringify({ toolResultChars: 0 }))
  expect(await capResult(h.host, 't1', 'Bash', { result: { stdout: big(90_000) } })).toBeTruthy()
  const off = { result: { stdout: big(90_000) } }
  expect(await capResult(h.host, 't1', 'Bash', off)).toBe(off)
  for (const v of [100, 'big', -1, null]) {
    h.files.set(`${L}/config.json`, JSON.stringify({ toolResultChars: v }))
    expect(await capChars(h.host)).toBe(DEFAULT_CAP)
  }
})

test('a result that cannot be saved in full is never cut', async () => {
  const h = fakeHost(null)
  const w = h.host.fs.write
  h.host.fs.write = async () => {
    throw new Error('disk full')
  }
  const r = { result: { stdout: big(50_000), stderr: '' } }
  expect(await capResult(h.host, 't1', 'Bash', r)).toBe(r)
  h.host.fs.write = w
})

test('the cap and the Bash line squeeze save into the same folder; old files are pruned by their name\'s time, then all but the newest MAX_FILES', async () => {
  const h = fakeHost(null)
  const DAY = 86_400_000
  h.clock.t = 100 * DAY
  const put = (ts: number, tag = 'x') => h.files.set(`${OUT}/${ts}-${tag}.txt`, 'old')
  put(100 * DAY - 8 * DAY) // older than 7 days
  put(100 * DAY - 9 * DAY, 't3-1')
  put(100 * DAY - 6 * DAY) // kept
  h.files.set(`${OUT}/notes.txt`, 'not ours: no time in the name, never pruned')
  await capResult(h.host, 't1', 'Bash', { result: { stdout: big(30_000), stderr: '' } }) // saves, and prunes once
  const names = outFiles(h).map((k: string) => k.slice(OUT.length + 1))
  expect(names.some((n: string) => n.startsWith(`${100 * DAY - 8 * DAY}-`))).toBe(false)
  expect(names.some((n: string) => n.startsWith(`${100 * DAY - 9 * DAY}-`))).toBe(false)
  expect(names.some((n: string) => n.startsWith(`${100 * DAY - 6 * DAY}-`))).toBe(true)
  expect(names).toContain('notes.txt')
  expect(names.filter((n: string) => n.startsWith(`${100 * DAY}-t1-`)).length).toBe(1) // this thread's cut
  // past MAX_FILES the oldest go, whatever their age (deterministic: by the time in the name)
  const extra = MAX_FILES + 50
  for (let i = 0; i < extra; i++) put(100 * DAY - 3 * DAY + i, 'a')
  expect((await pruneOutput(h.host, 100 * DAY)).length).toBe(extra + 2 - MAX_FILES) // + 1 (6 days old) + 1 (this cut)
  const left = outFiles(h).filter((k: string) => /\/\d{10,}-/.test(k))
  expect(left.length).toBe(MAX_FILES)
  expect(left.some((k: string) => k.includes(`${100 * DAY - 3 * DAY}-a`))).toBe(false) // the oldest of them went
  expect(left.some((k: string) => k.includes(`${100 * DAY - 3 * DAY + extra - 1}-a`))).toBe(true)
})

test('cutText keeps the head and the tail on line ends', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join('\n')
  const out = cutText(text, 4000, '/f.txt')
  expect(out.startsWith('row 0\nrow 1\n')).toBe(true)
  expect(out).toContain('row 1999')
  expect(out).toContain('/f.txt')
  expect(out.length).toBeLessThan(4400)
})

test('stats count what was saved: "saved 140.0k chars in 12 results"; nothing when nothing was cut', async () => {
  const h = fakeHost(null)
  h.clock.t = 50 * 86_400_000
  expect(await statsText(h.host)).not.toContain('output cap')
  const rows = Array.from({ length: 12 }, (_, i) => JSON.stringify({ ts: h.clock.t - i * 1000, tN: 't1', tool: 'Bash', saved: i < 8 ? 10_000 : 15_000 })).join('\n') + '\n'
  h.files.set(`${L}/capped.jsonl`, rows + JSON.stringify({ ts: h.clock.t - 20 * 86_400_000, tN: 't1', tool: 'Bash', saved: 999_999 }) + '\n') // older than the window
  expect(await capStats(h.host, h.clock.t, 7)).toEqual({ results: 12, chars: 140_000 })
  expect(await statsText(h.host)).toContain('saved 140.0k chars in 12 results')
})

// ---- through the engine's hooks -----------------------------------------------------------------------------------
async function session($: any, on: any, cwd: string, result: () => any) {
  const h = fakeHost(on)
  resetLocks()
  h.clock.t = 1_000_000
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', title: 'x', project: 'proj', state: 'open', sid: '', created: 1, lastWake: 0, delivered: 0 }))
  h.claude.handler = () => ({ exitCode: 0, stdout: '[]' })
  on('clock.after', () => new Promise(() => {})) // a step's timeout never fires here
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__lean-agent__${e.name}` } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [{ id: 'agent-1', type: 'lean-agent:worker-sonnet', status: 'running' }] }))
  on('ui.status', () => ({ value: null }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('tool.call', () => result() as any)
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true } as any)
  return h
}

test('in a thread session the main loop\'s oversized Bash result is cut; a subagent\'s is not', { timeoutMs: 20_000 }, async ($, on) => {
  const stdout = big(60_000)
  const h = await session($, on, `${L}/threads/t1`, () => ({ result: { stdout, stderr: '', interrupted: false } }))
  const a: any = await $.tool.call({ tool: 'Bash', command: 'cat big.log' } as any)
  expect(a.result.stdout.length).toBeLessThan(DEFAULT_CAP)
  expect(a.result.stdout).toContain('Read it if you need more')
  expect(outFiles(h).length).toBe(1)
  const b: any = await $.tool.call({ tool: 'Bash', command: 'cat big.log', agentId: 'agent-1' } as any)
  expect(b.result.stdout).toBe(stdout)
  expect(outFiles(h).length).toBe(1)
})

test('in a plain session nothing is cut', { timeoutMs: 20_000 }, async ($, on) => {
  const stdout = big(60_000)
  const h = await session($, on, '/somewhere/else', () => ({ result: { stdout, stderr: '', interrupted: false } }))
  const a: any = await $.tool.call({ tool: 'Bash', command: 'cat big.log' } as any)
  expect(a.result.stdout.length).toBeGreaterThanOrEqual(60_000 - 1)
  expect(outFiles(h).length).toBe(0)
})
