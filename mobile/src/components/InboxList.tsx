// Native port of the desktop sidebar's Inbox (renderer/components/
// InboxView.tsx). The model — sections, ordering, PR events, "why" lines —
// is the renderer's own buildInboxModel over the fleet's merged maps; this
// file only draws it, with the picker's touch sizing.
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, GitPullRequest, Inbox } from 'lucide-react-native'
import type { InboxItem, InboxModel, InboxSectionKey } from '../../../src/renderer/inbox-model'
import { alpha, c, fs, themed } from '../theme'
import { Pulse } from './Spin'

const DOT: Record<InboxSectionKey, { color: string; pulse: boolean }> = themed(() => ({
  approval: { color: c.danger, pulse: true },
  question: { color: c.accent, pulse: false },
  done: { color: c.warning, pulse: false },
  pr: { color: c.danger, pulse: false },
  prInfo: { color: c.accent, pulse: false },
  working: { color: c.success, pulse: true },
  seen: { color: c.faint, pulse: false }
}))

const PR_COLOR = themed(() => ({
  'ci-failed': c.danger,
  conflict: c.danger,
  'changes-requested': c.warning,
  ready: c.success,
  merged: c.accent
}))

function ago(ts: number, now: number): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function InboxList({
  model,
  activeWorktreeId,
  activeTabId,
  onOpen
}: {
  model: InboxModel
  activeWorktreeId: string | null
  activeTabId: string | null
  onOpen: (item: InboxItem) => void
}) {
  // Per-client fold state, like the picker's group collapse.
  const [open, setOpen] = useState<Partial<Record<InboxSectionKey, boolean>>>({})
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const nonEmpty = model.sections.filter((sec) => sec.items.length > 0)

  return (
    <View>
      {model.needsYou.length === 0 && (
        <View style={s.empty}>
          <Inbox color={c.faint} size={16} />
          <Text style={s.faintXs}>Nothing needs you right now.</Text>
        </View>
      )}
      {nonEmpty.map((sec) => {
        const expanded = open[sec.key] ?? !sec.collapsedByDefault
        return (
          <View key={sec.key}>
            <Pressable
              onPress={() => setOpen((o) => ({ ...o, [sec.key]: !expanded }))}
              style={({ pressed }) => [s.groupHead, pressed && { opacity: 0.7 }]}
              accessibilityRole="button"
              accessibilityState={{ expanded }}
            >
              {expanded ? <ChevronDown color={c.faint} size={12} /> : <ChevronRight color={c.faint} size={12} />}
              <Text style={s.faintXs}>{sec.label}</Text>
              <View style={{ flex: 1 }} />
              <Text style={s.faintXs}>{sec.items.length}</Text>
            </Pressable>
            {expanded &&
              sec.items.map((item) => {
                const isPr = item.prFingerprint !== undefined
                const active = !isPr && item.worktreePath === activeWorktreeId && item.tabId === activeTabId
                const dot = DOT[item.section]
                return (
                  <View key={item.key} style={[s.block, active && { backgroundColor: c.surface }]}>
                    <Pressable
                      onPress={() => onOpen(item)}
                      style={({ pressed }) => [s.row, pressed && !active && { backgroundColor: c.panelRaised }]}
                      accessibilityRole="button"
                      accessibilityLabel={`${item.worktreeLabel} ${item.tabLabel}. ${item.why}`}
                    >
                      <View style={{ width: 14, alignItems: 'center', paddingTop: 3 }}>
                        {isPr ? (
                          <GitPullRequest color={item.prKind ? PR_COLOR[item.prKind] : c.dim} size={14} />
                        ) : (
                          <Pulse active={dot.pulse}>
                            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot.color }} />
                          </Pulse>
                        )}
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                          <Text style={[s.label, { color: active ? c.fgBright : c.muted }]} numberOfLines={1}>
                            {item.worktreeLabel !== item.repoName && <Text style={{ color: c.faint }}>{item.repoName} · </Text>}
                            {item.worktreeLabel}
                            {!!item.tabLabel && <Text style={{ color: c.faint }}> · {item.tabLabel}</Text>}
                          </Text>
                          <Text style={s.faintXs}>{ago(item.since, now)}</Text>
                        </View>
                        {!!item.why && (
                          <Text style={[s.why, item.section === 'seen' && { color: c.faint }]} numberOfLines={2}>
                            {item.why}
                          </Text>
                        )}
                      </View>
                    </Pressable>
                  </View>
                )
              })}
          </View>
        )
      })}
    </View>
  )
}

const s = themed(() =>
  StyleSheet.create({
    empty: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 16 },
    faintXs: { color: c.faint, fontSize: fs.xs },
    groupHead: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, minHeight: 44, backgroundColor: alpha(c.app, 0.95) },
    block: { marginHorizontal: 6, borderRadius: 6, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 8, minHeight: 44, paddingVertical: 10 },
    label: { fontSize: fs.sm, fontWeight: '500', flexShrink: 1 },
    why: { color: c.fgBright, fontSize: fs.sm, marginTop: 2 }
  })
)
