import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowLeft, ArrowRight, PauseCircle, RotateCw, Wrench, Loader2 } from 'lucide-react'
import { useBrowser } from '../store'
import { useBackend } from '../backend'
import { Tooltip } from './Tooltip'
import { useActiveBackend } from '../store'
import { RemoteBrowserView } from './RemoteBrowserView'
import { ViewportPicker } from './ViewportPicker'
import type { BrowserViewport } from '../../shared/browser-viewport'

interface BrowserPanelProps {
  tabId: string
  visible: boolean
  initialUrl: string
}

/**
 * Renders the URL bar + navigation buttons for a browser tab and a
 * placeholder body whose bounds are streamed to main. The actual web view
 * is a native `WebContentsView` positioned on top of this placeholder by
 * BrowserManager.
 */
export function BrowserPanel({ tabId, visible, initialUrl }: BrowserPanelProps): JSX.Element {
  const backend = useBackend()
  const browser = useBrowser()
  const tabState = browser.byTab[tabId]
  const currentUrl = tabState?.url ?? initialUrl
  const loading = tabState?.loading ?? false
  const canGoBack = tabState?.canGoBack ?? false
  const canGoForward = tabState?.canGoForward ?? false

  const viewport = tabState?.viewport ?? null
  const attached = tabState?.attached ?? false

  const [draftUrl, setDraftUrl] = useState(currentUrl)
  const [editing, setEditing] = useState(false)
  // The native view paints above the DOM, so the picker's dropdown is only
  // visible while the view is detached.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [viewportError, setViewportError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // Routine transitions (switching to this tab, a resize) detach and re-attach
  // the view within a frame or two. Only call it paused once it has stayed
  // that way, or the notice strobes on every tab switch.
  const [detachedAWhile, setDetachedAWhile] = useState(false)

  // Keep the URL bar text in sync with the actual page URL when not editing.
  useEffect(() => {
    if (!editing) setDraftUrl(currentUrl)
  }, [currentUrl, editing])

  // When the active backend is remote (or we're in the browser web
  // client, where the active backend's underlying transport is WS so
  // its `kind` is also 'remote'), the WebContentsView overlay is
  // unavailable — the BrowserPanel falls back to the polled-screenshot
  // view. Per design §L: replace the old __HARNESS_WEB__ process flag
  // with a per-backend kind check.
  const webMode = useActiveBackend().kind === 'remote'

  const pushBounds = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    if (!visible || pickerOpen) {
      backend.browserHide(tabId)
      return
    }
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) {
      backend.browserHide(tabId)
      return
    }
    backend.browserSetBounds(tabId, {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height
    })
  }, [tabId, visible, pickerOpen])

  useEffect(() => {
    if (webMode) return
    pushBounds()
    if (!visible || pickerOpen) return
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => pushBounds())
    ro.observe(el)
    const onWinResize = (): void => pushBounds()
    window.addEventListener('resize', onWinResize)
    // Periodic re-check catches layout shifts that ResizeObserver misses
    // (sidebar collapse animations that move x/y without resizing us).
    const interval = setInterval(pushBounds, 150)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWinResize)
      clearInterval(interval)
    }
  }, [pushBounds, visible, pickerOpen, webMode])

  useEffect(() => {
    if (webMode) return
    return () => {
      backend.browserHide(tabId)
    }
  }, [tabId, webMode])

  const applyViewport = (next: BrowserViewport | null): void => {
    setViewportError(null)
    void backend
      .browserSetViewport(tabId, next)
      .then((r) => {
        if (r && r.ok === false) setViewportError(r.error ?? 'could not set viewport')
      })
      .catch((err: unknown) => {
        setViewportError(err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(() => {
    if (webMode || !visible) return
    if (!attached) {
      const t = window.setTimeout(() => setDetachedAWhile(true), 250)
      return () => window.clearTimeout(t)
    }
    setDetachedAWhile(false)
    return
  }, [attached, visible, webMode])

  const submitNav = (): void => {
    setEditing(false)
    if (!draftUrl.trim()) return
    void backend.browserNavigate(tabId, draftUrl.trim())
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-app">
      <div className="flex items-center gap-1 px-2 h-9 shrink-0 border-b border-border bg-panel">
        <Tooltip label="Back">
          <button
            onClick={() => void backend.browserBack(tabId)}
            disabled={!canGoBack}
            className="p-1 rounded text-faint hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="Forward">
          <button
            onClick={() => void backend.browserForward(tabId)}
            disabled={!canGoForward}
            className="p-1 rounded text-faint hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowRight className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="Reload">
          <button
            onClick={() => void backend.browserReload(tabId)}
            className="p-1 rounded text-faint hover:text-fg transition-colors"
          >
            {loading ? <Loader2 className="icon-sm animate-spin" /> : <RotateCw className="icon-sm" />}
          </button>
        </Tooltip>
        <input
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              submitNav()
              ;(e.currentTarget as HTMLInputElement).blur()
            }
            if (e.key === 'Escape') {
              setDraftUrl(currentUrl)
              setEditing(false)
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          placeholder="Enter URL"
          spellCheck={false}
          className="flex-1 h-7 px-2 text-xs bg-app border border-border rounded text-fg focus:outline-none focus:border-accent"
        />
        <ViewportPicker
          viewport={viewport}
          onChange={applyViewport}
          onOverlayChange={setPickerOpen}
        />
        <Tooltip label="DevTools">
          <button
            onClick={() => void backend.browserOpenDevTools(tabId)}
            className="p-1 rounded text-faint hover:text-fg transition-colors"
          >
            <Wrench className="icon-sm" />
          </button>
        </Tooltip>
      </div>
      {viewportError && (
        <div className="shrink-0 px-2 py-1 text-xs text-red-500 border-b border-border bg-panel">
          {viewportError}
        </div>
      )}
      <div ref={bodyRef} className="flex-1 min-h-0 bg-app relative">
        {webMode && <RemoteBrowserView tabId={tabId} visible={visible} />}
        {!webMode && visible && !attached && (pickerOpen || detachedAWhile) && (
          // The native view composites above the DOM, so anything that needs to
          // draw over the page — this panel's own menu, an off-screen capture —
          // has to detach it first. Without a notice the empty pane reads as a
          // crashed page.
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center px-6 pointer-events-none">
            <PauseCircle className="icon-lg text-faint" />
            <div className="text-sm text-fg">Page paused</div>
            <div className="text-xs text-faint">
              {pickerOpen
                ? "It's still loaded — it comes back when you close this menu."
                : "It's still loaded — it comes back in a moment."}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
