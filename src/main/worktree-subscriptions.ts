import { randomUUID } from 'crypto'
import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { findSubscription, type NotifyMode } from '../shared/state/subscriptions'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import { listChatTabs } from '../shared/agent-tabs'
import {
  followedTargets,
  subscribersOf,
  type Subscriber,
  type SubscriptionTopic
} from '../shared/subscribers'
import { describeWorktree, type TabDeliveryFailure } from './chat-delivery'
import type { NotificationBus } from './notification-bus'
import { log } from './debug'

const MAX_LISTED_CHECKS = 5

/** Delivery failures that mean the subscriber tab can never receive an
 *  update again. A failed wake is transient and keeps the subscription. */
const GONE: ReadonlySet<TabDeliveryFailure> = new Set([
  'no-tab',
  'not-agent-tab',
  'terminal-unsupported'
])

function tabLabelOf(store: Store, worktreePath: string, tabId: string): string | undefined {
  return listChatTabs(store.getSnapshot().state, worktreePath).find((t) => t.id === tabId)?.label
}

function senderName(store: Store, worktreePath: string, tabId: string): string {
  const name = describeWorktree(store.getSnapshot().state, worktreePath)
  const label = tabLabelOf(store, worktreePath, tabId)
  return label ? `${name} · ${label}` : name
}

export type SubscribeResult = {
  created: boolean
  mode: NotifyMode
  /** Whether the target worktree's agent was told about this follower on
   *  this call. False with no error when there was nothing new to tell. */
  targetNotified: boolean
  targetNotifyError?: 'no-chat-tab' | 'wake-failed'
}

/** Subscribe one Chat tab to another worktree.
 *
 *  The target's agent is briefed when that tells it something new: a new
 *  follower, or a changed note. A call that only changes `mode` — the
 *  documented way to quiet a worktree you follow — must not interrupt the
 *  agent there, and neither does subscribing to a worktree you already
 *  follow implicitly, whose agent was told in its kickoff brief. */
export function subscribeToWorktree(
  store: Store,
  bus: NotificationBus,
  params: {
    subscriberPath: string
    subscriberTabId: string
    targetPath: string
    note?: string
    mode?: NotifyMode
  }
): SubscribeResult {
  const note = params.note?.trim() || undefined
  const mode = params.mode ?? 'interrupt'
  const before = store.getSnapshot().state
  const existing = findSubscription(before.subscriptions, params.subscriberTabId, params.targetPath)
  const alreadyFollowing =
    existing ??
    subscribersOf(before, params.targetPath).find((s) => s.subscriberTabId === params.subscriberTabId)
  store.dispatch({
    type: 'subscriptions/added',
    payload: {
      id: existing?.id ?? randomUUID(),
      subscriberPath: params.subscriberPath,
      subscriberTabId: params.subscriberTabId,
      targetPath: params.targetPath,
      ...(note ? { note } : {}),
      mode,
      createdAt: existing?.createdAt ?? Date.now()
    }
  })

  const rebrief = !alreadyFollowing || (note !== undefined && note !== alreadyFollowing.note)
  if (!rebrief) {
    log('subscriptions', `${params.subscriberTabId} -> ${params.targetPath} updated (mode=${mode}), no re-brief`)
    return { created: !existing, mode, targetNotified: false }
  }
  const from = senderName(store, params.subscriberPath, params.subscriberTabId)
  const lines = [`${from} subscribed to progress reports from this worktree.`]
  if (note) lines.push('', `What they are watching for: ${note}`)
  const result = bus.toWorktree(
    params.targetPath,
    wrapAutomatedMessage('subscription-started', lines.join('\n'), { from })
  )
  return {
    created: !existing,
    mode,
    targetNotified: result.ok,
    ...(result.ok ? {} : { targetNotifyError: result.reason })
  }
}

export type UnsubscribeResult = 'removed' | 'implicit' | 'not-subscribed'

/** Remove an explicit subscription. An implicit one can't be removed — it
 *  is derived from a fact (e.g. this tab created the worktree), not stored
 *  — so the caller is told that instead. */
export function unsubscribeFromWorktree(
  store: Store,
  subscriberTabId: string,
  targetPath: string
): UnsubscribeResult {
  const state = store.getSnapshot().state
  const sub = findSubscription(state.subscriptions, subscriberTabId, targetPath)
  if (sub) {
    store.dispatch({ type: 'subscriptions/removed', payload: { ids: [sub.id] } })
    return 'removed'
  }
  const implicit = subscribersOf(state, targetPath).some(
    (s) => s.subscriberTabId === subscriberTabId
  )
  return implicit ? 'implicit' : 'not-subscribed'
}

/** Record that `creator` created `worktreePath`. That fact alone is what
 *  makes the creator follow the new worktree — no subscription is written. */
export function recordWorktreeOrigin(
  store: Store,
  worktreePath: string,
  creator: { worktreePath: string; tabId: string }
): void {
  store.dispatch({
    type: 'origins/recorded',
    payload: {
      path: worktreePath,
      origin: {
        creatorPath: creator.worktreePath,
        creatorTabId: creator.tabId,
        createdAt: Date.now()
      }
    }
  })
}

export interface FanOutResult {
  delivered: Array<{ worktreePath: string; tabId: string; delivery: 'interrupt' | 'held' }>
  failed: Array<{ worktreePath: string; tabId: string; reason: TabDeliveryFailure }>
}


/** Deliver to every subscriber of `targetPath` that hears about `topic`,
 *  each in its own mode unless `urgent` forces an interrupt. `message` is
 *  built per subscriber, because a worktree's own agent and an agent
 *  following it from elsewhere need the same news phrased differently.
 *  Explicit subscriptions whose tab is gone for good are dropped; implicit
 *  ones whose tab is gone already stopped resolving in subscribersOf. */
function fanOut(
  store: Store,
  bus: NotificationBus,
  targetPath: string,
  opts: {
    topic: SubscriptionTopic
    urgent: boolean
    messagingEnabled: boolean
    /** Wire text for one subscriber. */
    message: (sub: Subscriber) => string
  }
): FanOutResult {
  const result: FanOutResult = { delivered: [], failed: [] }
  const dead: string[] = []
  const subs = subscribersOf(store.getSnapshot().state, targetPath, opts.topic).filter(
    (s) => opts.messagingEnabled || !s.needsMessaging
  )
  for (const sub of subs) {
    const target = { worktreePath: sub.subscriberPath, tabId: sub.subscriberTabId }
    const mode = opts.urgent ? 'interrupt' : sub.mode
    const r = bus.toTab(target.worktreePath, target.tabId, opts.message(sub), mode)
    if (r.ok) {
      result.delivered.push({ ...target, delivery: r.held ? 'held' : 'interrupt' })
      continue
    }
    result.failed.push({ ...target, reason: r.reason })
    if (sub.explicitId && GONE.has(r.reason)) dead.push(sub.explicitId)
  }
  if (dead.length > 0) {
    log('subscriptions', `dropping ${dead.length} subscription(s) to ${targetPath}: subscriber tab gone`)
    store.dispatch({ type: 'subscriptions/removed', payload: { ids: dead } })
  }
  return result
}

/** A progress report from an agent in `fromPath` to everyone following it. */
export function reportProgress(
  store: Store,
  bus: NotificationBus,
  fromPath: string,
  fromTabId: string,
  message: string,
  urgent: boolean
): FanOutResult {
  const from = senderName(store, fromPath, fromTabId)
  const wire = wrapAutomatedMessage('progress-report', message, { from })
  return fanOut(store, bus, fromPath, {
    topic: 'progress',
    urgent,
    // The endpoint that calls this is already gated on messaging.
    messagingEnabled: true,
    message: () => wire
  })
}

/** Remove explicit subscriptions and origins that involve `removed`
 *  worktree paths. Takes the paths that left the list rather than diffing
 *  against the current list, so a worktree created moments ago — whose
 *  origin is recorded before it shows up in the list — isn't mistaken for
 *  one that was deleted. */
export function pruneForRemovedWorktrees(store: Store, removed: ReadonlySet<string>): void {
  if (removed.size === 0) return
  const state = store.getSnapshot().state
  const dead = state.subscriptions.list
    .filter((s) => removed.has(s.subscriberPath) || removed.has(s.targetPath))
    .map((s) => s.id)
  if (dead.length > 0) store.dispatch({ type: 'subscriptions/removed', payload: { ids: dead } })
  for (const [path, origin] of Object.entries(state.origins.byPath)) {
    if (removed.has(path) || removed.has(origin.creatorPath)) {
      store.dispatch({ type: 'origins/cleared', payload: path })
    }
  }
}

export interface PrChange {
  text: string
  /** Something the subscriber likely needs to act on now. Forces an
   *  interrupt even for a silent subscription. */
  urgent: boolean
  /** Set on a CI result: `<headSha>:<result>`. A check that flaps
   *  (failure → pending → failure on a re-run of the same commit) is one
   *  result, so the notifier reports each key once. */
  ciKey?: string
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

/** One indented line per failing check, with its description and log
 *  link, so the agent can go straight to the failure. */
function failingChecks(pr: PRStatus): string {
  const failing = pr.checks.filter((c) => c.state === 'failure' || c.state === 'error')
  const lines = failing.slice(0, MAX_LISTED_CHECKS).map((c) => {
    const detail = c.description?.trim()
    return `  - ${c.name}${detail ? `: ${detail}` : ''}${c.detailsUrl ? ` — ${c.detailsUrl}` : ''}`
  })
  if (failing.length > MAX_LISTED_CHECKS) {
    lines.push(`  - …and ${failing.length - MAX_LISTED_CHECKS} more`)
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}

function ciKey(pr: PRStatus): string {
  return `${pr.headSha || `pr-${pr.number}`}:${pr.checksOverall}`
}

function latestChangeRequester(pr: PRStatus): string | undefined {
  const reviews = pr.reviews.filter((r) => r.state === 'CHANGES_REQUESTED')
  return reviews[reviews.length - 1]?.user
}

/** What a subscriber should hear about, going from `prev` to `next`.
 *  `prev === undefined` means "never observed" — a baseline, not a change.
 *  Exported for tests. */
export function describePrChanges(
  prev: PRStatus | null | undefined,
  next: PRStatus | null
): PrChange[] {
  if (prev === undefined || !next) return []
  if (!prev || prev.number !== next.number) {
    const draft = next.state === 'draft' ? ' as a draft' : ''
    return [{ text: `Opened PR #${next.number}${draft}: "${next.title}"`, urgent: false }]
  }
  const out: PrChange[] = []
  if (prev.state !== next.state) {
    if (next.state === 'merged') out.push({ text: 'PR merged', urgent: true })
    else if (next.state === 'closed') out.push({ text: 'PR closed without merging', urgent: true })
    else if (next.state === 'draft') out.push({ text: 'PR converted to draft', urgent: false })
    else if (prev.state === 'draft') out.push({ text: 'PR marked ready for review', urgent: false })
    else out.push({ text: 'PR reopened', urgent: false })
  }
  const newCommit = !!prev.headSha && !!next.headSha && prev.headSha !== next.headSha
  if (newCommit) out.push({ text: `New commit pushed (${shortSha(next.headSha)})`, urgent: false })
  const checksMoved = prev.checksOverall !== next.checksOverall || newCommit
  if (checksMoved && next.checksOverall === 'failure') {
    out.push({ text: `CI failing${failingChecks(next)}`, urgent: true, ciKey: ciKey(next) })
  } else if (checksMoved && next.checksOverall === 'success') {
    out.push({ text: 'CI passed', urgent: false, ciKey: ciKey(next) })
  }
  if (prev.reviewDecision !== next.reviewDecision) {
    if (next.reviewDecision === 'approved') out.push({ text: 'PR approved', urgent: false })
    else if (next.reviewDecision === 'changes_requested') {
      const who = latestChangeRequester(next)
      out.push({ text: who ? `Changes requested by ${who}` : 'Changes requested', urgent: true })
    } else if (prev.reviewDecision === 'approved') {
      out.push({ text: 'Approval dismissed — review required again', urgent: false })
    }
  }
  if (prev.hasConflict !== true && next.hasConflict === true) {
    out.push({ text: 'PR now has merge conflicts with its base', urgent: true })
  } else if (prev.hasConflict === true && next.hasConflict === false) {
    out.push({ text: 'Merge conflicts resolved', urgent: false })
  }
  return out
}

/** The update as an agent following the worktree from elsewhere reads it.
 *  Exported for tests. */
export function buildSubscriptionUpdate(
  targetName: string,
  pr: PRStatus,
  changes: PrChange[]
): string {
  return [
    `${targetName} — PR #${pr.number} "${pr.title}":`,
    ...changes.map((c) => `- ${c.text}`),
    '',
    pr.url
  ].join('\n')
}

/** The update as the worktree's own agent reads it — its own PR.
 *  Exported for tests. */
export function buildOwnPrUpdate(pr: PRStatus, changes: PrChange[]): string {
  return [
    `Your PR #${pr.number} "${pr.title}" (${pr.branch}):`,
    ...changes.map((c) => `- ${c.text}`),
    '',
    pr.url
  ].join('\n')
}

/** Every GitHub notification to an agent goes through here: a worktree's
 *  own agent hearing about its PR, and agents following it from elsewhere.
 *  Reports PR opened, new commits, CI results, review decisions, conflicts
 *  and merge/close.
 *
 *  Keeps the last PR status seen for every path — references, so it's
 *  cheap — and diffs against it, so a re-poll that changes nothing says
 *  nothing and a path that only starts being followed later already has a
 *  baseline. A path's first observation is a baseline rather than news,
 *  which keeps boot quiet. Who hears about a change is re-derived per
 *  delivery from subscribersOf; nothing here caches subscriptions. */
export class SubscriptionNotifier {
  private last = new Map<string, PRStatus | null>()
  /** Last CI result reported per path, so a flapping check is reported
   *  once per commit. */
  private reportedCi = new Map<string, string>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private store: Store,
    private bus: NotificationBus,
    /** Re-read per update so the messaging toggle takes effect live. Only
     *  gates agent-to-agent subscribers; a worktree's own agent has its own
     *  setting, applied by the subscription rule. */
    private messagingEnabled: () => boolean
  ) {}

  start(): void {
    if (this.unsubscribe) return
    const byPath = this.store.getSnapshot().state.prs.byPath
    for (const [path, status] of Object.entries(byPath)) {
      this.last.set(path, status ?? null)
      // An already-red PR at boot isn't news; claim its result so the
      // next poll of the same commit stays quiet.
      if (status && (status.checksOverall === 'failure' || status.checksOverall === 'success')) {
        this.reportedCi.set(path, ciKey(status))
      }
    }
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private onEvent(event: StateEvent): void {
    if (event.type === 'prs/statusChanged') {
      const followed = followedTargets(this.store.getSnapshot().state)
      this.consider(event.payload.path, event.payload.status, followed)
      return
    }
    if (event.type === 'prs/bulkStatusChanged') {
      // Sweeping the payload is inherent to this event — it replaces
      // prs.byPath wholesale — and PR polls are minutes apart. Only
      // followed paths are diffed; the rest just update the baseline.
      const followed = followedTargets(this.store.getSnapshot().state)
      for (const path of Object.keys(event.payload)) {
        this.consider(path, event.payload[path] ?? null, followed)
      }
      for (const path of [...this.last.keys()]) {
        if (!(path in event.payload)) {
          this.last.delete(path)
          this.reportedCi.delete(path)
        }
      }
    }
  }

  private consider(path: string, next: PRStatus | null, followed: Set<string>): void {
    const prev = this.last.has(path) ? this.last.get(path) : undefined
    this.last.set(path, next)
    if (!followed.has(path) || !next) return
    const changes = describePrChanges(prev, next).filter((c) => {
      if (!c.ciKey) return true
      if (this.reportedCi.get(path) === c.ciKey) return false
      this.reportedCi.set(path, c.ciKey)
      return true
    })
    if (changes.length === 0) return
    setImmediate(() => this.deliver(path, next, changes))
  }

  private deliver(target: string, pr: PRStatus, changes: PrChange[]): void {
    const targetName = describeWorktree(this.store.getSnapshot().state, target)
    const urgent = changes.some((c) => c.urgent)
    const own = wrapAutomatedMessage('pr-update', buildOwnPrUpdate(pr, changes))
    const other = wrapAutomatedMessage(
      'subscription-update',
      buildSubscriptionUpdate(targetName, pr, changes),
      { from: targetName }
    )
    const result = fanOut(this.store, this.bus, target, {
      topic: 'pr',
      urgent,
      messagingEnabled: this.messagingEnabled(),
      message: (sub) => (sub.subscriberPath === target ? own : other)
    })
    log(
      'subscriptions',
      `update ${target}: ${changes.map((c) => c.text.split('\n')[0]).join('; ')} urgent=${urgent} ` +
        `-> delivered=${result.delivered.length} failed=${result.failed.length}`
    )
  }
}

const MAX_DETAIL_COMMITS = 15
const MAX_DETAIL_FILES = 30

export interface WorktreeDetailReaders {
  branch: (worktreePath: string) => Promise<string>
  commits: (worktreePath: string) => Promise<
    Array<{ shortHash: string; subject: string; relativeDate: string; pushed: boolean }>
  >
  changedFiles: (worktreePath: string) => Promise<Array<{ path: string; status: string }>>
}

/** Everything get_worktree_status reports: the git facts read fresh, the
 *  PR from the poller's last result. Each git read fails soft so one broken
 *  read doesn't hide the rest. */
export async function buildWorktreeDetail(
  store: Store,
  worktreePath: string,
  readers: WorktreeDetailReaders
): Promise<Record<string, unknown>> {
  const soft = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)
  const [branch, commits, files] = await Promise.all([
    soft(readers.branch(worktreePath), ''),
    soft(readers.commits(worktreePath), []),
    soft(readers.changedFiles(worktreePath), [])
  ])
  const state = store.getSnapshot().state
  const pr = state.prs.byPath[worktreePath]
  return {
    worktreePath,
    worktree: describeWorktree(state, worktreePath),
    branch,
    pr: pr
      ? {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          checks: pr.checksOverall,
          failingChecks: pr.checks
            .filter((c) => c.state === 'failure' || c.state === 'error')
            .map((c) => c.name),
          reviewDecision: pr.reviewDecision,
          hasConflict: pr.hasConflict,
          headSha: pr.headSha
        }
      : pr === null
        ? null
        : 'not polled yet',
    commits: {
      total: commits.length,
      unpushed: commits.filter((c) => !c.pushed).length,
      recent: commits.slice(0, MAX_DETAIL_COMMITS).map((c) => ({
        sha: c.shortHash,
        subject: c.subject,
        when: c.relativeDate,
        pushed: c.pushed
      }))
    },
    uncommitted: {
      total: files.length,
      files: files.slice(0, MAX_DETAIL_FILES).map((f) => `${f.status} ${f.path}`)
    },
    followers: subscribersOf(state, worktreePath).length
  }
}
