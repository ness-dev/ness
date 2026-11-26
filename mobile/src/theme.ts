// Ness's default dark theme tokens, read off the web client's computed
// `--color-*` variables (src/renderer/styles.css). A real app would
// mirror `settings.theme` from the slice; the spike hardcodes the default.
import { Platform } from 'react-native'
import type { PtyStatus } from '../../src/shared/state/terminals'

export const c = {
  app: '#0a0a0a',
  panel: '#141414',
  panelRaised: '#1f1f1f',
  surface: '#262626',
  surfaceHover: '#404040',
  border: '#262626',
  borderStrong: '#404040',
  fg: '#d4d4d4',
  fgBright: '#f5f5f5',
  muted: '#a3a3a3',
  dim: '#737373',
  faint: '#525252',
  success: '#22c55e',
  warning: '#fbbf24',
  danger: '#ef4444',
  info: '#60a5fa',
  accent: '#c084fc',
  // --color-brand; the default --brand-gradient is flat, so it's one colour.
  brand: '#4ade80'
}

/** Tailwind's `color/NN` opacity modifier, for hex tokens. */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, "SF Mono", Menlo, monospace' })

// text-xs / text-sm (the web client's chrome + chat body sizes).
export const fs = { xs: 12, sm: 14, base: 16, lg: 18 }

/** Same mapping as MobileApp.tsx's STATUS_DOT. */
export const STATUS_DOT: Record<PtyStatus, string> = {
  idle: c.faint,
  processing: c.success,
  waiting: c.warning,
  'needs-approval': c.danger
}
