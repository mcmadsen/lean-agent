// `lean_review` actions beyond the plain record: prepare (the script-computed brief, model and second-opinion advice), record (the
// reviewer's JSON checked by reviewgate.ts before a green is signed) and decline. The HMAC signing stays in reviews.ts.
import type { Host } from './state'
import { homeDir } from './state'
import { readConfig } from './budget'
import { writeReview } from './reviews'
import { externalOf, fetchExternal, noteExternal } from './reviewext'
import { logRefusal } from './feedback'
import { noteReviewed } from './reviewkind'
import type { Review } from './reviews'
import { capPrep, prepText, prepare, refOk, resolveRange } from './reviewprep'
import type { Range } from './reviewprep'
import { requiredRuns, wantSecondOpinion, wantedModel } from './reviewrisk'
import { addDecline, declinesFor, declinesText, enforce, findingLine, normalize } from './reviewgate'
import type { Context, Finding, Result } from './reviewgate'
import { digestOf, mergeRuns, rememberMerged, sameBlocks, wasMerged } from './reviewmerge'
import { addRequest, isExpensiveModel, modelAllowed } from './expensive'
import { slugOk } from './rules'
import { lessonsTool, repoOf } from './reviewlessons'
import { fetchPrs } from './prhost'
import { excludeSpecs, excludedText, globsOk } from './reviewexclude'
import { expectedReviewCost, expectedText } from './reviewcost'
import { readRegistry, worktreeState } from './worktreereg'

type Out = { ok: boolean; text: string }
// light: the carry of a light pass (never green); a full review does not take it as "the last reviewed sha", a light one does
type Carry = { open: Finding[]; reuse: Result['reuse']; coverage: Result['coverage']; branch: string; ts: number; light?: boolean }
type Earlier = { sha: string; carry: Carry }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// ---- the two review levels ---------------------------------------------------------------------------------------------------
// light (the default): ONE sonnet pass over correctness, behaviour and reuse, at an intermediate checkpoint; it never records green.
// full: the strict review (every pass, two runs for a high-risk diff, the checks of the record) that the push gate needs; asked for only
// before "ready to push". What the last prepare of a sha asked for lives in the mod's store (a session cannot write it), so a light pass
// cannot be recorded green by leaving the level out of the record call.
export type Level = 'light' | 'full'
export const levelArg = (v: unknown): Level | null => {
  const s = str(v).toLowerCase()
  return !s ? 'light' : s === 'light' || s === 'full' ? s : null
}
const levelKey = (project: string) => `review.level.${project}`
async function noteLevel(h: Host, project: string, sha: string, level: Level): Promise<void> {
  const v = await h.store.get(levelKey(project)).catch(() => undefined)
  const all: Record<string, { level: Level; ts: number }> = v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : {}
  all[sha] = { level, ts: await h.clock.now() }
  const keep = Object.entries(all).sort((a, b) => (b[1]?.ts ?? 0) - (a[1]?.ts ?? 0)).slice(0, 20)
  await h.store.set(levelKey(project), Object.fromEntries(keep)).catch(() => undefined)
}
async function preparedLevel(h: Host, project: string, sha: string): Promise<Level | null> {
  const v = (await h.store.get(levelKey(project)).catch(() => undefined)) as Record<string, { level?: unknown }> | undefined
  const l = v && typeof v === 'object' ? v[sha]?.level : undefined
  return l === 'light' || l === 'full' ? l : null
}

// The two arguments this file adds to the lean_review tool's inputSchema (delivery.ts spreads them into its properties)
export const REVIEW_EXTRA_PROPS = {
  level: { type: 'string', enum: ['light', 'full'], description: 'prepare, record: light (the default: ONE cheap sonnet pass on correctness, behaviour and reuse at an intermediate checkpoint; it never records green) or full (the strict review the push gate needs: every pass, two runs for a high-risk diff; ask for it only before "ready to push")' },
  ref: { type: 'string', description: 'prepare: review SOMEONE ELSE\'s work: a PR number or URL, a branch or a sha of the project\'s origin, read read-only into a scratch repository (never the user\'s tree); base optional. Record it with mode: "external"' },
  mode: { type: 'string', enum: ['external'], description: 'record: external = the review of a ref prepare read (ref): the record is NOT green and never counts for the push gate' },
  worktree: { type: 'string', description: 'prepare, record (the same one on both sides): absolute path of a registered worktree of the project to review (default: the calling thread\'s own registered worktree, else the project\'s path)' },
}

// The checkout a review reads: the calling thread's own registered worktree of this project (its HEAD is the work under review), else the
// project's registered path. `asked` (the `worktree` argument) must be a registered worktree of the project or its own path.
async function checkoutOf(h: Host, project: string, thread: string, branch: string, asked: string): Promise<string | undefined> {
  const { reg } = await readRegistry(h, await homeDir(h)).catch(() => ({ reg: {} as Record<string, any> }))
  const mine: { path: string; branch: string }[] = []
  for (const [k, e] of Object.entries(reg)) {
    if (!k.startsWith(`${project}/`) || !e || typeof e.path !== 'string' || !e.path.startsWith('/')) continue
    if (asked ? e.path.replace(/\/+$/, '') === asked.replace(/\/+$/, '') : typeof e.thread === 'string' && e.thread === thread && !!thread) mine.push({ path: e.path, branch: String(e.branch ?? '') })
  }
  const pick = mine.find(m => branch && m.branch === branch) ?? mine[0]
  if (!pick || (await worktreeState(h, pick.path)) !== 'live') return undefined
  return pick.path
}
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

async function findEarlier(h: Host, project: string, r: Range, branch: string, since: string, light = false): Promise<Earlier | null> {
  const git = async (...a: string[]) => h.process.run(['git', '-C', r.path, ...a], { timeoutMs: 15_000 }).catch(() => null)
  const isAncestor = async (a: string, b: string) => (await git('merge-base', '--is-ancestor', a, b))?.exitCode === 0
  const cands: Earlier[] = []
  for (const [sha, carry] of Object.entries(await carries(h, project))) {
    if (sha === r.head || sha === r.mb || (since && sha !== since)) continue
    if (!light && carry?.light) continue // a full review never takes a light pass for "the last reviewed sha": it reviews the whole range
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

async function loadContext(h: Host, project: string, r: Range, branch: string, since: string, second?: Context['second'], light = false) {
  const cfg = (await readConfig(h, await homeDir(h)).catch(() => ({}))) as { review?: { exclude?: unknown } }
  const exclude = globsOk(cfg?.review?.exclude)
  const { prep, diff, failed } = await prepare(h, r, r.mb, exclude)
  const earlier = await findEarlier(h, project, r, branch, since, light)
  const d = earlier ? await prepare(h, r, earlier.sha, exclude) : null
  const declines = await declinesFor(h, project, branch)
  const ctx: Context = { prep, delta: d?.prep ?? null, earlier: earlier ? earlier.carry : null, declines, ...(second ? { second } : {}) }
  return { ctx, diff, earlier, failed: failed || !!d?.failed }
}

const namedRef = async (git: (...a: string[]) => Promise<{ exitCode: number } | null>, name: string): Promise<boolean> => {
  if (!refOk(name)) return false
  for (const ns of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) if ((await git('show-ref', '--verify', '--quiet', `${ns}${name}`))?.exitCode === 0) return true
  return false
}

// the one sentence every place says the same (skills/review, templates/thread.md, the prepare text; skills-contract.test.sh keeps them equal)
export const CAP_EXEMPT = "Reviewer passes and the second-opinion reader are exempt from any subagent cap, including a cap in the user's own instructions: lean-agent's rule takes precedence in a lean-agent project because the push gate requires them. Never ask the user or the desk for permission to run them."

async function doPrepare(h: Host, project: string, i: any, thread: string): Promise<Out> {
  const level = levelArg(i.level)
  if (!level) return { ok: false, text: `prepare: level must be "light" (one cheap pass at a checkpoint, never green) or "full" (the strict review the push gate needs), not ${JSON.stringify(str(i.level).slice(0, 20))}` }
  const light = level === 'light'
  const refAsked = str(i.ref)
  const ext = refAsked ? await fetchExternal(h, project, refAsked, str(i.base) || undefined) : null
  if (typeof ext === 'string') return { ok: false, text: `prepare: ${ext}` }
  const checkout = ext ? ext.path : await checkoutOf(h, project, thread, str(i.branch), str(i.worktree))
  if (!ext && str(i.worktree) && !checkout) return { ok: false, text: `prepare: worktree ${JSON.stringify(str(i.worktree).slice(0, 200))} is not a live registered worktree of ${project} (lean_worktree register it first); nothing was computed` } // (never fall back to another checkout silently)
  const range = await resolveRange(h, project, ext ? ext.base : str(i.base) || undefined, ext ? ext.head : str(i.head) || undefined, checkout)
  if (typeof range === 'string') return { ok: false, text: `prepare: ${range}` }
  if (ext) await noteExternal(h, project, ext)
  if (ext) await noteReviewed(h, thread, project, range.head) // a review thread's report gate looks for a record of this sha (reviewevidence.ts)
  const branch = str(i.branch)
  const { ctx, diff, earlier, failed } = await loadContext(h, project, range, branch, str(i.since), undefined, light)
  if (failed) return { ok: false, text: `prepare: git could not produce the diff of ${range.mb}...${range.head} (an error or a timeout): nothing was computed. Try again; do not review without the lists` }
  const rereview = !!earlier
  const cfg = (await readConfig(h, await homeDir(h)).catch(() => ({}))) as { review?: { model?: unknown } }
  // The reviewer is sonnet (twice for a high-risk diff, on the full level). A model that config.json review.model or the brief names is
  // used only when it is cheap, or an expensive one the user approved for THIS thread in the pane; otherwise sonnet runs and the request
  // waits in the pane. The light level is always ONE sonnet pass.
  const runs = light ? { runs: 1 as const, why: 'light review' } : requiredRuns(ctx.prep, diff, rereview)
  let model = 'sonnet'
  let nRuns: 1 | 2 = runs.runs
  let why = runs.why
  let held = ''
  const want = light ? null : wantedModel({ config: cfg?.review?.model, asked: i.model })
  if (want) {
    if (!isExpensiveModel(want.model) || (await modelAllowed(h, thread, want.model))) {
      model = want.model
      nRuns = 1
      why = want.why
    } else {
      await addRequest(h, { thread, model: want.model, reason: `the review of ${project} asks for ${want.model} (${want.why})`, action: 'review', origin: 'review', asked: true }).catch(() => undefined)
      held = `a review on ${want.model} (${want.why}) needs the user's approval for this thread (a request is in the pane's "Needs you", Approve there); sonnet runs meanwhile.`
    }
  }
  const brief = rereview ? ctx.delta! : ctx.prep // a re-review looks at what changed since; enforcement still covers the whole range
  const second = !light && !rereview && wantSecondOpinion(ctx.prep)
  await noteLevel(h, project, range.head, level)
  // generated files stay out of the diff the reviewer reads (its own `git diff` takes the pathspecs as written)
  const specs = excludeSpecs(brief.excluded)
  const cut = specs ? ` -- . ${specs}` : ''
  const co = range.path
  const lines: string[] = []
  if (ext) lines.push(`EXTERNAL REVIEW of ${ext.label} (someone else's work, read read-only from a scratch repository; the user's tree is never touched). Record it with mode: "external" and the head sha below: it is recorded NOT green and never counts for the push gate. Do not edit anything and do not push.`)
  lines.push(ext ? `Scratch repository (every git command is git -C this path, never cd): ${co}` : `Project checkout (the worktree: every git command is git -C this path, never cd): ${co}`)
  lines.push(`Range: merge base ${range.mb}, head ${range.head}. The whole change: git -C ${co} diff ${range.mb}...${range.head}${cut} (code before the change: git -C ${co} show ${range.mb}:<path>)`)
  const grants = [`git -C ${co} diff ${range.mb}...${range.head}`, `git -C ${co} log ${range.mb}..${range.head}`, `git -C ${co} show ${range.head}`, `git -C ${co} merge-base ${range.mb} ${range.head}`, ...(rereview ? [`git -C ${co} diff ${earlier!.sha}...${range.head}`] : [])]
  lines.push(`allow-cmd: ${grants.join(', ')}`)
  const ex = excludedText(brief.excluded)
  if (ex) lines.push(ex)
  if (light) lines.push('LIGHT REVIEW (an intermediate checkpoint; one pass; it never records green). Do ONLY pass 1 (correctness, traced end to end), pass 2 (behaviour before -> after) and pass 3 (reuse and duplication). Skip completeness, scope and platform, tests, defaults and style. Report only findings you are sure of, blockers and majors first; keep the answer short. Still answer with the one fenced json block (every key; `[]` for what you skipped).')
  if (rereview) {
    lines.push(`RE-REVIEW. The last reviewed sha is ${earlier!.sha}. Review ONLY: (1) whether each open finding below is fixed, (2) the diff since: git -C ${co} diff ${earlier!.sha}...${range.head}${cut}, (3) ${light ? 'the reuse pass (3)' : 'the reuse, scope and platform passes (3 and 4)'} on the files changed since: ${brief.changed.slice(0, 30).join(', ') || 'none'}. Report new findings only about changed lines.`)
    lines.push(earlier!.carry.open.length ? `Open findings from the last review:\n${earlier!.carry.open.map(findingLine).join('\n')}` : 'Open findings from the last review: none.')
  }
  lines.push(prepText(capPrep(brief)))
  if (ctx.prep.truncated) lines.push('(the diff was over the size cap: the lists above may be incomplete; read the diff itself)')
  const d = declinesText(ctx.declines)
  if (d) lines.push(d)
  const exp = await expectedReviewCost(h, project, nRuns)
  const meta = { level, model, runs: nRuns, why, secondOpinion: second, rereview, since: earlier?.sha ?? '', mb: range.mb, head: range.head, newSymbols: ctx.prep.symbols.length, editedTests: ctx.prep.tests.length, lines: ctx.prep.lines, excluded: { files: brief.excluded?.files.length ?? 0, lines: brief.excluded?.lines ?? 0 }, expectedUsd: Math.round(exp.usd * 100) / 100 }
  const who = nRuns === 2 ? `reviewer: ${model} x2 (${why})` : `reviewer: ${model} (${why})`
  const lvl = light
    ? 'level: LIGHT (default at a checkpoint: one sonnet pass, correctness + behaviour + reuse; it never records green). Before "ready to push" run prepare again with level: "full": the push gate needs the full review\'s record.'
    : 'level: FULL (the strict review the push gate needs; a green record is possible).'
  const twice = nRuns === 2 ? `\nThis is a high-risk diff: run TWO independent reviewer passes on ${model} (two separate Agent calls with the same prompt; neither sees the other's answer). Pass both JSON blocks to lean_review: action record with reviews: [<block 1>, <block 2>] (or action merge first to see the merged block). Findings both found are marked [2/2]; the union counts.` : ''
  return { ok: true, text: `LEAN-REVIEW-PREP ${JSON.stringify(meta)}\n${who}${second ? '; run the search-only second opinion first (a new abstraction or a big diff)' : ''}.\n${lvl}\n${expectedText(exp, model)}.${held ? `\n${held}` : ''}${twice}\n${CAP_EXEMPT}\nPut everything below this line in the reviewer's prompt.\n\n${lines.join('\n\n')}` }
}

const parseResult = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  const t = v.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try { return JSON.parse(t) } catch { return null }
}

// the two runs of a high-risk diff (`reviews`): both blocks parsed, not the same one twice; a string = what is wrong
type TwoRuns = { a: unknown; b: unknown }
function twoRuns(v: unknown): TwoRuns | string {
  if (!Array.isArray(v) || v.length !== 2) return 'reviews must hold exactly two reviewer JSON blocks (one per independent run)'
  const [a, b] = [parseResult(v[0]), parseResult(v[1])]
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return 'reviews: each of the two blocks must be the reviewer\'s JSON object (a block that does not parse is no review)'
  if (sameBlocks(a, b)) return 'reviews: the two blocks are identical, so they are one pass twice, not two independent passes: run the second reviewer separately'
  return { a, b }
}
// a block as the thread will hand it back (a JSON round trip), so its digest is the same on both sides
const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v))

async function doMerge(h: Host, project: string, i: any): Promise<Out> {
  const two = twoRuns(i.reviews)
  if (typeof two === 'string') return { ok: false, text: `merge: ${two}` }
  const { result, info } = mergeRuns(normalize(two.a), normalize(two.b))
  const block = roundTrip(result)
  await rememberMerged(h, project, digestOf(block))
  return { ok: true, text: `merged 2 reviewer runs: ${result.findings.length} finding(s), ${info.both} found by both [2/2], ${info.only} by one run [1/2] (the union counts).\nPass this block, unchanged, as review to lean_review record (or pass the two blocks as reviews):\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\`` }
}

async function doRecord(h: Host, project: string, i: any, thread: string): Promise<Out> {
  const sha = str(i.sha)
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, text: 'review needs the full commit sha (git rev-parse HEAD)' }
  const external = str(i.mode) === 'external'
  const wantGreen = i.green === true && !external // an external review (someone else's ref) is never green, and says so below
  const extNote = external ? ' [external review: recorded NOT green by design; it never counts for the push gate]' : ''
  let raw: unknown
  let merged: string | null = null
  let verdicts: string[] | undefined
  if (i.reviews !== undefined) {
    const two = twoRuns(i.reviews)
    if (typeof two === 'string') {
      const file = await writeReview(h, { project, sha, green: false, passes: Number(i.passes) || undefined })
      return { ok: !wantGreen, text: `${wantGreen ? 'green refused' : 'recorded not green'}: ${two}; recorded NOT green in ${file}` }
    }
    const m = mergeRuns(normalize(two.a), normalize(two.b))
    raw = roundTrip(m.result)
    verdicts = [normalize(two.a).verdict, normalize(two.b).verdict]
    merged = `merged from 2 reviewer runs (${m.info.both} finding(s) by both [2/2], ${m.info.only} by one run [1/2])`
  } else raw = parseResult(i.review)
  const strings = Array.isArray(i.findings) ? i.findings.filter((x: unknown): x is string => typeof x === 'string') : undefined
  const rec: Review = { project, sha, green: false, passes: Number(i.passes) || undefined, findings: strings, ...(external ? { mode: 'external' as const } : {}) }
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
  // the same checkout prepare read (the thread's own worktree): generated-file marks and the lists must be the same on both sides
  const askedWt = str(i.worktree)
  const ext = external ? await externalOf(h, project, sha) : null
  if (external && !ext) {
    const file = await writeReview(h, rec)
    return { ok: true, text: `recorded not green: an external record needs lean_review prepare with ref for this sha first (the scratch repository it read is remembered by the mod); recorded NOT green in ${file}${extNote}` }
  }
  const checkout = ext ? ext.path : await checkoutOf(h, project, thread, branch, askedWt)
  const range = ext ? await resolveRange(h, project, ext.base, sha, ext.path) : askedWt && !checkout ? `worktree ${JSON.stringify(askedWt.slice(0, 200))} is not a live registered worktree of ${project}` : await resolveRange(h, project, base || undefined, sha, checkout)
  if (typeof range === 'string') {
    const file = await writeReview(h, rec)
    return { ok: !wantGreen, text: `${wantGreen ? 'green refused' : 'recorded not green'}: ${range} (base is needed to compute the new symbols and edited tests); recorded NOT green in ${file}` }
  }
  const res = normalize(raw)
  const second = Array.isArray(i.second) ? i.second.filter((x: any) => x && typeof x.symbol === 'string').map((x: any) => ({ symbol: String(x.symbol), candidate: typeof x.candidate === 'string' ? x.candidate : '' })) : undefined
  // a light pass never records green: said by the call (level: "light") or by the last prepare of this sha (the mod's store)
  const light = str(i.level).toLowerCase() === 'light' || (await preparedLevel(h, project, sha)) === 'light'
  const { ctx, diff, earlier, failed } = await loadContext(h, project, range, branch, str(i.since), second, light)
  const v = enforce(res, ctx)
  // a high-risk diff needs TWO independent runs: the two blocks (`reviews`), or the one block the merge action returned, unchanged
  // (its digest was remembered in the mod's store; a block that merely says `runs: 2` is one pass)
  const git = async (...a: string[]) => h.process.run(['git', '-C', range.path, ...a], { timeoutMs: 15_000 }).catch(() => null)
  const need = requiredRuns(ctx.prep, diff, !!earlier)
  if (need.runs === 2 && !merged && !light) {
    const rawRuns = (raw as { runs?: unknown }).runs
    if (rawRuns === 2 && (await wasMerged(h, project, digestOf(roundTrip(raw))))) merged = 'the merged block of 2 reviewer runs'
    else {
      // say what is still missing and over which commits, so the thread plans its passes (the one block given counts as one pass)
      const listed = await git('rev-list', '--reverse', `${range.mb}..${range.head}`)
      const commits = listed?.exitCode === 0 ? listed.stdout.split('\n').map(s => s.trim()).filter(s => /^[0-9a-f]{7,64}$/.test(s)) : []
      const over = `the WHOLE unpushed range ${range.mb.slice(0, 8)}..${range.head.slice(0, 8)}${commits.length ? ` (${commits.length} commit${commits.length === 1 ? '' : 's'}${earlier ? '' : `; the oldest, ${commits[0]!.slice(0, 8)}, was never reviewed`})` : ''}`
      v.reasons.unshift(`this is a high-risk diff (${need.why}): two independent reviewer passes are required, 1 is still missing (only 1 was given), over ${over}: run one more reviewer pass separately over that same range, then pass both JSON blocks as reviews: [a, b], or the block lean_review action merge returned, unchanged (a single block, or one edited after the merge, does not count)`)
    }
  }
  // what the diff read must be believable: git answered, the range is not empty, and the base names a branch or tag (never a sha or
  // HEAD~1, which would shrink the range and with it the symbols and tests that need entries)
  if (failed) v.reasons.unshift('git could not produce the diff (an error or a timeout): nothing was checked, so no green')
  if (range.mb === range.head) v.reasons.unshift(`the range is empty (the merge base of ${base || 'the default branch'} is the head itself): base must be the branch this work goes into`)
  if (base && !ext && !(await namedRef(git, base))) v.reasons.unshift(`base ${base} is not a branch or tag name: pass the branch the work goes into (a sha or HEAD~n would shrink the range that is checked)`)
  if (light) v.reasons.unshift('this was a LIGHT review (one cheap pass at a checkpoint): it never records green. Before "ready to push" run lean_review prepare with level: "full", run the reviewer passes it asks for and record that')
  v.green = v.reasons.length === 0
  const green = wantGreen && v.green
  rec.green = green
  rec.level = light ? 'light' : 'full'
  rec.verdicts = verdicts ?? [res.verdict || 'none']
  rec.counts = {}
  for (const f of v.open) rec.counts[f.severity || 'unknown'] = (rec.counts[f.severity || 'unknown'] ?? 0) + 1
  rec.base = ext ? ext.base : base || range.base
  if (branch) rec.branch = branch
  rec.findings = v.open.map(findingLine)
  const file = await writeReview(h, rec)
  if (!ext) await putCarry(h, project, sha, { open: v.open, reuse: v.reuse, coverage: v.coverage, branch, ts: await h.clock.now(), ...(light ? { light: true } : {}) })
  const tail = [v.open.length ? `open findings:\n${v.open.map(findingLine).join('\n')}` : 'no open findings', v.checks.length ? `checks:\n${v.checks.map(c => `- ${c.what}`).join('\n')}` : '', v.notes.length ? `notes: ${v.notes.join('; ')}` : ''].filter(Boolean).join('\n')
  if (wantGreen && !v.green) return { ok: false, text: `green refused, recorded NOT green in ${file}:\n${v.reasons.map(r => `- ${r}`).join('\n')}\n${tail}` }
  return { ok: true, text: `review recorded (${green ? 'green' : 'not green'}) in ${file}${extNote}${merged ? ` (${merged})` : ''}${!green && v.reasons.length ? `\n${v.reasons.map(r => `- ${r}`).join('\n')}` : ''}\n${tail}` }
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

// `thread`: the calling thread's id (an approval of an expensive reviewer model is for that thread only)
// a refused call on someone else's ref (prepare with ref, record with mode external) is recorded like every refusal (feedback.ts)
export async function reviewTool(h: Host, project: string, i: any, thread = ''): Promise<Out> {
  const out = await reviewToolRun(h, project, i, thread)
  if (!out.ok && (str(i?.ref) || str(i?.mode) === 'external')) await logRefusal(h, { role: 'thread', rule: 'external-review-refused', text: out.text.split('\n')[0]!.slice(0, 200), tool: 'lean_review', thread: thread || undefined })
  return out
}
async function reviewToolRun(h: Host, project: string, i: any, thread = ''): Promise<Out> {
  if (!slugOk(project)) return { ok: false, text: 'lean_review needs a project name' }
  const action = str(i.action) || 'record'
  const les = await lessonsTool(h, project, i) // the learned lessons (reviewlessons.ts): lessons, learn, lessons-list/-rm/-undo/-verify
  if (les) return les
  if (action === 'prepare') return doPrepare(h, project, i, thread)
  if (action === 'merge') return doMerge(h, project, i)
  if (action === 'prs') {
    // the PR comments of a project's recent PRs (or one), from the host in its origin URL: prhost.ts, the one fetch the pr and review-learn skills share
    const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined)
    const r = await fetchPrs(h, project, { repo: await repoOf(h, project, str(i.repo) || undefined), pr: num(i.pr), last: num(i.last), base: str(i.base) })
    return { ok: r.ok, text: r.text }
  }
  if (action === 'decline') return doDecline(h, project, i)
  if (action === 'record') return doRecord(h, project, i, thread)
  return { ok: false, text: `unknown lean_review action ${action}` }
}
