// What to show while no worktrees have arrived: "Connecting…" only while a
// backend's first attempt is still running. Once every backend still
// waiting on a snapshot has failed, say which ones can't be reached, offer
// Retry (skips the backoff) and the Backends sheet, and keep retrying in
// the background so it recovers by itself when the network comes back.
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { Loader2, RefreshCw, Server, WifiOff } from 'lucide-react-native'
import { hostOf, useConns, type NessClient } from '../ness'
import { Spin } from './Spin'
import { alpha, c, fs, mono, themed } from '../theme'

export function Connecting({
  clients,
  onOpenBackends = () => router.push('/backends'),
  inline = false
}: {
  clients: readonly NessClient[]
  onOpenBackends?: () => void
  /** Top-aligned inside a sheet rather than centred on a screen. */
  inline?: boolean
}) {
  const conns = useConns(clients)
  const waiting = clients.filter((_, i) => !conns[i].hasSnapshot)
  const failed = waiting.filter((cl) => {
    const cn = conns[clients.indexOf(cl)]
    return !cn.connected && !!cn.error
  })
  // A tapped Retry shows as in progress until some backend reports back
  // (a new ConnState, even with the same error) or the attempt would have
  // timed out anyway.
  const [retrying, setRetrying] = useState(false)
  useEffect(() => setRetrying(false), [conns])
  useEffect(() => {
    if (!retrying) return
    const t = setTimeout(() => setRetrying(false), 10_000)
    return () => clearTimeout(t)
  }, [retrying])

  const wrap = inline ? s.inline : s.screen

  if (clients.length === 0) {
    return (
      <View style={wrap}>
        <Server color={c.dim} size={28} />
        <Text style={s.title}>All your backends are turned off</Text>
        <View style={s.row}>
          <Btn label="Backends" onPress={onOpenBackends} primary>
            <Server color={c.fg} size={16} />
          </Btn>
        </View>
      </View>
    )
  }

  if (waiting.length === 0 || failed.length < waiting.length) {
    const pending = waiting.filter((cl) => !failed.includes(cl))
    return (
      <View style={wrap}>
        <Text style={s.body}>
          {pending.length === 1 ? `Connecting to ${pending[0].label}…` : 'Connecting to your backends…'}
        </Text>
      </View>
    )
  }

  const one = failed.length === 1 ? failed[0] : null
  const reason = one ? conns[clients.indexOf(one)].error : null
  return (
    <View style={wrap} accessibilityLiveRegion="polite">
      <WifiOff color={c.warning} size={28} />
      <Text style={s.title}>{one ? `Can't reach ${one.label}` : "Can't reach your backends"}</Text>
      {one ? (
        !one.label.includes(hostOf(one.wsUrl)) && <Text style={s.host}>{hostOf(one.wsUrl)}</Text>
      ) : (
        <View style={{ gap: 2, alignItems: 'center' }}>
          {failed.map((cl) => (
            <Text key={cl.id} style={s.host}>
              {cl.label.includes(hostOf(cl.wsUrl)) ? cl.label : `${cl.label} (${hostOf(cl.wsUrl)})`}
            </Text>
          ))}
        </View>
      )}
      <Text style={s.body}>
        Are you on the same network as {one ? 'it' : 'them'}? Check that Ness is running there, too.
      </Text>
      <Text style={s.meta}>{reason ? `${reason} · ` : ''}retrying in the background</Text>
      <View style={s.row}>
        <Btn
          label={retrying ? 'Retrying…' : 'Retry'}
          primary
          disabled={retrying}
          onPress={() => {
            setRetrying(true)
            for (const cl of failed) cl.retry()
          }}
        >
          {retrying ? (
            <Spin>
              <Loader2 color={c.fg} size={16} />
            </Spin>
          ) : (
            <RefreshCw color={c.fg} size={16} />
          )}
        </Btn>
        <Btn label="Backends" onPress={onOpenBackends}>
          <Server color={c.dim} size={16} />
        </Btn>
      </View>
    </View>
  )
}

function Btn({
  label,
  onPress,
  primary,
  disabled,
  children
}: {
  label: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!disabled }}
      style={({ pressed }) => [s.btn, primary && s.primary, pressed && { opacity: 0.7 }]}
    >
      {children}
      <Text style={[s.btnText, primary && { color: c.fgBright }]}>{label}</Text>
    </Pressable>
  )
}

const s = themed(() =>
  StyleSheet.create({
    screen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
    inline: { alignItems: 'center', gap: 10, paddingHorizontal: 24, paddingVertical: 32 },
    title: { color: c.fgBright, fontSize: fs.base, fontWeight: '600', textAlign: 'center', marginTop: 4 },
    host: { color: c.dim, fontSize: fs.xs, fontFamily: mono, textAlign: 'center' },
    body: { color: c.dim, fontSize: fs.sm, textAlign: 'center', lineHeight: 20 },
    meta: { color: c.muted, fontSize: fs.xs, textAlign: 'center' },
    row: { flexDirection: 'row', gap: 10, marginTop: 10 },
    // 44pt: the thumb-sized minimum used everywhere else in the app.
    btn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      minHeight: 44,
      minWidth: 112,
      paddingHorizontal: 16,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: c.border
    },
    primary: { backgroundColor: alpha(c.accent, 0.15), borderColor: alpha(c.accent, 0.3) },
    btnText: { color: c.fg, fontSize: fs.sm, fontWeight: '500' }
  })
)
