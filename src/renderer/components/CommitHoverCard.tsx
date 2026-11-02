import { useEffect, useState } from 'react'
import { GitCommitHorizontal } from 'lucide-react'
import { getBackendFor } from '../backend'
import { useBackendScope } from '../backend-scope'
import type { CommitMeta } from '../types'

interface CommitHoverCardProps {
  worktreePath: string
  /** Full SHA under the pointer. */
  sha: string
  /** Viewport coordinates of the hover, used to anchor the card. */
  anchor: { x: number; y: number }
}

const CARD_WIDTH = 380

// Process-wide cache so re-hovering the same commit is instant and we never
// double-fetch. Keyed by backend + worktree + SHA.
//
// The backend has to be in the key, not just the fetch: a worktree path is
// only unique WITHIN a backend, so two machines checking out the same repo
// at the same path would otherwise serve each other's commit metadata from
// this cache.
const metaCache = new Map<string, CommitMeta | null>()
const metaInflight = new Map<string, Promise<CommitMeta | null>>()

function cacheKey(backendId: string | null, cwd: string, sha: string): string {
  return `${backendId ?? ''}\x00${cwd}\x00${sha}`
}

function fetchMeta(
  backendId: string | null,
  cwd: string,
  sha: string
): Promise<CommitMeta | null> {
  const key = cacheKey(backendId, cwd, sha)
  if (metaCache.has(key)) return Promise.resolve(metaCache.get(key) ?? null)
  const existing = metaInflight.get(key)
  if (existing) return existing
  const p = getBackendFor(backendId)
    .getCommitMeta(cwd, sha)
    .then((m) => {
      metaCache.set(key, m)
      metaInflight.delete(key)
      return m
    })
    .catch(() => {
      metaInflight.delete(key)
      return null
    })
  metaInflight.set(key, p)
  return p
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const sec = Math.round((Date.now() - then) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`
  const mon = Math.round(day / 30)
  if (mon < 12) return `${mon} month${mon === 1 ? '' : 's'} ago`
  const yr = Math.round(mon / 12)
  return `${yr} year${yr === 1 ? '' : 's'} ago`
}

export function CommitHoverCard({ worktreePath, sha, anchor }: CommitHoverCardProps): JSX.Element | null {
  const backendId = useBackendScope()
  const key = cacheKey(backendId, worktreePath, sha)
  const [meta, setMeta] = useState<CommitMeta | null | undefined>(() =>
    metaCache.has(key) ? metaCache.get(key) : undefined
  )

  useEffect(() => {
    let cancelled = false
    if (metaCache.has(key)) {
      setMeta(metaCache.get(key))
      return
    }
    setMeta(undefined)
    void fetchMeta(backendId, worktreePath, sha).then((m) => {
      if (!cancelled) setMeta(m)
    })
    return () => {
      cancelled = true
    }
  }, [key, backendId, worktreePath, sha])

  // Show nothing until metadata resolves (avoids an empty flickering box) and
  // nothing if the commit couldn't be loaded.
  if (!meta) return null

  const left = Math.max(8, Math.min(anchor.x + 12, window.innerWidth - CARD_WIDTH - 8))
  // Prefer above the pointer (blame-style); flip below if there isn't room.
  const above = anchor.y > 160
  const top = above ? undefined : anchor.y + 18
  const bottom = above ? window.innerHeight - anchor.y + 8 : undefined
  const rel = relativeTime(meta.date)

  return (
    <div
      className="fixed z-[60] pointer-events-none bg-panel-raised border border-border-strong rounded-md shadow-lg px-3 py-2"
      style={{ left, top, bottom, width: CARD_WIDTH }}
    >
      <div className="flex items-center gap-1.5 text-xs font-mono text-faint mb-1">
        <GitCommitHorizontal className="icon-2xs text-accent shrink-0" />
        <span>{meta.shortHash}</span>
      </div>
      <div className="text-xs font-medium text-fg-bright line-clamp-2">{meta.subject}</div>
      <div className="text-xs text-faint mt-1 truncate">
        <span className="text-fg">{meta.author}</span>
        {rel && <span> · {rel}</span>}
      </div>
    </div>
  )
}
