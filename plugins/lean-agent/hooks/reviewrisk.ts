// Which reviewer model a change deserves, and whether it needs a cheap search-only second opinion first (0.45's classify_risk,
// choose_review_model and second_opinion, ported). Pure functions over the diff text and the prep: no model decides this.
import type { Prep } from './reviewprep'
import { isTestPath } from './reviewprep'

export const LARGE_REVIEW_LINES = 800
const SECURITY = new Set(['auth', 'authn', 'authz', 'authenticate', 'authentication', 'authorize', 'authorization', 'token', 'tokens', 'crypto', 'cryptography', 'secret', 'secrets', 'password', 'passwords', 'permission', 'permissions', 'cert', 'certs', 'certificate', 'sign', 'signed', 'signing', 'signature', 'encrypt', 'encrypted', 'encryption', 'sanitize', 'sanitise', 'sanitizer', 'csp', 'cors'])
const CONCURRENCY = new Set(['race', 'concurrent', 'concurrency', 'mutex', 'lock', 'semaphore', 'timeout', 'interval', 'timer', 'debounce', 'throttle', 'logout', 'login', 'session', 'migrate', 'migration', 'schema', 'sync', 'async', 'queue', 'queued', 'retry', 'cache', 'transaction', 'webhook', 'cron', 'pending', 'inflight', 'promise', 'mutation'])
// path signals of a change users or other code can observe
const PATHS: [string, RegExp][] = [
  ['UI strings', /(^|\/)(locales?|i18n|l10n|translations?|lang|strings)(\/|\.|$)|\.(resx|po|xlf|arb)$/i],
  ['UI', /\.(xaml|axaml|storyboard|tsx|jsx|vue|svelte|html|cshtml|razor)$|(^|\/)(ui|views?|screens?|pages)\//i],
  ['migration/schema/storage', /migrat|(^|\/)schema|\.sql$|(^|\/)(models?|entities)\.|(^|\/)storage|\.prisma$/i],
  ['public API', /openapi|swagger|\.proto$|\.graphql$|(^|\/)(routes?|routing|controllers?|endpoints?|protocol)(\/|\.)/i],
  ['config format', /(^|\/)(appsettings[^/]*|settings|config)\.[a-z]+$|\.(toml|ini|env)$|\.config\.[a-z]+$/i],
]
const isDocs = (f: string) => {
  const parts = f.split('/')
  if (parts.slice(0, -1).includes('prompts') || parts.slice(0, -1).includes('templates')) return false
  return f.endsWith('.md') || f.startsWith('docs/')
}

// reasons the change deserves the stronger model; [] = an ordinary change
export function classifyRisk(prep: Prep, diff: string): string[] {
  const names = prep.changed
  const lines = diff.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
  const tokens = new Set((`${names.join(' ')}\n${lines.join('\n')}`.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []).map(t => t.toLowerCase()))
  const why: string[] = []
  const sec = [...tokens].filter(t => SECURITY.has(t)).sort()
  if (sec.length) why.push(`security-sensitive: ${sec.slice(0, 3).join(', ')}`)
  const hits = [...tokens].filter(t => CONCURRENCY.has(t)).sort()
  if (hits.length >= 3) why.push(`concurrency/state: ${hits.slice(0, 5).join(', ')}`)
  const code = names.filter(n => !isDocs(n) && !isTestPath(n))
  for (const [reason, re] of PATHS) if (code.some(n => re.test(n))) why.push(reason)
  const gone = prep.exports.filter(e => e.kind === 'removed' && !e.name.startsWith('_'))
  if (gone.length) why.push(`removes public symbols: ${gone.slice(0, 3).map(e => e.name).join(', ')}`)
  if (prep.lines >= LARGE_REVIEW_LINES) why.push(`large diff, ${prep.lines} lines`)
  else if (names.length >= 15) why.push(`large (${names.length} files)`)
  return why
}

// { model, why }: a re-review and a docs/tests-only diff run on sonnet; any risk reason on opus; `config` (review.model) wins unless 'auto'
export function chooseModel(prep: Prep, diff: string, opts: { rereview?: boolean; config?: unknown } = {}): { model: string; why: string } {
  if (typeof opts.config === 'string' && opts.config && opts.config !== 'auto') return { model: opts.config, why: 'config.json review.model' }
  if (opts.rereview) return { model: 'sonnet', why: 're-review' }
  if (prep.changed.length && prep.changed.every(n => isDocs(n) || isTestPath(n))) return { model: 'sonnet', why: 'docs/tests only' }
  const why = classifyRisk(prep, diff)
  if (why.length) return { model: 'opus', why: `risk: ${why.slice(0, 4).join(', ')}` }
  return { model: 'sonnet', why: `${prep.lines} lines, no sensitive paths` }
}

// a new abstraction or a big diff: a cheap search-only reuse pass first (needs something new to look for)
export function wantSecondOpinion(prep: Prep): boolean {
  if (!prep.symbols.length && !prep.files.length) return false
  return prep.symbols.length >= 3 || prep.files.length >= 2 || prep.changed.length >= 12
}
