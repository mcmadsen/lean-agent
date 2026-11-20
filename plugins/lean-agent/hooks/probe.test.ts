// `lean_doctor overhead probe` (probe.ts): the variants, the table from canned `claude -p --output-format json` answers, the biggest component.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { overheadProbe, probeText, variants } from './probe'
import type { Measured } from './probe'

const out = (input: number, cost = 0.004) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, num_turns: 1, usage: { input_tokens: 3, cache_read_input_tokens: input - 3, cache_creation_input_tokens: 0, output_tokens: 4 }, result: 'ok' })

test('variants: one thing off each, user CLAUDE.md excluded by path, plugins by key, the lean case measures the user\'s plugins the other way', () => {
  const v = variants({ tools: ['--tools', 'Read'], others: ['a@m', 'b@m'], home: '/h', lean: false })
  expect(v.map(x => x.key)).toEqual(['today', 'mcp', 'skills', 'plugins', 'claudemd', 'floor'])
  expect(v[1]!.args).toContain('--strict-mcp-config')
  expect(v[2]!.args).toContain('--disable-slash-commands')
  expect(JSON.parse(v[3]!.args[3]!)).toEqual({ enabledPlugins: { 'a@m': false, 'b@m': false } })
  expect(JSON.parse(v[4]!.args[3]!).claudeMdExcludes).toEqual(['/h/.claude/CLAUDE.md', '/h/.claude/rules/**'])
  const lean = variants({ tools: [], others: ['a@m'], home: '/h', lean: true })
  expect(lean.map(x => x.key)).toContain('allplugins')
  expect(JSON.parse(lean.find(x => x.key === 'allplugins')!.args[1]!)).toEqual({ enabledPlugins: { 'a@m': true } })
})

test('the report names the biggest component and the config line, and says it costs money', () => {
  const rows: Measured[] = [
    { key: 'today', label: 'as a thread starts today', args: [], tokens: 62000, cost: 0.01 },
    { key: 'mcp', label: 'without MCP', args: [], tokens: 40000, cost: 0.01 },
    { key: 'skills', label: 'without skills', args: [], tokens: 58000, cost: 0.01 },
    { key: 'plugins', label: 'without other plugins', args: [], tokens: 61000, cost: 0.01 },
    { key: 'claudemd', label: 'without user CLAUDE.md', args: [], tokens: 61800, cost: 0.01 },
    { key: 'floor', label: 'floor', args: [], tokens: 31000, cost: 0.01 },
  ]
  const t = probeText(rows, { lean: false })
  expect(t).toContain('about $0.06')
  expect(t).toContain('a few cents')
  expect(t).toContain('biggest component: MCP servers and connectors, about 22.0k of 62.0k')
  expect(t).toContain('threads.mcp: "none"')
  expect(t).toContain('then: the skills listing 4.0k, other plugins')
  expect(probeText(rows.map(r => ({ ...r, tokens: r.key === 'today' ? 31000 : 30900 })), { lean: false })).toContain('biggest component: none over 500 tokens')
  expect(probeText(rows.map(r => ({ ...r, tokens: null })), { lean: false })).toContain('no usage')
})

test('the probe runs one claude call per variant, prompt first and flags after, in the throw-away thread folder, and cleans it up', async () => {
  const h = fakeHost(null)
  h.clock.t = Date.UTC(2026, 10, 18, 12)
  h.files.set('/p/templates/thread.md', '# {{id}}')
  h.files.set('/h/.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'lean-agent@mk': [{ installPath: '/c/la' }], 'other@mk': [{ installPath: '/c/o' }] } }))
  const seen: string[][] = []
  h.claude.handler = (a: string[]) => {
    seen.push(a)
    const s = a.join(' ')
    return { exitCode: 0, stdout: out(s.includes('--strict-mcp-config') && s.includes('--disable-slash-commands') ? 31000 : s.includes('--strict-mcp-config') ? 40000 : 62000) }
  }
  const r = await overheadProbe(h.host, '/p', 'probe')
  expect(seen.length).toBeGreaterThanOrEqual(6)
  for (const a of seen) {
    expect(a.slice(0, 3)).toEqual(['-p', 'Reply with the single word ok.', '--model'])
    expect(a).toContain('haiku')
    expect(a).toContain('json')
  }
  expect(r).toContain('as a thread starts today')
  expect(r).toContain('62.0k')
  expect(r).toContain('biggest component: MCP servers and connectors, about 22.0k')
  expect(r).toContain('cents')
  expect([...h.files.keys()].some(k => /\/threads\/t9\d+\//.test(k))).toBe(false) // the throw-away folder is gone
  expect(await overheadProbe(h.host, '/p', 'probe t7')).toContain('no thread t7')
  expect(await overheadProbe(h.host, '/p', 'probe x')).toContain('usage')
})
