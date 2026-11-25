// Spike UI, modelled on the web client's mobile layout (MobileApp.tsx):
// a top bar with the worktree switcher + that worktree's chat tabs, the
// chat filling the rest, and a full-screen worktree sheet. Several
// backends can be enabled at once; the sheet lists each one's repos.
// No Expo Router — the spike proves the data path, not the nav shell.
import { StatusBar } from 'expo-status-bar'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { Asterisk, ChevronDown, Plus } from 'lucide-react-native'
import { parseConnectionUrl } from '../src/shared/transport/parse-connection-url'
import type { TerminalTab } from '../src/shared/state/terminals'
import { useBackends } from './src/backends'
import { NessClient, chatTabsOf, useConn, useNess } from './src/ness'
import { STATUS_DOT, c, fs } from './src/theme'
import { ChatView } from './src/components/ChatView'
import { WorktreeSheet, type Selection } from './src/components/WorktreeSheet'
import { BackendsSheet } from './src/components/BackendsSheet'

export default function App() {
  const backends = useBackends()
  const [selection, setSelection] = useState<Selection | null>(null)
  const [tabByPath, setTabByPath] = useState<Record<string, string>>({})
  const [sheet, setSheet] = useState<'worktrees' | 'backends' | null>(null)

  // Deep-link pairing: <scheme>://pair?url=<connection link>. In Expo Go
  // that's exp://<metro>/--/pair?url=…; a production app would register
  // ness:// so the desktop QR could open it straight from the system
  // camera.
  useEffect(() => {
    const handle = (link: string | null | undefined) => {
      const m = link && /[?&]url=([^&]+)/.exec(link)
      if (!m) return
      const r = parseConnectionUrl(decodeURIComponent(m[1]))
      if (r.ok) backends.add({ wsUrl: r.parsed.wsUrl, token: r.parsed.token })
    }
    void Linking.getInitialURL().then(handle)
    const sub = Linking.addEventListener('url', (e) => handle(e.url))
    return () => sub.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const client = backends.clients.find((cl) => cl.id === selection?.backendId) ?? null

  // Drop a selection whose backend was disabled or removed.
  useEffect(() => {
    if (selection && backends.loaded && !client) setSelection(null)
  }, [selection, client, backends.loaded])

  if (!backends.loaded) {
    return (
      <Shell>
        <ActivityIndicator color={c.muted} style={{ flex: 1 }} />
      </Shell>
    )
  }
  if (backends.saved.length === 0) {
    return (
      <Shell>
        <BackendsSheet backends={backends} />
      </Shell>
    )
  }

  const tabKey = client && selection ? `${client.id}:${selection.path}` : ''
  return (
    <Shell>
      {client && selection ? (
        <WorktreeView
          key={tabKey}
          client={client}
          path={selection.path}
          tabId={tabByPath[tabKey]}
          onTab={(id) => setTabByPath((p) => ({ ...p, [tabKey]: id }))}
          onOpenSheet={() => setSheet('worktrees')}
        />
      ) : (
        <AutoSelect clients={backends.clients} onSelect={setSelection} onOpenSheet={() => setSheet('worktrees')} />
      )}
      {sheet === 'worktrees' && (
        <WorktreeSheet
          clients={backends.clients}
          selected={selection}
          onSelect={(sel) => {
            setSelection(sel)
            setSheet(null)
          }}
          onClose={() => setSheet(null)}
          onOpenBackends={() => setSheet('backends')}
        />
      )}
      {sheet === 'backends' && <BackendsSheet backends={backends} onClose={() => setSheet('worktrees')} />}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {children}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

/** First screen after launch: open the worktree with the most recent live
 *  chat on the first enabled backend. */
function AutoSelect({
  clients,
  onSelect,
  onOpenSheet
}: {
  clients: NessClient[]
  onSelect: (s: Selection) => void
  onOpenSheet: () => void
}) {
  const first = clients[0]
  if (!first) {
    return (
      <Centered>
        <Text style={s.muted}>All backends are disabled.</Text>
        <Pressable onPress={onOpenSheet}>
          <Text style={{ color: c.accent, fontSize: fs.sm }}>Open worktrees</Text>
        </Pressable>
      </Centered>
    )
  }
  return <AutoSelectFor client={first} onSelect={onSelect} />
}

function AutoSelectFor({ client, onSelect }: { client: NessClient; onSelect: (s: Selection) => void }) {
  const conn = useConn(client)
  useEffect(() => {
    if (!conn.hasSnapshot) return
    const st = client.getState()
    const withChat = st.worktrees.list
      .filter((w) => chatTabsOf(st, w.path).some((t) => st.jsonClaude.sessions[t.id]))
      .sort((a, b) => (st.terminals.lastActive[b.path] ?? 0) - (st.terminals.lastActive[a.path] ?? 0))
    const pick = withChat[0] ?? st.worktrees.list.find((w) => w.isMain) ?? st.worktrees.list[0]
    if (pick) onSelect({ backendId: client.id, path: pick.path })
  }, [conn.hasSnapshot, client, onSelect])
  return (
    <Centered>
      <ActivityIndicator color={c.muted} />
      <Text style={s.muted}>
        {conn.error ? `${client.label}: ${conn.error} — retrying` : `Connecting to ${client.label}…`}
      </Text>
    </Centered>
  )
}

function WorktreeView({
  client,
  path,
  tabId,
  onTab,
  onOpenSheet
}: {
  client: NessClient
  path: string
  tabId: string | undefined
  onTab: (id: string) => void
  onOpenSheet: () => void
}) {
  const wt = useNess(client, (st) => st.worktrees.list.find((w) => w.path === path))
  const pane = useNess(client, (st) => st.terminals.panes[path])
  const sessions = useNess(client, (st) => st.jsonClaude.sessions)
  const conn = useConn(client)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tabs = useMemo(() => chatTabsOf(client.getState(), path), [client, path, pane])

  // Default tab: a live session beats an exited or slept one.
  const active =
    tabs.find((t) => t.id === tabId) ??
    tabs.find((t) => sessions[t.id] && sessions[t.id].state !== 'exited') ??
    tabs[0]

  const newChat = () => void client.addChatTab(path).then(onTab)
  const repo = (wt?.repoRoot ?? path).split('/').pop() ?? ''
  return (
    <View style={{ flex: 1 }}>
      <View style={s.topBar}>
        <Pressable onPress={onOpenSheet} style={s.wtButton}>
          <View style={{ minWidth: 0, flexShrink: 1 }}>
            <Text style={s.wtRepo} numberOfLines={1}>
              {repo}
            </Text>
            <Text style={s.wtBranch} numberOfLines={1}>
              {wt?.isMain ? 'main' : wt?.branch ?? path.split('/').pop()}
            </Text>
          </View>
          <ChevronDown color={c.dim} size={14} />
          {!conn.connected && <View style={[s.tabDot, { backgroundColor: c.danger }]} />}
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'stretch' }}>
          {tabs.map((t) => (
            <ChatTab key={t.id} client={client} tab={t} active={t.id === active?.id} onPress={() => onTab(t.id)} />
          ))}
          <Pressable style={s.addTab} hitSlop={6} onPress={newChat} accessibilityLabel="New chat">
            <Plus color={c.dim} size={16} />
          </Pressable>
        </ScrollView>
      </View>
      {active ? (
        <ChatView key={active.id} client={client} sessionId={active.id} worktreePath={path} />
      ) : (
        <Centered>
          <Text style={s.muted}>No chat tab in this worktree.</Text>
          <Text style={[s.muted, { color: c.faint, textAlign: 'center', paddingHorizontal: 32 }]}>
            Terminal tabs stream raw PTY output, which the mobile client doesn't render.
          </Text>
          <Pressable style={s.newChatBtn} onPress={newChat}>
            <Plus color="#fff" size={14} />
            <Text style={{ color: '#fff', fontSize: fs.xs, fontWeight: '500' }}>New chat</Text>
          </Pressable>
        </Centered>
      )}
    </View>
  )
}

function ChatTab({
  client,
  tab,
  active,
  onPress
}: {
  client: NessClient
  tab: TerminalTab
  active: boolean
  onPress: () => void
}) {
  const status = useNess(client, (st) => st.terminals.statuses[tab.id] ?? 'idle')
  return (
    <Pressable onPress={onPress} style={[s.tab, active && s.tabActive]}>
      <Asterisk color="#d97757" size={14} strokeWidth={3} />
      <View style={[s.tabDot, { backgroundColor: STATUS_DOT[status] }]} />
      <Text style={[s.tabText, active && { color: c.fgBright }]} numberOfLines={1}>
        {tab.customLabel || tab.label}
      </Text>
    </Pressable>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>{children}</View>
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.app },
  muted: { color: c.muted, fontSize: fs.xs },
  topBar: {
    height: 44,
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderColor: c.border,
    backgroundColor: c.panel
  },
  wtButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    maxWidth: 180,
    borderRightWidth: 1,
    borderColor: c.border
  },
  wtRepo: { color: c.dim, fontSize: fs.xs, textTransform: 'uppercase', letterSpacing: 0.6 },
  wtBranch: { color: c.fgBright, fontSize: fs.xs, fontWeight: '500' },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderBottomWidth: 2,
    borderColor: 'transparent'
  },
  tabActive: { borderColor: c.muted, backgroundColor: c.app },
  tabText: { color: c.dim, fontSize: fs.xs, maxWidth: 120 },
  tabDot: { width: 6, height: 6, borderRadius: 3 },
  addTab: { paddingHorizontal: 12, justifyContent: 'center' },
  newChatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: c.accent,
    borderRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 6
  }
})
