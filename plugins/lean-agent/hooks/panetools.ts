// Helpers of the pane specs (1.0.33): the rendered tree as plain nodes, "every block of the pane is a card", and the unfold taps.
// Used by specs only (like fake.ts); the pane itself never imports it.
export type Node = { type: string; props?: Record<string, any>; children?: Array<Node | string> }
export const kids = (n: Node): Node[] => (n.children ?? []).filter((c): c is Node => !!c && typeof c === 'object')
export const keyOf = (n: Node): string => String(n.props?.key ?? '')
// the pane body: the outermost Box the pane draws
export const bodyOf = async (ui: any): Promise<Node> => (await ui.findAll({ type: 'Box' }))[0] as Node
// a card: a Box with the pane's one border (the same border and padding for every block)
export const isCard = (n: Node): boolean => n.type === 'Box' && n.props?.borderStyle === 'round' && n.props?.paddingX === 1
export const walk = (n: Node, f: (x: Node) => void): void => {
  f(n)
  for (const c of kids(n)) walk(c, f)
}
export const has = (n: Node, pred: (x: Node) => boolean): boolean => {
  let found = false
  walk(n, x => {
    if (pred(x)) found = true
  })
  return found
}
// (a Button's text is its label, a prop)
export const textOf = (n: Node): string => (n.type === 'Button' ? String(n.props?.label ?? '') : (n.children ?? []).map(c => (typeof c === 'string' ? c : textOf(c))).join(' '))
// every top-level child of the pane body, as the cards; `loose` names whatever is not one (a bare Text, a Button, a Box without the card border)
export const topLevel = async (ui: any): Promise<{ cards: Node[]; loose: string[] }> => {
  const body = await bodyOf(ui)
  const all = body.children ?? []
  return {
    cards: all.filter((c): c is Node => typeof c === 'object' && !!c && isCard(c)),
    loose: all.filter(c => typeof c === 'string' || !isCard(c as Node)).map(c => (typeof c === 'string' ? `text "${c}"` : `${(c as Node).type} ${keyOf(c as Node)} ${textOf(c as Node).slice(0, 40)}`.trim())),
  }
}
// the card that holds the element with this key: the INNERMOST one (1.0.35: a session card sits inside the Sessions card, so the key of a session's button names its own card, not the container)
export const cardWith = async (ui: any, key: string): Promise<Node | undefined> => {
  const top = (await topLevel(ui)).cards.find(c => has(c, x => keyOf(x) === key))
  if (!top) return undefined
  let best = top
  walk(top, x => {
    if (isCard(x) && x !== top && has(x, y => keyOf(y) === key)) best = x // (walk is depth first: the last match is the deepest)
  })
  return best
}
// a card of the pane by its own key prop, wherever it is (a session card is "t-t5", the Sessions card "toolbar", Health "health")
export const cardByKey = async (ui: any, key: string): Promise<Node | undefined> => {
  let found: Node | undefined
  walk(await bodyOf(ui), x => {
    if (!found && isCard(x) && keyOf(x) === key) found = x
  })
  return found
}
// the lines of a folded card: its direct children
export const lines = (card: Node): Node[] => kids(card)
// a tap on a foldable title unfolds it (one tap; nothing when it already is)
export const openKey = async (ui: any, key: string): Promise<void> => {
  const b = await ui.find({ type: 'Button', key })
  if (b && String(b.text).startsWith('▸')) await ui.press({ key })
}
// (1.0.35: a session card exists only while the Sessions card is unfolded, so this unfolds that first when the card's button is not there)
export const openCard = async (ui: any, id: string): Promise<void> => {
  if (!(await ui.find({ type: 'Button', key: `card-${id}` }))) await openKey(ui, 'sec-toolbar')
  await openKey(ui, `card-${id}`)
}
export const openHeader = (ui: any) => openKey(ui, 'sec-header')
export const openToolbar = (ui: any) => openKey(ui, 'sec-toolbar')
export const openHealth = (ui: any) => openKey(ui, 'sec-health')
// the Sessions card (1.0.35: the container of every session card): its title "▸ Sessions (46) · sorted by last active ↓"
export const toolbarTitle = async (ui: any): Promise<string> => String((await ui.find({ type: 'Button', key: 'sec-toolbar' }))?.text ?? '')
// the whole folded line of the Sessions card: the title and its chips ("▸ Sessions (46) · sorted by last active ↓ 2 needs you 92 unread 3 hidden")
export const toolbarLine = async (ui: any): Promise<string> => {
  const c = await cardByKey(ui, 'toolbar')
  const line = c ? kids(c).find(k => keyOf(k) === 'tb-line') : undefined
  return line ? textOf(line).replace(/\s+/g, ' ').trim() : ''
}
// the unfolded Sessions card holds the session cards: unfold it (and keep it unfolded) before pressing a session's own buttons
export const openSessions = openToolbar
