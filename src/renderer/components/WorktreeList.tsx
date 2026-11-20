import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { ChevronDown, ChevronRight, Plus, X, AlertCircle, Loader2, GitPullRequest, Sparkles, History, Waypoints } from 'lucide-react'
import type { PendingWorktree } from '../types'
import type { AssignedPR } from '../../shared/state/assigned-prs'
import type { GroupKey } from '../../shared/worktree-sort'
import type {
  WorktreeListModel,
  WorktreeRepoSectionModel,
  SectionRepoRoot,
  WorktreeListGroupModel,
  WorktreeRowModel
} from '../worktree-list-model'
import { mergeProjectOrder, repoLabelFor } from '../worktree-list-model'
import { WorktreeTab, type ProjectRowProps, type WorktreeListVariant } from './WorktreeTab'
import type { WorktreeRowAction, WorktreeRowActionHandlers } from './worktree-row-actions'
import { WorktreeTabRows } from './WorktreeTabRows'
import { SnoozeCalendar } from './SnoozeCalendar'
import { Tooltip } from './Tooltip'
import { ContextMenu } from './ContextMenu'
import { HotkeyBadge } from './HotkeyBadge'
import { RepoIcon } from './RepoIcon'
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
  /** Focused tab of the active worktree, highlighted among its nested tabs. */
  activeTabId?: string | null
  snoozeDefaultDays?: number
  /** Non-main worktrees. Drives the "spawn your first agent" nudge. */
  agentCount: number
  editingAliasPath: string | null
  onStartAliasEdit: (path: string) => void
  onEndAliasEdit: () => void
  onSelectWorktree: (path: string) => void
  /** Owning backend per worktree path, so nested tab rows read the right
   *  store. The sidebar sits above every BackendScope. */
  pathBackendId?: Record<string, string>
  /** Backend label per worktree path, present only for non-local ones. */
  originByPath?: Record<string, string>
  /** When provided, worktrees list their tabs as child rows, per the
   *  sidebarTabsExpansion setting. */
  onSelectTab?: (worktreePath: string, paneId: string, tabId: string) => void
  onCloseTab?: (worktreePath: string, tabId: string) => void
  onToggleGroup: (scope: string, key: GroupKey) => void
  /** Keep a project expanded while you work elsewhere. */
  onTogglePinnedOpen: (scope: string) => void
  onNewWorktree?: (repoRoot?: string) => void
  onDismissPendingWorktree?: (id: string) => void
  onContinueWorktree?: (worktreePath: string, newBranchName: string) => Promise<void>
  onDeleteWorktree?: (path: string) => Promise<void>
  onPruneWorktrees?: (repoRoot: string) => Promise<void>
  onRemoveRepo?: (roots: SectionRepoRoot[]) => Promise<void>
  /** Opens the subscription graph scoped to a repo. */
  onOpenGraph?: (repoRoot: string) => void
  onOpenAssignedPR?: (repoRoot: string, prNumber: number) => void
  /** Repos to offer "Install history tracking" for (loch installed, not yet
   *  recording, not dismissed). Omit to hide the prompt entirely. */
  historyPromptRepos?: readonly string[]
  onOpenHistoryTracking?: (repoRoot: string) => void
  onDismissHistoryPrompt?: (repoRoot: string) => void
}

/** The per-repo "Install history tracking" nudge. Opens the full-screen
 *  explainer; the X closes it for that repo for good. */
function HistoryPrompt({
  repoRoot,
  showRepoName,
  touch,
  onOpen,
  onDismiss
}: {
  repoRoot: string
  showRepoName: boolean
  touch: boolean
  onOpen: (repoRoot: string) => void
  onDismiss: (repoRoot: string) => void
}): JSX.Element {
  return (
    <div
      className={`group relative mx-2 my-1 flex items-center gap-2 rounded-md border border-border bg-panel-raised hover:border-accent transition-colors ${
        touch ? 'min-h-11' : ''
      }`}
    >
      <button
        onClick={() => onOpen(repoRoot)}
        className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer"
      >
        <History className="icon-sm shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-fg-bright truncate">
            Install history tracking
          </span>
          {showRepoName && (
            <span className="block text-xs text-faint truncate">{repoLabelFor(repoRoot)}</span>
          )}
        </span>
      </button>
      <Tooltip label="Don’t ask for this repo">
        <button
          onClick={() => onDismiss(repoRoot)}
          className="shrink-0 mr-1.5 p-1 rounded text-faint hover:text-fg hover:bg-panel cursor-pointer"
          aria-label="Dismiss history tracking prompt"
        >
          <X className="icon-xs" />
        </button>
      </Tooltip>
    </div>
  )
}

export function WorktreeList({
  model,
  variant,
  activeWorktreeId,
  activeTabId,
  snoozeDefaultDays,
  agentCount,
  editingAliasPath,
  onStartAliasEdit,
  onEndAliasEdit,
  onSelectWorktree,
  pathBackendId,
  originByPath,
  onSelectTab,
  onCloseTab,
  onToggleGroup,
  onTogglePinnedOpen,
  onNewWorktree,
  onDismissPendingWorktree,
  onContinueWorktree,
  onDeleteWorktree,
  onPruneWorktrees,
  onRemoveRepo,
  onOpenGraph,
  onOpenAssignedPR,
  historyPromptRepos,
  onOpenHistoryTracking,
  onDismissHistoryPrompt
}: WorktreeListProps): JSX.Element {
  const backend = useBackend()
  const touch = variant === 'touch'
  // Read once for the whole list rather than per row — N rows each holding
  // their own store subscription is CLAUDE.md anti-pattern #4.
  const settings = useSettings()
  const density = settings.sidebarDensity
  const detailPrefs = settings.sidebarDetails[density]
  const tabsExpansion = settings.sidebarTabsExpansion
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

  const buildRowActionHandlers = useCallback(
    (row: WorktreeRowModel): WorktreeRowActionHandlers => {
      const { worktree, deleting } = row
      const locked = worktree.isMain || deleting
      return {
        onContinue: locked || !onContinueWorktree ? undefined : () => beginContinue(worktree.path, worktree.branch),
        onSnooze: locked ? undefined : (e?: ReactMouseEvent) => onSnoozeRow(worktree.path, e),
        onUnsnooze: locked ? undefined : () => void backend.unsnooze(worktree.path),
        // The main worktree is its project's row, already fixed at the top,
        // so pinning it would do nothing — but a pin set before that stays
        // clearable rather than stranded.
        onTogglePin: deleting || (worktree.isMain && !row.isPinned)
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

  // Cached per row object so WorktreeTab's memo holds: rows are
  // reference-stable across renders until their data changes, and the
  // cache resets whenever a handler it closes over does.
  const rowActionsCache = useMemo(
    () => new WeakMap<WorktreeRowModel, WorktreeRowActionHandlers>(),
    [buildRowActionHandlers]
  )
  const rowActionsFor = (row: WorktreeRowModel): WorktreeRowActionHandlers => {
    let actions = rowActionsCache.get(row)
    if (!actions) {
      actions = buildRowActionHandlers(row)
      rowActionsCache.set(row, actions)
    }
    return actions
  }

  const showTabsFor = (row: WorktreeRowModel): boolean =>
    !!onSelectTab &&
    !row.deleting &&
    // Project rows follow the same rule, and show their tabs even while the
    // project is collapsed: collapsing hides the worktrees, not main.
    (tabsExpansion === 'all' || (tabsExpansion === 'selected' && row.path === activeWorktreeId))

  const renderTabRows = (row: WorktreeRowModel): JSX.Element | null =>
    showTabsFor(row) && onSelectTab ? (
      <WorktreeTabRows
        worktreePath={row.path}
        backendId={pathBackendId?.[row.path] ?? null}
        activeTabId={row.path === activeWorktreeId ? (activeTabId ?? null) : null}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
      />
    ) : null

  const renderTab = (row: WorktreeRowModel, project?: ProjectRowProps): JSX.Element => (
    <WorktreeTab
      project={project}
      row={row}
      variant={variant}
      isActive={row.path === activeWorktreeId}
      metaHeld={metaHeld}
      density={density}
      detailPrefs={detailPrefs}
      isEditingAlias={editingAliasPath === row.path}
      actions={rowActionsFor(row)}
      originLabel={originByPath?.[row.path]}
      onSelect={onSelectWorktree}
      onStartAliasEdit={onStartAliasEdit}
      onEndAliasEdit={onEndAliasEdit}
    />
  )

  const projectActions = (repoName: string, repoRoots: SectionRepoRoot[]): WorktreeRowAction[] =>
    buildProjectActions(repoName, repoRoots, {
      onNewWorktree: onNewWorktree ? () => onNewWorktree(repoRoots[0]?.repoRoot) : undefined,
      onRemove: onRemoveRepo,
      onOpenGraph
    })

  const renderRow = (row: WorktreeRowModel): JSX.Element => (
    <div key={row.path}>
      <RowBlock active={row.path === activeWorktreeId}>
        {renderTab(row)}
        {renderTabRows(row)}
      </RowBlock>
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
  )

  const renderPhantoms = (group: WorktreeListGroupModel): JSX.Element[] =>
    group.phantomPRs.map((pr) => (
      <AssignedPRRow
        key={`${pr.repoRoot}#${pr.number}`}
        pr={pr}
        variant={variant}
        showRepoLabel={model.showRepoLabels}
        repoLabel={repoLabelFor(pr.repoRoot)}
        onClick={onOpenAssignedPR ? () => onOpenAssignedPR(pr.repoRoot, pr.number) : undefined}
      />
    ))

  const renderGroup = (
    section: WorktreeRepoSectionModel,
    group: WorktreeListGroupModel
  ): JSX.Element => (
    <div key={group.key}>
      <GroupHeader
        label={group.label}
        count={group.count}
        collapsed={group.collapsed}
        touch={touch}
        onToggle={() => onToggleGroup(section.scope, group.key)}
      />
      {!group.collapsed && group.rows.map(renderRow)}
      {!group.collapsed && renderPhantoms(group)}
    </div>
  )

  // One fold for every archive group. Expanding flips each collapsed one
  // open; collapsing closes whichever are open — so the fold always lands
  // in a uniform state even if an older per-group toggle left them mixed.
  const renderTail = (section: WorktreeRepoSectionModel): JSX.Element | null => {
    const tail = section.tail
    if (!tail) return null
    return (
      <div className="mt-1">
        <GroupHeader
          label={tail.groups.map((g) => g.label).join(' · ')}
          count={tail.count}
          collapsed={tail.collapsed}
          touch={touch}
          onToggle={() => {
            for (const g of tail.groups) {
              if (g.collapsed === tail.collapsed) onToggleGroup(section.scope, g.key)
            }
          }}
        />
        {!tail.collapsed &&
          tail.groups.map((group) => (
            <div key={group.key}>
              {tail.groups.length > 1 && (
                <div className="px-3 pl-7 pt-1 text-xs text-faint">{group.label}</div>
              )}
              {group.rows.map(renderRow)}
              {renderPhantoms(group)}
            </div>
          ))}
      </div>
    )
  }

  const firstHome = model.sections.flatMap((s) => s.homes)[0]

  const reorderable = !touch && model.sections.length > 1 && !model.sections.some((s) => s.unified)
  const storedOrder = settings.sidebarProjectOrder
  const commitOrder = useCallback(
    (scopes: string[]) => {
      const current = model.sections.map((s) => s.scope)
      if (scopes.every((k, i) => k === current[i])) return
      void backend.setSidebarProjectOrder(mergeProjectOrder(storedOrder, scopes))
    },
    [model.sections, storedOrder, backend]
  )
  const drag = useProjectDrag(model.sections, commitOrder)
  const draggingSection = drag.activeScope
    ? model.sections.find((s) => s.scope === drag.activeScope)
    : undefined

  const moveSection = (scope: string, by: -1 | 1): void => {
    const scopes = model.sections.map((s) => s.scope)
    const from = scopes.indexOf(scope)
    const to = from + by
    if (from < 0 || to < 0 || to >= scopes.length) return
    scopes.splice(to, 0, ...scopes.splice(from, 1))
    commitOrder(scopes)
  }

  return (
    <>
      {agentCount === 0 && (firstHome || onNewWorktree) && (
        <div className="group relative mx-2 mb-2 mt-1 bg-panel-raised border border-border-strong rounded-lg overflow-hidden">
          <div className="brand-gradient-bg h-0.5" />
          <button
            onClick={() => (firstHome ? onSelectWorktree(firstHome.path) : onNewWorktree?.())}
            className="w-full text-left p-3 pb-2 cursor-pointer hover:bg-surface/40 transition-colors"
          >
            <div className="flex items-center gap-1.5 mb-1">
              <Sparkles className="icon-xs text-accent" />
              <span className="text-xs font-semibold uppercase tracking-wider text-accent">
                Get started
              </span>
            </div>
            <div className="text-sm font-semibold text-fg-bright leading-snug">
              Ask your project for what you want built
            </div>
            <div className="text-xs text-dim mt-0.5 leading-snug">
              Open the project, describe a task in its chat, and it spins up a worktree with an agent for it.
            </div>
          </button>
          {onNewWorktree && (
            <button
              onClick={() => onNewWorktree()}
              className="w-full flex items-center gap-1.5 px-3 pb-2.5 text-xs text-faint hover:text-fg transition-colors cursor-pointer"
            >
              <span>or start one yourself</span>
              {!touch && <HotkeyBadge action="newWorktree" />}
            </button>
          )}
        </div>
      )}
      {/* Unified mode has no per-project header to hang the nudge under, so
          offer one repo at a time at the top; closing it moves to the next. */}
      {model.sections.some((s) => s.unified) && historyPromptRepos?.[0] && onOpenHistoryTracking && onDismissHistoryPrompt && (
        <HistoryPrompt
          repoRoot={historyPromptRepos[0]}
          showRepoName
          touch={touch}
          onOpen={onOpenHistoryTracking}
          onDismiss={onDismissHistoryPrompt}
        />
      )}
      <DndContext
        sensors={drag.sensors}
        onDragStart={drag.onDragStart}
        onDragMove={drag.onDragMove}
        onDragEnd={drag.onDragEnd}
        onDragCancel={drag.onDragCancel}
      >
      {model.sections.map((section, i) => {
        // The model orders the section's own (primary-host) main first; it's
        // the project row. Other hosts' mains are ordinary rows under it.
        const home = section.unified ? undefined : section.homes[0]
        const otherHomes = section.unified ? [] : section.homes.slice(1)
        const promptRoot =
          !section.unified && !section.collapsed
            ? section.repoRoots.find((r) => historyPromptRepos?.includes(r.repoRoot))?.repoRoot
            : undefined
        // While a project is being dragged only its header shows, so a
        // tall project doesn't drag a screenful of rows around with it.
        const lifted = drag.activeScope === section.scope
        const showBody = !section.collapsed && !lifted
        return (
        <ProjectSection
          key={section.scope}
          scope={section.scope}
          name={section.repoName}
          className={i > 0 ? 'mt-3' : ''}
          draggable={reorderable}
          lifted={lifted}
          dropLine={drag.dropLine?.scope === section.scope ? drag.dropLine.edge : null}
          registerEl={drag.registerEl}
          focusable={!!home}
          onOpen={home ? () => onSelectWorktree(home.path) : undefined}
          onMove={(by) => moveSection(section.scope, by)}
          header={
          /* Every real project gets a row, even when it's the only one.
              Clicking it opens main, which opens the project: the project
              you're in is expanded, the rest collapse to this row unless
              pinned open. */
          !section.unified &&
            (home ? (
              <RowBlock active={home.path === activeWorktreeId} context={section.holdsActive}>
                {renderTab(home, {
                  name: section.repoName,
                  collapsed: section.collapsed,
                  count: section.count,
                  pinnedOpen: section.pinnedOpen,
                  collapsedStatus: section.collapsed ? section.worstStatus : undefined,
                  onTogglePinnedOpen: () => onTogglePinnedOpen(section.scope),
                  actions: projectActions(section.repoName, section.repoRoots)
                })}
                {renderTabRows(home)}
              </RowBlock>
            ) : (
              <RepoHeader
                section={section}
                variant={variant}
                onToggle={() => onTogglePinnedOpen(section.scope)}
                actions={projectActions(section.repoName, section.repoRoots)}
              />
            ))
          }
        >
          {/* Unified mode lists every project up top, then the shared groups. */}
          {section.unified && section.homes.length > 0 && (
            <div className="mb-2">
              {section.homes.map((h) => {
                const name = repoLabelFor(h.worktree.repoRoot)
                return (
                  <RowBlock
                    key={h.path}
                    active={h.path === activeWorktreeId}
                    context={h.worktree.repoRoot === model.activeRepoRoot}
                  >
                    {renderTab(h, {
                      name,
                      actions: projectActions(name, [
                        { backendId: pathBackendId?.[h.path] ?? null, repoRoot: h.worktree.repoRoot }
                      ])
                    })}
                    {renderTabRows(h)}
                  </RowBlock>
                )
              })}
            </div>
          )}
          {!lifted && promptRoot && onOpenHistoryTracking && onDismissHistoryPrompt && (
            <HistoryPrompt
              repoRoot={promptRoot}
              showRepoName={false}
              touch={touch}
              onOpen={onOpenHistoryTracking}
              onDismiss={onDismissHistoryPrompt}
            />
          )}
          {showBody && otherHomes.map(renderRow)}
          {showBody &&
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
          {showBody && section.workGroups.map((group) => renderGroup(section, group))}
          {showBody && renderTail(section)}
        </ProjectSection>
        )
      })}
      <DragOverlay dropAnimation={null}>
        {draggingSection && <ProjectDragPreview name={draggingSection.repoName} />}
      </DragOverlay>
      </DndContext>
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

/** A press on one of these inside a project header is that control's,
 *  not the start of a drag: the hover "+", the pin, the alias editor. */
const NON_DRAG_TARGETS = 'button, a, input, textarea, select, [contenteditable="true"], [data-no-drag]'

/** PointerSensor that leaves the header's own controls alone. The
 *  activation distance is what keeps a plain click a click (open the Lead,
 *  toggle a bare-repo header). */
class ProjectHeaderPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: ReactPointerEvent): boolean => {
        if (!nativeEvent.isPrimary || nativeEvent.button !== 0) return false
        const target = nativeEvent.target as Element | null
        return !target?.closest?.(NON_DRAG_TARGETS)
      }
    }
  ]
}

type DropEdge = 'before' | 'after'

/** Drag state for project reordering. Deliberately not a SortableContext:
 *  sections are wildly different heights (a collapsed project is one row,
 *  the open one can be a screenful), which makes sortable's shift-the-
 *  neighbours animation jumpy. Instead nothing moves until the drop, and a
 *  line marks where the project will land — computed from the live section
 *  rects, so the lifted project's body folding away mid-drag is fine. */
function useProjectDrag(
  sections: readonly WorktreeRepoSectionModel[],
  commit: (scopes: string[]) => void
): {
  sensors: ReturnType<typeof useSensors>
  activeScope: string | null
  dropLine: { scope: string; edge: DropEdge } | null
  registerEl: (scope: string, el: HTMLElement | null) => void
  onDragStart: (e: DragStartEvent) => void
  onDragMove: (e: DragMoveEvent) => void
  onDragEnd: (e: DragEndEvent) => void
  onDragCancel: () => void
} {
  const sensors = useSensors(
    useSensor(ProjectHeaderPointerSensor, { activationConstraint: { distance: 5 } })
  )
  const els = useRef(new Map<string, HTMLElement>())
  const [activeScope, setActiveScope] = useState<string | null>(null)
  // Scope the lifted project will be inserted before; null = the end.
  const [insertBefore, setInsertBefore] = useState<string | null | undefined>(undefined)

  const registerEl = useCallback((scope: string, el: HTMLElement | null) => {
    if (el) els.current.set(scope, el)
    else els.current.delete(scope)
  }, [])

  const others = (active: string): string[] =>
    sections.map((s) => s.scope).filter((k) => k !== active)

  const onDragMove = (e: DragMoveEvent): void => {
    const rect = e.active.rect.current.translated
    if (!rect) return
    const y = rect.top + rect.height / 2
    const active = String(e.active.id)
    // Before the first project whose middle is below the dragged header.
    let before: string | null = null
    for (const scope of others(active)) {
      const r = els.current.get(scope)?.getBoundingClientRect()
      if (r && r.top + r.height / 2 > y) {
        before = scope
        break
      }
    }
    setInsertBefore(before)
  }

  const reset = (): void => {
    setActiveScope(null)
    setInsertBefore(undefined)
  }

  const nextOrder = (active: string, before: string | null): string[] => {
    const rest = others(active)
    const at = before === null ? rest.length : rest.indexOf(before)
    rest.splice(at, 0, active)
    return rest
  }

  // Hide the line where dropping would change nothing.
  let dropLine: { scope: string; edge: DropEdge } | null = null
  if (activeScope && insertBefore !== undefined) {
    const proposed = nextOrder(activeScope, insertBefore)
    const unchanged = proposed.every((k, i) => k === sections[i]?.scope)
    if (!unchanged) {
      const rest = others(activeScope)
      dropLine =
        insertBefore === null
          ? { scope: rest[rest.length - 1], edge: 'after' }
          : { scope: insertBefore, edge: 'before' }
    }
  }

  return {
    sensors,
    activeScope,
    dropLine,
    registerEl,
    onDragStart: (e) => setActiveScope(String(e.active.id)),
    onDragMove,
    onDragEnd: (e) => {
      const active = String(e.active.id)
      if (insertBefore !== undefined) commit(nextOrder(active, insertBefore))
      reset()
    },
    onDragCancel: reset
  }
}

/** One project: its header row (the drag handle) and body. */
function ProjectSection({
  scope,
  name,
  className,
  draggable,
  lifted,
  dropLine,
  registerEl,
  focusable,
  onOpen,
  onMove,
  header,
  children
}: {
  scope: string
  name: string
  className: string
  draggable: boolean
  lifted: boolean
  dropLine: DropEdge | null
  registerEl: (scope: string, el: HTMLElement | null) => void
  /** Give the header its own tab stop. Off for bare-repo headers, which
   *  are already focusable buttons — their keys bubble up to here. */
  focusable: boolean
  onOpen?: () => void
  onMove: (by: -1 | 1) => void
  header: ReactNode
  children: ReactNode
}): JSX.Element {
  const { listeners, setNodeRef } = useDraggable({ id: scope, disabled: !draggable })
  const outerRef = useCallback((el: HTMLElement | null) => registerEl(scope, el), [registerEl, scope])
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if ((e.target as Element).closest?.('input, textarea')) return
    if (draggable && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      onMove(e.key === 'ArrowUp' ? -1 : 1)
      // Moving a keyed node can drop focus; put it back on the header.
      const el = document.activeElement as HTMLElement | null
      requestAnimationFrame(() => el?.focus())
      return
    }
    if (onOpen && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onOpen()
    }
  }
  return (
    <div ref={outerRef} className={`relative ${className}`}>
      {dropLine === 'before' && <DropLine className="-top-2" />}
      <div
        ref={setNodeRef}
        {...(draggable ? listeners : undefined)}
        onKeyDown={onKeyDown}
        tabIndex={focusable ? 0 : undefined}
        aria-label={focusable ? name : undefined}
        aria-roledescription={draggable ? 'reorderable project' : undefined}
        aria-keyshortcuts={draggable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        className={`outline-none rounded-md focus-visible:ring-1 focus-visible:ring-accent ${lifted ? 'opacity-40' : ''}`}
      >
        {header}
      </div>
      {children}
      {dropLine === 'after' && <DropLine className="-bottom-2" />}
    </div>
  )
}

function DropLine({ className }: { className: string }): JSX.Element {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute left-2 right-2 z-10 h-0.5 rounded-full bg-accent ${className}`}
    />
  )
}

/** What follows the pointer: the project's name, not its whole body. */
function ProjectDragPreview({ name }: { name: string }): JSX.Element {
  return (
    <div className="mx-1.5 flex min-h-14 cursor-grabbing items-center gap-2.5 rounded-md border border-border-strong bg-panel-raised px-2 py-2 shadow-lg">
      <RepoIcon repoName={name} className="text-2xl" />
      <span className="truncate text-base font-semibold text-fg-bright">{name}</span>
    </div>
  )
}

/** A row plus its tab rows, inset with rounded corners. The selected
 *  background covers the whole block as one pill rather than bleeding to
 *  the sidebar edges. Pending and assigned-PR rows use the same mx-1.5
 *  inset so every pill lines up. */
function RowBlock({
  active,
  context = false,
  children
}: {
  active: boolean
  /** A faint version of the selected pill: you're working inside this
   *  project (on one of its worktrees), just not on the row itself. */
  context?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`mx-1.5 rounded-md overflow-hidden ${active ? 'bg-surface' : context ? 'bg-surface/50' : ''}`}>
      {children}
    </div>
  )
}

/** Quiet by design: group headers organise the work, they shouldn't compete
 *  with it. Sentence case, faint, chevron only as strong as the label. */
function GroupHeader({
  label,
  count,
  collapsed,
  touch,
  onToggle
}: {
  label: string
  count: number
  collapsed: boolean
  touch: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-1 px-3 text-xs text-faint hover:text-fg transition-colors cursor-pointer ${
        touch ? 'min-h-11 py-2 sticky top-0 z-10 bg-app/95 backdrop-blur' : 'pt-2 pb-1'
      }`}
      title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
    >
      <Chevron collapsed={collapsed} />
      <span>{label}</span>
      <span className="ml-auto">{count}</span>
    </button>
  )
}

function Chevron({ collapsed }: { collapsed: boolean }): JSX.Element {
  return collapsed ? (
    <ChevronRight className="icon-xs shrink-0" />
  ) : (
    <ChevronDown className="icon-xs shrink-0" />
  )
}

/** Project header for a section with no main worktree in view (e.g. a
 *  bare repo). Clicking toggles collapse since there's no workspace to open. */
function RepoHeader({
  section,
  variant,
  onToggle,
  actions
}: {
  section: WorktreeRepoSectionModel
  variant: WorktreeListVariant
  onToggle: () => void
  actions: WorktreeRowAction[]
}): JSX.Element {
  const touch = variant === 'touch'
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuActions = actions.filter((a) => a.menuOnly)
  return (
    // A div, not a <button>, because it holds real buttons and those can't
    // nest — so it carries the button keyboard contract itself.
    <div
      onClick={onToggle}
      role="button"
      tabIndex={0}
      aria-expanded={!section.collapsed}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
      className={`group mx-1.5 flex items-center gap-2.5 rounded-md px-2 cursor-pointer outline-none hover:bg-panel-raised focus-visible:bg-surface ${
        touch ? 'min-h-14 py-2.5' : 'py-2'
      }`}
      title={section.repoRoots.map((r) => r.repoRoot).join('\n')}
      onContextMenu={
        touch || menuActions.length === 0
          ? undefined
          : (e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY })
            }
      }
    >
      <RepoIcon repoName={section.repoName} className="text-2xl" />
      <span className="truncate text-base font-semibold text-fg-bright">{section.repoName}</span>
      {section.collapsed && <span className="text-xs text-faint shrink-0">{section.count}</span>}
      {/* No hover on touch, and a bare-repo header has no action sheet to
          fold these into — they were unreachable there before too. */}
      {!touch && (
        <span className="ml-auto shrink-0 hidden group-hover:flex items-center gap-1.5">
          {actions.filter((a) => !a.menuOnly).map((a) => {
            const Icon = a.icon
            return (
              <Tooltip key={a.key} label={a.label}>
                <button
                  aria-label={a.label}
                  className={`text-faint cursor-pointer ${a.tone === 'danger' ? 'hover:text-danger' : 'hover:text-fg'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    a.onSelect(e)
                  }}
                >
                  <Icon className="icon-xs" />
                </button>
              </Tooltip>
            )
          })}
        </span>
      )}
      <span className="text-faint">
        <Chevron collapsed={section.collapsed} />
      </span>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuActions.map((a) => ({
            label: a.label,
            onClick: () => a.onSelect(),
            danger: a.tone === 'danger'
          }))}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** Project-level actions. "+" is last and quiet on purpose: most worktrees
 *  get started from the project's main chat, so the manual path is a
 *  fallback. */
function buildProjectActions(
  repoName: string,
  repoRoots: SectionRepoRoot[],
  handlers: {
    onNewWorktree?: () => void
    onRemove?: (roots: SectionRepoRoot[]) => Promise<void>
    onOpenGraph?: (repoRoot: string) => void
  }
): WorktreeRowAction[] {
  const { onNewWorktree, onRemove, onOpenGraph } = handlers
  const primary = repoRoots[0]?.repoRoot
  const out: WorktreeRowAction[] = []
  if (onOpenGraph && primary) {
    out.push({
      key: 'project-graph',
      label: 'Subscription graph',
      icon: Waypoints,
      menuOnly: true,
      onSelect: () => onOpenGraph(primary)
    })
  }
  if (onRemove && repoRoots.length > 0) {
    out.push({
      key: 'project-remove',
      label: 'Remove project from workspace',
      icon: X,
      tone: 'danger',
      menuOnly: true,
      onSelect: () => {
        if (
          window.confirm(
            // A merged section's members are matched by folder name, so the
            // one way to catch a wrong merge before detaching an unrelated
            // repo is to show exactly what will go.
            repoRoots.length > 1
              ? `Remove ${repoName} from all ${repoRoots.length} hosts in this window?\n\n${repoRoots
                  .map((r) => `• ${r.repoRoot}`)
                  .join('\n')}\n\nWorktrees stay on disk everywhere.`
              : `Remove ${repoName} from this window? Worktrees stay on disk.`
          )
        ) {
          void onRemove(repoRoots)
        }
      }
    })
  }
  if (onNewWorktree) {
    out.push({ key: 'project-new', label: 'New worktree', icon: Plus, hotkey: 'newWorktree', onSelect: onNewWorktree })
  }
  return out
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
      className={`group mx-1.5 rounded-md text-left px-2 flex items-center gap-2 transition-colors cursor-pointer ${
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
      className={`group mx-1.5 w-[calc(100%-0.75rem)] rounded-md text-left px-2 flex items-center gap-2 text-muted transition-colors ${
        touch ? 'min-h-11 py-3' : 'py-2'
      } ${onClick ? 'hover:bg-panel-raised hover:text-fg cursor-pointer' : 'cursor-default'}`}
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
