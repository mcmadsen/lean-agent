#!/usr/bin/env node
// The settings table of the README, generated from the ONE registry (plugins/lean-agent/hooks/configkeys.ts).
//   node scripts/config-table.mjs           print the table
//   node scripts/config-table.mjs --write   put it between the config-table markers of README.md (or of the file given after --write)
//   node scripts/config-table.mjs --check   fail when the hooks read a config key the registry lacks, an entry has no description, or the README
//                                           table differs from the registry (run by plugins/lean-agent/hooks/skills-contract.test.sh)
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hooks = join(here, '..', 'plugins', 'lean-agent', 'hooks')
const readme = join(here, '..', 'README.md')

// the registry is a .ts file without imports: Node strips the types itself
if (!process.env.CONFIG_TABLE_CHILD) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, CONFIG_TABLE_CHILD: '1' } })
  process.exit(r.status ?? 1)
}
const { REGISTRY, GROUPS } = await import(pathToFileURL(join(hooks, 'configkeys.ts')).href)

const cell = s => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ')
const typeOf = e => (e.type === 'enum' ? e.values.join(' / ') : e.type === 'list' && e.special ? `list or ${e.special.join(' / ')}` : e.type === 'number' ? `number${e.min !== undefined ? ` >= ${e.min}` : ''}${e.max !== undefined ? ` <= ${e.max}` : ''}${e.zero ? ' (0 = off)' : ''}` : e.type)
const dflt = e => (e.default === null ? 'none' : typeof e.default === 'string' ? e.default : JSON.stringify(e.default))
const appliesOf = e => (e.applies === 'now' ? 'now' : e.applies === 'next-session' ? 'next session' : 'desk restart')

export function table() {
  const rows = ['| Setting | Group | Type | Default | Applies | What it does |', '| --- | --- | --- | --- | --- | --- |']
  for (const g of GROUPS) {
    for (const e of REGISTRY.filter(x => x.group === g)) {
      rows.push(`| \`${e.key}\`${e.sensitive ? ' (sensitive)' : ''} | ${e.group} | ${cell(typeOf(e))} | ${cell(dflt(e))} | ${appliesOf(e)} | ${cell(e.description)} |`)
    }
  }
  return rows.join('\n')
}

// --write [file]: put the table between the markers of README.md (or of the file named)
const w = process.argv.indexOf('--write')
if (w >= 0) {
  const file = process.argv[w + 1] && !process.argv[w + 1].startsWith('--') ? process.argv[w + 1] : readme
  const cur = readFileSync(file, 'utf8')
  const re = /(<!-- config-table:start -->\n)[\s\S]*?<!-- config-table:end -->/
  if (!re.test(cur)) {
    console.error(`${file}: no <!-- config-table:start --> ... <!-- config-table:end --> markers`)
    process.exit(1)
  }
  writeFileSync(file, cur.replace(re, (_, a) => `${a}${table()}\n<!-- config-table:end -->`))
  console.log(`${file}: table written (${REGISTRY.length} keys)`)
  process.exit(0)
}
if (!process.argv.includes('--check')) {
  console.log(table())
  process.exit(0)
}

const problems = []
const keys = new Set()
const segs = new Set()
for (const e of REGISTRY) {
  if (keys.has(e.key)) problems.push(`${e.key}: listed twice`)
  keys.add(e.key)
  for (const s of [e.key, ...(e.aliases ?? [])]) for (const p of s.split('.')) segs.add(p)
  if (typeof e.description !== 'string' || !e.description.trim()) problems.push(`${e.key}: no description`)
  else if (/\n/.test(e.description) || e.description.length > 200) problems.push(`${e.key}: the description must be ONE line of at most 200 characters`)
  if (!GROUPS.includes(e.group)) problems.push(`${e.key}: unknown group ${e.group}`)
  if (!['now', 'next-session', 'desk-restart'].includes(e.applies)) problems.push(`${e.key}: applies must be now, next-session or desk-restart`)
  if (e.type === 'enum' && !(e.values?.length)) problems.push(`${e.key}: an enum needs values`)
}

// the sources that read the file: a code line (not a comment) with readConfig( or readJson(... /config.json)
const strip = t => t.split('\n').map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
const files = readdirSync(hooks).filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
const text = {}
const readers = []
for (const f of files) {
  const raw = readFileSync(join(hooks, f), 'utf8')
  text[f] = raw
  const lines = strip(raw)
  let reads = false
  lines.forEach((l, i) => {
    if (!/readConfig\(|readJson[^\n]*\/config\.json/.test(l)) return
    reads = true
    // the keys the line declares (readJson<{ threads?: { autoRestart?: unknown } }>) and `pick(cfg, 'a.b')` literals
    for (const w of lines.slice(i, i + 3).join(' ').matchAll(/\b(\w+)\?:/g)) if (!segs.has(w[1]) && !/^(unknown|string|number|boolean)$/.test(w[1])) problems.push(`${f}: reads config key part "${w[1]}" that the registry does not know (hooks/configkeys.ts)`)
  })
  for (const m of lines.join('\n').matchAll(/\bpick\(\w+, '([\w.]+)'\)/g)) if (reads && ![...keys].some(k => k === m[1] || k.startsWith(`${m[1]}.`) || k === `threads.${m[1]}`)) problems.push(`${f}: reads config key ${m[1]} that the registry does not know (hooks/configkeys.ts)`)
  if (reads) readers.push(f)
}
const srcOf = e => (Array.isArray(e.src) ? e.src : [e.src])
const named = new Set(REGISTRY.flatMap(srcOf))
for (const f of readers) if (!named.has(f)) problems.push(`${f}: reads config.json but no registry entry names it as a source: add its keys to hooks/configkeys.ts`)
for (const e of REGISTRY) {
  const parts = e.key.split('.')
  for (const f of srcOf(e)) {
    if (!text[f] && !(f.endsWith('.ts') || f.endsWith('.tsx'))) problems.push(`${e.key}: src ${f} is not a hooks source`)
    else if (!text[f]) problems.push(`${e.key}: src ${f} does not exist in hooks/`)
    else if (!text[f].includes(parts[0]) || !text[f].includes(parts[parts.length - 1])) problems.push(`${e.key}: ${f} never mentions "${parts[0]}" / "${parts[parts.length - 1]}": wrong src, or the key is not read there any more`)
  }
}

// the README: the table between the markers is exactly the generated one
const doc = readFileSync(readme, 'utf8')
const m = /<!-- config-table:start -->\n([\s\S]*?)\n<!-- config-table:end -->/.exec(doc)
if (!m) problems.push('README.md has no <!-- config-table:start --> ... <!-- config-table:end --> block (Settings (lean_config))')
else if (m[1].trim() !== table().trim()) {
  const have = new Set([...m[1].matchAll(/^\| `([^`]+)`/gm)].map(x => x[1]))
  const miss = [...keys].filter(k => !have.has(k))
  const extra = [...have].filter(k => !keys.has(k))
  problems.push(`README.md settings table differs from the registry${miss.length ? `; missing: ${miss.join(', ')}` : ''}${extra.length ? `; not in the registry: ${extra.join(', ')}` : ''}; regenerate: node scripts/config-table.mjs`)
}

if (problems.length) {
  console.error(`config registry: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`config registry ok: ${REGISTRY.length} keys, ${readers.length} reader files, README table matches`)
