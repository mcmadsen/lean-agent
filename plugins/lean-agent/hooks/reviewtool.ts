// `lean_review` actions beyond the plain record: prepare (the script-computed brief, model and second-opinion advice), record (the
// reviewer's JSON checked by reviewgate.ts before a green is signed) and decline. The HMAC signing stays in reviews.ts.
import type { Host } from './state'
import { homeDir, leanDir } from './state'
import { readConfig } from './budget'
import { writeReview } from './reviews'
import type { Review } from './reviews'
import { capPrep, prepText, prepare, refOk, resolveRange } from './reviewprep'
import type { Range } from './reviewprep'
import { chooseModel, wantSecondOpinion } from './reviewrisk'
import { addDecline, declinesFor, declinesText, enforce, findingLine, normalize } from './reviewgate'
import type { Context, Finding, Result } from './reviewgate'
import { slugOk } from './rules'

type Out = { ok: boolean; text: string }
type Carry = { open: Finding[]; reuse: Result['reuse']; coverage: Result['coverage']; branch: string; ts: number }
type Earlier = { sha: string; carry: Carry }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
// what a later round needs from this one lives in the mod's own store (a session cannot write it: it would void the enforcement)
const carryKey = (project: string, sha: string) => `review.carry.${project}.${sha}`

async function findEarlier(h: Host, project: string, r: Range, branch: string, since: string): Promise<Earlier | null> {
  const home = await homeDir(h)
  const git = async (...a: string[]) => h.process.run(['git', '-C', r.path, ...a], { timeoutMs: 15_000 }).catch(() => null)
  const names = (await h.fs.list(`${leanDir(home)}/${project}/reviews`).catch(() => [])).map(f => f.name.replace(/\.json$/, '')).filter(n => /^[0-9a-f]{40,64}$/.test(n) && n !== r.head)
  const cands: Earlier[] = []
  for (const sha of names) {
    if (since && sha !== since) continue
    const carry = (await h.store.get(carryKey(project, sha)).catch(() => undefined)) as Carry | undefined
    if (carry && typeof carry === 'object' && Array.isArray(carry.open) && (!branch || !carry.branch || carry.branch === branch)) cands.push({ sha, carry })
  }
  cands.sort((a, b) => b.carry.ts - a.carry.ts)
  for (const c of cands.slice(0, 20)) {
    const anc = await git('merge-base', '--is-ancestor', c.sha, r.head)
    if (anc && anc.exitCode === 0) return c
  }
  if (since && refOk(since)) { // a delta start the caller names but this tool did not record: the diff since it, no earlier findings
    const ok = await git('rev-parse', '--verify', '--end-of-options', `${since}^{commit}`)
    if (ok && ok.exitCode === 0) return { sha: ok.stdout.trim(), carry: { open: [], reuse: [], coverage: [], branch, ts: 0 } }
  }
  return null
}

async function loadContext(h: Host, project: string, r: Range, branch: string, since: string, second?: Context['second']) {
  const { prep, diff } = await prepare(h, r)
  const earlier = await findEarlier(h, project, r, branch, since)
  const delta = earlier ? (await prepare(h, r, earlier.sha)).prep : null
  const declines = await declinesFor(h, project, branch)
  const ctx: Context = { prep, delta, earlier: earlier ? earlier.carry : null, declines, ...(second ? { second } : {}) }
  return { ctx, diff, earlier }
}

const short = (s: string) => s.slice(0, 10)

async function doPrepare(h: Host, project: string, i: any): Promise<Out> {
  const range = await resolveRange(h, project, str(i.base) || undefined, str(i.head) || undefined)
  if (typeof range === 'string') return { ok: false, text: `prepare: ${range}` }
  const branch = str(i.branch)
  const { ctx, diff, earlier } = await loadContext(h, project, range, branch, str(i.since))
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
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return { ok: false, text: 'review needs a full commit sha' }
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
  const { ctx } = await loadContext(h, project, range, branch, str(i.since), second)
  const v = enforce(res, ctx)
  const green = wantGreen && v.green
  rec.green = green
  rec.base = base || range.base
  if (branch) rec.branch = branch
  rec.findings = v.open.map(findingLine)
  const file = await writeReview(h, rec)
  await h.store.set(carryKey(project, sha), { open: v.open, reuse: v.reuse, coverage: v.coverage, branch, ts: await h.clock.now() } satisfies Carry)
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
  if (action === 'prepare') return doPrepare(h, project, i)
  if (action === 'decline') return doDecline(h, project, i)
  if (action === 'record') return doRecord(h, project, i)
  return { ok: false, text: `unknown lean_review action ${action}` }
}
