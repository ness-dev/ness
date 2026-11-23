import { describe, it, expect, beforeEach } from 'vitest'
import { applyTheme, EXPORTED_THEME_KEYS, SEMANTIC_KEYS } from './theme-apply'
import type { ResolvedTheme } from './hooks/useActiveTheme'

const builtIn = (id = 'dark'): ResolvedTheme =>
  ({ kind: 'built-in', id, mode: 'dark', swatches: ['#0a0a0a'] }) as unknown as ResolvedTheme

const custom = (colors: Record<string, string>, mode: 'light' | 'dark' = 'dark'): ResolvedTheme =>
  ({ kind: 'custom', id: 'c', name: 'C', mode, colors }) as unknown as ResolvedTheme

// This repo's vitest runs in the node environment and jsdom isn't a
// dependency, so stub the only two DOM surfaces applyTheme touches rather
// than pull one in for a handful of assertions.
const props = new Map<string, string>()
const dataset: Record<string, string | undefined> = {}

const read = (prop: string): string => props.get(prop) ?? ''

beforeEach(() => {
  props.clear()
  delete dataset.theme
  ;(globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      dataset,
      style: {
        setProperty: (k: string, v: string) => props.set(k, v),
        removeProperty: (k: string) => props.delete(k)
      }
    }
  }
})

describe('applyTheme', () => {

  it('lays the Nessie preset down for a built-in theme', () => {
    applyTheme(builtIn(), 'loch')
    expect(read('--color-brand')).toBe('#4ade80')
    expect(read('--brand-gradient')).toContain('gradient(')
    expect(dataset.theme).toBe('dark')
  })

  it('never writes accent — that stays the theme\'s secondary', () => {
    // The whole point of the split. Pinning accent to the brand colour made
    // the app monotone and cost Dracula its purple on user message bubbles,
    // links, focus rings and the caret.
    applyTheme(builtIn('dracula'), 'loch')
    expect(read('--color-accent')).toBe('')
    applyTheme(builtIn('dracula'), 'legacy')
    expect(read('--color-accent')).toBe('')
  })

  it('legacy still paints the real three-stop gradient', () => {
    applyTheme(builtIn(), 'legacy')
    expect(read('--color-brand')).toBe('#f59e0b')
    expect(read('--brand-gradient')).toContain('#ef4444')
    expect(read('--brand-gradient')).toContain('#a855f7')
  })

  it('lets a custom theme override the brand ramp and set its own accent', () => {
    // The question this answers: yes, these are reachable from theme JSON.
    applyTheme(custom({ brand: '#ff00ff', 'brand-mid': '#cc00cc', accent: '#00ffff' }), 'loch')
    expect(read('--color-brand')).toBe('#ff00ff')
    expect(read('--color-brand-mid')).toBe('#cc00cc')
    expect(read('--color-accent')).toBe('#00ffff')
  })

  it('repaints the gradient forms when a custom theme sets brand', () => {
    // Regression: --brand-gradient is what the gradient classes read, so a
    // theme setting only --color-brand left flat and gradient surfaces
    // disagreeing with each other.
    applyTheme(custom({ brand: '#ff00ff' }), 'loch')
    expect(read('--brand-gradient')).toContain('#ff00ff')
    expect(read('--brand-flow')).toContain('#ff00ff')
  })

  it('keeps the Nessie colour for brand keys the custom theme does not set', () => {
    applyTheme(custom({ app: '#111111' }), 'legacy')
    expect(read('--color-brand')).toBe('#f59e0b')
  })

  it('clears a previous custom theme when switching back to a built-in', () => {
    applyTheme(custom({ app: '#111111', brand: '#ff00ff' }), 'loch')
    expect(read('--color-app')).toBe('#111111')
    applyTheme(builtIn(), 'loch')
    expect(read('--color-app')).toBe('')
    expect(read('--color-brand')).toBe('#4ade80')
  })

  it('takes the ramp a rung darker on light themes', () => {
    // #4ade80 on a pale background is close to unreadable, and the mark and
    // wordmark are exactly what --color-brand paints.
    applyTheme(custom({ app: '#fdf6e3' }, 'light'), 'loch')
    expect(read('--color-brand')).toBe('#16a34a')
    expect(read('--brand-gradient')).toContain('#16a34a')
    applyTheme(builtIn(), 'loch')
    expect(read('--color-brand')).toBe('#4ade80')
  })

  it('keeps baseless light custom themes on Solarized Light', () => {
    // Written before `base` existed, tuned over the old default. Moving the
    // default light theme must not repaint the keys they leave unset.
    applyTheme(custom({ accent: '#ff00ff' }, 'light'), 'loch')
    expect(dataset.theme).toBe('solarized-light')
    applyTheme(custom({ accent: '#ff00ff' }, 'dark'), 'loch')
    expect(dataset.theme).toBe('dark')
  })

  it('layers a custom theme over its named base', () => {
    const withBase = (base: string, mode: 'light' | 'dark'): ResolvedTheme =>
      ({ ...custom({}, mode), base }) as ResolvedTheme
    applyTheme(withBase('catppuccin-latte', 'light'), 'loch')
    expect(dataset.theme).toBe('catppuccin-latte')
    // A base of the other mode, or an unknown id, falls back.
    applyTheme(withBase('dracula', 'light'), 'loch')
    expect(dataset.theme).toBe('solarized-light')
    applyTheme(withBase('nope', 'dark'), 'loch')
    expect(dataset.theme).toBe('dark')
  })

  it('exposes the brand ramp as settable semantic keys', () => {
    for (const k of ['brand', 'brand-mid', 'brand-deep', 'accent']) {
      expect(SEMANTIC_KEYS.has(k)).toBe(true)
    }
  })
})

describe('EXPORTED_THEME_KEYS', () => {
  it('lets custom themes set well but leaves it out of the built-in export', () => {
    expect(SEMANTIC_KEYS.has('well')).toBe(true)
    expect(EXPORTED_THEME_KEYS.has('well')).toBe(false)
    expect(EXPORTED_THEME_KEYS.has('app')).toBe(true)
  })
})
