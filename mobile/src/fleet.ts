// Every enabled backend projected into the same `BackendStateLike[]` the
// desktop renderer feeds `getMergedWorktrees`, so the worktree list, its
// cross-host repo merging and its grouping come from the renderer's own
// pure model code rather than a re-implementation.
//
// Reference stability is the whole game (same as the desktop's
// SegmentedSelector): `entries` is a new array only when some backend's
// AppState object actually changed, and getMergedWorktrees /
// buildWorktreeListBase hand back previous results when nothing they read
// moved — so a streamed token on one chat doesn't rebuild the list.
import { useMemo, useSyncExternalStore } from 'react'
import type { AppState } from '../../src/shared/state'
import { getMergedWorktrees, type BackendStateLike, type MergedWorktreeData } from '../../src/renderer/merge-backend-states'
import {
  applyProjectAccordion,
  buildWorktreeListBase,
  type WorktreeListModel
} from '../../src/renderer/worktree-list-model'
import type { NessClient } from './ness'
import type { CollapseState } from './collapse'

export class Fleet {
  private entries: readonly BackendStateLike[] = []
  private listeners = new Set<() => void>()
  private unsubs: (() => void)[] = []
  private clients: NessClient[] = []

  setClients(clients: NessClient[]): void {
    if (sameList(clients, this.clients)) return
    for (const u of this.unsubs) u()
    this.clients = clients
    this.unsubs = clients.map((c) => c.subscribe(() => this.refresh()))
    this.refresh(true)
  }

  getClients = (): NessClient[] => this.clients
  getEntries = (): readonly BackendStateLike[] => this.entries

  client(id: string | undefined): NessClient | undefined {
    return this.clients.find((c) => c.id === id)
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private refresh(force = false): void {
    // A backend with no snapshot yet contributes nothing (its state is
    // initialState); including it would just add empty sections.
    const next = this.clients
      .filter((c) => c.getConn().hasSnapshot)
      .map((c) => ({ backendId: c.id, label: c.label, kind: 'remote' as const, state: c.getState() }))
    const prev = this.entries
    const unchanged =
      !force &&
      next.length === prev.length &&
      next.every((e, i) => e.backendId === prev[i].backendId && e.state === prev[i].state)
    if (unchanged) return
    this.entries = next
    for (const l of this.listeners) l()
  }
}

function sameList(a: NessClient[], b: NessClient[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i])
}

export function useFleetEntries(fleet: Fleet): readonly BackendStateLike[] {
  return useSyncExternalStore(fleet.subscribe, fleet.getEntries)
}

/** Fleet view is always 'merged' on the phone: there's no backend chip
 *  strip, every enabled host is listed at once. */
export function useMerged(fleet: Fleet): MergedWorktreeData {
  return mergedFor(useFleetEntries(fleet))
}

export function mergedFor(entries: readonly BackendStateLike[]): MergedWorktreeData {
  return getMergedWorktrees(entries, 'merged', entries[0]?.backendId ?? '')
}

/** The worktree list the picker shows, as a plain function: the base
 *  build on merged inputs (same as useWorktreeListModel in
 *  renderer/hooks/useWorktreeListModel.ts), then the accordion pass. The
 *  hook below memoizes the two steps; the contract test calls this. */
export function listModelFor(
  entries: readonly BackendStateLike[],
  merged: MergedWorktreeData,
  collapse: Pick<CollapseState, 'unifiedRepos' | 'isGroupCollapsed' | 'pinnedOpenRepos'>,
  activeWorktreeId: string | null
): WorktreeListModel {
  return applyProjectAccordion(listBaseFor(entries, merged, collapse), activeWorktreeId, collapse.pinnedOpenRepos)
}

function listBaseFor(
  entries: readonly BackendStateLike[],
  merged: MergedWorktreeData,
  collapse: Pick<CollapseState, 'unifiedRepos' | 'isGroupCollapsed'>
): WorktreeListModel {
  return buildWorktreeListBase({
    worktrees: merged.flatWorktrees,
    repoRoots: merged.repoRoots,
    repoBackendId: merged.repoBackendId,
    repoRemotes: merged.repoRemotes,
    pendingWorktrees: merged.pendingWorktrees,
    pendingDeletions: merged.pendingDeletions,
    tabsByWorktree: merged.tabsByWorktree,
    statuses: merged.statuses,
    pendingTools: merged.pendingTools,
    shellActivity: merged.shellActivity,
    prStatuses: merged.prStatuses,
    mergedPaths: merged.mergedPaths,
    snoozeByPath: merged.snoozeByPath,
    pinnedPaths: merged.pinnedPaths,
    aliases: merged.aliases,
    viewerLogin: entries[0]?.state.settings.viewerLogin ?? null,
    assignedPRsByRepo: merged.assignedPRsByRepo,
    unifiedRepos: collapse.unifiedRepos,
    isGroupCollapsed: collapse.isGroupCollapsed,
    // Touch doesn't bind Cmd+N, same as MobileApp's picker.
    assignOrdinals: false,
    projectOrder: entries[0]?.state.settings.sidebarProjectOrder
  })
}

export function useListModel(
  fleet: Fleet,
  merged: MergedWorktreeData,
  collapse: CollapseState,
  activeWorktreeId: string | null
): WorktreeListModel {
  const entries = useFleetEntries(fleet)
  const viewerLogin = entries[0]?.state.settings.viewerLogin ?? null
  const projectOrder = entries[0]?.state.settings.sidebarProjectOrder
  const { unifiedRepos, isGroupCollapsed, pinnedOpenRepos } = collapse
  const base = useMemo(
    () => listBaseFor(entries, merged, { unifiedRepos, isGroupCollapsed }),
    // entries is read only for viewerLogin / projectOrder (listed instead,
    // so a streamed token on one chat doesn't rebuild the list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [merged, viewerLogin, unifiedRepos, isGroupCollapsed, projectOrder]
  )
  return useMemo(
    () => applyProjectAccordion(base, activeWorktreeId, pinnedOpenRepos),
    [base, activeWorktreeId, pinnedOpenRepos]
  )
}

/** Read one slice value from whichever backend owns `path`. */
export function stateFor(fleet: Fleet, merged: MergedWorktreeData, path: string): AppState | undefined {
  return fleet.client(merged.pathBackendId[path])?.getState()
}
