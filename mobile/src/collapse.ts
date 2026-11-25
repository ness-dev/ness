// Port of renderer/hooks/useWorktreeCollapse.ts: same keys, same defaults
// (merged + snoozed start collapsed, new clients start split by repo), but
// persisted in AsyncStorage because there's no localStorage on native.
// Per-client layout, so not slice state.
import { useCallback, useEffect, useRef, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { GroupKey } from '../../src/shared/worktree-sort'

export interface CollapseState {
  pinnedOpenRepos: Record<string, boolean>
  unifiedRepos: boolean
  setUnifiedRepos: (fn: (v: boolean) => boolean) => void
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
  toggleGroup: (scope: string, key: GroupKey) => void
  togglePinnedOpen: (scope: string) => void
}

function defaultCollapsed(key: GroupKey): boolean {
  return key === 'merged' || key === 'snoozed'
}

const K_GROUPS = 'harness:collapsedGroups'
const K_PINNED = 'harness:pinnedOpenRepos'
const K_UNIFIED = 'harness:unifiedRepos'

export function useCollapse(): CollapseState {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [pinnedOpenRepos, setPinnedOpenRepos] = useState<Record<string, boolean>>({})
  const [unifiedRepos, setUnified] = useState(false)
  const loaded = useRef(false)

  useEffect(() => {
    void AsyncStorage.multiGet([K_GROUPS, K_PINNED, K_UNIFIED]).then((pairs) => {
      const m = Object.fromEntries(pairs)
      try {
        if (m[K_GROUPS]) setCollapsedGroups(JSON.parse(m[K_GROUPS]))
        if (m[K_PINNED]) setPinnedOpenRepos(JSON.parse(m[K_PINNED]))
      } catch {
        // corrupt entry: keep defaults
      }
      setUnified(m[K_UNIFIED] === '1')
      loaded.current = true
    })
  }, [])

  useEffect(() => {
    if (loaded.current) void AsyncStorage.setItem(K_GROUPS, JSON.stringify(collapsedGroups))
  }, [collapsedGroups])
  useEffect(() => {
    if (loaded.current) void AsyncStorage.setItem(K_PINNED, JSON.stringify(pinnedOpenRepos))
  }, [pinnedOpenRepos])
  useEffect(() => {
    if (loaded.current) void AsyncStorage.setItem(K_UNIFIED, unifiedRepos ? '1' : '0')
  }, [unifiedRepos])

  const isGroupCollapsed = useCallback(
    (scope: string, key: GroupKey): boolean => {
      const composite = `${scope}:${key}`
      if (composite in collapsedGroups) return collapsedGroups[composite]
      return defaultCollapsed(key)
    },
    [collapsedGroups]
  )
  const toggleGroup = useCallback((scope: string, key: GroupKey) => {
    const composite = `${scope}:${key}`
    setCollapsedGroups((prev) => {
      const current = composite in prev ? prev[composite] : defaultCollapsed(key)
      return { ...prev, [composite]: !current }
    })
  }, [])
  const togglePinnedOpen = useCallback((scope: string) => {
    setPinnedOpenRepos((prev) => ({ ...prev, [scope]: !prev[scope] }))
  }, [])

  return { pinnedOpenRepos, unifiedRepos, setUnifiedRepos: setUnified, isGroupCollapsed, toggleGroup, togglePinnedOpen }
}
