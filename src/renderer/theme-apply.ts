import { CUSTOM_THEME_BASE, nessieColorById } from '../shared/state/settings'
import type { ResolvedTheme } from './hooks/useActiveTheme'
import { THEME_OPTIONS } from './themes'

// Tracks which custom properties we set inline on the documentElement during
// the previous apply, so the next apply can clear leftovers cleanly. Without
// this, switching from a custom theme back to a built-in would leak the
// custom's colors past the [data-theme] selector (inline styles outrank
// attribute selectors).
const inlineKeysApplied = new Set<string>()

export const SEMANTIC_KEYS: ReadonlySet<string> = new Set([
  'app',
  'panel',
  'panel-raised',
  'surface',
  'surface-hover',
  'well',
  'border',
  'border-strong',
  'fg',
  'fg-bright',
  'muted',
  'dim',
  'faint',
  'success',
  'warning',
  'danger',
  'info',
  'accent',
  // Brand ramp — the Nessie colour. Listed here so a custom theme JSON can
  // set them like any other semantic key; see the precedence note below.
  'brand',
  'brand-mid',
  'brand-deep'
])

/** Keys a built-in theme's "Copy JSON" export writes. `well` is left out:
 *  for most built-ins it's only derived (`var(--color-app)` at :root), so a
 *  probe reads the *active* theme's value, and freezing it into a custom
 *  theme would stop it following that theme's own `app`. */
export const EXPORTED_THEME_KEYS: ReadonlySet<string> = new Set(
  [...SEMANTIC_KEYS].filter((k) => k !== 'well')
)

/** Theme + Nessie colour are applied together, in one pass, on purpose.
 *
 *  They both write `--color-accent` and the brand ramp, so splitting them
 *  across two effects made the winner depend on React's effect ordering —
 *  and because the theme effect lives on the outer `App` and would have run
 *  *after* a child's, a custom theme's `accent` silently clobbered the
 *  Nessie colour on some renders and not others.
 *
 *  Precedence, now explicit: the Nessie preset goes down first, then the
 *  custom theme's own keys layer over it. So the picker sets the brand colour,
 *  and a custom theme that deliberately declares `brand` / `brand-mid` /
 *  `brand-deep` still wins for exactly those keys.
 *
 *  Note the preset does NOT write `--color-accent`. Accent is the theme's
 *  secondary and stays the theme's to set — that's what keeps Dracula purple
 *  under a green mark instead of turning the whole app one colour. */
export function applyTheme(theme: ResolvedTheme, nessieColorId: string): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  for (const key of inlineKeysApplied) root.style.removeProperty(key)
  inlineKeysApplied.clear()

  const setInline = (prop: string, value: string): void => {
    root.style.setProperty(prop, value)
    inlineKeysApplied.add(prop)
  }

  // Light themes take the ramp a rung darker. The presets are tuned for a
  // near-black background, so on a pale one (#fdf6e3 and friends) the top
  // rung is far too washed out for the thing it's mostly used on — the mark
  // and the wordmark, which are the two elements that can least afford to be
  // hard to read. `deep` is the same hue, just legible on paper.
  const nessie = nessieColorById(nessieColorId)
  const light = theme.mode === 'light'
  const brand = light ? nessie.deep : nessie.brand
  setInline('--color-brand', brand)
  setInline('--color-brand-mid', light ? nessie.deep : nessie.mid)
  setInline('--color-brand-deep', nessie.deep)
  setInline(
    '--brand-gradient',
    light ? `linear-gradient(135deg, ${brand} 0%, ${brand} 100%)` : nessie.gradient
  )
  setInline(
    '--brand-flow',
    light
      ? `linear-gradient(90deg, ${nessie.mid} 0%, ${brand} 25%, ${nessie.deep} 50%, ${brand} 75%, ${nessie.mid} 100%)`
      : nessie.flow
  )

  if (theme.kind === 'built-in') {
    // Built-ins pull every remaining value from the CSS file via the
    // [data-theme="<id>"] selector — setting the attribute is enough.
    root.dataset.theme = theme.id
    return
  }

  // Custom theme. Apply its base built-in's selector first so any keys the
  // custom didn't override fall back to a base of the same mode, then layer
  // the overrides inline.
  root.dataset.theme = customThemeBase(theme)
  for (const [key, value] of Object.entries(theme.colors)) {
    if (!SEMANTIC_KEYS.has(key)) continue
    setInline(`--color-${key}`, value)
  }

  // A theme that sets `brand` has to recolour the *painted* forms too. The
  // gradient classes read --brand-gradient / --brand-flow, not --color-brand,
  // so without this the flat brand surfaces would follow the theme while the
  // gradient ones stayed on the Nessie preset.
  const themeBrand = theme.colors.brand
  if (themeBrand) {
    const themeMid = theme.colors['brand-mid'] ?? themeBrand
    setInline('--brand-gradient', `linear-gradient(135deg, ${themeBrand} 0%, ${themeBrand} 100%)`)
    setInline(
      '--brand-flow',
      `linear-gradient(90deg, ${themeMid} 0%, ${themeBrand} 25%, color-mix(in srgb, ${themeBrand} 45%, white) 50%, ${themeBrand} 75%, ${themeMid} 100%)`
    )
  }
}

/** The built-in a custom theme layers over: its own `base` when that names a
 *  built-in of the same mode, else the per-mode legacy base. */
export function customThemeBase(theme: { mode: 'light' | 'dark'; base?: string }): string {
  const named = THEME_OPTIONS.find((t) => t.id === theme.base && t.mode === theme.mode)
  return named ? named.id : CUSTOM_THEME_BASE[theme.mode]
}

/** Best-effort hex/string for the app background after applying `theme`.
 *  Used as `lastEffectiveAppBg` so main can choose a matching window
 *  background on the next boot. */
export function effectiveAppBg(theme: ResolvedTheme): string {
  if (theme.kind === 'custom') {
    if (theme.colors.app) return theme.colors.app
    const base = THEME_OPTIONS.find((t) => t.id === customThemeBase(theme))
    return base?.swatches[0] ?? (theme.mode === 'dark' ? '#0a0a0a' : '#ffffff')
  }
  // First swatch on every built-in is its app background hex.
  return theme.swatches[0]
}
