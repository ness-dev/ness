import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Trash2, AlertTriangle, GitPullRequest, CheckCircle2, Loader2, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import type { Worktree, PRStatus, ActivityLog, BranchCommit, ElectronAPI } from '../types'
import { isPRMerged } from '../../shared/state/prs'
import { useBackend } from '../backend'
import { useAliases } from '../store'

interface CleanupProps {
  onClose: () => void
  worktrees: Worktree[]
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  lastActive: Record<string, number>
  /** The backend hosting each worktree. The list spans every backend in
   *  fleet view, and asking the active one about a remote path gets a
   *  wrong answer from the wrong machine. */
  backendFor: (worktreePath: string) => ElectronAPI
  onBulkDelete: (
    paths: string[],
    force: boolean,
    onProgress?: (path: string, phase: 'start' | 'done') => void
  ) => Promise<void>
}

type AgeKey = '1d' | '3d' | '7d' | '14d' | '30d' | 'all'

const AGES: { id: AgeKey; label: string; ms: number | null }[] = [
  { id: '1d', label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { id: '3d', label: '3 days', ms: 3 * 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '14d', label: '14 days', ms: 14 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'any age', ms: null }
]

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

interface Candidate {
  worktree: Worktree
  lastActiveMs: number | null
  prState: PRStatus['state'] | null
  merged: boolean
  dirty: boolean
  /** False until the dirty sweep has actually answered for this worktree.
   *  `dirty: false` alone can't be trusted while the scan is in flight. */
  dirtyKnown: boolean
}

export function Cleanup({
  onClose,
  worktrees,
  prStatuses,
  mergedPaths,
  lastActive,
  backendFor,
  onBulkDelete
}: CleanupProps): JSX.Element {
  const backend = useBackend()
  const aliases = useAliases()
  const [ageKey, setAgeKey] = useState<AgeKey>('7d')
  const [repoFilter, setRepoFilter] = useState<string | null>(null) // null = all repos
  const [mergedOnly, setMergedOnly] = useState(false)
  const [includeDirty, setIncludeDirty] = useState(false)
  // Absent key = not scanned yet. Distinct from `false` (scanned, clean).
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({})
  // Answered with an error: no longer pending, but still not known clean.
  const [dirtyFailed, setDirtyFailed] = useState<Record<string, boolean>>({})
  const [activityLastTs, setActivityLastTs] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  // Paths the user has explicitly clicked; their selection state must survive
  // worktree refreshes and filter changes instead of being reset to the default.
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [deletingPaths, setDeletingPaths] = useState<Record<string, boolean>>({})
  const [deletedPaths, setDeletedPaths] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [commitsByPath, setCommitsByPath] = useState<Record<string, BranchCommit[] | 'loading' | 'error'>>({})
  // Frozen at mount so candidate filtering stays stable across renders —
  // otherwise each render produces a new `candidates` array, which re-runs
  // the selection-reset effect and wipes user checkbox clicks.
  const [now] = useState(() => Date.now())

  const eligible = useMemo(() => worktrees.filter((w) => !w.isMain), [worktrees])

  const repos = useMemo(() => {
    const set = new Set(eligible.map((w) => w.repoRoot))
    return [...set].sort()
  }, [eligible])

  // The dirty sweep asks git about every eligible worktree, which on a large
  // set is the most expensive thing this modal does. Two things keep it off
  // everything else's back: it runs at 'bulk' priority so the main process
  // dequeues it behind whatever panel the user is looking at, and its answers
  // land one at a time instead of behind a single Promise.all barrier, so the
  // list is usable long before the last worktree reports in.
  //
  // A path missing from dirtyMap means "not scanned yet", which is distinct
  // from "clean" — see the selection defaults below, which must not offer up
  // an unscanned worktree for deletion.
  //
  // Each path is asked about once per open, never per `worktrees` change.
  // The list legitimately changes while the modal is open — every deletion
  // from it is one — and rescanning the whole set each time multiplied the
  // sweep by the number of deletions. Requests can't be cancelled once sent,
  // so a re-run only ever adds the paths it hasn't asked about yet.
  const requestedDirty = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    for (const w of eligible) {
      if (requestedDirty.current.has(w.path)) continue
      requestedDirty.current.add(w.path)
      void backendFor(w.path)
        .isWorktreeDirty(w.path, { bulk: true })
        .then((d) => {
          if (!mounted.current) return
          setDirtyMap((prev) => ({ ...prev, [w.path]: d.git || d.scratchpad }))
        })
        .catch(() => {
          if (!mounted.current) return
          setDirtyFailed((prev) => ({ ...prev, [w.path]: true }))
        })
    }
  }, [eligible, backendFor])
  const scanningDirty = eligible.some(
    (w) => dirtyMap[w.path] === undefined && !dirtyFailed[w.path]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const log = await backend.getActivityLog()
        if (cancelled) return
        const lastTs: Record<string, number> = {}
        for (const [path, rec] of Object.entries(log as ActivityLog)) {
          // Only 'processing' proves the agent actually ran here. Waking a
          // chat session derives 'waiting' and auto-sleep derives 'idle',
          // so using the newest event of any kind resets a worktree's age
          // just from the user opening it.
          let ts: number | undefined
          for (let i = rec.events.length - 1; i >= 0; i--) {
            if (rec.events[i].s === 'processing') {
              ts = rec.events[i].t
              break
            }
          }
          ts ??= rec.createdAt
          if (ts !== undefined) lastTs[path] = ts
        }
        setActivityLastTs(lastTs)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [backend])

  const ageMs = AGES.find((a) => a.id === ageKey)!.ms

  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = []
    for (const w of eligible) {
      const lastMs = activityLastTs[w.path] ?? lastActive[w.path] ?? null
      const pr = prStatuses[w.path] ?? null
      const merged = !!mergedPaths[w.path] || isPRMerged(pr)
      const dirty = !!dirtyMap[w.path]

      if (repoFilter !== null && w.repoRoot !== repoFilter) continue
      if (ageMs !== null) {
        // "older than" means: last activity is older than threshold, OR no activity recorded.
        if (lastMs !== null && now - lastMs < ageMs) continue
      }
      if (mergedOnly && !merged) continue

      out.push({
        worktree: w,
        lastActiveMs: lastMs,
        prState: pr?.state ?? null,
        merged,
        dirty,
        dirtyKnown: dirtyMap[w.path] !== undefined
      })
    }
    out.sort((a, b) => {
      const aT = a.lastActiveMs ?? 0
      const bT = b.lastActiveMs ?? 0
      return aT - bT
    })
    return out
  }, [eligible, activityLastTs, lastActive, prStatuses, mergedPaths, dirtyMap, ageMs, mergedOnly, repoFilter, now])

  // Seed selection with defaults for candidates we haven't seen yet, and
  // deselect anything no longer visible so filtered-out worktrees can't be
  // accidentally deleted.
  useEffect(() => {
    const visiblePaths = new Set(candidates.map((c) => c.worktree.path))
    setSelected((prev) => {
      const next = { ...prev }
      for (const path of Object.keys(next)) {
        if (!visiblePaths.has(path)) next[path] = false
      }
      for (const c of candidates) {
        if (touched[c.worktree.path]) continue
        // `=== false` rather than `!c.dirty`: while the sweep is still running
        // an unscanned worktree reads as not-dirty, and defaulting those to
        // selected would arm the delete button over worktrees that may well
        // have uncommitted work. They tick on as each one is proven clean.
        next[c.worktree.path] = includeDirty ? true : c.dirtyKnown && !c.dirty
      }
      return next
    })
  }, [candidates, includeDirty, touched])

  const selectedPaths = useMemo(
    () => candidates.filter((c) => selected[c.worktree.path]).map((c) => c.worktree.path),
    [candidates, selected]
  )
  const selectedDirtyCount = useMemo(
    () => candidates.filter((c) => selected[c.worktree.path] && c.dirty).length,
    [candidates, selected]
  )

  const toggleOne = (path: string): void => {
    setSelected((prev) => ({ ...prev, [path]: !prev[path] }))
    setTouched((prev) => ({ ...prev, [path]: true }))
  }
  const toggleExpand = (path: string): void => {
    setExpanded((prev) => {
      const next = { ...prev, [path]: !prev[path] }
      return next
    })
    if (!commitsByPath[path]) {
      setCommitsByPath((prev) => ({ ...prev, [path]: 'loading' }))
      backendFor(path)
        .getBranchCommits(path)
        .then((commits) => {
          setCommitsByPath((prev) => ({ ...prev, [path]: commits }))
        })
        .catch(() => {
          setCommitsByPath((prev) => ({ ...prev, [path]: 'error' }))
        })
    }
  }
  const selectAll = (): void => {
    setSelected((prev) => {
      const next = { ...prev }
      for (const c of candidates) next[c.worktree.path] = true
      return next
    })
    setTouched((prev) => {
      const next = { ...prev }
      for (const c of candidates) next[c.worktree.path] = true
      return next
    })
  }
  const selectNone = (): void => {
    setSelected((prev) => {
      const next = { ...prev }
      for (const c of candidates) next[c.worktree.path] = false
      return next
    })
    setTouched((prev) => {
      const next = { ...prev }
      for (const c of candidates) next[c.worktree.path] = true
      return next
    })
  }

  const handleDelete = async (): Promise<void> => {
    if (selectedPaths.length === 0) return
    const selectedCandidates = candidates.filter((c) => selected[c.worktree.path])
    const listing = selectedCandidates
      .map((c) => `  - ${aliases.byPath[c.worktree.path] ?? (c.worktree.branch || basename(c.worktree.path))}`)
      .join('\n')
    const dirtyNote = selectedDirtyCount > 0
      ? `\n\n⚠ ${selectedDirtyCount} of these have uncommitted changes that will be lost.`
      : ''
    const ok = window.confirm(
      `Delete ${selectedPaths.length} worktree${selectedPaths.length === 1 ? '' : 's'}?\n\n${listing}${dirtyNote}\n\nThis cannot be undone.`
    )
    if (!ok) return
    setDeleting(true)
    setDeletingPaths({})
    setDeletedPaths({})
    try {
      await onBulkDelete(selectedPaths, selectedDirtyCount > 0, (path, phase) => {
        if (phase === 'start') {
          setDeletingPaths((prev) => ({ ...prev, [path]: true }))
        } else {
          setDeletingPaths((prev) => {
            const next = { ...prev }
            delete next[path]
            return next
          })
          setDeletedPaths((prev) => ({ ...prev, [path]: true }))
        }
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col h-full w-full bg-panel">
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Clean up worktrees
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-8">
          <p className="text-sm text-dim mb-6">
            Remove old worktrees in bulk. Age is measured from the last time Claude actually ran
            here — opening a worktree doesn&apos;t count.
          </p>

          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <span className="text-xs text-dim uppercase tracking-wider mr-2">Older than</span>
            {AGES.map((a) => (
              <button
                key={a.id}
                onClick={() => setAgeKey(a.id)}
                className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                  ageKey === a.id
                    ? 'bg-accent/25 text-fg-bright border border-accent/40'
                    : 'bg-surface/40 text-muted hover:text-fg border border-transparent'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>

          {repos.length > 1 && (
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <span className="text-xs text-dim uppercase tracking-wider mr-2">Repo</span>
              <button
                onClick={() => setRepoFilter(null)}
                className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                  repoFilter === null
                    ? 'bg-accent/25 text-fg-bright border border-accent/40'
                    : 'bg-surface/40 text-muted hover:text-fg border border-transparent'
                }`}
              >
                all
              </button>
              {repos.map((r) => (
                <button
                  key={r}
                  onClick={() => setRepoFilter(r)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                    repoFilter === r
                      ? 'bg-accent/25 text-fg-bright border border-accent/40'
                      : 'bg-surface/40 text-muted hover:text-fg border border-transparent'
                  }`}
                >
                  {basename(r)}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-4 mb-6 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer text-muted hover:text-fg">
              <input
                type="checkbox"
                checked={mergedOnly}
                onChange={(e) => setMergedOnly(e.target.checked)}
                className="cursor-pointer icon-base" />
              Only merged PRs
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-muted hover:text-fg">
              <input
                type="checkbox"
                checked={includeDirty}
                onChange={(e) => setIncludeDirty(e.target.checked)}
                className="cursor-pointer icon-base" />
              Include worktrees with uncommitted changes
            </label>
          </div>

          {loading && <div className="text-sm text-dim py-12 text-center">Loading…</div>}

          {!loading && candidates.length === 0 && (
            <div className="bg-app/50 border border-border rounded-xl p-12 text-center">
              <CheckCircle2 className="icon-xl mx-auto mb-3 text-success/80" />
              <div className="text-sm text-fg">Nothing to clean up</div>
              <div className="text-xs text-dim mt-1">
                No worktrees match the current filters.
              </div>
            </div>
          )}

          {!loading && candidates.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-dim flex items-center gap-2">
                  <span>
                    {candidates.length} match{candidates.length === 1 ? '' : 'es'} · {selectedPaths.length} selected
                  </span>
                  {scanningDirty && (
                    <span className="flex items-center gap-1 text-muted">
                      <Loader2 className="icon-2xs animate-spin" />
                      checking for uncommitted changes…
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <button
                    onClick={selectAll}
                    className="text-muted hover:text-fg-bright transition-colors cursor-pointer"
                  >
                    Select all
                  </button>
                  <button
                    onClick={selectNone}
                    className="text-muted hover:text-fg-bright transition-colors cursor-pointer"
                  >
                    Deselect all
                  </button>
                </div>
              </div>

              <div className="bg-app/50 border border-border rounded-xl overflow-hidden">
                {candidates.map((c) => {
                  const path = c.worktree.path
                  const isSelected = !!selected[path]
                  const isDeleting = !!deletingPaths[path]
                  const isDeleted = !!deletedPaths[path]
                  const isExpanded = !!expanded[path]
                  const pr = prStatuses[path]
                  const commits = commitsByPath[path]
                  const rowClickable = !deleting && !isDeleted
                  return (
                    <div
                      key={path}
                      className={`border-b border-border last:border-b-0 transition-colors ${
                        isDeleted
                          ? 'opacity-40'
                          : isDeleting
                          ? 'bg-danger/10'
                          : isSelected
                          ? 'bg-accent/5'
                          : ''
                      }`}
                    >
                      <div
                        className={`flex items-center gap-3 px-4 py-2.5 ${
                          rowClickable ? 'cursor-pointer hover:bg-surface/40' : ''
                        }`}
                        onClick={() => {
                          if (rowClickable) toggleOne(path)
                        }}
                      >
                        {isDeleting ? (
                          <Loader2 className="icon-sm text-danger animate-spin shrink-0" />
                        ) : isDeleted ? (
                          <CheckCircle2 className="icon-sm text-success/70 shrink-0" />
                        ) : (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleOne(path)}
                            onClick={(e) => e.stopPropagation()}
                            disabled={deleting}
                            className="cursor-pointer icon-base" />
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleExpand(path)
                          }}
                          disabled={deleting || isDeleted}
                          className="text-dim hover:text-fg transition-colors cursor-pointer shrink-0 disabled:opacity-40"
                          title={isExpanded ? 'Collapse' : 'Show details'}
                        >
                          {isExpanded ? <ChevronDown className="icon-sm" /> : <ChevronRight className="icon-sm" />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-mono text-fg truncate">
                              {aliases.byPath[c.worktree.path] ?? (c.worktree.branch || basename(path))}
                            </span>
                            {c.merged && (
                              <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-success/15 text-success border border-success/30">
                                <GitPullRequest className="icon-2xs" />
                                merged
                              </span>
                            )}
                            {c.prState === 'open' && (
                              <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-info/15 text-info border border-info/30">
                                <GitPullRequest className="icon-2xs" />
                                open PR
                              </span>
                            )}
                            {c.prState === 'closed' && !c.merged && (
                              <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-faint/15 text-dim border border-border">
                                closed PR
                              </span>
                            )}
                            {c.dirty && (
                              <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30">
                                <AlertTriangle className="icon-2xs" />
                                uncommitted
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-dim font-mono truncate mt-0.5">
                            {path}
                          </div>
                        </div>
                        <div className="text-xs tabular-nums shrink-0">
                          {isDeleting ? (
                            <span className="text-danger">deleting…</span>
                          ) : isDeleted ? (
                            <span className="text-success/70">deleted</span>
                          ) : (
                            <span className="text-dim">
                              {c.lastActiveMs === null
                                ? 'no activity recorded'
                                : formatAge(now - c.lastActiveMs)}
                            </span>
                          )}
                        </div>
                      </div>
                      {isExpanded && !isDeleted && (
                        <div className="px-4 pb-3 pl-[4.25rem] space-y-3 border-t border-border/50 bg-app/30">
                          {pr && (
                            <div className="pt-3">
                              <div className="text-xs uppercase tracking-wider text-dim mb-1">
                                Pull request
                              </div>
                              <div className="flex items-start gap-2">
                                <span className="text-sm text-fg">
                                  #{pr.number} {pr.title}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    backend.openExternal(pr.url)
                                  }}
                                  className="text-dim hover:text-fg-bright transition-colors cursor-pointer shrink-0 mt-0.5"
                                  title="Open on GitHub"
                                >
                                  <ExternalLink className="icon-xs" />
                                </button>
                              </div>
                            </div>
                          )}
                          <div className={pr ? '' : 'pt-3'}>
                            <div className="text-xs uppercase tracking-wider text-dim mb-1">
                              Recent commits
                            </div>
                            {commits === 'loading' && (
                              <div className="text-xs text-dim">Loading…</div>
                            )}
                            {commits === 'error' && (
                              <div className="text-xs text-danger">Failed to load commits</div>
                            )}
                            {Array.isArray(commits) && commits.length === 0 && (
                              <div className="text-xs text-dim">No commits on this branch</div>
                            )}
                            {Array.isArray(commits) && commits.length > 0 && (
                              <div className="space-y-1">
                                {commits.slice(0, 5).map((commit) => (
                                  <div key={commit.hash} className="flex items-baseline gap-2 text-xs">
                                    <span className="font-mono text-dim tabular-nums shrink-0">
                                      {commit.shortHash}
                                    </span>
                                    <span className="text-fg truncate">{commit.subject}</span>
                                    <span className="text-dim shrink-0 ml-auto">
                                      {commit.relativeDate}
                                    </span>
                                  </div>
                                ))}
                                {commits.length > 5 && (
                                  <div className="text-xs text-dim">
                                    +{commits.length - 5} more
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="flex items-center justify-end gap-3 mt-5">
                {selectedDirtyCount > 0 && (
                  <span className="text-xs text-warning flex items-center gap-1.5">
                    <AlertTriangle className="icon-xs" />
                    {selectedDirtyCount} with uncommitted changes
                  </span>
                )}
                <button
                  onClick={handleDelete}
                  disabled={selectedPaths.length === 0 || deleting}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-danger/20 border border-danger/40 text-danger text-sm font-medium hover:bg-danger/30 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 className="icon-sm" />
                  {deleting
                    ? 'Deleting…'
                    : `Delete ${selectedPaths.length || ''} worktree${selectedPaths.length === 1 ? '' : 's'}`.trim()}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
