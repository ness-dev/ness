import type { AppState } from './state'
import type { NotifyMode } from './state/subscriptions'

// Who follows a worktree, derived on every read.
//
// Two kinds:
//   - explicit: a tab called subscribe_to_worktree. Stored in the
//     `subscriptions` slice, because nothing else records the intent.
//   - implicit: a rule over source data that already exists. Never
//     materialized as a subscription record — if the source fact goes away,
//     so does the subscription, with no cache to fall out of sync.
//
// Adding a new implicit listener means adding a rule to IMPLICIT_RULES, not
// writing subscription records from wherever the triggering event happens.

export type SubscriptionKind = 'explicit' | 'implicit'

export interface Subscriber {
  subscriberPath: string
  subscriberTabId: string
  targetPath: string
  kind: SubscriptionKind
  /** For implicit ones, the rule that produced it ('created-worktree'). */
  reason?: string
  mode: NotifyMode
  note?: string
  /** Stored id, for explicit subscriptions only. */
  explicitId?: string
  since: number
}

interface ImplicitRule {
  name: string
  /** Every target this rule makes someone follow. */
  targets: (state: AppState) => string[]
  subscribersOf: (state: AppState, targetPath: string) => Subscriber[]
  subscriptionsOfTab: (state: AppState, tabId: string) => Subscriber[]
}

/** The Chat tab that created a worktree follows it, quietly: routine
 *  updates are held for its next turn, urgent ones interrupt. */
const createdWorktree: ImplicitRule = {
  name: 'created-worktree',
  targets: (state) => Object.keys(state.origins.byPath),
  subscribersOf: (state, targetPath) => {
    const o = state.origins.byPath[targetPath]
    if (!o) return []
    return [
      {
        subscriberPath: o.creatorPath,
        subscriberTabId: o.creatorTabId,
        targetPath,
        kind: 'implicit',
        reason: 'created-worktree',
        mode: 'silent',
        since: o.createdAt
      }
    ]
  },
  subscriptionsOfTab: (state, tabId) => {
    const out: Subscriber[] = []
    for (const [targetPath, o] of Object.entries(state.origins.byPath)) {
      if (o.creatorTabId !== tabId) continue
      out.push({
        subscriberPath: o.creatorPath,
        subscriberTabId: tabId,
        targetPath,
        kind: 'implicit',
        reason: 'created-worktree',
        mode: 'silent',
        since: o.createdAt
      })
    }
    return out
  }
}

const IMPLICIT_RULES: readonly ImplicitRule[] = [createdWorktree]

/** One entry per subscriber tab. An explicit subscription shadows an
 *  implicit one for the same tab, which is how a tab changes the mode it
 *  gets an implicit subscription's updates in. */
function dedupe(list: Subscriber[], key: (s: Subscriber) => string): Subscriber[] {
  const seen = new Set<string>()
  const out: Subscriber[] = []
  for (const s of list) {
    const k = key(s)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

function fromExplicit(s: AppState['subscriptions']['list'][number]): Subscriber {
  return {
    subscriberPath: s.subscriberPath,
    subscriberTabId: s.subscriberTabId,
    targetPath: s.targetPath,
    kind: 'explicit',
    mode: s.mode ?? 'interrupt',
    ...(s.note ? { note: s.note } : {}),
    explicitId: s.id,
    since: s.createdAt
  }
}

export function subscribersOf(state: AppState, targetPath: string): Subscriber[] {
  const explicit = state.subscriptions.list
    .filter((s) => s.targetPath === targetPath)
    .map(fromExplicit)
  const implicit = IMPLICIT_RULES.flatMap((r) => r.subscribersOf(state, targetPath))
  return dedupe([...explicit, ...implicit], (s) => s.subscriberTabId).filter(
    // Following yourself would just echo your own progress back at you.
    (s) => s.subscriberPath !== targetPath
  )
}

export function subscriptionsOfTab(state: AppState, tabId: string): Subscriber[] {
  const explicit = state.subscriptions.list
    .filter((s) => s.subscriberTabId === tabId)
    .map(fromExplicit)
  const implicit = IMPLICIT_RULES.flatMap((r) => r.subscriptionsOfTab(state, tabId))
  return dedupe([...explicit, ...implicit], (s) => s.targetPath).filter(
    (s) => s.subscriberPath !== s.targetPath
  )
}

/** Every worktree at least one tab follows. */
export function followedTargets(state: AppState): Set<string> {
  const out = new Set(state.subscriptions.list.map((s) => s.targetPath))
  for (const r of IMPLICIT_RULES) for (const t of r.targets(state)) out.add(t)
  return out
}
