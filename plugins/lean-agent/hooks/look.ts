// An optional look for the app (1.0.30). OFF unless the user's config says `pane.theme: on` (~/.lean-agent/config.json): lean-agent never
// overrides the user's own look unasked. When it is on, the look (a calm palette, one accent, light and dark) is sent ONCE at session.start with
// `$.theme.set`; a theme is display only (a resumed session brings none back), so every session start sets it again, never more often.
// `$.theme.clear` runs only when the config went from on to off (this file's own record says the mod had set the look): there is one theme
// per session, so a clear would wipe any other plugin's, and the mod never clears for any other reason.
// The colors come from makeColors (make-colors.js, copied unchanged from the plugin-authoring skill): a wrong color name paints nothing and
// says nothing, so none is written by hand.
import type { ThemeSetArgs } from 'claude-code'
import { makeColors } from './make-colors.js'
import { hostOf } from './host'
import { homeDir, leanDir, readJson, writeJson } from './state'
import type { Host } from './state'

// Calm and quiet: cool grays tinted toward one teal accent; danger, success and warning keep their meaning (red, green, amber).
const made = makeColors({
  label: 'lean-agent calm',
  roles: { accent: '#2f7f86', danger: '#b3392f', success: '#3f7d4e', warning: '#a86f14', pro: '#6d4f94' },
  light: {
    gray: {
      anchors: {
        'surface-0': '#eef1f3',
        'surface-1': '#f4f6f7',
        'surface-2': '#fafbfb',
        'text-primary': '#1d2529',
        'text-secondary': '#444f55',
        'text-muted': '#5a666c',
      },
    },
  },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#14181b',
        'surface-1': '#1a1f23',
        'surface-2': '#21272b',
        'surface-3': '#262d32',
        'text-primary': '#e6ebee',
        'text-secondary': '#bcc6cc',
        'text-muted': '#97a3aa',
      },
    },
  },
})

export const LOOK: ThemeSetArgs = { colors: made.theme }
// the lines that would make Desktop ignore the whole theme (the other lines are under the design system's own bar and still paint)
export const UNPAINTED: string[] = made.problems.filter(l => l.startsWith("Desktop won't paint"))

export type LookRec = { on: boolean; isDrawn?: boolean; reason?: string; at: number }
const recFile = (home: string) => `${leanDir(home)}/look.json`

// config `pane.theme`: "on" (or true) turns the look on; anything else, or no config, is off
export async function themeWanted(h: Host): Promise<boolean> {
  const home = await homeDir(h)
  const cfg = await readJson<{ pane?: { theme?: unknown } } | null>(h, `${leanDir(home)}/config.json`, null).catch(() => null)
  const t = cfg?.pane?.theme
  return t === true || (typeof t === 'string' && t.trim().toLowerCase() === 'on')
}

export async function readLook(h: Host): Promise<LookRec | null> {
  const r = await readJson<Partial<LookRec> | null>(h, recFile(await homeDir(h)), null).catch(() => null)
  return r && typeof r.on === 'boolean' ? { on: r.on, ...(typeof r.isDrawn === 'boolean' ? { isDrawn: r.isDrawn } : {}), ...(typeof r.reason === 'string' ? { reason: r.reason } : {}), at: Number(r.at) || 0 } : null
}

// What a session start does: off and never on = nothing at all; on = one set; on to off = one clear. Returns what happened (for the spec).
export async function lookStep($: any, h: Host): Promise<'untouched' | 'set' | 'unpainted' | 'cleared'> {
  const home = await homeDir(h)
  const at = await h.clock.now()
  if (await themeWanted(h)) {
    if (UNPAINTED.length) {
      await writeJson(h, recFile(home), { on: true, isDrawn: false, reason: UNPAINTED[0]!.slice(0, 200), at } satisfies LookRec)
      return 'unpainted' // Desktop would ignore the whole theme: nothing is sent
    }
    try {
      const r = await $.theme.set(LOOK)
      await writeJson(h, recFile(home), { on: true, isDrawn: r?.isDrawn === true, ...(r?.isDrawn === true ? {} : { reason: String(r?.reason ?? 'no client draws a theme').slice(0, 200) }), at } satisfies LookRec)
    } catch (err) {
      await writeJson(h, recFile(home), { on: true, isDrawn: false, reason: `the theme was refused: ${String((err as Error)?.message ?? err).slice(0, 160)}`, at } satisfies LookRec)
    }
    return 'set'
  }
  const rec = await readLook(h)
  if (rec?.on) {
    await Promise.resolve($.theme.clear()).catch(() => undefined) // the user turned it off: the look the mod set goes
    await writeJson(h, recFile(home), { on: false, at } satisfies LookRec)
    return 'cleared'
  }
  return 'untouched'
}

// the lean_doctor row: off (nothing was touched), or on with whether anything draws it and why not
export async function lookRows(h: Host): Promise<string[]> {
  if (!(await themeWanted(h))) return ['ok   pane theme: off (config pane.theme: on turns on the optional look; your own look is never changed)']
  const rec = await readLook(h)
  if (!rec || !rec.on) return ['note pane theme: on, sent at the next session start']
  if (rec.isDrawn) return ['ok   pane theme: on, drawn']
  return [`note pane theme: on, not drawn: ${rec.reason ?? 'no client that draws themes is attached'}`]
}

export function registerLook(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    await lookStep($, hostOf($)).catch(() => undefined) // a look that cannot be sent never stops a session
    return next(e)
  })
}
