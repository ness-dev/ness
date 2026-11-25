// Spike UI: pair → worktree list → one chat. Deliberately a single file
// with state-switched screens (no Expo Router) — the point is to prove
// the data path, not the navigation shell.
import { StatusBar } from 'expo-status-bar'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { parseConnectionUrl } from '../src/shared/transport/parse-connection-url'
import type { JsonClaudeChatEntry, JsonClaudePendingApproval } from '../src/shared/state/json-claude'
import type { PtyStatus } from '../src/shared/state/terminals'
import { NessClient, rollupStatus, tabsOf, useConnected, useNess } from './src/ness'
import { clearConnection, loadConnection, saveConnection, type SavedConnection } from './src/storage'

const STATUS_COLOR: Record<PtyStatus, string> = {
  idle: '#555',
  waiting: '#3b82f6',
  processing: '#eab308',
  'needs-approval': '#ef4444'
}

export default function App() {
  const [conn, setConn] = useState<SavedConnection | null | undefined>(undefined)
  useEffect(() => {
    void loadConnection().then(setConn)
  }, [])

  // Deep-link pairing: <scheme>://pair?url=<connection link>. In Expo Go
  // that's exp://<metro>/--/pair?url=…; a production app would register
  // ness:// so the desktop QR could open it straight from the system
  // camera, no in-app scanner needed.
  useEffect(() => {
    const handle = (link: string | null | undefined) => {
      if (!link) return
      const m = /[?&]url=([^&]+)/.exec(link)
      if (!m) return
      const r = parseConnectionUrl(decodeURIComponent(m[1]))
      if (!r.ok) return
      const c = { wsUrl: r.parsed.wsUrl, token: r.parsed.token }
      void saveConnection(c)
      setConn(c)
    }
    void Linking.getInitialURL().then(handle)
    const sub = Linking.addEventListener('url', (e) => handle(e.url))
    return () => sub.remove()
  }, [])

  if (conn === undefined) return <Centered><ActivityIndicator /></Centered>
  if (!conn) {
    return (
      <PairScreen
        onPaired={(c) => {
          void saveConnection(c)
          setConn(c)
        }}
      />
    )
  }
  return (
    <Connected
      conn={conn}
      onForget={() => {
        void clearConnection()
        setConn(null)
      }}
    />
  )
}

// ── Pairing ────────────────────────────────────────────────────────────

function PairScreen({ onPaired }: { onPaired: (c: SavedConnection) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const handled = useRef(false)

  // Same parser the desktop "Add Backend" modal uses, so the Settings QR
  // (http://<lan-ip>:<port>/?token=…) and a pasted link both work.
  function tryPair(raw: string): void {
    const r = parseConnectionUrl(raw)
    if (!r.ok) {
      setError(r.error)
      return
    }
    onPaired({ wsUrl: r.parsed.wsUrl, token: r.parsed.token })
  }

  return (
    <Screen title="Pair with Ness">
      <Text style={styles.muted}>
        Scan the QR in Ness → Settings → Web & mobile, or paste the link.
      </Text>
      {scanning ? (
        <View style={styles.camera}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return
              handled.current = true
              setScanning(false)
              tryPair(data)
            }}
          />
        </View>
      ) : (
        <Button
          label="Scan QR code"
          onPress={async () => {
            const p = permission?.granted ? permission : await requestPermission()
            if (!p.granted) {
              setError('Camera permission denied')
              return
            }
            handled.current = false
            setScanning(true)
          }}
        />
      )}
      <TextInput
        style={styles.input}
        placeholder="http://192.168.1.10:37291/?token=…"
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => tryPair(text)}
      />
      <Button label="Connect" onPress={() => tryPair(text)} />
      {error && <Text style={styles.error}>{error}</Text>}
    </Screen>
  )
}

// ── Connected shell ────────────────────────────────────────────────────

function Connected({ conn, onForget }: { conn: SavedConnection; onForget: () => void }) {
  const client = useMemo(() => new NessClient(conn.wsUrl, conn.token), [conn])
  const [chat, setChat] = useState<{ sessionId: string; worktreePath: string } | null>(null)

  useEffect(() => {
    client.connect().catch(() => {
      // transport retries on its own; the header shows the state
    })
    return () => client.close()
  }, [client])

  const connected = useConnected(client)
  const snapshotLoaded = useNess(client, (s) => s.worktrees.list.length > 0 || s.worktrees.repoRoots.length > 0)

  if (!snapshotLoaded) {
    return (
      <Screen title="Connecting…" right={<Link label="Forget" onPress={onForget} />}>
        {!connected && <Text style={styles.muted}>{client.getLastError() ?? 'Opening socket'} — retrying</Text>}
        <ActivityIndicator style={{ marginTop: 24 }} />
      </Screen>
    )
  }
  if (chat) return <ChatScreen client={client} {...chat} onBack={() => setChat(null)} />
  return <WorktreesScreen client={client} connected={connected} onForget={onForget} onOpenChat={setChat} />
}

// ── Worktree list ──────────────────────────────────────────────────────

function WorktreesScreen({
  client,
  connected,
  onForget,
  onOpenChat
}: {
  client: NessClient
  connected: boolean
  onForget: () => void
  onOpenChat: (c: { sessionId: string; worktreePath: string }) => void
}) {
  // Select the three inputs separately so the list only re-renders when
  // one of them changes identity (reducers preserve references).
  const list = useNess(client, (s) => s.worktrees.list)
  const panes = useNess(client, (s) => s.terminals.panes)
  const statuses = useNess(client, (s) => s.terminals.statuses)
  const approvals = useNess(client, (s) => s.jsonClaude.pendingApprovals)

  const rows = useMemo(() => {
    const state = client.getState()
    return list
      .filter((w) => !w.prunable)
      .map((w) => {
        // A worktree can hold several chat tabs; prefer one whose session
        // is alive so the row opens something useful.
        const chats = tabsOf(panes[w.path]).filter((t) => t.type === 'json-claude')
        const live = (id: string) => {
          const s = state.jsonClaude.sessions[id]
          return s && s.state !== 'exited'
        }
        const chatTab = chats.find((t) => live(t.id)) ?? chats[0]
        return { wt: w, status: rollupStatus(state, w.path), chatTab }
      })
      .sort((a, b) => (state.terminals.lastActive[b.wt.path] ?? 0) - (state.terminals.lastActive[a.wt.path] ?? 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, panes, statuses])

  const pendingCount = Object.keys(approvals).length

  return (
    <Screen
      title="Worktrees"
      subtitle={`${connected ? '● live' : '○ reconnecting'} · ${pendingCount} approval${pendingCount === 1 ? '' : 's'} · snapshot ${(client.stats.snapshotBytes / 1024).toFixed(0)}KB, ${client.stats.events} events / ${(client.stats.eventBytes / 1024).toFixed(0)}KB`}
      right={<Link label="Forget" onPress={onForget} />}
    >
      <FlatList
        data={rows}
        keyExtractor={(r) => r.wt.path}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            disabled={!item.chatTab}
            onPress={() => item.chatTab && onOpenChat({ sessionId: item.chatTab.id, worktreePath: item.wt.path })}
          >
            <View style={[styles.dot, { backgroundColor: STATUS_COLOR[item.status] }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.wt.branch || '(detached)'}
              </Text>
              <Text style={styles.muted} numberOfLines={1}>
                {item.wt.repoRoot.split('/').pop()} · {item.status}
                {item.chatTab ? '' : ' · no chat tab'}
              </Text>
            </View>
            {item.chatTab && <Text style={styles.muted}>›</Text>}
          </Pressable>
        )}
      />
    </Screen>
  )
}

// ── Chat ───────────────────────────────────────────────────────────────

function ChatScreen({
  client,
  sessionId,
  worktreePath,
  onBack
}: {
  client: NessClient
  sessionId: string
  worktreePath: string
  onBack: () => void
}) {
  const session = useNess(client, (s) => s.jsonClaude.sessions[sessionId])
  const approvals = useNess(client, (s) => s.jsonClaude.pendingApprovals)
  const [draft, setDraft] = useState('')

  // Wire snapshots strip entries; fetch them once (server dispatches
  // jsonClaude/entriesSeeded, which our reducer applies).
  useEffect(() => {
    if (session && !session.entriesHydrated) void client.fetchEntries(sessionId)
  }, [client, sessionId, !!session])

  const mine = Object.values(approvals).filter((a) => a.sessionId === sessionId)
  const entries = (session?.entries ?? []).filter((e) => !e.parentToolUseId)

  return (
    <Screen
      title={worktreePath.split('/').pop() ?? 'Chat'}
      subtitle={session ? `${session.state}${session.busy ? ' · working' : ''}` : 'asleep'}
      left={<Link label="‹ Back" onPress={onBack} />}
    >
      {!session && (
        <Button label="Wake session" onPress={() => void client.startSession(sessionId, worktreePath)} />
      )}
      <FlatList
        style={{ flex: 1 }}
        data={[...entries].reverse()}
        inverted
        keyExtractor={(e) => e.entryId}
        renderItem={({ item }) => <Entry entry={item} />}
      />
      {mine.map((a) => (
        <ApprovalCard key={a.requestId} approval={a} client={client} />
      ))}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.composer}>
          <TextInput
            style={[styles.input, { flex: 1, marginTop: 0 }]}
            placeholder={session ? 'Message Claude…' : 'Wake the session first'}
            placeholderTextColor="#666"
            editable={!!session}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => {
              if (!draft.trim()) return
              client.sendMessage(sessionId, draft.trim())
              setDraft('')
            }}
          />
          <Button
            label="Send"
            onPress={() => {
              if (!draft.trim() || !session) return
              client.sendMessage(sessionId, draft.trim())
              setDraft('')
            }}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function Entry({ entry }: { entry: JsonClaudeChatEntry }) {
  if (entry.kind === 'user') {
    return (
      <View style={[styles.bubble, styles.userBubble]}>
        <Text style={styles.text}>{entry.text}</Text>
      </View>
    )
  }
  if (entry.kind === 'error') {
    return <Text style={styles.error}>{entry.errorMessage ?? 'error'}</Text>
  }
  if (entry.kind !== 'assistant') return null
  return (
    <View style={styles.bubble}>
      {(entry.blocks ?? []).map((b, i) => {
        if (b.type === 'text') return <Text key={i} style={styles.text}>{b.text}</Text>
        if (b.type === 'tool_use')
          return (
            <Text key={i} style={styles.tool} numberOfLines={2}>
              ⚙ {b.name} {summarizeInput(b.input)}
            </Text>
          )
        return null
      })}
    </View>
  )
}

function ApprovalCard({ approval, client }: { approval: JsonClaudePendingApproval; client: NessClient }) {
  const [busy, setBusy] = useState(false)
  const act = (allow: boolean) => {
    setBusy(true)
    client.resolveApproval(approval.requestId, allow, approval.input).finally(() => setBusy(false))
  }
  return (
    <View style={styles.approval}>
      <Text style={styles.rowTitle}>Allow {approval.toolName}?</Text>
      <Text style={styles.tool} numberOfLines={4}>{summarizeInput(approval.input)}</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Button label="Allow" onPress={() => act(true)} disabled={busy} />
        <Button label="Deny" onPress={() => act(false)} disabled={busy} kind="danger" />
      </View>
    </View>
  )
}

function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url
  return typeof v === 'string' ? v : JSON.stringify(input).slice(0, 160)
}

// ── Tiny UI kit ────────────────────────────────────────────────────────

function Screen(props: {
  title: string
  subtitle?: string
  left?: React.ReactNode
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.header}>
        {props.left}
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{props.title}</Text>
          {props.subtitle && <Text style={styles.muted} numberOfLines={1}>{props.subtitle}</Text>}
        </View>
        {props.right}
      </View>
      <View style={styles.body}>{props.children}</View>
    </SafeAreaView>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}>{children}</View>
}

function Button(props: { label: string; onPress: () => void; disabled?: boolean; kind?: 'danger' }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={[styles.button, props.kind === 'danger' && { backgroundColor: '#7f1d1d' }, props.disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  )
}

function Link({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={12}>
      <Text style={styles.link}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#111' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: 1, borderColor: '#222' },
  body: { flex: 1, padding: 12 },
  title: { color: '#fff', fontSize: 20, fontWeight: '600' },
  muted: { color: '#888', fontSize: 13 },
  text: { color: '#eee', fontSize: 15, lineHeight: 21 },
  tool: { color: '#a78bfa', fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, marginTop: 4 },
  error: { color: '#f87171', marginTop: 8 },
  link: { color: '#60a5fa', fontSize: 15 },
  input: { borderWidth: 1, borderColor: '#333', borderRadius: 8, color: '#fff', padding: 12, marginTop: 12, fontSize: 15 },
  button: { backgroundColor: '#2563eb', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, marginTop: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  camera: { height: 300, borderRadius: 12, overflow: 'hidden', marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderColor: '#1c1c1c' },
  rowTitle: { color: '#fff', fontSize: 15, fontWeight: '500' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  bubble: { padding: 10, borderRadius: 10, backgroundColor: '#1a1a1a', marginVertical: 4 },
  userBubble: { backgroundColor: '#1e3a8a', alignSelf: 'flex-end', maxWidth: '85%' },
  approval: { borderWidth: 1, borderColor: '#ef4444', borderRadius: 10, padding: 12, marginVertical: 8, backgroundColor: '#1f1111' },
  composer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }
})
