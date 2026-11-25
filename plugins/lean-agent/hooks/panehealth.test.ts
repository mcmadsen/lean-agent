// The Health card's counting lines (panehealth.ts).
import { expect, test } from 'claude-code/testing'
import { staleAreasLine } from './panehealth'

test('staleAreasLine: the count of projects with a stale rule area, singular for one, nothing for none or no data', () => {
  expect(staleAreasLine(undefined)).toBe('')
  expect(staleAreasLine([])).toBe('')
  expect(staleAreasLine([{ stale: 0 }, {}])).toBe('')
  expect(staleAreasLine([{ stale: 3 }, { stale: 0 }])).toBe('1 project has stale rule areas (lean_rules check names them; learn re-learns an area)') // projects, not areas
  expect(staleAreasLine([{ stale: 1 }, { stale: 2 }, { stale: 0 }, { stale: 1 }])).toBe('3 projects have stale rule areas (lean_rules check names them; learn re-learns an area)')
})
