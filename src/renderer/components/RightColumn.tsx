import { memo, useCallback, useMemo } from 'react'
import type { PRStatus, Worktree, RepoConfig, ToolSpec } from '../types'
import {
  effectiveHiddenRightPanels,
  effectiveRightPanelOrder,
  isCustomToolPanelKey,
  toolPanelKey,
  type HiddenRightPanels,
  type RightPanelKey
} from '../../shared/state/repo-configs'
import { BUILD_CUSTOM_TOOL_BRANCH, BUILD_CUSTOM_TOOL_PROMPT } from '../../shared/tools'
import { useWatchedQuery } from '../hooks/useWatchedQuery'
import { CustomToolPanel } from './CustomToolPanel'
import { PRStatusPanel, MergeLocallyPanel } from './PRStatusPanel'
import { BranchCommitsPanel } from './BranchCommitsPanel'
import { ChangedFilesPanel } from './ChangedFilesPanel'
import { AllFilesPanel } from './AllFilesPanel'
import { CostPanel } from './CostPanel'
import { ContextPanel } from './ContextPanel'
import { JsonClaudeTodosPanel } from './JsonClaudeTodosPanel'
import { JsonClaudeAgentsPanel } from './JsonClaudeAgentsPanel'
import { SubscriptionsPanel } from './SubscriptionsPanel'
import { ScratchpadPanel } from './ScratchpadPanel'
import { RightColumnToolbar } from './RightColumnToolbar'
import { useBackend } from '../backend'

type ChangedFilesPanelProps = React.ComponentProps<typeof ChangedFilesPanel>
type AllFilesPanelProps = React.ComponentProps<typeof AllFilesPanel>

/** Everything a stack of right-column panels needs. Shared by the desktop
 *  RightColumn and the phone web client's MobileRightPanel, so both show
 *  the same panels in the repo's configured order. */
export interface RightPanelStackProps {
  activeWorktreeId: string | null
  activeRepoRoot: string | null
  /** Id of the currently focused tab in the active worktree's focused
   *  pane. Used by the Todos panel to look up the focused json-claude
   *  session; null when no worktree is active. */
  focusedTabId: string | null
  worktrees: Worktree[]
  prStatuses: Record<string, PRStatus | null>
  prLoading: boolean
  hasGithubToken: boolean
  activeRepoConfig: RepoConfig | null
  onRefreshPRs: () => void
  onOpenGithubSettings: () => void
  onMerged: () => void
  onRemoveWorktree: (path: string) => void
  /** The three openers below are desktop-only (diff/file tabs); the phone
   *  web client leaves them out and the panels hide or no-op them. */
  onOpenDiff?: ChangedFilesPanelProps['onOpenDiff']
  onOpenCommitFileDiff?: (commitHash: string, shortHash: string, filePath: string) => void
  onOpenFile?: AllFilesPanelProps['onOpenFile']
  onSendToAgent: (worktreePath: string, text: string) => void
  onOpenPR: (url: string) => void
  onOpenReview?: () => void
}

interface RightColumnProps extends RightPanelStackProps {
  width: number
  onCollapse: () => void
  /** Opens the new-worktree screen pre-filled with a branch name and the
   * custom-tool authoring contract as the kickoff prompt. */
  onBuildCustomTool: (branch: string, prompt: string) => void
}

/** Tools list, effective order/visibility and the repo-config writers for
 *  the active repo — the state both RightColumn's toolbar and the panel
 *  stack read. */
export function useRightPanelConfig(
  activeWorktreeId: string | null,
  activeRepoRoot: string | null,
  activeRepoConfig: RepoConfig | null
) {
  const backend = useBackend()
  const toolsFetcher = useCallback(
    (path: string) => backend.listTools(path),
    [backend]
  )
  const { data: toolsData } = useWatchedQuery<ToolSpec[]>({
    worktreePath: activeWorktreeId,
    cacheKey: 'tools',
    fetcher: toolsFetcher
  })
  const tools = useMemo(() => toolsData ?? [], [toolsData])
  const toolKeys = useMemo(() => tools.map((t) => toolPanelKey(t.id)), [tools])
  const toolLabels = useMemo(
    () => Object.fromEntries(tools.map((t) => [toolPanelKey(t.id), t.title])),
    [tools]
  )

  const hidden = effectiveHiddenRightPanels(activeRepoConfig)
  const order = effectiveRightPanelOrder(activeRepoConfig, toolKeys)

  const handleChangeHidden = (next: HiddenRightPanels): void => {
    if (!activeRepoRoot) return
    // Send the full hiddenRightPanels object; also null out legacy
    // fields so old values don't leak back in via effective migration.
    void backend.setRepoConfig(activeRepoRoot, {
      hiddenRightPanels: next,
      hideMergePanel: null,
      hidePrPanel: null
    } as unknown as Partial<RepoConfig>)
  }

  const handleChangeOrder = (next: RightPanelKey[]): void => {
    if (!activeRepoRoot) return
    void backend.setRepoConfig(activeRepoRoot, {
      rightPanelOrder: next
    } as unknown as Partial<RepoConfig>)
  }

  return { tools, toolLabels, hidden, order, handleChangeHidden, handleChangeOrder }
}

/** Memoized so the sidebar's first-frame highlight render (see
 *  `sidebarActiveId` in App) can skip it; App keeps its props stable. */
export const RightColumn = memo(function RightColumn(props: RightColumnProps): JSX.Element {
  const { width, activeWorktreeId, activeRepoRoot, activeRepoConfig, onCollapse, onBuildCustomTool } = props
  const config = useRightPanelConfig(activeWorktreeId, activeRepoRoot, activeRepoConfig)
  return (
    <div
      data-right-sidebar
      className="shrink-0 h-full flex flex-col bg-panel"
      style={{ width }}
    >
      <RightColumnToolbar
        hidden={config.hidden}
        order={config.order}
        customLabels={config.toolLabels}
        onChangeHidden={config.handleChangeHidden}
        onChangeOrder={config.handleChangeOrder}
        onCollapse={onCollapse}
        onBuildCustomTool={() =>
          onBuildCustomTool(BUILD_CUSTOM_TOOL_BRANCH, BUILD_CUSTOM_TOOL_PROMPT)
        }
        canConfigure={!!activeRepoRoot}
      />
      <RightPanelStack {...props} config={config} />
    </div>
  )
})

/** The configured panels, in order, minus hidden ones. */
export function RightPanelStack({
  config,
  activeWorktreeId,
  focusedTabId,
  worktrees,
  prStatuses,
  prLoading,
  hasGithubToken,
  onRefreshPRs,
  onOpenGithubSettings,
  onMerged,
  onRemoveWorktree,
  onOpenDiff,
  onOpenCommitFileDiff,
  onOpenFile,
  onSendToAgent,
  onOpenPR,
  onOpenReview
}: RightPanelStackProps & { config: ReturnType<typeof useRightPanelConfig> }): JSX.Element {
  const { tools, hidden, order } = config
  const renderPanel = (key: RightPanelKey): JSX.Element | null => {
    if (hidden[key]) return null
    if (isCustomToolPanelKey(key)) {
      const spec = tools.find((t) => toolPanelKey(t.id) === key)
      if (!spec) return null
      return (
        <CustomToolPanel
          key={key}
          spec={spec}
          worktreePath={activeWorktreeId}
          onSendToAgent={
            activeWorktreeId ? (text) => onSendToAgent(activeWorktreeId, text) : undefined
          }
          onOpenFile={onOpenFile}
        />
      )
    }
    switch (key) {
      case 'merge':
        return (
          <MergeLocallyPanel
            key="merge"
            pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
            worktree={worktrees.find((w) => w.path === activeWorktreeId) || null}
            hasGithubToken={hasGithubToken}
            onMerged={onMerged}
            onRemoveWorktree={onRemoveWorktree}
          />
        )
      case 'pr':
        return (
          <PRStatusPanel
            key="pr"
            pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
            worktree={worktrees.find((w) => w.path === activeWorktreeId) || null}
            hasGithubToken={hasGithubToken}
            loading={prLoading}
            onRefresh={onRefreshPRs}
            onConnectGithub={onOpenGithubSettings}
            onOpenPR={onOpenPR}
          />
        )
      case 'todos':
        return <JsonClaudeTodosPanel key="todos" focusedTabId={focusedTabId} />
      case 'agents':
        return <JsonClaudeAgentsPanel key="agents" focusedTabId={focusedTabId} />
      case 'subscriptions':
        return (
          <SubscriptionsPanel
            key="subscriptions"
            worktreePath={activeWorktreeId}
            focusedTabId={focusedTabId}
          />
        )
      case 'commits':
        return (
          <BranchCommitsPanel
            key="commits"
            worktreePath={activeWorktreeId}
            onOpenCommitFileDiff={onOpenCommitFileDiff}
          />
        )
      case 'changedFiles':
        return (
          <ChangedFilesPanel
            key="changedFiles"
            worktreePath={activeWorktreeId}
            onOpenDiff={onOpenDiff}
            onSendToAgent={
              activeWorktreeId ? (text) => onSendToAgent(activeWorktreeId, text) : undefined
            }
            onOpenReview={onOpenReview}
          />
        )
      case 'allFiles':
        return (
          <AllFilesPanel
            key="allFiles"
            worktreePath={activeWorktreeId}
            onOpenFile={onOpenFile}
            onSendToAgent={
              activeWorktreeId ? (text) => onSendToAgent(activeWorktreeId, text) : undefined
            }
          />
        )
      case 'cost':
        return <CostPanel key="cost" worktreePath={activeWorktreeId} />
      case 'context':
        return <ContextPanel key="context" focusedTabId={focusedTabId} />
      case 'scratchpad':
        return <ScratchpadPanel key="scratchpad" worktreePath={activeWorktreeId} />
    }
  }

  return <>{order.map((key) => renderPanel(key))}</>
}
