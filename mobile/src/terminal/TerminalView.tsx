// A Claude Code / Shell tab: xterm.js in a WebView (./html.ts) and the
// accessory key row. The PTY conversation is XTerminal.tsx's, step for
// step, through client.api:
//
//   join → wait for the page's first fit → replay scrollback (history) →
//   reset reporting modes → spawn / attach (pty:create, at the fitted size)
//   → stream terminal:data → leave on unmount (main owns PTY lifetime).
//
// Terminal data is a side-effect signal, never state, so it goes straight
// from the socket to the page through OutputQueue (batched, one injection
// in flight) and never touches React state or the store.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState as RNAppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useKeyboardState } from 'react-native-keyboard-controller'
import * as ExpoClipboard from 'expo-clipboard'
import { ArrowDownToLine, ChevronDown, ClipboardPaste, Eye, Keyboard as KeyboardIcon, Loader2 } from 'lucide-react-native'
import type { TerminalTab } from '../../../src/shared/state/terminals'
import { agentDisplayName } from '../../../src/shared/agent-registry'
import { scaledEditorFontSize } from '../../../src/shared/state/settings'
import { useNess, type NessClient } from '../ness'
import { haptic } from '../haptics'
import { Spin } from '../components/Spin'
import { alpha, c, fs, mono, themed } from '../theme'
import { terminalPageHtml } from './html'
import { terminalTheme } from './theme'
import { OutputQueue } from './output-queue'
import { encodeKey, encodeText } from './keys'

// XTerminal writes these after replaying scrollback so a mode the old
// process left on (focus or mouse reporting, bracketed paste) doesn't apply
// to the fresh one.
const RESET_MODES = '\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l'
const RESTORED = '\r\n\x1b[2m── session restored ──\x1b[0m\r\n'

type PageMessage =
  | { t: 'ready' | 'resize'; cols: number; rows: number }
  | { t: 'ack' }
  | { t: 'data'; data: string }
  | { t: 'text'; text: string }
  | { t: 'key'; key: string }
  | { t: 'focus'; on: boolean }
  | { t: 'scrolled'; atBottom: boolean }

export function TerminalView({
  client,
  worktreePath,
  tab,
  onRestartAgent
}: {
  client: NessClient
  worktreePath: string
  tab: TerminalTab & { type: 'agent' | 'shell' }
  onRestartAgent?: () => void
}) {
  const api = client.api
  const id = tab.id
  const webRef = useRef<React.ComponentRef<typeof WebView>>(null)
  const dims = useRef<{ cols: number; rows: number } | null>(null)
  /** start() has begun for this page load (guards a second 'ready'). */
  const started = useRef(false)
  /** pty:create has been sent: from here the PTY may take input/resizes. */
  const spawned = useRef(false)
  const [loading, setLoading] = useState(tab.type === 'agent')
  const [exited, setExited] = useState(false)
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  ctrlRef.current = ctrl
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [scrolledBack, setScrolledBack] = useState(false)
  // The host's terminal font settings, as the web client uses (its backend
  // is its host). Baked into the page at load; a change applies on the
  // next mount.
  const fontSize = useNess(client, (st) => scaledEditorFontSize(st.settings.terminalFontSize || 13, st.settings.uiScale))
  const fontFamily = useNess(client, (st) => st.settings.terminalFontFamily)
  // A WebView whose content process iOS killed (memory pressure while
  // backgrounded) comes back blank; remount and replay from history.
  const [generation, setGeneration] = useState(0)

  const inject = useCallback((js: string) => webRef.current?.injectJavaScript(`${js};true;`), [])
  const queue = useMemo(() => new OutputQueue((chunk) => inject(`window.ness.write(${JSON.stringify(chunk)})`)), [inject, generation]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => queue.dispose(), [queue])

  // Controller gate, like XTerminal's isController. clientId is per
  // connection, so it's re-read after every reconnect.
  const session = useNess(client, (s) => s.terminals.sessions[id] ?? null)
  const [myClientId, setMyClientId] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const read = () => void client.transport.getClientId().then((cid) => live && setMyClientId(cid), () => {})
    read()
    const off = client.transport.onReconnect(read)
    return () => {
      live = false
      off()
    }
  }, [client])
  const isController = session === null || session.controllerClientId === null || session.controllerClientId === myClientId
  const isControllerRef = useRef(isController)
  isControllerRef.current = isController
  const spectating = session !== null && session.controllerClientId !== null && myClientId !== null && session.controllerClientId !== myClientId

  const write = useCallback(
    (data: string) => {
      if (!isControllerRef.current || !data) return
      api.writeTerminal(id, data)
    },
    [api, id]
  )

  // Presence on the session roster; re-join after a reconnect, which
  // cleared our controllership server-side (see XTerminal).
  useEffect(() => {
    api.joinTerminal(id)
    const off = client.transport.onReconnect(() => api.joinTerminal(id))
    return () => {
      off()
      api.leaveTerminal(id)
    }
  }, [api, client, id])

  useEffect(() => {
    if (tab.type !== 'agent') return
    return api.onTerminalExit((tid) => {
      if (tid === id) setExited(true)
    })
  }, [api, id, tab.type])

  // Runs once per page load, on its first fit: the spawn needs real
  // dimensions so the PTY doesn't come up at main's 120x30 fallback.
  const start = useCallback(async () => {
    let off: (() => void) | null = null
    let disposed = false
    console.log('[tt] start', id) // TTDEBUG
    const history = await api.getTerminalHistory(id).catch(() => '')
    console.log('[tt] history', history.length) // TTDEBUG
    if (history) {
      setLoading(false)
      queue.push(history)
      queue.push(RESET_MODES + RESTORED)
      // Wait for the page to finish parsing the replay before xterm's own
      // replies are forwarded, or a focus report in the saved bytes leaks
      // into the fresh PTY as a stray "O" (XTerminal's fix).
      await queue.drained()
    }
    const args = tab.type === 'agent'
      ? ['-ilc', await api.buildAgentSpawnArgs(tab.agentKind || 'claude', {
          terminalId: id,
          cwd: worktreePath,
          sessionId: tab.sessionId,
          sessionName: tab.label,
          modelOverride: tab.model
        })]
      : ['-il']
    const shellCwd = tab.type === 'shell' && tab.cwd
      ? tab.cwd.startsWith('/') ? tab.cwd : `${worktreePath}/${tab.cwd}`
      : worktreePath
    console.log('[tt] args', alive.current, JSON.stringify(args).slice(0, 100)) // TTDEBUG
    if (!alive.current) return () => {}
    const d = dims.current
    off = api.onTerminalData((tid, data) => {
      if (tid !== id) return
      queue.push(data)
      setLoading(false)
    })
    api.createTerminal(id, shellCwd, '', args, tab.type === 'agent' ? tab.agentKind : undefined, d?.cols, d?.rows)
    spawned.current = true
    // An attached-but-idle agent with no history sends nothing; don't
    // leave the loading overlay up forever.
    setTimeout(() => !disposed && setLoading(false), 800)
    return () => {
      disposed = true
      off?.()
    }
  }, [api, id, queue, tab.type, tab.agentKind, tab.sessionId, tab.label, tab.model, tab.cwd, worktreePath])

  const stopRef = useRef<(() => void) | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      stopRef.current?.()
      stopRef.current = null
    }
  }, [generation])

  // The phone is backgrounded constantly; resend the size on return in case
  // the window changed (rotation) while the page was suspended.
  useEffect(() => {
    const sub = RNAppState.addEventListener('change', (st) => {
      if (st === 'active' && dims.current && spawned.current && isControllerRef.current) {
        api.resizeTerminal(id, dims.current.cols, dims.current.rows)
      }
    })
    return () => sub.remove()
  }, [api, id])

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let m: PageMessage
      try {
        m = JSON.parse(e.nativeEvent.data) as PageMessage
      } catch {
        return
      }
      if (m.t !== 'ack') console.log('[tt] page', e.nativeEvent.data.slice(0, 120)) // TTDEBUG
      switch (m.t) {
        case 'ready':
          dims.current = { cols: m.cols, rows: m.rows }
          if (!started.current) {
            started.current = true
            void start().then((stop) => {
              // Unmounted (or the page died) while history was loading.
              if (alive.current) stopRef.current = stop
              else stop()
            })
          }
          break
        case 'resize':
          dims.current = { cols: m.cols, rows: m.rows }
          if (spawned.current && isControllerRef.current) api.resizeTerminal(id, m.cols, m.rows)
          break
        case 'ack':
          queue.ack()
          break
        case 'data':
          // xterm's replies to queries (cursor position, device attributes)
          // and term.paste output. Withheld until the PTY exists, so replies
          // to the replayed history never reach the new process.
          if (spawned.current) write(m.data)
          break
        case 'text': {
          const { data, ctrlUsed } = encodeText(m.text, ctrlRef.current)
          if (ctrlUsed) setCtrl(false)
          write(data)
          break
        }
        case 'key':
          write(encodeKey(m.key))
          break
        case 'focus':
          setKeyboardOpen(m.on)
          break
        case 'scrolled':
          setScrolledBack(!m.atBottom)
          break
      }
    },
    [api, id, queue, start, write]
  )

  const sendKey = useCallback(
    (key: string) => {
      haptic.select()
      write(encodeKey(key))
    },
    [write]
  )

  const paste = useCallback(async () => {
    const text = await ExpoClipboard.getStringAsync().catch(() => '')
    if (!text) return
    haptic.select()
    // Through the page's term.paste, which wraps in bracketed-paste markers
    // only when the program asked for them, exactly like a desktop paste.
    inject(`window.ness.paste(${JSON.stringify(text)})`)
  }, [inject])

  const reload = useCallback(() => {
    started.current = false
    spawned.current = false
    setGeneration((g) => g + 1)
  }, [])

  // Output sent while the socket was down never arrives (terminal:data
  // isn't replayed), so after a reconnect the page is stale. Reload it,
  // which re-runs the attach above: fresh history, then live data.
  // Reconnects are common on a phone (every return from the background).
  useEffect(() => client.transport.onReconnect(() => spawned.current && reload()), [client, reload])

  const takeControl = useCallback(() => {
    const d = dims.current ?? { cols: 120, rows: 30 }
    api.takeTerminalControl(id, d.cols, d.rows)
  }, [api, id])

  // Built once per mount: the theme can't change under a live terminal
  // (a theme change remounts the screen), and re-rendering the source would
  // reload the page.
  const html = useMemo(
    // Menlo last: the desktop's family names Mac fonts iOS may not have.
    () => terminalPageHtml({ theme: terminalTheme(), fontSize, fontFamily: `${fontFamily ? `${fontFamily}, ` : ''}Menlo, monospace` }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [generation]
  )

  const agentName = agentDisplayName(tab.agentKind)
  // The root layout leaves the bottom safe area to each screen (the chat
  // composer sits over it). Keys must not: a swipe on them would hit the
  // home indicator. With the keyboard up the KAV already lifts the row.
  const kbVisible = useKeyboardState((k) => k.isVisible)
  const bottomInset = useSafeAreaInsets().bottom

  return (
    <View style={{ flex: 1, backgroundColor: c.app }}>
      <View style={{ flex: 1 }}>
        <WebView
          key={generation}
          ref={webRef}
          source={{ html }}
          originWhitelist={['*']}
          onMessage={onMessage}
          style={{ flex: 1, backgroundColor: c.app }}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          // The keyboard button focuses the page's input programmatically,
          // which iOS only honours (shows the keyboard for) with this off.
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          setSupportMultipleWindows={false}
          javaScriptEnabled
          onContentProcessDidTerminate={reload}
          onRenderProcessGone={reload}
          accessibilityLabel={`${tab.customLabel ?? tab.label} terminal`}
        />

        {loading && (
          <View style={[StyleSheet.absoluteFill, s.center, { backgroundColor: alpha(c.app, 0.7) }]} pointerEvents="none">
            <Spin><Loader2 color={c.dim} size={18} /></Spin>
            <Text style={{ color: c.dim, fontSize: fs.sm }}>Starting {agentName}…</Text>
          </View>
        )}

        {spectating && (
          <View style={[s.chipRow, { right: 8 }]}>
            <View style={s.chip}>
              <Eye color={c.dim} size={12} />
              <Text style={[s.chipText, { color: c.dim }]}>Spectating</Text>
            </View>
            <Pressable onPress={takeControl} style={({ pressed }) => [s.chip, pressed && { backgroundColor: c.surface }]} accessibilityRole="button">
              <Text style={s.chipText}>Take control</Text>
            </Pressable>
          </View>
        )}

        {scrolledBack && (
          <Pressable
            onPress={() => {
              inject('window.ness.scrollToBottom()')
              setScrolledBack(false)
            }}
            style={s.jump}
            accessibilityRole="button"
          >
            <ArrowDownToLine color={c.fgBright} size={12} />
            <Text style={{ color: c.fgBright, fontSize: fs.xs }}>Jump to bottom</Text>
          </Pressable>
        )}

        {exited && (
          <View style={[StyleSheet.absoluteFill, s.center, { backgroundColor: alpha(c.app, 0.8) }]}>
            <Text style={{ color: c.dim, fontSize: fs.sm }}>{agentName} exited.</Text>
            {onRestartAgent && (
              <Pressable onPress={onRestartAgent} style={({ pressed }) => [s.restart, pressed && { backgroundColor: c.surface }]} accessibilityRole="button">
                <Text style={{ color: c.fgBright, fontSize: fs.sm }}>Start a new session</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>

      <View style={[s.bar, { paddingBottom: kbVisible ? 0 : bottomInset }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={s.keys}>
          <Key label="esc" onPress={() => sendKey('Escape')} />
          <Key label="tab" onPress={() => sendKey('Tab')} />
          <Key label="ctrl" active={ctrl} onPress={() => { haptic.select(); setCtrl((v) => !v) }} a11y="Control (applies to the next key)" />
          <Key label="^C" onPress={() => sendKey('\x03')} a11y="Control C" />
          <Key label="↑" onPress={() => sendKey('ArrowUp')} a11y="Up arrow" />
          <Key label="↓" onPress={() => sendKey('ArrowDown')} a11y="Down arrow" />
          <Key label="←" onPress={() => sendKey('ArrowLeft')} a11y="Left arrow" />
          <Key label="→" onPress={() => sendKey('ArrowRight')} a11y="Right arrow" />
          <Key label="⏎" onPress={() => sendKey('Enter')} a11y="Return" />
          {/* Claude Code's line continuation, what Shift+Enter sends on desktop. */}
          {tab.type === 'agent' && <Key label="⇧⏎" onPress={() => sendKey('\\\r')} a11y="Newline" />}
          <Key label="⌫" onPress={() => sendKey('Backspace')} a11y="Backspace" />
          <Key onPress={() => void paste()} a11y="Paste">
            <ClipboardPaste color={c.fg} size={14} />
          </Key>
        </ScrollView>
        <Pressable
          onPress={() => inject(keyboardOpen ? 'window.ness.blur()' : 'window.ness.focus()')}
          style={({ pressed }) => [s.kbBtn, pressed && { backgroundColor: c.surface }]}
          accessibilityRole="button"
          accessibilityLabel={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
        >
          {keyboardOpen ? <ChevronDown color={c.fgBright} size={16} /> : <KeyboardIcon color={c.fgBright} size={16} />}
        </Pressable>
      </View>
    </View>
  )
}

function Key({ label, onPress, active, a11y, children }: { label?: string; onPress: () => void; active?: boolean; a11y?: string; children?: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      // 36pt key + the bar's 4pt padding above and below = 44pt target.
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => [s.key, active && s.keyActive, pressed && { backgroundColor: c.surface }]}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={active !== undefined ? { selected: active } : undefined}
    >
      {children ?? <Text style={[s.keyText, active && { color: c.fgBright }]}>{label}</Text>}
    </Pressable>
  )
}

const s = themed(() => StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  chipRow: { position: 'absolute', top: 8, flexDirection: 'row', gap: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    minHeight: 30,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: alpha(c.panel, 0.9)
  },
  chipText: { color: c.fgBright, fontSize: fs.xs },
  jump: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: alpha(c.surface, 0.9)
  },
  restart: { paddingHorizontal: 12, minHeight: 44, justifyContent: 'center', borderRadius: 4, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel },
  bar: { flexDirection: 'row', borderTopWidth: 1, borderColor: c.border, backgroundColor: c.panelRaised },
  keys: { alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 4 },
  key: {
    minWidth: 44,
    height: 36,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.panel
  },
  keyActive: { backgroundColor: alpha(c.accent, 0.3), borderColor: alpha(c.accent, 0.5) },
  keyText: { color: c.fg, fontSize: fs.xs, fontFamily: mono },
  kbBtn: { width: 48, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderColor: c.border }
}))
