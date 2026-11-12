import { useCallback, useEffect, useRef } from 'react'
import type { PaneNode } from '../types'
import { findLeafByTabId } from '../../shared/state/terminals'
import {
  emptyTabHistory,
  recordVisit,
  sameEntry,
  stepTabHistory,
  type TabHistoryEntry
} from '../tab-history'

// Mouse buttons 3/4 are the side "back"/"forward" buttons.
const BACK_BUTTON = 3
const FORWARD_BUTTON = 4
// A cross-worktree jump lands in two renders: the worktree switches at once,
// the pane's activeTabId follows after the panesSelectTab IPC round trip.
// Focus changes inside this window that aren't the target are those
// in-between states, not visits.
const SETTLE_MS = 1000

interface Options {
  activeWorktreeId: string | null
  focusedTabId: string | null
  panes: Record<string, PaneNode>
  setActiveWorktreeId: (path: string) => void
  selectTab: (worktreePath: string, paneId: string, tabId: string) => void
}

export function useTabHistory(opts: Options): { goBack: () => void; goForward: () => void } {
  const { activeWorktreeId, focusedTabId } = opts
  const optsRef = useRef(opts)
  optsRef.current = opts
  const historyRef = useRef(emptyTabHistory)
  const pendingRef = useRef<{ target: TabHistoryEntry; until: number } | null>(null)

  useEffect(() => {
    if (!activeWorktreeId || !focusedTabId) return
    const entry = { worktreePath: activeWorktreeId, tabId: focusedTabId }
    const pending = pendingRef.current
    if (pending) {
      if (sameEntry(pending.target, entry)) {
        pendingRef.current = null
        return
      }
      if (performance.now() < pending.until) return
      pendingRef.current = null
    }
    historyRef.current = recordVisit(historyRef.current, entry)
  }, [activeWorktreeId, focusedTabId])

  const navigate = useCallback((direction: -1 | 1): void => {
    const { panes, setActiveWorktreeId, selectTab } = optsRef.current
    const leafFor = (e: TabHistoryEntry) => {
      const tree = panes[e.worktreePath]
      return tree ? findLeafByTabId(tree, e.tabId) : null
    }
    const { history, target } = stepTabHistory(historyRef.current, direction, (e) => !!leafFor(e))
    historyRef.current = history
    const leaf = target && leafFor(target)
    if (!target || !leaf) return
    pendingRef.current = { target, until: performance.now() + SETTLE_MS }
    setActiveWorktreeId(target.worktreePath)
    selectTab(target.worktreePath, leaf.id, target.tabId)
  }, [])

  useEffect(() => {
    const isNavButton = (e: MouseEvent): boolean =>
      e.button === BACK_BUTTON || e.button === FORWARD_BUTTON
    const onMouseDown = (e: MouseEvent): void => {
      if (isNavButton(e)) e.preventDefault()
    }
    const onMouseUp = (e: MouseEvent): void => {
      if (!isNavButton(e)) return
      e.preventDefault()
      e.stopPropagation()
      navigate(e.button === BACK_BUTTON ? -1 : 1)
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mouseup', onMouseUp, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mouseup', onMouseUp, true)
    }
  }, [navigate])

  const goBack = useCallback(() => navigate(-1), [navigate])
  const goForward = useCallback(() => navigate(1), [navigate])
  return { goBack, goForward }
}
