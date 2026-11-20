// The rules PR plan (rulespr.ts): a synthetic repo, learned rules, a load log, lessons and missing-context reports; the plan is computed
// without a model and is the same every time.
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { buildPlan, clusterGaps, contentOf, estTokens, renderPlan, sectionsOf, unsafeWhy } from './rulespr'
import { threadTool } from './delivery'

const L = '/h/.lean-agent'
const NOW = Date.UTC(2026, 5, 20, 12, 0, 0)
const ago = (days: number) => Math.floor((NOW - days * 86_400_000) / 1000)

const CLAUDE = `# Acme shop

This repo is the Acme shop monorepo.

## Commands

- Run \`pnpm test\` before every commit so the suite stays green.
- Format all code with \`pnpm fmt\` before opening a pull request.
- Always round amounts to whole cents before comparing two prices.

## Billing service

The billing service lives in \`services/billing/\` and owns every ledger write.
Ledger rows are created only through \`LedgerRow.create\` in \`services/billing/ledger.ts\`, never by raw inserts.
Money is rounded in \`services/billing/money.ts\`; never sum floating point totals anywhere in this folder.

## Old tooling

- Use \`legacy/deploy.sh\` for deploys and call \`OldDeployer\` before the first release step.
- See \`scripts/release.sh\` and \`ReleaseHelper\` for the release steps of a version.
- Never commit generated files to the repository.
`
const LOCAL = '# Mine\n- My own sandbox account is used for every manual check of the checkout flow.\n'
const WEB = `---
paths:
  - "apps/web/**"
---
# Web
- Components live in \`apps/web/\` and are tested with \`pnpm --filter web test\` before review.
- Format all code with \`pnpm fmt\` before opening a pull request.
`
const GENERAL = '# General\n- Run `pnpm test` before every commit so the suite stays green.\n- Keep pull requests small and focused on one change at a time.\n'
const DRAFT = '# Draft\n- Untracked notes for a rule the team has not committed yet.\n'
const TRACKED = ['CLAUDE.md', '.claude/rules/web.md', '.claude/rules/general.md', 'services/billing/ledger.ts', 'services/billing/money.ts', 'apps/web/a.ts', 'scripts/release.sh', 'docs/guide.md', 'package.json']
const SYMBOLS = new Set(['LedgerRow.create'])

const BILLING = `---
paths:
  - "services/billing/**"
---
# billing
- Ledger rows are created only through LedgerRow.create, never by raw inserts into the table.
- Retried payment webhooks must carry the idempotency key or the ledger gets a double entry.
- The way to rebuild a ledger snapshot is \`legacy/gone.sh\` together with \`GoneThing\` in the old tree.
- Ask the lean_script tool for a script that counts the rows by hand before you start.
<!-- lean-agent: learned abc 2026-01-01 -->
`
const PAYMENTS = '---\npaths:\n  - "services/payments/**"\n---\n# payments\n- Refunds above the daily limit need a second approval step from the finance lead.\n'
const INFRA = '# infra\n- Run `pnpm test` before every commit so the suite stays green.\n- Format all code with `pnpm fmt` before opening a pull request.\n'

const lesson = (id: number, family: string, text: string) => JSON.stringify({ id, family, topic: 'other', text, paths: [], keywords: [], source: 'x', added: '2026-01-01' })

function setup(opts: { log?: boolean; git?: boolean } = {}) {
  const h = fakeHost(null)
  h.clock.t = NOW
  const f = (p: string, t: string) => h.files.set(p, t)
  f(`${L}/projects.json`, JSON.stringify({ proj: { path: '/repo' } }))
  f('/repo/CLAUDE.md', CLAUDE)
  f('/repo/CLAUDE.local.md', LOCAL)
  f('/repo/.claude/rules/web.md', WEB)
  f('/repo/.claude/rules/general.md', GENERAL)
  f('/repo/.claude/rules/draft.md', DRAFT)
  f('/repo/.claude/rules/lean-agent/billing.md', 'a synced copy: never the team\'s')
  f(`${L}/proj/rules/billing.md`, BILLING)
  f(`${L}/proj/rules/payments.md`, PAYMENTS)
  f(`${L}/proj/rules/infra.md`, INFRA)
  f(`${L}/proj/review-lessons.jsonl`, [lesson(1, 'review-checklist', 'Always round amounts to whole cents before comparing two prices.'), lesson(2, 'shared-helpers', 'parseMoney (libs/money/parse.ts): turns a string into cents'), lesson(3, 'review-checklist', 'Check that every new endpoint validates its input schema.')].join('\n') + '\n')
  f(`${L}/logs/review-lessons.jsonl`, [3, 3, 1].map(id => JSON.stringify({ ts: ago(2), project: 'proj', offered: [{ id }] })).join('\n') + '\n')
  if (opts.log !== false) {
    const rows = [
      ...[12, 9, 3, 1].map((d, i) => ({ ts: ago(d), src: 'loader', rule: 'billing.md', project: 'proj', session: `s${i + 1}`, trigger: 'Read', sha: 'a' })),
      { ts: ago(0), e: { file_path: '/repo/.claude/rules/lean-agent/billing.md', load_reason: 'path_glob_match', trigger_file_path: '/repo/services/billing/ledger.ts', session_id: 's5' } },
      { ts: ago(2), src: 'loader', rule: 'payments.md', project: 'proj', session: 's1', trigger: 'Read', sha: 'b' },
      { ts: ago(5), src: 'loader', rule: 'infra.md', project: 'proj', session: 's7', trigger: 'Read', sha: 'c' },
      { ts: ago(5), src: 'loader', rule: 'infra.md', project: 'proj', session: 's8', trigger: 'Read', sha: 'c' },
      { ts: ago(5), src: 'loader', rule: 'billing.md', project: 'other', session: 'x1', trigger: 'Read', sha: 'a' },
    ]
    f(`${L}/logs/rules-loaded.jsonl`, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  }
  const gap = (text: string, path = '') => JSON.stringify({ ts: ago(3) * 1000, path, area: null, text })
  f(`${L}/proj/gaps.jsonl`, [
    gap('needed to know the ledger retry idempotency key format before changing the webhook handler', 'services/billing/ledger.ts'),
    gap('did not know the idempotency key format for a ledger retry in the webhook handler', 'services/billing/hooks.ts'),
    gap('which CI job publishes the docs site'),
    gap('should run pnpm test before every commit so the suite stays green'),
    gap('did not know to run pnpm test before every commit, the suite has to stay green'),
    gap('count how many files use OldClient'),
    gap('count how many files still use OldClient in the repo'),
  ].join('\n') + '\n')
  h.git.handler = (a0: string[]) => {
    const a = a0[0] === '-C' ? a0.slice(2) : a0
    if (opts.git === false) return { exitCode: 128, stdout: '' }
    if (a[0] === 'ls-files') {
      if (a.includes('--ignored')) return { exitCode: 0, stdout: 'CLAUDE.local.md\n' }
      if (a.includes('--others')) return { exitCode: 0, stdout: [...TRACKED, '.claude/rules/draft.md', '.claude/rules/lean-agent/billing.md'].join('\n') + '\n' }
      return { exitCode: 0, stdout: TRACKED.join('\n') + '\n' }
    }
    if (a[0] === 'ls-tree') return { exitCode: 0, stdout: TRACKED.join('\n') + '\n' }
    if (a[0] === 'rev-parse') return { exitCode: 0, stdout: 'abc\n' }
    if (a[0] === 'worktree') return { exitCode: 0, stdout: 'worktree /repo\nHEAD a\nbranch refs/heads/main\n\n' }
    if (a[0] === 'grep') return { exitCode: SYMBOLS.has(a[a.indexOf('-e') + 1]!) ? 0 : 1, stdout: '' }
    if (a[0] === 'show') { const m = /^[^:]+:(.*)$/.exec(a[1] ?? ''); const t = m ? h.files.get(`/repo/${m[1]}`) : undefined; return t === undefined ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: t } }
    return { exitCode: 1, stdout: '' }
  }
  h.files.set(`${L}/threads/t1/thread.json`, JSON.stringify({ id: 't1', project: 'proj' }))
  return h
}
const plan = async (h: ReturnType<typeof setup>, o: any = {}) => {
  const r = await buildPlan(h.host, 'proj', o)
  if (!r.ok) throw new Error(r.text)
  return r.plan
}

test('the repo files: every CLAUDE.md, the local one and the rules with their tokens; tracked or not; what loads every session', async () => {
  const p = await plan(setup())
  const by = Object.fromEntries(p.files.map(f => [f.path, f]))
  expect(Object.keys(by).sort()).toEqual(['.claude/rules/draft.md', '.claude/rules/general.md', '.claude/rules/web.md', 'CLAUDE.local.md', 'CLAUDE.md']) // (the synced lean-agent copy is not the team's)
  expect(by['CLAUDE.md']).toMatchObject({ kind: 'claude', tracked: true, load: 'always', proposable: true, tokens: estTokens(CLAUDE) })
  expect(by['CLAUDE.local.md']).toMatchObject({ kind: 'local', tracked: false, load: 'always', proposable: false })
  expect(by['.claude/rules/web.md']).toMatchObject({ kind: 'rule', load: 'scoped', paths: ['apps/web/**'] })
  expect(by['.claude/rules/general.md']!.load).toBe('always') // a rule without `paths:` loads in every session
  expect(by['.claude/rules/draft.md']!.tracked).toBe(false)
  expect(JSON.stringify(p)).not.toContain('sandbox') // the local file is never read into the plan
})

test('(b) an always-loaded section about one folder moves to a path rule; the others stay', async () => {
  const p = await plan(setup())
  expect(p.moves).toHaveLength(1)
  const s = sectionsOf(CLAUDE).find(x => x.title === 'Billing service')!
  expect(p.moves[0]).toMatchObject({ file: 'CLAUDE.md', heading: 'Billing service', from: s.from, to: s.to, tokens: s.tokens, target: '.claude/rules/services-billing.md', paths: ['services/billing/**'], why: 'body', merge: false })
  expect(p.moves.map(m => m.heading)).not.toContain('Commands')
})

test('(a) lean rules and lessons that are already in the repo files; a rule that is mostly there is retired, not proposed', async () => {
  const p = await plan(setup())
  const dups = p.duplicates.leanVsRepo.map(d => `${d.source} = ${d.file}`)
  expect(dups).toContain('rule billing.md = CLAUDE.md')
  expect(dups).toContain('rule infra.md = CLAUDE.md')
  expect(dups).toContain('lesson #1 = CLAUDE.md')
  expect(p.retire).toEqual({ rules: ['infra.md'], lessons: [1] })
  expect(p.upstream.map(u => u.rule)).not.toContain('infra.md')
  expect(p.tokens.leanTwice).toBe(p.lean.rules.find(r => r.name === 'infra.md')!.tokens)
})

test('(c) a lean rule loaded in enough sessions over enough days becomes an upstream candidate with its evidence, minus duplicate, stale and team-unsafe lines', async () => {
  const p = await plan(setup())
  expect(p.upstream.map(u => u.rule)).toEqual(['billing.md']) // payments.md: one session; infra.md: two sessions on one day and duplicated
  const u = p.upstream[0]!
  expect(u).toMatchObject({ target: '.claude/rules/billing.md', paths: ['services/billing/**'], loads: 5, sessions: 5, spanDays: 12, first: '2026-06-08', last: '2026-06-20', merge: false, dropped: { duplicate: 1, stale: 1, unsafe: 1 } })
  expect(u.triggers).toEqual(['services/billing/ledger.ts']) // the path an engine load named, the checkout stripped
  expect(u.text).toContain('idempotency key')
  expect(u.text).not.toContain('LedgerRow.create') // already in CLAUDE.md
  expect(u.text).not.toContain('GoneThing') // its names are gone from the repo
  expect(u.text).not.toContain('lean_script') // never in a team file
  expect(u.unsafe[0]).toContain('names lean-agent')
  expect(u.text).not.toContain('lean-agent: learned') // the footer is not carried
  // the other project's load of a rule of the same name is not counted; thresholds can be tightened
  expect((await plan(setup(), { minSessions: 6 })).upstream).toEqual([])
  expect((await plan(setup(), { minDays: 13 })).upstream).toEqual([])
})

test('(d) stale lines: names the repo no longer has; remove when every name is gone, review when only some are', async () => {
  const p = await plan(setup())
  const old = p.stale.find(s => s.text.includes('legacy/deploy.sh'))!
  expect(old).toMatchObject({ file: 'CLAUDE.md', missing: ['legacy/deploy.sh', 'OldDeployer'], checked: 2, action: 'remove' })
  const some = p.stale.find(s => s.text.includes('ReleaseHelper'))!
  expect(some).toMatchObject({ missing: ['ReleaseHelper'], checked: 2, action: 'review' }) // scripts/release.sh exists
  expect(p.stale.some(s => s.text.includes('LedgerRow.create'))).toBe(false) // found by grep
  expect(p.lean.lessons.stale).toEqual([2]) // the helper line whose path and symbol are gone (the lesson verify logic)
})

test('lines said twice in the repo files: the copy in the narrower file goes, an instruction is never left without its only copy', async () => {
  const p = await plan(setup())
  const d = p.duplicates.repoVsRepo.map(x => `${x.file}:${x.line} = ${x.sameAs}`).sort()
  expect(d).toEqual(['.claude/rules/general.md:2 = CLAUDE.md:7', '.claude/rules/web.md:7 = CLAUDE.md:8'])
})

test('(e) missing context that recurs and has no rule; covered and mechanical clusters are told apart', async () => {
  const p = await plan(setup())
  expect(p.missing.reports).toBe(7)
  expect(p.missing.recurring).toBe(3)
  expect(p.missing.clusters).toHaveLength(2) // the pnpm test one is already in CLAUDE.md
  const idem = p.missing.clusters.find(c => c.keywords.includes('idempotency'))!
  expect(idem).toMatchObject({ count: 2, paths: ['services/billing/hooks.ts', 'services/billing/ledger.ts'], mechanical: false })
  expect(p.missing.clusters.find(c => c.mechanical)!.samples[0]).toContain('count how many files')
  expect(p.missing.clusters.some(c => c.samples[0]!.includes('pnpm test'))).toBe(false)
  // clustering is by words, deterministic, and one report naming several paths is one report
  const same = clusterGaps([{ ts: 1, path: 'a/x.ts', text: 'the retry key format' }, { ts: 2, path: 'a/y.ts', text: 'the retry key format' }], 2)
  expect(same.reports).toBe(1)
  expect(same.clusters).toEqual([])
})

test('(f) tokens per session before and after: the numbers follow from the plan', async () => {
  const p = await plan(setup())
  const line = (text: string, n: number) => estTokens(text.split('\n')[n - 1]!) + 1
  const sec = sectionsOf(CLAUDE).find(x => x.title === 'Billing service')!
  const stale = line(CLAUDE, p.stale.find(s => s.action === 'remove' && s.file === 'CLAUDE.md')!.line)
  const dupGeneral = line(GENERAL, 2)
  const dupWeb = line(WEB, 7)
  const always = estTokens(CLAUDE) + estTokens(LOCAL) + estTokens(GENERAL) + estTokens(DRAFT) // (a rule without `paths:` loads every session, tracked or not)
  expect(p.tokens.alwaysBefore).toBe(always)
  expect(p.tokens.alwaysAfter).toBe(always - sec.tokens - stale - dupGeneral)
  expect(p.tokens.alwaysAfter).toBeLessThan(p.tokens.alwaysBefore)
  expect(p.tokens.moved).toBe(sec.tokens)
  const scoped = estTokens(WEB)
  const up = p.upstream[0]!
  expect(p.tokens.scopedBefore).toBe(scoped)
  expect(p.tokens.scopedAfter).toBe(scoped - dupWeb + up.tokens + 12 + sec.tokens + 12) // the upstream rule's file and the moved section's file
})

test('no log, no candidate: loading is unverified; a plan is deterministic and its two files are written', async () => {
  const h = setup({ log: false })
  const p = await plan(h)
  expect(p.upstream).toEqual([])
  expect(p.lean.loadsVerified).toBe(false)
  expect(p.notes.join('\n')).toContain('loading is unverified')
  const a = await threadTool(h.host, 't1', 'lean_rules', { action: 'pr-plan' })
  expect(a.ok).toBe(true)
  expect(a.text).toContain(`${L}/proj/rules-pr/plan-2026-06-20.json`)
  const json = h.files.get(`${L}/proj/rules-pr/plan-2026-06-20.json`)!
  expect(JSON.parse(json).project).toBe('proj')
  expect(h.files.get(`${L}/proj/rules-pr/plan-2026-06-20.md`)).toContain('# Claude files plan for proj (2026-06-20)')
  await threadTool(h.host, 't1', 'lean_rules', { action: 'pr-plan' })
  expect(h.files.get(`${L}/proj/rules-pr/plan-2026-06-20.json`)).toBe(json)
  expect(renderPlan(p)).toBe(renderPlan(await plan(h)))
})

test('a project that is not a git checkout, or has no registered path, is refused with the reason', async () => {
  const h = setup({ git: false })
  const r = await threadTool(h.host, 't1', 'lean_rules', { action: 'pr-plan' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('not a git checkout')
  const g = setup()
  g.files.set(`${L}/projects.json`, '{}')
  expect((await threadTool(g.host, 't1', 'lean_rules', { action: 'pr-plan' })).ok).toBe(false)
  expect((await threadTool(g.host, 't1', 'lean_rules', { action: 'pr-plan', project: '../x' })).ok).toBe(false)
})

test('nothing to propose says so (no PR)', async () => {
  const h = setup({ log: false })
  h.files.set('/repo/CLAUDE.md', '# Acme\n\n- Run `pnpm test` before every commit so the suite stays green.\n')
  for (const n of ['general', 'web', 'draft']) h.files.delete(`/repo/.claude/rules/${n}.md`)
  h.files.delete(`${L}/proj/gaps.jsonl`)
  for (const n of ['billing', 'payments', 'infra']) h.files.delete(`${L}/proj/rules/${n}.md`)
  const r = await threadTool(h.host, 't1', 'lean_rules', { action: 'pr-plan' })
  expect(r.text).toContain('NOTHING to propose')
})

test('what a team file may never carry is recognised', () => {
  expect(unsafeWhy('call lean_script propose first')).toBe('names lean-agent')
  expect(unsafeWhy('see ~/notes or /Users/someone/work')).toBe('a personal path')
  expect(unsafeWhy('thread t12 said so')).toBe('a thread id')
  expect(unsafeWhy('that run cost $4.20')).toBe('a cost')
  expect(unsafeWhy('ask someone@example.com')).toBe('an email address')
  expect(unsafeWhy('fixed in #1234')).toBe('a PR or ticket number')
  expect(unsafeWhy('Run `pnpm test` before every commit')).toBe('')
})

test('contentOf: headings, code, comments and frontmatter are not content lines; short lines are not compared', () => {
  const t = '---\npaths:\n  - "a/**"\n---\n# Title\n- A real instruction with enough words in it.\n```\nnot a content line at all, just code\n```\n<!-- a comment line with many words in it -->\nshort one\n| a | table row with several words |\n'
  expect(contentOf(t).map(c => c.text)).toEqual(['A real instruction with enough words in it.', 'a table row with several words'])
})

test('retire-upstreamed: a dry run lists, apply retires rules and lessons into a backup, learn will not write the area again, check stops reporting them', async () => {
  const h = setup()
  const before = await threadTool(h.host, 't1', 'lean_rules', { action: 'check' })
  expect(before.text).toContain('rule infra.md: 2 of 2 lines are already in the repo')
  expect(before.text).toContain('review lessons: 1 line(s) are already in the repo')
  const dry = await threadTool(h.host, 't1', 'lean_rules', { action: 'retire-upstreamed' })
  expect(dry.text).toContain('would retire rule infra.md')
  expect(dry.text).toContain('would retire lesson #1')
  expect(dry.text).toContain('nothing changed')
  expect(h.files.has(`${L}/proj/rules/infra.md`)).toBe(true)
  const r = await threadTool(h.host, 't1', 'lean_rules', { action: 'retire-upstreamed', apply: true })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('retired rule infra.md')
  expect(h.files.has(`${L}/proj/rules/infra.md`)).toBe(false)
  expect(h.files.get(`${L}/proj/rules-pr/retired/2026-06-20/rules/infra.md`)).toBe(INFRA) // the backup is the file as it was
  expect(h.files.has(`${L}/proj/rules/billing.md`)).toBe(true) // 1 of 4 lines in the repo: it stays
  expect(JSON.parse(h.files.get(`${L}/proj/rules-pr/retired/2026-06-20/lessons.json`)!).map((l: any) => l.id)).toEqual([1])
  const lessons = h.files.get(`${L}/proj/review-lessons.jsonl`)!.split('\n').filter(Boolean).map(x => JSON.parse(x))
  expect(lessons.find((l: any) => l.id === 1)).toMatchObject({ dropped: '2026-06-20', droppedWhy: 'upstreamed' }) // soft: lessons-undo brings it back
  expect(JSON.parse(h.files.get(`${L}/proj/learn.json`)!).areas.infra.coveredBy).toBe('CLAUDE.md')
  const after = await threadTool(h.host, 't1', 'lean_rules', { action: 'check' })
  expect(after.text).not.toContain('infra.md: 2 of 2')
  expect(after.text).not.toContain('review lessons: 1 line(s) are already')
  // the merged state can be checked at a ref instead of the working tree
  const at = await threadTool(h.host, 't1', 'lean_rules', { action: 'retire-upstreamed', ref: 'origin/main' })
  expect(at.text).toContain('at origin/main')
})
