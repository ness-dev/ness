import { randomUUID } from 'crypto'
import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { findSubscription, type NotifyMode } from '../shared/state/subscriptions'
import {
  wrapAutomatedMessage,
  type JsonClaudeAutomationSource
} from '../shared/state/json-claude'
import { findTabInWorktree, listChatTabs } from '../shared/agent-tabs'
import { followedTargets, subscribersOf, type Subscriber } from '../shared/subscribers'
import {
  deliverToTab,
  deliverToWorktreeChat,
  describeWorktree,
  type ChatDeliveryDeps,
  type TabDeliveryFailure
} from './chat-delivery'
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

export type NotifyResult =
  | { ok: true; delivery: 'interrupt'; woke: boolean }
  | { ok: true; delivery: 'held' }
  | { ok: false; reason: TabDeliveryFailure }

/** Deliver one automated message to one Chat tab, as an interrupt (its own
 *  turn, waking the tab) or held silently for the tab's next turn.
 *
 *  An interrupt spawns a subprocess when the tab is asleep — never call
 *  this from inside a store listener. */
export function notifyTab(
  store: Store,
  delivery: ChatDeliveryDeps,
  target: { worktreePath: string; tabId: string },
  message: { source: JsonClaudeAutomationSource; from?: string; wire: string },
  mode: NotifyMode
): NotifyResult {
  const state = store.getSnapshot().state
  if (mode === 'interrupt') {
    const r = deliverToTab(state, delivery, target.worktreePath, target.tabId, message.wire)
    return r.ok ? { ok: true, delivery: 'interrupt', woke: r.woke } : r
  }
  const tab = findTabInWorktree(state, target.worktreePath, target.tabId)
  if (!tab) return { ok: false, reason: 'no-tab' }
  if (tab.type === 'agent') return { ok: false, reason: 'terminal-unsupported' }
  if (tab.type !== 'json-claude') return { ok: false, reason: 'not-agent-tab' }
  store.dispatch({
    type: 'notifications/queued',
    payload: {
      tabId: target.tabId,
      notice: {
        id: randomUUID(),
        source: message.source,
        ...(message.from ? { from: message.from } : {}),
        wire: message.wire,
        queuedAt: Date.now()
      }
    }
  })
  return { ok: true, delivery: 'held' }
}

export type SubscribeResult = {
  created: boolean
  mode: NotifyMode
  /** Whether the target worktree's agent was told it is being followed. */
  targetNotified: boolean
  targetNotifyError?: 'no-chat-tab' | 'wake-failed'
}

/** Subscribe one Chat tab to another worktree, and tell the target's agent
 *  it now has an audience. Re-subscribing refreshes the note and mode and
 *  re-sends the briefing, which is how a subscriber recovers a target agent
 *  that lost the thread (new tab, compacted context). */
export function subscribeToWorktree(
  store: Store,
  delivery: ChatDeliveryDeps,
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
  const existing = findSubscription(
    store.getSnapshot().state.subscriptions,
    params.subscriberTabId,
    params.targetPath
  )
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

  const from = senderName(store, params.subscriberPath, params.subscriberTabId)
  const lines = [`${from} subscribed to progress reports from this worktree.`]
  if (note) lines.push('', `What they are watching for: ${note}`)
  const message = wrapAutomatedMessage('subscription-started', lines.join('\n'), { from })
  const result = deliverToWorktreeChat(
    store.getSnapshot().state,
    delivery,
    params.targetPath,
    message
  )
  log(
    'subscriptions',
    `${params.subscriberTabId}@${params.subscriberPath} -> ${params.targetPath} ` +
      `(${existing ? 'refreshed' : 'new'}, mode=${mode}, notified=${result.ok ? 'yes' : result.reason})`
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

/** Deliver one message to every subscriber of `targetPath`, each in its
 *  own mode unless `urgent` forces an interrupt. Explicit subscriptions
 *  whose tab is gone for good are dropped; implicit ones have nothing
 *  stored to drop, and simply stop resolving once their source fact goes. */
function fanOut(
  store: Store,
  delivery: ChatDeliveryDeps,
  targetPath: string,
  message: { source: JsonClaudeAutomationSource; from?: string; wire: string },
  urgent: boolean
): FanOutResult {
  const result: FanOutResult = { delivered: [], failed: [] }
  const dead: string[] = []
  const subs: Subscriber[] = subscribersOf(store.getSnapshot().state, targetPath)
  for (const sub of subs) {
    const target = { worktreePath: sub.subscriberPath, tabId: sub.subscriberTabId }
    const r = notifyTab(store, delivery, target, message, urgent ? 'interrupt' : sub.mode)
    if (r.ok) {
      result.delivered.push({ ...target, delivery: r.delivery })
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
  delivery: ChatDeliveryDeps,
  fromPath: string,
  fromTabId: string,
  message: string,
  urgent: boolean
): FanOutResult {
  const from = senderName(store, fromPath, fromTabId)
  const wire = wrapAutomatedMessage('progress-report', message, { from })
  return fanOut(store, delivery, fromPath, { source: 'progress-report', from, wire }, urgent)
}

/** Remove explicit subscriptions and origins whose worktrees are gone. */
export function pruneForRemovedWorktrees(store: Store): void {
  const state = store.getSnapshot().state
  const live = new Set(state.worktrees.list.map((w) => w.path))
  const dead = state.subscriptions.list
    .filter((s) => !live.has(s.subscriberPath) || !live.has(s.targetPath))
    .map((s) => s.id)
  if (dead.length > 0) store.dispatch({ type: 'subscriptions/removed', payload: { ids: dead } })
  for (const path of Object.keys(state.origins.byPath)) {
    if (!live.has(path)) store.dispatch({ type: 'origins/cleared', payload: path })
  }
}

export interface PrChange {
  text: string
  /** Something the subscriber likely needs to act on now. Forces an
   *  interrupt even for a silent subscription. */
  urgent: boolean
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

function failingChecks(pr: PRStatus): string {
  const failing = pr.checks.filter((c) => c.state === 'failure' || c.state === 'error')
  if (failing.length === 0) return ''
  const names = failing.slice(0, MAX_LISTED_CHECKS).map((c) => c.name)
  const more = failing.length > MAX_LISTED_CHECKS ? `, +${failing.length - MAX_LISTED_CHECKS} more` : ''
  return ` (${names.join(', ')}${more})`
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
    out.push({ text: `CI failing${failingChecks(next)}`, urgent: true })
  } else if (checksMoved && next.checksOverall === 'success') {
    out.push({ text: 'CI passed', urgent: false })
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

/** Exported for tests. */
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

/** Tells subscribers when a followed worktree's PR changes: opened, new
 *  commits, CI result, review decision, conflicts, merge/close.
 *
 *  Keeps the last PR status it saw per followed target and diffs against
 *  it, so a re-poll that changes nothing says nothing. A target with no
 *  cached status is baselined rather than reported, which keeps boot and
 *  a fresh subscription quiet until something actually moves. The cache
 *  is of PR state, not of who's subscribed — that is re-derived per
 *  delivery from subscribersOf. */
export class SubscriptionNotifier {
  private last = new Map<string, PRStatus | null>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private store: Store,
    private delivery: ChatDeliveryDeps,
    /** Re-read per update so the messaging toggle takes effect live. */
    private isEnabled: () => boolean
  ) {}

  start(): void {
    if (this.unsubscribe) return
    for (const target of followedTargets(this.store.getSnapshot().state)) this.baseline(target)
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private baseline(target: string): void {
    if (this.last.has(target)) return
    const byPath = this.store.getSnapshot().state.prs.byPath
    // Absent from byPath means "not polled yet": leave it uncached so the
    // first poll becomes the baseline instead of reading as "PR opened".
    if (target in byPath) this.last.set(target, byPath[target] ?? null)
  }

  private onEvent(event: StateEvent): void {
    switch (event.type) {
      case 'subscriptions/added':
        this.baseline(event.payload.targetPath)
        return
      case 'origins/recorded':
        this.baseline(event.payload.path)
        return
      case 'prs/statusChanged': {
        const { path, status } = event.payload
        if (followedTargets(this.store.getSnapshot().state).has(path)) this.consider(path, status)
        else this.last.delete(path)
        return
      }
      case 'prs/bulkStatusChanged':
        // Only followed targets are diffed — a handful at most — so this
        // never sweeps the whole PR map.
        for (const target of followedTargets(this.store.getSnapshot().state)) {
          if (target in event.payload) this.consider(target, event.payload[target] ?? null)
        }
        return
    }
  }

  private consider(target: string, next: PRStatus | null): void {
    const prev = this.last.has(target) ? this.last.get(target) : undefined
    this.last.set(target, next)
    const changes = describePrChanges(prev, next)
    if (changes.length === 0 || !next || !this.isEnabled()) return
    setImmediate(() => this.deliver(target, next, changes))
  }

  private deliver(target: string, pr: PRStatus, changes: PrChange[]): void {
    const targetName = describeWorktree(this.store.getSnapshot().state, target)
    const body = buildSubscriptionUpdate(targetName, pr, changes)
    const wire = wrapAutomatedMessage('subscription-update', body, { from: targetName })
    const urgent = changes.some((c) => c.urgent)
    const result = fanOut(
      this.store,
      this.delivery,
      target,
      { source: 'subscription-update', from: targetName, wire },
      urgent
    )
    log(
      'subscriptions',
      `update ${target}: ${changes.map((c) => c.text).join('; ')} urgent=${urgent} ` +
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
