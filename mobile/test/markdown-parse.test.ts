// The app's chat markdown must parse exactly as the desktop's: the same
// remark plugin lists (renderer/chat-remark-plugins.ts). These check the
// node types Markdown.tsx draws actually come out of that pipeline.
import { describe, expect, it } from 'vitest'
import { unified, type PluggableList } from 'unified'
import remarkParse from 'remark-parse'
import type { Root } from 'mdast'
import { ASSISTANT_REMARK_PLUGINS, USER_REMARK_PLUGINS } from '../../src/renderer/chat-remark-plugins'
import { sameCtx, sameNode } from '../src/components/markdown-memo'

const parse = (text: string, plugins: PluggableList = ASSISTANT_REMARK_PLUGINS): Root => {
  const p = unified().use(remarkParse).use(plugins)
  return p.runSync(p.parse(text), text) as Root
}

describe('chat markdown pipeline', () => {
  it('parses GFM tables with alignment', () => {
    const tree = parse('| a | b |\n|:--|--:|\n| 1 | 2 |\n')
    const table = tree.children[0]
    expect(table.type).toBe('table')
    if (table.type !== 'table') return
    expect(table.align).toEqual(['left', 'right'])
    expect(table.children).toHaveLength(2)
  })

  it('parses strikethrough and task lists', () => {
    const tree = parse('~~old~~\n\n- [x] done\n- [ ] todo\n')
    expect(JSON.stringify(tree)).toContain('"type":"delete"')
    const list = tree.children[1]
    expect(list.type === 'list' && list.children.map((i) => i.checked)).toEqual([true, false])
  })

  it('turns an Insight block into an insight-card node', () => {
    const tree = parse('`★ Insight ─────────`\n- one point\n`─────────────────`\n')
    const card = tree.children.find((n) => n.data?.hName === 'insight-card')
    expect(card).toBeDefined()
  })

  it('keeps single newlines as breaks in typed text', () => {
    const tree = parse('line one\nline two', USER_REMARK_PLUGINS)
    expect(JSON.stringify(tree)).toContain('"type":"break"')
  })
})

// Markdown memoises each block on sameNode, so a streamed token re-renders
// only the block that grew. That holds only if nothing but `position`
// differs between re-parses of an unchanged block, including what our
// plugins write to `data`, and if a block whose rendering inputs changed
// (an Insight or mermaid fence closing) compares unequal.
describe('Markdown block memo', () => {
  const blocks = (text: string) => parse(text).children
  const insight = '`★ Insight ─────────`\n- one point\n`─────────────────`'
  const code = '```ts\nconst x = 1\n```'
  const mermaid = '```mermaid\nflowchart TD\n  A --> B\n```'

  it('skips an unchanged block and re-renders the one that grew', () => {
    const [a1, b1] = blocks('first\n\nsecond')
    const [a2, b2] = blocks('first\n\nsecond more')
    expect(sameNode(a1, a2)).toBe(true)
    expect(sameNode(b1, b2)).toBe(false)
  })

  it('ignores position shifts from text before the block', () => {
    const before = blocks('x\n\nsame paragraph')[1]
    const after = blocks('x longer now\n\nsame paragraph')[1]
    expect(before.position).not.toEqual(after.position)
    expect(sameNode(before, after)).toBe(true)
  })

  it.each([
    ['a code block', code],
    ['a finished Insight card', insight],
    ['a closed mermaid block', mermaid]
  ])('keeps %s equal while a paragraph after it streams', (_name, block) => {
    const first = blocks(`${block}\n\ntail`)
    const second = blocks(`${block}\n\ntail grows`)
    expect(first.length).toBe(second.length)
    expect(sameNode(first[0], second[0])).toBe(true)
    expect(sameNode(first[first.length - 1], second[second.length - 1])).toBe(false)
  })

  it('re-renders an Insight card when it stops streaming', () => {
    const open = blocks('`★ Insight ─────────`\n- one point').find((n) => n.data?.hName === 'insight-card')
    const closed = blocks(insight).find((n) => n.data?.hName === 'insight-card')
    expect(open && closed).toBeTruthy()
    expect(sameNode(open, closed)).toBe(false)
  })

  it('re-renders a mermaid block when its closing fence arrives', () => {
    const open = blocks('```mermaid\nflowchart TD\n  A --> B\n')[0]
    const closed = blocks(mermaid)[0]
    expect(sameNode(open, closed)).toBe(false)
  })

  it('compares the render context by value', () => {
    const ctx = () => ({ base: { color: '#fff', fontSize: 14, lineHeight: 21 }, size: 14 })
    expect(sameCtx(ctx(), ctx())).toBe(true)
    expect(sameCtx(ctx(), { ...ctx(), base: { ...ctx().base, color: '#000' } })).toBe(false)
  })
})
