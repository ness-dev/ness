// The demo's own UI: the badge shown wherever the backend label is, the
// menu behind it (theme, reset, leave), the "Try the demo" card on the
// first-run screen, and the toast that says "Not available in the demo".
import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { FlaskConical, LogOut, RotateCcw, Server, Sparkles, X } from 'lucide-react-native'
import type { Backends } from '../backends'
import { useNess, type NessClient } from '../ness'
import { hitArea } from '../hit'
import { alpha, c, fs, themed } from '../theme'
import { DEMO_NOTICE_SIGNAL } from './constants'

/** "DEMO" pill. With `onPress`, it opens the demo menu. */
export function DemoBadge({ onPress }: { onPress?: () => void }) {
  const pill = (
    <View style={s.badge}>
      <Text style={s.badgeText}>DEMO</Text>
    </View>
  )
  if (!onPress) return <View accessible accessibilityLabel="Demo workspace">{pill}</View>
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Demo workspace options"
      accessibilityHint="Change the theme, reset or leave the demo"
      style={({ pressed }) => [{ ...hitArea(14, 8), zIndex: 1 }, pressed && { opacity: 0.6 }]}
    >
      {pill}
    </Pressable>
  )
}

/** Leave the demo: off, and back to the first screen (pairing, or the
 *  user's own worktrees). */
export function leaveDemo(backends: Backends): void {
  backends.setDemo(false)
  router.replace('/')
}

type ThemeChoice = 'system' | 'dark' | 'light' | 'solarized-light'

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'solarized-light', label: 'Solarized' }
]

function currentTheme(mode: string, light: string): ThemeChoice {
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return light === 'solarized-light' ? 'solarized-light' : 'light'
  return 'system'
}

export function DemoMenu({ client, backends, themeFollowsDemo, onClose }: { client: NessClient; backends: Backends; themeFollowsDemo: boolean; onClose: () => void }) {
  const settings = useNess(client, (st) => st.settings)
  const theme = currentTheme(settings.themeMode, settings.themeLight)
  const pickTheme = (t: ThemeChoice) => {
    if (t === 'system' || t === 'dark') {
      void client.api.setThemeMode(t)
      return
    }
    void client.api.setThemeLight(t)
    void client.api.setThemeMode('light')
  }
  return (
    <View style={s.sheet} accessibilityViewIsModal>
      <View style={s.head}>
        <Text style={s.title} accessibilityRole="header">
          DEMO WORKSPACE
        </Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={({ pressed }) => [s.icon44, pressed && { backgroundColor: c.surface }]}>
          <X color={c.dim} size={18} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 16, paddingBottom: 40 }}>
        <View style={s.card}>
          <FlaskConical color={c.accent} size={20} />
          <Text style={s.body}>
            You're exploring a sample project with made-up data. It runs entirely on this phone: nothing is sent anywhere, and the chat replies are scripted.
          </Text>
        </View>

        {themeFollowsDemo && (
          <View style={{ gap: 8 }}>
            <Text style={s.section}>THEME</Text>
            <View style={s.segment} accessibilityRole="radiogroup">
              {THEMES.map((t) => {
                const on = t.id === theme
                return (
                  <Pressable
                    key={t.id}
                    onPress={() => pickTheme(t.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    style={[s.segmentItem, on && { backgroundColor: c.surface, borderColor: c.borderStrong }]}
                  >
                    <Text style={{ color: on ? c.fgBright : c.muted, fontSize: fs.sm }}>{t.label}</Text>
                  </Pressable>
                )
              })}
            </View>
          </View>
        )}

        <View style={{ gap: 8 }}>
          <Row
            icon={<Server color={c.fgBright} size={16} />}
            label="Connect your own Ness"
            hint="Pair with the desktop app or harness-server"
            onPress={() => {
              onClose()
              router.push('/backends')
            }}
          />
          <Row
            icon={<RotateCcw color={c.fgBright} size={16} />}
            label="Reset the demo"
            hint="Back to the starting state"
            onPress={() => {
              backends.resetDemo()
              onClose()
            }}
          />
          <Row icon={<LogOut color={c.danger} size={16} />} label="Leave the demo" danger onPress={() => leaveDemo(backends)} />
        </View>
      </ScrollView>
    </View>
  )
}

function Row({ icon, label, hint, danger, onPress }: { icon: React.ReactNode; label: string; hint?: string; danger?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={hint}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: c.surface }]}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={{ color: danger ? c.danger : c.fgBright, fontSize: fs.sm, fontWeight: '500' }}>{label}</Text>
        {hint && <Text style={{ color: c.muted, fontSize: fs.xs, marginTop: 2 }}>{hint}</Text>}
      </View>
    </Pressable>
  )
}

/** First-run card: the way in for anyone without a Ness backend. */
export function TryDemoCard({ onTry }: { onTry: () => void }) {
  return (
    <View style={[s.card, { flexDirection: 'column', alignItems: 'stretch', gap: 10 }]}>
      <Text style={{ color: c.fgBright, fontSize: fs.sm, fontWeight: '600' }}>No Ness backend yet?</Text>
      <Text style={s.body}>Explore a sample workspace with agents, approvals, diffs and a terminal. It works offline and touches nothing on any computer.</Text>
      <Pressable
        onPress={onTry}
        accessibilityRole="button"
        style={({ pressed }) => [s.tryBtn, pressed && { opacity: 0.8 }]}
      >
        <Sparkles color="#fff" size={16} />
        <Text style={{ color: '#fff', fontSize: fs.sm, fontWeight: '600' }}>Try the demo</Text>
      </Pressable>
    </View>
  )
}

/** "Not available in the demo", for the demo client's turned-away calls. */
export function DemoNotice({ client }: { client: NessClient | undefined }) {
  const [message, setMessage] = useState<string | null>(null)
  const opacity = useRef(new Animated.Value(0)).current
  const insets = useSafeAreaInsets()
  useEffect(() => {
    if (!client) return
    let hide: ReturnType<typeof setTimeout> | undefined
    const off = client.transport.onSignal(DEMO_NOTICE_SIGNAL, (m: unknown) => {
      setMessage(String(m))
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start()
      clearTimeout(hide)
      hide = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }).start(() => setMessage(null))
      }, 2200)
    })
    return () => {
      off()
      clearTimeout(hide)
    }
  }, [client, opacity])
  if (!message) return null
  return (
    <Animated.View pointerEvents="none" style={[s.toast, { bottom: insets.bottom + 96, opacity }]} accessibilityLiveRegion="polite">
      <FlaskConical color={c.accent} size={14} />
      <Text style={{ color: c.fgBright, fontSize: fs.sm }} accessibilityRole="alert">
        {message}
      </Text>
    </Animated.View>
  )
}

const s = themed(() => StyleSheet.create({
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: alpha(c.accent, 0.18),
    borderWidth: 1,
    borderColor: alpha(c.accent, 0.4)
  },
  badgeText: { color: c.accent, fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  sheet: { ...(StyleSheet.absoluteFill as object), backgroundColor: c.app, zIndex: 60, elevation: 60 },
  head: { height: 56, flexDirection: 'row', alignItems: 'center', paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border },
  title: { flex: 1, color: c.dim, fontSize: fs.xs, fontWeight: '600', letterSpacing: 1.2 },
  icon44: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  card: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel },
  body: { flex: 1, color: c.muted, fontSize: fs.sm, lineHeight: 20 },
  section: { color: c.dim, fontSize: fs.xs, fontWeight: '600', letterSpacing: 1.2, paddingHorizontal: 2 },
  segment: { flexDirection: 'row', gap: 6 },
  segmentItem: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: c.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel },
  tryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, borderRadius: 6, backgroundColor: c.accent },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: c.panelRaised,
    borderWidth: 1,
    borderColor: c.borderStrong,
    zIndex: 100,
    elevation: 100
  }
}))
