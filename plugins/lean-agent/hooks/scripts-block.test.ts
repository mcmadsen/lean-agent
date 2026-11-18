// A rule may hold an adopted-scripts block (written by a later release); record, footer and sync must leave it byte for byte.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { SCRIPTS_BLOCK, parseRelies, recordRule, ruleMetrics, syncRules, withRelies } from './rules'

const SRC = '/h/.lean-agent/proj'
const BLOCK = '<!-- lean-agent:scripts -->\n- count open items: `scripts/count.sh`\n- list changed packages: `scripts/changed.sh --json`\n<!-- /lean-agent:scripts -->'
const rule = (footer = '<!-- lean-agent: learned abc 2026-01-01 sources: a/** -->') => `---\npaths:\n  - "a/**"\n---\n# a\n- Test: \`make test\`\n${BLOCK}\n${footer}\n`

test('the scripts block is not the footer: relies-on is read from and written to the footer only', () => {
  expect(parseRelies(rule())).toEqual([])
  const t = withRelies(rule(), ['a/x.ts', 'Sym'], 'abc', '2026-01-01')
  expect(t).toContain(BLOCK) // byte for byte
  expect(t.match(SCRIPTS_BLOCK)![0]).toBe(BLOCK)
  expect(parseRelies(t)).toEqual(['a/x.ts', 'Sym'])
  expect(t).toContain('sources: a/** relies-on: a/x.ts, Sym -->')
  // a rule with the block but no footer gets a footer, and the block stays
  const bare = withRelies(`---\npaths:\n  - "a/**"\n---\n# a\n${BLOCK}\n`, ['a/y.ts'], 'deadbeef00', '2026-02-02')
  expect(bare).toContain(BLOCK)
  expect(bare).toContain('<!-- lean-agent: learned deadbeef')
  expect(parseRelies(bare)).toEqual(['a/y.ts'])
})

test('record keeps the block; sync copies it unchanged; its lines count toward the caps', async () => {
  const h = fakeHost(null)
  h.git.handler = a => (a[0] === 'rev-parse' ? { exitCode: 0, stdout: '/repo/.git\n' } : { exitCode: 1, stdout: '' })
  h.files.set(`${SRC}/rules/a.md`, rule())
  const msg = await recordRule(h.host, 'proj', 'a', { globs: ['a/**'], sha: 'abcdef12', relies: ['a/x.ts'] })
  expect(msg).toContain('relies-on 1')
  const after = h.files.get(`${SRC}/rules/a.md`)!
  expect(after.match(SCRIPTS_BLOCK)![0]).toBe(BLOCK)
  expect(after.match(/<!--/g)!.length).toBe(3) // block open, block close, and still exactly one footer
  await syncRules(h.host, 'proj', '/repo')
  expect(h.files.get('/repo/.claude/rules/lean-agent/a.md')!.match(SCRIPTS_BLOCK)![0]).toBe(BLOCK)
  expect(ruleMetrics(rule()).lines).toBe(4) // heading, bullet and the two script bullets
})
