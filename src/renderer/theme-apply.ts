import {
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
  nessieColorById
} from '../shared/state/settings'
import type { ResolvedTheme } from './hooks/useActiveTheme'

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

  // Custom theme. Apply its mode's default selector first so any keys the
  // custom didn't override fall back to a sensible base of the same mode,
  // then layer the overrides inline.
  root.dataset.theme = theme.mode === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME
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

/** Best-effort hex/string for the app background after applying `theme`.
 *  Used as `lastEffectiveAppBg` so main can choose a matching window
 *  background on the next boot. */
export function effectiveAppBg(theme: ResolvedTheme): string {
  if (theme.kind === 'custom') {
    return theme.colors.app ?? (theme.mode === 'dark' ? '#0a0a0a' : '#fdf6e3')
  }
  // First swatch on every built-in is its app background hex.
  return theme.swatches[0]
}
