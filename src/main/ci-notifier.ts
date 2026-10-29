import type { PRStatus } from '../shared/state/prs'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import type { ChatDeliveryDeps } from './chat-delivery'
import { PrStatusWatcher } from './pr-status-watcher'
import { log } from './debug'

/** Identity of a failure. Statuses cached by an older build carry no
 *  headSha; falling back to the PR number still collapses a flapping
 *  check down to one message. */
function shaKeyFor(status: PRStatus): string {
  return status.headSha || `pr-${status.number}`
}

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

/** Subscribes to the store and injects a "CI is failing" message into a
 *  worktree's agent chat when its PR checks transition into failure.
 *
 *  Lives here rather than in PRPoller so the poller stays ignorant of chat
 *  sessions — it only knows how to fetch PR status and dispatch it.
 *
 *  The head commit is the identity of a failure: `handledSha` records the
 *  commit we last made a decision about, so a failure that flaps
 *  (failure → pending → failure on a re-run) notifies once while a fresh
 *  push that also fails notifies again. Deliberately NOT keyed on a
 *  transition in `checksOverall` — a push whose CI fails before the poller
 *  ever observes a non-failure state is still a new failure, and with
 *  multi-minute poll intervals that's the common case, not the edge.
 *
 *  Delivery wakes a slept chat tab when it has to — see `deliver`. */
export class CiNotifier extends PrStatusWatcher {
  private handledSha = new Map<string, string>()

  protected seed(path: string, status: PRStatus): void {
    // Claim an already-red commit so boot stays quiet until a NEW one
    // fails. Marking the path seen isn't enough on its own — the next
    // poll would read as a fresh failure.
    if (status.checksOverall === 'failure') {
      this.handledSha.set(path, shaKeyFor(status))
    }
  }

  protected forget(path: string): void {
    this.handledSha.delete(path)
  }

  protected consider(path: string, status: PRStatus, firstObservation: boolean): void {
    if (status.checksOverall !== 'failure') return

    const shaKey = shaKeyFor(status)
    if (this.handledSha.get(path) === shaKey) return
    // Claim the commit before deciding anything else, so there's exactly
    // one decision per head commit. That stops a poll landing during the
    // deferred delivery below from notifying twice, and bounds the
    // decline logging to one line per commit.
    this.handledSha.set(path, shaKey)

    if (firstObservation) {
      // Already red the first time we looked. Staying quiet here is what
      // keeps a launch from re-announcing every red PR in the workspace.
      log('ci-notifier', `skip ${path} @ ${shaKey}: already failing at first poll`)
      return
    }

    if (!this.isEnabled(path, 'ci')) {
      log('ci-notifier', `skip ${path} @ ${shaKey}: notifications off for this worktree`)
      return
    }

    this.deliver(path, buildCiFailureMessage(status), shaKey)
  }

  /** Hand the message to the shared chat router. A failure to deliver
   *  releases the commit claim so a later poll can retry — the tab may
   *  have been asleep mid-spawn, or the worktree may not have had a chat
   *  tab yet. */
  private deliver(worktreePath: string, message: string, shaKey: string): void {
    this.deliverLater(worktreePath, message, (result) => {
      if (!result.ok) {
        // No chat tab (terminal-only worktree) is not a problem to solve
        // here — the PR pane already shows the red checks.
        log('ci-notifier', `skip ${worktreePath} @ ${shaKey}: ${result.reason}`)
        this.handledSha.delete(worktreePath)
        return
      }
      if (result.woke) {
        log('ci-notifier', `woke tab=${result.sessionId} wt=${worktreePath} to report CI failure`)
      }
      log('ci-notifier', `notified ${result.sessionId} of CI failure on ${worktreePath} @ ${shaKey}`)
    })
  }
}
