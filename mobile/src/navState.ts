// Which worktree the phone was last on, and which tab it last chose in
// each worktree. Per-client UI focus (never slice state), persisted so a
// relaunch lands where you left off — a phone app is relaunched constantly,
// unlike the web client, which starts at worktrees[0] on every load.
//
// The tab lives here rather than in the route: the tools panel and the
// picker change it from other screens, and a route param would go stale
// under them. A `?tab=` on a worktree link is applied on arrival.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'
import type { TerminalTab } from '../../src/shared/state/terminals'
import { pickInitialTab } from './tabs'

const K_ACTIVE = 'ness.mobile.activeWorktree'
const K_TABS = 'ness.mobile.selectedTabs'

let lastWorktree: string | null = null
let tabs: Record<string, string> = {}
let loaded = false
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())

export const navStateLoaded: Promise<void> = AsyncStorage.multiGet([K_ACTIVE, K_TABS])
  .then((pairs) => {
    const m = Object.fromEntries(pairs)
    lastWorktree = m[K_ACTIVE] ?? null
    try {
      tabs = { ...(m[K_TABS] ? JSON.parse(m[K_TABS]) : {}), ...tabs }
    } catch {
      // ignore a corrupt entry
    }
  })
  .catch(() => {})
  .finally(() => {
    loaded = true
    emit()
  })

export function getLastWorktree(): string | null {
  return lastWorktree
}

export function setLastWorktree(path: string): void {
  if (lastWorktree === path) return
  lastWorktree = path
  void AsyncStorage.setItem(K_ACTIVE, path)
}

export function rememberTab(worktreePath: string, tabId: string): void {
  if (tabs[worktreePath] === tabId) return
  tabs = { ...tabs, [worktreePath]: tabId }
  void AsyncStorage.setItem(K_TABS, JSON.stringify(tabs))
  emit()
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useNavStateLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => loaded)
}

/** The tab the phone shows for a worktree: the remembered choice while it
 *  still exists, else pickInitialTab's default. */
export function useSelectedTabId(worktreePath: string | null, worktreeTabs: readonly TerminalTab[]): string | null {
  const remembered = useSyncExternalStore(subscribe, () => (worktreePath ? tabs[worktreePath] : undefined))
  if (!worktreePath) return null
  if (remembered && worktreeTabs.some((t) => t.id === remembered)) return remembered
  return pickInitialTab(worktreeTabs)
}
