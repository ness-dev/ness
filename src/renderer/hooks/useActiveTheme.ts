import { useMemo } from 'react'
import {
  type CustomTheme,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME
} from '../../shared/state/settings'
import { useLocalAppState } from '../store'
import { THEME_OPTIONS, type ThemeOption } from '../themes'
import { useSystemColorScheme } from './useSystemColorScheme'

/** What the renderer needs to actually paint. Built-ins come straight
 *  from `THEME_OPTIONS`; custom themes are wrapped in the same shape so
 *  components don't need to branch on origin. */
export type ResolvedTheme =
  | ({ kind: 'built-in' } & ThemeOption)
  | {
      kind: 'custom'
      id: string
      label: string
      mode: 'light' | 'dark'
      colors: Record<string, string>
    }

function findBuiltIn(id: string): ThemeOption | undefined {
  return THEME_OPTIONS.find((t) => t.id === id)
}

function findCustom(id: string, customs: CustomTheme[]): CustomTheme | undefined {
  return customs.find((t) => t.id === id)
}

function wrapBuiltIn(opt: ThemeOption): ResolvedTheme {
  return { kind: 'built-in', ...opt }
}

function wrapCustom(c: CustomTheme): ResolvedTheme {
  return {
    kind: 'custom',
    id: c.id,
    label: c.name,
    mode: c.mode,
    colors: c.colors
  }
}

// Pure resolver — separate from the hook so it's testable and Phase-2
// flexible. Falls back to the built-in default for the resolved mode
// when the configured id is missing (deleted custom theme, typo, etc.).
export function resolveTheme(
  id: string,
  mode: 'light' | 'dark',
  customs: CustomTheme[]
): ResolvedTheme {
  const builtIn = findBuiltIn(id)
  if (builtIn && builtIn.mode === mode) return wrapBuiltIn(builtIn)
  const custom = findCustom(id, customs)
  if (custom && custom.mode === mode) return wrapCustom(custom)
  const fallbackId = mode === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME
  const fallback = findBuiltIn(fallbackId)
  if (fallback) return wrapBuiltIn(fallback)
  // Should be unreachable — both defaults are in THEME_OPTIONS — but
  // guard against THEME_OPTIONS being trimmed by future edits.
  return wrapBuiltIn(THEME_OPTIONS[0])
}

export function useActiveTheme(): ResolvedTheme {
  // Four narrow selectors rather than one `useSettings()`. The root `App`
  // component calls this hook, and `DesktopApp` beneath it isn't memoized
  // — so a whole-slice subscription here re-rendered the entire tree on
  // ANY settings change, including unrelated ones like `claudeCommand`.
  // That also silently defeated the narrow `nessieColor` selector sitting
  // one line below the call site, which was added to avoid exactly this.
  //
  // Local rather than active: theme is client-owned (see
  // CLIENT_OWNED_SETTING_KEYS), so it must not follow the active backend.
  // `useSettings()` already overlays these fields from the client store,
  // so this is the same value by a cheaper subscription — stated
  // explicitly here so the ownership is visible at the read site.
  //
  // The extra listeners are ~free: each selector is a property read that
  // returns a reference-stable value, so non-theme events compare equal
  // and never reach the reducer-to-render path.
  const themeMode = useLocalAppState((s) => s.settings.themeMode)
  const themeLight = useLocalAppState((s) => s.settings.themeLight)
  const themeDark = useLocalAppState((s) => s.settings.themeDark)
  const customThemes = useLocalAppState((s) => s.settings.customThemes)
  const osScheme = useSystemColorScheme()
  return useMemo(() => {
    const wantMode = themeMode === 'system' ? osScheme : themeMode
    const id = wantMode === 'dark' ? themeDark : themeLight
    return resolveTheme(id, wantMode, customThemes)
  }, [themeMode, themeLight, themeDark, osScheme, customThemes])
}
