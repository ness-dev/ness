// React face of `merge-backend-states.ts`. Thin on purpose: the merge is
// pure and cached at module level over there, so this hook only gathers
// the three reactive inputs and hands back the shared result. Every
// caller — App and useWorktreeListModel — therefore receives the same
// object for the same inputs, and the merge runs once per change between
// them.

import { useActiveBackend, useAllBackendStates } from '../store'
import { useFleetViewMode } from '../fleet-view'
import { getMergedWorktrees, type MergedWorktreeData } from '../merge-backend-states'

export type { MergedWorktree, MergedWorktreeData } from '../merge-backend-states'

export function useMergedWorktrees(): MergedWorktreeData {
  const allBackends = useAllBackendStates()
  const viewMode = useFleetViewMode()
  const activeId = useActiveBackend().id
  return getMergedWorktrees(allBackends, viewMode, activeId)
}
