// What the markdown parser actually hands the chat's <img> component, and
// what our src/alt parsers make of it. The size syntax we document to
// agents lives or dies here: a spec that the parser mangles before the
// component ever sees it can't be fixed downstream.
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  parseImageAlt,
  parseImageTitle,
  resolveLocalImageSrc,
  type ImageSizeHint
} from '../shared/chat-image-src'

interface Embed {
  path: string | null
  size: ImageSizeHint | null
}

/** Render markdown the way the chat does and report every image that came
 *  out, resolved through the same parsers MarkdownImage uses. */
function embeds(md: string): Embed[] {
  const out: Embed[] = []
  const Img = (props: { src?: string; alt?: string; title?: string }): null => {
    const local = resolveLocalImageSrc(props.src)
    out.push({
      path: local?.path ?? null,
      size:
        parseImageAlt(props.alt).size ??
        parseImageTitle(props.title).size ??
        local?.size ??
        null
    })
    return null
  }
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { remarkPlugins: [remarkGfm], components: { img: Img } } as any,
      md
    )
  )
  return out
}

const TABLE = (cell: string): string =>
  ['| shot | note |', '| --- | --- |', `| ${cell} | x |`].join('\n')

describe('chat image embeds — prose', () => {
  it('sizes via a #w= fragment', () => {
    expect(embeds('![cap](/tmp/a.png#w=300)')).toEqual([
      { path: '/tmp/a.png', size: { width: 300 } }
    ])
    expect(embeds('![cap](/tmp/a.png#w=50%)')[0].size).toEqual({ widthPercent: 50 })
    expect(embeds('![cap](/tmp/a.png#w=400x300)')[0].size).toEqual({
      width: 400,
      height: 300
    })
  })

  it('still honours the alt-pipe and =title forms', () => {
    expect(embeds('![cap|300](/tmp/a.png)')).toEqual([
      { path: '/tmp/a.png', size: { width: 300 } }
    ])
    expect(embeds('![cap](/tmp/a.png "=300x")')).toEqual([
      { path: '/tmp/a.png', size: { width: 300 } }
    ])
  })

  it('renders unsized when no spec is given', () => {
    expect(embeds('![cap](/tmp/a.png)')).toEqual([{ path: '/tmp/a.png', size: null }])
  })
})

describe('chat image embeds — inside a GFM table cell', () => {
  // The bug this file exists for. A pipe in a table row is a column
  // delimiter, so GFM splits `![cap|300](path)` into `![cap` and
  // `300](path)` before inline parsing — no image node is produced at all
  // and the cells render as broken literal text. That's why the documented
  // syntax is the fragment, not the pipe.
  it('the pipe form produces NO image — this is why we stopped teaching it', () => {
    expect(embeds(TABLE('![cap|300](/tmp/a.png)'))).toEqual([])
  })

  it('the fragment form survives, sized', () => {
    expect(embeds(TABLE('![cap](/tmp/a.png#w=300)'))).toEqual([
      { path: '/tmp/a.png', size: { width: 300 } }
    ])
  })

  it('the =title form survives too', () => {
    expect(embeds(TABLE('![cap](/tmp/a.png "=300x")'))[0].size).toEqual({ width: 300 })
  })

  it('an escaped pipe survives, for markdown that already uses it', () => {
    expect(embeds(TABLE('![cap\\|300](/tmp/a.png)'))).toEqual([
      { path: '/tmp/a.png', size: { width: 300 } }
    ])
  })
})
