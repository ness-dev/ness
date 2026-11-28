// The phone's theming must track the desktop's: a theme added or retuned in
// styles.css, or a change to how custom themes / the Nessie colour layer,
// shows up here before it ships as a phone that's the wrong colour.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { THEME_OPTIONS } from '../../src/renderer/themes'
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, nessieColorById } from '../../src/shared/state/settings'
import { BUILT_IN_PALETTES } from '../src/themes.generated'
import { applyTheme, c, getThemeMode, themeKey, themed, type Palette, type ThemeInputs } from '../src/theme'
import { generate, OUTPUT } from '../scripts/gen-themes.mjs'

const PALETTE_KEYS: (keyof Palette)[] = [
  'app', 'panel', 'panelRaised', 'surface', 'surfaceHover', 'well', 'border', 'borderStrong',
  'fg', 'fgBright', 'muted', 'dim', 'faint', 'success', 'warning', 'danger', 'info', 'accent',
  'brand', 'brandMid', 'brandDeep',
  'syntaxKeyword', 'syntaxType', 'syntaxString', 'syntaxNumber', 'syntaxComment', 'syntaxVariable', 'syntaxParams',
  'syntaxAddition', 'syntaxDeletion'
]
const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$/

const inputs = (over: Partial<ThemeInputs> = {}): ThemeInputs => ({
  themeMode: 'dark',
  themeLight: DEFAULT_LIGHT_THEME,
  themeDark: DEFAULT_DARK_THEME,
  customThemes: [],
  nessieColor: 'loch',
  systemScheme: 'dark',
  ...over
})

describe('generated palettes', () => {
  it('match styles.css (run `node scripts/gen-themes.mjs` in mobile/ if this fails)', () => {
    expect(readFileSync(OUTPUT, 'utf8')).toBe(generate().source)
  })

  it('cover every built-in theme the desktop offers', () => {
    for (const t of THEME_OPTIONS) expect(BUILT_IN_PALETTES, `theme ${t.id}`).toHaveProperty(t.id)
  })

  it('resolve every token the app reads to a colour', () => {
    for (const [id, p] of Object.entries(BUILT_IN_PALETTES)) {
      for (const k of PALETTE_KEYS) expect(p[k], `${id}.${k}`).toMatch(COLOR)
    }
  })
})

describe('applyTheme', () => {
  it('applies the chosen theme for the mode', () => {
    applyTheme(inputs({ themeMode: 'light', themeLight: 'solarized-light' }))
    expect(getThemeMode()).toBe('light')
    expect(c.app).toBe(BUILT_IN_PALETTES['solarized-light'].app)
    applyTheme(inputs({ themeDark: 'dracula' }))
    expect(getThemeMode()).toBe('dark')
    expect(c.app).toBe(BUILT_IN_PALETTES.dracula.app)
  })

  it("resolves 'system' against the phone's appearance", () => {
    applyTheme(inputs({ themeMode: 'system', systemScheme: 'light', themeLight: 'one-light' }))
    expect(c.app).toBe(BUILT_IN_PALETTES['one-light'].app)
    applyTheme(inputs({ themeMode: 'system', systemScheme: 'dark', themeDark: 'nord' }))
    expect(c.app).toBe(BUILT_IN_PALETTES.nord.app)
  })

  it("falls back to the mode's default for an unknown or wrong-mode id", () => {
    applyTheme(inputs({ themeMode: 'light', themeLight: 'dracula' }))
    expect(c.app).toBe(BUILT_IN_PALETTES[DEFAULT_LIGHT_THEME].app)
    applyTheme(inputs({ themeDark: 'no-such-theme' }))
    expect(c.app).toBe(BUILT_IN_PALETTES[DEFAULT_DARK_THEME].app)
  })

  it('layers a custom theme over its base', () => {
    applyTheme(
      inputs({
        themeDark: 'mine',
        customThemes: [{ id: 'mine', name: 'Mine', mode: 'dark', colors: { app: '#123456', 'fg-bright': '#abcdef' } }]
      })
    )
    expect(c.app).toBe('#123456')
    expect(c.fgBright).toBe('#abcdef')
    expect(c.border).toMatch(COLOR)
  })

  it('takes the brand ramp from the Nessie colour, a rung deeper on light themes', () => {
    const n = nessieColorById('abyss')
    applyTheme(inputs({ nessieColor: 'abyss' }))
    expect(c.brand).toBe(n.brand)
    applyTheme(inputs({ nessieColor: 'abyss', themeMode: 'light' }))
    expect(c.brand).toBe(n.deep)
  })

  it('changes themeKey only when the effective theme changes', () => {
    expect(themeKey(inputs())).toBe(themeKey(inputs({ themeLight: 'one-light' })))
    expect(themeKey(inputs())).not.toBe(themeKey(inputs({ themeDark: 'nord' })))
  })

  it('rebuilds themed() styles after a theme change', () => {
    const styles = themed(() => ({ box: { backgroundColor: c.app } }))
    applyTheme(inputs({ themeDark: 'nord' }))
    expect(styles.box.backgroundColor).toBe(BUILT_IN_PALETTES.nord.app)
    applyTheme(inputs({ themeDark: 'dracula' }))
    expect(styles.box.backgroundColor).toBe(BUILT_IN_PALETTES.dracula.app)
  })
})
