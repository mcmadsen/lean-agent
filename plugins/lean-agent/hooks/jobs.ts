// Job types (execution model, fail fast): the first line of a worker brief names the job, `job: lookup|edit|run|check`. By job:
//  - a step budget (tool calls): lookup 10, edit 16, run 6, check 10; config.json `workers.stepsByJob`; `workers.steps` (24) stays the ceiling.
//    At 75% of the budget the worker's next tool result carries "N tool calls left: finish and answer" (orchestrate.ts); the refusal stays at the budget.
//  - a return schema, enforced by script: the Agent result is cut to it and marked (trimJobResult / jobResult)
//  - a retry count per (thread, job hash): the second identical brief needs a `why-sonnet:` line, the third is refused (retryDenial checks, retryRan counts)
// Pure: no host, no model. A brief without a `job:` line keeps today's rules (workers.steps, no schema).
import { mapTexts } from './cap'

export type Job = 'lookup' | 'edit' | 'run' | 'check'
export const JOBS: readonly Job[] = ['lookup', 'edit', 'run', 'check']
export const STEPS_BY_JOB: Record<Job, number> = { lookup: 10, edit: 16, run: 6, check: 10 }
// the reviewer's tool-call budget: ONE number for the guard, the brief and agents/reviewer.md (a 10-call budget needed ~12 turns: 1.0.31 makes it 16)
export const REVIEWER_STEPS = 16
export const reviewerBudget = (ceiling: number): number => Math.min(REVIEWER_STEPS, Math.max(1, ceiling))
export const STEP_WARN = 0.75 // at this share of the budget the worker's next tool result says how many calls are left
export const RESULT_LINES = 20

const isJob = (s: unknown): s is Job => JOBS.includes(s as Job)

// the job named by the FIRST non-blank line of a brief (`job: lookup`), or null
export function jobOf(prompt: unknown): Job | null {
  const first = String(typeof prompt === 'string' ? prompt : '').split('\n').find(l => l.trim())
  const m = first && /^\s*job\s*[:=]\s*([a-z]+)\s*$/i.exec(first)
  const j = m?.[1]?.toLowerCase()
  return isJob(j) ? j : null
}

// the step budget of a job: its own number (config workers.stepsByJob, else the built-in), never above the ceiling `workers.steps`
export function stepBudget(job: string | undefined | null, ceiling: number, byJob?: Partial<Record<string, number>>): number {
  if (!isJob(job)) return ceiling
  const own = byJob?.[job]
  const n = typeof own === 'number' && Number.isFinite(own) && own >= 1 ? Math.floor(own) : STEPS_BY_JOB[job]
  return Math.min(n, ceiling)
}

// the line a worker's tool result carries once it has used 75% of its budget (call number `n` of `budget`): at the threshold and at the last call; null otherwise
export function stepNote(n: number, budget: number): string | null {
  const left = budget - n
  if (left < 1 || n < Math.ceil(budget * STEP_WARN) || (n > Math.ceil(budget * STEP_WARN) && left !== 1)) return null
  return `${left} tool call${left === 1 ? '' : 's'} left: finish and answer`
}

// ---- retries per (thread, job hash) --------------------------------------------------------------------------------
export const WHY_SONNET = /^\s*why-sonnet:\s*\S/m
// the brief as the retry rule compares it: why-sonnet lines dropped, spacing and case ignored (the second try only ADDS that line)
export function jobHash(prompt: unknown): string {
  const t = String(typeof prompt === 'string' ? prompt : '')
    .split('\n')
    .filter(l => !/^\s*why-sonnet\s*:/i.test(l))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0
  return `${t.length}-${h.toString(16)}`
}

const tries = new Map<string, number>() // `${thread}|${hash}` -> times started
const MAX_TRIES = 500
export const retryReset = (): void => tries.clear()

// null = allow. 1st: allowed. 2nd identical: only with a `why-sonnet:` line. 3rd: refused, never a loop.
// Only a check: a try is counted by retryRan, when a worker really ran (a denied, rejected or failed call consumes none).
export function retryDenial(thread: string, prompt: unknown): string | null {
  const n = tries.get(`${thread}|${jobHash(prompt)}`) ?? 0
  if (n >= 2) return 'this exact job already ran twice: split the job differently or report blocked (never a third identical try)'
  if (n === 1 && !WHY_SONNET.test(String(typeof prompt === 'string' ? prompt : ''))) return 'this exact job already ran once and did not settle it: change the brief (one line saying what the first answer lacked), or escalate once with a `why-sonnet: <reason>` line; a third identical try is refused'
  return null
}
// how many times this brief already ran in this thread (a second try is a run with count >= 1 before it)
export const retryCount = (thread: string, prompt: unknown): number => tries.get(`${thread}|${jobHash(prompt)}`) ?? 0
// a worker ran for this brief (the Agent call returned a real result, or a background launch was accepted): one try used
export function retryRan(thread: string, prompt: unknown): void {
  const k = `${thread}|${jobHash(prompt)}`
  if (!tries.has(k) && tries.size >= MAX_TRIES) tries.delete(tries.keys().next().value as string)
  tries.set(k, (tries.get(k) ?? 0) + 1)
}

// ---- return schemas ------------------------------------------------------------------------------------------------
//   lookup        answer:\n<= 20 lines\nrefs: path:line, path:line
//   edit          files: a, b\ndiffstat: <git --shortstat>\nresult: pass|fail\nnote: <one line>
//   run | check   result: pass|fail\n<= 20 lines
// The worker's last line LEAN-FEEDBACK is not part of the schema (the mod reads it) and is kept as the last line.
const FEEDBACK = /^\s*`?LEAN-FEEDBACK\b.*$/
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const REF = /[^\s,;()`'"<>]+:\d+(?:-\d+)?/g

function splitFeedback(text: string): { body: string; feedback: string } {
  const lines = text.replace(/\s+$/, '').split('\n')
  let i = lines.length - 1
  while (i >= 0 && !lines[i]!.trim()) i--
  if (i >= 0 && FEEDBACK.test(lines[i]!)) return { body: lines.slice(0, i).join('\n').trim(), feedback: lines[i]!.trim() }
  return { body: text.trim(), feedback: '' }
}
const clip = (lines: string[]): string[] => {
  const l = lines.map(x => x.replace(/\s+$/, ''))
  while (l.length && !l[0]!.trim()) l.shift()
  while (l.length && !l[l.length - 1]!.trim()) l.pop()
  return l.slice(0, RESULT_LINES).map(x => cut(x, 300))
}
const field = (lines: string[], name: string): { at: number; value: string } | null => {
  const re = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, 'i')
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!)
    if (m) return { at: i, value: m[1]!.trim() }
  }
  return null
}
// pass|fail from the words of a text (a count of zero failures does not count), else from the worker's own status line, else fail
const verdictOf = (text: string, feedback: string): 'pass' | 'fail' => {
  const t = text.replace(/\b(0|no|zero) (failed|failing|failures?|errors?)\b/gi, '')
  if (/\b(fail|failed|failing|failures?|errors?)\b/i.test(t)) return 'fail'
  if (/\b(pass|passed|passing|ok|success|succeeded)\b/i.test(t)) return 'pass'
  return /"status"\s*:\s*"done"/.test(feedback) ? 'pass' : 'fail'
}

function lookupCanon(body: string): string {
  const lines = body.split('\n')
  const iRefs = lines.findIndex(l => /^\s*refs\s*:/i.test(l))
  const head = iRefs >= 0 ? lines.slice(0, iRefs) : lines
  if (head.length && /^\s*answer\s*:/i.test(head[0]!)) head[0] = head[0]!.replace(/^\s*answer\s*:\s*/i, '')
  const refSrc = iRefs >= 0 ? lines.slice(iRefs).join(' ') : lines.join(' ')
  const refs = [...new Set(refSrc.match(REF) ?? [])].slice(0, RESULT_LINES)
  return ['answer:', ...clip(head), `refs: ${refs.length ? refs.join(', ') : 'none'}`].join('\n')
}

function editCanon(body: string, feedback: string): string {
  const lines = body.split('\n')
  const files = field(lines, 'files')
  let list: string[] = files && files.value ? [files.value] : []
  if (files) {
    for (let i = files.at + 1; i < lines.length && /^\s*([-*]\s|\s{2,}\S)/.test(lines[i]!); i++) list.push(lines[i]!.replace(/^\s*[-*]\s*/, '').trim())
  }
  const fl = list.flatMap(x => x.split(',')).map(x => x.trim()).filter(Boolean).slice(0, 30)
  const stat = field(lines, 'diffstat')?.value || lines.find(l => /\d+ files? changed|\+\d+\s*[\/,]\s*-\d+/.test(l))?.trim() || ''
  const res = field(lines, 'result')?.value ?? ''
  const verdict = /\b(pass|fail)\b/i.test(res) ? /\b(pass|fail)\b/i.exec(res)![1]!.toLowerCase() : verdictOf(body, feedback)
  const note = field(lines, 'note')?.value || lines.map(l => l.trim()).find(l => l && !/^(files|diffstat|sha|result|note)\s*:/i.test(l) && !/^[-*]\s/.test(l)) || ''
  const sha = /\b[0-9a-f]{7,40}\b/i.exec(field(lines, 'sha')?.value ?? '')?.[0] // the worker's own commit (brief line `commit: <message>`); a line only when it committed
  return [`files: ${fl.length ? fl.join(', ') : 'none'}`, `diffstat: ${stat ? cut(stat, 120) : 'none'}`, ...(sha ? [`sha: ${sha.toLowerCase()}`] : []), `result: ${verdict}`, `note: ${cut(squash(note), 160)}`].join('\n')
}

function runCanon(body: string, feedback: string): string {
  const lines = body.split('\n')
  const res = field(lines, 'result')
  const first = /^\s*(pass|fail)\b/i.exec(lines.find(l => l.trim()) ?? '')?.[1]
  const verdict = res && /\b(pass|fail)\b/i.test(res.value) ? /\b(pass|fail)\b/i.exec(res.value)![1]!.toLowerCase() : first ? first.toLowerCase() : verdictOf(body, feedback)
  const rest = res ? lines.filter((_, i) => i !== res.at) : lines
  return [`result: ${verdict}`, ...clip(rest)].join('\n')
}

export const PARTS: Record<Job, string> = { lookup: 'answer (<= 20 lines) + refs', edit: 'files, diffstat, sha, pass|fail, one-line note', run: 'pass|fail + <= 20 lines', check: 'pass|fail + <= 20 lines' }

// the result cut to the job's schema; marked when anything was dropped or rebuilt
export function trimJobResult(job: Job, text: string): { text: string; trimmed: boolean } {
  const { body, feedback } = splitFeedback(text)
  const canon = job === 'lookup' ? lookupCanon(body) : job === 'edit' ? editCanon(body, feedback) : runCanon(body, feedback)
  const tail = feedback ? `\n${feedback}` : ''
  if (squash(canon) === squash(body)) return { text, trimmed: false }
  return { text: `${canon}\n[lean-agent: result outside the ${job} schema, trimmed to ${PARTS[job]}]${tail}`, trimmed: true }
}

// an Agent tool result (`r` as next(e) resolved to) cut to the schema: its first text block only (later blocks are the engine's own notes)
export function jobResult(r: any, job: Job | null): any {
  if (!job || !r || r.deny !== undefined || r.isError) return r
  const res = r.result
  if (res === undefined || res === null || (typeof res === 'object' && !Array.isArray(res) && (res as any).isError === true)) return r
  let done = false
  let changed = false
  const next = mapTexts(res, t => {
    if (done) return t
    done = true
    const o = trimJobResult(job, t)
    if (o.trimmed) changed = true
    return o.text
  })
  return changed ? { ...r, result: next } : r
}
