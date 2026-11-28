// The active colour palette — Ness's `--color-*` tokens as a plain object.
//
// Theming model: `c` is ONE mutable object that every component reads at
// render time. applyTheme() swaps its values in place (palettes generated
// from the desktop's styles.css, custom themes from settings, the brand ramp
// from the Nessie colour) and bumps `themeVersion`; App remounts the UI
// subtree on that version so everything re-renders with the new values,
// while the backend connections (above the remount) stay up.
//
// Module-level styles must go through themed() rather than
// StyleSheet.create, so they're rebuilt lazily for the current palette
// instead of being frozen at import time.
import { Platform } from 'react-native'
import type { PtyStatus } from '../../src/shared/state/terminals'
import type { CustomTheme } from '../../src/shared/state/settings'
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, nessieColorById } from '../../src/shared/state/settings'
import { THEME_OPTIONS } from '../../src/renderer/themes'
import { customThemeBase, SEMANTIC_KEYS } from '../../src/renderer/theme-apply'
import { BUILT_IN_PALETTES, TERM_PALETTES } from './themes.generated'

export interface Palette {
  app: string
  panel: string
  panelRaised: string
  surface: string
  surfaceHover: string
  well: string
  border: string
  borderStrong: string
  fg: string
  fgBright: string
  muted: string
  dim: string
  faint: string
  success: string
  warning: string
  danger: string
  info: string
  accent: string
  brand: string
  brandMid: string
  brandDeep: string
}

export const c: Palette = { ...(BUILT_IN_PALETTES.dark as unknown as Palette) }
let themeMode: 'light' | 'dark' = 'dark'
/** Resolved mode of the active theme (status bar, keyboard appearance). */
export const getThemeMode = (): 'light' | 'dark' => themeMode
let termPalette: Record<string, string> = {}
/** The active theme's `--term-*` ANSI colours (empty for themes that use
 *  XTerminal's dark-tuned fallbacks). A custom theme uses its base's. */
export const getTermPalette = (): Readonly<Record<string, string>> => termPalette
let version = 0
export const themeVersion = (): number => version

const camel = (k: string) => k.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())

export interface ThemeInputs {
  themeMode: 'light' | 'dark' | 'system' | string
  themeLight: string
  themeDark: string
  customThemes: CustomTheme[]
  nessieColor: string
  systemScheme: 'light' | 'dark' | null | undefined
}

/** Which theme applies — copy of renderer/hooks/useActiveTheme's
 *  resolveTheme (that module imports the renderer store). A theme id that
 *  doesn't exist for the resolved mode falls back to that mode's default. */
function resolve(inputs: ThemeInputs): { id: string; mode: 'light' | 'dark'; custom?: CustomTheme } {
  const mode: 'light' | 'dark' =
    inputs.themeMode === 'light' || inputs.themeMode === 'dark'
      ? inputs.themeMode
      : inputs.systemScheme === 'light'
        ? 'light'
        : 'dark'
  const id = mode === 'light' ? inputs.themeLight : inputs.themeDark
  const builtIn = THEME_OPTIONS.find((t) => t.id === id)
  if (builtIn && builtIn.mode === mode) return { id, mode }
  const custom = inputs.customThemes.find((t) => t.id === id)
  if (custom && custom.mode === mode) return { id, mode, custom }
  return { id: mode === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME, mode }
}

/** Key for "did the effective theme change" (drives the UI remount). */
export function themeKey(inputs: ThemeInputs): string {
  const r = resolve(inputs)
  return `${r.id}:${r.mode}:${inputs.nessieColor}:${r.custom ? JSON.stringify(r.custom.colors) : ''}`
}

/** Same layering as renderer/theme-apply.ts applyTheme: base palette (the
 *  custom theme's base for customs), the Nessie brand ramp (a rung darker
 *  on light themes), then a custom theme's own semantic keys on top. */
export function applyTheme(inputs: ThemeInputs): void {
  const r = resolve(inputs)
  const baseId = r.custom ? customThemeBase(r.custom) : r.id
  const next = { ...(BUILT_IN_PALETTES.dark as unknown as Palette), ...((BUILT_IN_PALETTES[baseId] ?? {}) as unknown as Palette) }
  const nessie = nessieColorById(inputs.nessieColor)
  const light = r.mode === 'light'
  next.brand = light ? nessie.deep : nessie.brand
  next.brandMid = light ? nessie.deep : nessie.mid
  next.brandDeep = nessie.deep
  if (r.custom) {
    for (const [k, v] of Object.entries(r.custom.colors)) {
      if (SEMANTIC_KEYS.has(k)) (next as unknown as Record<string, string>)[camel(k)] = v
    }
  }
  Object.assign(c, next)
  termPalette = TERM_PALETTES[baseId] ?? {}
  themeMode = r.mode
  version++
}

/** Module-level styles that follow the theme: rebuilt for the current
 *  palette on first access after a theme change. Use instead of
 *  StyleSheet.create wherever the styles reference `c`. */
export function themed<T extends object>(make: () => T): T {
  let built = -1
  let cache = {} as T
  return new Proxy({} as T, {
    get(_t, key) {
      if (built !== version) {
        cache = make()
        built = version
      }
      return (cache as Record<string | symbol, unknown>)[key]
    }
  })
}

/** Tailwind's `color/NN` opacity modifier, for hex tokens. */
export function alpha(hex: string, a: number): string {
  if (!hex.startsWith('#')) return hex
  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
  const n = parseInt(full.slice(1, 7), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, "SF Mono", Menlo, monospace' })

// text-xs / text-sm (the web client's chrome + chat body sizes).
export const fs = { xs: 12, sm: 14, base: 16, lg: 18 }

/** Same mapping as MobileApp.tsx's STATUS_DOT — read live from the palette. */
export const STATUS_DOT: Record<PtyStatus, string> = {
  get idle() {
    return c.faint
  },
  get processing() {
    return c.success
  },
  get waiting() {
    return c.warning
  },
  get 'needs-approval'() {
    return c.danger
  }
}
