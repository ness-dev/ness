// Which of the two sidebar views is showing.
//
//   'single' — today's behavior, unchanged: the sidebar lists the active
//              backend's worktrees and the chip strip swaps the whole
//              list. The default, so existing workflows see nothing new
//              until they opt in.
//   'merged' — every backend's worktrees in one list, rows badged with
//              their origin, selection routing per-worktree.
//
// The chip strip is the switch: its "All" chip enters merged view, and
// clicking any host chip returns to single view of that host. The strip
// itself is permanent — merged view augments it, never replaces it.
//
// Deliberately a module-level external store, not React state or a
// settings slice:
//   - `useMergedWorktrees` (called from App and useWorktreeListModel),
//     the chip strip, and the backend-switch hotkeys all need the same
//     value; threading a prop through those call graphs is exactly the
//     churn that module stores avoid.
//   - It's a per-client VIEW preference, like sidebar widths — two
//     clients of the same workspace can validly differ — so per
//     CLAUDE.md it must not live in a shared slice. localStorage with
//     the same `harness:` prefix the other view prefs use.

import { useSyncExternalStore } from 'react'

export type FleetViewMode = 'single' | 'merged'

const STORAGE_KEY = 'harness:fleetView'

function load(): FleetViewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'merged' ? 'merged' : 'single'
  } catch {
    return 'single'
  }
}

let mode: FleetViewMode = load()
const listeners = new Set<() => void>()

export function getFleetViewMode(): FleetViewMode {
  return mode
}

export function setFleetViewMode(next: FleetViewMode): void {
  if (next === mode) return
  mode = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Persistence is best-effort; the session still works.
  }
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useFleetViewMode(): FleetViewMode {
  return useSyncExternalStore(subscribe, getFleetViewMode, getFleetViewMode)
}
