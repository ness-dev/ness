// Port of renderer/components/CustomToolPanel.tsx, including an RN port of
// the markdown vocabulary SidebarMarkdown.tsx maps tool output onto
// (react-markdown + GFM isn't available here, so this is a small block +
// inline parser covering exactly the elements that map renders).
import { useCallback, useMemo, type ReactNode } from 'react'
import { Alert, Pressable, ScrollView, Text, View, StyleSheet } from 'react-native'
import { RefreshCw, TriangleAlert } from 'lucide-react-native'
import type { ToolRunResult, ToolSpec } from '../../../src/shared/tools'
import { toolPanelKey } from '../../../src/shared/state/repo-configs'
import { Spin } from '../components/Spin'
import { alpha, c, fs, mono, themed } from '../theme'
import { PanelAction, RightPanel } from './RightPanel'
import { useWatchedQuery } from './useWatchedQuery'
import type { PanelProps } from './types'

interface NessLinkAction {
  verb: string
  params: Map<string, string>
}

export function CustomToolPanel({ client, worktreePath, onSendToAgent, onOpenUrl, spec }: PanelProps & { spec: ToolSpec }) {
  const fetcher = useCallback((path: string) => client.api.runTool(path, spec.id), [client, spec.id])

  const { data, loading, refresh } = useWatchedQuery<ToolRunResult>({
    client,
    worktreePath,
    cacheKey: `tool:${spec.id}`,
    fetcher,
    // A `manual` tool still runs on mount and on the refresh button, but
    // never on a timer or a git change — tool scripts routinely hit the
    // network, and the built-in panels' cadence would hammer an API.
    fallbackPollMs: spec.refresh === 'auto' ? 30000 : 0,
    revalidateOnFileChange: spec.refresh === 'auto'
  })

  const handleAction = useCallback(
    (action: NessLinkAction) => {
      if (action.verb === 'send') {
        const text = action.params.get('text')
        if (text) onSendToAgent(text)
        return
      }
      // `ness:file` opens a file tab on desktop (onOpenFile) — desktop-only, ignored.
      if (action.verb === 'refresh') refresh()
    },
    [onSendToAgent, refresh]
  )

  if (!worktreePath) return null

  const actions = (
    <>
      {data && !data.ok && (
        // Tooltip on desktop; tap to read the error here.
        <PanelAction onPress={() => Alert.alert(spec.title, data.error || 'Tool failed')} label={data.error || 'Tool failed'}>
          <TriangleAlert color={c.warning} size={12} />
        </PanelAction>
      )}
      <PanelAction onPress={() => refresh()} label="Refresh">
        {loading ? (
          <Spin>
            <RefreshCw color={c.faint} size={12} />
          </Spin>
        ) : (
          <RefreshCw color={c.faint} size={12} />
        )}
      </PanelAction>
    </>
  )

  const body = data?.markdown?.trim()

  return (
    <RightPanel id={toolPanelKey(spec.id)} title={spec.title} actions={actions}>
      {/* max-h-56 on desktop; taller here for 44pt rows. */}
      <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
        {!data && loading && <Text style={{ paddingHorizontal: 12, paddingVertical: 8, fontSize: fs.xs, color: c.faint }}>Running…</Text>}
        {body ? (
          <SidebarMarkdown markdown={body} onAction={handleAction} onOpenUrl={onOpenUrl} />
        ) : (
          data && (
            <Text style={{ paddingHorizontal: 12, paddingVertical: 8, fontSize: fs.xs, color: c.faint, fontStyle: 'italic' }}>
              {data.ok ? 'No output' : data.error || 'Tool failed'}
            </Text>
          )
        )}
      </ScrollView>
    </RightPanel>
  )
}

// ---------------------------------------------------------------------------
// SidebarMarkdown port. Same mapping: h1/h2 → section bar, h3 → light
// uppercase subheading, h4+ → muted subheading, list item → one truncated
// row, `code` → mono chip, **bold** → bright, *em* → faint italic,
// > → indented note, --- → divider, tables render cramped, images dropped,
// raw HTML inert. Links: `ness:` → onAction, http(s) → system browser,
// anything else → inert text.
// ---------------------------------------------------------------------------

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'li'; text: string }
  | { t: 'p'; text: string }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'pre'; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }

const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
}

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const endPara = (): void => {
    if (para.length) out.push({ t: 'p', text: para.join(' ') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      endPara()
      const body: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i])
      out.push({ t: 'pre', text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      endPara()
      continue
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      endPara()
      out.push({ t: 'h', level: h[1].length, text: h[2] })
      continue
    }
    if (HR_RE.test(line)) {
      // `text\n---` is a setext h2 in markdown.
      if (para.length && /^\s*-+\s*$/.test(line)) {
        out.push({ t: 'h', level: 2, text: para.join(' ') })
        para = []
      } else {
        endPara()
        out.push({ t: 'hr' })
      }
      continue
    }
    const li = LIST_RE.exec(line)
    if (li) {
      endPara()
      out.push({ t: 'li', text: li[1] })
      continue
    }
    if (/^\s*>/.test(line)) {
      endPara()
      const body: string[] = [line.replace(/^\s*>\s?/, '')]
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) body.push(lines[++i].replace(/^\s*>\s?/, ''))
      out.push({ t: 'quote', text: body.join(' ') })
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      endPara()
      const head = splitRow(line)
      const rows: string[][] = []
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(splitRow(lines[i]))
      i--
      out.push({ t: 'table', head, rows })
      continue
    }
    // Continuation of a list item's text (lazy line) folds into the row.
    const last = out[out.length - 1]
    if (!para.length && last?.t === 'li' && /^\s+\S/.test(line)) {
      last.text += ' ' + line.trim()
      continue
    }
    para.push(line.trim())
  }
  endPara()
  return out
}

type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] }

const INLINE_RE =
  /(!\[[^\]]*\]\([^)]*\))|(`+)([\s\S]*?[^`])\2(?!`)|\[([^\]]+)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<]+[^\s<.,:;"')\]])|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][^*]*?)\*|\b_([^_\s][^_]*?)_\b/g

function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  const re = new RegExp(INLINE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', text: unescape(text.slice(last, m.index)) })
    last = m.index + m[0].length
    if (m[1]) continue // image: dropped
    if (m[2]) out.push({ t: 'code', text: m[3].trim() || m[3] })
    else if (m[4] !== undefined) out.push({ t: 'link', href: m[5], children: parseInline(m[4]) })
    else if (m[6]) out.push({ t: 'link', href: m[6], children: [{ t: 'text', text: m[6] }] })
    else if (m[7]) out.push({ t: 'link', href: m[7], children: [{ t: 'text', text: m[7] }] })
    else if (m[8] ?? m[9]) out.push({ t: 'strong', children: parseInline((m[8] ?? m[9])!) })
    else if (m[10] ?? m[11]) out.push({ t: 'em', children: parseInline((m[10] ?? m[11])!) })
  }
  if (last < text.length) out.push({ t: 'text', text: unescape(text.slice(last)) })
  return out
}

function unescape(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
}

/** `ness:verb?a=b` → action. URLSearchParams semantics (`+` is a space),
 *  parsed by hand because Hermes' URLSearchParams is incomplete. */
function parseNessLink(href: string): NessLinkAction {
  const rest = href.slice('ness:'.length)
  const [verb, query = ''] = rest.split('?')
  const params = new Map<string, string>()
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const dec = (s: string): string => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '))
      } catch {
        return s
      }
    }
    const k = dec(eq >= 0 ? pair.slice(0, eq) : pair)
    if (!params.has(k)) params.set(k, dec(eq >= 0 ? pair.slice(eq + 1) : ''))
  }
  return { verb, params }
}

/** The single link a row consists of, if any — the whole row becomes its
 *  44pt tap target. */
function soleLink(nodes: Inline[]): string | null {
  const meaningful = nodes.filter((n) => !(n.t === 'text' && !n.text.trim()))
  return meaningful.length === 1 && meaningful[0].t === 'link' ? meaningful[0].href : null
}


function SidebarMarkdown({
  markdown,
  onAction,
  onOpenUrl
}: {
  markdown: string
  onAction: (action: NessLinkAction) => void
  onOpenUrl: (url: string) => void
}) {
  const blocks = useMemo(() => parseBlocks(markdown), [markdown])

  const activate = useCallback(
    (href: string): void => {
      if (href.startsWith('ness:')) onAction(parseNessLink(href))
      else if (/^https?:/i.test(href)) onOpenUrl(href)
    },
    [onAction, onOpenUrl]
  )

  const renderInline = (nodes: Inline[], key = ''): ReactNode =>
    nodes.map((n, i) => {
      const k = `${key}${i}`
      switch (n.t) {
        case 'text':
          return n.text
        case 'code':
          return (
            <Text key={k} style={{ fontFamily: mono, fontSize: fs.xs, color: c.muted, fontVariant: ['tabular-nums'] }}>
              {n.text}
            </Text>
          )
        case 'strong':
          return (
            <Text key={k} style={{ color: c.fgBright, fontWeight: '500' }}>
              {renderInline(n.children, `${k}.`)}
            </Text>
          )
        case 'em':
          return (
            <Text key={k} style={{ color: c.faint, fontStyle: 'italic' }}>
              {renderInline(n.children, `${k}.`)}
            </Text>
          )
        case 'link':
          if (n.href.startsWith('ness:') || /^https?:/i.test(n.href)) {
            return (
              <Text key={k} style={{ color: c.accent }} onPress={() => activate(n.href)} suppressHighlighting={false}>
                {renderInline(n.children, `${k}.`)}
              </Text>
            )
          }
          return (
            <Text key={k} style={{ color: c.fg }}>
              {renderInline(n.children, `${k}.`)}
            </Text>
          )
      }
    })

  return (
    <View>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h':
            if (b.level <= 2)
              return (
                <View key={i} style={sectionStyles.section}>
                  <Text style={sectionStyles.sectionText} numberOfLines={2}>
                    {renderInline(parseInline(b.text))}
                  </Text>
                </View>
              )
            if (b.level === 3)
              return (
                <Text key={i} style={[sectionStyles.sectionText, { paddingHorizontal: 12, paddingVertical: 4 }]}>
                  {renderInline(parseInline(b.text))}
                </Text>
              )
            return (
              <Text key={i} style={{ paddingHorizontal: 12, paddingVertical: 4, fontSize: fs.xs, fontWeight: '500', color: c.muted }}>
                {renderInline(parseInline(b.text))}
              </Text>
            )
          case 'li': {
            const nodes = parseInline(b.text)
            const href = soleLink(nodes)
            const inner = (
              <Text style={{ flex: 1, minWidth: 0, fontSize: fs.xs, color: c.fg }} numberOfLines={1}>
                {renderInline(nodes)}
              </Text>
            )
            if (href && (href.startsWith('ness:') || /^https?:/i.test(href))) {
              return (
                <Pressable
                  key={i}
                  onPress={() => activate(href)}
                  style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, backgroundColor: pressed ? c.panelRaised : 'transparent' })}
                >
                  {inner}
                </Pressable>
              )
            }
            return (
              <View key={i} style={{ minHeight: 28, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 4 }}>
                {inner}
              </View>
            )
          }
          case 'p':
            return (
              <Text key={i} style={{ paddingHorizontal: 12, paddingVertical: 4, fontSize: fs.xs, color: c.fg }}>
                {renderInline(parseInline(b.text))}
              </Text>
            )
          case 'quote':
            return (
              <View key={i} style={{ marginLeft: 12, paddingHorizontal: 12, paddingVertical: 4, borderLeftWidth: 2, borderColor: c.border }}>
                <Text style={{ fontSize: fs.xs, color: c.faint }}>{renderInline(parseInline(b.text))}</Text>
              </View>
            )
          case 'hr':
            return <View key={i} style={{ borderBottomWidth: 1, borderColor: c.border, marginVertical: 4 }} />
          case 'pre':
            return (
              <ScrollView
                key={i}
                horizontal
                nestedScrollEnabled
                style={{ marginHorizontal: 12, marginVertical: 4, borderRadius: 4, backgroundColor: c.surface }}
                contentContainerStyle={{ padding: 8 }}
              >
                <Text selectable style={{ fontFamily: mono, fontSize: fs.xs, color: c.fg }}>
                  {b.text}
                </Text>
              </ScrollView>
            )
          case 'table':
            return (
              <ScrollView key={i} horizontal nestedScrollEnabled style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
                <View>
                  <View style={{ flexDirection: 'row' }}>
                    {b.head.map((h, j) => (
                      <Text key={j} style={[sectionStyles.sectionText, { paddingRight: 12, minWidth: 48 }]}>
                        {renderInline(parseInline(h))}
                      </Text>
                    ))}
                  </View>
                  {b.rows.map((r, ri) => (
                    <View key={ri} style={{ flexDirection: 'row' }}>
                      {b.head.map((_, j) => (
                        <Text key={j} style={{ paddingRight: 12, minWidth: 48, fontSize: fs.xs, color: c.fg }}>
                          {renderInline(parseInline(r[j] ?? ''))}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            )
        }
      })}
    </View>
  )
}

// Read styles from this map (st.x); never pass a themed() object itself
// as a style. React freezes styles and flattens them by enumerating
// keys, and themed()'s Proxy supports neither, so the style silently
// vanished (text fell back to iOS's default black on dark themes).
const sectionStyles = themed(() =>
  StyleSheet.create({
  section: {
  paddingHorizontal: 12,
  paddingVertical: 6,
  minHeight: 32,
  justifyContent: 'center' as const,
  backgroundColor: alpha(c.panelRaised, 0.5)
},
  sectionText: { fontSize: fs.xs, fontWeight: '500' as const, color: c.dim, textTransform: 'uppercase' as const, letterSpacing: 0.6 }
  })
)
