import { useState, useEffect, useCallback, useRef } from 'react'
import { ExternalLink, GitMerge, GitMergeConflict, ChevronDown, Check, GitPullRequest, RefreshCw, Loader2, ArrowDown, CircleDot, CircleCheck, Bot } from 'lucide-react'
import { useCiNotify, useRepoConfigs, useSettings } from '../store'
import { isCiNotifyEnabled } from '../../shared/state/ci-notify'
import { useBackend } from '../backend'
import type {
  PRStatus,
  PRReview,
  CheckStatus,
  Worktree,
  MergeStrategy,
  MainWorktreeStatus,
  MergeConflictPreview,
  GitHubMergeMethod,
  MergePRResult
} from '../types'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'

/** Pick a one-line failure reason out of a check's GitHub `output.summary`,
 * which is often multi-line markdown. Grab the first non-empty, non-heading
 * line and cap it — good enough to tell "what broke" without the full log. */
function firstLine(summary: string | undefined): string {
  if (!summary) return ''
  for (const raw of summary.split('\n')) {
    const line = raw.trim().replace(/^#+\s*/, '').replace(/^[-*]\s+/, '')
    if (line) return line.length > 140 ? line.slice(0, 140) + '…' : line
  }
  return ''
}

const STRATEGY_BUTTON_LABELS: Record<MergeStrategy, string> = {
  squash: 'Squash and merge',
  'merge-commit': 'Create a merge commit',
  'fast-forward': 'Fast-forward merge'
}

const STRATEGY_MENU_LABELS: Record<MergeStrategy, string> = {
  squash: 'Squash and merge',
  'merge-commit': 'Create a merge commit',
  'fast-forward': 'Fast-forward merge'
}

/** How long after a worktree switch to wait before simulating the merge.
 * Long enough that scrubbing through worktrees fires none of them, short
 * enough that the conflict warning is there by the time anyone reads it. */
const CONFLICT_PREVIEW_DELAY_MS = 500

const STRATEGY_DESCRIPTIONS: Record<MergeStrategy, string> = {
  squash:
    'The commits from this branch will be combined into one commit on the base branch.',
  'merge-commit':
    'All commits from this branch will be added to the base branch via a merge commit.',
  'fast-forward':
    'Only merge if the base can fast-forward (--ff-only). Fails on divergent history.'
}

interface MergeLocallyPanelProps {
  pr: PRStatus | null | undefined
  worktree?: Worktree | null
  hasGithubToken?: boolean | null
  onMerged?: () => void | Promise<void>
  onRemoveWorktree?: (worktreePath: string) => void | Promise<void>
}

/** Renders the "Merge Locally" right-panel when it's applicable (no PR, not main branch,
 * GitHub connected). Returns null otherwise. */
export function MergeLocallyPanel({
  pr,
  worktree,
  hasGithubToken,
  onMerged,
  onRemoveWorktree
}: MergeLocallyPanelProps): JSX.Element | null {
  const needsGithubToken = hasGithubToken === false
  const show = !needsGithubToken && pr === null && worktree && !worktree.isMain
  if (!show || !worktree) return null
  return (
    <RightPanel id="merge-locally" title="Merge Locally">
      <MergeLocallyBody
        worktree={worktree}
        onMerged={onMerged}
        onRemoveWorktree={onRemoveWorktree}
      />
    </RightPanel>
  )
}

function MergeLocallyBody({
  worktree,
  onMerged,
  onRemoveWorktree
}: {
  worktree: Worktree
  onMerged?: () => void | Promise<void>
  onRemoveWorktree?: (worktreePath: string) => void | Promise<void>
}): JSX.Element {
  const backend = useBackend()
  const [mainStatus, setMainStatus] = useState<MainWorktreeStatus | null>(null)
  const [conflictPreview, setConflictPreview] = useState<MergeConflictPreview | null>(null)
  const [busy, setBusy] = useState<'idle' | 'checking' | 'fixing' | 'merging'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // The in-flight (or settled) preview for the current worktree, so a merge
  // can wait on it rather than racing the deferral below.
  const previewRef = useRef<Promise<MergeConflictPreview | null> | null>(null)

  // Effective merge strategy = repo override → global default. Both come
  // from the main-process store, so this re-renders automatically when
  // either changes.
  const repoConfigs = useRepoConfigs()
  const globalStrategy = useSettings().mergeStrategy
  const strategy: MergeStrategy =
    repoConfigs[worktree.repoRoot]?.mergeStrategy || globalStrategy
  const strategyLoaded = true

  const { repoRoot, branch, path } = worktree

  const refreshStatus = useCallback(async () => {
    setBusy('checking')
    try {
      setMainStatus(await backend.getMainWorktreeStatus(repoRoot))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
    }
  }, [backend, repoRoot])

  useEffect(() => {
    setError(null)
    setSuccess(null)
    void refreshStatus()
  }, [path, refreshStatus])

  // The conflict preview is a real three-way merge simulation (`git merge-tree
  // --write-tree`) answering a question the user hasn't asked yet — it only
  // matters once they're looking at the merge button. Running it on the switch
  // itself put it on the click-to-populated path, so it waits for the switch to
  // settle instead, which also means a run of rapid switches fires none at all.
  useEffect(() => {
    setConflictPreview(null)
    previewRef.current = null
    let cancelled = false
    const timer = setTimeout(() => {
      const pending = backend
        .previewMergeConflicts(repoRoot, branch, path)
        .catch(() => null)
      previewRef.current = pending
      void pending.then((preview) => {
        if (!cancelled) setConflictPreview(preview)
      })
    }, CONFLICT_PREVIEW_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [backend, repoRoot, branch, path])

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const handlePickStrategy = useCallback((s: MergeStrategy) => {
    setMenuOpen(false)
    // Persist as new default — "last used wins". The store dispatch
    // re-renders us with the new strategy automatically.
    void backend.setMergeStrategy(s)
  }, [])

  const handleFix = useCallback(async () => {
    setError(null)
    setBusy('fixing')
    try {
      const status = await backend.prepareMainForMerge(repoRoot)
      setMainStatus(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
    }
  }, [backend, repoRoot])

  const handleMerge = useCallback(async () => {
    if (!mainStatus) return
    setError(null)
    setSuccess(null)
    setBusy('merging')
    try {
      // The preview is deferred, so on a fast click it may not have been
      // started yet. Settle it here rather than letting the deferral quietly
      // downgrade the conflict guard to "whatever had landed by click time".
      const preview = await (previewRef.current ??
        backend.previewMergeConflicts(repoRoot, branch, path).catch(() => null))
      if (preview?.hasConflict) {
        setConflictPreview(preview)
        setError('Resolve merge conflicts before merging.')
        return
      }
      // Persist strategy on use too, in case the user never opened the dropdown.
      void backend.setMergeStrategy(strategy)
      const result = await backend.mergeWorktreeLocally(repoRoot, branch, strategy, path)
      setSuccess(`Merged into ${result.baseBranch}`)
      if (onMerged) await onMerged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
    }
  }, [backend, mainStatus, strategy, repoRoot, branch, path, onMerged])

  const handleRemoveAfterMerge = useCallback(async () => {
    if (!onRemoveWorktree) return
    await onRemoveWorktree(worktree.path)
  }, [onRemoveWorktree, worktree.path])

  const ready = mainStatus?.ready === true
  const needsFix = mainStatus && !mainStatus.ready
  const hasConflict = conflictPreview?.hasConflict === true

  return (
    <div className="px-3 py-2 space-y-2">
        {!success && (
          <>
            <div className="text-xs text-faint">
              Merge <span className="text-fg font-mono">{worktree.branch}</span>
              {mainStatus && (
                <>
                  {' '}into{' '}
                  <span className="text-fg font-mono">{mainStatus.baseBranch}</span>
                </>
              )}
            </div>

            {/* GitHub-style split button */}
            <div className="relative" ref={menuRef}>
              <div className="flex">
                <button
                  onClick={handleMerge}
                  disabled={!ready || busy !== 'idle' || !strategyLoaded || hasConflict}
                  title={hasConflict ? 'Resolve merge conflicts before merging' : undefined}
                  className="flex-1 text-xs bg-accent/20 hover:bg-accent/30 text-fg-bright px-2 py-1.5 rounded-l flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer border-r border-accent/40"
                >
                  <GitMerge className="icon-xs" />
                  {busy === 'merging' ? 'Merging…' : STRATEGY_BUTTON_LABELS[strategy]}
                </button>
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  disabled={busy === 'merging'}
                  className="text-xs bg-accent/20 hover:bg-accent/30 text-fg-bright px-1.5 py-1.5 rounded-r flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  aria-label="Change merge strategy"
                  title="Change merge strategy"
                >
                  <ChevronDown className="icon-xs" />
                </button>
              </div>

              {menuOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-surface border border-border rounded shadow-lg overflow-hidden">
                  {(['squash', 'merge-commit', 'fast-forward'] as MergeStrategy[]).map(
                    (s) => {
                      const active = s === strategy
                      return (
                        <button
                          key={s}
                          onClick={() => handlePickStrategy(s)}
                          className={`w-full text-left px-2 py-1.5 flex items-start gap-1.5 hover:bg-panel-raised cursor-pointer ${
                            active ? 'bg-panel-raised' : ''
                          }`}
                        >
                          <Check
                            className={`icon-xs mt-0.5 shrink-0 ${
                              active ? 'text-accent' : 'opacity-0'
                            }`} />
                          <div className="min-w-0">
                            <div className="text-xs text-fg-bright">
                              {STRATEGY_MENU_LABELS[s]}
                            </div>
                            <div className="text-xs text-faint leading-snug">
                              {STRATEGY_DESCRIPTIONS[s]}
                            </div>
                          </div>
                        </button>
                      )
                    }
                  )}
                </div>
              )}
            </div>

            {hasConflict && conflictPreview && (
              <div className="text-xs text-danger leading-snug space-y-1">
                <div>
                  Merge conflict
                  {conflictPreview.files.length > 0 && (
                    <>
                      {' '}in{' '}
                      <span className="font-mono">
                        {conflictPreview.files.length === 1
                          ? conflictPreview.files[0]
                          : `${conflictPreview.files.length} files`}
                      </span>
                    </>
                  )}
                  . Resolve before merging.
                </div>
                {conflictPreview.files.length > 1 && (
                  <ul className="text-faint font-mono text-xs space-y-0.5 max-h-20 overflow-y-auto">
                    {conflictPreview.files.map((f) => (
                      <li key={f} className="truncate" style={{ direction: 'rtl', textAlign: 'left' }} title={f}>
                        <bdi>{f}</bdi>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {needsFix && (
              <div className="text-xs text-warning leading-snug space-y-1">
                <div>
                  Main worktree isn't ready:
                  {mainStatus.isDirty && ' has uncommitted changes'}
                  {!mainStatus.isOnBase && (
                    <>
                      {mainStatus.isDirty ? ' and' : ''} on{' '}
                      <span className="font-mono">
                        {mainStatus.currentBranch || 'detached HEAD'}
                      </span>
                      , not <span className="font-mono">{mainStatus.baseBranch}</span>
                    </>
                  )}
                  .
                </div>
                <button
                  onClick={handleFix}
                  disabled={busy !== 'idle'}
                  className="text-xs bg-panel-raised hover:bg-surface text-fg px-2 py-1 rounded disabled:opacity-50 cursor-pointer"
                >
                  {busy === 'fixing'
                    ? 'Fixing…'
                    : mainStatus.isDirty
                    ? `Stash & checkout ${mainStatus.baseBranch}`
                    : `Checkout ${mainStatus.baseBranch}`}
                </button>
              </div>
            )}

            {error && (
              <div className="text-xs text-danger leading-snug break-words">{error}</div>
            )}
          </>
        )}

        {success && (
          <div className="space-y-2">
            <div className="text-xs text-success">{success}</div>
            {onRemoveWorktree && (
              <button
                onClick={handleRemoveAfterMerge}
                className="w-full text-xs bg-panel-raised hover:bg-surface text-fg px-2 py-1.5 rounded cursor-pointer"
              >
                Remove worktree
              </button>
            )}
            <button
              onClick={() => {
                setSuccess(null)
                void refreshStatus()
              }}
              className="w-full text-xs text-faint hover:text-fg cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}
    </div>
  )
}

const STATE_LABELS: Record<string, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

const STATE_COLORS: Record<string, string> = {
  open: 'text-success',
  draft: 'text-warning',
  merged: 'text-accent',
  closed: 'text-danger'
}

const STATE_PILL_COLORS: Record<string, string> = {
  open: 'border-success text-success hover:bg-success/10',
  draft: 'border-warning text-warning hover:bg-warning/10',
  merged: 'border-accent text-accent hover:bg-accent/10',
  closed: 'border-danger text-danger hover:bg-danger/10'
}

/** Pick a readable foreground for a GitHub label background.
 *  GitHub uses the same algorithm — anything darker than mid-gray gets
 *  white text, anything lighter gets near-black. Falls back to white if
 *  the color string isn't 6-char hex. */
function labelTextColor(hex: string): string {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '#fff'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  // Relative luminance per WCAG (approximation good enough for label legibility).
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 140 ? '#1f2328' : '#ffffff'
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return 'th'
  switch (n % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

function formatEta(seconds: number): string {
  if (seconds < 60) return '<1m'
  if (seconds < 3600) return `~${Math.round(seconds / 60)}m`
  const hours = Math.floor(seconds / 3600)
  const mins = Math.round((seconds % 3600) / 60)
  return mins === 0 ? `~${hours}h` : `~${hours}h${mins}m`
}

function queueBadgeLabel(position: number, etaSeconds?: number): string {
  const eta = typeof etaSeconds === 'number' ? ` · ${formatEta(etaSeconds)}` : ''
  if (position <= 1) return `Queued${eta}`
  return `Queued (${position}${ordinalSuffix(position)}${eta})`
}

/** Decide which milestone affordance the PR pane should render:
 *   - 'hidden'      → repo has no milestones at all; no slot at all
 *   - 'pill'        → render the milestone name as a clickable pill
 *   - 'placeholder' → render the muted "No milestone" placeholder
 *
 * hasMilestones === undefined is treated as "we don't know yet" so we
 * keep showing the slot — older cached state pre-dates the field. */
export type MilestoneDisplay = 'hidden' | 'pill' | 'placeholder'
export function milestoneDisplay(
  pr: Pick<PRStatus, 'hasMilestones' | 'milestone'>
): MilestoneDisplay {
  if (pr.hasMilestones === false) return 'hidden'
  return pr.milestone ? 'pill' : 'placeholder'
}

const CHECK_ICONS: Record<CheckStatus['state'], { symbol: string; color: string }> = {
  success: { symbol: '\u2713', color: 'text-success' },
  failure: { symbol: '\u2717', color: 'text-danger' },
  error: { symbol: '!', color: 'text-danger' },
  pending: { symbol: '\u25CB', color: 'text-warning' },
  neutral: { symbol: '-', color: 'text-dim' },
  skipped: { symbol: '-', color: 'text-dim' }
}

const OVERALL_COLORS: Record<string, string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim'
}

// Failed/error checks are what the user has to act on, so they go first.
// Then pending (in progress), then success, then non-actionable
// neutral/skipped. Within each group, sort by startedAt ascending so the
// order matches the actual run order on CI.
const CHECK_STATE_PRIORITY: Record<CheckStatus['state'], number> = {
  failure: 0,
  error: 0,
  pending: 1,
  success: 2,
  neutral: 3,
  skipped: 4
}

function sortChecksForDisplay(checks: CheckStatus[]): CheckStatus[] {
  return [...checks].sort((a, b) => {
    const pa = CHECK_STATE_PRIORITY[a.state]
    const pb = CHECK_STATE_PRIORITY[b.state]
    if (pa !== pb) return pa - pb
    const ta = a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY
    const tb = b.startedAt ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY
    if (ta !== tb) return ta - tb
    return a.name.localeCompare(b.name)
  })
}

const REVIEW_DECISION_LABELS: Record<PRStatus['reviewDecision'], { text: string; color: string }> = {
  approved: { text: 'Approved', color: 'text-success' },
  changes_requested: { text: 'Changes requested', color: 'text-warning' },
  review_required: { text: 'Review pending', color: 'text-faint' },
  none: { text: '', color: '' }
}

const REVIEW_STATE_ICONS: Record<PRReview['state'], { symbol: string; color: string }> = {
  APPROVED: { symbol: '\u2713', color: 'text-success' },
  CHANGES_REQUESTED: { symbol: '\u25CF', color: 'text-warning' },
  COMMENTED: { symbol: '\u25CB', color: 'text-faint' },
  DISMISSED: { symbol: '-', color: 'text-dim' },
  PENDING: { symbol: '\u25CB', color: 'text-dim' }
}

function ReviewSummary({
  reviews,
  decision
}: {
  reviews: PRReview[]
  decision: PRStatus['reviewDecision']
}): JSX.Element {
  const backend = useBackend()
  const [expanded, setExpanded] = useState(false)
  const label = REVIEW_DECISION_LABELS[decision]

  // Dedupe to latest review per user for the summary row
  const latestByUser = new Map<string, PRReview>()
  for (const r of reviews) {
    latestByUser.set(r.user, r)
  }
  const uniqueReviewers = [...latestByUser.values()]

  return (
    <div className="mb-1">
      <div
        className="flex items-center gap-1.5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`text-xs ${label.color}`}>{label.text}</span>
        <span className="text-xs text-faint">
          ({uniqueReviewers.length} {uniqueReviewers.length === 1 ? 'reviewer' : 'reviewers'})
          {expanded ? '\u25B4' : '\u25BE'}
        </span>
      </div>
      {expanded && (
        <div className="space-y-0.5 mt-1">
          {uniqueReviewers.map((review) => {
            const icon = REVIEW_STATE_ICONS[review.state]
            return (
              <div
                key={review.user}
                className="flex items-center gap-1.5 text-xs py-0.5 cursor-pointer hover:bg-panel-raised px-1 -mx-1 rounded group"
                onClick={() => backend.openExternal(review.htmlUrl)}
                title={`${review.user}: ${review.state.toLowerCase().replace('_', ' ')}`}
              >
                <img
                  src={review.avatarUrl}
                  alt={review.user}
                  className="w-4 h-4 rounded-full shrink-0"
                />
                <span className="text-muted truncate">{review.user}</span>
                <span className={`shrink-0 ${icon.color}`}>{icon.symbol}</span>
                <ExternalLink
                  className="icon-2xs shrink-0 text-faint opacity-0 group-hover:opacity-100 transition-opacity ml-auto" />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 'fast-forward' has no GitHub equivalent — 'rebase' is the closest
// approximation but produces different history (linear, but rewritten
// commits with new SHAs). Tooltip below calls this out.
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

interface PRMergeAction {
  button: JSX.Element | null
  errorRow: JSX.Element | null
}

function usePRMergeAction(
  pr: PRStatus | null | undefined,
  worktree: Worktree | null | undefined,
  needsGithubToken: boolean
): PRMergeAction {
  const backend = useBackend()
  const repoConfigs = useRepoConfigs()
  const globalStrategy = useSettings().mergeStrategy
  const strategy: MergeStrategy = worktree
    ? repoConfigs[worktree.repoRoot]?.mergeStrategy || globalStrategy
    : globalStrategy
  const method = STRATEGY_TO_METHOD[strategy]
  const methodLabel = METHOD_LABEL[method]

  const [confirming, setConfirming] = useState(false)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justMerged, setJustMerged] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  // Reset confirm flag if the PR identity changes underneath us.
  useEffect(() => {
    setConfirming(false)
    setError(null)
    setJustMerged(false)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
  }, [pr?.number, pr?.state])

  const performMerge = useCallback(async () => {
    if (!worktree) return
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
    setConfirming(false)
    setMerging(true)
    setError(null)
    try {
      const result: MergePRResult = await backend.mergePR(worktree.path, method)
      if (result.ok) {
        setJustMerged(true)
      } else {
        setError(result.error || 'Merge failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMerging(false)
    }
  }, [worktree, method, backend])

  if (!pr) return { button: null, errorRow: null }

  const isTerminal = pr.state === 'merged' || pr.state === 'closed'

  let disabledReason: string | null = null
  if (needsGithubToken) disabledReason = 'Connect GitHub token to merge'
  else if (!worktree) disabledReason = 'No active worktree'
  else if (pr.state === 'merged') disabledReason = 'Already merged'
  else if (pr.state === 'closed') disabledReason = 'PR is closed'
  else if (pr.state === 'draft') disabledReason = "Draft PRs can't be merged"
  else if (pr.hasConflict === true) disabledReason = 'There are merge conflicts'
  const canMerge = disabledReason === null && !merging

  const startConfirm = (): void => {
    setError(null)
    setConfirming(true)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = setTimeout(() => {
      setConfirming(false)
      confirmTimerRef.current = null
    }, 5000)
  }

  const onMergeClick = (): void => {
    if (!canMerge) return
    if (confirming) {
      void performMerge()
    } else {
      startConfirm()
    }
  }

  let mergeLabel: string
  if (merging) mergeLabel = 'Merging…'
  else if (justMerged) mergeLabel = 'Merged'
  else if (confirming) mergeLabel = `Confirm merge into ${pr.baseBranch}`
  else mergeLabel = methodLabel

  const showMergeButton = !isTerminal && !pr.queuePosition

  let mergeTooltip: string
  if (disabledReason) mergeTooltip = disabledReason
  else if (confirming) mergeTooltip = 'Click again to confirm'
  else mergeTooltip = 'Merge the pull request'

  const button = showMergeButton ? (
    <Tooltip label={mergeTooltip}>
      <button
        onClick={onMergeClick}
        disabled={!canMerge || justMerged}
        className={`px-2 py-1 text-xs rounded transition-colors cursor-pointer flex items-center gap-1.5 disabled:cursor-not-allowed ${
          pr.hasConflict === true ? '' : 'disabled:opacity-40'
        } ${
          pr.hasConflict === true
            ? 'bg-danger/20 hover:bg-danger/20 text-danger'
            : confirming
              ? 'bg-warning/30 hover:bg-warning/40 text-warning border border-warning/50'
              : 'bg-success/20 hover:bg-success/30 text-success'
        }`}
      >
        {merging ? (
          <Loader2 className="icon-xs animate-spin" />
        ) : justMerged ? (
          <Check className="icon-xs" />
        ) : pr.hasConflict === true ? (
          <GitMergeConflict className="icon-xs" />
        ) : (
          <GitMerge className="icon-xs" />
        )}
        {mergeLabel}
      </button>
    </Tooltip>
  ) : null

  const errorRow = error ? (
    <div className="px-3 pt-2 text-xs text-danger leading-snug break-words flex items-center gap-2">
      <span className="flex-1">{error}</span>
      <button
        onClick={() => {
          setError(null)
          void performMerge()
        }}
        className="px-2 py-0.5 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer shrink-0"
      >
        Retry
      </button>
    </div>
  ) : null

  return { button, errorRow }
}

interface PRApproveAction {
  button: JSX.Element | null
  errorRow: JSX.Element | null
}

/** "Request AI review": opens a reviewer Chat tab for this worktree's
 *  author tab, the same path request_review and the CI-green spawner
 *  take. Shown whether or not the branch has a PR — the reviewer reads
 *  the branch diff, not GitHub. */
function useAiReviewAction(worktree: Worktree | null | undefined): {
  row: JSX.Element | null
} {
  const backend = useBackend()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    setBusy(false)
    setError(null)
    setDone(false)
  }, [worktree?.path])

  const request = useCallback(async () => {
    if (!worktree) return
    setBusy(true)
    setError(null)
    try {
      const result = await backend.requestAiReview(worktree.path)
      if (result.ok) setDone(true)
      else setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [worktree, backend])

  if (!worktree) return { row: null }

  const row = (
    <div className="px-3 pb-2 pt-1 space-y-1.5">
      <Tooltip label="Open an agent that reviews this branch and sends its review to your Chat tab">
        <button
          onClick={() => void request()}
          disabled={busy || done}
          className="w-full text-xs px-2 py-1.5 rounded flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 bg-accent/20 hover:bg-accent/30 text-accent"
        >
          {busy ? (
            <Loader2 className="icon-xs animate-spin" />
          ) : done ? (
            <Check className="icon-xs" />
          ) : (
            <Bot className="icon-xs" />
          )}
          {done ? 'Reviewer opened' : 'Request AI review'}
        </button>
      </Tooltip>
      {error && <div className="text-xs text-danger leading-snug">{error}</div>}
    </div>
  )
  return { row }
}

/** Approve-button visibility heuristic — mirrors github.com's "Approve"
 *  affordance on the Files/Review tab. The button shows only when the
 *  viewer is plausibly a reviewer of someone else's PR: not the author,
 *  hasn't already approved, and either the PR is still waiting for a
 *  first review or the viewer's latest review was CHANGES_REQUESTED
 *  (so they can flip to APPROVE). Returns null otherwise. */
function usePRApproveAction(
  pr: PRStatus | null | undefined,
  worktree: Worktree | null | undefined,
  viewerLogin: string | null,
  needsGithubToken: boolean
): PRApproveAction {
  const backend = useBackend()
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justApproved, setJustApproved] = useState(false)

  useEffect(() => {
    setApproving(false)
    setError(null)
    setJustApproved(false)
  }, [pr?.number])

  const performApprove = useCallback(async () => {
    if (!worktree) return
    setApproving(true)
    setError(null)
    try {
      const result = await backend.approvePR(worktree.path)
      if (result.ok) setJustApproved(true)
      else setError(result.error || 'Approval failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApproving(false)
    }
  }, [worktree, backend])

  if (!pr || !worktree || needsGithubToken) return { button: null, errorRow: null }
  if (pr.state !== 'open') return { button: null, errorRow: null }
  if (!viewerLogin) return { button: null, errorRow: null }
  if (pr.author?.login === viewerLogin) return { button: null, errorRow: null }

  let viewerLatest: PRReview | null = null
  for (const r of pr.reviews) {
    if (r.user !== viewerLogin) continue
    if (!viewerLatest || r.submittedAt > viewerLatest.submittedAt) viewerLatest = r
  }
  if (viewerLatest?.state === 'APPROVED') return { button: null, errorRow: null }

  const showApprove =
    pr.reviewDecision === 'review_required' ||
    viewerLatest?.state === 'CHANGES_REQUESTED'
  if (!showApprove) return { button: null, errorRow: null }

  const button = (
    <Tooltip label={justApproved ? 'Approved' : 'Approve this pull request'}>
      <button
        onClick={() => void performApprove()}
        disabled={approving || justApproved}
        aria-label="Approve pull request"
        className="px-2 py-1 text-xs rounded transition-colors cursor-pointer flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-40 bg-success/20 hover:bg-success/30 text-success"
      >
        {approving ? (
          <Loader2 className="icon-xs animate-spin" />
        ) : (
          <Check className="icon-xs" />
        )}
        {justApproved ? 'Approved' : 'Approve'}
      </button>
    </Tooltip>
  )

  const errorRow = error ? (
    <div className="px-3 pt-2 text-xs text-danger leading-snug break-words flex items-center gap-2">
      <span className="flex-1">{error}</span>
      <button
        onClick={() => {
          setError(null)
          void performApprove()
        }}
        className="px-2 py-0.5 text-xs rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer shrink-0"
      >
        Retry
      </button>
    </div>
  ) : null

  return { button, errorRow }
}

interface PRStatusPanelProps {
  pr: PRStatus | null | undefined
  worktree?: Worktree | null
  hasGithubToken?: boolean | null
  loading?: boolean
  onRefresh?: () => void | Promise<void>
  onConnectGithub?: () => void
  /** Opens the PR itself. Omitted on mobile, which can't render browser
   *  tabs, so the URL goes straight to the OS there. */
  onOpenPR?: (url: string) => void
}

export function PRStatusPanel({
  pr,
  worktree,
  hasGithubToken,
  loading,
  onRefresh,
  onConnectGithub,
  onOpenPR
}: PRStatusPanelProps): JSX.Element {
  const backend = useBackend()
  const openPr = (url: string): void =>
    onOpenPR ? onOpenPR(url) : void backend.openExternal(url)
  const [expanded, setExpanded] = useState(false)

  // Auto-expand the check list whenever checks are failing so the user sees
  // which check broke without an extra click.
  useEffect(() => {
    if (pr?.checksOverall === 'failure') setExpanded(true)
  }, [pr?.checksOverall, pr?.number])

  const needsGithubToken = hasGithubToken === false

  const settings = useSettings()
  const ciNotify = useCiNotify()
  const mergeAction = usePRMergeAction(pr, worktree, needsGithubToken)
  const approveAction = usePRApproveAction(pr, worktree, settings.viewerLogin, needsGithubToken)
  const aiReview = useAiReviewAction(worktree)

  const refreshButton = !needsGithubToken && onRefresh ? (
    <Tooltip label="Refresh PR status" side="left">
      <button
        onClick={(e) => {
          e.stopPropagation()
          void onRefresh()
        }}
        disabled={loading}
        className="text-xs text-dim hover:text-fg flex items-center transition-colors cursor-pointer disabled:cursor-default"
        aria-label="Refresh PR status"
      >
        <RefreshCw className={`icon-xs ${loading ? 'animate-spin' : ''}`} />
      </button>
    </Tooltip>
  ) : null

  const actions = (approveAction.button || mergeAction.button || refreshButton) ? (
    <div className="flex items-center gap-2">
      {approveAction.button}
      {mergeAction.button}
      {refreshButton}
    </div>
  ) : null

  return (
    <RightPanel
      id="pull-request"
      title="Pull Request"
      actions={actions}
      containerClassName={needsGithubToken ? 'bg-info/10' : ''}
      headerClassName={needsGithubToken ? 'bg-info/25' : ''}
    >
      {needsGithubToken && (
        <div className="px-3 py-3 space-y-2">
          <div className="text-xs text-info/90 leading-snug">
            Connect a GitHub token to see PR status and open pull requests from Ness.
          </div>
          {onConnectGithub && (
            <button
              onClick={onConnectGithub}
              className="w-full text-xs bg-info/25 hover:bg-info/35 text-info px-2 py-1.5 rounded flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <GitPullRequest className="icon-xs" />
              Connect GitHub
            </button>
          )}
        </div>
      )}

      {!needsGithubToken && pr === null && (
        <div className="px-3 py-2 text-xs text-faint">No PR for this branch</div>
      )}

      {!needsGithubToken && pr !== undefined && aiReview.row}

      {!needsGithubToken && pr === undefined && (
        <div className="px-3 py-2 text-xs text-faint">Loading...</div>
      )}

      {mergeAction.errorRow}
      {approveAction.errorRow}

      {!needsGithubToken && pr && (
        <div className="px-3 py-2 space-y-2">
          {/* PR title row: #nnn pill + title */}
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              onClick={(e) => {
                e.stopPropagation()
                openPr(pr.url)
              }}
              className={`px-1.5 py-0.5 rounded border text-xs font-medium transition-colors cursor-pointer shrink-0 ${
                pr.queuePosition
                  ? 'border-accent text-accent hover:bg-accent/10'
                  : STATE_PILL_COLORS[pr.state]
              }`}
              aria-label="Open PR in browser"
              title={pr.queuePosition ? queueBadgeLabel(pr.queuePosition, pr.queueEstimatedSeconds) : STATE_LABELS[pr.state]}
            >
              #{pr.number}
            </button>
            <Tooltip label="Open PR in browser" action="openPR">
              <a
                className="flex-1 text-xs text-fg hover:text-fg-bright truncate cursor-pointer"
                onClick={() => openPr(pr.url)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', pr.url)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
              >
                {pr.title}
              </a>
            </Tooltip>
          </div>

          <div className="flex items-center gap-1.5 text-xs">
            {pr.assignees.length > 0 && (
              <div className="flex items-center shrink-0">
                {pr.assignees.map((a, i) => (
                  <img
                    key={a.login}
                    src={a.avatarUrl}
                    alt={a.login}
                    title={`Assigned to ${a.login}`}
                    className={`w-4 h-4 rounded-full border border-panel ${i > 0 ? '-ml-1' : ''}`}
                  />
                ))}
              </div>
            )}
            {pr.queuePosition && (
              <span className="font-medium shrink-0 text-accent">
                {queueBadgeLabel(pr.queuePosition, pr.queueEstimatedSeconds)}
              </span>
            )}
            {(() => {
              const display = milestoneDisplay(pr)
              if (display === 'hidden') return null
              if (display === 'pill' && pr.milestone) {
                return (
                  <a
                    onClick={(e) => {
                      e.stopPropagation()
                      backend.openExternal(pr.milestone!.url)
                    }}
                    className={`shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium cursor-pointer transition-colors truncate max-w-[140px] ${
                      pr.milestone.state === 'closed'
                        ? 'bg-surface text-dim hover:text-fg-bright'
                        : 'bg-accent/20 text-accent hover:bg-accent/30'
                    }`}
                    title={`Milestone: ${pr.milestone.title}`}
                  >
                    {pr.milestone.title}
                  </a>
                )
              }
              return (
                <span className="shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium bg-surface text-faint">
                  No milestone
                </span>
              )
            })()}
            <span
              className={`font-mono truncate shrink-0 ${pr.isDefaultBase ? 'text-dim' : 'text-warning'}`}
              title={pr.isDefaultBase ? `Target: ${pr.baseBranch}` : `Target: ${pr.baseBranch} (not the default branch)`}
            >
              {pr.baseBranch}
            </span>
            {pr.state !== 'merged' && typeof pr.behindBy === 'number' && pr.behindBy > 0 && (
              <span
                className="flex items-center gap-0.5 text-warning shrink-0"
                title={`${pr.behindBy} commit${pr.behindBy === 1 ? '' : 's'} behind ${pr.baseBranch}`}
              >
                <ArrowDown className="icon-xs" />
                {pr.behindBy}
              </span>
            )}
            {pr.state === 'merged' && (
              <span
                className={`font-mono truncate shrink-0 ${pr.firstReleaseTag ? 'text-accent' : 'text-faint italic'}`}
                title={pr.firstReleaseTag ? `First released in ${pr.firstReleaseTag}` : 'Merged but not in any tag yet'}
              >
                {pr.firstReleaseTag ?? 'unreleased'}
              </span>
            )}
            {typeof pr.additions === 'number' && typeof pr.deletions === 'number' && (
              <span className="font-mono ml-auto shrink-0">
                <span className="text-success">+{pr.additions}</span>
                <span className="text-danger ml-1">−{pr.deletions}</span>
              </span>
            )}
          </div>

          {/* Labels */}
          {pr.labels.length > 0 && (
            <div className="flex items-center flex-wrap gap-1">
              {pr.labels.map((label) => {
                const fg = labelTextColor(label.color)
                return (
                  <span
                    key={label.name}
                    className="px-1.5 py-0.5 rounded-full text-xs font-medium leading-tight"
                    style={{ backgroundColor: `#${label.color}`, color: fg }}
                    title={label.description || label.name}
                  >
                    {label.name}
                  </span>
                )
              })}
            </div>
          )}

          {/* Linked issues (Closes #N / GitHub "Link an issue") */}
          {pr.linkedIssues.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <div className="text-xs uppercase tracking-wide text-faint">
                {pr.linkedIssues.length === 1 ? 'Linked issue' : 'Linked issues'}
              </div>
              {pr.linkedIssues.map((iss) => (
                <a
                  key={iss.number}
                  onClick={(e) => {
                    e.stopPropagation()
                    backend.openExternal(iss.url)
                  }}
                  className="flex items-center gap-1.5 text-xs cursor-pointer hover:text-fg-bright min-w-0"
                  title={`${iss.title} (#${iss.number})`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', iss.url)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  {iss.state === 'closed' ? (
                    <CircleCheck className="icon-xs shrink-0 text-dim" />
                  ) : (
                    <CircleDot className="icon-xs shrink-0 text-success" />
                  )}
                  <span className="font-mono text-faint shrink-0">#{iss.number}</span>
                  <span className={`truncate ${iss.state === 'closed' ? 'text-faint line-through' : 'text-fg'}`}>
                    {iss.title}
                  </span>
                </a>
              ))}
            </div>
          )}

          {/* Reviews summary */}
          {pr.reviews.length > 0 && (
            <ReviewSummary reviews={pr.reviews} decision={pr.reviewDecision} />
          )}

          {/* Checks summary */}
          <div
            className={`flex items-center gap-1.5 cursor-pointer ${expanded ? 'mb-1.5' : ''}`}
            onClick={() => setExpanded(!expanded)}
          >
            <span className={`text-xs ${OVERALL_COLORS[pr.checksOverall]}`}>
              {pr.checksOverall === 'success' && 'Checks passing'}
              {pr.checksOverall === 'failure' && 'Checks failing'}
              {pr.checksOverall === 'pending' && 'Checks running'}
              {pr.checksOverall === 'none' && 'No checks'}
            </span>
            {pr.checks.length > 0 && (
              <span className="text-xs text-faint">
                ({pr.checks.filter((c) => c.state === 'success').length}/{pr.checks.length})
                {expanded ? '\u25B4' : '\u25BE'}
              </span>
            )}
          </div>

          {/* Expanded check list — sorted: failed → pending → success → neutral/skipped,
              then by startedAt within each group. */}
          {expanded && pr.checks.length > 0 && (
            <div className="space-y-0.5 max-h-60 overflow-y-auto">
              {sortChecksForDisplay(pr.checks).map((check) => {
                const icon = CHECK_ICONS[check.state]
                const isFailure = check.state === 'failure' || check.state === 'error'
                const reason = isFailure
                  ? check.description || firstLine(check.summary)
                  : ''
                const clickable = !!check.detailsUrl
                const rowClasses = `flex items-start gap-1.5 text-xs py-0.5 rounded ${
                  clickable ? 'cursor-pointer hover:bg-panel-raised px-1 -mx-1 group' : ''
                }`
                return (
                  <div
                    key={check.name}
                    className={rowClasses}
                    onClick={() => {
                      if (check.detailsUrl) backend.openExternal(check.detailsUrl)
                    }}
                    title={
                      check.detailsUrl
                        ? `Open: ${check.detailsUrl}`
                        : check.description || check.name
                    }
                    draggable={!!check.detailsUrl}
                    onDragStart={(e) => {
                      if (!check.detailsUrl) return
                      e.dataTransfer.setData('text/plain', check.detailsUrl)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <span className={`shrink-0 mt-0.5 ${icon.color}`}>{icon.symbol}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span
                          className={`truncate ${isFailure ? 'text-fg' : 'text-muted'}`}
                        >
                          {check.name}
                        </span>
                        {clickable && (
                          <ExternalLink
                            className="icon-2xs shrink-0 text-faint opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                      {reason && (
                        <div className="text-faint text-xs leading-snug truncate">
                          {reason}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {worktree &&
            pr.hasConflict === true &&
            pr.state !== 'merged' &&
            pr.state !== 'closed' && <FixConflictsButton worktreePath={worktree.path} />}

          {worktree && (
            <CiNotifyToggle
              worktreePath={worktree.path}
              enabled={isCiNotifyEnabled(
                ciNotify,
                worktree.path,
                settings.notifyChatOnCiFailure
              )}
              globalDefault={settings.notifyChatOnCiFailure}
            />
          )}
        </div>
      )}
    </RightPanel>
  )
}

/** Hands the conflict off to the worktree's agent. A button rather than the
 *  standing opt-in CI failures get: a branch that conflicts with its base
 *  usually conflicts with every other in-flight branch too, so firing this
 *  automatically would put the whole workspace to work over one bad merge
 *  base. */
function FixConflictsButton({ worktreePath }: { worktreePath: string }): JSX.Element {
  const backend = useBackend()
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (phase !== 'sent') return
    const t = setTimeout(() => setPhase('idle'), 4000)
    return () => clearTimeout(t)
  }, [phase])

  const send = useCallback(async () => {
    setPhase('sending')
    setError(null)
    try {
      const result = await backend.requestMergeConflictFix(worktreePath)
      setPhase(result.ok ? 'sent' : 'idle')
      if (!result.ok) setError(result.error || 'Failed to reach the agent')
    } catch (err) {
      setPhase('idle')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [backend, worktreePath])

  return (
    <div className="space-y-1 mt-1.5">
      <button
        onClick={() => void send()}
        disabled={phase !== 'idle'}
        title="Post a message into this worktree's agent chat asking it to bring the branch up to date with its base and resolve the conflicts."
        className="w-full text-xs bg-danger/15 hover:bg-danger/25 text-danger px-2 py-1.5 rounded flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-default disabled:opacity-70"
      >
        {phase === 'sending' ? (
          <Loader2 className="icon-xs animate-spin" />
        ) : phase === 'sent' ? (
          <Check className="icon-xs" />
        ) : (
          <GitMergeConflict className="icon-xs" />
        )}
        {phase === 'sent' ? 'Asked the agent' : 'Ask the agent to fix conflicts'}
      </button>
      {error && <div className="text-xs text-danger leading-snug break-words">{error}</div>}
    </div>
  )
}

/** Per-worktree opt in/out of the "tell the agent when CI fails" injection.
 *  Toggling back to the global default drops the override entirely so the
 *  worktree tracks future changes to the setting. */
function CiNotifyToggle({
  worktreePath,
  enabled,
  globalDefault
}: {
  worktreePath: string
  enabled: boolean
  globalDefault: boolean
}): JSX.Element {
  const backend = useBackend()
  return (
    <label
      className="flex items-center gap-1.5 cursor-pointer text-xs text-dim hover:text-fg mt-1.5"
      title={`Post a message naming the failing checks into this worktree's agent chat when CI goes red. Default for all worktrees: ${globalDefault ? 'on' : 'off'}.`}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => {
          const next = e.target.checked
          void backend.setCiNotifyOverride(
            worktreePath,
            next === globalDefault ? null : next
          )
        }}
        className="accent-current icon-base cursor-pointer"
      />
      <span>Tell the agent when CI fails</span>
    </label>
  )
}
