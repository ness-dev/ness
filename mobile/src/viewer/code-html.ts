// HTML for the file and diff viewers' WebView. A WebView rather than RN
// Text rows: a several-thousand-line file stays one cheap document with
// native selection, sideways scrolling and pinch-zoom, where a View per
// line would need virtualizing in two directions at once.
//
// Highlighting is highlight.js (the desktop's renderer/syntax.ts, run on
// the RN side), coloured with the theme's --syntax-* tokens exactly as
// styles.css maps them.
import { detectLanguage, highlightToLines } from '../../../src/renderer/syntax'
import { c, getThemeMode, mono } from '../theme'
import type { UnifiedDiff } from './diff-model'

/** hljs on Hermes is an interpreter's worth of slow: past this a file is
 *  shown plain rather than freezing the JS thread for seconds. */
const HIGHLIGHT_LIMIT = 256 * 1024

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Per-line highlighted HTML for a whole text. Highlighting the whole file
 *  (not line by line) keeps multi-line strings and comments right. */
export function highlightedLines(text: string, filePath: string): string[] {
  const lang = text.length <= HIGHLIGHT_LIMIT ? detectLanguage(filePath) : null
  return highlightToLines(text, lang)
}

function page(body: string, digits: number): string {
  const gutterCh = digits + 2
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
<style>
:root { color-scheme: ${getThemeMode()}; }
html, body { margin: 0; background: ${c.app}; color: ${c.fg}; -webkit-text-size-adjust: none; }
body { font: 12px/18px ${mono}, ui-monospace, monospace; padding: 4px 0 40px; }
.w { display: inline-block; min-width: 100%; }
.r { display: flex; white-space: pre; min-height: 18px; }
.g { position: sticky; left: 0; flex: none; box-sizing: border-box; padding: 0 8px 0 4px; text-align: right;
     color: ${c.faint}; background: ${c.app}; -webkit-user-select: none; user-select: none; }
.t { padding: 0 12px 0 4px; }
.add { background: ${tint(c.success, 0.14)}; } .add .g { background: ${blend(c.app, c.success, 0.2)}; color: ${c.success}; }
.del { background: ${tint(c.danger, 0.14)}; } .del .g { background: ${blend(c.app, c.danger, 0.2)}; color: ${c.danger}; }
.h { color: ${c.info}; background: ${c.panel}; margin: 6px 0 2px; }
.h .t { position: sticky; left: 0; padding-left: 8px; }
.f { color: ${c.fgBright}; background: ${c.panelRaised}; font-weight: 600; margin-top: 10px;
     border-top: 1px solid ${c.border}; border-bottom: 1px solid ${c.border}; }
.f .t { position: sticky; left: 0; padding: 4px 8px; }
.r:first-child.h, .r:first-child.f { margin-top: 0; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag, .hljs-tag, .hljs-name { color: ${c.syntaxKeyword}; }
.hljs-built_in, .hljs-type, .hljs-class .hljs-title, .hljs-title.class_, .hljs-title, .hljs-link { color: ${c.syntaxType}; }
.hljs-string, .hljs-regexp, .hljs-symbol, .hljs-template-tag, .hljs-template-variable { color: ${c.syntaxString}; }
.hljs-number, .hljs-meta, .hljs-section, .hljs-bullet { color: ${c.syntaxNumber}; }
.hljs-comment, .hljs-quote { color: ${c.syntaxComment}; font-style: italic; }
.hljs-variable, .hljs-attr, .hljs-attribute, .hljs-property { color: ${c.syntaxVariable}; }
.hljs-params { color: ${c.syntaxParams}; }
.hljs-deletion { color: ${c.syntaxDeletion}; } .hljs-addition { color: ${c.syntaxAddition}; }
.hljs-link { text-decoration: underline; } .hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 600; }
.g { width: ${gutterCh}ch; } .d .g { width: ${gutterCh * 2 + 2}ch; }
</style></head><body><div class="w">${body}</div></body></html>`
}

/** A file, one row per line with its number. */
export function fileHtml(text: string, filePath: string): string {
  const lines = highlightedLines(text, filePath)
  // A trailing newline isn't a line of its own (editors don't number it).
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const body = lines.map((l, i) => `<div class="r"><span class="g">${i + 1}</span><span class="t">${l}</span></div>`).join('')
  return page(body, String(lines.length).length)
}

/** A unified diff: hunk headers, then each line with its old and new
 *  numbers and a +/− marker in one sticky gutter. Lines are highlighted
 *  from the full side they came from, so context is never lost mid-hunk. */
export function diffHtml(diff: UnifiedDiff, sides?: { original: string; modified: string; filePath: string }): string {
  const oldLines = sides ? highlightedLines(sides.original, sides.filePath) : []
  const newLines = sides ? highlightedLines(sides.modified, sides.filePath) : []
  let maxNo = 1
  for (const r of diff.rows) if (r.kind === 'line') maxNo = Math.max(maxNo, r.oldNo ?? 0, r.newNo ?? 0)
  const digits = String(maxNo).length
  const pad = (n: number | null) => (n === null ? '' : String(n)).padStart(digits, ' ')
  const body = diff.rows
    .map((r) => {
      if (r.kind === 'file') return `<div class="r f"><span class="t">${esc(r.path)}</span></div>`
      if (r.kind === 'hunk') return `<div class="r h"><span class="t">${esc(r.header)}</span></div>`
      const html = (r.type === 'del' ? oldLines[(r.oldNo ?? 1) - 1] : newLines[(r.newNo ?? 1) - 1]) ?? esc(r.text)
      const mark = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '
      return `<div class="r ${r.type}"><span class="g">${pad(r.oldNo)} ${pad(r.newNo)} ${mark}</span><span class="t">${html}</span></div>`
    })
    .join('')
  return page(`<div class="d">${body}</div>`, digits)
}

function hex(h: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})/i.exec(h)
  const n = m ? parseInt(m[1], 16) : 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function tint(color: string, a: number): string {
  const [r, g, b] = hex(color)
  return `rgba(${r},${g},${b},${a})`
}

/** Opaque mix, for the sticky gutter: a translucent one would let the code
 *  scrolling under it show through. */
function blend(base: string, over: string, a: number): string {
  const [r1, g1, b1] = hex(base)
  const [r2, g2, b2] = hex(over)
  const mix = (x: number, y: number) => Math.round(x + (y - x) * a)
  return `rgb(${mix(r1, r2)},${mix(g1, g2)},${mix(b1, b2)})`
}
