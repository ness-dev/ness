import { ChevronDown, ChevronRight, GitPullRequest, Hand, Loader2 } from 'lucide-react'
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
  onSelect: (worktreePath: string) => void
  onSelectTab: (worktreePath: string, paneId: string, tabId: string) => void
  onToggleGroup: (scope: string, key: GroupKey) => void
}

/** A dense, one-line-per-worktree rendering of the fleet — the alternative
 *  to CommandCenter's card grid. Three glyphs maximum per row (status,
 *  title, PR) so the view answers "what do I look at next" and nothing
 *  else. Renders from the same `WorktreeListModel` the cards do. */
export function TaskListView({
  model,
  activeWorktreeId,
  activeTabId,
  onSelect,
  onSelectTab,
  onToggleGroup
}: TaskListViewProps): JSX.Element {
  const sections = model.sections.filter((s) => s.count > 0)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto py-3">
      {sections.length === 0 && (
        <div className="h-full flex items-center justify-center text-dim">
          No sessions yet — create a worktree to get started.
        </div>
      )}
      {sections.map((section) => (
        <div key={section.repoRoot} className="mb-4">
          {model.showRepoHeaders && (
            <div className="flex items-center gap-2 px-4 mb-2">
              <h2
                className={`text-base font-semibold tracking-tight ${repoNameColor(section.repoName)}`}
              >
                {section.repoName}
              </h2>
              <div className="flex-1 border-t border-border" />
            </div>
          )}
          {section.groups.map((group) => (
            <section key={group.key} className="mb-3">
              <button
                onClick={() => onToggleGroup(section.scope, group.key)}
                className="w-full flex items-center gap-1.5 px-4 py-1 text-left text-dim hover:text-fg transition-colors cursor-pointer"
              >
                {group.collapsed ? (
                  <ChevronRight className="icon-xs shrink-0" />
                ) : (
                  <ChevronDown className="icon-xs shrink-0" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wider">{group.label}</span>
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
      className={`flex items-center gap-2 pl-3 pr-4 py-1 text-sm transition-colors ${
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
