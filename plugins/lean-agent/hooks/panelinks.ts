// The two buttons of the desk pane that open another pane: a thread's detail pane (card button "Open") and the new-thread form
// (footer button "New thread"). The panes themselves are built in threadpane.tsx and newthread.tsx; the first argument of both openers
// is the engine `$` of the render handler that pressed the button (they spell `$.ui.open(...)` as the engine's validator wants).
export { openThreadPane } from './threadpane'
export { openNewThread } from './newthread'
