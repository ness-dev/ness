import { useCallback } from 'react'
import { useRepoConfigs, useSettings } from '../store'
import { useBackend } from '../backend'
import { RightColumnToolbar } from './RightColumnToolbar'
import { RightPanelStack, useRightPanelConfig } from './RightColumn'
import { BUILD_CUSTOM_TOOL_BRANCH, BUILD_CUSTOM_TOOL_PROMPT } from '../../shared/tools'
import type { Worktree, PRStatus } from '../types'

interface MobileRightPanelProps {
  activeWorktree: Worktree | null
  worktrees: Worktree[]
  /** The tab the phone has selected — what the desktop calls the focused
   *  tab. Todos / Agents / Context / Subscriptions read its session. */
  focusedTabId: string | null
  prStatuses: Record<string, PRStatus | null>
  prLoading: boolean
  onSendToAgent: (worktreePath: string, text: string) => void
  /** Opens the new-worktree screen pre-filled, as the desktop does. */
  onBuildCustomTool: (branch: string, prompt: string) => void
  onClose: () => void
}

// Fullscreen takeover with the desktop's full right column: the same
// panels, in the repo's configured order, with the same visibility /
// reorder toolbar (RightPanelStack is shared with RightColumn). Openers
// that need a diff or file tab — which a phone can't show — are left out,
// so those rows don't open anything; everything else is identical.
export function MobileRightPanel({
  activeWorktree,
  worktrees,
  focusedTabId,
  prStatuses,
  prLoading,
  onSendToAgent,
  onBuildCustomTool,
  onClose
}: MobileRightPanelProps): JSX.Element {
  const backend = useBackend()
  const repoConfigs = useRepoConfigs()
  const settings = useSettings()
  const hasGithubToken = settings.hasGithubToken || !!settings.githubAuthSource
  const activeRepoRoot = activeWorktree?.repoRoot ?? null
  const activeRepoConfig = activeRepoRoot ? repoConfigs[activeRepoRoot] ?? null : null
  const config = useRightPanelConfig(activeWorktree?.path ?? null, activeRepoRoot, activeRepoConfig)

  const handleRefresh = useCallback(() => {
    void backend.refreshPRsAll()
  }, [backend])

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-app overflow-y-auto">
      {!activeWorktree && (
        <div className="p-6 text-center text-dim text-sm">
          Pick a worktree first.
        </div>
      )}
      {activeWorktree && (
        <>
          <RightColumnToolbar
            hidden={config.hidden}
            order={config.order}
            customLabels={config.toolLabels}
            onChangeHidden={config.handleChangeHidden}
            onChangeOrder={config.handleChangeOrder}
            onCollapse={onClose}
            onBuildCustomTool={() => onBuildCustomTool(BUILD_CUSTOM_TOOL_BRANCH, BUILD_CUSTOM_TOOL_PROMPT)}
            canConfigure={!!activeRepoRoot}
          />
          <RightPanelStack
            config={config}
            activeWorktreeId={activeWorktree.path}
            activeRepoRoot={activeRepoRoot}
            activeRepoConfig={activeRepoConfig}
            focusedTabId={focusedTabId}
            worktrees={worktrees}
            prStatuses={prStatuses}
            prLoading={prLoading}
            hasGithubToken={hasGithubToken}
            onRefreshPRs={handleRefresh}
            onOpenGithubSettings={onClose}
            onSendToAgent={onSendToAgent}
            onOpenPR={(url) => window.open(url, '_blank', 'noopener')}
          />
        </>
      )}
    </div>
  )
}
