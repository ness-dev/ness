// Just enough markdown to make assistant text read like the web chat:
// paragraphs, fenced code, headings, bullets, `inline code`, **bold**.
// The desktop uses react-markdown + rehype-highlight; a real app would
// swap this for a proper RN markdown renderer.
import { Fragment } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { c, fs, mono } from '../theme'

export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactElement[] = []
  const parts = text.split(/```[^\n]*\n([\s\S]*?)```/g)
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      blocks.push(
        <ScrollView key={i} horizontal style={s.codeBlock} contentContainerStyle={{ padding: 10 }}>
          <Text style={s.codeBlockText}>{part.replace(/\n$/, '')}</Text>
        </ScrollView>
      )
      return
    }
    for (const [j, para] of part.split(/\n{2,}/).entries()) {
      const trimmed = para.trim()
      if (!trimmed) continue
      const key = `${i}-${j}`
      const h = /^(#{1,3})\s+(.*)$/.exec(trimmed)
      if (h) {
        blocks.push(
          <Text key={key} style={[s.p, s.heading]}>
            <Inline text={h[2]} />
          </Text>
        )
        continue
      }
      const lines = trimmed.split('\n')
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        blocks.push(
          <View key={key} style={{ gap: 4 }}>
            {lines.map((l, k) => {
              const m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(l)!
              return (
                <View key={k} style={{ flexDirection: 'row', gap: 8, paddingLeft: 4 }}>
                  <Text style={[s.p, { color: c.dim }]}>{m[1] === '-' || m[1] === '*' ? '•' : m[1]}</Text>
                  <Text style={[s.p, { flex: 1 }]}>
                    <Inline text={m[2]} />
                  </Text>
                </View>
              )
            })}
          </View>
        )
        continue
      }
      blocks.push(
        <Text key={key} style={s.p}>
          <Inline text={trimmed} />
        </Text>
      )
    }
  })
  return <View style={{ gap: 10 }}>{blocks}</View>
}

function Inline({ text }: { text: string }) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return (
    <>
      {tokens.map((t, i) => {
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
        return <Fragment key={i}>{t}</Fragment>
      })}
    </>
  )
}

const s = StyleSheet.create({
  p: { color: c.fg, fontSize: fs.sm, lineHeight: 21 },
  heading: { color: c.fgBright, fontWeight: '600', fontSize: 15 },
  code: { fontFamily: mono, fontSize: 12.6, backgroundColor: c.panelRaised, color: c.fg },
  codeBlock: { backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, borderRadius: 6 },
  codeBlockText: { fontFamily: mono, fontSize: 12, lineHeight: 18, color: c.fg }
})
