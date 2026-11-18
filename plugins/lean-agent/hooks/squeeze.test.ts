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

test('squeezeResult saves the full output and points at it; errors flag and deny pass through', async () => {
  const h = fakeHost(null)
  const full = long(300)
  const r = await squeezeResult(h.host, { result: full, isError: true })
  expect(r.isError).toBe(true)
  expect(r.result).toContain('/h/.lean-agent/output/')
  const saved = [...h.files.entries()].find(([k]) => k.startsWith('/h/.lean-agent/output/'))!
  expect(saved[1]).toBe(full)
  expect(await squeezeResult(h.host, { deny: 'no' })).toEqual({ deny: 'no' })
  expect(await squeezeResult(h.host, { result: 'short' })).toEqual({ result: 'short' })
})

test('trimTools drops by glob per role and never lean-agent tools', () => {
  const tools = [{ name: 'Read' }, { name: 'Glob' }, { name: 'mcp__big__a' }, { name: 'mcp__lean-agent__lean_report' }]
  const cfg = { thread: { drop: ['Glob', 'mcp__*'] } }
  expect(trimTools(tools, 'thread', cfg).map(t => t.name)).toEqual(['Read', 'mcp__lean-agent__lean_report'])
  expect(trimTools(tools, 'desk', cfg)).toHaveLength(4)
  expect(trimTools(tools, 'thread', undefined)).toHaveLength(4)
})
