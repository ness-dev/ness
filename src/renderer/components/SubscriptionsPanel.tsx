import { useMemo } from 'react'
import { Bell, BellOff, X } from 'lucide-react'
import { useAppState } from '../store'
import { useBackend } from '../backend'
import { RightPanel } from './RightPanel'
import { findTabInWorktree, tabLabel } from '../../shared/agent-tabs'
import { tabSubscriptionsView, type Subscriber } from '../../shared/subscribers'
import {
  parseAutomatedMessage,
  type JsonClaudeAutomationSource
} from '../../shared/state/json-claude'
import type { AppState } from '../../shared/state'

interface FollowRow {
  targetPath: string
  name: string
  kind: Subscriber['kind']
  reason?: Subscriber['reason']
  mode: Subscriber['mode']
  note?: string
}

interface FollowerRow {
  worktree: string
  tab: string
  kind: Subscriber['kind']
  reason?: Subscriber['reason']
  mode: Subscriber['mode']
}

interface PanelView {
  following: FollowRow[]
  followers: FollowerRow[]
}

const SOURCE_LABELS: Partial<Record<JsonClaudeAutomationSource, string>> = {
  'pr-update': 'PR update',
  'reviewed-pr-update': 'Reviewed PR update',
  'subscription-update': 'Worktree update',
  'progress-report': 'Progress report',
  'worktree-message': 'Message',
  review: 'Review'
}

function worktreeName(s: AppState, path: string): string {
  return (
    s.aliases.byPath[path] ||
    s.worktrees.list.find((w) => w.path === path)?.branch ||
    path.split('/').pop() ||
    path
  )
}

function kindLabel(kind: Subscriber['kind'], reason?: Subscriber['reason']): string {
  if (reason === 'created-worktree') return 'created it'
  if (reason === 'own-worktree') return 'own PR'
  return kind === 'explicit' ? 'subscribed' : 'implicit'
}

/** The panel's data as one string, so the selector result is stable across
 *  store events that don't change it (a JSON string compares by value).
 *  The derivation reads chat sessions, which churn per streamed token, so
 *  returning fresh objects here would re-render on every token. Null when
 *  the focused tab isn't a Chat tab — the only kind that can follow. */
function selectView(s: AppState, worktreePath: string | null, tabId: string | null): string {
  if (!worktreePath || !tabId) return ''
  if (findTabInWorktree(s, worktreePath, tabId)?.type !== 'json-claude') return ''
  const { following, followers } = tabSubscriptionsView(s, worktreePath, tabId)
  const view: PanelView = {
    following: following.map((f) => ({
      targetPath: f.targetPath,
      name: f.reason === 'own-worktree' ? 'This worktree' : worktreeName(s, f.targetPath),
      kind: f.kind,
      ...(f.reason ? { reason: f.reason } : {}),
      mode: f.mode,
      ...(f.note ? { note: f.note } : {})
    })),
    followers: followers.map((f) => {
      const tab = findTabInWorktree(s, f.subscriberPath, f.subscriberTabId)
      return {
        worktree: worktreeName(s, f.subscriberPath),
        tab: tab ? tabLabel(tab) : 'Chat',
        kind: f.kind,
        ...(f.reason ? { reason: f.reason } : {}),
        mode: f.mode
      }
    })
  }
  return JSON.stringify(view)
}

/** What the focused Chat tab follows, who follows its worktree, and the
 *  notifications held for its next turn. Renders nothing for any other
 *  kind of tab. Hidden by default (DEFAULT_HIDDEN_RIGHT_PANELS). */
export function SubscriptionsPanel({
  worktreePath,
  focusedTabId
}: {
  worktreePath: string | null
  focusedTabId: string | null
}): JSX.Element | null {
  const backend = useBackend()
  const json = useAppState((s) => selectView(s, worktreePath, focusedTabId))
  const view = useMemo<PanelView | null>(() => (json ? JSON.parse(json) : null), [json])
  const held = useAppState((s) =>
    focusedTabId ? s.notifications.pendingByTab[focusedTabId] : undefined
  )

  if (!view || !worktreePath || !focusedTabId) return null
  const heldCount = held?.length ?? 0

  return (
    <RightPanel
      id="subscriptions"
      title="Subscriptions"
      maxHeight="max-h-72"
      actions={
        <span className="text-xs text-faint tabular-nums">
          {heldCount > 0
            ? `${heldCount} held`
            : `${view.following.length} following`}
        </span>
      }
    >
      <div className="py-1 text-xs overflow-y-auto">
        <SectionLabel>Following</SectionLabel>
        {view.following.length === 0 ? (
          <p className="px-3 py-1 text-faint">
            Not following anything. Agents follow worktrees they create, or ones they
            subscribe to.
          </p>
        ) : (
          <ul>
            {view.following.map((f) => (
              <li
                key={f.targetPath}
                className="flex items-center gap-1.5 px-3 py-1 hover:bg-app/60 min-w-0"
                title={f.note ? `Watching for: ${f.note}` : undefined}
              >
                <span className="truncate flex-1 min-w-0 text-fg">{f.name}</span>
                <span className="text-faint shrink-0">{kindLabel(f.kind, f.reason)}</span>
                <button
                  type="button"
                  onClick={() =>
                    void backend.setSubscriptionMode(
                      worktreePath,
                      focusedTabId,
                      f.targetPath,
                      f.mode === 'interrupt' ? 'silent' : 'interrupt'
                    )
                  }
                  className="p-0.5 rounded text-muted hover:text-fg-bright cursor-pointer shrink-0"
                  title={
                    f.mode === 'interrupt'
                      ? 'Interrupts with every update. Click to hold routine updates for the next turn.'
                      : 'Routine updates are held for the next turn. Click to be interrupted by every update.'
                  }
                  aria-label={f.mode === 'interrupt' ? 'Switch to silent' : 'Switch to interrupt'}
                >
                  {f.mode === 'interrupt' ? (
                    <Bell className="icon-xs" />
                  ) : (
                    <BellOff className="icon-xs" />
                  )}
                </button>
                {f.kind === 'explicit' ? (
                  <button
                    type="button"
                    onClick={() => void backend.unsubscribeTab(worktreePath, focusedTabId, f.targetPath)}
                    className="p-0.5 rounded text-muted hover:text-danger cursor-pointer shrink-0"
                    title="Unsubscribe"
                    aria-label={`Unsubscribe from ${f.name}`}
                  >
                    <X className="icon-xs" />
                  </button>
                ) : (
                  <span className="w-4 shrink-0" aria-hidden="true" />
                )}
              </li>
            ))}
          </ul>
        )}

        {view.followers.length > 0 && (
          <>
            <SectionLabel>Followers</SectionLabel>
            <ul>
              {view.followers.map((f, i) => (
                <li key={i} className="flex items-center gap-1.5 px-3 py-1 min-w-0">
                  <span className="truncate flex-1 min-w-0 text-fg">
                    {f.worktree} · {f.tab}
                  </span>
                  <span className="text-faint shrink-0">
                    {kindLabel(f.kind, f.reason)} · {f.mode}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {heldCount > 0 && held && (
          <>
            <div className="flex items-center gap-2 pr-3">
              <SectionLabel>Held for next turn</SectionLabel>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => void backend.deliverHeldNotices(worktreePath, focusedTabId)}
                className="text-accent hover:underline cursor-pointer"
                title="Send these to the agent now, as one turn"
              >
                Deliver now
              </button>
              <button
                type="button"
                onClick={() => void backend.discardHeldNotices(worktreePath, focusedTabId)}
                className="text-muted hover:text-danger cursor-pointer"
              >
                Discard
              </button>
            </div>
            <ul>
              {held.map((n) => {
                const parsed = parseAutomatedMessage(n.wire)
                const firstLine = parsed?.body.split('\n')[0] ?? ''
                return (
                  <li key={n.id} className="px-3 py-1 min-w-0" title={parsed?.body}>
                    <div className="text-faint truncate">
                      {SOURCE_LABELS[n.source] ?? n.source}
                      {n.from ? ` · ${n.from}` : ''}
                    </div>
                    <div className="truncate text-fg">{firstLine}</div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </RightPanel>
  )
}

function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-3 pt-1.5 pb-0.5 text-faint uppercase tracking-wide text-xs">{children}</div>
  )
}
