// `lean_doctor overhead probe [tN]` (1.0.20): where does a thread's base go on THIS machine? A handful of one-word `claude -p` calls (haiku,
// prompt first, flags after) in a thread-shaped folder (the thread's own folder when tN is given, else a throw-away one), each switching ONE
// thing off, and a table of base tokens (input + cache read + cache creation of the first request). It costs a few cents (haiku, one turn each).
// It names the biggest component and the config line that removes it. No claude: say so, nothing runs.
import { dropDir, parseRun, tempThread } from './compare'
import { installedPlugins, OWN_SERVER } from './profile'
import { homeDir, readJson, threadsDir } from './state'
import type { Host } from './state'
import { threadToolsArgv } from './orchestrate'
import { readLeanThreadCfg } from './threadlean'

export const PROBE_PROMPT = 'Reply with the single word ok.'
export type Variant = { key: 'today' | 'mcp' | 'skills' | 'plugins' | 'allplugins' | 'claudemd' | 'floor'; label: string; args: string[] }
export type Measured = Variant & { tokens: number | null; cost: number; note?: string }

const settings = (o: unknown) => ['--settings', JSON.stringify(o)]
const MCP_OFF = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']

// `others`: every installed plugin but lean-agent; `lean`: the thread already runs without them (the lean default), so the cost of the user's plugins is
// measured the other way round (all of them switched on)
export function variants(o: { tools: string[]; others: string[]; home: string; lean: boolean }): Variant[] {
  const off = (v: boolean) => settings({ enabledPlugins: Object.fromEntries(o.others.map(k => [k, v])) })
  const md = settings({ claudeMdExcludes: [`${o.home}/.claude/CLAUDE.md`, `${o.home}/.claude/rules/**`] })
  const merged = settings({ enabledPlugins: Object.fromEntries(o.others.map(k => [k, false])), claudeMdExcludes: [`${o.home}/.claude/CLAUDE.md`, `${o.home}/.claude/rules/**`] })
  return [
    { key: 'today', label: 'as a thread starts today', args: [...o.tools] },
    { key: 'mcp', label: 'without MCP servers (--strict-mcp-config)', args: [...o.tools, ...MCP_OFF] },
    { key: 'skills', label: 'without skills (--disable-slash-commands)', args: [...o.tools, '--disable-slash-commands'] },
    { key: 'plugins', label: 'without other plugins (enabledPlugins)', args: [...o.tools, ...off(false)] },
    ...(o.lean && o.others.length ? [{ key: 'allplugins' as const, label: 'with all your plugins (threads.plugins "all")', args: [...o.tools, ...off(true)] }] : []),
    { key: 'claudemd', label: 'without user CLAUDE.md and rules (claudeMdExcludes)', args: [...o.tools, ...md] },
    { key: 'floor', label: 'all of the above off: the tool list alone', args: [...o.tools, ...MCP_OFF, '--disable-slash-commands', ...merged] },
  ]
}

const k = (n: number | null) => (n === null ? 'n/a' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// the report: the table, the biggest component, the config line that removes it
export function probeText(rows: Measured[], o: { lean: boolean; thread?: string }): string {
  const t = (key: string) => rows.find(r => r.key === key)
  const today = t('today')?.tokens ?? null
  const cost = rows.reduce((n, r) => n + r.cost, 0)
  const out = [`overhead probe${o.thread ? ` (${o.thread}'s folder)` : ''}: the base of a thread session by component, haiku, one word each; ${rows.length} calls, about $${cost.toFixed(2)} in all (a few cents: it is a real model call)`]
  const w = Math.max(...rows.map(r => r.label.length))
  for (const r of rows) out.push(`  ${r.label.padEnd(w)}  ${k(r.tokens).padStart(7)}${today !== null && r.tokens !== null && r.key !== 'today' && r.key !== 'allplugins' ? `  (${r.tokens <= today ? '-' : '+'}${k(Math.abs(today - r.tokens))})` : ''}${r.note ? `  ${r.note}` : ''}`)
  if (today === null) return [...out, 'the first run gave no usage: nothing to compare (is `claude -p` logged in?)'].join('\n')
  const part = (key: string, what: string, line: string) => {
    const a = t(key)?.tokens
    const d = key === 'allplugins' ? (a == null ? null : a - today) : a == null ? null : today - a
    return d !== null && d > 0 ? { what, d, line } : null
  }
  const comps = [
    part('mcp', 'MCP servers and connectors', 'config threads.mcp: "none" (all deferred, found again through ToolSearch) or "project"'),
    part('skills', 'the skills listing', 'config threads.skills: "lean" (default: lean-agent\'s skills only); a user-level skill folder you do not need: move it out of ~/.claude/skills'),
    part(o.lean ? 'allplugins' : 'plugins', 'other plugins (their skills, agents, hooks text)', 'config threads.plugins: [] (default: lean-agent only); today it lists more or is "all"'),
    part('claudemd', 'your user CLAUDE.md and rules', 'trim ~/.claude/CLAUDE.md and ~/.claude/rules (no thread switch: they are yours)'),
  ].filter((x): x is { what: string; d: number; line: string } => !!x).sort((a, b) => b.d - a.d)
  const floor = t('floor')?.tokens
  if (!comps.length || comps[0]!.d < 500) out.push(`biggest component: none over 500 tokens; today's base of ${k(today)} is the tool list and the engine's system prompt${floor != null ? ` (everything off: ${k(floor)})` : ''}; threads.tools cuts the tool list`)
  else out.push(`biggest component: ${comps[0]!.what}, about ${k(comps[0]!.d)} of ${k(today)} · remove it: ${comps[0]!.line}`)
  if (comps.length > 1) out.push(`then: ${comps.slice(1).map(c => `${c.what} ${k(c.d)}`).join(', ')}`)
  return out.join('\n')
}

// run the probe; `session` is "probe" or "probe tN"
export async function overheadProbe(h: Host, root: string, session: string): Promise<string> {
  const m = /^probe(?:\s+(t\d+))?\s*$/.exec(session.trim())
  if (!m) return 'overhead probe [tN]: usage: lean_doctor overhead with session "probe" or "probe tN"'
  const home = await homeDir(h)
  const cwdOf = m[1] ? `${threadsDir(home)}/${m[1]}` : ''
  let temp = ''
  try {
    let cwd = cwdOf
    let lean = (await readLeanThreadCfg(h, home)).plugins !== 'all'
    if (cwd) {
      if (!(await h.fs.exists(`${cwd}/thread.json`).catch(() => false))) return `overhead probe: no thread ${m[1]}`
      const st = await readJson<{ enabledPlugins?: Record<string, unknown> } | null>(h, `${cwd}/.claude/settings.json`, null)
      lean = !!st?.enabledPlugins && Object.values(st.enabledPlugins).some(v => v === false)
    } else {
      const tmp = await tempThread(h, root, home, '')
      temp = tmp.dir
      cwd = tmp.dir
    }
    const others = (await installedPlugins(h).catch(() => [])).filter(p => p.name !== OWN_SERVER).map(p => p.key)
    const tools = await threadToolsArgv(h)
    const rows: Measured[] = []
    for (const v of variants({ tools, others, home, lean })) {
      try {
        const r = await h.process.run(['claude', '-p', PROBE_PROMPT, '--model', 'haiku', '--output-format', 'json', '--max-turns', '1', '--max-budget-usd', '0.25', ...v.args], { cwd, timeoutMs: 120_000 })
        const run = parseRun(r.stdout)
        rows.push({ ...v, tokens: run && run.input > 0 ? run.input : null, cost: run?.cost ?? 0, ...(run?.error ? { note: 'error' } : {}) })
      } catch (e) {
        rows.push({ ...v, tokens: null, cost: 0, note: String((e as Error)?.message ?? e).slice(0, 60) })
      }
    }
    return probeText(rows, { lean, thread: m[1] })
  } catch (e) {
    return `overhead probe failed: ${String((e as Error)?.message ?? e)}`
  } finally {
    if (temp) await dropDir(h, temp)
  }
}
