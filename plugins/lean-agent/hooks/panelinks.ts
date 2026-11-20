// The two buttons of the desk pane that open another pane: a thread's detail pane (card button "Open") and the new-thread form
// (footer button "New thread"). Those panes are built apart (threadpane.tsx, newthread.tsx, exporting `openThreadPane(host, surface, id)`
// and `openNewThread(host, surface)`); until they are merged this module holds a stub of each that only says so, and the pane never
// breaks. To wire the real ones, replace the body of this file with:
//   export { openThreadPane } from './threadpane'
//   export { openNewThread } from './newthread'
import type { Host } from './state'

// a result the pane shows as its notice: ok false is drawn as the last error; nothing (void) is a silent success
export type Opened = { ok: boolean; text: string } | void

export async function openThreadPane(_host: Host, _surface: string | undefined, id: string): Promise<Opened> {
  return { ok: true, text: `${id}: the thread detail pane comes in this release` }
}

export async function openNewThread(_host: Host, _surface: string | undefined): Promise<Opened> {
  return { ok: true, text: 'The new-thread form comes in this release: ask the desk to start a thread' }
}
