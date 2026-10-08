import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PanelRightOpen,
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  ClipboardCheck,
  Code2,
  FolderOpen,
  FolderSearch2,
  Loader2,
  Check,
  Pencil,
  GitCommitHorizontal,
  NotebookPen,
  RefreshCw,
  CircleX
} from 'lucide-react'
import { Tooltip } from './Tooltip'
import { CommitInfoModal } from './CommitInfoModal'
import { useActiveBackend, usePanes, usePrs, useRepoConfigs, useSettings, useWorktrees } from '../store'
import { useBackend } from '../backend'
import { useWatchedQuery } from '../hooks/useWatchedQuery'
import { requestChangedFiles } from '../hooks/changed-files-request'
import { useReviewProgress } from '../review-progress'
import { getLeaves } from '../../shared/state/terminals'
import { effectiveHiddenRightPanels } from '../../shared/state/repo-configs'
import type {
  BranchCommit,
  ChangedFile,
  GitHubMergeMethod,
  MergePRResult,
  MergeStrategy
} from '../types'

interface ChangedFilesData {
  working: ChangedFile[]
  branch: ChangedFile[]
}

interface CollapsedRightPanelProps {
  worktreePath: string | null
  onExpand: () => void
  onOpenPR: (url: string) => void
  onReview: () => void
  /** Opens the fuzzy file-open palette (same overlay as the Cmd+P
   *  fileQuickOpen hotkey). */
  onFileQuickOpen: () => void
  /** Opens one file's changes within a commit as a diff tab. */
  onOpenCommitFileDiff?: (commitHash: string, shortHash: string, filePath: string) => void
}

const WIDTH = 48

// 'fast-forward' has no GitHub equivalent — 'rebase' is the closest
// approximation (linear history but rewritten commit SHAs). Same mapping
// PRStatusPanel uses.
const STRATEGY_TO_METHOD: Record<MergeStrategy, GitHubMergeMethod> = {
  squash: 'squash',
  'merge-commit': 'merge',
  'fast-forward': 'rebase'
}

const METHOD_LABEL: Record<GitHubMergeMethod, string> = {
  squash: 'Squash',
  merge: 'Merge',
  rebase: 'Rebase'
}

export function CollapsedRightPanel({
  worktreePath,
  onExpand,
  onOpenPR,
  onReview,
  onFileQuickOpen,
  onOpenCommitFileDiff
}: CollapsedRightPanelProps): JSX.Element {
  const backend = useBackend()
  const activeBackend = useActiveBackend()
  const isLocal = activeBackend.kind === 'local'

  const worktrees = useWorktrees().list
  const prs = usePrs()
  const settings = useSettings()
  const repoConfigs = useRepoConfigs()

  const worktree = worktreePath ? worktrees.find((w) => w.path === worktreePath) ?? null : null
  const pr = worktreePath ? prs.byPath[worktreePath] ?? null : null
  const hasGithubToken = settings.hasGithubToken || !!settings.githubAuthSource

  // Counts for the badge buttons. Shared cacheKeys with ChangedFilesPanel
  // and BranchCommitsPanel so the expanded right column doesn't re-fetch
  // when the user toggles between collapsed and expanded.
  const changedFilesFetcher = useCallback(
    async (path: string, opts: { force: boolean }): Promise<ChangedFilesData> => {
      const [working, branch] = await Promise.all([
        requestChangedFiles(backend, path, 'working', opts),
        requestChangedFiles(backend, path, 'branch', opts)
      ])
      return { working, branch }
    },
    [backend]
  )
  const { data: changedFilesData, loading: changedFilesLoading, refresh: refreshChangedFiles } =
    useWatchedQuery<ChangedFilesData>({
      worktreePath,
      cacheKey: 'changedFiles',
      fetcher: changedFilesFetcher
    })
  const commitsFetcher = useCallback(
    (path: string) => backend.getBranchCommits(path),
    [backend]
  )
  const { data: commitsData, loading: commitsLoading, refresh: refreshCommits } =
    useWatchedQuery<BranchCommit[]>({
      worktreePath,
      cacheKey: 'branchCommits',
      fetcher: commitsFetcher
    })
  const changedFilesCount =
    (changedFilesData?.working.length ?? 0) + (changedFilesData?.branch.length ?? 0)

  // Find this worktree's review tab id (at most one — enforced by
  // PanesFSM.openReviewTab) so the badge can subtract reviewed files
  // from the to-review count as the user works through the list.
  const panes = usePanes()
  const reviewTabId = useMemo(() => {
    if (!worktreePath) return ''
    const tree = panes[worktreePath]
    if (!tree) return ''
    for (const leaf of getLeaves(tree)) {
      for (const tab of leaf.tabs) {
        if (tab.type === 'review') return tab.id
      }
    }
    return ''
  }, [panes, worktreePath])
  const reviewProgress = useReviewProgress(reviewTabId)
  // When a review tab exists, its progress is authoritative — both for
  // the total (which honors the user's commit-range pick) and for the
  // reviewed delta. Otherwise fall back to the raw branch file count.
  const reviewFilesCount = reviewProgress
    ? Math.max(0, reviewProgress.total - reviewProgress.reviewed)
    : changedFilesData?.branch.length ?? 0
  const commitsCount = commitsData?.length ?? 0
  const hasUnpushedCommits = !!commitsData?.some((c) => !c.pushed)

  // Commit-info popover opened from the commits button. Tracks the selected
  // commit by index so the popup's up/down controls can walk the list; x is
  // the strip's left edge (the popover flies out from there), y the button.
  const [commitPopover, setCommitPopover] = useState<{
    index: number
    x: number
    y: number
  } | null>(null)

  // Expand the right column AND uncollapse the named RightPanel section.
  // RightPanel listens for the CustomEvent and self-expands. Sections that
  // can be hidden per-repo via hiddenRightPanels (scratchpad) also need
  // un-hiding — that's a separate config write, handled by callers as needed.
  const expandSection = useCallback(
    (sectionId: string) => {
      onExpand()
      window.dispatchEvent(
        new CustomEvent('harness:expand-right-panel', { detail: { id: sectionId } })
      )
    },
    [onExpand]
  )

  const onOpenScratchpad = useCallback(() => {
    expandSection('scratchpad')
    if (!worktree) return
    const repoRoot = worktree.repoRoot
    const currentConfig = repoConfigs[repoRoot] ?? null
    const currentHidden = effectiveHiddenRightPanels(currentConfig)
    if (currentHidden.scratchpad === false) return
    void backend.setRepoConfig(repoRoot, {
      hiddenRightPanels: { ...currentHidden, scratchpad: false }
    })
  }, [expandSection, worktree, repoConfigs, backend])

  const handleRefreshAll = useCallback(() => {
    refreshChangedFiles()
    refreshCommits()
    if (worktreePath) void backend.refreshPRsOne(worktreePath)
  }, [refreshChangedFiles, refreshCommits, worktreePath, backend])
  const refreshing = changedFilesLoading || commitsLoading

  const strategy: MergeStrategy =
    (worktree && repoConfigs[worktree.repoRoot]?.mergeStrategy) || settings.mergeStrategy
  const method = STRATEGY_TO_METHOD[strategy]
  const methodLabel = METHOD_LABEL[method]

  // Merge button state — mirrors the 2-click confirm pattern in
  // PRStatusPanel. First click arms; second within 5s actually fires.
  const [confirming, setConfirming] = useState(false)
  const [merging, setMerging] = useState(false)
  const [justMerged, setJustMerged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const justMergedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      if (justMergedTimerRef.current) clearTimeout(justMergedTimerRef.current)
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    }
  }, [])

  // Reset confirm/just-merged when the PR identity or worktree changes.
  useEffect(() => {
    setConfirming(false)
    setJustMerged(false)
    setError(null)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
  }, [worktreePath, pr?.number, pr?.state])

  let mergeDisabledReason: string | null = null
  if (!pr) mergeDisabledReason = 'No PR to merge'
  else if (!hasGithubToken) mergeDisabledReason = 'Connect a GitHub token to merge'
  else if (pr.state === 'merged') mergeDisabledReason = 'Already merged'
  else if (pr.state === 'closed') mergeDisabledReason = 'PR is closed'
  else if (pr.state === 'draft') mergeDisabledReason = "Draft PRs can't be merged"
  else if (pr.hasConflict === true) mergeDisabledReason = 'There are merge conflicts'
  const canMerge = mergeDisabledReason === null && !merging && !justMerged

  const performMerge = useCallback(async () => {
    if (!worktreePath) return
    setConfirming(false)
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
    setMerging(true)
    setError(null)
    try {
      const result: MergePRResult = await backend.mergePR(worktreePath, method)
      if (result.ok) {
        setJustMerged(true)
        justMergedTimerRef.current = setTimeout(() => setJustMerged(false), 4000)
      } else {
        setError(result.error || 'Merge failed')
        errorTimerRef.current = setTimeout(() => setError(null), 6000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      errorTimerRef.current = setTimeout(() => setError(null), 6000)
    } finally {
      setMerging(false)
    }
  }, [worktreePath, method, backend])

  const onMergeClick = useCallback(() => {
    if (!canMerge) return
    if (confirming) {
      void performMerge()
      return
    }
    setError(null)
    setConfirming(true)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = setTimeout(() => {
      setConfirming(false)
      confirmTimerRef.current = null
    }, 5000)
  }, [canMerge, confirming, performMerge])

  // Mirror PRStatusPanel's merge-button color/state logic so the
  // collapsed-strip button reads the same as the expanded version:
  // conflict → danger tint, confirming → warning tint w/ border, normal →
  // success tint. Disabled-for-other-reasons stays neutral.
  const hasConflict = pr?.hasConflict === true
  let mergeTooltip: string
  let MergeIcon = GitMerge
  let mergeClasses: string
  if (merging) {
    mergeTooltip = `Merging via ${methodLabel}…`
    MergeIcon = Loader2
    mergeClasses = 'bg-success/20 hover:bg-success/30 text-success'
  } else if (justMerged) {
    mergeTooltip = 'Merged ✓'
    MergeIcon = Check
    mergeClasses = 'bg-success/20 hover:bg-success/30 text-success'
  } else if (error) {
    mergeTooltip = error
    mergeClasses = 'bg-danger/20 hover:bg-danger/20 text-danger'
  } else if (hasConflict) {
    mergeTooltip = 'There are merge conflicts'
    MergeIcon = GitMergeConflict
    mergeClasses = 'bg-danger/20 hover:bg-danger/20 text-danger'
  } else if (mergeDisabledReason) {
    mergeTooltip = mergeDisabledReason
    mergeClasses = 'text-dim hover:text-fg hover:bg-surface'
  } else if (confirming) {
    mergeTooltip = `Click again to merge via ${methodLabel}`
    mergeClasses = 'bg-warning/30 hover:bg-warning/40 text-warning border border-warning/50'
  } else {
    mergeTooltip = `Merge PR on GitHub (${methodLabel})`
    mergeClasses = 'bg-success/20 hover:bg-success/30 text-success'
  }

  const hasPR = !!pr
  const prUrl = pr?.url ?? null
  const failedChecksCount = pr?.checks.filter((c) => c.state === 'failure' || c.state === 'error').length ?? 0

  return (
    <>
    <div
      data-right-sidebar
      className="shrink-0 h-full flex flex-col bg-panel border-l border-border"
      style={{ width: WIDTH }}
    >
      <div className="no-drag flex flex-col items-center gap-1 py-3">
        <Tooltip label="Expand right sidebar" action="toggleRightColumn" side="left">
          <button
            onClick={onExpand}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
            aria-label="Expand right sidebar"
          >
            <PanelRightOpen className="icon-sm" />
          </button>
        </Tooltip>

        <div className="h-px w-6 bg-border my-1" />

        <Tooltip
          label={hasPR ? 'Open PR' : 'No PR to open'}
          action={hasPR ? 'openPR' : undefined}
          side="left"
        >
          <button
            onClick={() => prUrl && onOpenPR(prUrl)}
            disabled={!hasPR}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-dim"
            aria-label="Open PR in browser"
          >
            <GitPullRequest className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label={mergeTooltip} side="left">
          <button
            onClick={onMergeClick}
            disabled={!canMerge && !hasConflict}
            className={`${mergeClasses} rounded p-1.5 transition-colors cursor-pointer disabled:cursor-not-allowed ${
              hasConflict ? '' : 'disabled:opacity-40'
            }`}
            aria-label="Merge PR on GitHub"
          >
            <MergeIcon className={`icon-sm ${merging ? 'animate-spin' : ''}`} />
          </button>
        </Tooltip>
        {failedChecksCount > 0 && (
          <Tooltip
            label={`${failedChecksCount} failed check${failedChecksCount === 1 ? '' : 's'}`}
            side="left"
          >
            <button
              onClick={() => expandSection('pull-request')}
              className="text-danger hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5"
              aria-label={`${failedChecksCount} failed checks`}
            >
              <CircleX className="icon-xs" />
              <span className="text-xs tabular-nums leading-none">{failedChecksCount}</span>
            </button>
          </Tooltip>
        )}

        <div className="h-px w-6 bg-border my-1" />

        <Tooltip
          label={
            reviewFilesCount > 0
              ? `Review ${reviewFilesCount} file${reviewFilesCount === 1 ? '' : 's'}`
              : 'Review changes'
          }
          action="openReview"
          side="left"
        >
          <button
            onClick={onReview}
            className="bg-accent text-app hover:bg-accent/80 rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5"
            aria-label={
              reviewFilesCount > 0
                ? `Review ${reviewFilesCount} files`
                : 'Review changes'
            }
          >
            <ClipboardCheck className="icon-xs" />
            {reviewFilesCount > 0 && (
              <span className="text-[10px] tabular-nums leading-none">{reviewFilesCount}</span>
            )}
          </button>
        </Tooltip>

        <Tooltip
          label={`${changedFilesCount} changed file${changedFilesCount === 1 ? '' : 's'} (uncommitted + committed)`}
          side="left"
        >
          <button
            onClick={() => expandSection('changed-files')}
            className="text-dim hover:text-fg hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5"
            aria-label={`${changedFilesCount} changed files`}
          >
            <Pencil className="icon-xs" />
            <span className="text-xs tabular-nums leading-none">{changedFilesCount}</span>
          </button>
        </Tooltip>
        <Tooltip
          label={
            hasUnpushedCommits
              ? `${commitsCount} commit${commitsCount === 1 ? '' : 's'} (unpushed)`
              : `${commitsCount} commit${commitsCount === 1 ? '' : 's'}`
          }
          side="left"
        >
          <button
            onClick={(e) => {
              // Open the newest commit in the popup; fall back to expanding the
              // section when there are no commits to show.
              if (commitsCount === 0) {
                expandSection('commits')
                return
              }
              const sidebar = (e.currentTarget as HTMLElement).closest(
                '[data-right-sidebar]'
              ) as HTMLElement | null
              const x = sidebar ? sidebar.getBoundingClientRect().left : e.clientX
              setCommitPopover({ index: 0, x, y: e.clientY })
            }}
            className={`${hasUnpushedCommits ? 'text-warning' : 'text-dim'} hover:text-fg hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5`}
            aria-label={`${commitsCount} commits`}
          >
            <GitCommitHorizontal className="icon-xs" />
            <span className="text-xs tabular-nums leading-none">{commitsCount}</span>
          </button>
        </Tooltip>

        <div className="h-px w-6 bg-border my-1" />

        {worktreePath && (
          <Tooltip label="Open worktree in editor" action="openInEditor" side="left">
            <button
              onClick={() => backend.openInEditor(worktreePath)}
              className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
              aria-label="Open worktree in editor"
            >
              <Code2 className="icon-sm" />
            </button>
          </Tooltip>
        )}
        {worktreePath && isLocal && (
          <Tooltip label="Reveal in Finder" side="left">
            <button
              onClick={() => backend.openPath(worktreePath)}
              className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
              aria-label="Reveal worktree in Finder"
            >
              <FolderOpen className="icon-sm" />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Find file in worktree" action="fileQuickOpen" side="left">
          <button
            onClick={onFileQuickOpen}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
            aria-label="Find file in worktree"
          >
            <FolderSearch2 className="icon-sm" />
          </button>
        </Tooltip>

        <div className="h-px w-6 bg-border my-1" />

        <Tooltip label="Open Scratchpad" side="left">
          <button
            onClick={onOpenScratchpad}
            disabled={!worktree}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-dim"
            aria-label="Open Scratchpad"
          >
            <NotebookPen className="icon-sm" />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1" />

      <div className="no-drag flex flex-col items-center gap-1 py-3">
        <Tooltip label="Refresh commits, changed files, and PR info" side="left">
          <button
            onClick={handleRefreshAll}
            disabled={!worktreePath}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Refresh PR, commits, and changed files"
          >
            <RefreshCw className={`icon-sm ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </Tooltip>
      </div>
    </div>
    {commitPopover && worktreePath && commitsData?.[commitPopover.index] && (
      <CommitInfoModal
        worktreePath={worktreePath}
        sha={commitsData[commitPopover.index].hash}
        anchor={{ x: commitPopover.x, y: commitPopover.y }}
        placement="right-edge"
        nav={{
          onPrev: () =>
            setCommitPopover((p) => (p && p.index > 0 ? { ...p, index: p.index - 1 } : p)),
          onNext: () =>
            setCommitPopover((p) =>
              p && p.index < commitsCount - 1 ? { ...p, index: p.index + 1 } : p
            ),
          hasPrev: commitPopover.index > 0,
          hasNext: commitPopover.index < commitsCount - 1
        }}
        onOpenFileDiff={
          onOpenCommitFileDiff
            ? (filePath) => {
                const c = commitsData[commitPopover.index]
                onOpenCommitFileDiff(c.hash, c.shortHash, filePath)
                setCommitPopover(null)
              }
            : undefined
        }
        onClose={() => setCommitPopover(null)}
      />
    )}
    </>
  )
}
