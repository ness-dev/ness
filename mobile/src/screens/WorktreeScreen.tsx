// The worktree screen: header (worktree picker button, tab strip, tools
// button) over the selected tab. Port of the web client's mobile shell
// (src/renderer/components/MobileApp.tsx), kept structurally parallel to it
// on purpose — selection fallback, rising-edge wake, add-tab and
// convert-menu behaviour mirror that file, so read the two side by side
// when changing either. Which worktree is shown is the route (/w/[wt]);
// the picker is an overlay on this screen, like the web's dropdown.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, Linking, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { Redirect, router } from 'expo-router'
import { ChevronDown, FileDiff, FileText, Globe, Loader2, PanelRightOpen, Plus, SquareTerminal } from 'lucide-react-native'
import { supportsChat } from '../../../src/shared/agent-registry'
import type { PtyStatus, TerminalTab } from '../../../src/shared/state/terminals'
import { haptic } from '../haptics'
import { firstLeafId, newChatTab } from '../tabs'
import { rememberTab, setLastWorktree, useSelectedTabId } from '../navState'
import { toolsHref, worktreeHref } from '../routes'
import { useFleetEntries, useMerged } from '../fleet'
import { useWorkspace } from '../workspace'
import { useNess, type NessClient } from '../ness'
import { STATUS_DOT, c, fs, themed } from '../theme'
import { AgentIcon } from '../components/AgentIcon'
import { ChatView } from '../components/ChatView'
import { WorktreePicker } from '../components/WorktreePicker'
import { Spin } from '../components/Spin'
import { Empty } from '../components/Empty'
import { ViewerTab } from '../viewer/ViewerTab'

export function WorktreeScreen({ wtPath, tabParam }: { wtPath: string; tabParam?: string }) {
  const { fleet } = useWorkspace()
  const merged = useMerged(fleet)
  const worktrees = merged.flatWorktrees
  const [pickerOpen, setPickerOpen] = useState(false)
  const [convertMenu, setConvertMenu] = useState<{ tab: TerminalTab; convertible: boolean; x: number; y: number } | null>(null)
  const windowWidth = useWindowDimensions().width

  const activeWorktree = useMemo(() => worktrees.find((w) => w.path === wtPath) ?? null, [worktrees, wtPath])
  const client = activeWorktree ? fleet.client(merged.pathBackendId[activeWorktree.path]) ?? null : null

  useEffect(() => {
    if (activeWorktree) setLastWorktree(activeWorktree.path)
  }, [activeWorktree])

  // A link's ?tab= (an approval push, an /open link) is applied on arrival,
  // then dropped from the route so it can't override later choices.
  useEffect(() => {
    if (!tabParam) return
    rememberTab(wtPath, tabParam)
    router.setParams({ tab: undefined })
  }, [wtPath, tabParam])

  // A worktree that isn't (or is no longer) there — removed, or a link to
  // a host that isn't connected: once every backend has reported (or 3s
  // have passed), go home, which picks a worktree that exists.
  const allSnapshotted = useFleetEntries(fleet).length === fleet.getClients().length
  const [waitedEnough, setWaitedEnough] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setWaitedEnough(true), 3000)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (activeWorktree && client) void client.api.panesEnsureInitialized(activeWorktree.path)
  }, [activeWorktree?.path, client])

  const tabs = activeWorktree ? merged.tabsByWorktree[activeWorktree.path] ?? [] : []
  const selectedTabId = useSelectedTabId(activeWorktree?.path ?? null, tabs)
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
    void client.api.panesWakeTab(activeWorktree.path, selectedTab.id)
  }, [activeWorktree, selectedTab, selectedTabId, client])

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

  // Switching worktrees replaces the route: there's no "back" to the
  // previous worktree, same as the web's picker.
  const handleSelectWorktree = useCallback(
    (path: string) => {
      haptic.select()
      setPickerOpen(false)
      if (path !== wtPath) router.replace(worktreeHref(path))
    },
    [wtPath]
  )

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (!activeWorktree) return
      if (tabId !== selectedTabId) haptic.select()
      rememberTab(activeWorktree.path, tabId)
      setPickerOpen(false)
    },
    [activeWorktree, selectedTabId]
  )

  const handleAddChat = useCallback(() => {
    if (!activeWorktree || !client) return
    const wtPath = activeWorktree.path
    const tree = merged.panes[wtPath]
    const paneId = tree ? firstLeafId(tree) : undefined
    const tab = newChatTab()
    void client.api.panesAddTab(wtPath, tab, paneId)
    rememberTab(wtPath, tab.id)
    setPickerOpen(false)
  }, [activeWorktree, client, merged.panes])

  const handleConvertTabType = useCallback(
    (tabId: string, newType: 'agent' | 'json-claude') => {
      if (activeWorktree && client) void client.api.panesConvertTabType(activeWorktree.path, tabId, newType)
    },
    [activeWorktree, client]
  )

  if (!activeWorktree && (allSnapshotted || waitedEnough) && worktrees.length > 0) return <Redirect href="/" />

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
                  // "dismiss the picker", so no tab menu.
                  onOpenMenu={!pickerOpen ? (pos) => setConvertMenu({ tab, convertible, ...pos }) : undefined}
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
              // The composer's keyboard would otherwise sit over the panel.
              Keyboard.dismiss()
              setPickerOpen(false)
              router.push(toolsHref(activeWorktree.path))
            }}
            style={({ pressed }) => [s.detailsBtn, pressed && { backgroundColor: c.surface }]}
            accessibilityLabel="Worktree details"
          >
            <PanelRightOpen color={c.dim} size={16} />
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
        {activeWorktree && client && selectedTab && (selectedTab.type === 'file' || selectedTab.type === 'diff') && (
          <ViewerTab key={`${client.id}:${selectedTab.id}`} client={client} worktreePath={activeWorktree.path} tab={selectedTab} />
        )}
        {activeWorktree && selectedTab && !['json-claude', 'agent', 'shell', 'file', 'diff'].includes(selectedTab.type) && (
          <NonRunnablePlaceholder tab={selectedTab} />
        )}
        {activeWorktree && !selectedTab && <Empty message="This worktree has no tabs yet. Open it on desktop to spawn one." />}
        {!activeWorktree && worktrees.length === 0 && <Empty message={fleet.getEntries().length ? 'No worktrees yet.' : 'Connecting…'} />}
        {!activeWorktree && worktrees.length > 0 && <Empty message="Connecting…" />}

        {convertMenu && (
          <Pressable style={[StyleSheet.absoluteFill, { zIndex: 40 }]} onPress={() => setConvertMenu(null)}>
            <View style={[s.menu, { left: Math.max(4, Math.min(convertMenu.x, windowWidth - 232)), top: 0 }]}>
              {convertMenu.convertible && (
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
              )}
              {/* The desktop chip's X: any tab, the last one included, no
                  confirm; PanesFSM.closeTab ends the tab's process. */}
              <Pressable
                style={({ pressed }) => [s.menuItem, pressed && { backgroundColor: c.panel }]}
                onPress={() => {
                  const { tab } = convertMenu
                  setConvertMenu(null)
                  if (!activeWorktree || !client) return
                  // Land on the neighbour, as the desktop's pane does (the
                  // one before it, else the one after).
                  const i = tabs.findIndex((t) => t.id === tab.id)
                  const next = tabs[i - 1] ?? tabs[i + 1]
                  if (next) rememberTab(activeWorktree.path, next.id)
                  void client.api.panesCloseTab(activeWorktree.path, tab.id)
                }}
              >
                <Text style={{ color: c.fgBright, fontSize: fs.xs }}>Close tab</Text>
              </Pressable>
            </View>
          </Pressable>
        )}
        {pickerOpen && (
          <WorktreePicker
            fleet={fleet}
            merged={merged}
            activeWorktreeId={activeWorktree?.path ?? null}
            onSelect={handleSelectWorktree}
            onClose={() => setPickerOpen(false)}
            // One overlay at a time: the picker is accessibilityViewIsModal,
            // so leaving it open under Backends hid Backends from VoiceOver.
            onOpenBackends={() => {
              setPickerOpen(false)
              router.push('/backends')
            }}
          />
        )}
      </View>
    </View>
  )
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

const s = themed(() => StyleSheet.create({
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
