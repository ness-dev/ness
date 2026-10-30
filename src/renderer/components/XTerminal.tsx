import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ProgressAddon } from '@xterm/addon-progress'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import type { StateEvent } from '../../shared/state'
import { getClientId, LOCAL_BACKEND_ID, subscribeActiveTransportReconnect, useSettings, useTerminalSession } from '../store'
import { getBackendFor, useBackend } from '../backend'
import { useBackendScope } from '../backend-scope'
import {
  makeFileLinkProvider,
  loadWorktreeFiles,
  getCachedWorktreeFiles
} from '../terminal-file-links'
import {
  makeCommitLinkProvider,
  loadWorktreeCommits,
  getCachedWorktreeCommits
} from '../terminal-commit-links'
import { scaledEditorFontSize, type UiScale } from '../../shared/state/settings'
import { Eye, X, Sparkles } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { CommitInfoModal } from './CommitInfoModal'
import { CommitHoverCard } from './CommitHoverCard'
import { FindBar } from './JsonModeChatFind'

function ClaudeLoader() {
  return (
    <div className="claude-loader" aria-label="Starting Claude">
      <div className="claude-loader-halo" />
      <div className="claude-loader-pulser">
        <div className="claude-loader-rotator">
          <svg viewBox="0 0 56 56" width="56" height="56">
            <g fill="var(--color-brand)" transform="translate(28 28)">
              {[0, 45, 90, 135].map((deg) => (
                <path
                  key={deg}
                  d="M 0 -24 Q 3 0 0 24 Q -3 0 0 -24 Z"
                  transform={`rotate(${deg})`}
                />
              ))}
            </g>
          </svg>
        </div>
      </div>
    </div>
  )
}

const DEFAULT_TERMINAL_FONT_FAMILY =
  "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace"
const DEFAULT_TERMINAL_FONT_SIZE = 13

const SEARCH_DECORATIONS = {
  matchBackground: '#facc1540',
  matchBorder: '#facc1580',
  matchOverviewRuler: '#facc15',
  activeMatchBackground: '#f59e0b',
  activeMatchBorder: '#fbbf24',
  activeMatchColorOverviewRuler: '#f59e0b'
}

/** Global registry so hotkeys can focus terminals without prop-drilling refs */
const terminalRegistry = new Map<string, Terminal>()
/** Fit addons keyed by terminal id, so font-change listeners can refit. */
const fitRegistry = new Map<string, FitAddon>()

// Matches an SGR mouse button press/release report (`ESC [ < btn ; col ; row M|m`).
// Motion (bit 0x20) and wheel (bit 0x40) reports are excluded so hovering and
// scrolling still reach a mouse-aware app — only an actual button click is
// treated as one we may need to withhold from the PTY.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_REPORT = /^\x1b\[<(\d+);\d+;\d+[Mm]$/
export function isMouseButtonReport(data: string): boolean {
  const match = SGR_MOUSE_REPORT.exec(data)
  if (!match) return false
  const button = Number(match[1])
  return (button & 0x20) === 0 && (button & 0x40) === 0
}

export function focusTerminalById(id: string): void {
  terminalRegistry.get(id)?.focus()
}

export function scrollTerminalById(id: string, lines: number): void {
  terminalRegistry.get(id)?.scrollLines(lines)
}

export function scrollTerminalToBottomById(id: string): void {
  terminalRegistry.get(id)?.scrollToBottom()
}

export function getTerminalLineHeight(id: string): number {
  const term = terminalRegistry.get(id)
  if (!term?.element) return 16
  const viewport = term.element.querySelector('.xterm-viewport') as HTMLElement | null
  if (!viewport) return 16
  const rows = term.rows || 1
  const h = viewport.clientHeight / rows
  return h > 0 ? h : 16
}

export function isTerminalAtBottom(id: string): boolean {
  const term = terminalRegistry.get(id)
  if (!term) return true
  return term.buffer.active.viewportY >= term.buffer.active.baseY
}

/** Live cache of terminal font settings. Hydrated once at module load and
 * kept in sync via main-process broadcasts so newly created terminals open
 * with the user's chosen values without any prop drilling. */
let currentFontFamily = DEFAULT_TERMINAL_FONT_FAMILY
let currentFontSize = DEFAULT_TERMINAL_FONT_SIZE
// `currentFontSize` is the user-configured terminal size. The pixel size
// we hand to xterm is shifted by the current scale's `terminalOffset` (see
// SCALES in shared/state/settings.ts) so terminals stay in proportion with
// the rest of the UI when the scale rung changes. Stored separately so the
// user's terminalFontSize preference is never overwritten — the offset is
// applied dynamically via `scaledEditorFontSize`, the same helper Monaco
// editors use.
let currentUiScale: UiScale = 'small'

function effectiveTerminalFontSize(): number {
  return scaledEditorFontSize(currentFontSize, currentUiScale)
}

/** Which backend owns each live terminal, so the module-scope helpers
 *  below can reach the right transport.
 *
 *  The component knows its backend from `useBackendScope()`, but these
 *  helpers run outside React: `applyFontToAll` sweeps every mounted
 *  terminal across every worktree, and `markTerminalClosing` is called
 *  imperatively from tab-close paths. Both used the active-routed
 *  singleton, which sends a resize or a scrollback-clear for a remote
 *  worktree's terminal to whichever backend happens to be selected. */
const terminalBackends = new Map<string, string | null>()

export function registerTerminalBackend(
  terminalId: string,
  backendId: string | null
): void {
  terminalBackends.set(terminalId, backendId)
}

export function forgetTerminalBackend(terminalId: string): void {
  terminalBackends.delete(terminalId)
}

/** The owning backend for a terminal, falling back to active-routed for an
 *  id we never saw registered (shouldn't happen; harmless if it does). */
function backendForTerminal(terminalId: string) {
  return getBackendFor(terminalBackends.get(terminalId) ?? null)
}

function applyFontToAll(): void {
  for (const [id, term] of terminalRegistry) {
    term.options.fontFamily = currentFontFamily
    term.options.fontSize = effectiveTerminalFontSize()
    const fit = fitRegistry.get(id)
    if (!fit) continue
    try {
      fit.fit()
      const dims = fit.proposeDimensions()
      if (dims) backendForTerminal(id).resizeTerminal(id, dims.cols, dims.rows)
    } catch {
      // ignore — terminal may not be visible
    }
  }
}

// Seed from the state snapshot and then keep in sync via the state event
// stream. XTerminal's font cache lives at module scope (not in React state)
// because newly mounted xterm instances read it synchronously in the
// constructor, before any React hook could fire.
//
// Init is lazy (called from the first component mount, not at module
// load) because the backend singleton is built by `initBackend()`
// during initStore — which runs after this module's import hoisting.
// Pre-init the cache fires the first time an XTerminal mounts; the
// `applyFontToAll()` sweep updates anything already on screen.
let fontCacheInitialized = false
function initFontCache(): void {
  if (fontCacheInitialized) return
  fontCacheInitialized = true
  // Explicitly the client's own backend, not the active one. Terminal font
  // family/size and uiScale describe how THIS window renders, so they must
  // not change when the user selects a worktree on another machine. Note
  // this path reads the snapshot straight off the transport rather than
  // through `useSettings()`, so it needs its own pinning — the hook-level
  // client-owned-settings overlay doesn't reach it.
  const backend = getBackendFor(LOCAL_BACKEND_ID)
  void backend.getStateSnapshot().then(({ state }) => {
    currentFontFamily = state.settings.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY
    currentFontSize = state.settings.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE
    currentUiScale = state.settings.uiScale
    applyFontToAll()
  })
  backend.onStateEvent((raw) => {
    const event = raw as StateEvent
    if (event.type === 'settings/terminalFontFamilyChanged') {
      currentFontFamily = event.payload || DEFAULT_TERMINAL_FONT_FAMILY
      applyFontToAll()
    } else if (event.type === 'settings/terminalFontSizeChanged') {
      currentFontSize = event.payload || DEFAULT_TERMINAL_FONT_SIZE
      applyFontToAll()
    } else if (event.type === 'settings/uiScaleChanged') {
      currentUiScale = event.payload as UiScale
      applyFontToAll()
    }
  })
}

// Browsers without `font-variant-emoji: text` (iOS Safari < 17.4) happily
// auto-emojify ambiguous codepoints via the Apple Color Emoji fallback,
// so Claude Code's U+23FA tool-call marker renders as a red-circle
// emoji on older phones even with our CSS rule in place. Detect support
// once and rewrite the known offender to U+25CF (●) in the data stream
// when the CSS can't do the job. On browsers that honor the property we
// ship the original glyph through unchanged.
const supportsTextEmoji =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('font-variant-emoji', 'text')
    : false

// On touch devices, xterm's alt-screen and mouse-tracking modes both
// make TUIs (Claude Code, vim) unscrollable: alt-screen has no
// scrollback at all, and mouse tracking forwards finger pans to the
// PTY as mouse reports that the TUI discards. Strip the CSI private
// modes that enable them so touch devices always stay in the primary
// buffer with scroll wheel / touch scroll. Desktop clients keep the
// full behavior.
const isTouchDevice =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || (window.navigator?.maxTouchPoints ?? 0) > 0)
const TUI_UNFRIENDLY_MODES =
  /\u001b\[\?(?:47|1000|1002|1003|1005|1006|1015|1047|1049)[hl]/g

function sanitizeTerminalData(data: string): string {
  let out = data
  if (!supportsTextEmoji) out = out.replace(/\u23FA/g, '\u25CF')
  if (isTouchDevice) out = out.replace(TUI_UNFRIENDLY_MODES, '')
  return out
}

/** Mark a terminal as closing: drop its main-side scrollback buffer + file so
 * a future tab with a different id doesn't inherit stale bytes. Scrollback
 * ownership lives in main (PtyManager), so this is a one-shot fire-and-forget
 * IPC with no renderer-side suppression needed. */
export function markTerminalClosing(id: string): void {
  backendForTerminal(id).clearTerminalHistory(id)
}

// Read the bg/fg from CSS vars set by theme-apply.ts, then build the full
// xterm theme object. ANSI colors stay hardcoded for now — themes only flow
// in via --color-app / --color-fg-bright.
function buildTerminalTheme(
  bgVar = '--color-app'
): NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'] {
  const rootStyle = getComputedStyle(document.documentElement)
  const bg =
    rootStyle.getPropertyValue(bgVar).trim() ||
    rootStyle.getPropertyValue('--color-app').trim() ||
    '#0a0a0a'
  const fg = rootStyle.getPropertyValue('--color-fg-bright').trim() || '#e5e5e5'
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    selectionBackground: '#33415580',
    black: bg,
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: fg,
    brightBlack: '#525252',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#fafafa'
  }
}

import type { AgentKind } from '../../shared/state/terminals'
import { agentDisplayName, supportsChat } from '../../shared/agent-registry'

interface XTerminalProps {
  terminalId: string
  cwd: string
  type: 'agent' | 'shell'
  agentKind?: AgentKind
  visible: boolean
  sessionName?: string
  sessionId?: string
  initialPrompt?: string
  teleportSessionId?: string
  modelOverride?: string
  /** Shell tabs only: directory to spawn in. Relative paths resolve against
   * `cwd` (the worktree root); absolute paths are used as-is. */
  shellCwd?: string
  /** CSS custom-property name to source the terminal background from, so a
   * host can tint it differently (e.g. the Quake overlay uses `--color-panel`
   * to set itself apart from in-pane terminals). Defaults to `--color-app`. */
  backgroundVar?: string
  /** One-time text written straight to the xterm display at mount (visual
   * only — never sent to the PTY), before history replay / PTY spawn so it
   * lands above the shell's first prompt. The Quake overlay uses this for its
   * first-open boot banner. */
  preamble?: string
  /** Skip the dim `── session restored ──` marker drawn after scrollback
   * replay. The Quake overlay sets this — the marker is useful chrome for
   * in-pane tabs but noise on the transient drop-down console. */
  hideRestoreNotice?: boolean
  onRestartAgent?: () => void
  /** When provided AND this is a Claude agent tab, an overlay chip in
   *  the top-left invites the user to switch to the Chat interface. */
  onSwitchToChat?: () => void
}

export function XTerminal({ terminalId, cwd, type, agentKind, visible, sessionName, sessionId, initialPrompt, teleportSessionId, modelOverride, shellCwd, backgroundVar, preamble, hideRestoreNotice, onRestartAgent, onSwitchToChat }: XTerminalProps): JSX.Element {
  // Lazy font-cache init — fires once on first XTerminal mount. See
  // initFontCache() comment for why this is lazy rather than at module
  // top.
  initFontCache()
  const backend = useBackend()
  // Recorded into `terminalBackends` on mount so the module-scope helpers
  // (font sweep, scrollback clear) can route to this terminal's backend.
  const backendScope = useBackendScope()
  const chatPromotionDismissed = useSettings().chatPromotionDismissed
  const plainClickOpensInApp = useSettings().terminalPlainClickOpensInApp

  // Prime + refresh the worktree file list that validates file-path links.
  // Shared across this worktree's tabs and rate-limited inside
  // loadWorktreeFiles, so reloading when the tab becomes visible is cheap.
  useEffect(() => {
    if (!visible) return
    void loadWorktreeFiles(cwd, (c) => backend.listAllFiles(c))
  }, [cwd, visible, backend])

  // Same priming for the commit-SHA set that validates commit links.
  useEffect(() => {
    if (!visible) return
    void loadWorktreeCommits(cwd, (c) => backend.listRecentCommitShas(c))
  }, [cwd, visible, backend])

  // Commit popup state (null = closed): the full SHA plus the click
  // coordinates so the popup can anchor next to the clicked SHA. Set by the
  // commit-link provider; the popup renders below via a fixed-position layer
  // so it escapes this terminal's pane.
  const [commitPopup, setCommitPopup] = useState<{ sha: string; x: number; y: number } | null>(
    null
  )
  // Blame-style hover card shown after a short hover-intent delay while the
  // pointer rests on a commit SHA. The timer ref holds the pending show so a
  // quick pass-over doesn't flash the card.
  const [commitHover, setCommitHover] = useState<{ sha: string; x: number; y: number } | null>(
    null
  )
  const commitHoverTimer = useRef<number | null>(null)
  const [exited, setExited] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ resultIndex: number; resultCount: number } | null>(null)
  const [loading, setLoading] = useState(type === 'agent')
  const visibleRef = useRef(visible)
  const backgroundVarRef = useRef(backgroundVar)
  backgroundVarRef.current = backgroundVar
  const initializedRef = useRef(false)
  const session = useTerminalSession(terminalId)
  // The controllerClientId is null in the very narrow window between
  // mount and the first terminal:join dispatch landing back through the
  // state stream. Treat that as "we are controller" so input works
  // (main's gate allows writes when no session exists yet — see
  // pty:write handler).
  const myClientId = getClientId()
  const isController =
    session === null || session.controllerClientId === null || session.controllerClientId === myClientId
  const isControllerRef = useRef(isController)
  isControllerRef.current = isController
  // The terminal + its link providers are built once, so the click-modifier
  // setting is read through a ref — toggling it applies to live terminals
  // without a rebuild.
  const plainClickOpensInAppRef = useRef(plainClickOpensInApp)
  plainClickOpensInAppRef.current = plainClickOpensInApp
  // When the terminal mounts in a display:none wrapper (background tab or
  // non-active worktree), the container has zero size and FitAddon can't
  // compute dimensions. We stash the deferred spawn here so the visible
  // effect kicks it off once the container actually has layout.
  const pendingSpawnRef = useRef<(() => void) | null>(null)

  // Keep ref in sync so the ResizeObserver callback sees current value
  visibleRef.current = visible

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return
    initializedRef.current = true

    const openUrlInBrowserTab = (uri: string): void => {
      // Browser tabs live in panes alongside terminals; appending here
      // bypasses the App-level handleAddBrowserTab so XTerminal stays
      // self-contained. paneId is omitted — panesFSM falls back to the
      // first leaf which is correct for the common single-pane case.
      let label = 'Browser'
      try {
        label = new URL(uri).host || label
      } catch {
        // ignore; fall back to generic label
      }
      const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      void backend.panesAddTab(cwd, { id, type: 'browser', label, url: uri })
    }

    // Both link providers — xterm's core OSC 8 provider (via `linkHandler`)
    // and the WebLinksAddon (plain-text URLs) — route through this one
    // closure so the destination logic can't drift. Plain click → OS
    // default browser; Cmd/Ctrl-click → in-app browser tab (swapped when
    // the terminalPlainClickOpensInApp setting is on); mailto → external
    // either way (the in-app browser can't open it).
    const isWebUri = (uri: string): boolean =>
      uri.startsWith('http://') || uri.startsWith('https://')
    // Schemes we'll hand to the OS on a plain click. vnc:// resolves to the
    // user's Screen Sharing / VNC client; mailto: to their mail client.
    const isExternalUri = (uri: string): boolean =>
      isWebUri(uri) || uri.startsWith('mailto:') || uri.startsWith('vnc://')
    const activateUri = (event: { metaKey: boolean; ctrlKey: boolean }, uri: string): void => {
      // Only web URLs can render in an in-app browser tab; vnc:// and mailto:
      // are OS-handled schemes, so they always go external.
      const wantsInApp =
        (event.metaKey || event.ctrlKey) !== plainClickOpensInAppRef.current
      const inApp = wantsInApp && isWebUri(uri)
      if (inApp) {
        openUrlInBrowserTab(uri)
        return
      }
      if (isExternalUri(uri)) {
        backend.openExternal(uri)
      }
    }

    // Tracks the URL currently under the pointer (set/cleared by the link
    // providers' hover/leave). Used to swallow a link click's mouse-report
    // bytes before they reach the PTY — see the onData handler below.
    let hoveredLinkUri: string | null = null
    const setHoveredLink = (uri: string | null): void => {
      hoveredLinkUri = uri
    }

    const terminal = new Terminal({
      fontSize: effectiveTerminalFontSize(),
      fontFamily: currentFontFamily,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      // Hold ⌥ (Option) while dragging to force a local xterm selection even
      // when the app owns the mouse. Agents (Claude/Codex) enable mouse
      // tracking, and a remote session wrapped in tmux with `mouse on` grabs
      // the drag for its own copy buffer — in both cases a plain drag never
      // becomes a browser selection, so ⌘C has nothing to copy. With this,
      // ⌥-drag selects locally and ⌘C copies to the system clipboard, while
      // a plain drag still reaches the app. Mirrors iTerm2's Option-drag.
      macOptionClickForcesSelection: true,
      linkHandler: {
        activate: (event, uri) => activateUri(event, uri),
        hover: (_event, uri) => setHoveredLink(uri),
        leave: () => setHoveredLink(null)
      },
      theme: buildTerminalTheme(backgroundVarRef.current)
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    const webLinksAddon = new WebLinksAddon(
      (event, uri) => {
        event.preventDefault()
        activateUri(event, uri)
      },
      {
        hover: (_event, uri) => setHoveredLink(uri),
        leave: () => setHoveredLink(null),
        // Extend the addon's default scheme list (https?) to also match
        // vnc:// so Screen Sharing links are clickable. Mirrors the upstream
        // trailing-punctuation trimming so we don't eat a closing ) or .
        urlRegex:
          /(https?|HTTPS?|vnc|VNC):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/
      }
    )
    terminal.loadAddon(webLinksAddon)

    const progressAddon = new ProgressAddon()
    terminal.loadAddon(progressAddon)
    // Only the controller dispatches — spectators parse the same OSC stream
    // identically, so letting them all dispatch would 2x+ the IPC traffic
    // and the reducer would dedup most of it anyway.
    const progressSub = progressAddon.onChange((p) => {
      if (!isControllerRef.current) return
      backend.setTerminalProgress(terminalId, p.state, p.value)
    })

    const searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)
    searchAddonRef.current = searchAddon
    const searchResultsSub = searchAddon.onDidChangeResults((e) => {
      setSearchResults({ resultIndex: e.resultIndex, resultCount: e.resultCount })
    })

    // File-path links: validate against the worktree's file list and make
    // real, in-worktree paths clickable. Like URLs: plain click opens the
    // file in the external editor; Cmd/Ctrl-click opens an in-app file tab.
    const fileLinkProvider = terminal.registerLinkProvider(
      makeFileLinkProvider({
        terminal,
        cwd,
        getKnownFiles: () => getCachedWorktreeFiles(cwd),
        openInApp: (rel) => {
          void backend.panesOpenFile(cwd, rel, terminalId)
        },
        openInEditor: (rel) => {
          void backend.openInEditor(cwd, rel)
        },
        plainClickOpensInApp: () => plainClickOpensInAppRef.current,
        onHoverChange: (hovering) => setHoveredLink(hovering ? 'file:' : null)
      })
    )

    // Commit-SHA links: validate hex tokens against the worktree's commit
    // set and make real commits clickable. Hover shows a blame-style card; a
    // click opens a popup with the commit's metadata + changed files.
    // Setting hoveredLink on hover feeds the same mouse-report withholding the
    // URL providers use, so the click that opens the popup isn't also
    // forwarded to a mouse-aware app (e.g. Claude Code).
    const clearCommitHoverTimer = (): void => {
      if (commitHoverTimer.current !== null) {
        window.clearTimeout(commitHoverTimer.current)
        commitHoverTimer.current = null
      }
    }
    const commitLinkProvider = terminal.registerLinkProvider(
      makeCommitLinkProvider({
        terminal,
        getKnownCommits: () => getCachedWorktreeCommits(cwd),
        openCommit: (fullSha, event) => {
          clearCommitHoverTimer()
          setCommitHover(null)
          setCommitPopup({ sha: fullSha, x: event.clientX, y: event.clientY })
        },
        onHover: (fullSha, event) => {
          setHoveredLink('commit:')
          const x = event.clientX
          const y = event.clientY
          clearCommitHoverTimer()
          commitHoverTimer.current = window.setTimeout(() => {
            setCommitHover({ sha: fullSha, x, y })
          }, 280)
        },
        onLeave: () => {
          setHoveredLink(null)
          clearCommitHoverTimer()
          setCommitHover(null)
        }
      })
    )

    // Translate Shift+Enter into "backslash + Enter" (\\\r). By default xterm
    // sends bare \r for both Enter and Shift+Enter, so Claude Code can't tell
    // them apart and treats Shift+Enter as submit. Sending `\` then Enter
    // matches Claude Code's documented line-continuation pattern and inserts
    // a newline regardless of cursor position.
    terminal.attachCustomKeyEventHandler((e) => {
      // Intercept Cmd/Ctrl+F before any controller gating so spectators
      // can search scrollback too.
      if (
        e.type === 'keydown' &&
        (e.key === 'f' || e.key === 'F') &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey
      ) {
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen(true)
        // Defer focus until after React renders the input.
        requestAnimationFrame(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        })
        return false
      }
      if (!isControllerRef.current) {
        // Spectators shouldn't inject even our Shift+Enter escape;
        // main would drop the write too, but swallowing here keeps
        // local copy/paste selection working while blocking input.
        return true
      }
      if (
        e.type === 'keydown' &&
        e.key === 'Enter' &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        e.stopPropagation()
        backend.writeTerminal(terminalId, '\\\r')
        return false
      }
      return true
    })

    terminal.open(containerRef.current)

    requestAnimationFrame(() => {
      fitAddon.fit()
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    terminalRegistry.set(terminalId, terminal)
    fitRegistry.set(terminalId, fitAddon)
    registerTerminalBackend(terminalId, backendScope)

    // One-time host preamble (e.g. the Quake boot banner). Written here,
    // before the history replay / PTY spawn below, so it always sits above
    // the shell's first prompt. Purely visual — never echoed to the PTY.
    if (preamble) terminal.write(preamble)

    // Restore scrollback (if any) before spawning the PTY so historical output
    // appears above the fresh shell's prompt.
    let cleanupData: (() => void) | null = null
    let cleanupExit: (() => void) | null = null
    let disposed = false

    if (type === 'agent') {
      cleanupExit = backend.onTerminalExit((id) => {
        if (id === terminalId && !disposed) setExited(true)
      })
    }

    const buildAgentArg = async (): Promise<string> => {
      return backend.buildAgentSpawnArgs(agentKind || 'claude', {
        terminalId,
        cwd,
        sessionId,
        initialPrompt,
        teleportSessionId,
        sessionName,
        modelOverride
      })
    }

    const spawnPty = async (): Promise<void> => {
      if (disposed) return
      // If the container has no layout yet (display:none background tab),
      // defer the spawn. The visible useEffect below will call this again
      // once the tab becomes visible and FitAddon can compute real dims.
      // Spawning now would come up at the fallback 120x30 and every burst
      // of output before the first resize IPC would paint at the wrong
      // column, producing a visible "flash" when the worktree is opened.
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width < 20 || rect.height < 20) {
        pendingSpawnRef.current = () => { void spawnPty() }
        return
      }
      pendingSpawnRef.current = null

      // Empty string falls through to env.SHELL in pty-manager — picks up the
      // user's actual shell instead of hardcoding zsh on bash-only systems.
      const shell = ''
      const agentArg = type === 'agent' ? await buildAgentArg() : ''
      if (disposed) return
      // Shell tabs always come up as a plain interactive shell, even when the
      // tab carries a `command`. Executing it belongs to the create_shell
      // path in main, which spawns eagerly at creation time; doing it here too
      // would re-run the command every time the PTY is gone but the tab isn't
      // — i.e. on every app restart, and after the command's shell exits.
      const args = type === 'agent' ? ['-ilc', agentArg] : ['-il']
      const spawnCwd = shellCwd
        ? shellCwd.startsWith('/')
          ? shellCwd
          : `${cwd}/${shellCwd}`
        : cwd
      // Pass the renderer's fitted dimensions so the PTY spawns at the
      // right grid size instead of main's fallback 120x30.
      let spawnCols: number | undefined
      let spawnRows: number | undefined
      try {
        fitAddon.fit()
        const dims = fitAddon.proposeDimensions()
        if (dims && dims.cols > 0 && dims.rows > 0) {
          spawnCols = dims.cols
          spawnRows = dims.rows
        }
      } catch {
        // fall back to main's defaults
      }
      backend.createTerminal(terminalId, spawnCwd, shell, args, type === 'agent' ? agentKind : undefined, spawnCols, spawnRows)

      terminal.onData((data) => {
        // Spectators silently drop input. Main also enforces this, but
        // gating here avoids the round-trip + any suggestion the keystroke
        // "took" (we don't echo back since xterm's local echo is off).
        if (!isControllerRef.current) return
        // When the pointer is over a link, withhold the click's mouse-report
        // bytes from the PTY. A mouse-aware app (e.g. Claude Code, which
        // enables mouse tracking) can't tell the click landed on one of its
        // OSC 8 hyperlinks, so it would ALSO open the URL — a second browser
        // tab on top of Ness's own link handling. Ness's linkHandler /
        // WebLinksAddon still fire on the same click, so the link opens
        // exactly once and honors the Cmd/Ctrl modifier. Non-link clicks
        // pass through untouched so the app's mouse UI keeps working.
        if (hoveredLinkUri && isMouseButtonReport(data)) return
        backend.writeTerminal(terminalId, data)
      })

      cleanupData = backend.onTerminalData((id, data) => {
        if (id === terminalId) {
          terminal.write(sanitizeTerminalData(data))
          setLoading(false)
        }
      })

      // Safety net: if no output has arrived by the time spawnPty
      // returns + a short grace window, clear the overlay anyway. This
      // covers the "attach to a running but idle Claude with no
      // accumulated history" case, where getTerminalHistory returns ''
      // and no new bytes will flow until the user does something — the
      // overlay would otherwise stay forever.
      setTimeout(() => {
        if (!disposed) setLoading(false)
      }, 800)
    }

    backend.getTerminalHistory(terminalId).then((history) => {
      if (disposed) return
      if (!history) {
        spawnPty()
        return
      }
      // A non-empty history means this tab has run before — either main
      // still holds a live PTY for it (we're attaching to a running one) or
      // the scrollback came off disk from a previous app run. Clear the
      // loading overlay so it's visible without waiting for new bytes
      // (which may never come if the agent is idle at its prompt).
      setLoading(false)
      // Replay raw scrollback. Wait for xterm to finish parsing before
      // attaching onData, otherwise any response sequences xterm generates
      // mid-parse (e.g. focus reports from CSI ?1004h in the saved history)
      // get sent to the freshly spawned PTY — which is how a stray "O" was
      // leaking into Claude on session resume (focus-out = ESC [ O).
      terminal.write(sanitizeTerminalData(history), () => {
        if (disposed) return
        // Reset any reporting modes the restored session may have left on, so
        // the fresh process starts in a clean state.
        const RESET_MODES =
          '\x1b[?1004l' + // focus reporting
          '\x1b[?1000l' + // mouse click tracking
          '\x1b[?1002l' + // mouse cell tracking
          '\x1b[?1003l' + // mouse all tracking
          '\x1b[?1006l' + // SGR mouse encoding
          '\x1b[?2004l'   // bracketed paste
        const restoreTrailer = hideRestoreNotice
          ? RESET_MODES
          : RESET_MODES + '\r\n\x1b[2m── session restored ──\x1b[0m\r\n'
        terminal.write(restoreTrailer, () => {
          if (disposed) return
          spawnPty()
        })
      })
    }).catch(() => {
      spawnPty()
    })

    // Handle resize — only fit when actually visible. Spectators still
    // call fitAddon.fit() so the local xterm renders at the controller's
    // dimensions, but they don't forward resize signals — the PTY size
    // is authoritative and owned by the controller. Last-reported dims
    // are kept on a closure-scoped ref to dedupe the IPC: a backend-swap
    // re-flips display:none on every xterm of the new active worktree,
    // so without dedup we'd fire a resize per terminal even when the
    // dimensions are unchanged.
    let lastReportedCols = -1
    let lastReportedRows = -1
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!visibleRef.current) return
      if (!entry) return
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      if (w === 0 || h === 0) return
      requestAnimationFrame(() => {
        if (!fitAddonRef.current) return
        fitAddonRef.current.fit()
        const dims = fitAddonRef.current.proposeDimensions()
        if (!dims || !isControllerRef.current) return
        if (dims.cols === lastReportedCols && dims.rows === lastReportedRows) return
        lastReportedCols = dims.cols
        lastReportedRows = dims.rows
        backend.resizeTerminal(terminalId, dims.cols, dims.rows)
      })
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      disposed = true
      // PTY lifetime is owned by main now: panes:closeTab,
      // panes:restartAgentTab, and panes:clearForWorktree call
      // ptyManager.kill on the way out. We don't kill from XTerminal
      // unmount because unmount can fire for reasons unrelated to the
      // user wanting the agent dead — a web client closing a browser
      // tab, a renderer reload, etc. — and any one of those used to
      // take Claude down for every connected client.
      backend.leaveTerminal(terminalId)
      terminalRegistry.delete(terminalId)
      fitRegistry.delete(terminalId)
      // Deliberately AFTER leaveTerminal above, which still needs to reach
      // this terminal's backend. markTerminalClosing can also fire from a
      // tab-close path after unmount, so it tolerates a missing entry.
      forgetTerminalBackend(terminalId)
      resizeObserver.disconnect()
      cleanupData?.()
      cleanupExit?.()
      searchResultsSub.dispose()
      progressSub.dispose()
      fileLinkProvider.dispose()
      commitLinkProvider.dispose()
      clearCommitHoverTimer()
      searchAddonRef.current = null
      terminal.dispose()
    }
  }, [terminalId, cwd, type])

  // Announce our presence on the session roster. For the spawn path
  // this is redundant with pty:create's implicit controlTaken, but
  // dispatching here too covers the attach case (second client mounts
  // an XTerminal for a terminal whose PTY already exists).
  useEffect(() => {
    backend.joinTerminal(terminalId)
  }, [terminalId])

  // Re-fire terminal:join after a WS reconnect. The server cleared the
  // session's controllerClientId when the old socket closed, and the
  // renderer just got a fresh server-side clientId — without a re-join
  // the session entry stays orphaned and pty:write is silently dropped
  // by main's "controllerClientId !== ctx.clientId" gate.
  useEffect(() => {
    return subscribeActiveTransportReconnect(() => {
      backend.joinTerminal(terminalId)
    })
  }, [terminalId, backend])

  // Re-apply the xterm theme when the app theme changes. theme-apply.ts
  // mutates `data-theme` and inline `style` on :root; observe both so we
  // pick up built-in switches and custom-theme overrides alike. Using a
  // MutationObserver (rather than keying on useActiveTheme) avoids a child-
  // before-parent useEffect race where the child would read stale CSS vars.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const terminal = terminalRef.current
      if (!terminal) return
      terminal.options.theme = buildTerminalTheme(backgroundVarRef.current)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style']
    })
    return () => observer.disconnect()
  }, [])

  // Re-fit when the terminal becomes visible
  useEffect(() => {
    if (!visible || !fitAddonRef.current || !containerRef.current) return

    const doFit = (reason: string): void => {
      if (!fitAddonRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      console.log(`[xterm] doFit reason=${reason} id=${terminalId} rect=${Math.round(rect.width)}x${Math.round(rect.height)}`)
      if (rect.width === 0 || rect.height === 0) return
      fitAddonRef.current.fit()
      // If the PTY spawn was deferred because the container was hidden at
      // mount, fire it now that we have real dimensions — before any
      // resize IPC, so the very first spawn lands at the right grid size.
      if (pendingSpawnRef.current) {
        const pending = pendingSpawnRef.current
        pendingSpawnRef.current = null
        pending()
        return
      }
      const dims = fitAddonRef.current.proposeDimensions()
      if (dims) {
        console.log(`[xterm] resize id=${terminalId} cols=${dims.cols} rows=${dims.rows}`)
        backend.resizeTerminal(terminalId, dims.cols, dims.rows)
      }
    }

    // Multiple passes to handle layout settling after display:none removal
    requestAnimationFrame(() => doFit('visible-raf'))
    const t1 = setTimeout(() => doFit('visible-50ms'), 50)
    const t2 = setTimeout(() => doFit('visible-150ms'), 150)

    const onFocus = (): void => doFit('window-focus')
    const onVisChange = (): void => doFit('visibility-change')
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisChange)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisChange)
    }
  }, [visible, terminalId])

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    const types = e.dataTransfer.types
    if (!types.includes('Files') && !types.includes('text/plain')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      e.preventDefault()
      const paths = files
        .map((f) => backend.getFilePath(f))
        .filter((p) => p && p.length > 0)
      if (paths.length === 0) return
      // Match iTerm2: shell-quote each path, join with spaces, wrap in
      // bracketed-paste markers so Claude (and other readline-style prompts)
      // treat it as a paste rather than per-keystroke input.
      // Claude Code detects image paths in pasted text and renders them as
      // attachments, but only when escaped iTerm2-style (backslash-escaped
      // special chars, not POSIX single-quoting).
      const escapeForDrop = (p: string): string => p.replace(/([ \t"'`$\\!?*()[\]{}|;<>&#])/g, '\\$1')
      const text = paths.map(escapeForDrop).join(' ')
      backend.writeTerminal(terminalId, '\x1b[200~' + text + '\x1b[201~')
      terminalRef.current?.focus()
      return
    }
    // In-app drag: panels set a text/plain payload (e.g. "@path/to/file ",
    // a check URL, or a commit SHA). Pasted verbatim with bracketed-paste
    // markers so the agent sees it as a single chunk.
    const dragText = e.dataTransfer.getData('text/plain')
    if (!dragText) return
    e.preventDefault()
    backend.writeTerminal(terminalId, '\x1b[200~' + dragText + '\x1b[201~')
    terminalRef.current?.focus()
  }

  const handleTakeControl = (): void => {
    const controller = session?.controllerClientId ?? 'null'
    if (!fitAddonRef.current) {
      console.log(`[take-control] click id=${terminalId} myClientId=${myClientId} prevController=${controller} dims=fallback-120x30`)
      backend.takeTerminalControl(terminalId, 120, 30)
      return
    }
    try {
      fitAddonRef.current.fit()
      const dims = fitAddonRef.current.proposeDimensions()
      if (dims && dims.cols > 0 && dims.rows > 0) {
        console.log(`[take-control] click id=${terminalId} myClientId=${myClientId} prevController=${controller} dims=${dims.cols}x${dims.rows}`)
        backend.takeTerminalControl(terminalId, dims.cols, dims.rows)
      } else {
        console.log(`[take-control] click id=${terminalId} myClientId=${myClientId} prevController=${controller} dims=fallback-120x30`)
        backend.takeTerminalControl(terminalId, 120, 30)
      }
    } catch {
      console.log(`[take-control] click id=${terminalId} myClientId=${myClientId} prevController=${controller} dims=fallback-caught`)
      backend.takeTerminalControl(terminalId, 120, 30)
    }
  }

  const closeSearch = (): void => {
    setSearchOpen(false)
    setSearchResults(null)
    searchAddonRef.current?.clearDecorations()
    terminalRef.current?.focus()
  }

  const handleSearchNext = (): void => {
    const addon = searchAddonRef.current
    if (!addon || !searchQuery) return
    addon.findNext(searchQuery, { decorations: SEARCH_DECORATIONS })
  }

  const handleSearchPrev = (): void => {
    const addon = searchAddonRef.current
    if (!addon || !searchQuery) return
    addon.findPrevious(searchQuery, { decorations: SEARCH_DECORATIONS })
  }

  const handleSearchQueryChange = (value: string): void => {
    setSearchQuery(value)
    const addon = searchAddonRef.current
    if (!addon) return
    if (!value) {
      addon.clearDecorations()
      setSearchResults(null)
      return
    }
    addon.findNext(value, { decorations: SEARCH_DECORATIONS, incremental: true })
  }

  const showSpectatorOverlay = session !== null && session.controllerClientId !== null && session.controllerClientId !== myClientId

  // Diagnostic for the controller/spectator UI flow. Logs the overlay
  // decision whenever the session roster or cached clientId changes
  // so we can correlate with the `[take-control]` lines from
  // renderer/store.ts and main's debug log.
  useEffect(() => {
    console.log(
      `[take-control] overlay id=${terminalId} myClientId=${myClientId} controller=${session?.controllerClientId ?? 'null'} showOverlay=${showSpectatorOverlay} isController=${isController}`
    )
  }, [terminalId, myClientId, session?.controllerClientId, showSpectatorOverlay, isController])

  return (
    <div
      className="w-full h-full relative"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div ref={containerRef} className="w-full h-full" />
      {searchOpen && (
        <div className="absolute top-2 left-2 z-10 pointer-events-auto">
          <FindBar
            query={searchQuery}
            hitIndex={searchResults?.resultIndex ?? 0}
            hitCount={searchResults?.resultCount ?? 0}
            placeholder="Find in terminal"
            inputRef={searchInputRef}
            onQueryChange={handleSearchQueryChange}
            onNext={handleSearchNext}
            onPrev={handleSearchPrev}
            onClose={closeSearch}
          />
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-app/70 pointer-events-none">
          <div className="flex flex-col items-center gap-3 text-dim text-sm">
            <ClaudeLoader />
            <div className="flex items-center">
              <span>Starting {agentDisplayName(agentKind)}</span>
              <span className="claude-loader-dots ml-1">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        </div>
      )}
      {showSpectatorOverlay && (
        <div className="absolute top-2 right-2 flex items-center gap-2 pointer-events-auto">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-panel/90 border border-border text-xs text-dim">
            <Eye className="icon-xs" />
            <span>Spectating</span>
          </div>
          <button
            onClick={handleTakeControl}
            className="px-2 py-1 rounded-md text-xs bg-panel/90 border border-border text-fg-bright hover:bg-border transition-colors"
          >
            Take control
          </button>
        </div>
      )}
      {!loading && !exited && onSwitchToChat && type === 'agent' && supportsChat(agentKind) && !chatPromotionDismissed && (
        <div className="absolute top-2 left-2 flex items-center gap-1 pointer-events-auto">
          <Tooltip label="You can always switch modes by right-clicking the tab.">
            <button
              onClick={onSwitchToChat}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs bg-panel/90 border border-border text-fg-bright hover:bg-border transition-colors"
            >
              <Sparkles className="icon-xs text-accent" />
              <span>Switch to the new Chat mode</span>
            </button>
          </Tooltip>
          <Tooltip label="You can always switch modes by right-clicking the tab.">
            <button
              onClick={() => { void backend.setChatPromotionDismissed(true) }}
              aria-label="Dismiss Chat mode promotion"
              className="p-1 rounded-md bg-panel/90 border border-border text-dim hover:text-fg-bright transition-colors"
            >
              <X className="icon-xs" />
            </button>
          </Tooltip>
        </div>
      )}
      {exited && type === 'agent' && onRestartAgent && (
        <div className="absolute inset-0 flex items-center justify-center bg-app/80">
          <div className="flex flex-col items-center gap-3 text-sm">
            <div className="text-dim">{agentDisplayName(agentKind)} exited.</div>
            <button
              onClick={onRestartAgent}
              className="px-3 py-1.5 rounded border border-border bg-panel text-fg-bright hover:bg-border transition-colors"
            >
              Start a new session
            </button>
          </div>
        </div>
      )}
      {commitHover && !commitPopup && (
        <CommitHoverCard
          worktreePath={cwd}
          sha={commitHover.sha}
          anchor={{ x: commitHover.x, y: commitHover.y }}
        />
      )}
      {commitPopup && (
        <CommitInfoModal
          worktreePath={cwd}
          sha={commitPopup.sha}
          anchor={{ x: commitPopup.x, y: commitPopup.y }}
          onClose={() => setCommitPopup(null)}
        />
      )}
    </div>
  )
}
