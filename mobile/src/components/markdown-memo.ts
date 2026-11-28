// Markdown's Block memo: is a re-parsed block the same as last time? A
// streamed reply is re-parsed per token, so every block is a fresh mdast
// object. Its `position` shifts whenever text before it changes; nothing
// else should differ for an unchanged block. Anything a plugin writes to
// `data` (remarkInsight's streaming flag, remarkMermaid's closedness) is
// compared, so a block whose rendering inputs changed still re-renders.
// test/markdown-parse.test.ts pins that against the real processors.
import type { TextStyle } from 'react-native'

export interface BlockCtx {
  base: TextStyle
  size: number
}

export function sameCtx(a: BlockCtx, b: BlockCtx): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  const ka = Object.keys(a.base) as (keyof TextStyle)[]
  return ka.length === Object.keys(b.base).length && ka.every((k) => a.base[k] === b.base[k])
}

export function sameNode(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameNode(x, b[i]))
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra).filter((k) => k !== 'position')
  if (ka.length !== Object.keys(rb).filter((k) => k !== 'position').length) return false
  return ka.every((k) => sameNode(ra[k], rb[k]))
}
