import { useCallback, useEffect, useRef } from 'react'
import type { PaneNode } from '../types'
import { findLeafByTabId } from '../../shared/state/terminals'
import {
  emptyTabHistory,
  recordVisit,
  settleVisit,
  stepTabHistory,
  NAVIGATION_EXPIRY_MS,
  type PendingNavigation,
  type TabHistoryEntry
} from '../tab-history'

// Mouse buttons 3/4 are the side "back"/"forward" buttons.
const BACK_BUTTON = 3
const FORWARD_BUTTON = 4

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
  const pendingRef = useRef<PendingNavigation | null>(null)

  useEffect(() => {
    if (!activeWorktreeId || !focusedTabId) return
    const entry = { worktreePath: activeWorktreeId, tabId: focusedTabId }
    const { record, pending } = settleVisit(pendingRef.current, entry, performance.now())
    pendingRef.current = pending
    if (record) historyRef.current = recordVisit(historyRef.current, entry)
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
    pendingRef.current = { target, expiresAt: performance.now() + NAVIGATION_EXPIRY_MS }
    setActiveWorktreeId(target.worktreePath)
    selectTab(target.worktreePath, leaf.id, target.tabId)
  }, [])

  useEffect(() => {
    const isNavButton = (e: MouseEvent): boolean =>
      e.button === BACK_BUTTON || e.button === FORWARD_BUTTON
    // Swallowed on mousedown too: WorkspaceView focuses the pane under the
    // cursor on any mousedown, which would record a stray visit (and drop
    // forward history) just before the jump.
    const swallow = (e: MouseEvent): boolean => {
      if (!isNavButton(e)) return false
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    const onMouseDown = (e: MouseEvent): void => {
      swallow(e)
    }
    const onMouseUp = (e: MouseEvent): void => {
      if (swallow(e)) navigate(e.button === BACK_BUTTON ? -1 : 1)
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
