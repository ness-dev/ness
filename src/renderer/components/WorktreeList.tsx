import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ChevronRight, Plus, X, AlertCircle, Loader2, GitPullRequest, Sparkles } from 'lucide-react'
import type { PendingWorktree } from '../types'
import type { AssignedPR } from '../../shared/state/assigned-prs'
import type { GroupKey } from '../../shared/worktree-sort'
import type {
  WorktreeListModel,
  WorktreeRepoSectionModel,
  WorktreeListGroupModel,
  WorktreeRowModel
} from '../worktree-list-model'
import { repoLabelFor } from '../worktree-list-model'
import { WorktreeTab, type WorktreeListVariant } from './WorktreeTab'
import { SnoozeCalendar } from './SnoozeCalendar'
import { Tooltip } from './Tooltip'
import { HotkeyBadge } from './HotkeyBadge'
import { repoNameColor } from './RepoIcon'
import { useBackend } from '../backend'
import { useSettings } from '../store'
import { useMetaHeld } from '../hooks/useMetaHeld'

/** Everything between the desktop sidebar's header and its footer — repo
 *  sections, group headers, rows, the inline continue-on-new-branch form,
 *  phantom review PRs and pending-creation rows.
 *
 *  The touch worktree picker renders the exact same tree with
 *  `variant="touch"`; only the surrounding shell (fixed-width resizable
 *  panel vs. fullscreen overlay) differs. Handlers a surface can't service
 *  are simply omitted and the corresponding affordance disappears. */
interface WorktreeListProps {
  model: WorktreeListModel
  variant: WorktreeListVariant
  activeWorktreeId: string | null
  snoozeDefaultDays?: number
  /** Non-main worktrees. Drives the "spawn your first agent" nudge. */
  agentCount: number
  editingAliasPath: string | null
  onStartAliasEdit: (path: string) => void
  onEndAliasEdit: () => void
  onSelectWorktree: (path: string) => void
  onToggleGroup: (scope: string, key: GroupKey) => void
  onToggleRepo: (repoRoot: string) => void
  onNewWorktree?: (repoRoot?: string) => void
  onDismissPendingWorktree?: (id: string) => void
  onContinueWorktree?: (worktreePath: string, newBranchName: string) => Promise<void>
  onDeleteWorktree?: (path: string) => Promise<void>
  onPruneWorktrees?: (repoRoot: string) => Promise<void>
  onRemoveRepo?: (repoRoot: string) => Promise<void>
  onOpenAssignedPR?: (repoRoot: string, prNumber: number) => void
}

export function WorktreeList({
  model,
  variant,
  activeWorktreeId,
  snoozeDefaultDays,
  agentCount,
  editingAliasPath,
  onStartAliasEdit,
  onEndAliasEdit,
  onSelectWorktree,
  onToggleGroup,
  onToggleRepo,
  onNewWorktree,
  onDismissPendingWorktree,
  onContinueWorktree,
  onDeleteWorktree,
  onPruneWorktrees,
  onRemoveRepo,
  onOpenAssignedPR
}: WorktreeListProps): JSX.Element {
  const backend = useBackend()
  const touch = variant === 'touch'
  // Read once for the whole list rather than per row — N rows each holding
  // their own store subscription is CLAUDE.md anti-pattern #4.
  const settings = useSettings()
  const density = settings.sidebarDensity
  const detailPrefs = settings.sidebarDetails[density]
  const metaHeld = useMetaHeld() && !touch

  const [continueTarget, setContinueTarget] = useState<{ path: string; oldBranch: string } | null>(
    null
  )
  const [continueBranchName, setContinueBranchName] = useState('')
  const [continuing, setContinuing] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)
  const [calendarFor, setCalendarFor] = useState<{
    path: string
    anchor: { top: number; left: number; width: number; height: number }
  } | null>(null)

  const beginContinue = useCallback((path: string, oldBranch: string) => {
    setContinueTarget({ path, oldBranch })
    setContinueBranchName(suggestContinueName(oldBranch))
    setContinueError(null)
  }, [])

  const cancelContinue = useCallback(() => {
    setContinueTarget(null)
    setContinueBranchName('')
    setContinueError(null)
  }, [])

  const submitContinue = useCallback(async () => {
    if (!continueTarget || !onContinueWorktree) return
    const name = continueBranchName.trim()
    if (!name) return
    setContinuing(true)
    setContinueError(null)
    try {
      await onContinueWorktree(continueTarget.path, name)
      cancelContinue()
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : 'Failed to continue worktree')
    } finally {
      setContinuing(false)
    }
  }, [continueTarget, continueBranchName, onContinueWorktree, cancelContinue])

  const snoozeDays = Math.max(1, Math.floor(snoozeDefaultDays ?? 7))

  const onSnoozeRow = useCallback(
    (path: string, e?: ReactMouseEvent) => {
      // ⌥-click opens the date picker anchored to the button. Touch has no
      // modifier, so it always takes the default duration.
      if (e?.altKey) {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        setCalendarFor({
          path,
          anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        })
        return
      }
      void backend.snooze(path, Date.now() + snoozeDays * 86400000)
    },
    [snoozeDays, backend]
  )

  const rowActionsFor = useCallback(
    (row: WorktreeRowModel) => {
      const { worktree, deleting } = row
      const locked = worktree.isMain || deleting
      return {
        onContinue: locked || !onContinueWorktree ? undefined : () => beginContinue(worktree.path, worktree.branch),
        onSnooze: locked ? undefined : (e?: ReactMouseEvent) => onSnoozeRow(worktree.path, e),
        onUnsnooze: locked ? undefined : () => void backend.unsnooze(worktree.path),
        // Pinning is an organisational choice, not a lifecycle action — the
        // main worktree is pinnable too, so this gates on `deleting` alone
        // rather than `locked`.
        onTogglePin: deleting
          ? undefined
          : () =>
              void (row.isPinned
                ? backend.unpinWorktree(worktree.path)
                : backend.pinWorktree(worktree.path)),
        onPrune:
          worktree.prunable && onPruneWorktrees
            ? () => void onPruneWorktrees(worktree.repoRoot)
            : undefined,
        onDelete: locked || !onDeleteWorktree ? undefined : () => void onDeleteWorktree(worktree.path)
      }
    },
    [beginContinue, onSnoozeRow, backend, onContinueWorktree, onPruneWorktrees, onDeleteWorktree]
  )

  const renderGroup = (
    section: WorktreeRepoSectionModel,
    group: WorktreeListGroupModel
  ): JSX.Element => (
    <div key={group.key}>
      <button
        onClick={() => onToggleGroup(section.scope, group.key)}
        className={`w-full flex items-center gap-1 px-3 text-xs text-dim hover:text-fg transition-colors cursor-pointer ${
          touch ? 'min-h-11 py-2 sticky top-0 z-10 bg-app/95 backdrop-blur' : 'py-1.5'
        }`}
        title={group.collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
      >
        <Chevron collapsed={group.collapsed} />
        <span className="font-medium">{group.label}</span>
        <span className="text-faint ml-auto">{group.count}</span>
      </button>
      {!group.collapsed &&
        group.rows.map((row) => (
          <div key={row.path}>
            <WorktreeTab
              row={row}
              variant={variant}
              isActive={row.path === activeWorktreeId}
              metaHeld={metaHeld}
              density={density}
              detailPrefs={detailPrefs}
              isEditingAlias={editingAliasPath === row.path}
              actions={rowActionsFor(row)}
              onClick={() => onSelectWorktree(row.path)}
              onStartAliasEdit={() => onStartAliasEdit(row.path)}
              onEndAliasEdit={onEndAliasEdit}
            />
            {continueTarget?.path === row.path && (
              <div className="border-y-2 border-accent bg-panel-raised p-2.5 shadow-inner">
                <div className="text-xs font-semibold uppercase tracking-wider text-accent mb-1.5 px-0.5">
                  Continue on new branch
                </div>
                <input
                  type="text"
                  value={continueBranchName}
                  onChange={(e) => setContinueBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitContinue()
                    if (e.key === 'Escape') cancelContinue()
                  }}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="new-branch-name"
                  autoFocus
                  disabled={continuing}
                  data-hotkeys="ignore"
                  className="w-full bg-app border-2 border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-accent"
                />
                {continueError && (
                  <div className="text-xs text-danger mt-1 px-1 truncate" title={continueError}>
                    {continueError}
                  </div>
                )}
                <div className="flex gap-1 mt-1.5">
                  <button
                    onClick={() => void submitContinue()}
                    disabled={continuing || !continueBranchName.trim()}
                    className={`flex-1 text-xs bg-accent hover:opacity-90 disabled:opacity-40 rounded px-2 text-app font-semibold transition-opacity cursor-pointer ${
                      touch ? 'min-h-11' : 'py-1'
                    }`}
                  >
                    {continuing ? 'Continuing...' : 'Continue'}
                  </button>
                  <button
                    onClick={cancelContinue}
                    disabled={continuing}
                    className={`text-xs text-dim hover:text-fg px-2 transition-colors cursor-pointer ${
                      touch ? 'min-h-11' : 'py-1'
                    }`}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      {!group.collapsed &&
        group.phantomPRs.map((pr) => (
          <AssignedPRRow
            key={`${pr.repoRoot}#${pr.number}`}
            pr={pr}
            variant={variant}
            showRepoLabel={model.showRepoLabels}
            repoLabel={repoLabelFor(pr.repoRoot)}
            onClick={onOpenAssignedPR ? () => onOpenAssignedPR(pr.repoRoot, pr.number) : undefined}
          />
        ))}
    </div>
  )

  return (
    <>
      {agentCount === 0 && onNewWorktree && (
        <button
          onClick={() => onNewWorktree()}
          className="group relative mx-2 mb-2 mt-1 w-[calc(100%-1rem)] text-left bg-panel-raised border border-border-strong hover:border-accent rounded-lg overflow-hidden transition-colors cursor-pointer"
        >
          <div className="brand-gradient-bg h-0.5" />
          <div className="p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Sparkles className="icon-xs text-accent" />
              <span className="text-xs font-semibold uppercase tracking-wider text-accent">
                Get started
              </span>
            </div>
            <div className="text-sm font-semibold text-fg-bright leading-snug">
              Spawn your first agent
            </div>
            <div className="text-xs text-dim mt-0.5 leading-snug">
              Fork a branch and send a Claude into it.
            </div>
            {!touch && (
              <div className="mt-2">
                <HotkeyBadge action="newWorktree" />
              </div>
            )}
          </div>
        </button>
      )}
      {model.sections.map((section) => (
        <div key={section.repoRoot}>
          {model.showRepoHeaders && (
            <RepoHeader
              section={section}
              variant={variant}
              onToggle={() => onToggleRepo(section.repoRoot)}
              onRemove={onRemoveRepo}
            />
          )}
          {!section.collapsed && agentCount > 0 && onNewWorktree && (
            <button
              onClick={() => onNewWorktree(section.unified ? undefined : section.repoRoot)}
              className={`group relative w-full flex items-center gap-2 px-3 text-dim hover:bg-panel-raised transition-colors cursor-pointer overflow-hidden ${
                touch ? 'min-h-11 py-3' : 'py-1.5'
              }`}
            >
              <span className="absolute left-0 top-0 bottom-0 w-0.5 brand-gradient-flow-bar opacity-0 group-hover:opacity-100 transition-opacity" />
              <Plus className="icon-sm shrink-0 text-dim group-hover:text-brand transition-colors" />
              <span className="text-sm font-medium brand-gradient-flow-text-hover">Add worktree</span>
              {!touch && (section.unified || !model.showRepoHeaders) && (
                <HotkeyBadge action="newWorktree" className="ml-auto" />
              )}
            </button>
          )}
          {!section.collapsed &&
            section.pending.map((pending) => (
              <PendingWorktreeRow
                key={pending.id}
                pending={pending}
                variant={variant}
                isActive={pending.id === activeWorktreeId}
                onClick={() => onSelectWorktree(pending.id)}
                onDismiss={
                  onDismissPendingWorktree ? () => onDismissPendingWorktree(pending.id) : undefined
                }
              />
            ))}
          {!section.collapsed && section.groups.map((group) => renderGroup(section, group))}
        </div>
      ))}
      {model.totalWorktrees === 0 &&
        (onNewWorktree ? (
          agentCount > 0 && <div className="px-4 py-3 text-xs text-faint">No worktrees found</div>
        ) : (
          <div className="p-6 text-center text-dim text-sm">
            No worktrees yet. Create one from the desktop app to get started.
          </div>
        ))}
      {calendarFor && (
        <SnoozeCalendar
          anchor={calendarFor.anchor}
          defaultDays={snoozeDays}
          onPick={(wakeAt) => {
            void backend.snooze(calendarFor.path, wakeAt)
            setCalendarFor(null)
          }}
          onDismiss={() => setCalendarFor(null)}
        />
      )}
    </>
  )
}

function Chevron({ collapsed }: { collapsed: boolean }): JSX.Element {
  return collapsed ? (
    <ChevronRight className="icon-xs shrink-0" />
  ) : (
    <ChevronDown className="icon-xs shrink-0" />
  )
}

function RepoHeader({
  section,
  variant,
  onToggle,
  onRemove
}: {
  section: WorktreeRepoSectionModel
  variant: WorktreeListVariant
  onToggle: () => void
  onRemove?: (repoRoot: string) => Promise<void>
}): JSX.Element {
  return (
    <button
      onClick={onToggle}
      className={`group w-full flex items-center gap-1 px-3 mt-1 text-xs font-semibold uppercase tracking-wider text-dim hover:text-fg transition-colors cursor-pointer ${
        variant === 'touch' ? 'min-h-11 py-2' : 'py-1.5'
      }`}
      title={section.repoRoot}
    >
      <Chevron collapsed={section.collapsed} />
      <span className={`truncate ${repoNameColor(section.repoName)}`}>{section.repoName}</span>
      <span className="ml-auto relative flex items-center">
        <span className={`text-faint normal-case transition-opacity ${onRemove ? 'group-hover:opacity-0' : ''}`}>
          {section.count}
        </span>
        {onRemove && (
          <span
            role="button"
            className="absolute inset-0 flex items-center justify-end opacity-0 group-hover:opacity-100 text-faint hover:text-danger transition-opacity"
            title={`Remove ${section.repoName} from workspace`}
            onClick={(e) => {
              e.stopPropagation()
              if (
                window.confirm(
                  `Remove ${section.repoName} from this window? Worktrees stay on disk.`
                )
              ) {
                void onRemove(section.repoRoot)
              }
            }}
          >
            <X className="icon-xs" />
          </span>
        )}
      </span>
    </button>
  )
}

function PendingWorktreeRow({
  pending,
  variant,
  isActive,
  onClick,
  onDismiss
}: {
  pending: PendingWorktree
  variant: WorktreeListVariant
  isActive: boolean
  onClick: () => void
  onDismiss?: () => void
}): JSX.Element {
  const isError = pending.status === 'error'
  return (
    <div
      onClick={onClick}
      className={`group w-full text-left px-3 flex items-center gap-2 transition-colors cursor-pointer ${
        variant === 'touch' ? 'min-h-11 py-3' : 'py-2'
      } ${isActive ? 'bg-surface text-fg-bright' : 'text-muted hover:bg-panel-raised hover:text-fg'}`}
    >
      {isError ? (
        <AlertCircle className="icon-sm shrink-0 text-danger" />
      ) : (
        <Loader2 className="icon-sm shrink-0 text-accent animate-spin" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{pending.branchName}</div>
        <div className="text-xs text-faint truncate">
          {isError ? 'Failed to create' : 'Creating worktree…'}
        </div>
      </div>
      {isError && onDismiss && (
        <Tooltip label="Dismiss" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDismiss()
            }}
            className={`text-faint hover:text-danger transition-all shrink-0 cursor-pointer ${
              variant === 'touch'
                ? 'inline-flex items-center justify-center w-11 h-11 -mr-2'
                : 'opacity-0 group-hover:opacity-100'
            }`}
            aria-label="Dismiss"
          >
            <X className="icon-xs" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

/** A review-requested PR with no worktree yet. Clicking spawns one — on
 *  surfaces that can't create worktrees it renders informational. */
function AssignedPRRow({
  pr,
  variant,
  showRepoLabel,
  repoLabel,
  onClick
}: {
  pr: AssignedPR
  variant: WorktreeListVariant
  showRepoLabel: boolean
  repoLabel: string
  onClick?: () => void
}): JSX.Element {
  const touch = variant === 'touch'
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      title={
        onClick
          ? `Open PR #${pr.number} from ${pr.repoNameWithOwner} as a new worktree`
          : `PR #${pr.number} from ${pr.repoNameWithOwner} — awaiting your review`
      }
      className={`group w-full text-left px-3 flex items-center gap-2 text-muted transition-colors border-l-2 border-transparent ${
        touch ? 'min-h-11 py-3' : 'py-2'
      } ${onClick ? 'hover:bg-panel-raised hover:text-fg hover:border-accent cursor-pointer' : 'cursor-default'}`}
    >
      <GitPullRequest className={`icon-sm shrink-0 ${pr.isDraft ? 'text-dim' : 'text-accent'}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate flex items-center gap-1.5">
          <span className="text-faint">#{pr.number}</span>
          <span className="truncate">{pr.title}</span>
        </div>
        <div className="text-xs text-faint truncate">
          {showRepoLabel ? `${repoLabel} · ` : ''}
          {pr.author?.login ? `by ${pr.author.login}` : 'assigned to you'}
        </div>
      </div>
      {onClick && !touch && (
        <Plus className="icon-xs shrink-0 text-faint opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </button>
  )
}

function suggestContinueName(oldBranch: string): string {
  const match = oldBranch.match(/^(.*?)-continued(?:-(\d+))?$/)
  if (match) {
    const next = match[2] ? parseInt(match[2], 10) + 1 : 2
    return `${match[1]}-continued-${next}`
  }
  return `${oldBranch}-continued`
}
