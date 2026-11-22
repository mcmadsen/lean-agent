// `lean_thread dismiss` (and the pane's two-press Dismiss on a card): the user acknowledged an item. The store is dismissstore.ts (a row in the
// thread's or the desk's history.jsonl); the view hides THAT item until a newer one of its kind arrives. The record behind it (inbox report,
// question, notice file) stays, and a dismissed question is NOT answered: the thread is told nothing.
//   dismiss tN                 the thread's current Needs-you item (the first, when it has several)
//   dismiss tN kind:<kind>     that kind of item: question | prompt | approval | blocked | stalled | restart | ready | model | action
//   dismiss notice <id|all>    a line at the top of the pane (a notice's id is its file name; `all` hides every shown one)
import type { Host } from './state'
import { homeDir } from './state'
import { DKINDS, dismissedKeys, dismissedTs, dkey, recordDismiss } from './dismissstore'
import type { DItem, DKind } from './dismissstore'
import { loadView } from './view'
export { dismissedTs }

type Out = { ok: boolean; text: string }
const NAMES: Record<string, string> = { question: 'question', prompt: 'prompt wait', approval: 'approval request', blocked: 'blocked report', stalled: 'stall', restart: 'failed restart', ready: 'done report', model: 'model request', action: 'write request', script: 'script', context: 'desk context warning', deskmodel: 'desk model warning', olddesk: 'old-desk reminder', notice: 'notice' }
const say = (what: string, kind: string) => `${what}. A newer ${NAMES[kind] ?? kind} will show again; the record behind it stays and nobody was told.`

export async function dismissAction(h: Host, i: { tN?: string; kind?: string; notice?: string }): Promise<Out> {
  const home = await homeDir(h)
  const v = await loadView(h)
  // (the Needs-you cards, plus the notices of the top lines, as one list of items)
  const items = [...v.needs, ...v.dismissed].map(n => ({ dk: n.dk!, text: n.text })).filter(x => x.dk)
  const notices = [...v.notices, ...v.dismissedNotices].map(n => ({ dk: n.dk, text: n.text, key: n.key }))
  const gone = await dismissedKeys(h, home, ['desk', ...items.map(x => x.dk.thread), ...notices.map(x => x.dk.thread)])
  const hide = async (x: { dk: DItem; text: string }) => {
    await recordDismiss(h, home, x.dk, x.text)
    return `hid the ${NAMES[x.dk.kind] ?? x.dk.kind}: ${x.text.replace(/\s+/g, ' ').slice(0, 80)}`
  }
  if (i.notice !== undefined) {
    const want = String(i.notice).trim()
    if (!want) return { ok: false, text: 'dismiss notice needs an id (the notice\'s file name) or all' }
    const shown = notices.filter(n => !gone.has(dkey(n.dk)))
    const pick = want === 'all' ? shown : shown.filter(n => n.key === want)
    if (!pick.length) return { ok: true, text: want === 'all' ? 'no notice is shown' : `notice ${want}: not shown (unknown id, or already dismissed)` }
    const done: string[] = []
    for (const n of pick) done.push(await hide(n))
    return { ok: true, text: `${say(done.join('; '), 'notice')}` }
  }
  const id = i.tN ?? ''
  if (!/^t\d+$/.test(id)) return { ok: false, text: 'dismiss needs tN (like t3), tN kind:<kind>, or notice <id|all>' }
  const kind = i.kind?.trim().replace(/^kind:/, '')
  if (kind && !(DKINDS as readonly string[]).includes(kind)) return { ok: false, text: `dismiss: kind must be one of ${DKINDS.join(', ')}` }
  const mine = [...items, ...notices].filter(x => x.dk.thread === id && (!kind || x.dk.kind === (kind as DKind)))
  if (!mine.length) return { ok: true, text: kind ? `${id}: nothing to dismiss (no ${NAMES[kind] ?? kind} for it)` : `${id}: nothing to dismiss (it has nothing in Needs you)` }
  const open = mine.filter(x => !gone.has(dkey(x.dk)))
  if (!open.length) return { ok: true, text: `${id}: that ${NAMES[mine[0]!.dk.kind] ?? mine[0]!.dk.kind} was already dismissed` }
  const msg = await hide(open[0]!)
  const more = open.length > 1 ? ` (${open.length - 1} more of ${id} still shown: ${[...new Set(open.slice(1).map(x => x.dk.kind))].join(', ')})` : ''
  return { ok: true, text: `${id}: ${say(msg, open[0]!.dk.kind)}${more}` }
}
