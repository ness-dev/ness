// Port of MobileApp's WorktreePickerSheet + WorktreeList variant="touch"
// (renderer/components/WorktreeList.tsx, WorktreeTab.tsx,
// WorktreeActionSheet.tsx). The model — sections, homes, groups, tail,
// accordion, cross-host merging — is the renderer's own
// buildWorktreeListBase/applyProjectAccordion via src/fleet.ts; this file
// only draws it. Row actions route to whichever backend owns the path.
//
// One addition over the web picker: with more than one backend enabled,
// rows show the desktop sidebar's origin badge (Server icon + host label),
// which the web's single-backend picker never needs.
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import {
  AlarmClock,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Ghost,
  GitPullRequest,
  Layers,
  Loader2,
  Moon,
  MoreHorizontal,
  Pin,
  PinOff,
  RefreshCw,
  Rows3,
  Server,
  Tag,
  TriangleAlert,
  X
} from 'lucide-react-native'
import type { MergedWorktreeData } from '../../../src/renderer/merge-backend-states'
import type { WorktreeListGroupModel, WorktreeRepoSectionModel, WorktreeRowModel } from '../../../src/renderer/worktree-list-model'
import { repoLabelFor } from '../../../src/renderer/worktree-list-model'
import { detachedLikeTooltip, prIconStyle, type DisplayStatus } from '../../../src/renderer/worktree-row-style'
import { formatPendingTool } from '../../../src/renderer/pending-tool'
import { latestAgentReviewStatus } from '../../../src/shared/review-status'
import { findLeafByTabId } from '../../../src/shared/state/terminals'
import { formatWakeAt } from '../../../src/shared/state/snooze'
import { DEFAULT_SIDEBAR_DETAILS } from '../../../src/shared/state/settings'
import type { PendingWorktree } from '../../../src/shared/state/worktrees'
import type { AssignedPR } from '../../../src/shared/state/assigned-prs'
import { Fleet, useFleetEntries, useListModel } from '../fleet'
import { useCollapse, type CollapseState } from '../collapse'
import { alpha, c, fs, mono } from '../theme'
import { tokenColor, tw } from '../tw'
import { Pulse, Spin } from './Spin'

const STATUS: Record<DisplayStatus, { color: string; pulse: boolean }> = {
  idle: { color: c.faint, pulse: false },
  processing: { color: c.success, pulse: true },
  waiting: { color: c.warning, pulse: false },
  'needs-approval': { color: c.danger, pulse: true },
  merged: { color: c.accent, pulse: false }
}

const REPO_BG = ['teal-400', 'cyan-400', 'sky-400', 'blue-400', 'indigo-400', 'violet-400', 'purple-400', 'fuchsia-400', 'pink-400', 'slate-400']
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
const repoBg = (name: string) => tokenColor(`bg-${REPO_BG[hash(name) % 10]}/60`, 'bg')!
const repoText = (name: string) => tokenColor(`text-${REPO_BG[hash(name) % 10]}`, 'text')!

function formatWorktreeAge(createdAt: number, now = Date.now()): string {
  // Same rules as renderer/components/worktree-detail.ts.
  if (!createdAt) return '—'
  const ms = now - createdAt
  if (ms < 0) return '—'
  const hours = ms / 3_600_000
  if (hours < 1) return '<1h'
  const days = hours / 24
  if (days < 1) return `${Math.floor(hours)}h`
  if (days < 365) return `${Math.floor(days)}d`
  return `${(days / 365).toFixed(1)}y`
}

interface Action {
  label: string
  icon: ReactNode
  tone?: 'accent' | 'warning' | 'danger'
  run: () => void
  /** Run only after the sheet has finished closing — anything that wants
   *  keyboard focus (alias editor) loses it to the modal's focus trap
   *  otherwise. */
  afterClose?: boolean
}

interface Ctx {
  fleet: Fleet
  merged: MergedWorktreeData
  collapse: CollapseState
  activeWorktreeId: string | null
  multiBackend: boolean
  snoozeDays: number
  editingAlias: string | null
  setEditingAlias: (p: string | null) => void
  openSheet: (title: string, subtitle: string | undefined, actions: Action[]) => void
  onSelect: (path: string) => void
}

export function WorktreePicker({
  fleet,
  merged,
  activeWorktreeId,
  onSelect,
  onClose,
  onOpenBackends
}: {
  fleet: Fleet
  merged: MergedWorktreeData
  activeWorktreeId: string | null
  onSelect: (path: string) => void
  onClose: () => void
  onOpenBackends: () => void
}) {
  const collapse = useCollapse()
  const model = useListModel(fleet, merged, collapse, activeWorktreeId)
  const entries = useFleetEntries(fleet)
  const loading = entries.some((e) => e.state.prs.loading)
  const snoozeDays = Math.max(1, Math.floor(entries[0]?.state.settings.snoozeDefaultDays ?? 7))
  const [editingAlias, setEditingAlias] = useState<string | null>(null)
  const [sheet, setSheet] = useState<{ title: string; subtitle?: string; actions: Action[] } | null>(null)
  const repoCount = merged.repoRoots.length

  const ctx: Ctx = {
    fleet,
    merged,
    collapse,
    activeWorktreeId,
    multiBackend: fleet.getClients().length > 1,
    snoozeDays,
    editingAlias,
    setEditingAlias,
    openSheet: (title, subtitle, actions) => setSheet({ title, subtitle, actions }),
    onSelect
  }

  return (
    <View style={s.sheet} accessibilityViewIsModal>
      <View style={s.head}>
        <Text style={s.headTitle}>WORKTREES</Text>
        <IconBtn
          label={collapse.unifiedRepos ? 'Split by repo' : 'Merge repos into one list'}
          disabled={repoCount <= 1}
          onPress={() => collapse.setUnifiedRepos((v) => !v)}
        >
          {collapse.unifiedRepos ? <Rows3 color={c.dim} size={16} /> : <Layers color={c.dim} size={16} />}
        </IconBtn>
        <IconBtn label="Backends" onPress={onOpenBackends}>
          <Server color={c.dim} size={16} />
        </IconBtn>
        <IconBtn label="Refresh" onPress={() => fleet.getClients().forEach((cl) => void cl.req('prs:refreshAll'))}>
          {loading ? (
            <Spin>
              <Loader2 color={c.dim} size={16} />
            </Spin>
          ) : (
            <RefreshCw color={c.dim} size={16} />
          )}
        </IconBtn>
        <IconBtn label="Close" onPress={onClose}>
          <X color={c.dim} size={16} />
        </IconBtn>
      </View>
      <ScrollView contentContainerStyle={{ paddingVertical: 6, paddingBottom: 40 }} stickyHeaderIndices={undefined} keyboardShouldPersistTaps="handled">
        {entries.length === 0 && <Text style={[s.dimText, { padding: 24 }]}>Connecting to your backends…</Text>}
        {model.sections.map((section, i) => {
          const prev = model.sections[i - 1]
          const gap = !prev ? 0 : !prev.unified && !prev.collapsed && !prev.holdsActive ? 12 : 6
          return (
            <View key={section.scope} style={{ marginTop: gap }}>
              <Section section={section} ctx={ctx} showRepoLabels={model.showRepoLabels} />
            </View>
          )
        })}
      </ScrollView>
      <ActionSheet sheet={sheet} onClose={() => setSheet(null)} />
    </View>
  )
}

// ── sections ─────────────────────────────────────────────────────────────

function Section({ section, ctx, showRepoLabels }: { section: WorktreeRepoSectionModel; ctx: Ctx; showRepoLabels: boolean }) {
  const home = section.homes[0]
  return (
    <View>
      {!section.unified &&
        (home ? (
          <Block active={ctx.activeWorktreeId === home.path} context={section.holdsActive}>
            <ProjectRow
              row={home}
              ctx={ctx}
              name={section.repoName}
              repoRoot={section.repoRoot}
              collapsed={section.collapsed}
              count={section.count}
              collapsedStatus={section.collapsed ? section.worstStatus : undefined}
              pinnedOpen={section.pinnedOpen}
              onTogglePinned={() => ctx.collapse.togglePinnedOpen(section.scope)}
            />
          </Block>
        ) : (
          <BareRepoHeader section={section} onPress={() => ctx.collapse.togglePinnedOpen(section.scope)} />
        ))}
      {section.unified && (
        <View style={{ marginBottom: 8 }}>
          {section.homes.map((h) => (
            <Block key={h.path} active={ctx.activeWorktreeId === h.path} context={false}>
              <ProjectRow row={h} ctx={ctx} name={repoLabelFor(h.worktree.repoRoot)} repoRoot={h.worktree.repoRoot} />
            </Block>
          ))}
        </View>
      )}
      {!section.collapsed && (
        <View>
          {!section.unified &&
            section.homes.slice(1).map((h) => (
              <Block key={h.path} active={ctx.activeWorktreeId === h.path}>
                <Row row={h} ctx={ctx} />
              </Block>
            ))}
          {section.pending.map((p) => (
            <PendingRow key={p.id} pending={p} ctx={ctx} />
          ))}
          {section.workGroups.map((g) => (
            <Group key={g.key} group={g} scope={section.scope} ctx={ctx} showRepoLabels={showRepoLabels} />
          ))}
          {section.tail && (
            <View style={{ marginTop: 4 }}>
              <GroupHeader
                label={section.tail.groups.map((g) => g.label).join(' · ')}
                count={section.tail.count}
                collapsed={section.tail.collapsed}
                onPress={() => {
                  for (const g of section.tail!.groups) if (g.collapsed === section.tail!.collapsed) ctx.collapse.toggleGroup(section.scope, g.key)
                }}
              />
              {!section.tail.collapsed &&
                section.tail.groups.map((g) => (
                  <View key={g.key}>
                    {section.tail!.groups.length > 1 && <Text style={[s.faintXs, { paddingLeft: 28, paddingTop: 4 }]}>{g.label}</Text>}
                    {g.rows.map((r) => (
                      <Block key={r.path} active={ctx.activeWorktreeId === r.path}>
                        <Row row={r} ctx={ctx} />
                      </Block>
                    ))}
                    {g.phantomPRs.map((pr) => (
                      <PhantomRow key={`${pr.repoRoot}#${pr.number}`} pr={pr} showRepo={showRepoLabels} />
                    ))}
                  </View>
                ))}
            </View>
          )}
        </View>
      )}
    </View>
  )
}

function Group({ group, scope, ctx, showRepoLabels }: { group: WorktreeListGroupModel; scope: string; ctx: Ctx; showRepoLabels: boolean }) {
  return (
    <View>
      <GroupHeader label={group.label} count={group.count} collapsed={group.collapsed} onPress={() => ctx.collapse.toggleGroup(scope, group.key)} />
      {!group.collapsed && (
        <>
          {group.rows.map((r) => (
            <Block key={r.path} active={ctx.activeWorktreeId === r.path}>
              <Row row={r} ctx={ctx} />
            </Block>
          ))}
          {group.phantomPRs.map((pr) => (
            <PhantomRow key={`${pr.repoRoot}#${pr.number}`} pr={pr} showRepo={showRepoLabels} />
          ))}
        </>
      )}
    </View>
  )
}

function GroupHeader({ label, count, collapsed, onPress }: { label: string; count: number; collapsed: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.groupHead, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityState={{ expanded: !collapsed }}>
      {collapsed ? <ChevronRight color={c.faint} size={12} /> : <ChevronDown color={c.faint} size={12} />}
      <Text style={s.faintXs}>{label}</Text>
      <View style={{ flex: 1 }} />
      <Text style={s.faintXs}>{count}</Text>
    </Pressable>
  )
}

/** RowBlock: mx-1.5 rounded-md, bg-surface when active, /50 for context. */
function Block({ active, context, children }: { active: boolean; context?: boolean; children: ReactNode }) {
  return (
    <View style={{ marginHorizontal: 6, borderRadius: 6, overflow: 'hidden', backgroundColor: active ? c.surface : context ? alpha(c.surface, 0.5) : 'transparent' }}>
      {children}
    </View>
  )
}

function BareRepoHeader({ section, onPress }: { section: WorktreeRepoSectionModel; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.projectRow, { marginHorizontal: 6 }]}>
      <RepoIcon name={section.repoName} />
      <Text style={s.projectName} numberOfLines={1}>
        {section.repoName}
      </Text>
      {section.collapsed && section.count > 0 && <Text style={s.faintXs}>{section.count}</Text>}
      <View style={{ flex: 1 }} />
      {section.collapsed ? <ChevronRight color={c.faint} size={12} /> : <ChevronDown color={c.faint} size={12} />}
    </Pressable>
  )
}

function RepoIcon({ name, status, diamond }: { name: string; status?: DisplayStatus; diamond?: boolean }) {
  return (
    <View style={{ width: 24, height: 24, borderRadius: 3, backgroundColor: repoBg(name), alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>{name[0]?.toUpperCase()}</Text>
      {status && (
        <View style={{ position: 'absolute', right: -3, bottom: -3 }}>
          <Pulse active={STATUS[status].pulse}>
            <View
              style={{
                width: 9,
                height: 9,
                borderRadius: diamond ? 1 : 5,
                transform: diamond ? [{ rotate: '45deg' }] : undefined,
                backgroundColor: STATUS[status].color,
                borderWidth: 2,
                borderColor: c.panel
              }}
            />
          </Pulse>
        </View>
      )}
    </View>
  )
}

// ── rows ───────────────────────────────────────────────────────────────

function clientFor(ctx: Ctx, path: string) {
  return ctx.fleet.client(ctx.merged.pathBackendId[path])
}

function rowActions(row: WorktreeRowModel, ctx: Ctx, isProject: boolean): Action[] {
  const client = clientFor(ctx, row.path)
  if (!client || row.deleting) return []
  const req = (ch: string, ...a: unknown[]) => void client.req(ch, ...a)
  const out: Action[] = [
    {
      label: row.alias ? 'Rename Alias…' : 'Alias Worktree…',
      icon: <Tag color={c.fgBright} size={16} />,
      run: () => ctx.setEditingAlias(row.path),
      afterClose: true
    }
  ]
  if (row.alias) out.push({ label: 'Clear Alias', icon: <X color={c.fgBright} size={16} />, run: () => req('aliases:clear', row.path) })
  const locked = row.worktree.isMain
  if (!locked) {
    out.push(
      row.isPinned
        ? { label: 'Unpin Worktree', icon: <PinOff color={c.accent} size={16} />, tone: 'accent', run: () => req('pinned:unpin', row.path) }
        : { label: 'Pin Worktree', icon: <Pin color={c.accent} size={16} />, tone: 'accent', run: () => req('pinned:pin', row.path) }
    )
    out.push(
      row.isSnoozed
        ? {
            label: row.snoozeWakeAt ? `Wakes ${formatWakeAt(row.snoozeWakeAt)} — tap to wake up` : 'Wake up',
            icon: <AlarmClock color={c.accent} size={16} />,
            tone: 'accent',
            run: () => req('snooze:unsnooze', row.path)
          }
        : {
            label: 'Snooze',
            icon: <Moon color={c.accent} size={16} />,
            tone: 'accent',
            run: () => req('snooze:snooze', row.path, Date.now() + ctx.snoozeDays * 86_400_000)
          }
    )
  } else if (row.isPinned) {
    out.push({ label: 'Unpin Worktree', icon: <PinOff color={c.accent} size={16} />, tone: 'accent', run: () => req('pinned:unpin', row.path) })
  }
  void isProject
  return out
}

function MoreBtn({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.icon44, { marginRight: -8 }, pressed && { backgroundColor: c.surface }]} accessibilityLabel="Worktree actions">
      <MoreHorizontal color={c.dim} size={16} />
    </Pressable>
  )
}

const ProjectRow = memo(function ProjectRow({
  row,
  ctx,
  name,
  repoRoot,
  collapsed,
  count,
  collapsedStatus,
  pinnedOpen,
  onTogglePinned
}: {
  row: WorktreeRowModel
  ctx: Ctx
  name: string
  repoRoot: string
  collapsed?: boolean
  count?: number
  collapsedStatus?: DisplayStatus
  pinnedOpen?: boolean
  onTogglePinned?: () => void
}) {
  const active = ctx.activeWorktreeId === row.path
  const title = row.alias ?? name
  const actions = rowActions(row, ctx, true)
  void repoRoot
  return (
    <Pressable onPress={() => ctx.onSelect(row.path)} style={({ pressed }) => [s.projectRow, pressed && !active && { backgroundColor: c.panelRaised }]}>
      <RepoIcon name={name} status={collapsedStatus ?? row.displayStatus} diamond={collapsedStatus === 'needs-approval'} />
      <View style={{ flex: 1, minWidth: 0 }}>
        {ctx.editingAlias === row.path ? (
          <AliasEditor row={row} ctx={ctx} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[s.projectName, active && { color: c.fgBright }]} numberOfLines={1}>
              {title}
            </Text>
            {collapsed && !!count && <Text style={s.faintXs}>{count}</Text>}
            {row.home?.showBranch && (
              <Text style={s.branchPill} numberOfLines={1}>
                {row.worktree.branch}
              </Text>
            )}
            {row.prStatus && <GitPullRequest color={tw(prIconStyle(row.prStatus).iconColor).color ?? c.dim} size={12} />}
            <ReviewIcon row={row} ctx={ctx} size={12} />
            {row.shellActive && (
              <Spin>
                <Loader2 color={c.fgBright} size={12} />
              </Spin>
            )}
          </View>
        )}
        {row.displayStatus === 'needs-approval' && row.pendingTool && (
          <Text style={s.pendingTool} numberOfLines={1}>
            {formatPendingTool(row.pendingTool)}
          </Text>
        )}
      </View>
      {actions.length > 0 && <MoreBtn onPress={() => ctx.openSheet(title, row.worktree.branch, actions)} />}
      {onTogglePinned && (
        <Pressable onPress={onTogglePinned} style={[s.icon44, { marginRight: -8 }]} accessibilityLabel={pinnedOpen ? 'Unpin project' : 'Keep project open'}>
          <Pin color={pinnedOpen ? c.accent : c.faint} fill={pinnedOpen ? c.accent : 'none'} size={12} />
        </Pressable>
      )}
    </Pressable>
  )
})

const Row = memo(function Row({ row, ctx }: { row: WorktreeRowModel; ctx: Ctx }) {
  const active = ctx.activeWorktreeId === row.path
  const label = row.alias ?? row.worktree.branch
  const prunable = !!row.worktree.prunable
  const actions = rowActions(row, ctx, false)
  const st = STATUS[row.displayStatus]
  const pr = row.prStatus
  const detached = detachedLikeTooltip(row.worktree.branch)
  return (
    <Pressable
      onPress={() => ctx.onSelect(row.path)}
      style={({ pressed }) => [s.row, row.deleting && { opacity: 0.6 }, pressed && !active && { backgroundColor: c.panelRaised }]}
    >
      {row.deleting ? (
        <Spin>
          <Loader2 color={c.danger} size={12} />
        </Spin>
      ) : (
        <Pulse active={st.pulse}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: st.color }} />
        </Pulse>
      )}
      {row.shellActive && (
        <Spin>
          <Loader2 color={c.fgBright} size={12} />
        </Spin>
      )}
      {row.isPinned && <Pin color={c.accent} size={12} />}
      {pr && (
        <View>
          <GitPullRequest color={tw(prIconStyle(pr).iconColor).color ?? c.dim} size={14} />
          {(pr.reviewDecision === 'approved' || pr.reviewDecision === 'changes_requested') && (
            <View style={{ position: 'absolute', top: -2, right: -2, width: 6, height: 6, borderRadius: 3, backgroundColor: pr.reviewDecision === 'approved' ? c.success : c.warning, borderWidth: 1, borderColor: c.panel }} />
          )}
        </View>
      )}
      <ReviewIcon row={row} ctx={ctx} size={14} />
      <View style={{ flex: 1, minWidth: 0 }}>
        {ctx.editingAlias === row.path ? (
          <AliasEditor row={row} ctx={ctx} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {detached && <TriangleAlert color={c.warning} size={12} />}
            <Text
              style={[s.rowLabel, { color: active ? c.fgBright : c.muted }, (row.deleting) && { fontStyle: 'italic' }, prunable && { textDecorationLine: 'line-through', color: c.dim }]}
              numberOfLines={1}
            >
              {label}
            </Text>
            {prunable && (
              <View style={s.stale}>
                <Ghost color={c.warning} size={10} />
                <Text style={{ color: c.warning, fontSize: 10, letterSpacing: 0.5 }}>STALE</Text>
              </View>
            )}
          </View>
        )}
        <Subtitle row={row} ctx={ctx} active={active} prunable={prunable} />
      </View>
      {actions.length > 0 && <MoreBtn onPress={() => ctx.openSheet(label, row.alias ? row.worktree.branch : undefined, actions)} />}
    </Pressable>
  )
})

function Subtitle({ row, ctx, active, prunable }: { row: WorktreeRowModel; ctx: Ctx; active: boolean; prunable: boolean }) {
  const tone = active ? c.muted : c.faint
  if (row.displayStatus === 'needs-approval' && row.pendingTool) {
    return (
      <Text style={s.pendingTool} numberOfLines={1}>
        {formatPendingTool(row.pendingTool)}
      </Text>
    )
  }
  if (prunable) {
    const segs = row.path.split('/')
    return (
      <Text style={{ fontSize: fs.xs, color: tone }} numberOfLines={1}>
        {row.repoLabel ? (
          <>
            <Text style={{ color: repoText(row.repoLabel) }}>{row.repoLabel}</Text> · {segs.pop()}
          </>
        ) : (
          segs.slice(-2).join('/')
        )}
      </Text>
    )
  }
  // Touch forces comfy density but reads the prefs of the user's desktop
  // density — same quirk as the web (WorktreeList.tsx:176-177).
  const st = ctx.fleet.client(ctx.merged.pathBackendId[row.path])?.getState().settings
  const prefs = st?.sidebarDetails?.[st.sidebarDensity ?? 'comfy'] ?? DEFAULT_SIDEBAR_DETAILS.comfy
  const pr = row.prStatus
  const backendId = ctx.merged.pathBackendId[row.path]
  const origin = ctx.multiBackend && backendId ? ctx.merged.backendMeta[backendId]?.label : undefined
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, minWidth: 0, overflow: 'hidden' }}>
      {origin && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: 90, flexShrink: 1 }}>
          <Server color={c.info} size={10} />
          <Text style={{ fontSize: fs.xs, color: c.info }} numberOfLines={1}>
            {origin}
          </Text>
        </View>
      )}
      {prefs.repoLabel && row.repoLabel && (
        <Text style={{ fontSize: fs.xs, color: repoText(row.repoLabel), maxWidth: 80, flexShrink: 1 }} numberOfLines={1}>
          {row.repoLabel}
        </Text>
      )}
      {prefs.branch && row.alias && (
        <Text style={{ fontSize: fs.xs, color: tone, maxWidth: 128, flexShrink: 1 }} numberOfLines={1}>
          {row.worktree.branch}
        </Text>
      )}
      {prefs.age && <Text numberOfLines={1} style={{ fontSize: fs.xs, color: tone, fontFamily: mono, flexShrink: 0 }}>{formatWorktreeAge(row.worktree.createdAt)}</Text>}
      {prefs.diff && pr?.additions !== undefined && pr?.deletions !== undefined && (
        <Text numberOfLines={1} style={{ fontSize: fs.xs, fontFamily: mono, flexShrink: 0 }}>
          <Text style={{ color: c.success }}>+{pr.additions}</Text>
          <Text style={{ color: c.danger }}> −{pr.deletions}</Text>
        </Text>
      )}
      {prefs.milestone && pr?.milestone && (
        <Text style={{ fontSize: fs.xs, color: tone, maxWidth: 96, flexShrink: 1 }} numberOfLines={1}>
          {pr.milestone.title}
        </Text>
      )}
      {prefs.prNumber && pr && (
        <View style={s.prPill}>
          <Text style={{ color: c.fgBright, fontSize: fs.xs, fontFamily: mono }}>#{pr.number}</Text>
        </View>
      )}
    </View>
  )
}

function ReviewIcon({ row, ctx, size }: { row: WorktreeRowModel; ctx: Ctx; size: number }) {
  const state = ctx.fleet.client(ctx.merged.pathBackendId[row.path])?.getState()
  if (!state) return null
  const tree = state.terminals.panes[row.path]
  const { kind, unsent, reviewerTabId } = latestAgentReviewStatus(state.reviews.byPath[row.path], (id) => !!tree && !!findLeafByTabId(tree, id))
  if (kind === 'none') return null
  const reviewer = reviewerTabId ? state.terminals.statuses[reviewerTabId] : undefined
  let cls: string
  let IconName: string
  if (kind === 'reviewing') {
    if (reviewer === 'processing') [IconName, cls] = ['Loader2', 'text-accent animate-spin']
    else if (reviewer === 'needs-approval') [IconName, cls] = ['ListChecks', 'text-danger animate-pulse']
    else [IconName, cls] = ['ListChecks', 'text-accent opacity-60']
  } else if (kind === 'approve') [IconName, cls] = ['CircleCheck', 'text-success']
  else if (kind === 'changes-requested') [IconName, cls] = ['CircleAlert', 'text-warning']
  else [IconName, cls] = ['MessageSquare', 'text-info']
  // The lucide shim maps the desktop's class names to RN props.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Icons = require('../shims/lucide-react.js') as Record<string, (p: { className: string; size: number }) => ReactNode>
  const Icon = Icons[IconName]
  return (
    <View>
      <Icon className={cls} size={size} />
      {unsent && <View style={{ position: 'absolute', top: -2, right: -2, width: 6, height: 6, borderRadius: 3, backgroundColor: c.warning }} />}
    </View>
  )
}

function AliasEditor({ row, ctx }: { row: WorktreeRowModel; ctx: Ctx }) {
  const [value, setValue] = useState(row.alias ?? '')
  const done = useRef(false)
  const commit = () => {
    if (done.current) return
    done.current = true
    // Server trims and treats empty as clear (main/index.ts aliases:set).
    void clientFor(ctx, row.path)?.req('aliases:set', row.path, value)
    ctx.setEditingAlias(null)
  }
  return (
    <TextInput
      autoFocus
      selectTextOnFocus
      value={value}
      onChangeText={setValue}
      maxLength={80}
      // Names, not prose: autocorrect only gets in the way.
      autoCorrect={false}
      spellCheck={false}
      onSubmitEditing={commit}
      onBlur={commit}
      returnKeyType="done"
      placeholder={row.worktree.branch}
      placeholderTextColor={c.faint}
      style={{ color: c.fgBright, fontSize: 16, fontWeight: '500', backgroundColor: c.surface, borderWidth: 1, borderColor: c.accent, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 4 }}
    />
  )
}

function PendingRow({ pending, ctx }: { pending: PendingWorktree; ctx: Ctx }) {
  const failed = pending.status === 'error'
  const owner = ctx.fleet.client(ctx.merged.pendingBackendId[pending.id])
  return (
    <View style={[s.row, { marginHorizontal: 6 }]}>
      {failed ? (
        <AlertCircle color={c.danger} size={14} />
      ) : (
        <Spin>
          <Loader2 color={c.accent} size={14} />
        </Spin>
      )}
      <View style={{ flex: 1 }}>
        <Text style={[s.rowLabel, { color: c.muted }]} numberOfLines={1}>
          {pending.branchName}
        </Text>
        <Text style={s.faintXs}>{failed ? 'Failed to create' : 'Creating worktree…'}</Text>
      </View>
      {failed && owner && (
        <Pressable style={[s.icon44, { marginRight: -8 }]} onPress={() => void owner.req('worktrees:dismissPending', pending.id)} accessibilityLabel="Dismiss">
          <X color={c.faint} size={12} />
        </Pressable>
      )}
    </View>
  )
}

function PhantomRow({ pr, showRepo }: { pr: AssignedPR; showRepo: boolean }) {
  // Not tappable on mobile (MobileApp passes no onOpenAssignedPR).
  return (
    <View style={[s.row, { marginHorizontal: 6 }]}>
      <GitPullRequest color={pr.isDraft ? c.dim : c.accent} size={14} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: fs.sm, color: c.muted }} numberOfLines={1}>
          <Text style={{ color: c.faint }}>#{pr.number} </Text>
          {pr.title}
        </Text>
        <Text style={s.faintXs} numberOfLines={1}>
          {showRepo ? `${repoLabelFor(pr.repoRoot)} · ` : ''}
          {pr.author?.login ? `by ${pr.author.login}` : 'assigned to you'}
        </Text>
      </View>
    </View>
  )
}

// ── action sheet (WorktreeActionSheet.tsx) ──────────────────────────────

function ActionSheet({ sheet, onClose }: { sheet: { title: string; subtitle?: string; actions: Action[] } | null; onClose: () => void }) {
  // In-tree overlay rather than RN <Modal>: react-native-web's Modal
  // intermittently fails to re-show after a close and leaves its focus
  // trap behind, which stole the alias editor's focus.
  if (!sheet) return null
  const toneColor = (t?: Action['tone']) => (t === 'accent' ? c.accent : t === 'warning' ? c.warning : t === 'danger' ? c.danger : c.fgBright)
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 50, justifyContent: 'flex-end' }]} accessibilityViewIsModal>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={onClose} accessibilityLabel="Close actions" />
      <View style={s.actionSheet}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderColor: c.border }}>
          <Text style={{ color: c.fgBright, fontSize: fs.sm, fontWeight: '600' }} numberOfLines={1}>
            {sheet.title}
          </Text>
          {sheet.subtitle ? <Text style={{ color: c.dim, fontSize: fs.xs, marginTop: 2 }}>{sheet.subtitle}</Text> : null}
        </View>
        <ScrollView style={{ maxHeight: 420 }}>
          {sheet.actions.map((a) => (
            <Pressable
              key={a.label}
              onPress={() => {
                onClose()
                // Let the overlay unmount before anything grabs focus.
                if (a.afterClose) setTimeout(a.run, 0)
                else a.run()
              }}
              style={({ pressed }) => [s.actionItem, pressed && { backgroundColor: c.surface }]}
            >
              {a.icon}
              <Text style={{ color: toneColor(a.tone), fontSize: fs.sm }}>{a.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={onClose} style={({ pressed }) => [s.actionItem, { borderBottomWidth: 0 }, pressed && { backgroundColor: c.surface }]}>
            <Text style={{ color: c.dim, fontSize: fs.sm }}>Cancel</Text>
          </Pressable>
        </ScrollView>
        <View style={{ height: 24 }} />
      </View>
    </View>
  )
}

function IconBtn({ label, onPress, disabled, children }: { label: string; onPress: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      style={({ pressed }) => [s.icon44, { opacity: disabled ? 0.4 : 1 }, pressed && { backgroundColor: c.surface }]}
    >
      {children}
    </Pressable>
  )
}

const s = StyleSheet.create({
  sheet: { ...(StyleSheet.absoluteFill as object), backgroundColor: c.app, zIndex: 30 },
  head: { flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 4, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel },
  headTitle: { flex: 1, color: c.dim, fontSize: fs.xs, fontWeight: '600', letterSpacing: 1.2 },
  icon44: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  dimText: { color: c.dim, fontSize: fs.sm },
  faintXs: { color: c.faint, fontSize: fs.xs },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, minHeight: 44, backgroundColor: alpha(c.app, 0.95) },
  projectRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, minHeight: 56, paddingVertical: 10, borderRadius: 6 },
  projectName: { color: c.fgBright, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  branchPill: { maxWidth: '50%', backgroundColor: c.surface, borderRadius: 3, paddingHorizontal: 4, fontSize: fs.xs, color: c.dim, fontFamily: mono },
  pendingTool: { color: c.danger, fontSize: fs.xs, fontFamily: mono, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, minHeight: 44, paddingVertical: 12 },
  rowLabel: { fontSize: fs.sm, fontWeight: '500', flexShrink: 1 },
  stale: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 2, backgroundColor: alpha(c.warning, 0.15) },
  prPill: { flexShrink: 0, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: c.panel, borderWidth: 1, borderColor: c.borderStrong },
  actionSheet: { backgroundColor: c.panel, borderTopWidth: 1, borderColor: c.borderStrong, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  actionItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: 48, borderBottomWidth: 1, borderColor: c.border }
})
