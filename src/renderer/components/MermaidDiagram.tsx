import { memo, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Code2, Workflow } from 'lucide-react'

// Mermaid is ~1MB, so it loads on the first diagram rather than at boot.
// Renders are serialized because mermaid.initialize is global config and
// mermaid.render measures text in a shared scratch element; two renders
// interleaving across an await can draw with each other's theme.

type MermaidApi = typeof import('mermaid').default

let mermaidPromise: Promise<MermaidApi> | null = null
function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  return mermaidPromise
}

const THEME_VARS = [
  'app',
  'panel',
  'panel-raised',
  'surface',
  'border',
  'border-strong',
  'fg',
  'fg-bright',
  'muted',
  'accent'
] as const

type ThemeColors = Record<(typeof THEME_VARS)[number], string>

function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement)
  return Object.fromEntries(
    THEME_VARS.map((v) => [v, style.getPropertyValue(`--color-${v}`).trim()])
  ) as ThemeColors
}

// Theme switches rewrite [data-theme] and, for custom themes and uiScale,
// inline styles on <html>. One observer for every diagram on screen.
let themeKey = ''
const themeListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null
function subscribeTheme(cb: () => void): () => void {
  themeListeners.add(cb)
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      const next = currentThemeKey()
      if (next === themeKey) return
      themeKey = next
      for (const l of themeListeners) l()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class']
    })
  }
  return () => {
    themeListeners.delete(cb)
    if (themeListeners.size === 0) {
      themeObserver?.disconnect()
      themeObserver = null
      // Nothing watches the theme now, so the key would go stale.
      themeKey = ''
    }
  }
}
function getThemeKey(): string {
  if (!themeKey) themeKey = currentThemeKey()
  return themeKey
}

function currentThemeKey(): string {
  return `${JSON.stringify(readThemeColors())}|${getComputedStyle(document.documentElement).fontSize}`
}

function isDark(hex: string): boolean {
  const m = /^#([0-9a-f]{6})/i.exec(hex)
  if (!m) return true
  const n = parseInt(m[1], 16)
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  return lum < 128
}

const MIN_SCALE = 0.65

function mermaidConfig(c: ThemeColors): Parameters<MermaidApi['initialize']>[0] {
  // Mermaid sizes text in px. Derive it from the root font-size so
  // diagrams follow uiScale like the rest of the UI (13px at the default).
  const fontPx = Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.8125)
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: getComputedStyle(document.body).fontFamily,
    sequence: { actorFontSize: fontPx, messageFontSize: fontPx, noteFontSize: fontPx },
    themeVariables: {
      darkMode: isDark(c.app),
      background: c.panel,
      fontSize: `${fontPx}px`,
      primaryColor: c.surface,
      primaryTextColor: c['fg-bright'],
      primaryBorderColor: c['border-strong'],
      secondaryColor: c['panel-raised'],
      tertiaryColor: c.panel,
      lineColor: c.muted,
      textColor: c.fg,
      mainBkg: c.surface,
      nodeBorder: c['border-strong'],
      clusterBkg: c['panel-raised'],
      clusterBorder: c.border,
      edgeLabelBackground: c.panel,
      actorBkg: c.surface,
      actorBorder: c['border-strong'],
      actorTextColor: c['fg-bright'],
      signalColor: c.muted,
      signalTextColor: c.fg,
      labelBoxBkgColor: c.surface,
      noteBkgColor: c['panel-raised'],
      noteTextColor: c.fg,
      noteBorderColor: c.accent
    }
  }
}

type RenderResult = { svg: string } | { error: string }

// Keyed by theme + source so chat rows that unmount and remount while
// scrolling show their diagram straight away instead of re-rendering.
const MAX_CACHE = 64
const cache = new Map<string, RenderResult>()
let queue: Promise<unknown> = Promise.resolve()
let seq = 0

function renderMermaid(source: string, key: string): Promise<RenderResult> {
  const run = async (): Promise<RenderResult> => {
    const hit = cache.get(key)
    if (hit) return hit
    let result: RenderResult
    try {
      const mermaid = await loadMermaid()
      mermaid.initialize(mermaidConfig(readThemeColors()))
      const { svg } = await mermaid.render(`ness-mermaid-${++seq}`, source)
      // Mermaid emits width="100%" capped at the natural width, so a wide
      // diagram shrinks until its labels are unreadable. Floor the shrink
      // and let the container scroll past that.
      const natural = Number(/max-width:\s*([\d.]+)px/.exec(svg)?.[1])
      result = {
        svg: natural
          ? svg.replace(/max-width:\s*[\d.]+px;?/, `max-width: ${natural}px; min-width: ${Math.round(natural * MIN_SCALE)}px;`)
          : svg
      }
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) }
    }
    cache.set(key, result)
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string)
    return result
  }
  const p = queue.then(run, run)
  queue = p
  return p
}

/** A ```mermaid block drawn as a diagram, with a toggle back to its
 *  source. Shows the source while rendering and when it fails to parse,
 *  so a typo costs the picture, never the content. `fallback` is the
 *  normal code block for that source. */
export const MermaidDiagram = memo(function MermaidDiagram({
  source,
  fallback
}: {
  source: string
  fallback: ReactNode
}): JSX.Element {
  const theme = useSyncExternalStore(subscribeTheme, getThemeKey)
  const key = `${theme}\n${source}`
  const [result, setResult] = useState<RenderResult | null>(() => cache.get(key) ?? null)
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    const hit = cache.get(key)
    if (hit) return setResult(hit)
    let cancelled = false
    void renderMermaid(source, key).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [key, source])

  if (!result || showSource || 'error' in result) {
    return (
      <div className="relative group">
        {fallback}
        {result && 'error' in result && (
          <div className="-mt-1 mb-2 text-xs text-faint">Diagram didn’t render: {result.error.split('\n')[0]}</div>
        )}
        {result && 'svg' in result && (
          <ToggleButton onClick={() => setShowSource(false)} label="Show diagram">
            <Workflow className="icon-xs" />
          </ToggleButton>
        )}
      </div>
    )
  }

  return (
    <div className="relative group my-2">
      <div
        className="mermaid-diagram overflow-x-auto rounded border border-border bg-panel p-3 [&_svg]:mx-auto [&_svg]:h-auto"
        // Strict mode strips scripts and javascript: URLs, but a plain
        // http link in a node would still navigate the whole window.
        onClickCapture={(e) => {
          if ((e.target as Element).closest('a')) e.preventDefault()
        }}
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
      <ToggleButton onClick={() => setShowSource(true)} label="Show source">
        <Code2 className="icon-xs" />
      </ToggleButton>
    </div>
  )
})

function ToggleButton({
  onClick,
  label,
  children
}: {
  onClick: () => void
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
      className="absolute top-1.5 right-1.5 p-1 rounded bg-panel-raised/90 border border-border text-faint hover:text-fg opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
    >
      {children}
    </button>
  )
}

type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

/** react-markdown `pre` override: a finished ```mermaid block (marked by
 *  remarkMermaid) becomes a diagram, everything else renders as usual. */
export function MarkdownPre({
  node,
  ...props
}: React.HTMLAttributes<HTMLPreElement> & { node?: HastNode }): JSX.Element {
  const code = node?.children?.find((c) => c.tagName === 'code')
  const pre = <pre {...props} />
  if (code?.properties?.dataMermaid !== 'closed') return pre
  return <MermaidDiagram source={hastText(code).replace(/\n$/, '')} fallback={pre} />
}
