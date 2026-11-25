import { useState } from 'react'
import { ChevronDown, ChevronRight, GitPullRequest, Inbox } from 'lucide-react'
import type { InboxItem, InboxModel, InboxSectionKey } from '../inbox-model'

/** The sidebar's Inbox view: one row per agent tab, bucketed by what it
 *  needs from you. Display only — the bucketing lives in inbox-model.ts
 *  and the read marks in the inbox slice. */

const DOT: Record<InboxSectionKey, string> = {
  approval: 'bg-danger animate-pulse',
  question: 'bg-accent',
  done: 'bg-warning',
  pr: '',
  working: 'bg-success animate-pulse',
  seen: 'bg-faint'
}

const PR_COLOR: Record<NonNullable<InboxItem['prKind']>, string> = {
  'ci-failed': 'text-danger',
  conflict: 'text-danger',
  'changes-requested': 'text-warning',
  ready: 'text-success',
  merged: 'text-accent'
}

function ago(ts: number, now: number): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function InboxView({
  model,
  activeWorktreeId,
  activeTabId,
  onOpen
}: {
  model: InboxModel
  activeWorktreeId: string | null
  activeTabId: string | null
  onOpen: (item: InboxItem) => void
}): JSX.Element {
  // Per-client UI fold state, like the Projects view's group collapse.
  const [open, setOpen] = useState<Partial<Record<InboxSectionKey, boolean>>>({})
  const now = Date.now()
  const nonEmpty = model.sections.filter((s) => s.items.length > 0)

  return (
    <div className="flex flex-col pb-2">
      {model.needsYou.length === 0 && (
        <div className="px-3 py-4 flex items-center gap-2 text-xs text-faint">
          <Inbox className="icon-sm shrink-0" />
          <span>Nothing needs you right now.</span>
        </div>
      )}
      {nonEmpty.map((section) => {
        const expanded = open[section.key] ?? !section.collapsedByDefault
        return (
          <div key={section.key}>
            <button
              onClick={() => setOpen((o) => ({ ...o, [section.key]: !expanded }))}
              className="w-full flex items-center gap-1 px-3 pt-2 pb-1 text-xs text-faint hover:text-fg transition-colors cursor-pointer"
              title={expanded ? `Collapse ${section.label}` : `Expand ${section.label}`}
            >
              {expanded ? (
                <ChevronDown className="icon-xs shrink-0" />
              ) : (
                <ChevronRight className="icon-xs shrink-0" />
              )}
              <span>{section.label}</span>
              <span className="ml-auto">{section.items.length}</span>
            </button>
            {expanded &&
              section.items.map((item) => {
                const active =
                  item.worktreePath === activeWorktreeId &&
                  item.section !== 'pr' &&
                  item.tabId === activeTabId
                return (
                  <button
                    key={item.key}
                    onClick={() => onOpen(item)}
                    data-inbox-item={item.key}
                    className={`mx-1.5 w-[calc(100%-0.75rem)] rounded-md text-left px-2 py-1.5 flex gap-2 items-start cursor-pointer transition-colors ${
                      active ? 'bg-surface text-fg-bright' : 'text-muted hover:bg-panel-raised hover:text-fg'
                    }`}
                  >
                    {item.section === 'pr' ? (
                      <GitPullRequest
                        className={`icon-xs shrink-0 mt-0.5 ${item.prKind ? PR_COLOR[item.prKind] : ''}`}
                      />
                    ) : (
                      <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${DOT[item.section]}`} />
                    )}
                    <span className="min-w-0 flex-1 flex flex-col">
                      <span className="flex items-baseline gap-1 text-xs min-w-0">
                        <span className="truncate">
                          {item.worktreeLabel !== item.repoName && (
                            <span className="text-faint">{item.repoName} · </span>
                          )}
                          <span>{item.worktreeLabel}</span>
                          {item.tabLabel && (
                            <span className="text-faint"> · {item.tabLabel}</span>
                          )}
                        </span>
                        <span className="ml-auto shrink-0 text-faint">{ago(item.since, now)}</span>
                      </span>
                      {item.why && (
                        <span
                          className={`text-xs line-clamp-2 break-words ${
                            item.section === 'seen' ? 'text-faint' : 'text-fg'
                          }`}
                          title={item.why}
                        >
                          {item.why}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}
