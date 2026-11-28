// Phone Settings: what's running (native build, runtime, channel, the
// update this launch loaded) and the EAS Update check / download / restart
// loop, plus a way to the backends sheet. Everything here is per-device —
// none of it is Ness workspace state, so nothing goes through a backend.
//
// Version sources, chosen so an OTA can't misreport the binary under it:
//  - native version: the embedded app.config the binary was built with
//    (ExponentConstants.manifest). Constants.expoConfig would be the
//    running update's manifest instead.
//  - native build number: CFBundleVersion, via Constants.platform.ios.
//  - JS commit: EXPO_PUBLIC_GIT_COMMIT, inlined by Metro when the bundle is
//    exported (the mobile-update workflow sets it). An env var, not app
//    config `extra`, because expoConfig is a fingerprint input and a
//    per-commit value there would change the runtime version every commit.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { router } from 'expo-router'
import { requireOptionalNativeModule } from 'expo'
import Constants from 'expo-constants'
import * as Updates from 'expo-updates'
import { Check, ChevronRight, Copy, Loader2, Server, X } from 'lucide-react-native'
import { copyText } from '../clipboard'
import {
  formatAgo,
  formatStamp,
  launchSource,
  runtimeLabel,
  shortId,
  updateAction,
  updatePhase,
  updateStatusText,
  versionLabel
} from '../app-info'
import { alpha, c, fs, mono, themed } from '../theme'
import { Spin } from './Spin'
import { setPickerTabs, usePickerTabs } from '../prefs'

const embeddedConfig = requireOptionalNativeModule<{ manifest?: { version?: string } | string }>('ExponentConstants')?.manifest
const nativeVersion = (typeof embeddedConfig === 'string' ? safeParse(embeddedConfig)?.version : embeddedConfig?.version) ?? Constants.expoConfig?.version
const nativeBuild = Platform.OS === 'ios' ? Constants.platform?.ios?.buildNumber : null
const gitCommit = process.env.EXPO_PUBLIC_GIT_COMMIT || null
// The dev client reports Updates.isEnabled = true while running a bundle
// from Metro (its launcher stands in for expo-updates), and "checking"
// there would ask EAS about a build that never takes OTAs. __DEV__ is the
// reliable marker for a Metro-served bundle; release builds compile it out.
const updatesEnabled = Updates.isEnabled && !__DEV__

function safeParse(s: string): { version?: string } | null {
  try {
    return JSON.parse(s) as { version?: string }
  } catch {
    return null
  }
}

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const u = Updates.useUpdates()
  const [now, setNow] = useState(() => new Date())
  // Keeps the relative "last checked" current while the sheet is open.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])
  const lastCheck = u.lastCheckForUpdateTimeSinceRestart
  const phase = updatePhase({ ...u, isEnabled: updatesEnabled }, !!lastCheck)
  const action = updateAction(phase)
  const running = u.currentlyRunning
  const pickerTabs = usePickerTabs()
  const busy = phase.kind === 'checking' || phase.kind === 'downloading' || phase.kind === 'restarting'

  const run = async (a: 'check' | 'download' | 'restart') => {
    // Errors land in useUpdates()' checkError / downloadError; swallowing
    // here just keeps them from also surfacing as an unhandled rejection.
    try {
      if (a === 'check') {
        await Updates.checkForUpdateAsync()
        return
      }
      if (a === 'download') {
        const r = await Updates.fetchUpdateAsync()
        if (!r.isNew && !r.isRollBackToEmbedded) return
      }
      await Updates.reloadAsync()
    } catch {}
  }

  return (
    <View style={s.sheet} accessibilityViewIsModal>
      <View style={s.head}>
        <Text style={s.title} accessibilityRole="header">
          SETTINGS
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close settings"
          style={({ pressed }) => [s.icon44, { marginRight: -12 }, pressed && { backgroundColor: c.surface }]}
        >
          <X color={c.dim} size={18} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 16, paddingBottom: 40 }}>
        <Section title="Updates">
          <View style={s.statusRow} accessible accessibilityLiveRegion="polite" accessibilityLabel={updateStatusText(phase, now)}>
            {busy && (
              <Spin>
                <Loader2 color={c.dim} size={14} />
              </Spin>
            )}
            {phase.kind === 'upToDate' && <Check color={c.success} size={14} />}
            <Text style={[s.statusText, phase.kind === 'error' && { color: c.danger }, phase.kind === 'available' && { color: c.accent }]}>
              {updateStatusText(phase, now)}
            </Text>
          </View>
          {updatesEnabled && (
            <Row label="Last checked" value={lastCheck ? formatAgo(lastCheck, now) : 'Not since launch'} />
          )}
          {action && (
            <Pressable
              onPress={() => void run(action.action)}
              accessibilityRole="button"
              style={({ pressed }) => [s.primary, action.action !== 'check' && s.primaryStrong, pressed && { opacity: 0.7 }]}
            >
              <Text style={[s.primaryText, action.action !== 'check' && { color: '#fff' }]}>{action.label}</Text>
            </Pressable>
          )}
        </Section>

        <Section title="About">
          <Row label="App version" value={versionLabel(nativeVersion, nativeBuild)} />
          <Row label="Runtime version" value={runtimeLabel(Updates.runtimeVersion)} copy={Updates.runtimeVersion} mono />
          <Row label="Channel" value={Updates.channel || '—'} mono />
          <Row
            label="Running"
            value={launchSource({
              isEnabled: updatesEnabled,
              isEmbeddedLaunch: running.isEmbeddedLaunch,
              isEmergencyLaunch: running.isEmergencyLaunch,
              emergencyLaunchReason: running.emergencyLaunchReason
            })}
          />
          <Row label="Update ID" value={shortId(running.updateId)} copy={running.updateId} mono />
          <Row label="Published" value={formatStamp(running.createdAt)} />
          <Row label="JS commit" value={gitCommit ? gitCommit.slice(0, 8) : 'unknown'} copy={gitCommit} mono />
          <Row label="Updates" value={updatesEnabled ? 'Enabled' : 'Disabled'} last />
        </Section>

        <Section title="Worktree list">
          <View style={[s.row, s.rowLast]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[s.rowLabel, { color: c.fgBright }]}>Show tabs in worktree list (experimental)</Text>
              <Text style={[s.rowLabel, { fontSize: fs.xs, marginTop: 2 }]}>
                List each worktree's chats, terminals and shells under it, like the desktop sidebar. Tap one to open it.
              </Text>
            </View>
            <Switch
              value={pickerTabs}
              onValueChange={setPickerTabs}
              accessibilityLabel="Show tabs in worktree list (experimental)"
              trackColor={{ true: c.accent, false: c.surface }}
              thumbColor="#fff"
            />
          </View>
        </Section>

        <Section title="Connections">
          <Pressable
            onPress={() => router.push('/backends')}
            accessibilityRole="button"
            accessibilityLabel="Backends"
            accessibilityHint="Opens the list of Ness backends"
            style={({ pressed }) => [s.row, s.rowLast, pressed && { backgroundColor: c.surface }]}
          >
            <Server color={c.dim} size={16} />
            <Text style={[s.rowLabel, { flex: 1, color: c.fgBright }]}>Backends</Text>
            <ChevronRight color={c.faint} size={16} />
          </Pressable>
        </Section>
      </ScrollView>
    </View>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.sectionTitle} accessibilityRole="header">
        {title.toUpperCase()}
      </Text>
      <View style={s.card}>{children}</View>
    </View>
  )
}

/** A label/value row. With `copy`, the whole row is a 44pt button that puts
 *  the full value (not the shortened one shown) on the clipboard. */
function Row({ label, value, copy, mono: isMono, last }: { label: string; value: string; copy?: string | null; mono?: boolean; last?: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const body = (
    <>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, isMono && { fontFamily: mono }]} numberOfLines={2} selectable={!copy}>
        {value}
      </Text>
      {copy ? copied ? <Check color={c.accent} size={14} /> : <Copy color={c.faint} size={14} /> : null}
    </>
  )
  if (!copy) {
    return (
      <View style={[s.row, last && s.rowLast]} accessible accessibilityLabel={`${label}: ${value}`}>
        {body}
      </View>
    )
  }
  return (
    <Pressable
      style={({ pressed }) => [s.row, last && s.rowLast, pressed && { backgroundColor: c.surface }]}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      accessibilityHint={copied ? 'Copied' : 'Copies the full value'}
      onPress={() => {
        void copyText(copy).then((ok) => {
          if (!ok) return
          setCopied(true)
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {body}
    </Pressable>
  )
}

const s = themed(() => StyleSheet.create({
  // Same layer as BackendsSheet: above the picker (z 30) and panels (z 40).
  sheet: { ...(StyleSheet.absoluteFill as object), backgroundColor: c.app, zIndex: 60, elevation: 60 },
  head: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, borderBottomWidth: 1, borderColor: c.border },
  title: { flex: 1, color: c.dim, fontSize: fs.xs, fontWeight: '600', letterSpacing: 1.2 },
  icon44: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  sectionTitle: { color: c.muted, fontSize: fs.xs, fontWeight: '600', letterSpacing: 1, paddingHorizontal: 4 },
  card: { borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, minHeight: 44, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.border },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { color: c.dim, fontSize: fs.sm },
  rowValue: { flex: 1, color: c.fgBright, fontSize: fs.sm, textAlign: 'right' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 44, paddingVertical: 10 },
  statusText: { flex: 1, color: c.fgBright, fontSize: fs.sm },
  primary: {
    margin: 12,
    marginTop: 4,
    minHeight: 44,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: alpha(c.accent, 0.3),
    backgroundColor: alpha(c.accent, 0.15)
  },
  primaryStrong: { backgroundColor: c.accent, borderColor: c.accent },
  primaryText: { color: c.accent, fontSize: fs.sm, fontWeight: '600' }
}))
