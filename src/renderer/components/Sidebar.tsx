import { Trash2, Layers, ListTodo, Rows3, PanelLeftClose, RefreshCw } from 'lucide-react'
import { Tooltip } from './Tooltip'
import type { GroupKey } from '../../shared/worktree-sort'
import type { WorktreeListModel } from '../worktree-list-model'
import { WorktreeList } from './WorktreeList'
import { BackendChipStrip } from './BackendChipStrip'
import { BottomIconStrip } from './BottomIconStrip'

/** The desktop shell around the shared worktree list: fixed-width panel,
 *  header controls, backend chip strip and bottom icon strip. The list
 *  itself lives in WorktreeList so the touch picker renders the same tree —
 *  only this chrome is desktop-specific. */
interface SidebarProps {
  model: WorktreeListModel
  activeWorktreeId: string | null
  activeTabId: string | null
  snoozeDefaultDays?: number
  prLoading: boolean
  onOpenAssignedPR?: (repoRoot: string, prNumber: number) => void
  /** Non-main worktrees. Used to decide whether to show the "spawn your first agent" nudge. */
  agentCount: number
  onSelectWorktree: (path: string) => void
  pathBackendId?: Record<string, string>
  onSelectTab: (worktreePath: string, paneId: string, tabId: string) => void
  onDismissPendingWorktree: (id: string) => void
  onNewWorktree: (repoRoot?: string) => void
  onContinueWorktree: (worktreePath: string, newBranchName: string) => Promise<void>
  onDeleteWorktree: (path: string) => Promise<void>
  onPruneWorktrees: (repoRoot: string) => Promise<void>
  onRefresh: () => void
  repoCount: number
  onAddRepo: () => void
  onRemoveRepo: (repoRoot: string) => Promise<void>
  onOpenSettings: () => void
  onOpenAddBackend: () => void
  onOpenHotkeyCheatsheet: () => void
  onOpenActivity: () => void
  onOpenCleanup: () => void
  onOpenTaskList: () => void
  onOpenCommandCenter: () => void
  onOpenNewProject: () => void
  onOpenMyWeek: () => void
  width: number
  onToggleGroup: (scope: string, key: GroupKey) => void
  onToggleRepo: (repoRoot: string) => void
  unifiedRepos: boolean
  onToggleUnifiedRepos: () => void
  onCollapseSidebar: () => void
  editingAliasPath: string | null
  onStartAliasEdit: (path: string) => void
  onEndAliasEdit: () => void
}

export function Sidebar({
  model,
  activeWorktreeId,
  activeTabId,
  snoozeDefaultDays,
  prLoading,
  onOpenAssignedPR,
  agentCount,
  onSelectWorktree,
  pathBackendId,
  onSelectTab,
  onDismissPendingWorktree,
  onNewWorktree,
  onContinueWorktree,
  onDeleteWorktree,
  onPruneWorktrees,
  onRefresh,
  repoCount,
  onAddRepo,
  onRemoveRepo,
  onOpenSettings,
  onOpenAddBackend,
  onOpenHotkeyCheatsheet,
  onOpenActivity,
  onOpenCleanup,
  onOpenTaskList,
  onOpenCommandCenter,
  onOpenNewProject,
  onOpenMyWeek,
  width,
  onToggleGroup,
  onToggleRepo,
  unifiedRepos,
  onToggleUnifiedRepos,
  onCollapseSidebar,
  editingAliasPath,
  onStartAliasEdit,
  onEndAliasEdit
}: SidebarProps): JSX.Element {
  return (
    <div className="shrink-0 bg-panel flex flex-col h-full" style={{ width }}>
      {/* Worktrees header */}
      <div className="px-3 py-3 flex items-center gap-2 shrink-0">
        <Tooltip label="Collapse sidebar" action="toggleSidebar" side="bottom">
          <button
            onClick={onCollapseSidebar}
            className="text-dim hover:text-fg hover:bg-surface rounded p-0.5 transition-colors cursor-pointer"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose className="icon-xs" />
          </button>
        </Tooltip>
        <span className="text-xs font-medium text-dim">WORKTREES</span>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip label="Task list" action="toggleTaskList" side="bottom">
            <button
              onClick={onOpenTaskList}
              className="text-dim hover:text-fg hover:bg-surface rounded p-0.5 transition-colors cursor-pointer"
              aria-label="Task list"
            >
              <ListTodo className="icon-xs" />
            </button>
          </Tooltip>
          <Tooltip label="Clean up old worktrees" side="bottom">
            <button
              onClick={onOpenCleanup}
              className="text-dim hover:text-fg hover:bg-surface rounded p-0.5 transition-colors cursor-pointer"
            >
              <Trash2 className="icon-xs" />
            </button>
          </Tooltip>
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
              className="text-dim hover:text-fg hover:bg-surface rounded p-0.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-dim"
            >
              {unifiedRepos ? <Rows3 className="icon-xs" /> : <Layers className="icon-xs" />}
            </button>
          </Tooltip>
          <Tooltip label="Refresh worktrees" action="refreshWorktrees" side="bottom">
            <button
              onClick={onRefresh}
              className="text-dim hover:text-fg hover:bg-surface rounded p-0.5 transition-colors cursor-pointer"
            >
              <RefreshCw className={`icon-xs ${prLoading ? 'animate-spin' : ''}`} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        <WorktreeList
          model={model}
          variant="desktop"
          activeWorktreeId={activeWorktreeId}
          activeTabId={activeTabId}
          snoozeDefaultDays={snoozeDefaultDays}
          agentCount={agentCount}
          editingAliasPath={editingAliasPath}
          onStartAliasEdit={onStartAliasEdit}
          onEndAliasEdit={onEndAliasEdit}
          onSelectWorktree={onSelectWorktree}
          pathBackendId={pathBackendId}
          onSelectTab={onSelectTab}
          onToggleGroup={onToggleGroup}
          onToggleRepo={onToggleRepo}
          onNewWorktree={onNewWorktree}
          onDismissPendingWorktree={onDismissPendingWorktree}
          onContinueWorktree={onContinueWorktree}
          onDeleteWorktree={onDeleteWorktree}
          onPruneWorktrees={onPruneWorktrees}
          onRemoveRepo={onRemoveRepo}
          onOpenAssignedPR={onOpenAssignedPR}
        />
      </div>

      {/* Backend chip strip — multi-backend UX (Tier 1). Auto-hides
          when there's only one backend in the registry; renders one
          row of avatar+label chips above the bottom icon row when
          the user has added at least one remote. See plans/
          tier-1-multi-backend-ux.md §A. */}
      <BackendChipStrip onAddBackend={onOpenAddBackend} />

      {/* Bottom actions — overlay launchers (worktree-management buttons
          live in the WORKTREES header now). The strip adaptively hides
          trailing icons when the sidebar is too narrow to fit them all,
          and surfaces every icon via the hamburger menu regardless. */}
      <BottomIconStrip
        orientation="horizontal"
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
