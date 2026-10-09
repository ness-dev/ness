import { useEffect, useMemo, useRef, useState } from 'react'
import { X, GitPullRequest, ChevronDown, ChevronRight, Layers, Rows3 } from 'lucide-react'
import { useSettings, useSnooze, usePinned } from '../store'
import { useBackend } from '../backend'
import type {
  Worktree,
  PtyStatus,
  PendingTool,
  PRStatus,
  TerminalTab,
  ActivityLog,
  ActivityRecord
} from '../types'
import { eventsToSegments, STATE_COLOR } from './Activity'
import { groupWorktrees, type GroupKey } from '../../shared/worktree-sort'
import { isPRMerged } from '../../shared/state/prs'
import { repoNameColor } from './RepoIcon'
import { formatPendingTool } from '../pending-tool'

interface CommandCenterProps {
  worktrees: Worktree[]
  worktreeStatuses: Record<string, PtyStatus>
  worktreePendingTools: Record<string, PendingTool | null>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  lastActive: Record<string, number>
  tailLines: Record<string, string>
  terminalTabs: Record<string, TerminalTab[]>
  onClose: () => void
  onSelect: (worktreePath: string) => void
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
  onToggleGroup: (scope: string, key: GroupKey) => void
}

type DisplayStatus = PtyStatus | 'merged'

const STATUS_DOT: Record<DisplayStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent'
}

const STATUS_LABEL: Record<DisplayStatus, string> = {
  idle: 'Idle',
  processing: 'Working',
  waiting: 'Waiting',
  'needs-approval': 'Needs approval',
  merged: 'Merged'
}

const STATUS_BAR_FILL: Record<DisplayStatus, string> = {
  idle: 'bg-faint/40',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger',
  merged: 'bg-accent'
}

const STATUS_CARD_RING: Record<DisplayStatus, string> = {
  idle: 'ring-1 ring-border',
  processing: 'ring-1 ring-success/40',
  waiting: 'ring-1 ring-warning/50',
  'needs-approval': 'ring-2 ring-danger shadow-[0_0_32px_rgba(239,68,68,0.25)] animate-pulse',
  merged: 'ring-1 ring-accent/30'
}

const SAMPLE_COUNT = 60
// Match the aggregate bar graph above: last minute.
const TIMELINE_WINDOW_MS = 60 * 1000

interface Sample {
  'needs-approval': number
  waiting: number
  processing: number
  idle: number
}

function emptySample(): Sample {
  return { 'needs-approval': 0, waiting: 0, processing: 0, idle: 0 }
}

function relTime(ms: number | undefined): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function CommandCenter({
  worktrees,
  worktreeStatuses,
  worktreePendingTools,
  prStatuses,
  mergedPaths,
  lastActive,
  tailLines,
  terminalTabs,
  onClose,
  onSelect,
  isGroupCollapsed,
  onToggleGroup
}: CommandCenterProps): JSX.Element {
  const backend = useBackend()
  // Activity log for per-worktree mini timelines.
  const [log, setLog] = useState<ActivityLog>({})
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const data = await backend.getActivityLog()
        if (!cancelled) setLog(data)
      } catch {
        // ignore
      }
    }
    load()
    const t = setInterval(load, 3000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const terminalFont = useSettings().terminalFontFamily ||
    "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace"

  // Clock tick so timelines + relative times advance.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(t)
  }, [])

  // Aggregate counts right now.
  const counts = useMemo(() => {
    const c = emptySample()
    for (const wt of worktrees) {
      if (wt.isMain) continue
      if (mergedPaths[wt.path] || isPRMerged(prStatuses[wt.path])) continue
      const s = worktreeStatuses[wt.path] || 'idle'
      c[s] = (c[s] || 0) + 1
    }
    return c
  }, [worktrees, worktreeStatuses, prStatuses, mergedPaths])

  // Rolling 60-sample aggregate history for the top bar graph.
  const [history, setHistory] = useState<Sample[]>(() =>
    Array.from({ length: SAMPLE_COUNT }, () => emptySample())
  )
  const countsRef = useRef(counts)
  countsRef.current = counts
  useEffect(() => {
    const t = setInterval(() => {
      setHistory((prev) => {
        const next = prev.slice(1)
        next.push({ ...countsRef.current })
        return next
      })
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const maxBarTotal = useMemo(() => {
    let m = 1
    for (const s of history) {
      const t = s['needs-approval'] + s.waiting + s.processing + s.idle
      if (t > m) m = t
    }
    return m
  }, [history])

  // Distinct repos represented in the current worktree list, in first-seen
  // order. Used to decide when to show the unified/split toggle and to
  // render per-repo sections in split mode.
  const repoRoots = useMemo(() => {
    const seen: string[] = []
    for (const wt of worktrees) {
      if (!seen.includes(wt.repoRoot)) seen.push(wt.repoRoot)
    }
    return seen
  }, [worktrees])

  // Unified = one set of PR-status groups across all repos (default).
  // Split = each repo gets its own section with its own groups.
  // Shares the same localStorage key as the sidebar toggle so the user's
  // preference stays consistent across views.
  const [unifiedRepos, setUnifiedRepos] = useState<boolean>(() => {
    const saved = localStorage.getItem('harness:unifiedRepos')
    return saved === null ? true : saved === '1'
  })
  useEffect(() => {
    localStorage.setItem('harness:unifiedRepos', unifiedRepos ? '1' : '0')
  }, [unifiedRepos])

  // Group cards. In unified mode we pass the full worktree list through
  // `groupWorktrees` once; in split mode we bucket by repo first, then
  // group inside each bucket so every repo has its own "Active" section.
  interface Section {
    /** Stable scope for collapse state. `__unified__` in unified mode,
     *  otherwise the repoRoot. */
    scope: string
    /** Repo header text — empty string in unified mode. */
    repoLabel: string
    groups: ReturnType<typeof groupWorktrees>
  }
  const viewerLogin = useSettings().viewerLogin
  const snoozeByPath = useSnooze().byPath
  const snoozedPaths = useMemo(() => {
    const m: Record<string, true> = {}
    for (const p of Object.keys(snoozeByPath)) m[p] = true
    return m
  }, [snoozeByPath])
  const pinnedPaths = usePinned().byPath
  const sections = useMemo<Section[]>(() => {
    const group = (wts: Worktree[]): Section['groups'] =>
      groupWorktrees(wts, prStatuses, mergedPaths, snoozedPaths, viewerLogin, undefined, pinnedPaths)
    if (unifiedRepos || repoRoots.length <= 1) {
      return [{ scope: '__unified__', repoLabel: '', groups: group(worktrees) }]
    }
    // Split mode: pinned worktrees from every repo share one section above
    // the per-repo sections, rather than a Pinned group inside each repo.
    // It reuses the unified scope so its collapse state matches unified mode.
    const pinned: Worktree[] = []
    const byRepo = new Map<string, Worktree[]>()
    for (const root of repoRoots) byRepo.set(root, [])
    for (const wt of worktrees) {
      if (pinnedPaths[wt.path]) pinned.push(wt)
      else byRepo.get(wt.repoRoot)!.push(wt)
    }
    const repoSections = repoRoots
      .filter((root) => byRepo.get(root)!.length > 0)
      .map((root) => ({
        scope: root,
        repoLabel: root.split('/').pop() || root,
        groups: group(byRepo.get(root)!)
      }))
    if (pinned.length === 0) return repoSections
    return [{ scope: '__unified__', repoLabel: '', groups: group(pinned) }, ...repoSections]
  }, [unifiedRepos, repoRoots, worktrees, prStatuses, mergedPaths, snoozedPaths, viewerLogin, pinnedPaths])

  const totalCards = useMemo(
    () => sections.reduce((acc, s) => acc + s.groups.reduce((a, g) => a + g.worktrees.length, 0), 0),
    [sections]
  )

  const showRepoLabelOnCards = repoRoots.length > 1

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const pickTail = (wtPath: string): string => {
    const tabs = terminalTabs[wtPath] || []
    for (const t of tabs) {
      const line = tailLines[t.id]
      if (line && line.trim()) return line
    }
    return ''
  }

  const pickRecord = (wtPath: string): ActivityRecord | undefined => log[wtPath]

  const cardDisplay = (wt: Worktree): DisplayStatus => {
    if (mergedPaths[wt.path] || isPRMerged(prStatuses[wt.path])) return 'merged'
    return worktreeStatuses[wt.path] || 'idle'
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-bg">
      {/* Header */}
      <div className="drag-region px-4 py-4 border-b border-border flex items-start gap-6 shrink-0">
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-fg-bright tracking-tight no-drag">
            Command Center
          </h1>
          <p className="text-xs text-dim mt-0.5 no-drag">
            {totalCards} session{totalCards === 1 ? '' : 's'} · live view
          </p>
        </div>

        {/* Big counts */}
        <div className="flex items-center gap-4 no-drag">
          <StatCount
            label="Needs approval"
            value={counts['needs-approval']}
            dot="bg-danger"
            pulse={counts['needs-approval'] > 0}
          />
          <StatCount label="Waiting" value={counts.waiting} dot="bg-warning" />
          <StatCount label="Working" value={counts.processing} dot="bg-success" />
          <StatCount label="Idle" value={counts.idle} dot="bg-faint" />
        </div>

        {repoRoots.length > 1 && (
          <button
            onClick={() => setUnifiedRepos((v) => !v)}
            className="no-drag p-2 rounded hover:bg-surface text-muted hover:text-fg cursor-pointer"
            title={unifiedRepos ? 'Split by repo' : 'Merge repos into one list'}
          >
            {unifiedRepos ? <Rows3 className="icon-base" /> : <Layers className="icon-base" />}
          </button>
        )}

        <button
          onClick={onClose}
          className="no-drag p-2 rounded hover:bg-surface text-muted hover:text-fg cursor-pointer"
          title="Close (Esc)"
        >
          <X className="icon-base" />
        </button>
      </div>

      {/* Live stacked bar graph */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs uppercase tracking-wider text-faint">Last minute</span>
          <span className="text-xs text-faint">1s intervals</span>
        </div>
        <div className="h-16 flex items-end gap-[2px]">
          {history.map((s, i) => {
            const total = s['needs-approval'] + s.waiting + s.processing + s.idle
            const h = (total / maxBarTotal) * 100
            const seg = (n: number): string =>
              total === 0 ? '0%' : `${(n / total) * h}%`
            return (
              <div
                key={i}
                className="flex-1 flex flex-col-reverse justify-start min-w-0"
                style={{ height: '100%' }}
              >
                <div className={STATUS_BAR_FILL['needs-approval']} style={{ height: seg(s['needs-approval']) }} />
                <div className={STATUS_BAR_FILL.waiting} style={{ height: seg(s.waiting) }} />
                <div className={STATUS_BAR_FILL.processing} style={{ height: seg(s.processing) }} />
                <div className={STATUS_BAR_FILL.idle} style={{ height: seg(s.idle) }} />
              </div>
            )
          })}
        </div>
      </div>

      {/* Grouped grid of session cards */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
        {totalCards === 0 && (
          <div className="h-full flex items-center justify-center text-dim">
            No sessions yet — create a worktree to get started.
          </div>
        )}

        {sections.map((section) => (
          <div key={section.scope}>
            {section.repoLabel && (
              <div className="flex items-center gap-2 mb-5">
                <h2 className={`text-base font-semibold tracking-tight ${repoNameColor(section.repoLabel)}`}>
                  {section.repoLabel}
                </h2>
                <div className="flex-1 border-t border-border" />
              </div>
            )}
            <div className="space-y-6">
            {section.groups.map((group) => {
              const collapsedHere = isGroupCollapsed(section.scope, group.key)
              return (
                <section key={group.key}>
                  <button
                    onClick={() => onToggleGroup(section.scope, group.key)}
                    className="w-full flex items-center gap-2 mb-3 text-left text-muted hover:text-fg transition-colors cursor-pointer"
                  >
                    {collapsedHere
                      ? <ChevronRight className="icon-sm shrink-0" />
                      : <ChevronDown className="icon-sm shrink-0" />}
                    <h2 className="text-xs font-semibold uppercase tracking-wider">
                      {group.label}
                    </h2>
                    <span className="text-xs text-faint">{group.worktrees.length}</span>
                    <div className="flex-1 border-t border-border ml-2" />
                  </button>

                  {!collapsedHere && (
                    <div
                      className="grid gap-4"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
                    >
                      {group.worktrees.map((wt) => {
                        const display = cardDisplay(wt)
                        const pr = prStatuses[wt.path]
                        const tail = pickTail(wt.path)
                        const record = pickRecord(wt.path)
                        return (
                          <button
                            key={wt.path}
                            onClick={() => onSelect(wt.path)}
                            className={`text-left rounded-lg bg-surface hover:bg-surface-hover transition-colors flex flex-col cursor-pointer overflow-hidden ${STATUS_CARD_RING[display]}`}
                          >
                            <div className="px-4 pt-3 pb-2.5 flex flex-col gap-1 min-w-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                {showRepoLabelOnCards && (
                                  <>
                                    <span className={`text-xs truncate shrink ${repoNameColor(wt.repoRoot.split('/').pop() || wt.repoRoot)}`}>
                                      {wt.repoRoot.split('/').pop()}
                                    </span>
                                    <span className="text-faint shrink-0">/</span>
                                  </>
                                )}
                                <span className="text-sm font-semibold text-fg-bright truncate flex-1">
                                  {wt.branch}
                                </span>
                              </div>
                              {display === 'needs-approval' && worktreePendingTools[wt.path] && (
                                <div className="flex items-center gap-1.5 min-w-0 text-xs text-danger">
                                  <span className="font-semibold shrink-0">Waiting on:</span>
                                  <span className="truncate font-mono">
                                    {formatPendingTool(worktreePendingTools[wt.path] as PendingTool)}
                                  </span>
                                </div>
                              )}
                              <div className="flex items-center gap-2 min-w-0 text-xs">
                                <span
                                  className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[display]}`}
                                />
                                <span className="text-muted">{STATUS_LABEL[display]}</span>
                                <div className="flex-1" />
                                {pr && (
                                  <GitPullRequest
                                    className={`icon-xs ${pr.state === 'merged'
                                        ? 'text-accent'
                                        : pr.state === 'closed'
                                          ? 'text-danger'
                                          : pr.checksOverall === 'failure' || pr.hasConflict
                                            ? 'text-danger'
                                            : pr.checksOverall === 'pending'
                                              ? 'text-warning'
                                              : pr.checksOverall === 'success'
                                                ? 'text-success'
                                                : 'text-dim'}`} />
                                )}
                                <span className="text-faint">{relTime(lastActive[wt.path])}</span>
                              </div>
                            </div>

                            <div
                              className="border-t border-border/60 px-3 py-2 h-24 overflow-hidden flex flex-col justify-end"
                              style={{ backgroundColor: 'var(--color-app)' }}
                            >
                              <pre
                                className="text-xs leading-tight whitespace-pre-wrap break-all line-clamp-6"
                                style={{
                                  fontFamily: terminalFont,
                                  color: 'var(--color-fg-bright)'
                                }}
                              >
                                {tail || <span className="text-faint italic">no output yet</span>}
                              </pre>
                            </div>

                            <MiniTimeline record={record} now={now} />
                          </button>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function MiniTimeline({
  record,
  now
}: {
  record: ActivityRecord | undefined
  now: number
}): JSX.Element {
  const windowStart = now - TIMELINE_WINDOW_MS
  const span = now - windowStart
  const events = record?.events || []
  const segs = eventsToSegments(events, windowStart, now, record?.removedAt)
  return (
    <div className="relative h-6 overflow-hidden border-t border-border bg-faint/5 mt-auto">
      {segs.map((seg, i) => {
        if (seg.state === 'idle') return null
        const leftPct = ((seg.start - windowStart) / span) * 100
        const widthPct = ((seg.end - seg.start) / span) * 100
        if (widthPct <= 0) return null
        return (
          <div
            key={i}
            className={`absolute top-0 h-full ${STATE_COLOR[seg.state]}`}
            style={{
              left: `${leftPct}%`,
              width: `${Math.max(widthPct, 0.4)}%`
            }}
          />
        )
      })}
    </div>
  )
}

function StatCount({
  label,
  value,
  dot,
  pulse
}: {
  label: string
  value: number
  dot: string
  pulse?: boolean
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${dot} ${pulse ? 'animate-pulse' : ''}`} />
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums text-fg-bright">{value}</span>
        <span className="text-xs uppercase tracking-wider text-faint">{label}</span>
      </div>
    </div>
  )
}
