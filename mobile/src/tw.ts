// Tiny Tailwind-class → RN-style translator for the handful of classes the
// desktop's icon components receive (`icon-sm text-danger animate-pulse`).
// Lets renderer modules that hand out icon components (tool-display's
// registry, row-style helpers) be reused unchanged: the className they
// pass still means the same size and colour here.
import { alpha, c, themed, themeVersion } from './theme'

const ICON: Record<string, number> = {
  'icon-2xs': 10,
  'icon-xs': 12,
  'icon-sm': 14,
  'icon-base': 16,
  'icon-lg': 20,
  'icon-xl': 32
}

const TOKENS: Record<string, string> = themed(() => ({
  fg: c.fg,
  'fg-bright': c.fgBright,
  muted: c.muted,
  dim: c.dim,
  faint: c.faint,
  success: c.success,
  warning: c.warning,
  danger: c.danger,
  info: c.info,
  accent: c.accent,
  white: '#ffffff',
  // RepoIcon / repo label palette (Tailwind v4 *-400)
  'teal-400': '#2dd4bf',
  'cyan-400': '#22d3ee',
  'sky-400': '#38bdf8',
  'blue-400': '#60a5fa',
  'indigo-400': '#818cf8',
  'violet-400': '#a78bfa',
  'purple-400': '#c084fc',
  'fuchsia-400': '#e879f9',
  'pink-400': '#f472b6',
  'slate-400': '#94a3b8'
}))

/** Resolve `text-accent`, `bg-teal-400/60`, `text-danger/80` → a colour. */
export function tokenColor(cls: string, prefix: 'text' | 'bg'): string | undefined {
  const m = new RegExp(`^${prefix}-([a-z0-9-]+?)(?:/(\\d+))?$`).exec(cls)
  if (!m || TOKENS[m[1]] === undefined) return undefined
  const hex = TOKENS[m[1]]
  return m[2] ? alpha(hex, Number(m[2]) / 100) : hex
}

export interface TwResult {
  size?: number
  color?: string
  opacity?: number
  spin: boolean
  pulse: boolean
}

// Keyed per theme: the colours resolve against the active palette.
const cache = new Map<string, TwResult>()
let cacheVersion = -1

export function tw(className: string | undefined): TwResult {
  if (cacheVersion !== themeVersion()) {
    cache.clear()
    cacheVersion = themeVersion()
  }
  const key = className ?? ''
  const hit = cache.get(key)
  if (hit) return hit
  const out: TwResult = { spin: false, pulse: false }
  for (const cls of key.split(/\s+/)) {
    if (cls in ICON) out.size = ICON[cls]
    else if (cls === 'animate-spin') out.spin = true
    else if (cls === 'animate-pulse') out.pulse = true
    else if (cls.startsWith('opacity-')) out.opacity = Number(cls.slice(8)) / 100
    else {
      const col = tokenColor(cls, 'text')
      if (col) out.color = col
    }
  }
  cache.set(key, out)
  return out
}
