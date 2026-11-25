// AZURE DEVOPS TEXT RULES (1.0.35). Azure DevOps renders or ACTS ON special tokens in the markdown the mod posts (PR descriptions, PR comments and replies, work item comments) and
// in commit messages, so a thread's plain text can link or notify the wrong thing (field: a follow-up PR description said "#4271" for an earlier PR; Azure DevOps linked an unrelated,
// closed WORK ITEM 4271). One module finds the tokens by script (no model), says what Azure DevOps does with each and what the mod did (converted / warned). It is used by the PR guide
// check (prguide / prchecks: title and description before a push), by the typed action requests at REQUEST time (deskactions.ts: the findings show on the pane card, in action-list and in
// the question BEFORE the user approves), and by the commit-message lint after a `git commit -m` (register.tsx: a hint line, never a refusal). GitHub origins are never checked here.
//
// Config `ado.textRules`: warn (default: findings only, the text goes out as written) | convert (also the documented, unambiguous conversions) | off.
// Auto-conversions are only: a "#<id>" whose number is a KNOWN PR of the task -> "!<id>", and (convert) a mention the user did not write -> inside backticks. Everything else warns.
//
// WHAT MICROSOFT DOCUMENTS (checked 2026-11-25 through search excerpts of learn.microsoft.com, the pages themselves were blocked by the network proxy; where it says "not documented" the rule only warns):
//   * "#<id>" = work item, "!<id>" = pull request: "Reference work items by using #workitemID and other PRs by using !pullrequestID"
//       https://learn.microsoft.com/en-us/azure/devops/repos/git/review-pull-requests  and  https://learn.microsoft.com/en-us/azure/devops/project/wiki/markdown-guidance
//     a literal "#" (a colour code) is written "\#" to avoid the work item suggestion (markdown-guidance). "AB#<id>" is the GitHub-connection syntax: left alone.
//   * @mentions: typed "@" opens the people picker; a mention copied or typed as plain text "doesn't register as a true mention and doesn't send an email notification"
//       https://learn.microsoft.com/en-us/azure/devops/organizations/notifications/at-mentions  (the documented stored form is @<userID>): a mention is a notification, so it only warns.
//   * emoji: ":smile:" converts to an emoji graphic in PR comments and descriptions; escape it with a backslash (markdown-guidance).
//   * line breaks: "add two spaces at the end of the line before you press Enter" (markdown-guidance); a single newline joins the lines of a paragraph.
//   * HTML: "the HTML break tag works only in wikis" (markdown-guidance); other tags in PR / work item text are not documented: warn.
//   * commit hashes: Azure DevOps does NOT document auto-linking of bare 7 to 40 hex strings in PR descriptions, PR comments or work item comments (the PR and markdown pages above are silent;
//     the only documented commit linking is "#<workitem>" in a commit message). So a bare hash only WARNS ("may render as a link or stay plain text"); it is never rewritten.
//   * length: a PR description is "up to 4000 characters" (https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update). No maximum is documented for PR comments or
//     work item comments: no length check for them. The "/" attachment shortcut is not documented: not checked.
import { homeDir, leanDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { recentPrompts } from './humanprompts'

export type AdoKind = 'pr-title' | 'pr-description' | 'pr-comment' | 'workitem-comment' | 'commit'
export type AdoMode = 'warn' | 'convert' | 'off'
export type AdoFinding = { token: string; what: string; did: 'converted' | 'warned' }
export type AdoResult = { text: string; findings: AdoFinding[] }
export type AdoOpts = { kind: AdoKind; mode?: AdoMode; knownPrs?: readonly number[]; userText?: string }

export const PR_DESCRIPTION_MAX = 4000 // https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update ("Description (up to 4000 characters)")
export const isAdoUrl = (url: string): boolean => /(^|[@/.])(dev\.azure\.com|ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\b|\.visualstudio\.com\b/i.test(url)

const FILL = '\u0001'
const blank = (s: string, re: RegExp): string => s.replace(re, m => FILL.repeat(m.length))
// the text with code blocks, inline code and (optionally) URLs blanked out: same length, so an index in it is an index in the original
function masked(text: string, urls: boolean): string {
  let m = blank(text, /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*|(?![\s\S]))/gm)
  m = blank(m, /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)/g)
  if (urls) m = blank(m, /\b(?:https?|ftp):\/\/[^\s)<>\]]+/gi)
  return m
}
const uniq = <T>(a: T[]): T[] => [...new Set(a)]
const one = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function checkAdoText(text: string, o: AdoOpts): AdoResult {
  const mode = o.mode ?? 'warn'
  if (mode === 'off' || !text) return { text, findings: [] }
  const findings: AdoFinding[] = []
  const edits: { at: number; end: number; to: string }[] = []
  const add = (token: string, what: string, did: AdoFinding['did'] = 'warned') => {
    if (!findings.some(f => f.token === token)) findings.push({ token, what, did })
  }
  const known = new Set(o.knownPrs ?? [])
  const m1 = masked(text, true)
  const markdown = o.kind !== 'commit' && o.kind !== 'pr-title'

  // 1. "#<digits>": a WORK ITEM on Azure DevOps ("!<digits>" is a pull request; "AB#<digits>" and "&#123;" are left alone)
  for (const m of m1.matchAll(/(?<![\w&#\\])#(\d{1,9})(?!\w)/g)) {
    const n = Number(m[1])
    if (known.has(n)) {
      if (mode === 'convert') {
        edits.push({ at: m.index!, end: m.index! + m[0].length, to: `!${m[1]}` })
        add(`#${m[1]}`, `#${m[1]} -> !${m[1]} (PR): on Azure DevOps #${m[1]} links work item ${m[1]}, a pull request is !${m[1]}, and ${m[1]} is a known PR of this task`, 'converted')
      } else add(`#${m[1]}`, `#${m[1]} is a known PR of this task but Azure DevOps reads it as WORK ITEM ${m[1]}: write !${m[1]} (ado.textRules convert does it for you)`)
    } else add(`#${m[1]}`, o.kind === 'commit' ? `#${m[1]} is a work item on Azure DevOps (a commit message with it may link that work item on merge): keep it only if you mean the work item; a pull request is !${m[1]}` : `#${m[1]} is a work item on Azure DevOps: write !${m[1]} for a pull request, or keep # only if you mean the work item (a colour like #123456: write \\#123456)`)
  }

  // 2. "@name" / "@<GUID>": a MENTION that notifies a person (never in code, an e-mail address or a URL); only the user's own words may mention
  const mentions: string[] = []
  if (o.kind !== 'commit') {
    for (const m of m1.matchAll(/(?<![\w.@+/-])@(<[0-9a-fA-F-]{36}>|[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}|[A-Za-z][\w.-]{0,38}\w)/g)) {
      const tok = `@${m[1]}`
      if ((o.userText ?? '').toLowerCase().includes(tok.toLowerCase())) continue // the user wrote it
      mentions.push(tok)
      if (mode === 'convert') edits.push({ at: m.index!, end: m.index! + m[0].length, to: `\`${tok}\`` })
    }
    const who = uniq(mentions)
    if (who.length) add(who.join(' '), `this mentions ${who.length} ${who.length === 1 ? 'person' : 'people'} who may get a notification (${who.map(w => one(w)).join(', ')}) and the user did not write ${who.length === 1 ? 'it' : 'them'}: remove ${who.length === 1 ? 'it' : 'them'}${mode === 'convert' ? '' : ' (ado.textRules convert puts them in backticks)'}`, mode === 'convert' ? 'converted' : 'warned')
  }

  // 3. a bare commit hash (7 to 40 hex characters with a digit and a letter): not documented, so only a warning
  if (markdown) {
    for (const m of m1.matchAll(/(?<![\w/.#@-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g)) add(one(m[0], 12), `a bare commit hash: Azure DevOps does not document whether it becomes a link in PR text and work item comments, so it may render as a link or stay plain text (not changed; for plain text put it in backticks, for a link use the commit's URL)`)
  }

  if (markdown) {
    // 4. ":emoji:" shortcodes become a graphic
    for (const m of m1.matchAll(/(?<![\w:\\]):([a-z][a-z0-9_+-]{1,29}):(?![\w:])/g)) add(m[0], `${m[0]} may become an emoji graphic (documented for PR text); write \\${m[0]} to keep the text`)
    // 5. HTML tags
    const noMention = blank(m1, /@<[0-9a-fA-F-]{36}>/g)
    for (const m of noMention.matchAll(/<[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?\/?>/g)) add(one(m[0]), `an HTML tag: only <br> in a wiki is documented to work; here it may be stripped or shown as text`)
    // 6. a line starting with "#" is a heading (a description's own headings are the template: only comments are checked)
    if (o.kind !== 'pr-description') for (const m of m1.matchAll(/^[ \t]{0,3}#{1,6}[ \t]+\S[^\n]*/gm)) add(one(m[0].trim(), 24), `a line starting with "#" renders as a heading in a comment (a work item is "#<id>" with no space)`)
    // 7. a single newline joins the lines of a paragraph
    const lines = m1.split('\n')
    let joins = 0
    const plain = (l: string) => l.trim() !== '' && !l.includes(FILL) && !/^\s*([-*+]|\d+[.)])\s/.test(l) && !/^\s*(#{1,6}\s|>|\||<)/.test(l)
    for (let i = 0; i + 1 < lines.length; i++) if (plain(lines[i]!) && plain(lines[i + 1]!) && !/( {2}|\\)$/.test(lines[i]!)) joins++
    if (joins) add(`${joins} line break${joins > 1 ? 's' : ''}`, `a single newline inside a paragraph joins the lines (${joins}x): leave a blank line between them, or end the line with two spaces (documented)`)
    // 8. a link with a scheme that is not http(s) / mailto
    const noCode = masked(text, false)
    for (const m of noCode.matchAll(/\]\(\s*<?([a-zA-Z][a-zA-Z0-9+.-]*):[^)\n]*\)/g)) if (!/^(https?|mailto)$/i.test(m[1]!)) add(one(`](${m[1]}:…)`), `a link with the scheme "${m[1]}:" is not an http(s) link: it may not render as a link or may be refused`)
  }

  // 9. length: a PR description is up to 4000 characters (documented); no maximum is documented for comments
  if (o.kind === 'pr-description') {
    const n = text.length
    if (n > PR_DESCRIPTION_MAX) add(`${n} characters`, `the description is ${n} characters: Azure DevOps documents up to ${PR_DESCRIPTION_MAX}, so it is refused or cut`)
    else if (n > PR_DESCRIPTION_MAX * 0.9) add(`${n} characters`, `the description is ${n} characters, over 90% of the documented ${PR_DESCRIPTION_MAX}`)
  }

  let out = text
  for (const e of edits.sort((a, b) => b.at - a.at)) out = `${out.slice(0, e.at)}${e.to}${out.slice(e.end)}`
  return { text: out, findings }
}

export const findingLines = (fs: AdoFinding[]): string[] => fs.map(f => `${f.token}: ${f.what} [${f.did}]`)
export const findingsText = (fs: AdoFinding[]): string => (fs.length ? `Azure DevOps text check: ${findingLines(fs).join('; ')}` : '')

// ---- config and context -------------------------------------------------------------------------------------------------------------------------
export async function adoMode(h: Host): Promise<AdoMode> {
  const cfg = await readJson<{ ado?: { textRules?: unknown }; 'ado.textRules'?: unknown } | null>(h, `${leanDir(await homeDir(h))}/config.json`, null).catch(() => null)
  const v = cfg?.ado?.textRules ?? cfg?.['ado.textRules']
  return v === 'convert' || v === 'off' || v === 'warn' ? v : 'warn'
}
// the PRs the mod KNOWS for this task: the thread's own (thread.json pr), every PR of workitems.json, the PR numbers in its stored work item map
export async function knownPrsOf(h: Host, thread: string): Promise<number[]> {
  const home = await homeDir(h)
  const out = new Set<number>()
  const n = (v: unknown) => {
    const x = Number(v)
    if (Number.isInteger(x) && x > 0) out.add(x)
  }
  const t = thread ? await readJson<{ pr?: { number?: unknown; id?: unknown } } | null>(h, `${threadsDir(home)}/${thread}/thread.json`, null).catch(() => null) : null
  n(t?.pr?.number)
  n(t?.pr?.id)
  const m = await readJson<{ pr?: Record<string, unknown> } | null>(h, `${leanDir(home)}/workitems.json`, null).catch(() => null)
  for (const k of Object.keys(m?.pr ?? {})) n(k)
  const push = await h.store.get(`push.pr.${thread}`).catch(() => null)
  n((push as { number?: unknown } | null)?.number)
  return [...out]
}
// the user's own recent words: a mention in them is deliberate
export async function userWords(h: Host): Promise<string> {
  return (await recentPrompts(h).catch(() => [])).map(p => p.text).join('\n')
}
export async function adoContext(h: Host, thread: string): Promise<{ mode: AdoMode; knownPrs: number[]; userText: string }> {
  const mode = await adoMode(h)
  return mode === 'off' ? { mode, knownPrs: [], userText: '' } : { mode, knownPrs: await knownPrsOf(h, thread), userText: await userWords(h) }
}

// ---- the text of one typed action request (deskactions.ts addActionRequest, before the request is signed) -------------------------------------------
const TEXT_FIELDS: Record<string, { field: string; kind: AdoKind }[]> = {
  'ado-pr-reply': [{ field: 'body', kind: 'pr-comment' }],
  'ado-pr-comment': [{ field: 'body', kind: 'pr-comment' }],
  'ado-workitem-comment': [{ field: 'body', kind: 'workitem-comment' }],
  'ado-pr-update': [{ field: 'title', kind: 'pr-title' }, { field: 'description', kind: 'pr-description' }],
}
// params with the converted text (convert mode only changes anything) and the findings; a batch is walked item by item. Never throws.
export async function checkActionText(h: Host, thread: string, kind: string, params: unknown): Promise<{ params: unknown; findings: AdoFinding[] }> {
  try {
    if (!params || typeof params !== 'object') return { params, findings: [] }
    const ctx = await adoContext(h, thread)
    if (ctx.mode === 'off') return { params, findings: [] }
    const findings: AdoFinding[] = []
    const walk = (k: string, p: Record<string, unknown>): Record<string, unknown> => {
      const fields = TEXT_FIELDS[k]
      if (!fields) return p
      const next = { ...p }
      for (const f of fields) {
        const v = p[f.field]
        if (typeof v !== 'string' || !v) continue
        const r = checkAdoText(v, { kind: f.kind, mode: ctx.mode, knownPrs: ctx.knownPrs, userText: ctx.userText })
        next[f.field] = r.text
        for (const x of r.findings) if (!findings.some(y => y.token === x.token)) findings.push(x)
      }
      return next
    }
    if (kind === 'batch') {
      const p = params as { items?: unknown }
      if (!Array.isArray(p.items)) return { params, findings: [] }
      const items = p.items.map(it => (it && typeof it === 'object' && typeof (it as { kind?: unknown }).kind === 'string' && (it as { params?: unknown }).params && typeof (it as { params?: unknown }).params === 'object' ? { ...(it as object), params: walk((it as { kind: string }).kind, (it as { params: Record<string, unknown> }).params) } : it))
      return { params: { ...p, items }, findings }
    }
    return { params: walk(kind, params as Record<string, unknown>), findings }
  } catch {
    return { params, findings: [] }
  }
}

// ---- a PR title and description before a push (prchecks.ts) -------------------------------------------------------------------------------------
export async function checkPrText(h: Host, thread: string, o: { title: string; body: string }): Promise<{ title: string; body: string; findings: AdoFinding[] }> {
  try {
    const ctx = await adoContext(h, thread)
    if (ctx.mode === 'off') return { ...o, findings: [] }
    const t = checkAdoText(o.title, { kind: 'pr-title', ...ctx })
    const b = checkAdoText(o.body, { kind: 'pr-description', ...ctx })
    return { title: t.text, body: b.text, findings: [...t.findings, ...b.findings.filter(f => !t.findings.some(x => x.token === f.token))] }
  } catch {
    return { ...o, findings: [] }
  }
}

// ---- a commit message (register.tsx, after a `git commit -m "..."` ran in a thread) -----------------------------------------------------------------
// the messages of -m / --message arguments of a git commit command, in order (quotes removed); '' when the command is no commit with a message
export function commitMessages(cmd: string): string[] {
  if (!/\bgit\b[^|;&\n]*\bcommit\b/.test(cmd)) return []
  const out: string[] = []
  for (const m of cmd.matchAll(/(?:^|\s)(?:-m|--message)(?:=|\s+)?(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g)) out.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(["\\$`])/g, '$1'))
  return out
}
// one hint line (never a refusal) when the command is a commit with "#<id>" in its message in a repo whose origin is Azure DevOps; '' otherwise
export async function commitHint(h: Host, thread: string, cmd: string, cwd: string): Promise<string> {
  try {
    const msgs = commitMessages(cmd)
    if (!msgs.length || !/#\d/.test(msgs.join('\n'))) return ''
    const mode = await adoMode(h)
    if (mode === 'off') return ''
    const dir = cwd.startsWith('/') ? cwd : ''
    if (!dir) return ''
    const r = await h.process.run(['git', '-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 }).catch(() => null)
    if (!r || r.exitCode !== 0 || !isAdoUrl(r.stdout.trim())) return ''
    const known = await knownPrsOf(h, thread)
    const fs = checkAdoText(msgs.join('\n'), { kind: 'commit', mode: 'warn', knownPrs: known }).findings
    return fs.length ? `[lean-agent] Azure DevOps: PR is !<id>, work item is #<id>. In this commit message: ${findingLines(fs).join('; ')}. Nothing was refused; amend only if you did not mean a work item.` : ''
  } catch {
    return ''
  }
}

// the guide line for threads and the pr skill (one place, specs pin it)
export const ADO_GUIDE_LINE = 'Azure DevOps: a PR is !<id>, a work item is #<id> (GitHub uses #<id> for both); an @name mentions a person, a bare commit hash may or may not link: write them only when the user asked.'
