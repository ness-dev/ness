import type { Store } from './store'
import type { PRStatus } from '../shared/state/prs'
import { isCiNotifyEnabled } from '../shared/state/ci-notify'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import { deliverToWorktreeChat, type ChatDeliveryDeps } from './chat-delivery'
import { PrStatusWatcher } from './pr-status-watcher'
import { log } from './debug'


export type CiNotifierOptions = ChatDeliveryDeps

const MAX_LISTED_CHECKS = 10

/** Compose the message injected into the agent chat. Exported for tests. */
export function buildCiFailureMessage(pr: PRStatus): string {
  const failing = pr.checks.filter(
    (c) => c.state === 'failure' || c.state === 'error'
  )
  const lines = [
    `CI is failing on PR #${pr.number} (${pr.branch}). Please investigate and fix.`,
    ''
  ]
  if (failing.length === 0) {
    lines.push('No individual failing check was reported — see ' + pr.url)
  } else {
    lines.push('Failing checks:')
    for (const check of failing.slice(0, MAX_LISTED_CHECKS)) {
      const detail = check.description?.trim()
      const parts = [`- ${check.name}`]
      if (detail) parts.push(`: ${detail}`)
      if (check.detailsUrl) parts.push(` — ${check.detailsUrl}`)
      lines.push(parts.join(''))
    }
    if (failing.length > MAX_LISTED_CHECKS) {
      lines.push(`- …and ${failing.length - MAX_LISTED_CHECKS} more`)
    }
  }
  return wrapAutomatedMessage('ci-failure', lines.join('\n'))
}

/** Injects a "CI is failing" message into a worktree's agent chat when
 *  its PR checks go red. The once-per-head-commit dedup lives in
 *  PrStatusWatcher, which this configures; see there for why it works
 *  that way. */
export class CiNotifier {
  private watcher: PrStatusWatcher

  constructor(
    private store: Store,
    private opts: CiNotifierOptions
  ) {
    this.watcher = new PrStatusWatcher(store, {
      name: 'ci-notifier',
      on: 'failure',
      isEnabled: (path) => {
        const state = this.store.getSnapshot().state
        return isCiNotifyEnabled(state.ciNotify, path, state.settings.notifyChatOnCiFailure)
      },
      act: (path, status, shaKey) => this.deliver(path, buildCiFailureMessage(status), shaKey)
    })
  }

  start(): void {
    this.watcher.start()
  }

  stop(): void {
    this.watcher.stop()
  }

  /** Hand the message to the shared chat router. Returning false releases
   *  the commit claim so a later poll can retry — the tab may have been
   *  asleep mid-spawn, or the worktree may not have had a chat tab yet. */
  private deliver(worktreePath: string, message: string, shaKey: string): boolean {
    const state = this.store.getSnapshot().state
    const result = deliverToWorktreeChat(state, this.opts, worktreePath, message)
    if (!result.ok) {
      // No chat tab (terminal-only worktree) is not a problem to solve
      // here — the PR pane already shows the red checks.
      log('ci-notifier', `skip ${worktreePath} @ ${shaKey}: ${result.reason}`)
      return false
    }
    if (result.woke) {
      log('ci-notifier', `woke tab=${result.sessionId} wt=${worktreePath} to report CI failure`)
    }
    log('ci-notifier', `notified ${result.sessionId} of CI failure on ${worktreePath} @ ${shaKey}`)
    return true
  }
}
