export type Action =
  | 'nextWorktree'
  | 'prevWorktree'
  | 'worktree1'
  | 'worktree2'
  | 'worktree3'
  | 'worktree4'
  | 'worktree5'
  | 'worktree6'
  | 'worktree7'
  | 'worktree8'
  | 'worktree9'
  | 'backend1'
  | 'backend2'
  | 'backend3'
  | 'backend4'
  | 'backend5'
  | 'backend6'
  | 'backend7'
  | 'backend8'
  | 'backend9'
  | 'newShellTab'
  | 'closeTab'
  | 'renameTab'
  | 'nextTab'
  | 'prevTab'
  | 'newWorktree'
  | 'refreshWorktrees'
  | 'focusTerminal'
  | 'toggleSidebar'
  | 'openPR'
  | 'openInEditor'
  | 'toggleCommandCenter'
  | 'toggleTaskList'
  | 'commandPalette'
  | 'fileQuickOpen'
  | 'splitPaneRight'
  | 'splitPaneDown'
  | 'toggleRightColumn'
  | 'toggleSingleScreen'
  | 'togglePerfMonitor'
  | 'hotkeyCheatsheet'
  | 'openReview'
  | 'toggleQuakeTerminal'
  | 'openSettings'
  | 'uiScaleUp'
  | 'uiScaleDown'
  | 'uiScaleReset'
  | 'aliasWorktree'
  | 'approveToolUse'
  | 'denyToolUse'
  | 'cyclePreventSleep'

export interface Modifiers {
  cmd?: boolean
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export interface HotkeyBinding {
  key: string
  modifiers: Modifiers
}

export const DEFAULT_HOTKEYS: Record<Action, HotkeyBinding> = {
  nextWorktree: { key: 'ArrowDown', modifiers: { cmd: true } },
  prevWorktree: { key: 'ArrowUp', modifiers: { cmd: true } },
  worktree1: { key: '1', modifiers: { cmd: true } },
  worktree2: { key: '2', modifiers: { cmd: true } },
  worktree3: { key: '3', modifiers: { cmd: true } },
  worktree4: { key: '4', modifiers: { cmd: true } },
  worktree5: { key: '5', modifiers: { cmd: true } },
  worktree6: { key: '6', modifiers: { cmd: true } },
  worktree7: { key: '7', modifiers: { cmd: true } },
  worktree8: { key: '8', modifiers: { cmd: true } },
  worktree9: { key: '9', modifiers: { cmd: true } },
  // Backend switcher hotkeys (multi-backend Tier 1, design §F).
  // Cmd+Shift+1..9 to avoid colliding with worktree1..9. The cycle
  // hotkey from the design (Cmd+`) is the macOS "next window" shortcut,
  // so cycle is deferred — index switching is enough for v1's expected
  // 2-3 backend usage.
  backend1: { key: '1', modifiers: { cmd: true, shift: true } },
  backend2: { key: '2', modifiers: { cmd: true, shift: true } },
  backend3: { key: '3', modifiers: { cmd: true, shift: true } },
  backend4: { key: '4', modifiers: { cmd: true, shift: true } },
  backend5: { key: '5', modifiers: { cmd: true, shift: true } },
  backend6: { key: '6', modifiers: { cmd: true, shift: true } },
  backend7: { key: '7', modifiers: { cmd: true, shift: true } },
  backend8: { key: '8', modifiers: { cmd: true, shift: true } },
  backend9: { key: '9', modifiers: { cmd: true, shift: true } },
  newShellTab: { key: 't', modifiers: { cmd: true } },
  closeTab: { key: 'w', modifiers: { cmd: true } },
  renameTab: { key: 'l', modifiers: { cmd: true } },
  nextTab: { key: 'Tab', modifiers: { ctrl: true } },
  prevTab: { key: 'Tab', modifiers: { ctrl: true, shift: true } },
  newWorktree: { key: 'n', modifiers: { cmd: true } },
  refreshWorktrees: { key: 'r', modifiers: { cmd: true, shift: true } },
  // Gesture-driven: focusTerminal fires on a double-tap of Shift (see
  // GESTURE_ACTIONS / useDoubleTapShift), not this binding. The entry stays so
  // the action remains a valid member of the binding map; the key matcher in
  // useHotkeys skips it.
  focusTerminal: { key: '`', modifiers: { ctrl: true, shift: true } },
  toggleSidebar: { key: 'b', modifiers: { cmd: true } },
  openPR: { key: 'g', modifiers: { cmd: true, shift: true } },
  openInEditor: { key: 'e', modifiers: { cmd: true, shift: true } },
  toggleCommandCenter: { key: 'k', modifiers: { cmd: true, shift: true } },
  toggleTaskList: { key: 'l', modifiers: { cmd: true, shift: true } },
  commandPalette: { key: 'k', modifiers: { cmd: true } },
  fileQuickOpen: { key: 'p', modifiers: { cmd: true } },
  splitPaneRight: { key: 'd', modifiers: { cmd: true } },
  splitPaneDown: { key: 'd', modifiers: { cmd: true, shift: true } },
  toggleRightColumn: { key: 'b', modifiers: { cmd: true, shift: true } },
  toggleSingleScreen: { key: 'F12', modifiers: {} },
  togglePerfMonitor: { key: 'p', modifiers: { cmd: true, alt: true } },
  hotkeyCheatsheet: { key: '/', modifiers: { cmd: true, shift: true } },
  openReview: { key: 'r', modifiers: { cmd: true, alt: true } },
  // Quake-style drop-down terminal on Ctrl+backtick (classic Quake's backtick).
  toggleQuakeTerminal: { key: '`', modifiers: { ctrl: true } },
  openSettings: { key: ',', modifiers: { cmd: true } },
  uiScaleUp: { key: '+', modifiers: { cmd: true, shift: true } },
  uiScaleDown: { key: '-', modifiers: { cmd: true } },
  uiScaleReset: { key: '=', modifiers: { cmd: true } },
  aliasWorktree: { key: 'a', modifiers: { cmd: true, shift: true } },
  approveToolUse: { key: 'y', modifiers: { cmd: true, shift: true } },
  denyToolUse: { key: 'n', modifiers: { cmd: true, shift: true } },
  cyclePreventSleep: { key: 'u', modifiers: { cmd: true, shift: true } },
}

/** Actions triggered by a gesture (e.g. double-tap Shift) rather than a
 * modifier+key chord. The key matcher in useHotkeys skips these, and the
 * Settings rebind UI omits them — they have no editable binding. */
export const GESTURE_ACTIONS: ReadonlySet<Action> = new Set<Action>(['focusTerminal'])

const CODE_TO_KEY: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: ' '
}

/**
 * The character a key would produce with no modifiers, derived from its
 * physical position (`e.code`). Returns null for keys that don't produce
 * one (F1, Escape, ArrowUp) — those report a stable `e.key` already.
 *
 * This exists because Option is a text-entry modifier on macOS: ⌥A reports
 * `e.key === 'å'`, and ⌥E reports `'Dead'` (the start of an accent
 * sequence, so ⌥E and ⌥I are indistinguishable by key). Binding on `e.key`
 * alone therefore can't express "Option plus the A key".
 */
export function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return CODE_TO_KEY[code] ?? null
}

/** Check if a KeyboardEvent matches a hotkey binding */
export function matchesBinding(e: KeyboardEvent, binding: HotkeyBinding): boolean {
  const wantCmd = binding.modifiers.cmd ?? false
  const wantCtrl = binding.modifiers.ctrl ?? false
  const wantShift = binding.modifiers.shift ?? false
  const wantAlt = binding.modifiers.alt ?? false

  if (e.metaKey !== wantCmd) return false
  if (e.ctrlKey !== wantCtrl) return false
  if (e.shiftKey !== wantShift) return false
  if (e.altKey !== wantAlt) return false

  // Normalize key comparison — e.key is case-sensitive but we want case-insensitive for letters
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const bindingKey = binding.key.length === 1 ? binding.key.toLowerCase() : binding.key

  // With Option held, e.key is the composed character ("å", "Dead"), so match
  // on physical position instead. The e.key comparison still runs after, so
  // bindings captured before this existed (stored as "Alt+Å") keep working.
  if (wantAlt && keyFromCode(e.code) === bindingKey) return true

  return eventKey === bindingKey
}

// Monaco's input surface is an EditContext-backed div (not a textarea, not
// contenteditable), so it's matched by container class rather than tag.
export function isEditableTarget(el: HTMLElement | null): boolean {
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable ||
    el.closest('.monaco-editor, .xterm') !== null
  )
}

/**
 * True when this binding is indistinguishable from typing a character —
 * `a`, `Shift+A`, space. Those must not be stolen from an editable target.
 * Anything with Cmd, Ctrl, or Alt is a deliberate chord and stays live
 * everywhere, as do keys that never insert text (`F12`, `Escape`).
 *
 * Alt is on the modifier side despite ⌥A typing "å" on macOS: treating it
 * as typing would make Option bindings as dead in a text field as bare
 * letters, and Option is the one easy one-hand modifier left. The cost is
 * that binding ⌥A means you can't type "å" in the app — self-inflicted and
 * limited to the one chord, unlike losing the letter A.
 */
export function isTypeableBinding(binding: HotkeyBinding): boolean {
  const { cmd, ctrl, alt } = binding.modifiers
  if (cmd || ctrl || alt) return false
  return binding.key.length === 1
}

/**
 * Parse a shortcut string like "Cmd+Shift+T" into a HotkeyBinding.
 * Recognized modifier tokens: Cmd, Ctrl, Shift, Alt.
 *
 * Modifiers are consumed greedily from the front and everything after the
 * last one is the key, so a key that IS the separator survives the round
 * trip: "Shift+Cmd++" splits to ['Shift','Cmd','',''] and rejoins to '+'.
 * Taking the last token instead yielded '' — a binding that could never
 * match. Single-character keys skip the trim so ' ' (Space) survives too.
 */
export function parseBinding(shortcut: string): HotkeyBinding {
  const parts = shortcut.split('+')
  const modifiers: Modifiers = {}

  let i = 0
  for (; i < parts.length - 1; i++) {
    const mod = parts[i].trim().toLowerCase()
    if (mod === 'cmd' || mod === 'meta') modifiers.cmd = true
    else if (mod === 'ctrl' || mod === 'control') modifiers.ctrl = true
    else if (mod === 'shift') modifiers.shift = true
    else if (mod === 'alt' || mod === 'option') modifiers.alt = true
    else break
  }

  const rest = parts.slice(i).join('+')
  const key = rest.length > 1 ? rest.trim() : rest

  return { key, modifiers }
}

/**
 * Format a Cmd+Shift+E-style string as ⇧⌘E with Unicode mac glyphs.
 * Modifiers always render in macOS HIG order ⌃ ⌥ ⇧ ⌘ (Shift before Cmd),
 * regardless of the order they appear in the input string.
 */
export function formatBindingGlyphs(binding: string, separator = ' '): string {
  // Canonical macOS modifier order: Control, Option, Shift, Command.
  const MOD_ORDER = ['⌃', '⌥', '⇧', '⌘']
  const parts = binding.split('+')
  // Trailing empty tokens mean the key itself was the separator:
  // "Shift+Cmd++" → ['Shift','Cmd','',''] → ['Shift','Cmd','+']. Without
  // this the badge renders "⇧⌘" with no key at all.
  while (parts.length > 1 && parts[parts.length - 1] === '') {
    parts.pop()
    if (parts[parts.length - 1] === '') parts[parts.length - 1] = '+'
  }
  const glyphs = parts
    .map((part) => {
      const lower = part.trim().toLowerCase()
      if (lower === 'cmd' || lower === 'meta') return '\u2318' // ⌘
      if (lower === 'ctrl' || lower === 'control') return '\u2303' // ⌃
      if (lower === 'alt' || lower === 'option') return '\u2325' // ⌥
      if (lower === 'shift') return '\u21E7' // ⇧
      if (part === 'ArrowUp') return '\u2191'
      if (part === 'ArrowDown') return '\u2193'
      if (part === 'ArrowLeft') return '\u2190'
      if (part === 'ArrowRight') return '\u2192'
      if (part === 'Enter') return '\u23CE'
      if (part === 'Tab') return 'Tab'
      if (part === 'Escape') return 'Esc'
      return part
    })
  const mods = glyphs
    .filter((g) => MOD_ORDER.includes(g))
    .sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b))
  const rest = glyphs.filter((g) => !MOD_ORDER.includes(g))
  return [...mods, ...rest].join(separator)
}

/** Convert a binding back to a human-readable string like "Ctrl+Alt+Shift+Cmd+T" — Mac order. */
export function bindingToString(binding: HotkeyBinding): string {
  const parts: string[] = []
  if (binding.modifiers.ctrl) parts.push('Ctrl')
  if (binding.modifiers.alt) parts.push('Alt')
  if (binding.modifiers.shift) parts.push('Shift')
  if (binding.modifiers.cmd) parts.push('Cmd')
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  return parts.join('+')
}

/** Human-readable labels for each action */
export const ACTION_LABELS: Record<Action, string> = {
  nextWorktree: 'Next worktree',
  prevWorktree: 'Previous worktree',
  worktree1: 'Switch to worktree 1',
  worktree2: 'Switch to worktree 2',
  worktree3: 'Switch to worktree 3',
  worktree4: 'Switch to worktree 4',
  worktree5: 'Switch to worktree 5',
  worktree6: 'Switch to worktree 6',
  worktree7: 'Switch to worktree 7',
  worktree8: 'Switch to worktree 8',
  worktree9: 'Switch to worktree 9',
  backend1: 'Switch to backend 1',
  backend2: 'Switch to backend 2',
  backend3: 'Switch to backend 3',
  backend4: 'Switch to backend 4',
  backend5: 'Switch to backend 5',
  backend6: 'Switch to backend 6',
  backend7: 'Switch to backend 7',
  backend8: 'Switch to backend 8',
  backend9: 'Switch to backend 9',
  newShellTab: 'New shell tab',
  closeTab: 'Close tab',
  renameTab: 'Rename tab',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  newWorktree: 'New worktree',
  refreshWorktrees: 'Refresh worktrees',
  focusTerminal: 'Focus terminal',
  toggleSidebar: 'Toggle sidebar',
  openPR: 'Open PR in browser',
  openInEditor: 'Open worktree in editor',
  toggleCommandCenter: 'Toggle command center',
  toggleTaskList: 'Toggle task list',
  commandPalette: 'Command palette',
  fileQuickOpen: 'Open file...',
  splitPaneRight: 'Split pane right',
  splitPaneDown: 'Split pane down',
  toggleRightColumn: 'Toggle right column',
  toggleSingleScreen: 'Toggle single screen mode',
  togglePerfMonitor: 'Performance monitor',
  hotkeyCheatsheet: 'Keyboard shortcuts',
  openReview: 'Review changes',
  toggleQuakeTerminal: 'Toggle drop-down terminal',
  openSettings: 'Open settings',
  uiScaleUp: 'Increase UI size',
  uiScaleDown: 'Decrease UI size',
  uiScaleReset: 'Reset UI size',
  aliasWorktree: 'Alias worktree',
  approveToolUse: 'Approve pending tool use (Chat)',
  denyToolUse: 'Deny pending tool use (Chat)',
  cyclePreventSleep: 'Cycle prevent-sleep mode'
}

export type CategoryId =
  | 'navigation'
  | 'backends'
  | 'worktree-mgmt'
  | 'tabs'
  | 'layout'
  | 'commands'
  | 'overlays'
  | 'external'
  | 'chat'

export interface HotkeyCategory {
  id: CategoryId
  label: string
  actions: Action[]
  /** Optional groups within the category whose members should render as a
   *  single collapsed "family" row by default (e.g. worktree1..9). The
   *  `summary` is what shows on the collapsed row; expand reveals the
   *  individual actions for rebinding. */
  families?: { label: string; summary: string; actions: Action[] }[]
}

export const ACTION_CATEGORIES: HotkeyCategory[] = [
  {
    id: 'navigation',
    label: 'Worktree navigation',
    actions: ['nextWorktree', 'prevWorktree'],
    families: [{
      label: 'Switch to worktree N',
      summary: '⌘ 1 … ⌘ 9',
      actions: ['worktree1', 'worktree2', 'worktree3', 'worktree4', 'worktree5', 'worktree6', 'worktree7', 'worktree8', 'worktree9']
    }]
  },
  {
    id: 'backends',
    label: 'Backends',
    actions: [],
    families: [{
      label: 'Switch to backend N',
      summary: '⇧ ⌘ 1 … ⇧ ⌘ 9',
      actions: ['backend1', 'backend2', 'backend3', 'backend4', 'backend5', 'backend6', 'backend7', 'backend8', 'backend9']
    }]
  },
  {
    id: 'worktree-mgmt',
    label: 'Worktree management',
    actions: ['newWorktree', 'refreshWorktrees', 'aliasWorktree']
  },
  {
    id: 'tabs',
    label: 'Tabs & panes',
    actions: ['newShellTab', 'closeTab', 'renameTab', 'nextTab', 'prevTab', 'focusTerminal', 'splitPaneRight', 'splitPaneDown']
  },
  {
    id: 'layout',
    label: 'Window layout',
    actions: ['toggleSidebar', 'toggleRightColumn', 'toggleSingleScreen', 'uiScaleUp', 'uiScaleDown', 'uiScaleReset', 'cyclePreventSleep']
  },
  {
    id: 'commands',
    label: 'Search & commands',
    actions: ['commandPalette', 'fileQuickOpen', 'toggleCommandCenter', 'toggleTaskList', 'hotkeyCheatsheet']
  },
  {
    id: 'overlays',
    label: 'App overlays',
    actions: ['openSettings', 'openReview', 'togglePerfMonitor', 'toggleQuakeTerminal']
  },
  {
    id: 'external',
    label: 'External actions',
    actions: ['openPR', 'openInEditor']
  },
  {
    id: 'chat',
    label: 'Chat (JSON mode)',
    actions: ['approveToolUse', 'denyToolUse']
  }
]

/** Capture a KeyboardEvent into a HotkeyBinding (for the rebind UI) */
export function eventToBinding(e: KeyboardEvent): HotkeyBinding | null {
  // Ignore pure modifier presses
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null
  // With Option held, capture the physical key so ⌥A records as "Alt+A"
  // rather than "Alt+Å" — and so ⌥E records as E rather than "Dead", which
  // every other Option-accent chord would also have collided on.
  const fromCode = e.altKey ? keyFromCode(e.code) : null
  return {
    key: fromCode ?? (e.key.length === 1 ? e.key.toLowerCase() : e.key),
    modifiers: {
      cmd: e.metaKey,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey
    }
  }
}

/** Build a resolved hotkey map by merging defaults with user overrides */
export function resolveHotkeys(
  overrides?: Record<string, string>
): Record<Action, HotkeyBinding> {
  if (!overrides) return { ...DEFAULT_HOTKEYS }

  const resolved = { ...DEFAULT_HOTKEYS }
  for (const [action, shortcut] of Object.entries(overrides)) {
    if (action in DEFAULT_HOTKEYS) {
      resolved[action as Action] = parseBinding(shortcut)
    }
  }
  return resolved
}
