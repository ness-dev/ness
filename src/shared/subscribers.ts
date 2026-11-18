import type { AppState } from './state'
import type { NotifyMode } from './state/subscriptions'
import { isCiNotifyEnabled } from './state/ci-notify'
import { findTabInWorktree, pickAuthorTab } from './agent-tabs'

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

/** What a subscriber hears about: `pr` is GitHub state (PR, CI, reviews,
 *  conflicts), `progress` is report_progress from the agent there. */
export type SubscriptionTopic = 'pr' | 'progress'

export interface Subscriber {
  subscriberPath: string
  subscriberTabId: string
  targetPath: string
  kind: SubscriptionKind
  /** For implicit ones, the rule that produced it. */
  reason?: 'created-worktree' | 'own-worktree'
  mode: NotifyMode
  topics: readonly SubscriptionTopic[]
  /** Agent-to-agent subscriptions only exist while worktree messaging is
   *  on; the own-worktree rule has its own setting and doesn't. */
  needsMessaging: boolean
  note?: string
  /** Stored id, for explicit subscriptions only. */
  explicitId?: string
  since: number
}

const ALL_TOPICS: readonly SubscriptionTopic[] = ['pr', 'progress']
const PR_ONLY: readonly SubscriptionTopic[] = ['pr']

interface ImplicitRule {
  /** Every target this rule makes someone follow. */
  targets: (state: AppState) => string[]
  subscribersOf: (state: AppState, targetPath: string) => Subscriber[]
  subscriptionsOfTab: (state: AppState, tabId: string) => Subscriber[]
}

/** The Chat tab that created a worktree follows it, quietly: routine
 *  updates are held for its next turn, urgent ones interrupt. Only while
 *  that tab still exists — closing it ends the follow, with no record to
 *  clean up, because the follow was never stored. */
const createdWorktree: ImplicitRule = {
  targets: (state) =>
    Object.entries(state.origins.byPath)
      .filter(([, o]) => creatorTabAlive(state, o))
      .map(([path]) => path),
  subscribersOf: (state, targetPath) => {
    const o = state.origins.byPath[targetPath]
    return o && creatorTabAlive(state, o) ? [fromOrigin(targetPath, o)] : []
  },
  subscriptionsOfTab: (state, tabId) =>
    Object.entries(state.origins.byPath)
      .filter(([, o]) => o.creatorTabId === tabId && creatorTabAlive(state, o))
      .map(([targetPath, o]) => fromOrigin(targetPath, o))
}

function creatorTabAlive(state: AppState, o: AppState['origins']['byPath'][string]): boolean {
  return findTabInWorktree(state, o.creatorPath, o.creatorTabId)?.type === 'json-claude'
}

function fromOrigin(
  targetPath: string,
  o: AppState['origins']['byPath'][string]
): Subscriber {
  return {
    subscriberPath: o.creatorPath,
    subscriberTabId: o.creatorTabId,
    targetPath,
    kind: 'implicit',
    reason: 'created-worktree',
    mode: 'silent',
    topics: ALL_TOPICS,
    needsMessaging: true,
    since: o.createdAt
  }
}

/** A worktree's own agent follows its own PR, when the user has turned
 *  that on (the "tell the agent when CI fails" setting, globally or per
 *  worktree). This is how GitHub notifications reach the agent working on
 *  the branch: the same change detection and delivery modes as any other
 *  subscriber, with routine updates held and failures interrupting. */
const ownWorktree: ImplicitRule = {
  targets: (state) =>
    state.worktrees.list
      .map((w) => w.path)
      .filter((p) => ownWorktreeEnabled(state, p) && pickAuthorTab(state, p) !== null),
  subscribersOf: (state, targetPath) => {
    if (!ownWorktreeEnabled(state, targetPath)) return []
    const tabId = pickAuthorTab(state, targetPath)
    return tabId ? [fromOwn(targetPath, tabId)] : []
  },
  subscriptionsOfTab: (state, tabId) =>
    state.worktrees.list
      .map((w) => w.path)
      .filter((p) => ownWorktreeEnabled(state, p) && pickAuthorTab(state, p) === tabId)
      .map((p) => fromOwn(p, tabId))
}

function ownWorktreeEnabled(state: AppState, worktreePath: string): boolean {
  return isCiNotifyEnabled(state.ciNotify, worktreePath, state.settings.notifyChatOnCiFailure)
}

function fromOwn(targetPath: string, tabId: string): Subscriber {
  return {
    subscriberPath: targetPath,
    subscriberTabId: tabId,
    targetPath,
    kind: 'implicit',
    reason: 'own-worktree',
    mode: 'silent',
    topics: PR_ONLY,
    needsMessaging: false,
    since: 0
  }
}

const IMPLICIT_RULES: readonly ImplicitRule[] = [createdWorktree, ownWorktree]

/** One entry per key. An explicit subscription shadows an implicit one for
 *  the same tab, which is how a tab changes the mode it gets an implicit
 *  subscription's updates in. */
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
    topics: ALL_TOPICS,
    needsMessaging: true,
    ...(s.note ? { note: s.note } : {}),
    explicitId: s.id,
    since: s.createdAt
  }
}

/** Everyone following `targetPath`, optionally only those who hear about
 *  `topic`. */
export function subscribersOf(
  state: AppState,
  targetPath: string,
  topic?: SubscriptionTopic
): Subscriber[] {
  const explicit = state.subscriptions.list
    .filter((s) => s.targetPath === targetPath)
    .map(fromExplicit)
  const implicit = IMPLICIT_RULES.flatMap((r) => r.subscribersOf(state, targetPath))
  const all = dedupe([...explicit, ...implicit], (s) => s.subscriberTabId)
  return topic ? all.filter((s) => s.topics.includes(topic)) : all
}

export function subscriptionsOfTab(state: AppState, tabId: string): Subscriber[] {
  const explicit = state.subscriptions.list
    .filter((s) => s.subscriberTabId === tabId)
    .map(fromExplicit)
  const implicit = IMPLICIT_RULES.flatMap((r) => r.subscriptionsOfTab(state, tabId))
  return dedupe([...explicit, ...implicit], (s) => s.targetPath)
}

/** Every worktree at least one tab follows. */
export function followedTargets(state: AppState): Set<string> {
  const out = new Set(state.subscriptions.list.map((s) => s.targetPath))
  for (const r of IMPLICIT_RULES) for (const t of r.targets(state)) out.add(t)
  return out
}
