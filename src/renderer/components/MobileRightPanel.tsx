import { useCallback } from 'react'
import { useRepoConfigs, useSettings } from '../store'
import { useBackend } from '../backend'
import { PRStatusPanel } from './PRStatusPanel'
import { BranchCommitsPanel } from './BranchCommitsPanel'
import { CostPanel } from './CostPanel'
import type { Worktree, PRStatus } from '../types'

interface MobileRightPanelProps {
  activeWorktree: Worktree | null
  prStatuses: Record<string, PRStatus | null>
  prLoading: boolean
  onClose: () => void
}

// Fullscreen takeover that surfaces the useful slices of the desktop
// right panel — PR status, branch commits, cost. File
// panels (ChangedFiles / AllFiles) are intentionally omitted: their
// primary interaction is "tap a file to open a diff tab", and mobile
// can't render diff/file tabs meaningfully.
export function MobileRightPanel({
  activeWorktree,
  prStatuses,
  prLoading,
  onClose
}: MobileRightPanelProps): JSX.Element {
  const backend = useBackend()
  const repoConfigs = useRepoConfigs()
  const settings = useSettings()
  const hasGithubToken = settings.hasGithubToken || !!settings.githubAuthSource
  const activeRepoConfig = activeWorktree ? repoConfigs[activeWorktree.repoRoot] ?? null : null
  void activeRepoConfig

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
          <PRStatusPanel
            pr={prStatuses[activeWorktree.path] ?? null}
            worktree={activeWorktree}
            hasGithubToken={hasGithubToken}
            loading={prLoading}
            onRefresh={handleRefresh}
            onConnectGithub={onClose}
          />
          <BranchCommitsPanel worktreePath={activeWorktree.path} />
          <CostPanel worktreePath={activeWorktree.path} />
          <div className="px-4 py-3 text-xs text-dim">
            File diffs and commit review open only on desktop for now.
          </div>
        </>
      )}
    </div>
  )
}
