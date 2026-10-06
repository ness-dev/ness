import {
  PanelLeftOpen,
  Plus,
  Trash2,
  Activity,
  ShieldAlert,
  HatGlasses,
  GitPullRequest
} from 'lucide-react'
import { useMemo } from 'react'
import { Tooltip } from './Tooltip'
import { usePrs, useSettings, useSnooze, useWorktrees } from '../store'
import { groupWorktrees, type GroupKey } from '../../shared/worktree-sort'
import { BottomIconStrip } from './BottomIconStrip'

interface CollapsedSidebarProps {
  onExpand: () => void
  onAddRepo: () => void
  onNewWorktree: () => void
  onOpenCleanup: () => void
  onOpenCommandCenter: () => void
  onOpenNewProject: () => void
  onOpenActivity: () => void
  onOpenMyWeek: () => void
  onOpenHotkeyCheatsheet: () => void
  onOpenSettings: () => void
}

const WIDTH = 48

export function CollapsedSidebar({
  onExpand,
  onAddRepo,
  onNewWorktree,
  onOpenCleanup,
  onOpenCommandCenter,
  onOpenNewProject,
  onOpenActivity,
  onOpenMyWeek,
  onOpenHotkeyCheatsheet,
  onOpenSettings
}: CollapsedSidebarProps): JSX.Element {
  // Live counts for the badges below the cleanup divider. Read from the
  // store so we don't have to thread N more props through App.tsx.
  const worktrees = useWorktrees().list
  const prs = usePrs()
  const snooze = useSnooze()
  const viewerLogin = useSettings().viewerLogin
  const snoozedPaths = useMemo(() => {
    const m: Record<string, true> = {}
    for (const p of Object.keys(snooze.byPath)) m[p] = true
    return m
  }, [snooze.byPath])
  // Deliberately NOT passing pinnedPaths: these badges are a status
  // summary, not a mirror of the sidebar's sections. Grouping pinned
  // worktrees out would drop them from every badge, so a pinned worktree
  // with failing checks would stop counting toward "needs attention".
  const groupCounts = useMemo(() => {
    const counts: Partial<Record<GroupKey, number>> = {}
    const groups = groupWorktrees(worktrees, prs.byPath, prs.mergedByPath, snoozedPaths, viewerLogin)
    for (const g of groups) counts[g.key] = g.worktrees.length
    return counts
  }, [worktrees, prs.byPath, prs.mergedByPath, snoozedPaths, viewerLogin])
  const activeCount = groupCounts['no-pr'] ?? 0
  const needsAttentionCount = groupCounts['needs-attention'] ?? 0
  const reviewingCount = groupCounts['reviewing'] ?? 0
  const openPRsCount = groupCounts['active'] ?? 0

  return (
    <div
      className="shrink-0 bg-panel flex flex-col h-full border-r border-border"
      style={{ width: WIDTH }}
    >
      <div className="no-drag flex flex-col items-center gap-1 py-3">
        <Tooltip label="Expand sidebar" action="toggleSidebar" side="right">
          <button
            onClick={onExpand}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen className="icon-sm" />
          </button>
        </Tooltip>

        <div className="h-px w-6 bg-border my-1" />

        <Tooltip label="Add worktree" action="newWorktree" side="right">
          <button
            onClick={onNewWorktree}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <Plus className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="Clean up old worktrees" side="right">
          <button
            onClick={onOpenCleanup}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <Trash2 className="icon-sm" />
          </button>
        </Tooltip>
        <div className="h-px w-6 bg-border my-1" />
        {activeCount > 0 && (
          <Tooltip label={`${activeCount} active worktree${activeCount === 1 ? '' : 's'}`} side="right">
            <button
              onClick={onExpand}
              className="text-dim hover:text-fg hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5"
              aria-label={`${activeCount} active worktrees`}
            >
              <Activity className="icon-xs" />
              <span className="text-xs tabular-nums leading-none">{activeCount}</span>
            </button>
          </Tooltip>
        )}
        {needsAttentionCount > 0 && (
          <Tooltip label={`${needsAttentionCount} needs attention`} side="right">
            <button
              onClick={onExpand}
              className="text-warning hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5"
              aria-label={`${needsAttentionCount} needs attention`}
            >
              <ShieldAlert className="icon-xs" />
              <span className="text-xs tabular-nums leading-none">{needsAttentionCount}</span>
            </button>
          </Tooltip>
        )}
        {reviewingCount > 0 && (
          <Tooltip label={`${reviewingCount} reviewing`} side="right">
            <button
              onClick={onExpand}
              className="text-dim hover:text-fg hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5"
              aria-label={`${reviewingCount} reviewing`}
            >
              <HatGlasses className="icon-xs" />
              <span className="text-xs tabular-nums leading-none">{reviewingCount}</span>
            </button>
          </Tooltip>
        )}
        {openPRsCount > 0 && (
          <Tooltip label={`${openPRsCount} open PR${openPRsCount === 1 ? '' : 's'}`} side="right">
            <button
              onClick={onExpand}
              className="text-dim hover:text-fg hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5"
              aria-label={`${openPRsCount} open PRs`}
            >
              <GitPullRequest className="icon-xs" />
              <span className="text-xs tabular-nums leading-none">{openPRsCount}</span>
            </button>
          </Tooltip>
        )}
      </div>

      <div className="flex-1" />

      <BottomIconStrip
        orientation="vertical"
        onOpenCommandCenter={onOpenCommandCenter}
        onOpenNewProject={onOpenNewProject}
        onAddRepo={onAddRepo}
        onOpenActivity={onOpenActivity}
        onOpenMyWeek={onOpenMyWeek}
        onOpenHotkeyCheatsheet={onOpenHotkeyCheatsheet}
        onOpenSettings={onOpenSettings}
      />
    </div>
  )
}
