import { useEffect } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  Hand,
  Layers,
  Loader2,
  Rows3
} from 'lucide-react'
import { Tooltip } from './Tooltip'
import type { GroupKey } from '../../shared/worktree-sort'
import type { WorktreeListModel, WorktreeRowModel } from '../worktree-list-model'
import { STATUS_COLORS, STATUS_LABELS, prIconStyle, prIconTitle } from '../worktree-row-style'
import { repoNameColor } from './RepoIcon'
import { WorktreeTabRows } from './WorktreeTabRows'

/** The one line of text a task row shows.
 *
 *  Deliberately a single function with an explicit precedence chain: the
 *  open question this view exists to answer is whether rows want a
 *  sentence-form description of their own rather than a branch name. If the
 *  answer turns out to be yes, that field slots in at the top of the chain
 *  and nothing else in the view has to change. */
export function taskTitle(row: WorktreeRowModel): string {
  return row.alias ?? row.worktree.branch
}

interface TaskListViewProps {
  model: WorktreeListModel
  activeWorktreeId: string | null
  activeTabId: string | null
  /** Same `useWorktreeCollapse` values the sidebar reads, so switching repo
   *  grouping or collapsing a group here does it in both places at once. */
  unifiedRepos: boolean
  repoCount: number
  onToggleUnifiedRepos: () => void
  onClose: () => void
  onSelect: (worktreePath: string) => void
  onSelectTab: (worktreePath: string, paneId: string, tabId: string) => void
  onToggleGroup: (scope: string, key: GroupKey) => void
}

/** The worktree sidebar, fullscreened and stripped to one line per row.
 *
 *  Same `WorktreeListModel` and the same PR-status grouping the sidebar
 *  uses, but three glyphs maximum per row — status, title, PR — so the view
 *  answers "what am I working on and what do I look at next" and nothing
 *  else. Content sits in a centered, max-width column: the point is a
 *  readable list, not a wall that grows with the window.
 *
 *  Rendered as a full-screen overlay (Settings / My week chrome) rather
 *  than in the center column, because it duplicates the sidebar — showing
 *  both at once would put the same list on screen twice. */
export function TaskListView({
  model,
  activeWorktreeId,
  activeTabId,
  unifiedRepos,
  repoCount,
  onToggleUnifiedRepos,
  onClose,
  onSelect,
  onSelectTab,
  onToggleGroup
}: TaskListViewProps): JSX.Element {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const sections = model.sections.filter((s) => s.count > 0)
  const total = sections.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.rows.length, 0), 0)

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-app relative overflow-hidden">
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-20 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
          <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">
            ESC
          </kbd>
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Tasks
        </span>
        <div className="no-drag absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-1">
          <Tooltip
            label={
              repoCount <= 1
                ? 'Merge repos into one list (add another repo to enable)'
                : unifiedRepos
                  ? 'Split by repo'
                  : 'Merge repos into one list'
            }
            side="bottom"
          >
            <button
              onClick={onToggleUnifiedRepos}
              disabled={repoCount <= 1}
              className="text-dim hover:text-fg hover:bg-surface rounded p-1 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-dim"
            >
              {unifiedRepos ? <Rows3 className="icon-sm" /> : <Layers className="icon-sm" />}
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-6">
        <div className="mx-auto w-full max-w-3xl px-4">
          {total === 0 && (
            <div className="text-center text-dim py-12">
              No worktrees yet — create one to get started.
            </div>
          )}
          {sections.map((section) => (
            <div key={section.repoRoot} className="mb-6">
              {model.showRepoHeaders && (
                <div className="flex items-center gap-2 mb-2">
                  <h2
                    className={`text-base font-semibold tracking-tight ${repoNameColor(section.repoName)}`}
                  >
                    {section.repoName}
                  </h2>
                  <div className="flex-1 border-t border-border" />
                </div>
              )}
              {section.groups.map((group) => (
                <section key={group.key} className="mb-4">
                  <button
                    onClick={() => onToggleGroup(section.scope, group.key)}
                    className="w-full flex items-center gap-1.5 py-1 text-left text-dim hover:text-fg transition-colors cursor-pointer"
                  >
                    {group.collapsed ? (
                      <ChevronRight className="icon-xs shrink-0" />
                    ) : (
                      <ChevronDown className="icon-xs shrink-0" />
                    )}
                    <span className="text-xs font-semibold uppercase tracking-wider">
                      {group.label}
                    </span>
                    <span className="text-xs text-faint">{group.rows.length}</span>
                  </button>
                  {!group.collapsed &&
                    group.rows.map((row) => (
                      <div key={row.path}>
                        <TaskRow
                          row={row}
                          isActive={row.path === activeWorktreeId}
                          onSelect={onSelect}
                        />
                        {!row.deleting && (
                          <WorktreeTabRows
                            worktreePath={row.path}
                            activeTabId={row.path === activeWorktreeId ? activeTabId : null}
                            onSelectTab={onSelectTab}
                          />
                        )}
                      </div>
                    ))}
                </section>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TaskRow({
  row,
  isActive,
  onSelect
}: {
  row: WorktreeRowModel
  isActive: boolean
  onSelect: (worktreePath: string) => void
}): JSX.Element {
  const { prStatus, repoLabel, deleting } = row
  const { iconColor } = prIconStyle(prStatus)
  return (
    <div
      onClick={() => !deleting && onSelect(row.path)}
      className={`flex items-center gap-2 rounded px-2 py-1 text-sm transition-colors ${
        deleting
          ? 'text-faint cursor-default'
          : isActive
            ? 'bg-surface text-fg-bright cursor-pointer'
            : 'text-fg hover:bg-surface-hover/50 cursor-pointer'
      }`}
    >
      <span className="w-4 flex items-center justify-center shrink-0">
        <StatusGlyph row={row} />
      </span>
      {repoLabel && (
        <span className={`text-xs shrink-0 ${repoNameColor(repoLabel)}`}>{repoLabel}</span>
      )}
      <span className="truncate">{taskTitle(row)}</span>
      <div className="flex-1" />
      {prStatus && (
        <span className="shrink-0" title={prIconTitle(prStatus)}>
          <GitPullRequest className={`icon-xs ${iconColor}`} />
        </span>
      )}
    </div>
  )
}

function StatusGlyph({ row }: { row: WorktreeRowModel }): JSX.Element {
  if (row.deleting) {
    return <Loader2 className="icon-xs animate-spin text-faint" aria-label="Deleting" />
  }
  // A spinner and a raised hand carry further than two differently-coloured
  // dots do at this density — everything else stays a dot.
  switch (row.displayStatus) {
    case 'processing':
      return (
        <Loader2
          className="icon-xs animate-spin text-success"
          aria-label={STATUS_LABELS.processing}
        />
      )
    case 'needs-approval':
      return (
        <Hand
          className="icon-xs text-danger animate-pulse"
          aria-label={STATUS_LABELS['needs-approval']}
        />
      )
    default:
      return (
        <span
          className={`w-2 h-2 rounded-full ${STATUS_COLORS[row.displayStatus]}`}
          title={STATUS_LABELS[row.displayStatus]}
        />
      )
  }
}
