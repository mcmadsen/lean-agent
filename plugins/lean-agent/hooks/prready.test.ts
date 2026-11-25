// 1.0.35: a thread that reports "ready to push" gets the PR guide check of the intended text, with the template skeleton and the stored work item when it fails (no model, nothing sent).
import { expect, test } from 'claude-code/testing'
import { fakeHost } from './fake'
import { createChecks, runPrGuide } from './prchecks'
import { intentFrom, readyCheck, readyToPush } from './prready'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const TEMPLATE = '# Pull request\n\n## Summary\n<!-- what and why -->\n\n## Test plan\n\n## Screenshots (optional)\n'
const TITLES = ['feat(api): add the export endpoint', 'fix(ui): keep the focus ring', 'chore: bump the build image', 'docs: explain the cache', 'fix: handle an empty list', 'feat!: drop the old route']
const GOOD = '## Summary\nAdds the export endpoint.\n\n## Test plan\nRan the suite: green.\n'

function world(cfg: unknown = {}) {
  const h = fakeHost(null)
  h.files.set('/h/.lean-agent/config.json', JSON.stringify(cfg))
  h.files.set('/r/.azuredevops/pull_request_template.md', TEMPLATE)
  h.files.set('/h/.lean-agent/worktrees.json', JSON.stringify({ w1: { path: '/r', thread: 't1' } }))
  h.files.set('/h/.lean-agent/threads/t1/thread.json', JSON.stringify({ project: 'app', workItem: { id: 4210 } }))
  h.git.handler = a => {
    const s = a.join(' ')
    if (s.includes('refs/remotes/origin/HEAD')) return { exitCode: 0, stdout: 'origin/main\n' }
    if (s.includes('rev-parse --verify')) return { exitCode: 0, stdout: SHA + '\n' }
    if (s.includes('rev-parse HEAD')) return { exitCode: 0, stdout: SHA + '\n' }
    if (a.includes('log')) return { exitCode: 0, stdout: TITLES.map(t => `${t}\x1f\x1e`).join('\n') }
    return { exitCode: 1, stdout: '' }
  }
  return h
}

test('ready wording: ready state or "ready to push" / "ready for PR"; never blocked, waiting or a question', () => {
  expect(readyToPush('ready', 'x')).toBe(true)
  expect(readyToPush('working', 'All done, ready to push.')).toBe(true)
  expect(readyToPush('working', 'ready for PR')).toBe(true)
  expect(readyToPush('blocked', 'ready to push')).toBe(false)
  expect(readyToPush('waiting', 'ready to push')).toBe(false)
  expect(readyToPush('working', 'ready to push?')).toBe(false)
  expect(readyToPush('working', 'still going')).toBe(false)
})

test('intentFrom reads PR title / PR description lines or a fenced block', () => {
  expect(intentFrom('ready to push\nPR title: feat: a\nPR description: ## Summary\nx')).toEqual({ title: 'feat: a', body: '## Summary\nx' })
  expect(intentFrom('ready to push\n```\n## Summary\nhi\n```')).toEqual({ title: '', body: '## Summary\nhi' })
  expect(intentFrom('ready to push')).toBeNull()
})

test('a ready report with an empty body gets a skeleton with the template headings and the work item link', { timeoutMs: 20_000 }, async () => {
  const h = world()
  const r = await readyCheck(h.host, 't1', { state: 'working', text: 'Ready to push.\nPR title: add export' })
  expect(r).toContain('## Summary')
  expect(r).toContain('## Test plan')
  expect(r).toContain('## Screenshots (optional)')
  expect(r).toContain('<fill in:')
  expect(r).toContain('Related work items: AB#4210')
})

test('a good title and body gets the OK line', { timeoutMs: 20_000 }, async () => {
  const h = world()
  const r = await readyCheck(h.host, 't1', { state: 'working', text: `ready to push\nPR title: feat(api): add export\nPR description:\n\`\`\`\n${GOOD}\`\`\`` })
  expect(r).toContain('(OK)')
})

test('no ready wording, or a question: nothing is added', { timeoutMs: 20_000 }, async () => {
  const h = world()
  expect(await readyCheck(h.host, 't1', { state: 'working', text: 'half way through' })).toBeNull()
  expect(await readyCheck(h.host, 't1', { state: 'working', text: 'is it ready to push?' })).toBeNull()
})

test('the PR guide switched off: null', { timeoutMs: 20_000 }, async () => {
  const h = world({ pr: { checks: { guide: false } } })
  expect(await readyCheck(h.host, 't1', { state: 'ready', text: 'ready to push' })).toBeNull()
})

test('no worktree: a one-line skipped note', { timeoutMs: 20_000 }, async () => {
  const h = world()
  h.files.set('/h/.lean-agent/worktrees.json', '{}')
  expect(await readyCheck(h.host, 't1', { state: 'ready', text: 'ready to push' })).toContain('skipped')
})

test('an intent stored by pr-guide is used when the report has none', { timeoutMs: 20_000 }, async () => {
  const h = world()
  await runPrGuide(h.host, 't1', { title: 'feat(api): add export', body: GOOD }, '/r')
  const r = await readyCheck(h.host, 't1', { state: 'ready', text: 'ready to push' })
  expect(r).toContain('(OK)')
})

test('the push refusal carries the skeleton', { timeoutMs: 20_000 }, async () => {
  const h = world()
  const o = await createChecks(h.host, { dir: '/r', project: 'app', thread: 't1', sha: SHA, remote: 'origin', base: 'main', title: 'add export', body: '', draft: false })
  expect(o.ok).toBe(false)
  if (!o.ok) {
    expect(o.text).toContain('## Summary')
    expect(o.text).toContain('Related work items: AB#4210')
  }
})
