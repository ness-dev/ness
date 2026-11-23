import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { USER_REMARK_PLUGINS } from './remark-user-text'

function render(md: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: USER_REMARK_PLUGINS }, md)
  )
}

describe('user-text markdown', () => {
  it('keeps a single newline as a line break', () => {
    expect(render('first line\nsecond line')).toBe('<p>first line<br/>\nsecond line</p>')
  })

  it('does not turn indented text into a code block', () => {
    const html = render('see this:\n\n    indented note')
    expect(html).not.toContain('<pre>')
    expect(html).toContain('indented note')
  })

  it('still renders fenced code', () => {
    expect(render('```ts\nconst x = 1\n```')).toContain('<pre><code class="language-ts">')
  })

  it('renders lists and inline formatting', () => {
    const html = render('- **bold** item\n- `code` item')
    expect(html).toContain('<ul>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
  })

  it('keeps angle-bracket text the user typed', () => {
    expect(render('wrap it in <Provider> please')).toContain('&lt;Provider&gt;')
  })

  // Automated cards and held notices use these plugins too: Ness-composed
  // bodies (e.g. review-spawner's CI-green context) join lines with '\n'.
  it('keeps the lines of a Ness-composed body apart', () => {
    const html = render('PR title: Fix login\nPR: https://github.com/o/r/pull/1')
    expect(html).toContain('Fix login<br/>')
  })

  // Deliberate: GFM reads a closing `__` before punctuation as strong, so
  // a bare `__init__.py` bolds. Backticks are the escape hatch.
  it('renders a bare __init__.py as strong, like GFM', () => {
    expect(render('edit __init__.py')).toContain('<strong>init</strong>.py')
  })
})
