// The new-thread form: one pane (`lean-agent-new-thread`) with a title field, the registered projects (or none), model and effort
// choices, a multi-line brief and a Start button. Start runs the lean_thread tool's own `new` code (leanThread: no model is involved),
// then opens the new thread's detail pane. Mistakes are said inline, next to the button, before anything is created.
import { ensureGitHooks } from './githooks'
import { guardParents } from './doctor'
import { isExpensiveModel } from './expensive'
import { hostOf } from './host'
import { listProjects, unknownProject } from './projects'
import type { Role } from './role'
import { bounded } from './setup'
import { leanThread } from './threads'
import type { Thread } from './threads'
import { openThreadPane } from './threadpane'

export const NEW_THREAD_PANE = 'lean-agent-new-thread'
export const MODEL_CHOICES = ['sonnet', 'haiku', 'opus'] as const
export const EFFORT_CHOICES = ['high', 'medium', 'low'] as const
// The first option of model and effort leaves the field out: the tool's own default then applies (sonnet / high, or what config.json
// `threads.model` / `threads.effort` say), so the form never overrides a configured default by spelling one itself.
export const DEFAULT = '(default)'
export const NO_PROJECT = '(none)' // a Select value that no project name can have (names are letters, digits, . _ -)
export const BRIEF_ROWS = 8
const TITLE_MAX = 80
const BRIEF_MAX = 20_000

// keep: "keep session" (keep mode, threadcontext.ts), off by default; the surface has no checkbox, so it is a two-option choice
type Form = { title: string; project: string; model: string; effort: string; brief: string; reason: string; keep: boolean; errors: string[]; notice: string; busy: boolean; surface?: string }
const fresh = (surface?: string): Form => ({ title: '', project: NO_PROJECT, model: DEFAULT, effort: DEFAULT, brief: '', reason: '', keep: false, errors: [], notice: '', busy: false, ...(surface ? { surface } : {}) })
export const KEEP_OFF = 'off'
export const KEEP_ON = 'on'
// opus (any model that is not haiku or sonnet) needs the user's Approve press in the pane: Start only files the request (expensive.ts)
export const needsApproval = (model: string) => model !== DEFAULT && isExpensiveModel(model)
export const APPROVAL_NOTE = 'opus needs your approval: Start creates the thread and a request in "Needs you" on the desk pane; nothing runs on opus until you press Approve there (twice). Say why sonnet is not enough:'
let form: Form = fresh()
export const resetNewThread = () => {
  form = fresh()
}
const msg = (err: unknown, n = 160) => String((err as Error)?.message ?? err).slice(0, n)

// The first argument is the engine `$` or the thin host `hostOf($)` (both answer `ui.open`; named `$` as the engine wants).
export async function openNewThread($: any, surface: string | undefined): Promise<{ ok: boolean; text: string; pane: string }> {
  if (surface) form.surface = surface
  try {
    await $.ui.open({ id: NEW_THREAD_PANE, title: 'New thread' })
    return { ok: true, text: 'new thread form opened', pane: NEW_THREAD_PANE }
  } catch (err) {
    return { ok: false, text: `could not open the new thread form: ${msg(err)}`, pane: NEW_THREAD_PANE }
  }
}

// What is wrong with the form, in the order the fields are drawn (an unknown project is looked up by the caller)
export function validate(f: Pick<Form, 'title' | 'brief' | 'model' | 'effort'> & { reason?: string }): string[] {
  const out: string[] = []
  if (!f.title.trim()) out.push('Title is empty: give the thread a short title.')
  else if (f.title.trim().length > TITLE_MAX) out.push(`Title is too long (${f.title.trim().length} characters, at most ${TITLE_MAX}).`)
  if (!f.brief.trim()) out.push('Brief is empty: say what the thread should do.')
  else if (f.brief.length > BRIEF_MAX) out.push(`Brief is too long (${f.brief.length} characters, at most ${BRIEF_MAX}).`)
  if (f.model !== DEFAULT && !(MODEL_CHOICES as readonly string[]).includes(f.model)) out.push(`Unknown model ${f.model}.`)
  if (f.effort !== DEFAULT && !(EFFORT_CHOICES as readonly string[]).includes(f.effort)) out.push(`Unknown effort ${f.effort}.`)
  if (needsApproval(f.model) && (MODEL_CHOICES as readonly string[]).includes(f.model) && !(f.reason ?? '').trim()) out.push(`Reason is empty: ${f.model} needs your approval, say why sonnet is not enough.`)
  return out
}

export async function drawNewThread($: any, e: any, roleOf: () => Role): Promise<any> {
  const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
  const host = hostOf($)
  const tell = () => $.ui.invalidate('ui.render')
  if (roleOf().kind !== 'desk') {
    return (
      <Box flexDirection="column">
        <Text bold>New thread</Text>
        <Text>Threads are started from the desk: open this form from the desk session&apos;s pane.</Text>
      </Box>
    )
  }
  const surface = typeof e?.surface === 'string' && e.surface ? e.surface : form.surface
  let names: string[] = []
  let listError = ''
  try {
    names = (await listProjects(host)).rows.map(r => r.name)
  } catch (err) {
    listError = `could not list the projects: ${msg(err)}`
  }
  if (form.project !== NO_PROJECT && !names.includes(form.project) && !listError) form.project = NO_PROJECT // a project that is no longer listed is "none", as the Select shows
  // (the surface keeps what is typed or picked until the next draw; these handlers keep it here too, so a redraw never loses it)
  const start = async () => {
    if (form.busy) return
    const f = form
    f.notice = ''
    const project = f.project === NO_PROJECT ? '' : f.project
    const errors = validate(f)
    if (project) {
      const bad = await unknownProject(host, project).catch(err => `could not check the project: ${msg(err)}`)
      if (bad) errors.push(bad.replace(/ No thread was created\.$/, '') + ' Pick one from the list.')
    }
    f.errors = errors
    if (errors.length) return tell()
    f.busy = true
    tell()
    try {
      // the same steps as the tool's handler for `new` (register.tsx): a stale parent guide is cleared first, the git hooks refreshed after
      await guardParents(host).catch(() => [])
      const out = await bounded($, leanThread(host, $.plugin.root, { action: 'new', title: f.title.trim(), text: f.brief.trim(), ...(project ? { project } : {}), ...(f.model !== DEFAULT ? { model: f.model } : {}), ...(f.effort !== DEFAULT ? { effort: f.effort } : {}), ...(needsApproval(f.model) ? { reason: f.reason.trim() } : {}), ...(f.keep ? { keep: true } : {}) }), 'start thread', 130_000)
      await ensureGitHooks(host).catch(() => undefined)
      const id = out.ok ? (out.data as Thread | undefined)?.id : undefined
      if (!out.ok || !id) {
        f.errors = [out.ok ? 'The thread was started but its number is unknown: see the desk pane.' : out.text]
      } else {
        const opened = await openThreadPane($, surface, id)
        const text = `${out.text}${opened.ok ? '' : ` (${opened.text})`}`
        Object.assign(form, fresh(surface), { notice: text }) // an empty form again; the new thread has its own pane now
      }
    } catch (err) {
      // (after a timeout the session may still be starting: look at the desk pane before pressing Start again, or it is a second thread)
      f.errors = [`start failed: ${msg(err)}. The thread may still have been created: check the desk pane before pressing Start again.`]
    } finally {
      f.busy = false
    }
    tell()
  }
  const projectOptions = [{ value: NO_PROJECT, label: 'none' }, ...names.map(n => ({ value: n, label: n }))]
  const known = projectOptions.some(o => o.value === form.project)
  const modelOptions = [{ value: DEFAULT, label: 'default (sonnet, or threads.model in config.json)' }, ...MODEL_CHOICES.map(m => ({ value: m, label: needsApproval(m) ? `${m} (needs your Approve press)` : m }))]
  const effortOptions = [{ value: DEFAULT, label: 'default (high, or threads.effort in config.json)' }, ...EFFORT_CHOICES.map(x => ({ value: x, label: x }))]
  return (
    <Box flexDirection="column">
      <Text bold>New thread</Text>
      <Input key="title" label="Title" placeholder="short title" value={form.title} onInput={(v: string) => void (form.title = v)} onSubmit={(v: string) => void (form.title = v)} />
      {!!listError && <Text color="red">{listError}</Text>}
      <Select key="project" label={names.length ? 'Project' : 'Project (none registered: ask the desk to add one)'} options={projectOptions} value={known ? form.project : NO_PROJECT} onSelect={(v: string) => void (form.project = v)} />
      <Select key="model" label="Model" options={modelOptions} value={form.model} onSelect={(v: string) => { form.model = v; tell() }} />
      {needsApproval(form.model) && <Text color="yellow">{APPROVAL_NOTE}</Text>}
      {needsApproval(form.model) && <Input key="reason" label="Reason" placeholder="why sonnet is not enough" value={form.reason} onInput={(v: string) => void (form.reason = v)} onSubmit={(v: string) => void (form.reason = v)} />}
      <Select key="effort" label="Effort" options={effortOptions} value={form.effort} onSelect={(v: string) => void (form.effort = v)} />
      <Select key="keep" label="Keep session (after a done report, follow-ups resume it until its context passes the limit)" options={[{ value: KEEP_OFF, label: 'off (a done thread gets a new session)' }, { value: KEEP_ON, label: 'on (resume until the context limit)' }]} value={form.keep ? KEEP_ON : KEEP_OFF} onSelect={(v: string) => void (form.keep = v === KEEP_ON)} />
      <Input key="brief" label="Brief" placeholder="what the thread should do" rows={BRIEF_ROWS} value={form.brief} onInput={(v: string) => void (form.brief = v)} onSubmit={(v: string) => void (form.brief = v)} />
      {form.errors.map((m, i) => (
        <Text key={`e-${i}`} color="red">
          {m}
        </Text>
      ))}
      <Button key="start" variant="primary" label={form.busy ? 'Starting…' : 'Start'} onPress={start} />
      {!!form.notice && <Text color="green">{form.notice}</Text>}
    </Box>
  )
}
