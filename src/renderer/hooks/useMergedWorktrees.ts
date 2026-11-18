// React face of `merge-backend-states.ts`. Thin on purpose: the merge is
// pure and cached at module level over there, so this hook only gathers
// the reactive inputs and hands back the shared result. Every caller —
// App and useWorktreeListModel — therefore receives the same object for
// the same inputs, and the merge runs once per change between them.
//
// It subscribes through the merge rather than to the raw backend states.
// Those change on every event from every backend, a streamed chat token
// included, and holding them re-rendered App per token. The merge hands
// back its previous result when an event changed nothing it reads, so
// useSyncExternalStore bails and the render never happens.

import { useCallback } from 'react'
import { useActiveBackend, useAllBackendStatesSelector, type BackendStateEntry } from '../store'
import { useFleetViewMode } from '../fleet-view'
import { getMergedWorktrees, type MergedWorktreeData } from '../merge-backend-states'

export type { MergedWorktree, MergedWorktreeData } from '../merge-backend-states'

export function useMergedWorktrees(): MergedWorktreeData {
  const viewMode = useFleetViewMode()
  const activeId = useActiveBackend().id
  const select = useCallback(
    (entries: readonly BackendStateEntry[]) => getMergedWorktrees(entries, viewMode, activeId),
    [viewMode, activeId]
  )
  return useAllBackendStatesSelector(select)
}

/** Every backend's worktrees whatever the view mode — what stays MOUNTED,
 *  as opposed to what the sidebar lists. Single mode filters the list to
 *  the active host; rendering workspaces from that filtered list unmounted
 *  every other host's worktrees on a chip switch and mounted them all back
 *  on the return trip. Switching back to Local remounted 38 worktrees and
 *  64 chat tabs at once, and the burst of file listings and scrollback
 *  replays it set off froze the main process for seconds. */
export function useFleetWorktrees(): MergedWorktreeData {
  const activeId = useActiveBackend().id
  const select = useCallback(
    (entries: readonly BackendStateEntry[]) => getMergedWorktrees(entries, 'merged', activeId),
    [activeId]
  )
  return useAllBackendStatesSelector(select)
}
