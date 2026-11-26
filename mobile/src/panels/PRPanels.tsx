// Port of renderer/components/PRStatusPanel.tsx (PRStatusPanel +
// MergeLocallyPanel). Same data sources, channels, conditions and labels;
// only the view layer changes. Phone-specific changes:
// - Desktop tooltips (hover-only) are reachable by long-press (Alert).
// - The PR panel's Approve / Merge live in the header like the desktop's
//   while the panel is collapsed; when expanded they move into a full-width
//   44pt row at the top of the body so the two-tap merge confirm is
//   comfortable on a phone.
// - Drag-a-URL-out (PR title, issues, checks) has no phone equivalent.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Image, Pressable, ScrollView, Text, View } from 'react-native'
import {
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDot,
  ExternalLink,
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  Info,
  Loader2,
  RefreshCw,
  Square,
  SquareCheck
} from 'lucide-react-native'
import type { CheckStatus, PRReview, PRStatus } from '../../../src/shared/state/prs'
import type { MergeStrategy } from '../../../src/shared/state/settings'
import type { Worktree } from '../../../src/shared/state/worktrees'
import { isCiNotifyEnabled } from '../../../src/shared/state/ci-notify'
import type {
  GitHubMergeMethod,
  MainWorktreeStatus,
  MergeConflictFixResult,
  MergeConflictPreview,
  MergeLocalResult,
  MergePRResult
} from '../../../src/renderer/types'
import { useNess, type NessClient } from '../ness'
import { alpha, c, fs, mono, themed } from '../theme'
import { Spin } from '../components/Spin'
import { PanelAction, RightPanel } from './RightPanel'
import type { PanelProps } from './types'

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const tip = (text: string) => () => Alert.alert(text)

/** Same as RightColumn/MobileRightPanel: a PAT or a detected `gh` login. */
function useHasGithubToken(client: NessClient): boolean {
  return useNess(client, (s) => s.settings.hasGithubToken || !!s.settings.githubAuthSource)
}

/** Effective merge strategy = repo override → global default. */
function useMergeStrategy(client: NessClient, repoRoot: string | null): MergeStrategy {
  const repo = useNess(client, (s) => (repoRoot ? s.repoConfigs.byRepo[repoRoot]?.mergeStrategy : undefined))
  const global = useNess(client, (s) => s.settings.mergeStrategy)
  return repo || global
}

/** Port of renderer/store.ts useLocalMergeState. */
function useLocalMergeState(client: NessClient, worktreePath: string, repoRoot: string) {
  const merging = useNess(client, (s) => !!s.prs.mergingByPath[worktreePath])
  const repoBusy = useNess(client, (s) => {
    for (const path in s.prs.mergingByPath) {
      if (s.worktrees.list.some((w) => w.path === path && w.repoRoot === repoRoot)) return true
    }
    return false
  })
  const merged = useNess(client, (s) => !!s.prs.mergedByPath[worktreePath])
  return { merging, repoBusy, merged }
}

// ─── Shared view bits ───────────────────────────────────────────────────

function Icon({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return busy ? <Spin>{children}</Spin> : <>{children}</>
}

/** Tinted full-width (or compact header) action button. */
function ActionButton({
  label,
  icon,
  color,
  bg,
  border,
  onPress,
  onLongPress,
  disabled,
  dim,
  compact,
  accessibilityLabel
}: {
  label: string
  icon: ReactNode
  color: string
  bg: string
  border?: string
  onPress: () => void
  onLongPress?: () => void
  disabled?: boolean
  /** Visual disabled (opacity) independent of tappability. */
  dim?: boolean
  compact?: boolean
  accessibilityLabel?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      hitSlop={compact ? 6 : 0}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => ({
        flex: compact ? undefined : 1,
        minHeight: compact ? 32 : 44,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: compact ? 8 : 12,
        borderRadius: 6,
        borderWidth: border ? 1 : 0,
        borderColor: border,
        backgroundColor: bg,
        opacity: dim ? 0.45 : pressed ? 0.75 : 1
      })}
    >
      {icon}
      <Text style={{ color, fontSize: compact ? fs.xs : fs.sm, fontWeight: '500' }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

function ErrorRow({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={{ flex: 1, color: c.danger, fontSize: fs.xs, lineHeight: 16 }}>{error}</Text>
      <Pressable
        onPress={onRetry}
        style={({ pressed }) => ({ minHeight: 44, minWidth: 64, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 4, backgroundColor: pressed ? alpha(c.surface, 0.6) : c.surface })}
      >
        <Text style={{ color: c.fg, fontSize: fs.xs }}>Retry</Text>
      </Pressable>
    </View>
  )
}

// ─── Merge Locally ──────────────────────────────────────────────────────

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

/** How long after a worktree switch to wait before simulating the merge
 *  (same as desktop: scrubbing fires none, the warning is there by read time). */
const CONFLICT_PREVIEW_DELAY_MS = 500

const STRATEGY_DESCRIPTIONS: Record<MergeStrategy, string> = {
  squash: 'The commits from this branch will be combined into one commit on the base branch.',
  'merge-commit': 'All commits from this branch will be added to the base branch via a merge commit.',
  'fast-forward': 'Only merge if the base can fast-forward (--ff-only). Fails on divergent history.'
}

/** Shown only when there's no PR, it's not the main worktree, and GitHub is
 *  connected (same condition as the desktop). */
export function MergePanel(props: PanelProps) {
  const { client, worktree, worktreePath, onClose } = props
  const hasGithubToken = useHasGithubToken(client)
  const pr = useNess(client, (s) => (worktreePath ? s.prs.byPath[worktreePath] : null))
  const needsGithubToken = hasGithubToken === false
  const show = !needsGithubToken && pr === null && worktree && !worktree.isMain
  if (!show || !worktree) return null
  // Desktop onMerged → prs:refreshAll; onRemoveWorktree → worktree:remove
  // (as the web client's MobileRightPanel does), then close the sheet.
  const onMerged = (): void => void client.api.refreshPRsAll()
  // Always confirm on the phone: the desktop confirms only for locked /
  // dirty / scratchpad-bearing worktrees, but a stray tap is much more
  // likely on a touch screen and removal can't be undone from here.
  const onRemoveWorktree = (path: string): void => {
    Alert.alert('Remove worktree?', `${worktree.branch || path.split('/').pop()} will be removed from disk.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void client.api.removeWorktree(worktree.repoRoot, path)
          onClose()
        }
      }
    ])
  }
  return (
    <RightPanel id="merge-locally" title="Merge Locally">
      {/* Keyed per worktree so a merge in one never settles into another's view. */}
      <MergeLocallyBody
        key={`${client.id}:${worktree.path}`}
        client={client}
        worktree={worktree}
        onMerged={onMerged}
        onRemoveWorktree={onRemoveWorktree}
      />
    </RightPanel>
  )
}

function MergeLocallyBody({
  client,
  worktree,
  onMerged,
  onRemoveWorktree
}: {
  client: NessClient
  worktree: Worktree
  onMerged: () => void
  onRemoveWorktree: (worktreePath: string) => void
}) {
  const [mainStatus, setMainStatus] = useState<MainWorktreeStatus | null>(null)
  const [conflictPreview, setConflictPreview] = useState<MergeConflictPreview | null>(null)
  const [busy, setBusy] = useState<'idle' | 'checking' | 'fixing' | 'merging'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const previewRef = useRef<Promise<MergeConflictPreview | null> | null>(null)

  const { repoRoot, branch, path } = worktree
  const strategy = useMergeStrategy(client, repoRoot)
  const { merging: mergeInFlight, repoBusy, merged: mergedLocally } = useLocalMergeState(client, path, repoRoot)

  const refreshStatus = useCallback(async () => {
    setBusy('checking')
    try {
      setMainStatus(await client.api.getMainWorktreeStatus(repoRoot))
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy('idle')
    }
  }, [client, repoRoot])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    setConflictPreview(null)
    previewRef.current = null
    let cancelled = false
    const timer = setTimeout(() => {
      const pending = client
        .api.previewMergeConflicts(repoRoot, branch, path)
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
  }, [client, repoRoot, branch, path])

  const handlePickStrategy = (s: MergeStrategy): void => {
    setMenuOpen(false)
    // Persist as new default — "last used wins".
    void client.api.setMergeStrategy(s)
  }

  const handleFix = async (): Promise<void> => {
    setError(null)
    setBusy('fixing')
    try {
      setMainStatus(await client.api.prepareMainForMerge(repoRoot))
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy('idle')
    }
  }

  const handleMerge = async (): Promise<void> => {
    if (!mainStatus) return
    setError(null)
    setSuccess(null)
    setBusy('merging')
    try {
      // Settle the deferred preview rather than racing it.
      const preview = await (previewRef.current ??
        client.api.previewMergeConflicts(repoRoot, branch, path).catch(() => null))
      if (preview?.hasConflict) {
        setConflictPreview(preview)
        setError('Resolve merge conflicts before merging.')
        return
      }
      void client.api.setMergeStrategy(strategy)
      const result = await client.api.mergeWorktreeLocally(repoRoot, branch, strategy, path)
      setSuccess(`Merged into ${result.baseBranch}`)
      onMerged()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy('idle')
    }
  }

  const ready = mainStatus?.ready === true
  const needsFix = mainStatus && !mainStatus.ready
  const hasConflict = conflictPreview?.hasConflict === true
  const merging = busy === 'merging' || mergeInFlight
  const successMessage =
    success ?? (mergedLocally && !dismissed && !merging && mainStatus ? `Merged into ${mainStatus.baseBranch}` : null)
  const mergeDisabled = !ready || busy !== 'idle' || merging || repoBusy || hasConflict

  if (successMessage) {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}>
        <Text style={{ color: c.success, fontSize: fs.sm }}>{successMessage}</Text>
        <ActionButton
          label="Remove worktree"
          icon={null}
          color={c.fg}
          bg={c.panelRaised}
          onPress={() => onRemoveWorktree(worktree.path)}
        />
        <Pressable
          onPress={() => {
            setSuccess(null)
            setDismissed(true)
            void refreshStatus()
          }}
          style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: c.faint, fontSize: fs.xs }}>Dismiss</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}>
      <Text style={{ color: c.faint, fontSize: fs.xs }}>
        Merge <Text style={{ color: c.fg, fontFamily: mono }}>{worktree.branch}</Text>
        {mainStatus && (
          <>
            {' '}into <Text style={{ color: c.fg, fontFamily: mono }}>{mainStatus.baseBranch}</Text>
          </>
        )}
      </Text>

      {/* GitHub-style split button; the strategy menu expands inline. */}
      <View style={{ flexDirection: 'row' }}>
        <Pressable
          onPress={() => void handleMerge()}
          onLongPress={hasConflict ? tip('Resolve merge conflicts before merging') : undefined}
          disabled={mergeDisabled}
          style={({ pressed }) => ({
            flex: 1,
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            backgroundColor: alpha(c.accent, pressed ? 0.3 : 0.2),
            borderTopLeftRadius: 6,
            borderBottomLeftRadius: 6,
            borderRightWidth: 1,
            borderColor: alpha(c.accent, 0.4),
            opacity: mergeDisabled ? 0.5 : 1
          })}
        >
          <GitMerge size={14} color={c.fgBright} />
          <Text style={{ color: c.fgBright, fontSize: fs.sm, fontWeight: '500' }}>
            {merging ? 'Merging…' : STRATEGY_BUTTON_LABELS[strategy]}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setMenuOpen((v) => !v)}
          disabled={merging}
          accessibilityLabel="Change merge strategy"
          style={({ pressed }) => ({
            width: 44,
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: alpha(c.accent, pressed || menuOpen ? 0.3 : 0.2),
            borderTopRightRadius: 6,
            borderBottomRightRadius: 6,
            opacity: merging ? 0.5 : 1
          })}
        >
          <ChevronDown size={14} color={c.fgBright} style={{ transform: [{ rotate: menuOpen ? '180deg' : '0deg' }] }} />
        </Pressable>
      </View>

      {menuOpen && (
        <View style={{ backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 6, overflow: 'hidden' }}>
          {(['squash', 'merge-commit', 'fast-forward'] as MergeStrategy[]).map((s) => {
            const active = s === strategy
            return (
              <Pressable
                key={s}
                onPress={() => handlePickStrategy(s)}
                accessibilityState={{ selected: active }}
                style={({ pressed }) => ({
                  minHeight: 44,
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  backgroundColor: active || pressed ? c.panelRaised : 'transparent'
                })}
              >
                <View style={{ marginTop: 2, opacity: active ? 1 : 0 }}>
                  <Check size={14} color={c.accent} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: c.fgBright, fontSize: fs.sm }}>{STRATEGY_MENU_LABELS[s]}</Text>
                  <Text style={{ color: c.faint, fontSize: fs.xs, lineHeight: 16 }}>{STRATEGY_DESCRIPTIONS[s]}</Text>
                </View>
              </Pressable>
            )
          })}
        </View>
      )}

      {hasConflict && conflictPreview && (
        <View style={{ gap: 4 }}>
          <Text style={{ color: c.danger, fontSize: fs.xs, lineHeight: 16 }}>
            Merge conflict
            {conflictPreview.files.length > 0 && (
              <>
                {' '}in{' '}
                <Text style={{ fontFamily: mono }}>
                  {conflictPreview.files.length === 1 ? conflictPreview.files[0] : `${conflictPreview.files.length} files`}
                </Text>
              </>
            )}
            . Resolve before merging.
          </Text>
          {conflictPreview.files.length > 1 && (
            <ScrollView style={{ maxHeight: 80 }} nestedScrollEnabled>
              {conflictPreview.files.map((f) => (
                // ellipsizeMode="head" = the desktop's rtl trick: keep the filename end visible.
                <Text key={f} numberOfLines={1} ellipsizeMode="head" style={{ color: c.faint, fontFamily: mono, fontSize: fs.xs, paddingVertical: 1 }}>
                  {f}
                </Text>
              ))}
            </ScrollView>
          )}
        </View>
      )}

      {needsFix && mainStatus && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.warning, fontSize: fs.xs, lineHeight: 16 }}>
            Main worktree isn't ready:
            {mainStatus.isDirty && ' has uncommitted changes'}
            {!mainStatus.isOnBase && (
              <>
                {mainStatus.isDirty ? ' and' : ''} on{' '}
                <Text style={{ fontFamily: mono }}>{mainStatus.currentBranch || 'detached HEAD'}</Text>, not{' '}
                <Text style={{ fontFamily: mono }}>{mainStatus.baseBranch}</Text>
              </>
            )}
            .
          </Text>
          <ActionButton
            label={
              busy === 'fixing'
                ? 'Fixing…'
                : mainStatus.isDirty
                  ? `Stash & checkout ${mainStatus.baseBranch}`
                  : `Checkout ${mainStatus.baseBranch}`
            }
            icon={null}
            color={c.fg}
            bg={c.panelRaised}
            onPress={() => void handleFix()}
            disabled={busy !== 'idle' || repoBusy}
            dim={busy !== 'idle' || repoBusy}
          />
        </View>
      )}

      {error && <Text style={{ color: c.danger, fontSize: fs.xs, lineHeight: 16 }}>{error}</Text>}
    </View>
  )
}

// ─── Pull Request ───────────────────────────────────────────────────────

/** Copied from PRStatusPanel.tsx: first non-empty, non-heading line of a
 *  check's `output.summary`, capped. */
function firstLine(summary: string | undefined): string {
  if (!summary) return ''
  for (const raw of summary.split('\n')) {
    const line = raw.trim().replace(/^#+\s*/, '').replace(/^[-*]\s+/, '')
    if (line) return line.length > 140 ? line.slice(0, 140) + '…' : line
  }
  return ''
}

const STATE_LABELS: Record<string, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }
const STATE_PILL_COLORS: Record<string, string> = themed(() => ({ open: c.success, draft: c.warning, merged: c.accent, closed: c.danger }))

/** Copied from PRStatusPanel.tsx (GitHub's label-foreground rule). */
function labelTextColor(hex: string): string {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '#fff'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
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

type MilestoneDisplay = 'hidden' | 'pill' | 'placeholder'
function milestoneDisplay(pr: Pick<PRStatus, 'hasMilestones' | 'milestone'>): MilestoneDisplay {
  if (pr.hasMilestones === false) return 'hidden'
  return pr.milestone ? 'pill' : 'placeholder'
}

const CHECK_ICONS: Record<CheckStatus['state'], { symbol: string; color: string }> = themed(() => ({
  success: { symbol: '✓', color: c.success },
  failure: { symbol: '✗', color: c.danger },
  error: { symbol: '!', color: c.danger },
  pending: { symbol: '○', color: c.warning },
  neutral: { symbol: '-', color: c.dim },
  skipped: { symbol: '-', color: c.dim }
}))

const OVERALL_COLORS: Record<string, string> = themed(() => ({ success: c.success, failure: c.danger, pending: c.warning, none: c.dim }))

const CHECK_STATE_PRIORITY: Record<CheckStatus['state'], number> = {
  failure: 0,
  error: 0,
  pending: 1,
  success: 2,
  neutral: 3,
  skipped: 4
}

/** Failed → pending → success → neutral/skipped, then startedAt, then name. */
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

const REVIEW_DECISION_LABELS: Record<PRStatus['reviewDecision'], { text: string; color: string }> = themed(() => ({
  approved: { text: 'Approved', color: c.success },
  changes_requested: { text: 'Changes requested', color: c.warning },
  review_required: { text: 'Review pending', color: c.faint },
  none: { text: '', color: c.faint }
}))

const REVIEW_STATE_ICONS: Record<PRReview['state'], { symbol: string; color: string }> = themed(() => ({
  APPROVED: { symbol: '✓', color: c.success },
  CHANGES_REQUESTED: { symbol: '●', color: c.warning },
  COMMENTED: { symbol: '○', color: c.faint },
  DISMISSED: { symbol: '-', color: c.dim },
  PENDING: { symbol: '○', color: c.dim }
}))

function ReviewSummary({
  reviews,
  decision,
  onOpenUrl
}: {
  reviews: PRReview[]
  decision: PRStatus['reviewDecision']
  onOpenUrl: (url: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const label = REVIEW_DECISION_LABELS[decision]
  // Dedupe to latest review per user.
  const latestByUser = new Map<string, PRReview>()
  for (const r of reviews) latestByUser.set(r.user, r)
  const uniqueReviewers = [...latestByUser.values()]

  return (
    <View>
      <Pressable onPress={() => setExpanded(!expanded)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {!!label.text && <Text style={{ fontSize: fs.xs, color: label.color }}>{label.text}</Text>}
        <Text style={{ fontSize: fs.xs, color: c.faint }}>
          ({uniqueReviewers.length} {uniqueReviewers.length === 1 ? 'reviewer' : 'reviewers'}){expanded ? '▴' : '▾'}
        </Text>
      </Pressable>
      {expanded &&
        uniqueReviewers.map((review) => {
          const icon = REVIEW_STATE_ICONS[review.state]
          return (
            <Pressable
              key={review.user}
              onPress={() => onOpenUrl(review.htmlUrl)}
              onLongPress={tip(`${review.user}: ${review.state.toLowerCase().replace('_', ' ')}`)}
              style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, borderRadius: 4, backgroundColor: pressed ? c.panelRaised : 'transparent' })}
            >
              <Image source={{ uri: review.avatarUrl }} style={{ width: 20, height: 20, borderRadius: 10 }} />
              <Text style={{ color: c.muted, fontSize: fs.xs, flexShrink: 1 }} numberOfLines={1}>
                {review.user}
              </Text>
              <Text style={{ color: icon.color, fontSize: fs.xs }}>{icon.symbol}</Text>
              <View style={{ marginLeft: 'auto' }}>
                <ExternalLink size={10} color={c.faint} />
              </View>
            </Pressable>
          )
        })}
    </View>
  )
}

// 'fast-forward' has no GitHub equivalent — 'rebase' is the closest.
const STRATEGY_TO_METHOD: Record<MergeStrategy, GitHubMergeMethod> = {
  squash: 'squash',
  'merge-commit': 'merge',
  'fast-forward': 'rebase'
}
const METHOD_LABEL: Record<GitHubMergeMethod, string> = { squash: 'Squash', merge: 'Merge', rebase: 'Rebase' }

/** Port of usePRMergeAction: same disabled reasons, 5s two-tap confirm,
 *  labels. Returns state + renderers instead of prebuilt JSX so the button
 *  can render compact (header) or full-width (body). */
function usePRMergeAction(client: NessClient, pr: PRStatus | null | undefined, worktree: Worktree | null, needsGithubToken: boolean) {
  const strategy = useMergeStrategy(client, worktree?.repoRoot ?? null)
  const method = STRATEGY_TO_METHOD[strategy]
  const methodLabel = METHOD_LABEL[method]

  const [confirming, setConfirming] = useState(false)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justMerged, setJustMerged] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
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
      const result = await client.api.mergePR(worktree.path, method)
      if (result.ok) setJustMerged(true)
      else setError(result.error || 'Merge failed')
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setMerging(false)
    }
  }, [client, worktree, method])

  if (!pr) return { render: null, errorRow: null }

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

  let mergeLabel: string
  if (merging) mergeLabel = 'Merging…'
  else if (justMerged) mergeLabel = 'Merged'
  else if (confirming) mergeLabel = `Confirm merge into ${pr.baseBranch}`
  else mergeLabel = methodLabel

  let mergeTooltip: string
  if (disabledReason) mergeTooltip = disabledReason
  else if (confirming) mergeTooltip = 'Tap again to confirm'
  else mergeTooltip = 'Merge the pull request'

  const showMergeButton = !isTerminal && !pr.queuePosition
  const conflict = pr.hasConflict === true
  const color = conflict ? c.danger : confirming ? c.warning : c.success
  const bg = conflict ? alpha(c.danger, 0.2) : confirming ? alpha(c.warning, 0.3) : alpha(c.success, 0.2)

  const render = showMergeButton
    ? (compact: boolean) => (
        <ActionButton
          compact={compact}
          label={mergeLabel}
          color={color}
          bg={bg}
          border={confirming && !conflict ? alpha(c.warning, 0.5) : undefined}
          icon={
            merging ? (
              <Icon busy><Loader2 size={compact ? 12 : 14} color={color} /></Icon>
            ) : justMerged ? (
              <Check size={compact ? 12 : 14} color={color} />
            ) : conflict ? (
              <GitMergeConflict size={compact ? 12 : 14} color={color} />
            ) : (
              <GitMerge size={compact ? 12 : 14} color={color} />
            )
          }
          // Disabled-with-a-reason stays tappable so the reason (a hover
          // tooltip on desktop) can be shown.
          onPress={() => {
            if (justMerged || merging) return
            if (!canMerge) {
              if (disabledReason) Alert.alert(disabledReason)
              return
            }
            if (confirming) void performMerge()
            else startConfirm()
          }}
          onLongPress={tip(mergeTooltip)}
          dim={(!canMerge || justMerged) && !conflict}
        />
      )
    : null

  const errorRow = error ? (
    <ErrorRow
      error={error}
      onRetry={() => {
        setError(null)
        void performMerge()
      }}
    />
  ) : null

  return { render, errorRow }
}

/** Port of usePRApproveAction (same visibility heuristic). */
function usePRApproveAction(
  client: NessClient,
  pr: PRStatus | null | undefined,
  worktree: Worktree | null,
  viewerLogin: string | null,
  needsGithubToken: boolean
) {
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
      const result = await client.api.approvePR(worktree.path)
      if (result.ok) setJustApproved(true)
      else setError(result.error || 'Approval failed')
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setApproving(false)
    }
  }, [client, worktree])

  const none = { render: null, errorRow: null }
  if (!pr || !worktree || needsGithubToken) return none
  if (pr.state !== 'open') return none
  if (!viewerLogin) return none
  if (pr.author?.login === viewerLogin) return none

  let viewerLatest: PRReview | null = null
  for (const r of pr.reviews) {
    if (r.user !== viewerLogin) continue
    if (!viewerLatest || r.submittedAt > viewerLatest.submittedAt) viewerLatest = r
  }
  if (viewerLatest?.state === 'APPROVED') return none
  const showApprove = pr.reviewDecision === 'review_required' || viewerLatest?.state === 'CHANGES_REQUESTED'
  if (!showApprove) return none

  const render = (compact: boolean) => (
    <ActionButton
      compact={compact}
      label={justApproved ? 'Approved' : 'Approve'}
      accessibilityLabel="Approve pull request"
      color={c.success}
      bg={alpha(c.success, 0.2)}
      icon={
        approving ? (
          <Icon busy><Loader2 size={compact ? 12 : 14} color={c.success} /></Icon>
        ) : (
          <Check size={compact ? 12 : 14} color={c.success} />
        )
      }
      onPress={() => void performApprove()}
      onLongPress={tip(justApproved ? 'Approved' : 'Approve this pull request')}
      disabled={approving || justApproved}
      dim={approving || justApproved}
    />
  )

  const errorRow = error ? (
    <ErrorRow
      error={error}
      onRetry={() => {
        setError(null)
        void performApprove()
      }}
    />
  ) : null

  return { render, errorRow }
}

/** Port of useAiReviewAction: opens a reviewer Chat tab for this worktree. */
function AiReviewRow({ client, worktree }: { client: NessClient; worktree: Worktree }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    setBusy(false)
    setError(null)
    setDone(false)
  }, [worktree.path])

  const request = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await client.api.requestAiReview(worktree.path)
      if (result.ok) setDone(true)
      else setError(result.error)
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: 8, paddingTop: 4, gap: 6 }}>
      <ActionButton
        label={done ? 'Reviewer opened' : 'Request AI review'}
        color={c.accent}
        bg={alpha(c.accent, 0.2)}
        icon={
          busy ? (
            <Icon busy><Loader2 size={14} color={c.accent} /></Icon>
          ) : done ? (
            <Check size={14} color={c.accent} />
          ) : (
            <Bot size={14} color={c.accent} />
          )
        }
        onPress={() => void request()}
        onLongPress={tip('Open an agent that reviews this branch and sends its review to your Chat tab')}
        disabled={busy || done}
        dim={busy || done}
      />
      {error && <Text style={{ color: c.danger, fontSize: fs.xs, lineHeight: 16 }}>{error}</Text>}
    </View>
  )
}

export function PRPanel(props: PanelProps) {
  const { client, worktree, worktreePath, onOpenUrl } = props
  // Same as RightColumn: undefined = not polled yet ("Loading..."), null = no PR.
  const pr = useNess(client, (s) => (worktreePath ? s.prs.byPath[worktreePath] : null))
  const loading = useNess(client, (s) => s.prs.loading)
  const hasGithubToken = useHasGithubToken(client)
  const viewerLogin = useNess(client, (s) => s.settings.viewerLogin)
  const agentReviewsEnabled = useNess(client, (s) => s.settings.agentReviewsEnabled)
  const notifyDefault = useNess(client, (s) => s.settings.notifyChatOnCiFailure)
  const ciNotify = useNess(client, (s) => s.ciNotify)

  const [expanded, setExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  // Auto-expand the check list whenever checks are failing.
  useEffect(() => {
    if (pr?.checksOverall === 'failure') setExpanded(true)
  }, [pr?.checksOverall, pr?.number])

  const needsGithubToken = hasGithubToken === false
  const mergeAction = usePRMergeAction(client, pr, worktree, needsGithubToken)
  const approveAction = usePRApproveAction(client, pr, worktree, viewerLogin, needsGithubToken)
  const onRefresh = (): void => void client.api.refreshPRsAll()

  const refreshButton = !needsGithubToken ? (
    <PanelAction onPress={onRefresh} label="Refresh PR status" disabled={loading}>
      <Icon busy={loading}>
        <RefreshCw size={14} color={c.dim} />
      </Icon>
    </PanelAction>
  ) : null

  const hasActionButtons = !!(approveAction.render || mergeAction.render)
  const actions =
    hasActionButtons || refreshButton ? (
      <>
        {collapsed && approveAction.render?.(true)}
        {collapsed && mergeAction.render?.(true)}
        {refreshButton}
      </>
    ) : null

  return (
    <RightPanel id="pull-request" title="Pull Request" actions={actions} onCollapsedChange={setCollapsed}>
      {/* The desktop also tints the header info-blue here; RightPanel's RN
          port has no header-style slot, so only the body is tinted. */}
      <View style={needsGithubToken ? { backgroundColor: alpha(c.info, 0.1) } : undefined}>
        {needsGithubToken && (
          // The desktop's "Connect GitHub" button opens Settings → GitHub;
          // the phone has no settings screen, so only the prompt is shown.
          <View style={{ paddingHorizontal: 12, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <GitPullRequest size={14} color={c.info} />
            <Text style={{ flex: 1, color: alpha(c.info, 0.9), fontSize: fs.xs, lineHeight: 16 }}>
              Connect a GitHub token to see PR status and open pull requests from Ness.
            </Text>
          </View>
        )}

        {!needsGithubToken && pr === null && (
          <Text style={{ paddingHorizontal: 12, paddingVertical: 8, color: c.faint, fontSize: fs.xs }}>No PR for this branch</Text>
        )}

        {!needsGithubToken && pr !== undefined && agentReviewsEnabled && worktree && (
          <AiReviewRow key={`${client.id}:${worktree.path}`} client={client} worktree={worktree} />
        )}

        {!needsGithubToken && pr === undefined && (
          <Text style={{ paddingHorizontal: 12, paddingVertical: 8, color: c.faint, fontSize: fs.xs }}>Loading...</Text>
        )}

        {/* Approve / Merge, full-size while expanded (header when collapsed). */}
        {hasActionButtons && (
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 8 }}>
            {approveAction.render?.(false)}
            {mergeAction.render?.(false)}
          </View>
        )}

        {mergeAction.errorRow}
        {approveAction.errorRow}

        {!needsGithubToken && pr && (
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 8 }}>
            {/* #nnn pill + title */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {(() => {
                const pillColor = pr.queuePosition ? c.accent : STATE_PILL_COLORS[pr.state]
                return (
                  <Pressable
                    onPress={() => onOpenUrl(pr.url)}
                    onLongPress={tip(pr.queuePosition ? queueBadgeLabel(pr.queuePosition, pr.queueEstimatedSeconds) : STATE_LABELS[pr.state])}
                    accessibilityLabel="Open PR in browser"
                    accessibilityRole="link"
                    // The 44pt box is the target; the pill is drawn inside it.
                    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                  >
                    {({ pressed }) => (
                      <View style={{ paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: pillColor, backgroundColor: pressed ? alpha(pillColor, 0.1) : 'transparent' }}>
                        <Text style={{ color: pillColor, fontSize: fs.xs, fontWeight: '500' }}>#{pr.number}</Text>
                      </View>
                    )}
                  </Pressable>
                )
              })()}
              <Pressable onPress={() => onOpenUrl(pr.url)} style={{ flex: 1, minHeight: 44, justifyContent: 'center' }} accessibilityLabel="Open PR in browser">
                <Text style={{ color: c.fg, fontSize: fs.sm }} numberOfLines={2}>
                  {pr.title}
                </Text>
              </Pressable>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              {pr.assignees.length > 0 && (
                <Pressable onLongPress={tip(pr.assignees.map((a) => `Assigned to ${a.login}`).join('\n'))} style={{ flexDirection: 'row' }}>
                  {pr.assignees.map((a, i) => (
                    <Image
                      key={a.login}
                      source={{ uri: a.avatarUrl }}
                      style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 1, borderColor: c.panel, marginLeft: i > 0 ? -4 : 0 }}
                    />
                  ))}
                </Pressable>
              )}
              {!!pr.queuePosition && (
                <Text style={{ color: c.accent, fontSize: fs.xs, fontWeight: '500' }}>
                  {queueBadgeLabel(pr.queuePosition, pr.queueEstimatedSeconds)}
                </Text>
              )}
              {(() => {
                const display = milestoneDisplay(pr)
                if (display === 'hidden') return null
                if (display === 'pill' && pr.milestone) {
                  const m = pr.milestone
                  const closed = m.state === 'closed'
                  return (
                    <Pressable
                      onPress={() => onOpenUrl(m.url)}
                      onLongPress={tip(`Milestone: ${m.title}`)}
                      hitSlop={8}
                      style={{ maxWidth: 160, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: closed ? c.surface : alpha(c.accent, 0.2) }}
                    >
                      <Text style={{ color: closed ? c.dim : c.accent, fontSize: fs.xs, fontWeight: '500' }} numberOfLines={1}>
                        {m.title}
                      </Text>
                    </Pressable>
                  )
                }
                return (
                  <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: c.surface }}>
                    <Text style={{ color: c.faint, fontSize: fs.xs, fontWeight: '500' }}>No milestone</Text>
                  </View>
                )
              })()}
              <Text
                onLongPress={tip(pr.isDefaultBase ? `Target: ${pr.baseBranch}` : `Target: ${pr.baseBranch} (not the default branch)`)}
                style={{ fontFamily: mono, fontSize: fs.xs, color: pr.isDefaultBase ? c.dim : c.warning }}
                numberOfLines={1}
              >
                {pr.baseBranch}
              </Text>
              {pr.state !== 'merged' && typeof pr.behindBy === 'number' && pr.behindBy > 0 && (
                <Pressable
                  onLongPress={tip(`${pr.behindBy} commit${pr.behindBy === 1 ? '' : 's'} behind ${pr.baseBranch}`)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}
                >
                  <ArrowDown size={12} color={c.warning} />
                  <Text style={{ color: c.warning, fontSize: fs.xs }}>{pr.behindBy}</Text>
                </Pressable>
              )}
              {pr.state === 'merged' && (
                <Text
                  onLongPress={tip(pr.firstReleaseTag ? `First released in ${pr.firstReleaseTag}` : 'Merged but not in any tag yet')}
                  style={{ fontFamily: mono, fontSize: fs.xs, color: pr.firstReleaseTag ? c.accent : c.faint, fontStyle: pr.firstReleaseTag ? 'normal' : 'italic' }}
                  numberOfLines={1}
                >
                  {pr.firstReleaseTag ?? 'unreleased'}
                </Text>
              )}
              {typeof pr.additions === 'number' && typeof pr.deletions === 'number' && (
                <Text style={{ marginLeft: 'auto', fontFamily: mono, fontSize: fs.xs }}>
                  <Text style={{ color: c.success }}>+{pr.additions}</Text>
                  <Text style={{ color: c.danger }}> −{pr.deletions}</Text>
                </Text>
              )}
            </View>

            {pr.labels.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                {pr.labels.map((label) => (
                  <Pressable
                    key={label.name}
                    onLongPress={tip(label.description || label.name)}
                    style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: `#${label.color}` }}
                  >
                    <Text style={{ color: labelTextColor(label.color), fontSize: fs.xs, fontWeight: '500' }}>{label.name}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            {pr.linkedIssues.length > 0 && (
              <View>
                <Text style={{ color: c.faint, fontSize: fs.xs, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  {pr.linkedIssues.length === 1 ? 'Linked issue' : 'Linked issues'}
                </Text>
                {pr.linkedIssues.map((iss) => {
                  const closed = iss.state === 'closed'
                  return (
                    <Pressable
                      key={iss.number}
                      onPress={() => onOpenUrl(iss.url)}
                      onLongPress={tip(`${iss.title} (#${iss.number})`)}
                      style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 4, backgroundColor: pressed ? c.panelRaised : 'transparent' })}
                    >
                      {closed ? <CircleCheck size={12} color={c.dim} /> : <CircleDot size={12} color={c.success} />}
                      <Text style={{ fontFamily: mono, color: c.faint, fontSize: fs.xs }}>#{iss.number}</Text>
                      <Text
                        numberOfLines={1}
                        style={{ flex: 1, fontSize: fs.xs, color: closed ? c.faint : c.fg, textDecorationLine: closed ? 'line-through' : 'none' }}
                      >
                        {iss.title}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            )}

            {pr.reviews.length > 0 && <ReviewSummary reviews={pr.reviews} decision={pr.reviewDecision} onOpenUrl={onOpenUrl} />}

            {/* Checks summary */}
            <Pressable onPress={() => setExpanded(!expanded)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: fs.xs, color: OVERALL_COLORS[pr.checksOverall] }}>
                {pr.checksOverall === 'success' && 'Checks passing'}
                {pr.checksOverall === 'failure' && 'Checks failing'}
                {pr.checksOverall === 'pending' && 'Checks running'}
                {pr.checksOverall === 'none' && 'No checks'}
              </Text>
              {pr.checks.length > 0 && (
                <Text style={{ fontSize: fs.xs, color: c.faint }}>
                  ({pr.checks.filter((ch) => ch.state === 'success').length}/{pr.checks.length}){expanded ? '▴' : '▾'}
                </Text>
              )}
            </Pressable>

            {expanded && pr.checks.length > 0 && (
              <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
                {sortChecksForDisplay(pr.checks).map((check) => {
                  const icon = CHECK_ICONS[check.state]
                  const isFailure = check.state === 'failure' || check.state === 'error'
                  const reason = isFailure ? check.description || firstLine(check.summary) : ''
                  const url = check.detailsUrl
                  return (
                    <Pressable
                      key={check.name}
                      disabled={!url}
                      onPress={() => {
                        if (url) onOpenUrl(url)
                      }}
                      onLongPress={tip(url ? `Open: ${url}` : check.description || check.name)}
                      style={({ pressed }) => ({ minHeight: url ? 44 : 28, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, borderRadius: 4, backgroundColor: pressed ? c.panelRaised : 'transparent' })}
                    >
                      <Text style={{ color: icon.color, fontSize: fs.xs, width: 12, textAlign: 'center' }}>{icon.symbol}</Text>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: fs.xs, color: isFailure ? c.fg : c.muted }}>
                            {check.name}
                          </Text>
                          {url && <ExternalLink size={10} color={c.faint} />}
                        </View>
                        {!!reason && (
                          <Text numberOfLines={1} style={{ color: c.faint, fontSize: fs.xs, lineHeight: 16 }}>
                            {reason}
                          </Text>
                        )}
                      </View>
                    </Pressable>
                  )
                })}
              </ScrollView>
            )}

            {worktree && pr.hasConflict === true && pr.state !== 'merged' && pr.state !== 'closed' && (
              <FixConflictsButton key={`${client.id}:${worktree.path}`} client={client} worktreePath={worktree.path} />
            )}

            {worktree && (
              <CiNotifyToggle
                client={client}
                worktreePath={worktree.path}
                enabled={isCiNotifyEnabled(ciNotify, worktree.path, notifyDefault)}
                globalDefault={notifyDefault}
              />
            )}
          </View>
        )}
      </View>
    </RightPanel>
  )
}

/** Hands the conflict off to the worktree's agent (a button, not automatic:
 *  one bad merge base would otherwise put the whole workspace to work). */
function FixConflictsButton({ client, worktreePath }: { client: NessClient; worktreePath: string }) {
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (phase !== 'sent') return
    const t = setTimeout(() => setPhase('idle'), 4000)
    return () => clearTimeout(t)
  }, [phase])

  const send = async (): Promise<void> => {
    setPhase('sending')
    setError(null)
    try {
      const result = await client.api.requestMergeConflictFix(worktreePath)
      setPhase(result.ok ? 'sent' : 'idle')
      if (!result.ok) setError(result.error || 'Failed to reach the agent')
    } catch (err) {
      setPhase('idle')
      setError(errMsg(err))
    }
  }

  return (
    <View style={{ gap: 4, marginTop: 4 }}>
      <View style={{ flexDirection: 'row' }}>
        <ActionButton
          label={phase === 'sent' ? 'Asked the agent' : 'Ask the agent to fix conflicts'}
          color={c.danger}
          bg={alpha(c.danger, 0.15)}
          icon={
            phase === 'sending' ? (
              <Icon busy><Loader2 size={14} color={c.danger} /></Icon>
            ) : phase === 'sent' ? (
              <Check size={14} color={c.danger} />
            ) : (
              <GitMergeConflict size={14} color={c.danger} />
            )
          }
          onPress={() => void send()}
          onLongPress={tip("Post a message into this worktree's agent chat asking it to bring the branch up to date with its base and resolve the conflicts.")}
          disabled={phase !== 'idle'}
          dim={phase !== 'idle'}
        />
      </View>
      {error && <Text style={{ color: c.danger, fontSize: fs.xs, lineHeight: 16 }}>{error}</Text>}
    </View>
  )
}

/** Per-worktree opt in/out of PR notifications to the agent. Toggling back
 *  to the global default drops the override (null) so it tracks the setting. */
function CiNotifyToggle({
  client,
  worktreePath,
  enabled,
  globalDefault
}: {
  client: NessClient
  worktreePath: string
  enabled: boolean
  globalDefault: boolean
}) {
  const help = `Keep this worktree's agent posted on its PR: CI failures, change requests and conflicts interrupt it, routine updates wait for its next turn. Default for all worktrees: ${globalDefault ? 'on' : 'off'}.`
  const toggle = (): void => {
    const next = !enabled
    void client.api.setCiNotifyOverride(worktreePath, next === globalDefault ? null : next)
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Pressable
        onPress={toggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: enabled }}
        style={{ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }}
      >
        {enabled ? <SquareCheck size={16} color={c.fg} /> : <Square size={16} color={c.dim} />}
        <Text style={{ color: enabled ? c.fg : c.dim, fontSize: fs.xs }}>Tell the agent about its PR</Text>
      </Pressable>
      {/* The desktop's hover tooltip, reachable by tap. */}
      <Pressable onPress={tip(help)} accessibilityLabel="About PR notifications" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Info size={14} color={c.faint} />
      </Pressable>
    </View>
  )
}
