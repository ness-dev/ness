// Port of the web client's mobile shell (src/renderer/components/
// MobileApp.tsx). Kept structurally parallel to it on purpose — selection
// fallback, rising-edge wake, add-tab and convert-menu behaviour all mirror
// that file, so read the two side by side when changing either. The
// worktree list itself comes from the renderer's own pure model code via
// src/fleet.ts, across every enabled backend.
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { KeyboardAvoidingView, KeyboardProvider } from 'react-native-keyboard-controller'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View
} from 'react-native'
import { ChevronDown, FileDiff, FileText, Globe, Loader2, PanelRightClose, PanelRightOpen, Plus, SquareTerminal } from 'lucide-react-native'
import { parseConnectionUrl } from '../src/shared/transport/parse-connection-url'
import { supportsChat } from '../src/shared/agent-registry'
import type { PtyStatus, TerminalTab } from '../src/shared/state/terminals'
import { randomUUID } from '../src/renderer/uuid'
import { useBackends } from './src/backends'
import { consumeLaunchUrl } from './src/launchUrl'
import { Fleet, useFleetEntries, useMerged } from './src/fleet'
import { useNess, type NessClient } from './src/ness'
import { STATUS_DOT, applyTheme, c, fs, getThemeMode, themeKey, themed } from './src/theme'
import { AgentIcon } from './src/components/AgentIcon'
import { ChatView } from './src/components/ChatView'
import { WorktreePicker } from './src/components/WorktreePicker'
import { BackendsSheet } from './src/components/BackendsSheet'
import { Spin } from './src/components/Spin'
import { PanelsHost } from './src/panels/PanelsHost'
import { getLeaves } from '../src/shared/state/terminals'

export default function Root() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <App />
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}

function App() {
  const backends = useBackends()
  const fleet = useMemo(() => new Fleet(), [])
  // In an effect, not during render: setClients notifies subscribers.
  useEffect(() => fleet.setClients(backends.clients), [fleet, backends.clients])
  const [showBackends, setShowBackends] = useState(false)
  const theme = useThemeFromSettings(fleet)

  // Deep-link pairing: <scheme>://pair?url=<connection link>.
  useEffect(() => {
    const handle = (link: string | null | undefined) => {
      const m = link && /[?&]url=([^&]+)/.exec(link)
      if (!m) return
      const r = parseConnectionUrl(decodeURIComponent(m[1]))
      if (r.ok) backends.add({ wsUrl: r.parsed.wsUrl, token: r.parsed.token })
    }
    void consumeLaunchUrl().then(handle)
    const sub = Linking.addEventListener('url', (e) => handle(e.url))
    return () => sub.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!backends.loaded) {
    return (
      <Shell key={theme}>
        <ActivityIndicator color={c.muted} style={{ flex: 1 }} />
      </Shell>
    )
  }
  if (backends.saved.length === 0) {
    return (
      <Shell key={theme}>
        <BackendsSheet backends={backends} />
      </Shell>
    )
  }
  return (
    <Shell key={theme}>
      <MobileApp fleet={fleet} onOpenBackends={() => setShowBackends(true)} />
      {showBackends && <BackendsSheet backends={backends} onClose={() => setShowBackends(false)} />}
    </Shell>
  )
}

// Ness's colour theme is a client-owned setting; the phone follows the
// first connected backend's (normally the user's own desktop), with
// 'system' resolved against the phone's appearance. The palette is applied
// during render, before anything below reads `c`, and the returned key
// remounts the UI subtree so every component and themed() style picks up
// the new colours. Backend connections live above it and stay up.
function useThemeFromSettings(fleet: Fleet): string {
  const entries = useFleetEntries(fleet)
  const settings = entries[0]?.state.settings
  const systemScheme = useColorScheme()
  return useMemo(() => {
    const inputs = {
      themeMode: settings?.themeMode ?? 'dark',
      themeLight: settings?.themeLight ?? '',
      themeDark: settings?.themeDark ?? '',
      customThemes: settings?.customThemes ?? [],
      nessieColor: settings?.nessieColor ?? '',
      systemScheme
    }
    applyTheme(inputs)
    return themeKey(inputs)
  }, [settings, systemScheme])
}

// keyboard-controller's KeyboardAvoidingView animates frame-by-frame with
// the keyboard on the UI thread (RN's own one ran a LayoutAnimation that
// moved the composer's button row and its text box at different speeds).
//
// Bottom edge: deliberately ignores the bottom safe area, so with the
// keyboard down the composer sits on the screen's bottom edge (only its own
// 12pt padding below it, over the home indicator) instead of 34pt higher.
// The KAV spans to the screen bottom, so its padding is exactly the
// keyboard height and the composer still rests 12pt above the keyboard.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={s.screen} edges={['top', 'left', 'right']}>
      <StatusBar style={getThemeMode() === 'light' ? 'dark' : 'light'} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {children}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const K_ACTIVE = 'ness.mobile.activeWorktree'
const K_TABS = 'ness.mobile.selectedTabs'

function pickInitialTab(tabs: TerminalTab[]): string | null {
  return tabs.find((t) => t.type === 'agent')?.id ?? tabs.find((t) => t.type === 'shell')?.id ?? tabs[0]?.id ?? null
}

function MobileApp({ fleet, onOpenBackends }: { fleet: Fleet; onOpenBackends: () => void }) {
  const merged = useMerged(fleet)
  const worktrees = merged.flatWorktrees
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null)
  // Mobile's own per-worktree tab focus, independent of desktop panes.
  const [selectedTabByWorktree, setSelectedTabByWorktree] = useState<Record<string, string>>({})
  const [pickerOpen, setPickerOpen] = useState(false)
  // Per-client UI focus, same as the web's rightPanelOpen.
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [convertMenu, setConvertMenu] = useState<{ tab: TerminalTab; x: number; y: number } | null>(null)
  const windowWidth = useWindowDimensions().width

  // Usability deviation from the web (which starts at worktrees[0] on every
  // load): a phone app is relaunched constantly, so restore the last
  // worktree + per-worktree tab focus. Still per-client UI state.
  const restored = useRef<{ wt: string | null; tabs: Record<string, string> } | null>(null)
  const [restoreDone, setRestoreDone] = useState(false)
  useEffect(() => {
    void AsyncStorage.multiGet([K_ACTIVE, K_TABS]).then((pairs) => {
      const m = Object.fromEntries(pairs)
      let tabs: Record<string, string> = {}
      try {
        tabs = m[K_TABS] ? JSON.parse(m[K_TABS]) : {}
      } catch {
        // ignore corrupt entry
      }
      restored.current = { wt: m[K_ACTIVE] ?? null, tabs }
      setSelectedTabByWorktree((prev) => ({ ...tabs, ...prev }))
      setRestoreDone(true)
    })
  }, [])
  // Backends snapshot at different times: don't fall back to
  // worktrees[0] while the saved worktree's host may still be connecting
  // (that would also overwrite the saved choice). Capped so an offline
  // host can't hold the first screen hostage.
  const allSnapshotted = useFleetEntries(fleet).length === fleet.getClients().length
  const [waitedEnough, setWaitedEnough] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setWaitedEnough(true), 3000)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    if (activeWorktreeId && worktrees.some((w) => w.path === activeWorktreeId)) return
    if (worktrees.length === 0 || !restoreDone) return
    const saved = restored.current?.wt
    if (saved && worktrees.some((w) => w.path === saved)) setActiveWorktreeId(saved)
    else if (!saved || allSnapshotted || waitedEnough) setActiveWorktreeId(worktrees[0].path)
  }, [activeWorktreeId, worktrees, restoreDone, allSnapshotted, waitedEnough])
  useEffect(() => {
    if (activeWorktreeId) void AsyncStorage.setItem(K_ACTIVE, activeWorktreeId)
  }, [activeWorktreeId])
  useEffect(() => {
    if (Object.keys(selectedTabByWorktree).length) void AsyncStorage.setItem(K_TABS, JSON.stringify(selectedTabByWorktree))
  }, [selectedTabByWorktree])

  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.path === activeWorktreeId) ?? null,
    [worktrees, activeWorktreeId]
  )
  const client = activeWorktree ? fleet.client(merged.pathBackendId[activeWorktree.path]) ?? null : null

  useEffect(() => {
    if (activeWorktree && client) void client.req('panes:ensureInitialized', activeWorktree.path)
  }, [activeWorktree?.path, client])

  // Once per backend as it joins, like MobileApp's mount effect.
  const refreshed = useRef(new Set<string>())
  const clients = fleet.getClients()
  useEffect(() => {
    for (const cl of clients) {
      if (refreshed.current.has(cl.id) || !cl.getConn().hasSnapshot) continue
      refreshed.current.add(cl.id)
      void cl.req('worktrees:refreshList')
      void cl.req('prs:refreshAllIfStale')
    }
  })

  const tabs = activeWorktree ? merged.tabsByWorktree[activeWorktree.path] ?? [] : []

  const selectedTabId = useMemo(() => {
    if (!activeWorktree) return null
    const claimed = selectedTabByWorktree[activeWorktree.path]
    if (claimed && tabs.some((t) => t.id === claimed)) return claimed
    return pickInitialTab(tabs)
  }, [activeWorktree, selectedTabByWorktree, tabs])
  const selectedTab = tabs.find((t) => t.id === selectedTabId) ?? null

  // Rising-edge wake, mirroring MobileApp: PanesFSM hydrates persisted
  // chat/shell tabs asleep, so a tab first opened from the phone would
  // otherwise render blank. Only on selection change, so a tab slept from
  // another client stays slept.
  const prevSelectedTabRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevSelectedTabRef.current
    prevSelectedTabRef.current = selectedTabId
    if (prev === selectedTabId || !activeWorktree || !selectedTab || !client) return
    if (selectedTab.type !== 'json-claude' && selectedTab.type !== 'shell') return
    if ((selectedTab.mode ?? 'awake') !== 'asleep') return
    void client.req('panes:wakeTab', activeWorktree.path, selectedTab.id)
  }, [activeWorktree, selectedTab, selectedTabId, client])

  // <scheme>://open?wt=<worktree path>&tab=<tab id> — jump straight to a
  // chat. What a push notification for an approval will deep-link to.
  useEffect(() => {
    const handle = (link: string | null | undefined) => {
      if (!link || !/\/open\?/.test(link)) return
      const q = new URLSearchParams(link.slice(link.indexOf('?') + 1))
      const wt = q.get('wt')
      const tab = q.get('tab')
      if (!wt) return
      setActiveWorktreeId(wt)
      if (tab) setSelectedTabByWorktree((prev) => ({ ...prev, [wt]: tab }))
      setPickerOpen(false)
    }
    void consumeLaunchUrl().then(handle)
    const sub = Linking.addEventListener('url', (e) => handle(e.url))
    return () => sub.remove()
  }, [])

  // Keep the selected tab visible: on a phone the strip overflows and the
  // selected tab could otherwise sit under the details button.
  const tabStripRef = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const tabStripWidth = useRef(0)
  const tabLayouts = useRef<Record<string, { x: number; w: number }>>({})
  useEffect(() => {
    const id = selectedTabId
    if (!id) return
    // Layout lands a frame after the tab mounts.
    const t = setTimeout(() => {
      const l = tabLayouts.current[id]
      if (!l) return
      const visible = tabStripWidth.current
      tabStripRef.current?.scrollTo({ x: Math.max(0, l.x + l.w - visible + 48), animated: true })
    }, 50)
    return () => clearTimeout(t)
  }, [selectedTabId, tabs.length])

  const handleSelectWorktree = useCallback((wtPath: string) => {
    setActiveWorktreeId(wtPath)
    setPickerOpen(false)
    setRightPanelOpen(false)
  }, [])

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (!activeWorktree) return
      setSelectedTabByWorktree((prev) => ({ ...prev, [activeWorktree.path]: tabId }))
      setPickerOpen(false)
    },
    [activeWorktree]
  )

  const handleAddChat = useCallback(() => {
    if (!activeWorktree || !client) return
    const wtPath = activeWorktree.path
    const tree = merged.panes[wtPath]
    const paneId = tree ? firstLeafId(tree) : undefined
    // One UUID as both tab id and session id, same as useTabHandlers.
    const sessionId = randomUUID()
    const tab: TerminalTab = { id: sessionId, type: 'json-claude', label: 'Chat', sessionId }
    void client.req('panes:addTab', wtPath, tab, paneId)
    setSelectedTabByWorktree((prev) => ({ ...prev, [wtPath]: tab.id }))
    setPickerOpen(false)
  }, [activeWorktree, client, merged.panes])

  // Port of useTabHandlers' handleSendToAgent: the phone's selected tab if
  // it's an agent/chat, else a pane's active one, else the first; chat gets
  // a message, a terminal agent a bracketed paste. Then focus that tab.
  const handleSendToAgent = useCallback(
    (text: string) => {
      if (!activeWorktree || !client) return
      const sendable = (t: TerminalTab) => t.type === 'agent' || t.type === 'json-claude'
      const tree = merged.panes[activeWorktree.path]
      const leaves = tree ? getLeaves(tree) : []
      const target =
        (selectedTab && sendable(selectedTab) ? selectedTab : undefined) ??
        leaves.map((l) => l.tabs.find((t) => t.id === l.activeTabId)).find((t): t is TerminalTab => !!t && sendable(t)) ??
        tabs.find(sendable)
      if (!target) return
      setSelectedTabByWorktree((prev) => ({ ...prev, [activeWorktree.path]: target.id }))
      setRightPanelOpen(false)
      if (target.type === 'json-claude') client.sig('jsonClaude:send', target.id, text)
      else client.sig('pty:write', target.id, '\x1b[200~' + text + '\x1b[201~')
    },
    [activeWorktree, client, merged.panes, selectedTab, tabs]
  )

  const handleConvertTabType = useCallback(
    (tabId: string, newType: 'agent' | 'json-claude') => {
      if (activeWorktree && client) void client.req('panes:convertTabType', activeWorktree.path, tabId, newType)
    },
    [activeWorktree, client]
  )

  const label = activeWorktree
    ? merged.aliases[activeWorktree.path] ?? (activeWorktree.branch || activeWorktree.path.split('/').pop())
    : null

  return (
    <View style={{ flex: 1 }}>
      <View style={s.header}>
        <Pressable
          onPress={() => {
            Keyboard.dismiss()
            setPickerOpen((v) => !v)
          }}
          style={({ pressed }) => [s.pickerBtn, (pickerOpen || pressed) && { backgroundColor: c.surface }]}
          accessibilityRole="button"
          accessibilityLabel="Switch worktree"
        >
          {activeWorktree ? (
            <>
              <View style={{ minWidth: 0, flexShrink: 1 }}>
                <Text style={s.repoLabel} numberOfLines={1}>
                  {activeWorktree.repoRoot.split('/').pop()}
                </Text>
                <Text style={s.branchLabel} numberOfLines={1}>
                  {label}
                </Text>
              </View>
              <ChevronDown color={c.dim} size={14} style={{ transform: [{ rotate: pickerOpen ? '180deg' : '0deg' }] }} />
            </>
          ) : (
            <Text style={{ color: c.fg, fontSize: fs.sm }}>Select a worktree</Text>
          )}
        </Pressable>
        <ScrollView
          ref={tabStripRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ alignItems: 'stretch' }}
          onLayout={(e) => (tabStripWidth.current = e.nativeEvent.layout.width)}
        >
          {client &&
            tabs.map((tab) => {
              const convertible = (tab.type === 'agent' && supportsChat(tab.agentKind)) || tab.type === 'json-claude'
              return (
                <TabChip
                  key={tab.id}
                  client={client}
                  tab={tab}
                  active={tab.id === selectedTabId}
                  onSelect={() => handleSelectTab(tab.id)}
                  onLayout={(x, w) => (tabLayouts.current[tab.id] = { x, w })}
                  // With the picker open, a tap on the active tab means
                  // "dismiss the picker", so no convert menu.
                  onOpenMenu={convertible && !pickerOpen ? (pos) => setConvertMenu({ tab, ...pos }) : undefined}
                />
              )
            })}
          {activeWorktree && (
            <Pressable onPress={handleAddChat} style={({ pressed }) => [s.addBtn, pressed && { backgroundColor: c.panelRaised }]} accessibilityLabel="New chat">
              <AgentIcon kind="claude" size={12} />
              <Plus color={c.dim} size={10} />
            </Pressable>
          )}
        </ScrollView>
        {activeWorktree && (
          <Pressable
            onPress={() => {
              // The composer's keyboard would otherwise sit over the sheet.
              Keyboard.dismiss()
              setRightPanelOpen((v) => !v)
            }}
            style={({ pressed }) => [s.detailsBtn, (rightPanelOpen || pressed) && { backgroundColor: c.surface }]}
            accessibilityLabel={rightPanelOpen ? 'Close worktree details' : 'Worktree details'}
          >
            {rightPanelOpen ? <PanelRightClose color={c.fgBright} size={16} /> : <PanelRightOpen color={c.dim} size={16} />}
          </Pressable>
        )}
      </View>

      <View style={{ flex: 1 }}>
        {activeWorktree && client && selectedTab && selectedTab.type === 'json-claude' && (
          <ChatView
            key={`${client.id}:${selectedTab.id}`}
            client={client}
            sessionId={selectedTab.id}
            worktreePath={activeWorktree.path}
            mode={selectedTab.mode ?? 'awake'}
          />
        )}
        {activeWorktree && selectedTab && (selectedTab.type === 'agent' || selectedTab.type === 'shell') && (
          <Empty message={`${selectedTab.customLabel ?? selectedTab.label} — terminal tabs aren't in the app yet`} />
        )}
        {activeWorktree && selectedTab && !['json-claude', 'agent', 'shell'].includes(selectedTab.type) && (
          <NonRunnablePlaceholder tab={selectedTab} />
        )}
        {activeWorktree && !selectedTab && <Empty message="This worktree has no tabs yet. Open it on desktop to spawn one." />}
        {!activeWorktree && worktrees.length === 0 && <Empty message={fleet.getEntries().length ? 'No worktrees yet.' : 'Connecting…'} />}

        {convertMenu && (
          <Pressable style={[StyleSheet.absoluteFill, { zIndex: 40 }]} onPress={() => setConvertMenu(null)}>
            <View style={[s.menu, { left: Math.max(4, Math.min(convertMenu.x, windowWidth - 232)), top: 0 }]}>
              <Pressable
                style={({ pressed }) => [s.menuItem, pressed && { backgroundColor: c.panel }]}
                onPress={() => {
                  const { tab } = convertMenu
                  setConvertMenu(null)
                  handleConvertTabType(tab.id, tab.type === 'agent' ? 'json-claude' : 'agent')
                }}
              >
                <Text style={{ color: c.fgBright, fontSize: fs.xs }}>
                  {convertMenu.tab.type === 'agent' ? 'Switch to Chat mode' : 'Switch to Terminal mode'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        )}
        {rightPanelOpen && activeWorktree && client && (
          <PanelsHost
            key={`${client.id}:${activeWorktree.path}`}
            client={client}
            worktree={activeWorktree}
            focusedTabId={selectedTabId}
            onSendToAgent={handleSendToAgent}
            onClose={() => setRightPanelOpen(false)}
          />
        )}
        {pickerOpen && (
          <WorktreePicker
            fleet={fleet}
            merged={merged}
            activeWorktreeId={activeWorktreeId}
            onSelect={handleSelectWorktree}
            onClose={() => setPickerOpen(false)}
            // One overlay at a time: the picker is accessibilityViewIsModal,
            // so leaving it open under Backends hid Backends from VoiceOver.
            onOpenBackends={() => {
              setPickerOpen(false)
              onOpenBackends()
            }}
          />
        )}
      </View>
    </View>
  )
}

function firstLeafId(tree: import('../src/shared/state/terminals').PaneNode): string {
  return tree.type === 'leaf' ? tree.id : firstLeafId(tree.children[0])
}

function TabChip({
  client,
  tab,
  active,
  onSelect,
  onOpenMenu,
  onLayout
}: {
  client: NessClient
  tab: TerminalTab
  active: boolean
  onSelect: () => void
  /** Tap the active tab → convert menu (mobile's right-click). */
  onOpenMenu?: (pos: { x: number; y: number }) => void
  onLayout?: (x: number, width: number) => void
}) {
  const ref = useRef<React.ComponentRef<typeof View>>(null)
  return (
    <Pressable
      ref={ref}
      onPress={() => {
        if (active && onOpenMenu) {
          ref.current?.measureInWindow((x: number, y: number) => onOpenMenu({ x, y }))
          return
        }
        onSelect()
      }}
      onLayout={(e) => onLayout?.(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      style={[s.tab, active && s.tabActive]}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
    >
      <TabIcon client={client} tab={tab} />
      <Text style={[s.tabText, active && { color: c.fgBright }]} numberOfLines={1}>
        {tab.customLabel ?? tab.label}
      </Text>
    </Pressable>
  )
}

function TabIcon({ client, tab }: { client: NessClient; tab: TerminalTab }) {
  const status = useNess(client, (st) => (st.terminals.statuses[tab.id] ?? 'idle') as PtyStatus)
  const shellActive = useNess(client, (st) => !!st.terminals.shellActivity[tab.id]?.active)
  if (tab.type === 'agent' || tab.type === 'json-claude') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <AgentIcon kind={tab.agentKind ?? 'claude'} size={12} />
        {/* Live status for agent AND chat tabs, like the desktop tab strip
            (TerminalPanel's TAB_STATUS_DOT): chat tabs get processing /
            waiting / needs-approval statuses too. */}
        <View style={[s.dot, { backgroundColor: STATUS_DOT[status] }]} />
      </View>
    )
  }
  if (tab.type === 'shell') return shellActive ? <Spin><Loader2 color={c.fgBright} size={12} /></Spin> : <SquareTerminal color={c.dim} size={12} />
  if (tab.type === 'diff') return <FileDiff color={c.dim} size={12} />
  if (tab.type === 'file') return <FileText color={c.dim} size={12} />
  if (tab.type === 'browser') return <Globe color={c.dim} size={12} />
  return null
}

function NonRunnablePlaceholder({ tab }: { tab: TerminalTab }) {
  const label = tab.type === 'diff' ? 'Diff view' : tab.type === 'file' ? 'File view' : tab.type === 'browser' ? 'Browser tab' : 'This tab'
  return (
    <View style={s.empty}>
      <Text style={{ color: c.fgBright, fontSize: fs.sm }}>{label} — desktop only</Text>
      <Text style={{ color: c.dim, fontSize: fs.xs }}>{tab.customLabel ?? tab.label}</Text>
      {tab.type === 'browser' && tab.url && (
        <Pressable onPress={() => void Linking.openURL(tab.url!)} hitSlop={10}>
          <Text style={{ color: c.accent, fontSize: fs.xs, textDecorationLine: 'underline' }}>Open URL in browser</Text>
        </Pressable>
      )}
    </View>
  )
}

function Empty({ message }: { message: string }) {
  return (
    <View style={s.empty}>
      <Text style={{ color: c.dim, fontSize: fs.sm, textAlign: 'center' }}>{message}</Text>
    </View>
  )
}

const s = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.app },
  // 45 = 44pt tap height + the 1px bottom border.
  header: { height: 45, flexDirection: 'row', borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel },
  pickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    maxWidth: '45%',
    borderRightWidth: 1,
    borderColor: c.border
  },
  repoLabel: { color: c.dim, fontSize: fs.xs, textTransform: 'uppercase', letterSpacing: 0.6 },
  branchLabel: { color: c.fgBright, fontSize: fs.xs, fontWeight: '500' },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderBottomWidth: 2, borderColor: 'transparent' },
  tabActive: { borderColor: c.muted, backgroundColor: c.app },
  tabText: { color: c.dim, fontSize: fs.xs, maxWidth: 140 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  detailsBtn: { width: 44, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderColor: c.border },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 12, minWidth: 44, justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 24 },
  menu: {
    position: 'absolute',
    minWidth: 224,
    backgroundColor: c.panelRaised,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 4,
    paddingVertical: 4
  },
  menuItem: { paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' }
}))
