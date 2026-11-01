// Which backend the enclosing subtree talks to.
//
// Multi-backend started as a *switch*: `BackendsRegistry` tracks one
// active id, and every slice hook plus every `useBackend()` method reads
// through it. That works while only one backend's worktrees are on
// screen, which was true as long as remotes lived behind a chip you had
// to select.
//
// It stops working the moment local and remote worktrees share one
// sidebar. App.tsx keeps EVERY worktree mounted (so PTYs survive
// switches), so with an active-routed backend a remote worktree's panes
// would read the local store and subscribe to the local transport's
// `terminal:data` — i.e. render the wrong data and then go silent.
//
// So routing becomes positional instead: a worktree's subtree declares
// which backend it belongs to, and `useBackend()` / `useAppState()`
// resolve it from context. `backend.ts:52` always anticipated this ("a
// seam for per-tree overrides later… without touching call sites") —
// which is why ~60 files calling `useBackend()` need no edit.
//
// Deliberately free of imports from `store.ts` and `backend.ts`: both of
// those import the scope hook, so anything flowing the other way would
// be a cycle.

import { createContext, useContext, type ReactNode } from 'react'

/** A registered backend id, or `null` for "whichever backend is active".
 *
 *  `null` is the default and preserves the original behavior, which is
 *  what app chrome wants: the sidebar, settings, and the add-backend
 *  flow aren't tied to one worktree. Only worktree-owned subtrees pin
 *  themselves to an id. */
export type BackendScopeId = string | null

const BackendScopeContext = createContext<BackendScopeId>(null)

/** Pins everything rendered inside to one backend. Wrap a worktree's
 *  workspace subtree in this and its panes read and write that backend
 *  regardless of which one the chip strip has selected. */
export function BackendScope({
  backendId,
  children
}: {
  backendId: BackendScopeId
  children: ReactNode
}): JSX.Element {
  return (
    <BackendScopeContext.Provider value={backendId}>{children}</BackendScopeContext.Provider>
  )
}

/** The backend id the calling component is scoped to, or `null` when it
 *  sits outside any `BackendScope` and should follow the active backend. */
export function useBackendScope(): BackendScopeId {
  return useContext(BackendScopeContext)
}
