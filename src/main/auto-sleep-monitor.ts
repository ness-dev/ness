import type { Store } from './store'
import type { PanesFSM } from './panes-fsm'
import { getLeaves } from '../shared/state/terminals'
import { hasRunningBackgroundTask } from '../shared/state/json-claude'
import { log } from './debug'

const SWEEP_INTERVAL_MS = 60_000

/** Sweeps the panes tree once a minute and sleeps json-mode tabs that
 *  have been sitting at the yellow 'waiting' dot longer than the
 *  configured threshold. A periodic timer is used (not a store
 *  subscription) so streaming events don't fan-out a sweep per token —
 *  see CLAUDE.md anti-pattern #1. */
export class AutoSleepMonitor {
  private store: Store
  private panesFSM: PanesFSM
  private timer: NodeJS.Timeout | null = null
  /** Tabs already logged as kept awake by background work, so the skip
   *  is logged once per stretch rather than every minute. */
  private keptAwake = new Set<string>()

  constructor(store: Store, panesFSM: PanesFSM) {
    this.store = store
    this.panesFSM = panesFSM
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** @internal exposed for tests. */
  sweep(now: number = Date.now()): void {
    const state = this.store.getSnapshot().state
    const minutes = state.settings.autoSleepMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) return
    const thresholdMs = minutes * 60_000
    for (const [wtPath, tree] of Object.entries(state.terminals.panes)) {
      const lastActive = state.terminals.lastActive[wtPath]
      if (typeof lastActive !== 'number') continue
      if (now - lastActive <= thresholdMs) continue
      for (const leaf of getLeaves(tree)) {
        for (const tab of leaf.tabs) {
          if (tab.type !== 'json-claude') continue
          if ((tab.mode ?? 'awake') !== 'awake') continue
          if (state.terminals.statuses[tab.id] !== 'waiting') continue
          // Skip the spawn-race window: a connecting session has fired
          // sessionStarted but not yet reached running, and killing it
          // mid-spawn would race the JsonClaudeManager's create().
          const session = state.jsonClaude.sessions[tab.id]
          if (session?.state === 'connecting') continue
          // A turn can end with a detached Agent or run_in_background
          // Bash still going; the tab reads 'waiting' but killing the
          // process would kill that work too. Bash counts because Claude
          // Code reports it through the same task_started/notification
          // pair (see json-claude-manager.ts).
          //
          // No upper bound, deliberately: a backgrounded dev server or
          // `tail -f` never settles, so its tab stays awake until the
          // process exits. Killing the user's server would be worse than
          // not sleeping. The cost is that a dropped task_notification
          // (a Claude Code bug or protocol change) pins the tab too —
          // hence the log line, so that's diagnosable from debug.log.
          if (session && hasRunningBackgroundTask(session)) {
            if (!this.keptAwake.has(tab.id)) {
              this.keptAwake.add(tab.id)
              log(
                'auto-sleep',
                `skip tab=${tab.id} wt=${wtPath}: running background task`
              )
            }
            continue
          }
          this.keptAwake.delete(tab.id)
          log(
            'auto-sleep',
            `sleep tab=${tab.id} wt=${wtPath} idleMs=${now - lastActive}`
          )
          this.panesFSM.sleepJsonClaudeTab(wtPath, tab.id)
        }
      }
    }
  }
}
