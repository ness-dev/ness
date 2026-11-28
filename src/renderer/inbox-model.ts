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
import type { MergedWorktreeData } from './merge-backend-states'
import { QUESTION_TOOL_NAME } from '../shared/state/json-claude'
import { tabLabel } from '../shared/agent-tabs'
import { formatPendingTool } from './pending-tool'
import { BLOCKING_PR_EVENTS, prEventFor, type PrEventKind } from '../shared/inbox-pr'

export { prEventFor, type PrEventKind }

export type InboxSectionKey =
  | 'approval'
  | 'question'
  | 'done'
  | 'pr'
  | 'prInfo'
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
  { key: 'pr', label: 'PR needs you', collapsedByDefault: false, needsYou: true },
  { key: 'prInfo', label: 'PR updates', collapsedByDefault: false, needsYou: false },
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
  statusSince: Record<string, number>
  pendingTools: Record<string, PendingTool | null>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  aliases: Record<string, string>
  inbox: InboxState
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
    prInfo: [],
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
          const statusSince = input.statusSince[tab.id] ?? 0
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
          } else if (turn && unread) {
            // 'idle' included: a restart puts chat tabs to sleep with no
            // status, and an unread reply is still unread.
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
      const section = BLOCKING_PR_EVENTS.has(ev.kind) ? 'pr' : 'prInfo'
      buckets[section].push({
        key: `pr:${wt.path}`,
        section,
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

/** The model straight from the merged multi-backend maps — the one input
 *  shape every client already has (desktop App, the mobile web client, and
 *  the Expo app's fleet), so none of them re-plumbs the fields. */
export function buildInboxModelFromMerged(merged: MergedWorktreeData): InboxModel {
  return buildInboxModel({
    worktrees: merged.flatWorktrees,
    panes: merged.panes,
    statuses: merged.statuses,
    statusSince: merged.statusSince,
    pendingTools: merged.pendingTools,
    prStatuses: merged.prStatuses,
    mergedPaths: merged.mergedPaths,
    aliases: merged.aliases,
    inbox: { turns: merged.inboxTurns, seenAt: merged.inboxSeenAt, prSeen: merged.inboxPrSeen }
  })
}

/** The item the jump hotkey opens: the top needs-you item that isn't the
 *  tab you're already looking at, so repeated presses walk the list. */
export function nextInboxItem(model: InboxModel, focusedTabId: string | null): InboxItem | null {
  return model.needsYou.find((i) => i.prFingerprint !== undefined || i.tabId !== focusedTabId) ?? null
}
