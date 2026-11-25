// Port of the web client's mobile worktree sheet: a project card per repo,
// then the sidebar's groups (Open PRs / Active / …) from the shared
// groupWorktrees(), each row with a status dot, age, diff stat and PR pill.
// With several backends enabled, each backend's repos get their own
// sections, tagged with the backend label.
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, GitPullRequest, Server, X } from 'lucide-react-native'
import { groupWorktrees } from '../../../src/shared/worktree-sort'
import type { Worktree } from '../../../src/shared/state/worktrees'
import type { PRStatus } from '../../../src/shared/state/prs'
import { NessClient, rollupStatus, useConn, useNess } from '../ness'
import { STATUS_DOT, alpha, c, fs } from '../theme'

export interface Selection {
  backendId: string
  path: string
}

export function WorktreeSheet({
  clients,
  selected,
  onSelect,
  onClose,
  onOpenBackends
}: {
  clients: NessClient[]
  selected: Selection | null
  onSelect: (sel: Selection) => void
  onClose: () => void
  onOpenBackends: () => void
}) {
  return (
    <View style={s.sheet}>
      <View style={s.sheetHead}>
        <Text style={s.sheetTitle}>WORKTREES</Text>
        <Pressable onPress={onOpenBackends} hitSlop={10} style={s.headBtn}>
          <Server color={c.dim} size={16} />
          <Text style={s.headBtnText}>{clients.length}</Text>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={10} style={s.headBtn}>
          <X color={c.dim} size={18} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {clients.length === 0 && (
          <Pressable onPress={onOpenBackends} style={{ padding: 24 }}>
            <Text style={s.muted}>No backends enabled. Tap to add or enable one.</Text>
          </Pressable>
        )}
        {clients.map((client) => (
          <BackendSection
            key={client.id}
            client={client}
            showLabel={clients.length > 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </ScrollView>
    </View>
  )
}

function BackendSection({
  client,
  showLabel,
  selected,
  onSelect
}: {
  client: NessClient
  showLabel: boolean
  selected: Selection | null
  onSelect: (sel: Selection) => void
}) {
  const conn = useConn(client)
  const worktrees = useNess(client, (s) => s.worktrees.list)
  const repoRoots = useNess(client, (s) => s.worktrees.repoRoots)

  if (!conn.hasSnapshot) {
    return (
      <View style={s.repoCard}>
        <View style={[s.avatar, { backgroundColor: c.surface }]}>
          <Server color={c.dim} size={14} />
        </View>
        <Text style={[s.repoName, { color: c.dim }]}>{client.label}</Text>
        <Text style={s.muted}>{conn.error ?? 'connecting…'}</Text>
      </View>
    )
  }
  return (
    <>
      {repoRoots.map((root) => (
        <RepoSection
          key={root}
          client={client}
          repoRoot={root}
          worktrees={worktrees.filter((w) => w.repoRoot === root && !w.prunable)}
          backendLabel={showLabel ? client.label : null}
          connected={conn.connected}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

function RepoSection({
  client,
  repoRoot,
  worktrees,
  backendLabel,
  connected,
  selected,
  onSelect
}: {
  client: NessClient
  repoRoot: string
  worktrees: Worktree[]
  backendLabel: string | null
  connected: boolean
  selected: Selection | null
  onSelect: (sel: Selection) => void
}) {
  const prs = useNess(client, (s) => s.prs)
  const snooze = useNess(client, (s) => s.snooze.byPath)
  const pinned = useNess(client, (s) => s.pinned.byPath)
  const viewerLogin = useNess(client, (s) => s.settings.viewerLogin)
  // Re-render rows on status/activity changes.
  useNess(client, (s) => s.terminals.statuses)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const snoozedPaths = Object.fromEntries(Object.keys(snooze).map((p) => [p, true as const]))
    return groupWorktrees(worktrees, prs.byPath, prs.mergedByPath, snoozedPaths, viewerLogin, undefined, pinned)
  }, [worktrees, prs, snooze, pinned, viewerLogin])

  const name = repoRoot.split('/').pop() ?? repoRoot
  const state = client.getState()

  return (
    <View>
      <View style={s.repoCard}>
        <View style={s.avatar}>
          <Text style={s.avatarText}>{name[0]?.toUpperCase()}</Text>
          <View style={[s.avatarDot, { backgroundColor: connected ? c.success : c.danger }]} />
        </View>
        <Text style={s.repoName} numberOfLines={1}>
          {name}
        </Text>
        {backendLabel && (
          <View style={s.backendChip}>
            <Text style={s.backendChipText} numberOfLines={1}>
              {backendLabel}
            </Text>
          </View>
        )}
      </View>
      {groups.map((g) => (
        <View key={g.key}>
          <Pressable style={s.groupHead} onPress={() => setCollapsed((p) => ({ ...p, [g.key]: !p[g.key] }))}>
            <ChevronDown
              color={c.dim}
              size={12}
              style={{ transform: [{ rotate: collapsed[g.key] ? '-90deg' : '0deg' }] }}
            />
            <Text style={s.groupLabel}>{g.label}</Text>
            <View style={{ flex: 1 }} />
            <Text style={s.groupCount}>{g.worktrees.length}</Text>
          </Pressable>
          {!collapsed[g.key] &&
            g.worktrees.map((wt) => (
              <WorktreeRow
                key={wt.path}
                wt={wt}
                pr={prs.byPath[wt.path] ?? null}
                status={rollupStatus(state, wt.path)}
                active={selected?.backendId === client.id && selected.path === wt.path}
                onPress={() => onSelect({ backendId: client.id, path: wt.path })}
              />
            ))}
        </View>
      ))}
    </View>
  )
}

function WorktreeRow({
  wt,
  pr,
  status,
  active,
  onPress
}: {
  wt: Worktree
  pr: PRStatus | null
  status: keyof typeof STATUS_DOT
  active: boolean
  onPress: () => void
}) {
  const prColor = pr ? (pr.state === 'merged' ? c.accent : pr.checksOverall === 'failure' ? c.danger : pr.state === 'draft' ? c.dim : c.success) : c.dim
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, (active || pressed) && { backgroundColor: c.panelRaised }]}>
      <View style={[s.dot, { backgroundColor: STATUS_DOT[status] }]} />
      {pr && <GitPullRequest color={prColor} size={14} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.branch, active && { color: c.fgBright }]} numberOfLines={1}>
          {wt.isMain ? 'main' : wt.branch || '(detached)'}
        </Text>
        <View style={s.meta}>
          <Text style={s.metaText}>{formatWorktreeAge(wt.createdAt)}</Text>
          {pr?.additions !== undefined && <Text style={[s.metaText, { color: c.success }]}>+{pr.additions}</Text>}
          {pr?.deletions !== undefined && <Text style={[s.metaText, { color: c.danger }]}>-{pr.deletions}</Text>}
          {pr && (
            <View style={s.prPill}>
              <Text style={s.prPillText}>#{pr.number}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  )
}

// Copy of worktree-detail.ts's formatWorktreeAge (src/renderer isn't
// watched by Metro): the sidebar shows worktree age, not last activity.
function formatWorktreeAge(createdAt: number, now: number = Date.now()): string {
  if (!createdAt) return '—'
  const ms = now - createdAt
  if (ms < 0) return '—'
  const hours = ms / (1000 * 60 * 60)
  if (hours < 1) return '<1h'
  const days = hours / 24
  if (days < 1) return `${Math.floor(hours)}h`
  if (days < 365) return `${Math.floor(days)}d`
  return `${(days / 365).toFixed(1)}y`
}

const s = StyleSheet.create({
  sheet: { ...(StyleSheet.absoluteFill as object), backgroundColor: c.app, zIndex: 10 },
  sheetHead: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 16,
    borderBottomWidth: 1,
    borderColor: c.border
  },
  sheetTitle: { flex: 1, color: c.dim, fontSize: fs.xs, fontWeight: '600', letterSpacing: 1.2 },
  headBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4 },
  headBtnText: { color: c.dim, fontSize: fs.xs },
  muted: { color: c.muted, fontSize: fs.xs },
  repoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 6,
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: c.panelRaised
  },
  avatar: { width: 22, height: 22, borderRadius: 5, backgroundColor: c.surfaceHover, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: c.fgBright, fontSize: fs.xs, fontWeight: '700' },
  avatarDot: { position: 'absolute', right: -3, bottom: -3, width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: c.panelRaised },
  repoName: { flex: 1, color: c.fgBright, fontSize: 15, fontWeight: '600' },
  backendChip: { borderWidth: 1, borderColor: c.borderStrong, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 120 },
  backendChipText: { color: c.muted, fontSize: 11 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingTop: 16, paddingBottom: 6 },
  groupLabel: { color: c.dim, fontSize: fs.xs },
  groupCount: { color: c.dim, fontSize: fs.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  branch: { color: c.fg, fontSize: fs.sm, fontWeight: '500' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  metaText: { color: c.dim, fontSize: fs.xs },
  prPill: { borderWidth: 1, borderColor: c.borderStrong, borderRadius: 4, paddingHorizontal: 4, backgroundColor: alpha(c.fg, 0.04) },
  prPillText: { color: c.fgBright, fontSize: 11, fontWeight: '600' }
})
