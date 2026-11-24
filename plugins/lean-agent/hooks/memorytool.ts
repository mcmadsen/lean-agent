// The tools over the memory store (memory.ts): the desk's `lean_memory` (add, list, get, find, retire, edit, confirm, prune) and the thread's
// `lean_remember` (extended with scope / kind / trigger / output). Both only forward to the store; the scripts there decide.
import { readJson, leanDir, threadsDir } from './state'
import type { Host } from './state'
import { addItem, confirmItem, editItem, findItems, getItem, listItems, pruneSuggestions, retireItem, TEXT_MAX } from './memory'
import type { Ctx, Source } from './memory'

export const MEMORY_SPEC = {
  name: 'lean_memory',
  description: `The user's memory (the remember skill): add (text <=${TEXT_MAX} chars, never secrets; scope when asked: global | desk | project:<name> | thread:<tN> | task:<id>; kind; trigger after-commit | after-step | before-push | on-pr-open; output path), list [scope], get id, find words, retire id, edit id text, confirm id (a candidate), prune (suggests only).`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'get', 'find', 'retire', 'edit', 'confirm', 'prune'] },
      text: { type: 'string', description: 'add, edit: the text; find: words' },
      id: { type: 'string', description: 'get, retire, edit, confirm: like m4' },
      scope: { type: 'string', description: 'add, list' },
      kind: { type: 'string', enum: ['rule', 'fact', 'decision', 'preference', 'correction'] },
      trigger: { type: 'string' },
      output: { type: 'string', description: 'add: the path to update at the trigger' },
    },
    required: ['action'],
  },
}

export async function deskCtx(h: Host, home: string): Promise<Ctx> {
  const p = await readJson<Record<string, unknown>>(h, `${leanDir(home)}/projects.json`, {})
  return { role: 'desk', projects: Object.keys(p && typeof p === 'object' ? p : {}) }
}
// fix441 (work item / PR on a thread) names the thread's tasks in thread.json: `tasks: [..]` or `task: ".."`
export async function threadCtx(h: Host, home: string, id: string): Promise<Ctx> {
  const t = await readJson<{ project?: unknown; task?: unknown; tasks?: unknown }>(h, `${threadsDir(home)}/${id}/thread.json`, {})
  const tasks = [...(Array.isArray(t?.tasks) ? t.tasks : []), ...(t?.task !== undefined ? [t.task] : [])].map(x => String(x)).filter(x => /^[A-Za-z0-9._#:-]{1,60}$/.test(x))
  return { role: 'thread', id, ...(typeof t?.project === 'string' && t.project ? { project: t.project } : {}), tasks }
}

type In = { action?: string; text?: string; id?: string; scope?: string; kind?: string; trigger?: string; output?: string }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export async function memoryTool(h: Host, home: string, i: In, ctx?: Ctx): Promise<{ ok: boolean; text: string }> {
  const c = ctx ?? (await deskCtx(h, home))
  const action = str(i.action)
  if (action === 'add') {
    const o = await addItem(h, home, { text: str(i.text), scope: str(i.scope) || undefined, kind: str(i.kind) || undefined, trigger: str(i.trigger) || undefined, output: str(i.output) || undefined, source: 'desk' }, c)
    return { ok: o.ok, text: o.text }
  }
  if (action === 'list') return { ok: true, text: await listItems(h, home, str(i.scope), c) }
  if (action === 'get') return { ok: true, text: await getItem(h, home, str(i.id), c) }
  if (action === 'find') return { ok: true, text: await findItems(h, home, str(i.text), c) }
  if (action === 'retire') {
    const o = await retireItem(h, home, str(i.id), c)
    return { ok: o.ok, text: o.text }
  }
  if (action === 'edit') {
    const o = await editItem(h, home, str(i.id), str(i.text), c)
    return { ok: o.ok, text: o.text }
  }
  if (action === 'confirm') {
    const o = await confirmItem(h, home, str(i.id))
    return { ok: o.ok, text: o.text }
  }
  if (action === 'prune') return { ok: true, text: await pruneSuggestions(h, home) }
  return { ok: false, text: 'lean_memory: action must be add, list, get, find, retire, edit, confirm or prune' }
}

// a thread's lean_remember: for itself (default), its project or a task; the legacy `project` field means scope project:<name>
export async function rememberTool(h: Host, home: string, id: string, i: In & { project?: string }): Promise<{ ok: boolean; text: string }> {
  const ctx = await threadCtx(h, home, id)
  const scope = str(i.scope) || (str(i.project) ? `project:${str(i.project)}` : undefined)
  const o = await addItem(h, home, { text: str(i.text), scope, kind: str(i.kind) || undefined, trigger: str(i.trigger) || undefined, output: str(i.output) || undefined, source: 'thread' as Source }, ctx)
  return { ok: o.ok, text: o.text }
}

// `lean_run {pull: "memory", section: "<words>"}`: no words = one line per item the thread can see (index and the rest); words = the full text of what matches
export async function memoryPull(h: Host, home: string, id: string, section: string): Promise<string> {
  const ctx = await threadCtx(h, home, id)
  if (section.trim()) return findItems(h, home, section, ctx)
  return listItems(h, home, '', ctx)
}
