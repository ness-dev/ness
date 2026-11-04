import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Code, Root } from 'mdast'
import { closedMermaidBodies, remarkMermaid } from './remark-mermaid'
import { remarkInsight } from './remark-insight'

function codeNodes(md: string, plugins: Array<() => (tree: Root, file?: { value?: unknown }) => void>): Code[] {
  let processor = unified().use(remarkParse).use(remarkGfm)
  for (const p of plugins) processor = processor.use(p)
  const tree = processor.runSync(processor.parse(md), md) as Root
  const out: Code[] = []
  const walk = (n: { type: string; children?: unknown[] }): void => {
    if (n.type === 'code') out.push(n as Code)
    for (const c of (n.children ?? []) as Array<{ type: string; children?: unknown[] }>) walk(c)
  }
  walk(tree)
  return out
}

const closed = (c: Code): boolean =>
  (c.data?.hProperties as Record<string, unknown> | undefined)?.dataMermaid === 'closed'

describe('closedMermaidBodies', () => {
  it('collects only fences that have closed', () => {
    const md = '```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\ngraph LR\n  X-->'
    expect([...closedMermaidBodies(md)]).toEqual(['graph TD\n  A-->B'])
  })

  it('needs the same fence character and at least the same length', () => {
    expect(closedMermaidBodies('````mermaid\na\n```\n').size).toBe(0)
    expect(closedMermaidBodies('~~~mermaid\na\n```\n').size).toBe(0)
    expect(closedMermaidBodies('~~~mermaid\na\n~~~~\n').size).toBe(1)
  })
})

describe('remarkMermaid', () => {
  it('marks a finished mermaid block and leaves one still streaming', () => {
    const done = codeNodes('```mermaid\ngraph TD\n  A-->B\n```\n', [remarkMermaid])
    expect(done.map(closed)).toEqual([true])
    const streaming = codeNodes('```mermaid\ngraph TD\n  A-->B\n', [remarkMermaid])
    expect(streaming.map(closed)).toEqual([false])
  })

  it('ignores other languages', () => {
    expect(codeNodes('```ts\nconst a = 1\n```\n', [remarkMermaid]).map(closed)).toEqual([false])
  })

  it('still finds a block inside an Insight card, which is re-parsed', () => {
    const md = '★ Insight ─────\n```mermaid\ngraph TD\n  A-->B\n```\n─────\n'
    expect(codeNodes(md, [remarkInsight, remarkMermaid]).map(closed)).toEqual([true])
  })
})
