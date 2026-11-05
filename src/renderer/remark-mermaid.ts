import type { Root, Code, Parent } from 'mdast'

// Marks ```mermaid blocks whose closing fence has arrived, so the renderer
// draws a diagram only for finished source. A block still streaming in is
// left as a code block: rendering a half-written diagram on every token
// would fail to parse most of the time and re-run mermaid per token.
//
// Closedness is read from the raw source rather than node positions,
// because remarkInsight re-parses Insight bodies and their positions are
// relative to the segment, not the message. A block counts as closed when
// some closed mermaid fence in the source has the same body.
//
// Bodies are compared line-trimmed: remark strips the list-item and fence
// indent from `code.value`, so a fence nested under a bullet or inside a
// blockquote has different leading whitespace in the raw source.

const OPEN_RE = /^(`{3,}|~{3,})\s*mermaid\s*$/i
const FENCE_RE = /^(`{3,}|~{3,})\s*$/

/** A source line without its container prefix: indentation and any
 *  blockquote markers. */
function unprefixed(line: string): string {
  return line.replace(/^(?:\s*>)*\s*/, '')
}

export function mermaidKey(body: string): string {
  return body
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim()
}

export function closedMermaidBodies(source: string): Set<string> {
  const closed = new Set<string>()
  const lines = source.split('\n').map(unprefixed)
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_RE.exec(lines[i])?.[1]
    if (!open) continue
    for (let j = i + 1; j < lines.length; j++) {
      const fence = FENCE_RE.exec(lines[j])?.[1]
      if (fence && fence[0] === open[0] && fence.length >= open.length) {
        closed.add(mermaidKey(lines.slice(i + 1, j).join('\n')))
        i = j
        break
      }
    }
  }
  return closed
}

function walk(node: Root | Parent, closed: Set<string>): void {
  for (const child of node.children) {
    if (child.type === 'code') {
      const code = child as Code
      if (code.lang?.toLowerCase() === 'mermaid' && closed.has(mermaidKey(code.value))) {
        code.data = {
          ...code.data,
          hProperties: { ...code.data?.hProperties, dataMermaid: 'closed' }
        }
      }
    } else if ('children' in child) {
      walk(child as Parent, closed)
    }
  }
}

export function remarkMermaid() {
  return (tree: Root, file?: { value?: unknown }) => {
    const source = typeof file?.value === 'string' ? file.value : null
    if (source === null || !/mermaid/i.test(source)) return
    const closed = closedMermaidBodies(source)
    if (closed.size > 0) walk(tree, closed)
  }
}
