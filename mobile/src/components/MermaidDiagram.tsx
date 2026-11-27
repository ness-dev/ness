// Port of renderer/components/MermaidDiagram.tsx: a finished ```mermaid
// block drawn as a diagram, with a toggle back to its source. The source
// shows while rendering and when it fails to parse, so a typo costs the
// picture, never the content.
//
// Two WebViews, one at a time. Rendering loads mermaid (~3.5MB, bundled as
// an asset: see metro.config.js) in an invisible WebView that hands back
// the SVG. The diagram is then that SVG alone in a light WebView with no
// mermaid in it, so a chat row that remounts while scrolling redraws from
// the cache instead of parsing mermaid again.
//
// Loading the page: expo-asset's localUri, a file:// path in every build —
// inside the app for the embedded bundle, the expo-updates asset store for
// an OTA, a cached download from Metro in development — so dev exercises
// the same file:// load release does. (RN's resolveAssetSource alone gives
// an http URL in dev and, for an OTA asset expo-asset hasn't resolved, an
// empty one.) If the file still won't load, the page's text is read and
// handed to the WebView inline; if that fails too, the source stays up.
import { memo, useEffect, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Asset } from 'expo-asset'
import { File } from 'expo-file-system'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { Code2, Workflow } from 'lucide-react-native'
import { c, fs, getThemeMode, themeVersion } from '../theme'
import { CopyableMessage } from '../chat/CopyText'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PAGE_MODULE: number = require('../../generated/mermaid.html')
/** A render that hasn't answered by then failed to load, not to parse. */
const RENDER_TIMEOUT_MS = 20_000

type PageSource = { uri: string; dir: string } | { html: string }

let pageUri: Promise<string> | null = null
function mermaidPageUri(): Promise<string> {
  pageUri ??= Asset.fromModule(PAGE_MODULE)
    .downloadAsync()
    .then((a) => {
      if (!a.localUri) throw new Error('Mermaid page has no local file')
      return a.localUri
    })
    .catch((e: unknown) => {
      pageUri = null // retry on the next diagram
      throw e
    })
  return pageUri
}

let pageHtml: Promise<string> | null = null
function mermaidPageHtml(uri: string): Promise<string> {
  pageHtml ??= new File(uri).text().catch((e: unknown) => {
    pageHtml = null
    throw e
  })
  return pageHtml
}

const FONT = '-apple-system, system-ui, sans-serif'
const FONT_PX = 13
/** The desktop's MIN_SCALE: a wide diagram shrinks to fit only this far,
 *  then scrolls sideways, so its labels stay readable. */
const MIN_SCALE = 0.65

/** The desktop's mermaidConfig, from the phone's palette. */
function mermaidConfig(): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: FONT,
    sequence: { actorFontSize: FONT_PX, messageFontSize: FONT_PX, noteFontSize: FONT_PX },
    themeVariables: {
      darkMode: getThemeMode() === 'dark',
      background: c.panel,
      fontSize: `${FONT_PX}px`,
      primaryColor: c.surface,
      primaryTextColor: c.fgBright,
      primaryBorderColor: c.borderStrong,
      secondaryColor: c.panelRaised,
      tertiaryColor: c.panel,
      lineColor: c.muted,
      textColor: c.fg,
      mainBkg: c.surface,
      nodeBorder: c.borderStrong,
      clusterBkg: c.panelRaised,
      clusterBorder: c.border,
      edgeLabelBackground: c.panel,
      actorBkg: c.surface,
      actorBorder: c.borderStrong,
      actorTextColor: c.fgBright,
      signalColor: c.muted,
      signalTextColor: c.fg,
      labelBoxBkgColor: c.surface,
      noteBkgColor: c.panelRaised,
      noteTextColor: c.fg,
      noteBorderColor: c.accent
    }
  }
}

type RenderResult = { svg: string; w: number; h: number } | { error: string }

// Keyed by theme + source, like the desktop's.
const MAX_CACHE = 64
const cache = new Map<string, RenderResult>()
function remember(key: string, r: RenderResult): void {
  cache.set(key, r)
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string)
}

/** `width` in points. An explicit width, not 100%: the page's
 *  device-width viewport is the screen's, not this WebView's frame, so a
 *  percentage would lay the diagram out wider than the box and clip it. */
function svgPage(svg: string, width: number): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>html, body { margin: 0; background: transparent; overflow: hidden; }
svg { display: block; width: ${width}px !important; max-width: none !important; height: auto; }</style>
</head><body>${svg}</body></html>`
}

/** `fallback` is the normal code block for `source`. */
export const MermaidDiagram = memo(function MermaidDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  // Screens remount on a theme change (the root layout keys them on it),
  // so reading the version at render is enough to key the cache.
  const key = `${themeVersion()}:${getThemeMode()}:${c.app}\n${source}`
  const [result, setResult] = useState<RenderResult | null>(() => cache.get(key) ?? null)
  const [showSource, setShowSource] = useState(false)
  const [width, setWidth] = useState(0)
  const [page, setPage] = useState<PageSource | null>(null)

  // A failure to load mermaid isn't remembered: the next mount retries.
  // Only what mermaid itself answered is cached.
  const loadFailed = (why: string) => setResult({ error: why })

  useEffect(() => {
    if (result) return
    let cancelled = false
    mermaidPageUri().then(
      (uri) => !cancelled && setPage({ uri, dir: uri.replace(/[^/]*$/, '') }),
      () => !cancelled && loadFailed('Mermaid is missing from this build')
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result === null])

  // The file:// page didn't load (or never answered): try it inline once.
  const fallBack = () => {
    if (!page || !('uri' in page)) return loadFailed('Mermaid failed to load')
    mermaidPageHtml(page.uri).then(
      (html) => setPage({ html }),
      () => loadFailed('Mermaid failed to load')
    )
  }

  useEffect(() => {
    if (result || !page) return
    const t = setTimeout(fallBack, RENDER_TIMEOUT_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, page])

  const onMessage = (e: WebViewMessageEvent) => {
    let r: RenderResult
    try {
      const m = JSON.parse(e.nativeEvent.data) as { ok: boolean; svg?: string; w?: number; h?: number; error?: string }
      r = m.ok && m.svg && m.w && m.h ? { svg: m.svg, w: m.w, h: m.h } : { error: m.error ?? 'Empty diagram' }
    } catch {
      r = { error: 'Bad render result' }
    }
    remember(key, r)
    setResult(r)
  }

  const renderer = !result && page && (
    // Invisible but laid out: mermaid measures text, which needs a live
    // page with a real width.
    <View style={{ position: 'absolute', left: 0, top: 0, width: Math.max(width, 320), height: 1, opacity: 0 }} pointerEvents="none">
      <WebView
        key={'uri' in page ? 'file' : 'inline'}
        source={'uri' in page ? { uri: page.uri } : { html: page.html }}
        originWhitelist={['*']}
        // WKWebView may only read a file:// page under a directory it's
        // granted; the page's own directory is enough (it loads nothing else).
        allowFileAccess
        allowingReadAccessToURL={'uri' in page ? page.dir : undefined}
        injectedJavaScript={`window.nessRender(${JSON.stringify(mermaidConfig())}, ${JSON.stringify(source)}); true;`}
        onMessage={onMessage}
        onError={fallBack}
        onContentProcessDidTerminate={fallBack}
      />
    </View>
  )

  if (!result || showSource || 'error' in result) {
    return (
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {fallback}
        {renderer}
        {result && 'error' in result && (
          <Text style={{ marginTop: 4, fontSize: fs.xs, color: c.faint }}>Diagram didn’t render: {result.error.split('\n')[0]}</Text>
        )}
        {result && 'svg' in result && (
          <ToggleButton onPress={() => setShowSource(false)} label="Show diagram">
            <Workflow color={c.faint} size={12} />
          </ToggleButton>
        )}
      </View>
    )
  }

  // Inner width of the bordered box (12pt padding each side).
  const avail = Math.max(0, width - 26)
  const shown = result.w <= avail ? result.w : Math.max(avail, result.w * MIN_SCALE)
  const height = Math.ceil((result.h * shown) / result.w)
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {/* Long-press selects the diagram's source, as it does on the code. */}
      <CopyableMessage text={source}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        scrollEnabled={shown > avail}
        showsHorizontalScrollIndicator={shown > avail}
        style={{ borderWidth: 1, borderColor: c.border, borderRadius: 6, backgroundColor: c.panel }}
        contentContainerStyle={{ padding: 12, minWidth: '100%', justifyContent: 'center' }}
      >
        {/* Touches go to the views around it (the message's long-press,
            this scroll view), not the page: it's a picture, and strict
            mode leaves plain links that would navigate the WebView. */}
        <View style={{ width: shown, height }} pointerEvents="none">
          {width > 0 && (
            <WebView
              source={{ html: svgPage(result.svg, shown) }}
              originWhitelist={['*']}
              scrollEnabled={false}
              style={{ backgroundColor: 'transparent' }}
              containerStyle={{ backgroundColor: 'transparent' }}
            />
          )}
        </View>
      </ScrollView>
      </CopyableMessage>
      <ToggleButton onPress={() => setShowSource(true)} label="Show source">
        <Code2 color={c.faint} size={12} />
      </ToggleButton>
    </View>
  )
})

function ToggleButton({ onPress, label, children }: { onPress: () => void; label: string; children: ReactNode }) {
  return (
    // The desktop reveals it on hover; a phone has no hover, so it's always
    // there, small, in the corner — with a 44pt hit area.
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      style={{ position: 'absolute', top: 4, right: 4, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{ padding: 4, borderRadius: 4, borderWidth: 1, borderColor: c.border, backgroundColor: c.panelRaised }}>{children}</View>
    </Pressable>
  )
}
