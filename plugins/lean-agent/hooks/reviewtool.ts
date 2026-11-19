// `lean_review` actions beyond the plain record: prepare (the script-computed brief, model and second-opinion advice), record (the
// reviewer's JSON checked by reviewgate.ts before a green is signed) and decline. The HMAC signing stays in reviews.ts.
import type { Host } from './state'
import { homeDir } from './state'
import { readConfig } from './budget'
import { writeReview } from './reviews'
import type { Review } from './reviews'
import { capPrep, prepText, prepare, refOk, resolveRange } from './reviewprep'
import type { Range } from './reviewprep'
import { chooseModel, wantSecondOpinion } from './reviewrisk'
import { addDecline, declinesFor, declinesText, enforce, findingLine, normalize } from './reviewgate'
import type { Context, Finding, Result } from './reviewgate'
import { slugOk } from './rules'
import { lessonsTool } from './reviewlessons'

type Out = { ok: boolean; text: string }
type Carry = { open: Finding[]; reuse: Result['reuse']; coverage: Result['coverage']; branch: string; ts: number }
type Earlier = { sha: string; carry: Carry }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
// what a later round needs from this one lives in the mod's own store (a session cannot write it: it would void the enforcement)
// One blob per project (sha -> carry), the newest CARRY_KEEP kept: the store has no way to list or delete keys
const carryKey = (project: string) => `review.carry.${project}`
const CARRY_KEEP = 20
const carries = async (h: Host, project: string): Promise<Record<string, Carry>> => {
  const v = await h.store.get(carryKey(project)).catch(() => undefined)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Carry>) : {}
}
async function putCarry(h: Host, project: string, sha: string, c: Carry): Promise<void> {
  const all = { ...(await carries(h, project)), [sha]: c }
  const keep = Object.entries(all).sort((a, b) => (b[1]?.ts ?? 0) - (a[1]?.ts ?? 0)).slice(0, CARRY_KEEP)
  await h.store.set(carryKey(project), Object.fromEntries(keep))
}

async function findEarlier(h: Host, project: string, r: Range, branch: string, since: string): Promise<Earlier | null> {
  const git = async (...a: string[]) => h.process.run(['git', '-C', r.path, ...a], { timeoutMs: 15_000 }).catch(() => null)
  const isAncestor = async (a: string, b: string) => (await git('merge-base', '--is-ancestor', a, b))?.exitCode === 0
  const cands: Earlier[] = []
  for (const [sha, carry] of Object.entries(await carries(h, project))) {
    if (sha === r.head || sha === r.mb || (since && sha !== since)) continue
    if (carry && typeof carry === 'object' && Array.isArray(carry.open) && (!branch || !carry.branch || carry.branch === branch)) cands.push({ sha, carry })
  }
  cands.sort((a, b) => b.carry.ts - a.carry.ts)
  // an earlier round lies between the merge base and the head: a record from before the branch or from another line of history is not one
  for (const c of cands) if ((await isAncestor(c.sha, r.head)) && (await isAncestor(r.mb, c.sha))) return c
  if (since && refOk(since)) { // a delta start the caller names but this tool did not record: the diff since it, no earlier findings
    const ok = await git('rev-parse', '--verify', '--end-of-options', `${since}^{commit}`)
    const sha = ok && ok.exitCode === 0 ? ok.stdout.trim() : ''
    if (sha && sha !== r.head && (await isAncestor(sha, r.head))) return { sha, carry: { open: [], reuse: [], coverage: [], branch, ts: 0 } }
  }
  return null
}

async function loadContext(h: Host, project: string, r: Range, branch: string, since: string, second?: Context['second']) {
  const { prep, diff, failed } = await prepare(h, r)
  const earlier = await findEarlier(h, project, r, branch, since)
  const d = earlier ? await prepare(h, r, earlier.sha) : null
  const declines = await declinesFor(h, project, branch)
  const ctx: Context = { prep, delta: d?.prep ?? null, earlier: earlier ? earlier.carry : null, declines, ...(second ? { second } : {}) }
  return { ctx, diff, earlier, failed: failed || !!d?.failed }
}

const namedRef = async (git: (...a: string[]) => Promise<{ exitCode: number } | null>, name: string): Promise<boolean> => {
  if (!refOk(name)) return false
  for (const ns of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) if ((await git('show-ref', '--verify', '--quiet', `${ns}${name}`))?.exitCode === 0) return true
  return false
}

async function doPrepare(h: Host, project: string, i: any): Promise<Out> {
  const range = await resolveRange(h, project, str(i.base) || undefined, str(i.head) || undefined)
  if (typeof range === 'string') return { ok: false, text: `prepare: ${range}` }
  const branch = str(i.branch)
  const { ctx, diff, earlier, failed } = await loadContext(h, project, range, branch, str(i.since))
  if (failed) return { ok: false, text: `prepare: git could not produce the diff of ${range.mb}...${range.head} (an error or a timeout): nothing was computed. Try again; do not review without the lists` }
  const rereview = !!earlier
  const cfg = (await readConfig(h, await homeDir(h)).catch(() => ({}))) as { review?: { model?: unknown } }
  const { model, why } = chooseModel(ctx.prep, diff, { rereview, config: cfg?.review?.model })
  const brief = rereview ? ctx.delta! : ctx.prep // a re-review looks at what changed since; enforcement still covers the whole range
  const second = !rereview && wantSecondOpinion(ctx.prep)
  const lines: string[] = []
  lines.push(`Project checkout: ${range.path}`)
  lines.push(`Range: merge base ${range.mb}, head ${range.head}. The whole change: git -C ${range.path} diff ${range.mb}...${range.head} (code before the change: git -C ${range.path} show ${range.mb}:<path>)`)
  if (rereview) {
    lines.push(`RE-REVIEW. The last reviewed sha is ${earlier!.sha}. Review ONLY: (1) whether each open finding below is fixed, (2) the diff since: git -C ${range.path} diff ${earlier!.sha}...${range.head}, (3) the reuse, scope and platform passes (3 and 4) on the files changed since: ${brief.changed.slice(0, 30).join(', ') || 'none'}. Report new findings only about changed lines.`)
    lines.push(earlier!.carry.open.length ? `Open findings from the last review:\n${earlier!.carry.open.map(findingLine).join('\n')}` : 'Open findings from the last review: none.')
  }
  lines.push(prepText(capPrep(brief)))
  if (ctx.prep.truncated) lines.push('(the diff was over the size cap: the lists above may be incomplete; read the diff itself)')
  const d = declinesText(ctx.declines)
  if (d) lines.push(d)
  const meta = { model, why, secondOpinion: second, rereview, since: earlier?.sha ?? '', mb: range.mb, head: range.head, newSymbols: ctx.prep.symbols.length, editedTests: ctx.prep.tests.length, lines: ctx.prep.lines }
  return { ok: true, text: `LEAN-REVIEW-PREP ${JSON.stringify(meta)}\nreviewer model: ${model} (${why})${second ? '; run the search-only second opinion first (a new abstraction or a big diff)' : ''}.\nPut everything below this line in the reviewer's prompt.\n\n${lines.join('\n\n')}` }
}

const parseResult = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  const t = v.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try { return JSON.parse(t) } catch { return null }
}

async function doRecord(h: Host, project: string, i: any): Promise<Out> {
  const sha = str(i.sha)
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, text: 'review needs the full commit sha (git rev-parse HEAD)' }
  const wantGreen = i.green === true
  const raw = parseResult(i.review)
  const strings = Array.isArray(i.findings) ? i.findings.filter((x: unknown): x is string => typeof x === 'string') : undefined
  const rec: Review = { project, sha, green: false, passes: Number(i.passes) || undefined, findings: strings }
  const model = str(i.model)
  if (model) rec.model = model
  if (!raw || typeof raw !== 'object') {
    // no reviewer result: never green (the gate needs the structured result to hold the review to its rules)
    const file = await writeReview(h, rec)
    return wantGreen
      ? { ok: false, text: `green refused: lean_review needs the reviewer's JSON block (review) and base to check it against the diff; recorded NOT green in ${file}` }
      : { ok: true, text: `review recorded (not green) in ${file}` }
  }
  const base = str(i.base)
  const branch = str(i.branch)
  const range = await resolveRange(h, project, base || undefined, sha)
  if (typeof range === 'string') {
    const file = await writeReview(h, rec)
    return { ok: !wantGreen, text: `${wantGreen ? 'green refused' : 'recorded not green'}: ${range} (base is needed to compute the new symbols and edited tests); recorded NOT green in ${file}` }
  }
  const res = normalize(raw)
  const second = Array.isArray(i.second) ? i.second.filter((x: any) => x && typeof x.symbol === 'string').map((x: any) => ({ symbol: String(x.symbol), candidate: typeof x.candidate === 'string' ? x.candidate : '' })) : undefined
  const { ctx, failed } = await loadContext(h, project, range, branch, str(i.since), second)
  const v = enforce(res, ctx)
  // what the diff read must be believable: git answered, the range is not empty, and the base names a branch or tag (never a sha or
  // HEAD~1, which would shrink the range and with it the symbols and tests that need entries)
  const git = async (...a: string[]) => h.process.run(['git', '-C', range.path, ...a], { timeoutMs: 15_000 }).catch(() => null)
  if (failed) v.reasons.unshift('git could not produce the diff (an error or a timeout): nothing was checked, so no green')
  if (range.mb === range.head) v.reasons.unshift(`the range is empty (the merge base of ${base || 'the default branch'} is the head itself): base must be the branch this work goes into`)
  if (base && !(await namedRef(git, base))) v.reasons.unshift(`base ${base} is not a branch or tag name: pass the branch the work goes into (a sha or HEAD~n would shrink the range that is checked)`)
  v.green = v.reasons.length === 0
  const green = wantGreen && v.green
  rec.green = green
  rec.base = base || range.base
  if (branch) rec.branch = branch
  rec.findings = v.open.map(findingLine)
  const file = await writeReview(h, rec)
  await putCarry(h, project, sha, { open: v.open, reuse: v.reuse, coverage: v.coverage, branch, ts: await h.clock.now() })
  const tail = [v.open.length ? `open findings:\n${v.open.map(findingLine).join('\n')}` : 'no open findings', v.checks.length ? `checks:\n${v.checks.map(c => `- ${c.what}`).join('\n')}` : '', v.notes.length ? `notes: ${v.notes.join('; ')}` : ''].filter(Boolean).join('\n')
  if (wantGreen && !v.green) return { ok: false, text: `green refused, recorded NOT green in ${file}:\n${v.reasons.map(r => `- ${r}`).join('\n')}\n${tail}` }
  return { ok: true, text: `review recorded (${green ? 'green' : 'not green'}) in ${file}${!green && v.reasons.length ? `\n${v.reasons.map(r => `- ${r}`).join('\n')}` : ''}\n${tail}` }
}

async function doDecline(h: Host, project: string, i: any): Promise<Out> {
  const why = str(i.why)
  if (!why) return { ok: false, text: 'decline needs why (the user\'s reason)' }
  const all = i.all === true || i.allBranches === true
  const branch = str(i.branch)
  if (!all && !branch) return { ok: false, text: 'decline needs branch, or all: true for every branch of the project' }
  const kind = str(i.kind).toLowerCase()
  const symbol = str(i.symbol)
  if (!symbol && !str(i.text)) return { ok: false, text: 'decline needs the finding kind plus symbol (or text and path): a bare kind would silence a whole category' }
  const d = await addDecline(h, project, { all, branch, kind, symbol, path: str(i.path), text: str(i.text), why })
  return { ok: true, text: `declined ${d.kind || 'any kind'}${d.symbol ? ` ${d.symbol}` : ''} for ${all ? 'every branch' : branch} (${why}); later reviews are told and do not raise a matching finding again. A decline never turns a verdict green by itself: the open findings are what the gate counts.` }
}

export async function reviewTool(h: Host, project: string, i: any): Promise<Out> {
  if (!slugOk(project)) return { ok: false, text: 'lean_review needs a project name' }
  const action = str(i.action) || 'record'
  const les = await lessonsTool(h, project, i) // the learned lessons (reviewlessons.ts): lessons, learn, lessons-list/-rm/-undo/-verify
  if (les) return les
  if (action === 'prepare') return doPrepare(h, project, i)
  if (action === 'decline') return doDecline(h, project, i)
  if (action === 'record') return doRecord(h, project, i)
  return { ok: false, text: `unknown lean_review action ${action}` }
}
