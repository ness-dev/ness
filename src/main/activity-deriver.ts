import type { Store } from './store'
import type { AppState, StateEvent } from '../shared/state'
import type { ActivityActor, PtyStatus } from '../shared/state/terminals'
import { getLeaves } from '../shared/state/terminals'
import { isWorktreeMerged } from '../shared/state/prs'
import type { ActivityState } from './activity'
import { actorForState, recordActivity } from './activity'

const DEBOUNCE_MS = 30000

const STATUS_RANK: Record<PtyStatus | 'merged', number> = {
  idle: 0,
  processing: 1,
  waiting: 2,
  'needs-approval': 3,
  merged: 4
}

/** Aggregate the worst (highest-rank) status across the tabs of a worktree.
 * Mirrors the renderer's prior worktreeStatuses derivation. */
function aggregateWorktreeStatus(
  state: AppState,
  worktreePath: string
): PtyStatus {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return 'idle'
  const leaves = getLeaves(tree)
  let worst: PtyStatus = 'idle'
  for (const leaf of leaves) {
    for (const tab of leaf.tabs) {
      if (tab.type !== 'agent' && tab.type !== 'shell' && tab.type !== 'json-claude') continue
      const s = state.terminals.statuses[tab.id]
      if (!s) continue
      if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s
    }
  }
  return worst
}

/** Override pty status with 'merged' when the worktree's PR is merged or
 * closed locally. */
function effectiveActivityState(
  state: AppState,
  worktreePath: string
): ActivityState {
  if (isWorktreeMerged(state.prs, worktreePath)) return 'merged'
  return aggregateWorktreeStatus(state, worktreePath)
}

/** Subscribes to the store and writes derived activity (recordActivity log
 * entries + lastActive timestamps) without any renderer involvement.
 *
 * This is the only main-side module that *consumes* state across multiple
 * slices to derive a third thing. It reads from `terminals` (statuses,
 * panes) AND `prs` (mergedByPath, byPath state) to compute "what's the
 * effective state of worktree X right now?", then writes back to
 * `terminals.lastActive` AND to the activity log on disk.
 *
 * Before the state migration, this logic lived in App.tsx as a
 * `useEffect` that read `worktreeStatuses` + `mergedPaths` + `prStatuses`
 * and called `window.api.recordActivity`. Pulling it into main
 * eliminated (a) the dedup and debounce refs that were in the renderer
 * and (b) duplicated calls if there were ever multiple clients of the
 * same workspace. The trade-off is that "what triggers an activity log
 * entry" is now invisible from the renderer — if you're debugging
 * missing log entries, look here, not in App.tsx. */
export class ActivityDeriver {
  private store: Store
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private lastRecorded = new Map<string, ActivityState>()
  /** Actors seen since the last flush, so a human submit followed by an
   * agent reply inside one debounce window advances both timestamps. */
  private pendingActors = new Map<string, Set<ActivityActor>>()
  private unsubscribe: (() => void) | null = null

  constructor(store: Store) {
    this.store = store
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
    this.pendingActors.clear()
  }

  /** Decide which worktrees to re-derive based on the event type. */
  private onEvent(event: StateEvent): void {
    const state = this.store.getSnapshot().state
    if (
      event.type === 'terminals/statusChanged' ||
      event.type === 'terminals/shellActivityChanged'
    ) {
      // Find which worktree owns this terminal id and re-derive just that one.
      const id = event.payload.id
      const wtPath = this.findWorktreeForTerminal(state, id)
      if (wtPath) this.deriveAndRecord(wtPath)
      return
    }
    if (event.type === 'terminals/removed') {
      const wtPath = this.findWorktreeForTerminal(state, event.payload)
      if (wtPath) this.deriveAndRecord(wtPath)
      return
    }
    if (event.type === 'terminals/panesForWorktreeChanged') {
      this.deriveAndRecord(event.payload.worktreePath)
      return
    }
    if (event.type === 'terminals/panesForWorktreeCleared') {
      this.deriveAndRecord(event.payload)
      return
    }
    if (event.type === 'terminals/panesReplaced') {
      // Whole pane tree replaced wholesale — every worktree may have changed.
      for (const wtPath of Object.keys(state.terminals.panes)) {
        this.deriveAndRecord(wtPath)
      }
      return
    }
    if (event.type === 'prs/statusChanged') {
      this.deriveAndRecord(event.payload.path)
      return
    }
    if (event.type === 'prs/bulkStatusChanged') {
      for (const wtPath of Object.keys(event.payload)) {
        this.deriveAndRecord(wtPath)
      }
      return
    }
    if (event.type === 'prs/mergedChanged') {
      for (const wtPath of Object.keys(event.payload)) {
        this.deriveAndRecord(wtPath)
      }
      return
    }
  }

  private findWorktreeForTerminal(
    state: AppState,
    terminalId: string
  ): string | null {
    for (const [wtPath, tree] of Object.entries(state.terminals.panes)) {
      for (const leaf of getLeaves(tree)) {
        if (leaf.tabs.some((t) => t.id === terminalId)) return wtPath
      }
    }
    return null
  }

  private deriveAndRecord(wtPath: string): void {
    const state = this.store.getSnapshot().state
    const next = effectiveActivityState(state, wtPath)

    // Auto-unsnooze when the user submits a prompt in a snoozed worktree.
    // 'processing' is the only input-driven trigger — viewing output, raw
    // keystrokes, or non-snooze status transitions don't qualify. Run
    // before the dedup gate so we still clear the snooze entry on the
    // very first 'processing' tick.
    if (next === 'processing' && state.snooze.byPath[wtPath]) {
      this.store.dispatch({ type: 'snooze/clear', payload: wtPath })
    }

    // Dedup against the last derived state for this worktree. If nothing
    // changed, do nothing — that includes NOT refreshing lastActive.
    // Background polling (PR poller fires every 5min for every worktree
    // even when no PR changed) was previously bumping lastActive on every
    // tick, which kept the auto-sleep monitor from ever crossing its
    // threshold for chats sitting at 'waiting'.
    if (this.lastRecorded.get(wtPath) === next) return
    this.lastRecorded.set(wtPath, next)
    recordActivity(wtPath, next)

    const actor = actorForState(next)
    if (actor) {
      let set = this.pendingActors.get(wtPath)
      if (!set) {
        set = new Set()
        this.pendingActors.set(wtPath, set)
      }
      set.add(actor)
    }

    // Debounce lastActive updates per worktree (30s window). Consumers
    // (CommandCenter relative-time label, Cleanup sort, AutoSleepMonitor)
    // only need minute-level precision, so a relaxed window keeps this
    // event off the hot path.
    if (this.debounceTimers.has(wtPath)) return
    const timer = setTimeout(() => {
      this.debounceTimers.delete(wtPath)
      const actors = this.pendingActors.get(wtPath)
      this.pendingActors.delete(wtPath)
      this.store.dispatch({
        type: 'terminals/lastActiveChanged',
        payload: {
          worktreePath: wtPath,
          ts: Date.now(),
          actors: actors ? [...actors] : undefined
        }
      })
    }, DEBOUNCE_MS)
    this.debounceTimers.set(wtPath, timer)
  }
}
