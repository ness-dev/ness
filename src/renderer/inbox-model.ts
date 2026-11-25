// The sidebar inbox: every agent tab, grouped by what it needs from you.
//
// Pure and React-free, like worktree-list-model.ts, so the bucketing rules
// are unit-tested and easy to retune after living with them. The inputs
// are the merged multi-backend maps App already builds, so the inbox and
// the Projects view always agree on which tabs exist.

import type { PaneNode, PendingTool, PtyStatus, TerminalTab } from '../shared/state/terminals'
import { getLeaves } from '../shared/state/terminals'
import type { PRStatus } from '../shared/state/prs'
import type { Worktree } from '../shared/state/worktrees'
import type { InboxState } from '../shared/state/inbox'
import { QUESTION_TOOL_NAME } from '../shared/state/json-claude'
import { tabLabel } from '../shared/agent-tabs'
import { formatPendingTool } from './pending-tool'

export type InboxSectionKey =
  | 'approval'
  | 'question'
  | 'done'
  | 'pr'
  | 'working'
  | 'seen'

export const INBOX_SECTIONS: ReadonlyArray<{
  key: InboxSectionKey
  label: string
  /** Collapsed sections only show their count until expanded. */
  collapsedByDefault: boolean
  /** Counts toward "needs you" and is reachable by the jump hotkey. */
  needsYou: boolean
}> = [
  { key: 'approval', label: 'Needs approval', collapsedByDefault: false, needsYou: true },
  { key: 'question', label: 'Asked you something', collapsedByDefault: false, needsYou: true },
  { key: 'done', label: 'Done, unread', collapsedByDefault: false, needsYou: true },
  { key: 'pr', label: 'PR events', collapsedByDefault: false, needsYou: true },
  { key: 'working', label: 'Working', collapsedByDefault: true, needsYou: false },
  { key: 'seen', label: 'Seen / idle', collapsedByDefault: true, needsYou: false }
]

export interface InboxItem {
  /** Tab id, or `pr:<worktreePath>` for a PR event. */
  key: string
  section: InboxSectionKey
  worktreePath: string
  /** Null for PR events — those open the worktree, not a tab. */
  tabId: string | null
  paneId: string | null
  repoName: string
  worktreeLabel: string
  tabLabel: string
  /** The one-line reason this row is here. Empty when there's nothing
   *  better to say than the section header already does. */
  why: string
  /** Epoch ms the row entered this state; 0 when unknown. */
  since: number
  status: PtyStatus
  /** PR events only: what "seen" records, so a new event resurfaces. */
  prFingerprint?: string
  prKind?: PrEventKind
}

export interface InboxSectionModel {
  key: InboxSectionKey
  label: string
  items: InboxItem[]
  collapsedByDefault: boolean
}

export interface InboxModel {
  sections: InboxSectionModel[]
  /** Sections flagged `needsYou`, flattened in display order. */
  needsYou: InboxItem[]
}

export interface InboxModelInput {
  worktrees: Worktree[]
  panes: Record<string, PaneNode>
  statuses: Record<string, PtyStatus>
  pendingTools: Record<string, PendingTool | null>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  aliases: Record<string, string>
  inbox: Pick<InboxState, 'turns' | 'seenAt' | 'statusSince' | 'prSeen'>
}

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

function repoNameOf(repoRoot: string): string {
  const trimmed = repoRoot.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

function isAgentTab(tab: TerminalTab): boolean {
  return tab.type === 'agent' || tab.type === 'json-claude'
}

export function buildInboxModel(input: InboxModelInput): InboxModel {
  const { inbox } = input
  const buckets: Record<InboxSectionKey, InboxItem[]> = {
    approval: [],
    question: [],
    done: [],
    pr: [],
    working: [],
    seen: []
  }

  for (const wt of input.worktrees) {
    if (wt.isBare || wt.prunable) continue
    const repoName = repoNameOf(wt.repoRoot)
    const alias = input.aliases[wt.path]
    const worktreeLabel = wt.isMain ? (alias ?? repoName) : (alias ?? wt.branch)
    const tree = input.panes[wt.path]
    let firstAgent: { tab: TerminalTab; paneId: string } | null = null

    if (tree) {
      for (const leaf of getLeaves(tree)) {
        for (const tab of leaf.tabs) {
          if (!isAgentTab(tab)) continue
          if (!firstAgent) firstAgent = { tab, paneId: leaf.id }
          const status = input.statuses[tab.id] ?? 'idle'
          const statusSince =
            inbox.statusSince[tab.id]?.status === status ? inbox.statusSince[tab.id].since : 0
          const turn = inbox.turns[tab.id]
          const unread = !!turn && turn.endedAt > (inbox.seenAt[tab.id] ?? 0)
          const base = {
            key: tab.id,
            worktreePath: wt.path,
            tabId: tab.id,
            paneId: leaf.id,
            repoName,
            worktreeLabel,
            tabLabel: tabLabel(tab),
            status
          }

          if (status === 'needs-approval') {
            const tool = input.pendingTools[tab.id]
            const isQuestion = tool?.name === QUESTION_TOOL_NAME
            buckets[isQuestion ? 'question' : 'approval'].push({
              ...base,
              section: isQuestion ? 'question' : 'approval',
              why: tool ? formatPendingTool(tool) : 'Waiting for approval',
              since: statusSince
            })
          } else if (status === 'processing') {
            buckets.working.push({
              ...base,
              section: 'working',
              why: '',
              since: statusSince
            })
          } else if (status === 'waiting' && turn && unread) {
            const section = turn.kind === 'question' ? 'question' : 'done'
            buckets[section].push({ ...base, section, why: turn.text, since: turn.endedAt })
          } else {
            buckets.seen.push({
              ...base,
              section: 'seen',
              why: turn?.text ?? '',
              since: turn?.endedAt ?? 0
            })
          }
        }
      }
    }

    const ev = prEventFor(input.prStatuses[wt.path], !!input.mergedPaths[wt.path])
    if (ev && inbox.prSeen[wt.path] !== ev.fingerprint) {
      buckets.pr.push({
        key: `pr:${wt.path}`,
        section: 'pr',
        worktreePath: wt.path,
        // Opening a PR event lands on the worktree's first agent tab, so
        // you're one keystroke from telling it to fix the failure.
        tabId: firstAgent?.tab.id ?? null,
        paneId: firstAgent?.paneId ?? null,
        repoName,
        worktreeLabel,
        tabLabel: firstAgent ? tabLabel(firstAgent.tab) : '',
        why: ev.why,
        since: 0,
        status: firstAgent ? (input.statuses[firstAgent.tab.id] ?? 'idle') : 'idle',
        prFingerprint: ev.fingerprint,
        prKind: ev.kind
      })
    }
  }

  // Needs-you sections: oldest first, so nothing starves at the bottom.
  // Unknown `since` (0) sorts first — it's a status from before this boot.
  const oldestFirst = (a: InboxItem, b: InboxItem): number => a.since - b.since
  // The rest: most recent first, which is what you scan them for.
  const newestFirst = (a: InboxItem, b: InboxItem): number => b.since - a.since

  const sections: InboxSectionModel[] = INBOX_SECTIONS.map((s) => ({
    key: s.key,
    label: s.label,
    collapsedByDefault: s.collapsedByDefault,
    items: buckets[s.key].sort(s.needsYou ? oldestFirst : newestFirst)
  }))
  const needsYou = sections
    .filter((s) => INBOX_SECTIONS.find((d) => d.key === s.key)?.needsYou)
    .flatMap((s) => s.items)
  return { sections, needsYou }
}

/** The item the jump hotkey opens: the top needs-you item that isn't the
 *  tab you're already looking at, so repeated presses walk the list. */
export function nextInboxItem(model: InboxModel, focusedTabId: string | null): InboxItem | null {
  return model.needsYou.find((i) => i.section === 'pr' || i.tabId !== focusedTabId) ?? null
}
