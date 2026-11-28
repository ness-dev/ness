// The single most actionable thing about a worktree's PR, for the inbox.
// Shared so main can seed `inbox.prSeen` on first observation (see
// InboxDeriver) with exactly the fingerprint the renderer compares against.

import type { PRStatus } from './state/prs'

export type PrEventKind = 'merged' | 'ci-failed' | 'conflict' | 'changes-requested' | 'ready'

/** The single most actionable thing about a worktree's PR, or null.
 *  The fingerprint changes when the event is genuinely new (new head
 *  commit, new review), which is what makes a seen event come back. */
export function prEventFor(
  pr: PRStatus | null | undefined,
  locallyMerged: boolean
): { kind: PrEventKind; why: string; fingerprint: string } | null {
  if (!pr) return null
  if (pr.state === 'merged' || locallyMerged) {
    return { kind: 'merged', why: `PR #${pr.number} merged`, fingerprint: `merged:${pr.number}` }
  }
  if (pr.state === 'closed') return null
  const sha = pr.headSha ?? ''
  if (pr.checksOverall === 'failure') {
    const failing = pr.checks
      .filter((c) => c.state === 'failure' || c.state === 'error')
      .map((c) => c.name)
    const names = failing.slice(0, 2).join(', ') + (failing.length > 2 ? ` +${failing.length - 2}` : '')
    return {
      kind: 'ci-failed',
      why: names ? `CI failed: ${names}` : 'CI failed',
      fingerprint: `ci:${pr.number}:${sha}`
    }
  }
  if (pr.hasConflict) {
    return { kind: 'conflict', why: 'Merge conflict with base', fingerprint: `conflict:${pr.number}:${sha}` }
  }
  if (pr.reviewDecision === 'changes_requested') {
    const latest = [...pr.reviews]
      .filter((r) => r.state === 'CHANGES_REQUESTED')
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]
    return {
      kind: 'changes-requested',
      why: latest ? `Changes requested by ${latest.user}` : 'Changes requested',
      fingerprint: `changes:${pr.number}:${latest?.submittedAt ?? sha}`
    }
  }
  if (pr.reviewDecision === 'approved' && pr.checksOverall === 'success' && pr.state === 'open') {
    return { kind: 'ready', why: 'Approved and green, ready to merge', fingerprint: `ready:${pr.number}:${sha}` }
  }
  return null
}

/** Event kinds that block you. The rest (merged, ready) are good news:
 *  shown, but never counted toward the bell or the jump hotkey. */
export const BLOCKING_PR_EVENTS: ReadonlySet<PrEventKind> = new Set<PrEventKind>([
  'ci-failed',
  'conflict',
  'changes-requested'
])
