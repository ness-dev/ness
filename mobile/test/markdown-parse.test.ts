// The app's chat markdown must parse exactly as the desktop's: the same
// remark plugin lists (renderer/chat-remark-plugins.ts). These check the
// node types Markdown.tsx draws actually come out of that pipeline.
import { describe, expect, it } from 'vitest'
import { unified, type PluggableList } from 'unified'
import remarkParse from 'remark-parse'
import type { Root } from 'mdast'
import { ASSISTANT_REMARK_PLUGINS, USER_REMARK_PLUGINS } from '../../src/renderer/chat-remark-plugins'

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
