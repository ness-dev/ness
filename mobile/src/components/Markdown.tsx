// Enough markdown for chat to read like the web client: paragraphs,
// fenced code, headings, bullet/numbered lists, blockquotes, `inline
// code`, **bold**, *italic*, [links](url). The desktop uses react-markdown
// + GFM; a real app would swap in a full RN markdown renderer.
// `preserveNewlines` mirrors USER_REMARK_PLUGINS (typed prompts keep
// single line breaks instead of reflowing them into one paragraph).
import { memo, type ReactElement } from 'react'
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native'
import { c, mono } from '../theme'

interface Props {
  text: string
  size?: number
  color?: string
  italic?: boolean
  preserveNewlines?: boolean
}

export const Markdown = memo(function Markdown({ text, size = 14, color = c.fg, italic, preserveNewlines }: Props) {
  const base = { color, fontSize: size, lineHeight: Math.round(size * 1.5), fontStyle: italic ? ('italic' as const) : undefined }
  const blocks: ReactElement[] = []
  const parts = text.split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g)
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      blocks.push(
        <ScrollView key={i} horizontal style={s.codeBlock} contentContainerStyle={{ padding: 10 }} nestedScrollEnabled>
          <Text selectable style={s.codeBlockText}>
            {part.replace(/\n$/, '')}
          </Text>
        </ScrollView>
      )
      return
    }
    for (const [j, para] of part.split(/\n{2,}/).entries()) {
      const trimmed = para.replace(/^\n+|\n+$/g, '')
      if (!trimmed.trim()) continue
      const key = `${i}-${j}`
      const h = /^(#{1,6})\s+(.*)$/.exec(trimmed)
      if (h) {
        blocks.push(
          <Text key={key} style={[base, { color: c.fgBright, fontWeight: '600', fontSize: size + (h[1].length <= 2 ? 2 : 0) }]}>
            <Inline text={h[2]} />
          </Text>
        )
        continue
      }
      const lines = trimmed.split('\n')
      if (lines.every((l) => /^\s*>/.test(l))) {
        blocks.push(
          <View key={key} style={{ borderLeftWidth: 2, borderColor: c.borderStrong, paddingLeft: 10 }}>
            <Text style={[base, { color: c.muted }]}>
              <Inline text={lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n')} />
            </Text>
          </View>
        )
        continue
      }
      if (lines.every((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s{2,}\S/.test(l))) {
        blocks.push(
          <View key={key} style={{ gap: 4 }}>
            {lines.map((l, k) => {
              const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l)
              if (!m) return null
              const indent = Math.min(3, Math.floor(m[1].length / 2))
              const bullet = /\d/.test(m[2]) ? m[2] : '•'
              return (
                <View key={k} style={{ flexDirection: 'row', gap: 8, paddingLeft: 4 + indent * 14 }}>
                  <Text style={[base, { color: c.dim }]}>{bullet}</Text>
                  <Text style={[base, { flex: 1 }]}>
                    <Inline text={m[3]} />
                  </Text>
                </View>
              )
            })}
          </View>
        )
        continue
      }
      blocks.push(
        <Text key={key} style={base} selectable>
          <Inline text={preserveNewlines ? trimmed : trimmed.replace(/\n(?!\n)/g, ' ')} />
        </Text>
      )
    }
  })
  return <View style={{ gap: 10 }}>{blocks}</View>
})

function Inline({ text }: { text: string }) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*\n]*\*)/g)
  return (
    <>
      {tokens.map((t, i) => {
        if (!t) return null
        if (t.startsWith('`') && t.endsWith('`') && t.length > 1)
          return (
            <Text key={i} style={s.code}>
              {t.slice(1, -1)}
            </Text>
          )
        if (t.startsWith('**') && t.endsWith('**'))
          return (
            <Text key={i} style={{ fontWeight: '600', color: c.fgBright }}>
              {t.slice(2, -2)}
            </Text>
          )
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)
        if (link)
          return (
            <Text key={i} style={{ color: c.info, textDecorationLine: 'underline' }} onPress={() => void Linking.openURL(link[2])}>
              {link[1]}
            </Text>
          )
        if (t.length > 2 && t.startsWith('*') && t.endsWith('*'))
          return (
            <Text key={i} style={{ fontStyle: 'italic' }}>
              {t.slice(1, -1)}
            </Text>
          )
        return t
      })}
    </>
  )
}

const s = StyleSheet.create({
  code: { fontFamily: mono, fontSize: 12.6, backgroundColor: c.panelRaised, color: c.fg },
  codeBlock: { backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, borderRadius: 6 },
  codeBlockText: { fontFamily: mono, fontSize: 12, lineHeight: 18, color: c.fg }
})
