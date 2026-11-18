import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { squeezeResult, squeezeText, trimTools } from './squeeze'

const long = (n: number, at?: [number, string]) => Array.from({ length: n }, (_, i) => (at && i === at[0] ? at[1] : `line ${i}`)).join('\n')

test('short output is untouched', () => {
  expect(squeezeText('a\nb').squeezed).toBe(false)
})

test('long output keeps head, tail and the error line', () => {
  const s = squeezeText(long(500, [250, 'Error: boom']))
  expect(s.squeezed).toBe(true)
  expect(s.text).toContain('Error: boom')
  expect(s.text).toContain('line 0')
  expect(s.text).toContain('line 499')
  expect(s.text).not.toContain('line 100\n')
  expect(s.text).toContain('lines squeezed')
})

// Bash's result is the record { stdout, stderr, interrupted, ... }; the engine validates a hook's answer against that schema
test('squeezeResult squeezes stdout of the Bash record, keeps its shape and every other field, and saves the full text', async () => {
  const h = fakeHost(null)
  const full = long(300)
  const rec = { stdout: full, stderr: '', interrupted: false, backgroundTaskId: undefined, rawOutputPath: '/x' }
  const r = await squeezeResult(h.host, { result: rec, context: ['c'] })
  expect(typeof r.result).toBe('object') // never a string: that is what the engine refused
  expect(r.result.interrupted).toBe(false)
  expect(r.result.rawOutputPath).toBe('/x')
  expect(r.result.stderr).toBe('')
  expect(r.context).toEqual(['c'])
  expect(r.result.stdout).toContain('lines squeezed')
  expect(r.result.stdout).toContain('/h/.lean-agent/output/')
  const saved = [...h.files.entries()].find(([k]) => k.startsWith('/h/.lean-agent/output/'))!
  expect(saved[1]).toBe(full)
})

test('a >100 KB stdout and a long stderr are both squeezed; a short stderr stays', async () => {
  const h = fakeHost(null)
  const big = Array.from({ length: 4000 }, (_, i) => `row ${i} ${'x'.repeat(40)}`).join('\n')
  expect(big.length).toBeGreaterThan(100_000)
  const r = await squeezeResult(h.host, { result: { stdout: big, stderr: long(200), interrupted: false } })
  expect(r.result.stdout.length).toBeLessThan(5000)
  expect(r.result.stdout).toContain('row 0')
  expect(r.result.stdout).toContain('row 3999')
  expect(r.result.stderr).toContain('lines squeezed')
  const only = await squeezeResult(h.host, { result: { stdout: 'ok', stderr: 'warn: x', interrupted: false } })
  expect(only.result).toEqual({ stdout: 'ok', stderr: 'warn: x', interrupted: false })
  const saved = [...h.files.entries()].filter(([k]) => k.startsWith('/h/.lean-agent/output/'))
  expect(saved.length).toBe(1)
  expect(saved[0]![1]).toContain('--- stderr ---')
})

test('every other result shape passes unchanged: a failed call\'s error text (a string), content blocks, no result, deny', async () => {
  const h = fakeHost(null)
  const text = long(500, [10, 'Error: boom'])
  for (const r of [{ result: text, isError: true }, { result: [{ type: 'text', text }] }, { result: Array.from({ length: 3 }, () => ({ type: 'text', text })) }, { result: { content: text } }, { result: null }, { context: ['x'] }, { deny: 'no' }, { result: 'short' }]) expect(await squeezeResult(h.host, r)).toBe(r)
  expect(await squeezeResult(h.host, undefined)).toBeUndefined()
  expect([...h.files.keys()].some(k => k.includes('/output/'))).toBe(false)
})

test('a result that cannot be saved is never squeezed', async () => {
  const h = fakeHost(null)
  h.host.process.run = async () => ({ exitCode: 1, stdout: '', stderr: 'no space' }) // mkdir and mv fail
  const r = { result: { stdout: long(300), stderr: '', interrupted: false } }
  expect(await squeezeResult(h.host, r)).toBe(r)
})

test('trimTools drops by glob per role and never lean-agent tools', () => {
  const tools = [{ name: 'Read' }, { name: 'Glob' }, { name: 'mcp__big__a' }, { name: 'mcp__lean-agent__lean_report' }]
  const cfg = { thread: { drop: ['Glob', 'mcp__*'] } }
  expect(trimTools(tools, 'thread', cfg).map(t => t.name)).toEqual(['Read', 'mcp__lean-agent__lean_report'])
  expect(trimTools(tools, 'desk', cfg).map(t => t.name)).toEqual(['Read', 'Glob', 'mcp__lean-agent__lean_report'])
  expect(trimTools(tools, 'thread', undefined)).toHaveLength(4)
})
