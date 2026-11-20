import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { GroupKey } from '../../shared/worktree-sort'

/** Per-client collapse / layout preferences for the worktree list. Renderer
 *  state by design (CLAUDE.md: per-viewer UI layout isn't slice state), but
 *  shared between the desktop sidebar and the touch picker so both surfaces
 *  honour the same expansion and the same unified-vs-split repo mode. */
export interface WorktreeCollapseState {
  collapsedGroups: Record<string, boolean>
  setCollapsedGroups: Dispatch<SetStateAction<Record<string, boolean>>>
  /** Projects kept expanded even when you're not in them. Every other
   *  project shows just its row unless it holds the active worktree. */
  pinnedOpenRepos: Record<string, boolean>
  unifiedRepos: boolean
  setUnifiedRepos: Dispatch<SetStateAction<boolean>>
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
  toggleGroup: (scope: string, key: GroupKey) => void
  togglePinnedOpen: (scope: string) => void
}

/** Merged and snoozed start collapsed — they're archives, not workspaces. */
function defaultCollapsed(key: GroupKey): boolean {
  return key === 'merged' || key === 'snoozed'
}

function loadFlagMap(key: string): Record<string, boolean> {
  try {
    const saved = localStorage.getItem(key)
    return saved ? JSON.parse(saved) : {}
  } catch {
    return {}
  }
}

export function useWorktreeCollapse(): WorktreeCollapseState {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() =>
    loadFlagMap('harness:collapsedGroups')
  )
  useEffect(() => {
    localStorage.setItem('harness:collapsedGroups', JSON.stringify(collapsedGroups))
  }, [collapsedGroups])

  // A new key on purpose: the old `harness:collapsedRepos` meant the
  // opposite (explicitly closed), so reading it here would invert intent.
  const [pinnedOpenRepos, setPinnedOpenRepos] = useState<Record<string, boolean>>(() =>
    loadFlagMap('harness:pinnedOpenRepos')
  )
  useEffect(() => {
    localStorage.setItem('harness:pinnedOpenRepos', JSON.stringify(pinnedOpenRepos))
  }, [pinnedOpenRepos])

  const [unifiedRepos, setUnifiedRepos] = useState<boolean>(() => {
    const saved = localStorage.getItem('harness:unifiedRepos')
    return saved === null ? true : saved === '1'
  })
  useEffect(() => {
    localStorage.setItem('harness:unifiedRepos', unifiedRepos ? '1' : '0')
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

  return {
    collapsedGroups,
    setCollapsedGroups,
    pinnedOpenRepos,
    unifiedRepos,
    setUnifiedRepos,
    isGroupCollapsed,
    toggleGroup,
    togglePinnedOpen
  }
}
