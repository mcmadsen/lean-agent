// The Health card of the desk pane (1.0.32): what it says when folded, and how loud it is. The items themselves are drawn by pane.tsx (their buttons
// are closures of the render); this is the counting, so a spec can pin it without an engine.
// fix: something the user has to act on (a finding that needs a fix, the desk restart, a notice, a script or a request waiting, an unread message from
// a sender without a thread); standing: the user's own grants and what went out under them (information); info: everything else (information).
// blocker: something is really broken (an error line, a setup that is missing): the only case that is red; any other fix is amber; no fix: quiet.
export type HealthCounts = { fix: number; standing: number; info: number; blocker: boolean }
export type HealthLook = { label: string; tone: 'error' | 'warning' | 'quiet'; chip: string; extra: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function healthSummary(c: HealthCounts): HealthLook {
  const extra = [c.standing ? plural(c.standing, 'standing approval') : '', c.info ? plural(c.info, 'info line') : ''].filter(Boolean).join(' · ')
  if (c.fix > 0) return { label: `Health: ${plural(c.fix, 'finding')}`, tone: c.blocker ? 'error' : 'warning', chip: c.fix === 1 ? '1 fix' : `${c.fix} fixes`, extra }
  return { label: 'Health: all good', tone: 'quiet', chip: '', extra }
}

// "3 projects have stale rule areas": ONE grey info line for the count of registered projects with a stale learned rule area (1.0.35; the More card that held
// it is gone since 1.0.35). Nothing when none is stale.
export function staleAreasLine(projects: { stale?: number }[] | undefined): string {
  const n = (projects ?? []).filter(p => Number(p?.stale) > 0).length
  return n === 0 ? '' : `${n} ${n === 1 ? 'project has' : 'projects have'} stale rule areas (lean_rules check names them; learn re-learns an area)`
}
