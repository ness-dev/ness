// Chat markdown, parsed exactly as the desktop parses it — remark with the
// shared plugin lists (renderer/chat-remark-plugins.ts: GFM tables,
// strikethrough, task lists and autolinks, Insight cards, mermaid) — and
// the resulting mdast drawn with React Native views instead of
// react-markdown's DOM. A message renders the same blocks on both.
//
// `preserveNewlines` selects USER_REMARK_PLUGINS (text a person typed:
// single newlines stay line breaks, indentation is never code).
//
// Finished ```mermaid blocks (remarkMermaid's dataMermaid: 'closed') draw
// as diagrams; one still streaming stays code, as on desktop. Not drawn
// yet: syntax highlighting.
import { memo, useMemo, useState, type ReactNode } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, RootContent, PhrasingContent, Table, List, Image, Nodes } from 'mdast'
import { ASSISTANT_REMARK_PLUGINS, USER_REMARK_PLUGINS } from '../../../src/renderer/chat-remark-plugins'
import { parseImageAlt, parseImageTitle, resolveLocalImageSrc } from '../../../src/shared/chat-image-src'
import { c, fs, mono, themed } from '../theme'
import { ChatImage } from '../chat/ChatImage'
import { CopyableMessage } from '../chat/CopyText'
import { MermaidDiagram } from './MermaidDiagram'

const assistantProcessor = unified().use(remarkParse).use(ASSISTANT_REMARK_PLUGINS).freeze()
const userProcessor = unified().use(remarkParse).use(USER_REMARK_PLUGINS).freeze()

function parse(text: string, user: boolean): Root {
  const p = user ? userProcessor : assistantProcessor
  // The source goes in as the VFile too: remarkInsight and remarkMermaid
  // read raw lines off it.
  return p.runSync(p.parse(text), text) as Root
}

interface Props {
  text: string
  size?: number
  color?: string
  italic?: boolean
  preserveNewlines?: boolean
}

interface Ctx {
  base: TextStyle
  size: number
}

export const Markdown = memo(function Markdown({ text, size = 14, color = c.fg, italic, preserveNewlines }: Props) {
  const tree = useMemo(() => parse(text, !!preserveNewlines), [text, preserveNewlines])
  const ctx: Ctx = {
    base: { color, fontSize: size, lineHeight: Math.round(size * 1.5), fontStyle: italic ? 'italic' : undefined },
    size
  }
  return <Blocks nodes={tree.children} ctx={ctx} />
})

function Blocks({ nodes, ctx }: { nodes: readonly RootContent[]; ctx: Ctx }) {
  return <View style={{ gap: 10 }}>{nodes.map((n, i) => <Block key={i} node={n} ctx={ctx} />)}</View>
}

function Block({ node, ctx }: { node: RootContent; ctx: Ctx }): ReactNode {
  switch (node.type) {
    case 'paragraph': {
      // remarkInsight's card: a paragraph renamed via data.hName whose
      // children are the re-parsed body blocks.
      const data = node.data as { hName?: string; hProperties?: { streaming?: boolean } } | undefined
      if (data?.hName === 'insight-card') {
        return <InsightCard nodes={node.children as unknown as RootContent[]} streaming={!!data.hProperties?.streaming} ctx={ctx} />
      }
      const images = node.children.filter((ch): ch is Image => ch.type === 'image')
      const inline = images.length ? node.children.filter((ch) => ch.type !== 'image') : node.children
      const hasText = inline.some((ch) => ch.type !== 'text' || ch.value.trim())
      return (
        <>
          {hasText && (
            <Text style={ctx.base}>
              <Inlines nodes={inline} />
            </Text>
          )}
          {images.length > 0 && <ImageRow images={images} />}
        </>
      )
    }
    case 'heading':
      return (
        <Text style={[ctx.base, { color: c.fgBright, fontWeight: '600', fontSize: ctx.size + (node.depth <= 2 ? 2 : 0) }]}>
          <Inlines nodes={node.children} />
        </Text>
      )
    case 'thematicBreak':
      return <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />
    case 'blockquote':
      return (
        <View style={{ borderLeftWidth: 2, borderColor: c.borderStrong, paddingLeft: 10 }}>
          <Blocks nodes={node.children} ctx={{ ...ctx, base: { ...ctx.base, color: c.muted } }} />
        </View>
      )
    case 'list':
      return <ListBlock node={node} ctx={ctx} />
    case 'code': {
      const block = <CodeBlock code={node.value} />
      return node.data?.hProperties?.dataMermaid === 'closed' ? <MermaidDiagram source={node.value} fallback={block} /> : block
    }
    case 'table':
      return <TableBlock node={node} ctx={ctx} />
    case 'html':
      return <Text style={[ctx.base, { fontFamily: mono, fontSize: ctx.size - 1, color: c.dim }]}>{node.value}</Text>
    case 'footnoteDefinition':
      return (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Text style={[ctx.base, { color: c.dim, fontSize: fs.xs }]}>[{node.label ?? node.identifier}]</Text>
          <View style={{ flex: 1 }}>
            <Blocks nodes={node.children} ctx={{ ...ctx, base: { ...ctx.base, fontSize: fs.xs, lineHeight: 18 } }} />
          </View>
        </View>
      )
    default:
      // definition, yaml, …: nothing visible.
      return null
  }
}

function Inlines({ nodes }: { nodes: readonly PhrasingContent[] }) {
  return <>{nodes.map((n, i) => <Inline key={i} node={n} />)}</>
}

function Inline({ node }: { node: PhrasingContent }): ReactNode {
  switch (node.type) {
    case 'text':
      // A soft line break inside a paragraph is whitespace, as in HTML.
      // (USER_REMARK_PLUGINS turns them into `break` nodes instead.)
      return node.value.replace(/\n/g, ' ')
    case 'break':
      return '\n'
    case 'emphasis':
      return (
        <Text style={{ fontStyle: 'italic' }}>
          <Inlines nodes={node.children} />
        </Text>
      )
    case 'strong':
      return (
        <Text style={{ fontWeight: '600', color: c.fgBright }}>
          <Inlines nodes={node.children} />
        </Text>
      )
    case 'delete':
      return (
        <Text style={{ textDecorationLine: 'line-through', color: c.dim }}>
          <Inlines nodes={node.children} />
        </Text>
      )
    case 'inlineCode':
      return <Text style={s.code}>{node.value}</Text>
    case 'link':
      return (
        <Text style={{ color: c.info, textDecorationLine: 'underline' }} onPress={() => void Linking.openURL(node.url)}>
          <Inlines nodes={node.children} />
        </Text>
      )
    case 'footnoteReference':
      return <Text style={{ color: c.dim, fontSize: fs.xs }}>[{node.label ?? node.identifier}]</Text>
    case 'html':
      return node.value
    default:
      // image (drawn at paragraph level), imageReference, linkReference.
      return 'children' in node ? <Inlines nodes={(node as { children: PhrasingContent[] }).children} /> : null
  }
}

function ListBlock({ node, ctx }: { node: List; ctx: Ctx }) {
  const start = node.start ?? 1
  return (
    <View style={{ gap: 4 }}>
      {node.children.map((item, i) => {
        const marker = item.checked === true ? '☑' : item.checked === false ? '☐' : node.ordered ? `${start + i}.` : '•'
        return (
          <View key={i} style={{ flexDirection: 'row', gap: 8, paddingLeft: 4 }}>
            <Text style={[ctx.base, { color: c.dim, minWidth: node.ordered ? 18 : undefined }]}>{marker}</Text>
            <View style={{ flex: 1 }}>
              <Blocks nodes={item.children} ctx={ctx} />
            </View>
          </View>
        )
      })}
    </View>
  )
}

function CodeBlock({ code }: { code: string }) {
  return (
    // Long-press selects just the code (the message's own long-press is
    // the next one out).
    <CopyableMessage text={code}>
      <ScrollView horizontal style={s.codeBlock} contentContainerStyle={{ padding: 10 }} nestedScrollEnabled>
        <Text style={s.codeBlockText}>{code}</Text>
      </ScrollView>
    </CopyableMessage>
  )
}

/** Plain text of a node, for sizing table columns. */
function textOf(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value
  if ('children' in node) return (node.children as Nodes[]).map(textOf).join('')
  return ''
}

// GFM table: columns sized from their longest cell (clamped) so every row
// lines up, and the whole table scrolls sideways when it's wider than the
// screen — the desktop's overflow-x: auto.
function TableBlock({ node, ctx }: { node: Table; ctx: Ctx }) {
  const cols = Math.max(...node.children.map((r) => r.children.length))
  // Average glyph width for the system font, a little generous so a word
  // never wraps mid-way; the header row is bold, so wider still.
  const charW = ctx.size * 0.62
  const widths = Array.from({ length: cols }, (_, ci) => {
    const longest = Math.max(
      ...node.children.map((r, ri) => {
        const len = r.children[ci] ? textOf(r.children[ci]).length : 0
        return ri === 0 ? len * 1.08 : len
      })
    )
    return Math.round(Math.min(260, Math.max(60, longest * charW + 24)))
  })
  return (
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
      <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 6, overflow: 'hidden' }}>
        {node.children.map((row, ri) => (
          <View key={ri} style={{ flexDirection: 'row', backgroundColor: ri === 0 ? c.panelRaised : ri % 2 ? 'transparent' : c.panel }}>
            {Array.from({ length: cols }, (_, ci) => {
              const cell = row.children[ci]
              const align = node.align?.[ci] ?? null
              return (
                <View
                  key={ci}
                  style={{
                    width: widths[ci],
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderTopWidth: ri === 0 ? 0 : 1,
                    borderLeftWidth: ci === 0 ? 0 : 1,
                    borderColor: c.border
                  }}
                >
                  <Text style={[ctx.base, { textAlign: align ?? 'left' }, ri === 0 && { fontWeight: '600', color: c.fgBright }]}>
                    {cell && <Inlines nodes={cell.children} />}
                  </Text>
                </View>
              )
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

// Same resolution + sizing rules as the desktop (shared chat-image-src):
// `#w=300` / `|400` / `"=400x300"` are size hints, not part of the path;
// an alt/title spec outranks a fragment.
function ImageRow({ images }: { images: Image[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {images.map((img, k) => {
        const alt = parseImageAlt(img.alt ?? '')
        const title = parseImageTitle(img.title ?? undefined)
        const local = resolveLocalImageSrc(img.url)
        const size = alt.size ?? title.size ?? local?.size ?? null
        return (
          <ChatImage
            key={k}
            path={local ? local.path : img.url}
            mediaType={local?.mediaType}
            alt={alt.alt}
            size={size ?? undefined}
            fit
          />
        )
      })}
    </View>
  )
}

// The desktop's InsightCard: "★ Insight" header that folds the body.
function InsightCard({ nodes, streaming, ctx }: { nodes: RootContent[]; streaming: boolean; ctx: Ctx }) {
  const [open, setOpen] = useState(true)
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderLeftWidth: 2, borderLeftColor: c.accent, borderRadius: 6, backgroundColor: c.panel }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, minHeight: 36 }}
      >
        <Text style={{ color: c.accent, fontSize: fs.xs }}>★</Text>
        <Text style={{ color: c.fgBright, fontSize: fs.xs, fontWeight: '600', flex: 1 }}>Insight</Text>
        <Text style={{ color: c.dim, fontSize: fs.xs }}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open && (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
          <Blocks nodes={nodes} ctx={ctx} />
          {streaming && <Text style={[ctx.base, { color: c.dim }]}>…</Text>}
        </View>
      )}
    </View>
  )
}

const s = themed(() => StyleSheet.create({
  code: { fontFamily: mono, fontSize: 12.6, backgroundColor: c.panelRaised, color: c.fg },
  codeBlock: { backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, borderRadius: 6 },
  codeBlockText: { fontFamily: mono, fontSize: 12, lineHeight: 18, color: c.fg }
}))
