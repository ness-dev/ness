import type { PRStatus } from '../shared/state/prs'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import { PrStatusWatcher, isPrOpen } from './pr-status-watcher'
import { buildMergeConflictMessage } from './merge-conflict-request'
import { log } from './debug'

/** A review or conversation comment, flattened so both can be ordered and
 *  rendered the same way. */
export interface PrFeedbackItem {
  kind: 'comment' | 'review'
  user: string
  body: string
  at: string
  url: string
  reviewState?: PRStatus['reviews'][number]['state']
  inlineCommentCount?: number
}

export function feedbackItems(status: PRStatus): PrFeedbackItem[] {
  const items: PrFeedbackItem[] = []
  for (const r of status.reviews) {
    items.push({
      kind: 'review',
      user: r.user,
      body: r.body,
      at: r.submittedAt,
      url: r.htmlUrl,
      reviewState: r.state,
      inlineCommentCount: r.inlineCommentCount
    })
  }
  for (const c of status.comments ?? []) {
    items.push({ kind: 'comment', user: c.user, body: c.body, at: c.createdAt, url: c.htmlUrl })
  }
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

function latestTimestamp(status: PRStatus): string {
  let latest = ''
  for (const item of feedbackItems(status)) {
    if (item.at > latest) latest = item.at
  }
  return latest
}

const MAX_LISTED_ITEMS = 10
const MAX_BODY_CHARS = 2000

function describe(item: PrFeedbackItem): string {
  if (item.kind === 'comment') return 'commented'
  switch (item.reviewState) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'requested changes'
    case 'DISMISSED':
      return 'left a review (since dismissed)'
    default:
      return 'reviewed'
  }
}

function quote(body: string): string {
  const trimmed = body.trim()
  const clipped =
    trimmed.length > MAX_BODY_CHARS ? `${trimmed.slice(0, MAX_BODY_CHARS)}…` : trimmed
  return clipped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function repoSlug(url: string): string | null {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)
  return m ? m[1] : null
}

/** Compose the message injected into the agent chat. Exported for tests. */
export function buildPrFeedbackMessage(pr: PRStatus, items: PrFeedbackItem[]): string {
  const lines = [`New feedback on PR #${pr.number} (${pr.branch}):`, '']
  for (const item of items.slice(0, MAX_LISTED_ITEMS)) {
    const inline = item.inlineCommentCount
      ? ` with ${item.inlineCommentCount} inline comment${item.inlineCommentCount === 1 ? '' : 's'}`
      : ''
    lines.push(`@${item.user} ${describe(item)}${inline} — ${item.url}`)
    if (item.body.trim()) lines.push(quote(item.body))
    lines.push('')
  }
  if (items.length > MAX_LISTED_ITEMS) {
    lines.push(`…and ${items.length - MAX_LISTED_ITEMS} more — see ${pr.url}`, '')
  }
  if (items.some((i) => i.inlineCommentCount)) {
    const slug = repoSlug(pr.url)
    lines.push(
      slug
        ? `Inline review comments aren't quoted here — read them with \`gh api repos/${slug}/pulls/${pr.number}/comments\`.`
        : `Inline review comments aren't quoted here — read them on ${pr.url}.`
    )
  }
  return wrapAutomatedMessage('pr-feedback', lines.join('\n').trimEnd())
}

/** Forwards new reviews and conversation comments from other people into a
 *  worktree's agent chat.
 *
 *  Keyed on a per-path timestamp watermark rather than a set of comment ids:
 *  the GraphQL query only returns the most recent page of each, so an id set
 *  would have to be pruned in step with that window anyway, and "newer than
 *  the newest thing we've already decided about" is all the notifier needs.
 *
 *  The viewer's own comments advance the watermark but are never forwarded —
 *  the agent posts to GitHub as the user, so forwarding them would echo the
 *  agent's own replies back at it. */
export class PrCommentNotifier extends PrStatusWatcher {
  private watermark = new Map<string, string>()

  protected seed(path: string, status: PRStatus): void {
    // A status from a build that didn't fetch comments can't establish a
    // baseline — every comment on the PR would look new on the next poll.
    if (status.comments === undefined) return
    this.watermark.set(path, latestTimestamp(status))
  }

  protected forget(path: string): void {
    this.watermark.delete(path)
  }

  protected consider(path: string, status: PRStatus, firstObservation: boolean): void {
    if (status.comments === undefined) return
    const previous = this.watermark.get(path)
    const latest = latestTimestamp(status)
    if (firstObservation || previous === undefined) {
      this.watermark.set(path, latest)
      return
    }
    if (latest <= previous) return
    this.watermark.set(path, latest)
    if (!isPrOpen(status)) return

    const self = this.store.getSnapshot().state.settings.viewerLogin ?? status.author?.login ?? null
    const fresh = feedbackItems(status).filter(
      (item) => item.at > previous && (self === null || item.user.toLowerCase() !== self.toLowerCase())
    )
    if (fresh.length === 0) return

    if (!this.isEnabled(path, 'comments')) {
      log('pr-notifier', `skip ${path}: ${fresh.length} new comment(s), notifications off`)
      return
    }

    this.deliverLater(path, buildPrFeedbackMessage(status, fresh), (result) => {
      if (!result.ok) {
        log('pr-notifier', `skip comments on ${path}: ${result.reason}`)
        // Roll back so the next poll retries — unless a later poll has
        // already moved past this batch, in which case rewinding would
        // re-send whatever it handled.
        if (this.watermark.get(path) === latest) this.watermark.set(path, previous)
        return
      }
      log(
        'pr-notifier',
        `notified ${result.sessionId} of ${fresh.length} new comment(s) on ${path}${result.woke ? ' (woke tab)' : ''}`
      )
    })
  }
}

/** Asks a worktree's agent to resolve conflicts when its PR starts
 *  conflicting with the base. Fires once per entry into the conflicted
 *  state: the claim is only released when GitHub reports the PR mergeable
 *  again, so pushes that leave it conflicted stay quiet. `null` (GitHub
 *  still computing mergeability) is treated as no information. */
export class MergeConflictNotifier extends PrStatusWatcher {
  private claimed = new Set<string>()

  protected seed(path: string, status: PRStatus): void {
    if (status.hasConflict === true) this.claimed.add(path)
  }

  protected forget(path: string): void {
    this.claimed.delete(path)
  }

  protected consider(path: string, status: PRStatus, firstObservation: boolean): void {
    if (status.hasConflict === false) {
      this.claimed.delete(path)
      return
    }
    if (status.hasConflict !== true) return
    if (this.claimed.has(path)) return
    this.claimed.add(path)

    if (firstObservation) {
      log('pr-notifier', `skip ${path}: already conflicting at first poll`)
      return
    }
    if (!isPrOpen(status)) return
    if (!this.isEnabled(path, 'conflicts')) {
      log('pr-notifier', `skip ${path}: conflict notifications off for this worktree`)
      return
    }

    this.deliverLater(path, buildMergeConflictMessage(status, true), (result) => {
      if (!result.ok) {
        log('pr-notifier', `skip conflict on ${path}: ${result.reason}`)
        this.claimed.delete(path)
        return
      }
      log(
        'pr-notifier',
        `asked ${result.sessionId} to resolve conflicts on ${path}${result.woke ? ' (woke tab)' : ''}`
      )
    })
  }
}
