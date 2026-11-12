import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HOTKEYS,
  ACTION_CATEGORIES,
  formatBindingGlyphs,
  isTypeableBinding,
  parseBinding,
  bindingToString,
  matchesBinding,
  eventToBinding,
  type Action
} from './hotkeys'

describe('hotkey categories', () => {
  it('every default hotkey is surfaced in exactly one category', () => {
    const categorized: Action[] = []
    for (const category of ACTION_CATEGORIES) {
      categorized.push(...category.actions)
      for (const family of category.families ?? []) {
        categorized.push(...family.actions)
      }
    }

    const seen = new Set<Action>()
    const duplicates = categorized.filter((a) => {
      if (seen.has(a)) return true
      seen.add(a)
      return false
    })
    expect(duplicates).toEqual([])

    const allActions = Object.keys(DEFAULT_HOTKEYS) as Action[]
    const missing = allActions.filter((a) => !seen.has(a))
    expect(missing).toEqual([])
  })
})

describe('formatBindingGlyphs', () => {
  it('renders modifiers in macOS HIG order (Shift before Cmd) regardless of input order', () => {
    // ⌃ ⌥ ⇧ ⌘
    expect(formatBindingGlyphs('Cmd+Shift+E', '')).toBe('⇧⌘E')
    expect(formatBindingGlyphs('Shift+Cmd+E', '')).toBe('⇧⌘E')
    expect(formatBindingGlyphs('Cmd+Alt+Shift+Ctrl+K', '')).toBe('⌃⌥⇧⌘K')
  })

  it('formats single modifiers and special keys', () => {
    expect(formatBindingGlyphs('Cmd+,', '')).toBe('⌘,')
    expect(formatBindingGlyphs('Cmd+ArrowDown', '')).toBe('⌘↓')
  })

  it('renders a "+" key instead of dropping it', () => {
    expect(formatBindingGlyphs('Shift+Cmd++', '')).toBe('⇧⌘+')
  })

  it('leaves the double-tap Shift gesture label alone', () => {
    expect(formatBindingGlyphs('Shift+Shift', '')).toBe('⇧⇧')
  })
})

describe('parseBinding', () => {
  it('parses punctuation keys', () => {
    expect(parseBinding('Cmd+Shift+[')).toEqual({
      key: '[',
      modifiers: { cmd: true, shift: true }
    })
    expect(parseBinding('Cmd+Shift+{')).toEqual({
      key: '{',
      modifiers: { cmd: true, shift: true }
    })
  })

  it('round-trips every binding whose key is the "+" separator', () => {
    const plus = bindingToString(DEFAULT_HOTKEYS.uiScaleUp)
    expect(plus).toBe('Shift+Cmd++')
    expect(parseBinding(plus)).toEqual(DEFAULT_HOTKEYS.uiScaleUp)
  })

  it('round-trips a Space key without trimming it away', () => {
    const binding = { key: ' ', modifiers: { cmd: true } }
    expect(parseBinding(bindingToString(binding))).toEqual(binding)
  })

  // bindingToString uppercases single-char keys and matchesBinding
  // lowercases both sides, so case is deliberately lossy — compare folded.
  it('round-trips every default binding', () => {
    const fold = (k: string): string => (k.length === 1 ? k.toLowerCase() : k)
    for (const [action, binding] of Object.entries(DEFAULT_HOTKEYS)) {
      const parsed = parseBinding(bindingToString(binding))
      expect({ action, key: fold(parsed.key), modifiers: parsed.modifiers }).toEqual({
        action,
        key: fold(binding.key),
        modifiers: binding.modifiers
      })
    }
  })
})

describe('isTypeableBinding', () => {
  it('treats a bare character key as typing', () => {
    expect(isTypeableBinding(parseBinding('a'))).toBe(true)
    expect(isTypeableBinding({ key: ' ', modifiers: {} })).toBe(true)
  })

  it('treats Shift+letter as typing', () => {
    expect(isTypeableBinding(parseBinding('Shift+A'))).toBe(true)
  })

  // ⌥A does insert "å" on macOS, but Alt counts as a deliberate chord —
  // otherwise Option bindings would be as dead in a text field as bare
  // letters. See the note on isTypeableBinding.
  it('treats Alt chords as modifiers, not typing', () => {
    expect(isTypeableBinding(parseBinding('Alt+A'))).toBe(false)
    expect(isTypeableBinding(parseBinding('Alt+Shift+A'))).toBe(false)
  })

  it('does not treat Cmd or Ctrl chords as typing', () => {
    expect(isTypeableBinding(parseBinding('Cmd+A'))).toBe(false)
    expect(isTypeableBinding(parseBinding('Ctrl+A'))).toBe(false)
    expect(isTypeableBinding(parseBinding('Cmd+Shift+Y'))).toBe(false)
  })

  it('does not treat named keys as typing', () => {
    expect(isTypeableBinding(parseBinding('F12'))).toBe(false)
    expect(isTypeableBinding(parseBinding('Escape'))).toBe(false)
    expect(isTypeableBinding(parseBinding('ArrowDown'))).toBe(false)
  })

  it('leaves every default binding live inside editable targets', () => {
    for (const binding of Object.values(DEFAULT_HOTKEYS)) {
      expect(isTypeableBinding(binding)).toBe(false)
    }
  })
})

// macOS composes a character from Option: ⌥A reports e.key "å", and the
// accent chords (⌥E, ⌥I, ⌥N, ⌥U) all report "Dead" — indistinguishable
// from each other. Matching falls back to e.code for those.
function keyEvent(
  key: string,
  code: string,
  modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}
): KeyboardEvent {
  return {
    key,
    code,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers
  } as KeyboardEvent
}

describe('matchesBinding with Option held', () => {
  it('matches ⌥A on physical position, not the composed "å"', () => {
    const e = keyEvent('å', 'KeyA', { altKey: true })
    expect(matchesBinding(e, parseBinding('Alt+A'))).toBe(true)
    expect(matchesBinding(e, parseBinding('Alt+B'))).toBe(false)
  })

  it('distinguishes the dead-key accent chords', () => {
    const optE = keyEvent('Dead', 'KeyE', { altKey: true })
    const optI = keyEvent('Dead', 'KeyI', { altKey: true })
    expect(matchesBinding(optE, parseBinding('Alt+E'))).toBe(true)
    expect(matchesBinding(optI, parseBinding('Alt+E'))).toBe(false)
    expect(matchesBinding(optI, parseBinding('Alt+I'))).toBe(true)
  })

  it('still honours bindings captured before this, stored as the composed char', () => {
    const e = keyEvent('å', 'KeyA', { altKey: true })
    expect(matchesBinding(e, { key: 'å', modifiers: { alt: true } })).toBe(true)
  })

  it('matches the ⌘⌥ defaults whatever character macOS reports', () => {
    expect(
      matchesBinding(keyEvent('®', 'KeyR', { metaKey: true, altKey: true }), DEFAULT_HOTKEYS.openReview)
    ).toBe(true)
    expect(
      matchesBinding(keyEvent('π', 'KeyP', { metaKey: true, altKey: true }), DEFAULT_HOTKEYS.togglePerfMonitor)
    ).toBe(true)
  })

  it('leaves non-Option matching alone', () => {
    // A US-layout Cmd+Shift+[ reports "{" — e.key still decides there.
    const e = keyEvent('{', 'BracketLeft', { metaKey: true, shiftKey: true })
    expect(matchesBinding(e, parseBinding('Cmd+Shift+{'))).toBe(true)
    expect(matchesBinding(e, parseBinding('Cmd+Shift+['))).toBe(false)
  })

  it('matches the tab-history defaults on Cmd+[ / Cmd+]', () => {
    const back = keyEvent('[', 'BracketLeft', { metaKey: true })
    const fwd = keyEvent(']', 'BracketRight', { metaKey: true })
    expect(matchesBinding(back, DEFAULT_HOTKEYS.historyBack)).toBe(true)
    expect(matchesBinding(fwd, DEFAULT_HOTKEYS.historyForward)).toBe(true)
    expect(matchesBinding(back, DEFAULT_HOTKEYS.historyForward)).toBe(false)
  })
})

describe('eventToBinding with Option held', () => {
  it('records the physical key so the badge reads ⌥A', () => {
    const binding = eventToBinding(keyEvent('å', 'KeyA', { altKey: true }))
    expect(binding).toEqual({
      key: 'a',
      modifiers: { cmd: false, ctrl: false, shift: false, alt: true }
    })
    expect(bindingToString(binding!)).toBe('Alt+A')
  })

  it('records a dead-key chord as its letter', () => {
    expect(eventToBinding(keyEvent('Dead', 'KeyE', { altKey: true }))?.key).toBe('e')
  })

  it('falls back to e.key for keys with no printable position', () => {
    expect(eventToBinding(keyEvent('ArrowDown', 'ArrowDown', { altKey: true }))?.key).toBe(
      'ArrowDown'
    )
  })

  it('is unchanged without Option', () => {
    expect(eventToBinding(keyEvent('A', 'KeyA', { metaKey: true, shiftKey: true }))?.key).toBe('a')
  })
})
