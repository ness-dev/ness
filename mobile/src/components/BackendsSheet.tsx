// Backends manager: every saved Ness backend with an enable switch, live
// connection state, remove, and "Add backend" (QR scan or pasted link —
// the same URL Settings → Web & mobile shows).
import { useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { Plus, QrCode, Trash2, X } from 'lucide-react-native'
import { parseConnectionUrl } from '../../../src/shared/transport/parse-connection-url'
import type { Backends } from '../backends'
import { NessClient, useConn } from '../ness'
import { alpha, c, fs, mono } from '../theme'

export function BackendsSheet({ backends, onClose }: { backends: Backends; onClose?: () => void }) {
  const [adding, setAdding] = useState(backends.saved.length === 0)
  return (
    <View style={s.sheet} accessibilityViewIsModal>
      <View style={s.head}>
        <Text style={s.title}>BACKENDS</Text>
        {onClose && (
          <Pressable
            onPress={onClose}
            accessibilityLabel="Close backends"
            style={({ pressed }) => ({ width: 44, height: 44, marginRight: -12, alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: pressed ? c.surface : 'transparent' })}
          >
            <X color={c.dim} size={18} />
          </Pressable>
        )}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }} keyboardShouldPersistTaps="handled">
        {backends.saved.map((b) => (
          <View key={b.id} style={s.card}>
            <BackendDot client={backends.clients.find((cl) => cl.id === b.id)} enabled={b.enabled} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.label} numberOfLines={1}>
                {b.label}
              </Text>
              <Text style={s.url} numberOfLines={1}>
                {b.wsUrl}
              </Text>
              <BackendStatus client={backends.clients.find((cl) => cl.id === b.id)} enabled={b.enabled} />
            </View>
            <Switch
              value={b.enabled}
              onValueChange={(v) => backends.setEnabled(b.id, v)}
              accessibilityLabel={`Connect to ${b.label}`}
              trackColor={{ true: c.accent, false: c.surface }}
              thumbColor="#fff"
            />
            <Pressable
              onPress={() => backends.remove(b.id)}
              accessibilityLabel={`Remove ${b.label}`}
              style={({ pressed }) => ({ width: 44, height: 44, marginRight: -10, alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: pressed ? c.surface : 'transparent' })}
            >
              <Trash2 color={c.dim} size={16} />
            </Pressable>
          </View>
        ))}
        {adding ? (
          <AddBackend
            onAdd={(b) => {
              backends.add(b)
              setAdding(false)
            }}
            onCancel={backends.saved.length > 0 ? () => setAdding(false) : undefined}
          />
        ) : (
          <Pressable style={s.addRow} onPress={() => setAdding(true)}>
            <Plus color={c.accent} size={16} />
            <Text style={{ color: c.accent, fontSize: fs.sm }}>Add backend</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  )
}

function BackendDot({ client, enabled }: { client?: NessClient; enabled: boolean }) {
  if (!client || !enabled) return <View style={[s.dot, { backgroundColor: c.faint }]} />
  return <LiveDot client={client} />
}

function LiveDot({ client }: { client: NessClient }) {
  const conn = useConn(client)
  return <View style={[s.dot, { backgroundColor: conn.connected ? c.success : conn.error ? c.danger : c.warning }]} />
}

function BackendStatus({ client, enabled }: { client?: NessClient; enabled: boolean }) {
  if (!enabled || !client) return <Text style={s.status}>disabled</Text>
  return <LiveStatus client={client} />
}

function LiveStatus({ client }: { client: NessClient }) {
  const conn = useConn(client)
  return (
    <Text style={[s.status, !conn.connected && conn.error ? { color: c.danger } : null]}>
      {conn.connected ? 'connected' : conn.error ? `${conn.error} — retrying` : 'connecting…'}
    </Text>
  )
}

function AddBackend({
  onAdd,
  onCancel
}: {
  onAdd: (b: { wsUrl: string; token: string; label?: string }) => void
  onCancel?: () => void
}) {
  const [link, setLink] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const handled = useRef(false)

  const submit = (raw: string) => {
    // Same parser the desktop "Add Backend" modal uses.
    const r = parseConnectionUrl(raw)
    if (!r.ok) {
      setError(r.error)
      return
    }
    onAdd({ wsUrl: r.parsed.wsUrl, token: r.parsed.token, label: label.trim() || undefined })
  }

  return (
    <View style={[s.card, { flexDirection: 'column', alignItems: 'stretch', gap: 10 }]}>
      <Text style={s.label}>Add a backend</Text>
      <Text style={s.help}>
        Scan the QR in Ness → Settings → Web & mobile, or paste the connection link. Works for the desktop app and for
        harness-server.
      </Text>
      {scanning ? (
        <View style={s.camera}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return
              handled.current = true
              setScanning(false)
              submit(data)
            }}
          />
        </View>
      ) : (
        <Pressable
          style={s.scanBtn}
          onPress={async () => {
            const p = permission?.granted ? permission : await requestPermission()
            if (!p.granted) {
              setError('Camera permission denied')
              return
            }
            handled.current = false
            setScanning(true)
          }}
        >
          <QrCode color={c.fgBright} size={16} />
          <Text style={{ color: c.fgBright, fontSize: fs.sm, fontWeight: '500' }}>Scan QR code</Text>
        </Pressable>
      )}
      <TextInput
        style={s.input}
        placeholder="http://192.168.1.10:37291/?token=…"
        placeholderTextColor={c.faint}
        autoCapitalize="none"
        autoCorrect={false}
        value={link}
        onChangeText={(t) => {
          setLink(t)
          setError(null)
        }}
        onSubmitEditing={() => submit(link)}
      />
      <TextInput
        style={s.input}
        placeholder="Label (optional, e.g. Laptop)"
        placeholderTextColor={c.faint}
        autoCorrect={false}
        spellCheck={false}
        value={label}
        onChangeText={setLabel}
      />
      {error && <Text style={{ color: c.danger, fontSize: fs.xs }}>{error}</Text>}
      <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
        {onCancel && (
          <Pressable style={s.btn} onPress={onCancel}>
            <Text style={{ color: c.fg, fontSize: fs.sm }}>Cancel</Text>
          </Pressable>
        )}
        <Pressable style={[s.btn, { backgroundColor: c.accent, borderColor: c.accent }]} onPress={() => submit(link)}>
          <Text style={{ color: '#fff', fontSize: fs.sm, fontWeight: '600' }}>Connect</Text>
        </Pressable>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  // Above the worktree picker (z 30) and the panels sheet (z 40): Fabric
  // flattens the unstyled wrappers between them, so all three end up
  // competing in one stacking context.
  sheet: { ...(StyleSheet.absoluteFill as object), backgroundColor: c.app, zIndex: 60, elevation: 60 },
  head: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderColor: c.border
  },
  title: { flex: 1, color: c.dim, fontSize: fs.xs, fontWeight: '600', letterSpacing: 1.2 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.panel
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { color: c.fgBright, fontSize: fs.sm, fontWeight: '600' },
  url: { color: c.dim, fontSize: 11, fontFamily: mono, marginTop: 2 },
  status: { color: c.muted, fontSize: 11, marginTop: 2 },
  help: { color: c.muted, fontSize: fs.xs, lineHeight: 17 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 48 },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    borderRadius: 6,
    backgroundColor: alpha(c.accent, 0.15),
    borderWidth: 1,
    borderColor: alpha(c.accent, 0.3)
  },
  camera: { height: 260, borderRadius: 8, overflow: 'hidden' },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.app,
    borderRadius: 6,
    color: c.fg,
    paddingHorizontal: 10,
    minHeight: 44,
    fontSize: 16
  },
  // 44pt: the thumb-sized minimum used everywhere else in the app.
  btn: { borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingHorizontal: 18, minHeight: 44, minWidth: 88, alignItems: 'center', justifyContent: 'center' }
})
