// Port of renderer/hooks/useWatchedQuery.ts over a NessClient: stale-
// while-revalidate per (cacheKey, client, worktree), refetch on the
// backend's `worktree:changedFilesInvalidated` signal (after asking it to
// watch via `worktree:watchChangedFiles`), plus a fallback poll.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NessClient } from '../ness'

const LIMIT = 100
const caches = new Map<string, Map<string, unknown>>()
function cache(key: string): Map<string, unknown> {
  let m = caches.get(key)
  if (!m) caches.set(key, (m = new Map()))
  return m
}

export interface WatchedQuery<T> {
  data: T | null
  loading: boolean
  error: string | null
  refresh: (opts?: { force?: boolean }) => void
}

export function useWatchedQuery<T>({
  client,
  worktreePath,
  cacheKey,
  fetcher,
  fallbackPollMs = 30000,
  revalidateOnFileChange = true,
  enabled = true
}: {
  client: NessClient
  worktreePath: string | null
  cacheKey: string
  fetcher: (path: string, opts: { force: boolean }) => Promise<T>
  fallbackPollMs?: number
  revalidateOnFileChange?: boolean
  /** False while the panel is collapsed: no fetches, no watch. */
  enabled?: boolean
}): WatchedQuery<T> {
  const ck = `${cacheKey}@${client.id}`
  const [data, setData] = useState<T | null>(() => (worktreePath ? ((cache(ck).get(worktreePath) as T) ?? null) : null))
  const [loading, setLoading] = useState(() => !!worktreePath && !cache(ck).has(worktreePath))
  const [error, setError] = useState<string | null>(null)
  const current = useRef(worktreePath)
  current.current = worktreePath
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher

  const refresh = useCallback(
    (opts: { force?: boolean } = {}) => {
      if (!worktreePath) return
      const path = worktreePath
      fetchRef
        .current(path, { force: opts.force ?? false })
        .then((r) => {
          const m = cache(ck)
          m.delete(path)
          m.set(path, r)
          while (m.size > LIMIT) m.delete(m.keys().next().value as string)
          if (current.current !== path) return
          setData(r)
          setError(null)
          setLoading(false)
        })
        .catch((e: unknown) => {
          if (current.current !== path) return
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        })
    },
    [worktreePath, ck]
  )

  // Show cached data for the new path immediately, then revalidate.
  useEffect(() => {
    if (!worktreePath) {
      setData(null)
      setLoading(false)
      return
    }
    const hit = cache(ck).get(worktreePath) as T | undefined
    setData(hit ?? null)
    setLoading(hit === undefined)
    if (enabled) refresh()
  }, [worktreePath, ck, enabled, refresh])

  useEffect(() => {
    if (!worktreePath || !enabled) return
    const interval = fallbackPollMs > 0 ? setInterval(() => refresh(), fallbackPollMs) : null
    let off: (() => void) | null = null
    if (revalidateOnFileChange) {
      client.sig('worktree:watchChangedFiles', worktreePath)
      off = client.transport.onSignal('worktree:changedFilesInvalidated', (path: unknown) => {
        if (path === worktreePath) refresh({ force: true })
      })
    }
    return () => {
      if (interval) clearInterval(interval)
      if (off) {
        off()
        client.sig('worktree:unwatchChangedFiles', worktreePath)
      }
    }
  }, [client, worktreePath, enabled, fallbackPollMs, revalidateOnFileChange, refresh])

  return { data, loading, error, refresh }
}
