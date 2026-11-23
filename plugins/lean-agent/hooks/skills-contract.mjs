// CONTRACT: what a skill tells a role to do must be something that role can do (run by skills-contract.test.sh, plain node).
// Skills declare where they are offered with a front-matter field `roles: desk, thread`.
//  1. every lean_* tool a skill names is registered for a role the skill is offered to; a tool that not every offered role has
//     may only be named on a line that says who uses it (`thread:` / `desk:` or `(thread only)` / `(desk only)`).
//  2. every Bash command a skill tells the DESK to run passes strict mode (deskBashOk, guard.ts). A command is the desk's when it
//     sits in a `desk:` segment of a line, or anywhere on a line headed `(desk)` / `(desk or thread)` / `(desk; ...)` outside a
//     `thread:` segment. The commands are written to skills-desk-commands.ts (node cannot load guard.ts); skills-roles.test.ts
//     runs them through deskBashOk, and this script fails when that file is stale (`node skills-contract.mjs --write` refreshes it).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = `${here}/..`
const ROLES = ['desk', 'thread']
const fails = []
const fail = m => fails.push(m)

// where each tool is registered: THREAD_TOOLS (delivery.ts) for threads; the desk's two are named in register.tsx
const toolRoles = {}
const delivery = readFileSync(`${here}/delivery.ts`, 'utf8')
const block = delivery.slice(delivery.indexOf('export const THREAD_TOOLS'), delivery.indexOf('export async function threadTool'))
for (const m of block.matchAll(/name: '(lean_[a-z_]+)'/g)) toolRoles[m[1]] = ['thread']
for (const m of readFileSync(`${here}/register.tsx`, 'utf8').matchAll(/^const (?:TOOL|DOCTOR) = '(lean_[a-z_]+)'/gm)) toolRoles[m[1]] = ['desk']
// lean_run (register.tsx `const RUN`) is a thread tool: the thread and its workers call it, the desk never
for (const m of readFileSync(`${here}/register.tsx`, 'utf8').matchAll(/^const RUN = '(lean_[a-z_]+)'/gm)) toolRoles[m[1]] = ['thread']
// lean_script is registered for the desk and for threads (register.tsx registers SCRIPT_SPEC in both role setups)
const scriptTool = /export const SCRIPT_TOOL = '(lean_[a-z_]+)'/.exec(readFileSync(`${here}/scripts.ts`, 'utf8'))?.[1]
if (scriptTool) toolRoles[scriptTool] = ['desk', 'thread']
if (Object.keys(toolRoles).length < 8) fail(`found only ${Object.keys(toolRoles).length} registered tools: the registration pattern changed`)

const SAYS_WHO = /\b(thread|desk):|\((thread|desk)( only)?\)/i
export function deskCommands(line, section = null) {
  const headed = section === 'desk' || /\(desk(?: or thread|[;,)])/i.test(line) || /\(desk only\)/i.test(line)
  const parts = line.split(/\b(thread|desk):/i)
  const out = []
  let owner = headed ? 'desk' : null
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { owner = parts[i].toLowerCase(); continue }
    if (owner !== 'desk') continue
    for (const m of parts[i].matchAll(/`([^`]+)`/g)) if (/^(gh|az|git|claude)\s/.test(m[1])) out.push(m[1])
  }
  return out
}

const commands = []
for (const name of readdirSync(`${root}/skills`).sort()) {
  const text = readFileSync(`${root}/skills/${name}/SKILL.md`, 'utf8')
  const [head, ...rest] = text.split('\n---\n')
  const roles = (/^roles:\s*(.+)$/m.exec(head)?.[1] ?? '').split(',').map(x => x.trim()).filter(Boolean)
  if (!roles.length || !roles.every(r => ROLES.includes(r))) { fail(`skill ${name}: front matter needs \`roles: desk, thread\` (desk and/or thread)`); continue }
  // a bullet that wraps onto indented lines is one logical line
  const lines = rest.join('\n---\n').split('\n').reduce((a, l) => (/^\s+\S/.test(l) && a.length ? (a[a.length - 1] += ' ' + l.trim(), a) : (a.push(l), a)), [])
  let section = null // a heading `## Desk` / `## Thread` (or `## Thread: ...`) says who every line below it is for, until the next heading
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) section = /^##\s+(desk|thread)\b/i.exec(line)?.[1].toLowerCase() ?? null // (a ### sub-heading keeps the section)
    for (const m of line.matchAll(/(?<![a-z_])(lean_[a-z_]+)/g)) {
      const has = toolRoles[m[1]]
      if (!has) fail(`skill ${name}: names ${m[1]}, which no role has`)
      else if (!has.some(r => roles.includes(r))) fail(`skill ${name} (${roles.join(', ')}): names ${m[1]}, which only ${has.join(', ')} has`)
      else if (!roles.every(r => has.includes(r)) && !SAYS_WHO.test(line) && !(section && has.includes(section))) fail(`skill ${name}: names ${m[1]} (${has.join(', ')} only) on a line that does not say who uses it (thread: / desk: / (thread only)): ${line.trim().slice(0, 80)}`)
    }
    if (roles.includes('desk')) for (const c of deskCommands(line, section)) commands.push({ skill: name, command: c })
  }
}

//  3. nothing a background thread reads (skills, templates, commands) tells it to use Claude Code's EnterWorktree tool: for a path
//     outside .claude/worktrees/ it asks a permission prompt nobody answers in a background session. A mention must be negated.
for (const dir of ['skills', 'templates', 'commands', 'agents']) {
  const files = dir === 'skills' ? readdirSync(`${root}/skills`).map(n => `skills/${n}/SKILL.md`) : readdirSync(`${root}/${dir}`).filter(n => n.endsWith('.md')).map(n => `${dir}/${n}`)
  for (const f of files) {
    const text = readFileSync(`${root}/${f}`, 'utf8').replace(/\n[ \t]+(?=\S)/g, ' ') // a wrapped bullet is one line
    // a mention must be forbidden right where it stands: "never ... EnterWorktree", "no EnterWorktree", "not the EnterWorktree tool"
    for (const line of text.split('\n')) if (/EnterWorktree/.test(line) && !/\b(never|not|no|without)\b[^.;]{0,60}EnterWorktree/i.test(line)) fail(`${f}: names EnterWorktree without forbidding it: ${line.trim().slice(0, 80)}`)
  }
}

//  4. the read-only agents open by saying "absolute paths only, never cd": their shell refuses `cd <dir> && ...`, and a reader that
//     starts with one wastes its first call (and shows up as a refusal in the feedback).
for (const n of ['reader-sonnet', 'reader-haiku', 'explorer']) {
  const text = readFileSync(`${root}/agents/${n}.md`, 'utf8').split('\n---\n').slice(1).join('\n')
  if (!/Absolute paths only, never `cd`/.test(text.slice(0, 400))) fail(`agents/${n}.md: the first lines of the body must say "Absolute paths only, never \`cd\`"`)
}

//  5. direct commands: `/lean-agent:<name> <args>` works for every flow the desk offers. Each skill offered on the desk and each commands/*.md
//     has a one-line description and an argument-hint (a command whose body takes $ARGUMENTS needs one; `list` takes none).
for (const name of readdirSync(`${root}/skills`).sort()) {
  const head = readFileSync(`${root}/skills/${name}/SKILL.md`, 'utf8').split('\n---\n')[0]
  if (!/^roles:.*\bdesk\b/m.test(head)) continue
  if (!/^description:\s*\S.+$/m.test(head)) fail(`skill ${name}: needs a one-line description (offered on the desk)`)
  if (!/^argument-hint:\s*\S.*$/m.test(head)) fail(`skill ${name}: offered on the desk, so it needs an argument-hint (\`/lean-agent:${name} <args>\` is the direct call)`)
}
for (const f of readdirSync(`${root}/commands`).filter(n => n.endsWith('.md'))) {
  const [head, ...body] = readFileSync(`${root}/commands/${f}`, 'utf8').split('\n---\n')
  if (!/^description:\s*\S.+$/m.test(head)) fail(`commands/${f}: needs a one-line description`)
  if (/\$ARGUMENTS/.test(body.join('\n')) && !/^argument-hint:\s*\S/m.test(head)) fail(`commands/${f}: takes $ARGUMENTS, so it needs an argument-hint`)
}
//  6. the review thread's brief template names the skill every review runs through
if (!/lean-agent:review/.test(readFileSync(`${root}/templates/review-brief.md`, 'utf8'))) fail('templates/review-brief.md must name lean-agent:review')

const file = `${here}/skills-desk-commands.ts`
const want = `// GENERATED by skills-contract.mjs (node hooks/skills-contract.mjs --write): the Bash commands the skills tell the desk to run.
// skills-roles.test.ts checks each one against strict mode (deskBashOk).
export const DESK_COMMANDS: [skill: string, command: string][] = ${JSON.stringify(commands.map(c => [c.skill, c.command]), null, 2)}
`
if (process.argv.includes('--write')) writeFileSync(file, want)
else if (readFileSync(file, 'utf8') !== want) fail('hooks/skills-desk-commands.ts is stale: run `node plugins/lean-agent/hooks/skills-contract.mjs --write`')
if (!commands.length) fail('no desk command found in any skill (the pr skill names some): the line convention changed')

if (fails.length) { for (const f of fails) console.log(`FAIL: ${f}`); process.exit(1) }
console.log(`ok skills-roles (${commands.length} desk commands)`)
