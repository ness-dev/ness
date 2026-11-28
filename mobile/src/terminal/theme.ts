// xterm theme from the active palette: XTerminal.tsx's buildTerminalTheme,
// with its CSS-var reads swapped for the phone's palette. The fallbacks are
// XTerminal's (tuned for a dark background); every light theme sets its own
// `--term-*` palette, which arrives via TERM_PALETTES.
import { c, getTermPalette } from '../theme'

export function terminalTheme(): Record<string, string> {
  const bg = c.app
  const fg = c.fgBright
  const p = getTermPalette()
  const term = (name: string, fallback: string): string => p[name] || fallback
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    selectionBackground: term('selection', '#33415580'),
    black: term('black', bg),
    red: term('red', '#f87171'),
    green: term('green', '#4ade80'),
    yellow: term('yellow', '#facc15'),
    blue: term('blue', '#60a5fa'),
    magenta: term('magenta', '#c084fc'),
    cyan: term('cyan', '#22d3ee'),
    white: term('white', fg),
    brightBlack: term('brightBlack', '#525252'),
    brightRed: term('brightRed', '#fca5a5'),
    brightGreen: term('brightGreen', '#86efac'),
    brightYellow: term('brightYellow', '#fde68a'),
    brightBlue: term('brightBlue', '#93c5fd'),
    brightMagenta: term('brightMagenta', '#d8b4fe'),
    brightCyan: term('brightCyan', '#67e8f9'),
    brightWhite: term('brightWhite', '#fafafa')
  }
}
