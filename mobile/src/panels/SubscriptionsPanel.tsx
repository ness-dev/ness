// Port of renderer/components/SubscriptionsPanel.tsx. Same JSON-string
// selector (stable across token churn), labels, and requests. Hover
// titles become tap-to-expand: a following row reveals its note and what
// its mode does, a held notice reveals its full body, and the "Deliver
// now" mid-turn explanation is shown inline while the button is disabled.
import { useMemo, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Bell, BellOff, X } from 'lucide-react-native'
import { findTabInWorktree, tabLabel } from '../../../src/shared/agent-tabs'
import { tabSubscriptionsView, type Subscriber } from '../../../src/shared/subscribers'
import { parseAutomatedMessage, type JsonClaudeAutomationSource } from '../../../src/shared/state/json-claude'
import type { AppState } from '../../../src/shared/state'
import { useNess } from '../ness'
import { alpha, c, fs } from '../theme'
import { RightPanel } from './RightPanel'
import type { PanelProps } from './types'

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

/** max-h-72 on the desktop's RightPanel. */
const MAX_H = 288

function worktreeName(s: AppState, path: string): string {
  return s.aliases.byPath[path] || s.worktrees.list.find((w) => w.path === path)?.branch || path.split('/').pop() || path
}

function kindLabel(kind: Subscriber['kind'], reason?: Subscriber['reason']): string {
  if (reason === 'created-worktree') return 'created it'
  if (reason === 'own-worktree') return 'own PR'
  return kind === 'explicit' ? 'subscribed' : 'implicit'
}

/** Copied from the desktop panel: one JSON string so the selector result
 *  compares by value. Empty when the focused tab isn't a Chat tab. */
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

const small = { fontSize: fs.xs }

function IconBtn({ onPress, label, children }: { onPress: () => void; label: string; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      style={({ pressed }) => ({ width: 36, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 4, backgroundColor: pressed ? c.surface : 'transparent' })}
    >
      {children}
    </Pressable>
  )
}

export function SubscriptionsPanel({ client, worktreePath, focusedTabId }: PanelProps) {
  const json = useNess(client, (s) => selectView(s, worktreePath, focusedTabId))
  const view = useMemo<PanelView | null>(() => (json ? JSON.parse(json) : null), [json])
  const held = useNess(client, (s) => (focusedTabId ? s.notifications.pendingByTab[focusedTabId] : undefined))
  const busy = useNess(client, (s) => (focusedTabId ? s.jsonClaude.sessions[focusedTabId]?.busy === true : false))
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [openNotice, setOpenNotice] = useState<string | null>(null)

  if (!view || !worktreePath || !focusedTabId) return null
  const heldCount = held?.length ?? 0

  return (
    <RightPanel
      id="subscriptions"
      title="Subscriptions"
      actions={
        <Text style={{ ...small, color: c.faint, fontVariant: ['tabular-nums'] }}>{heldCount > 0 ? `${heldCount} held` : `${view.following.length} following`}</Text>
      }
    >
      <ScrollView style={{ maxHeight: MAX_H }} nestedScrollEnabled contentContainerStyle={{ paddingVertical: 4 }}>
        <SectionLabel>Following</SectionLabel>
        {view.following.length === 0 ? (
          <Text style={{ ...small, color: c.faint, paddingHorizontal: 12, paddingVertical: 4 }}>
            Not following anything. Agents follow worktrees they create, or ones they subscribe to.
          </Text>
        ) : (
          view.following.map((f) => {
            const open = openRow === f.targetPath
            const ownPr = f.reason === 'own-worktree'
            return (
              <View key={f.targetPath}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 6, minWidth: 0 }}>
                  <Pressable
                    onPress={() => setOpenRow(open ? null : f.targetPath)}
                    style={{ flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}
                  >
                    <Text numberOfLines={1} style={{ ...small, flex: 1, minWidth: 0, color: c.fg }}>
                      {f.name}
                    </Text>
                    <Text style={{ ...small, color: c.faint }}>{kindLabel(f.kind, f.reason)}</Text>
                  </Pressable>
                  {ownPr ? (
                    // Own-PR updates are governed by "Tell the agent about
                    // its PR" (PR panel), not a subscription mode.
                    <View style={{ width: 36 }} />
                  ) : (
                    <IconBtn
                      label={f.mode === 'interrupt' ? 'Switch to silent' : 'Switch to interrupt'}
                      onPress={() => void client.api.setSubscriptionMode(worktreePath, focusedTabId, f.targetPath, f.mode === 'interrupt' ? 'silent' : 'interrupt')}
                    >
                      {f.mode === 'interrupt' ? <Bell color={c.muted} size={12} /> : <BellOff color={c.muted} size={12} />}
                    </IconBtn>
                  )}
                  {f.kind === 'explicit' ? (
                    <IconBtn label={`Unsubscribe from ${f.name}`} onPress={() => void client.api.unsubscribeTab(worktreePath, focusedTabId, f.targetPath)}>
                      <X color={c.muted} size={12} />
                    </IconBtn>
                  ) : (
                    <View style={{ width: 36 }} />
                  )}
                </View>
                {open && (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 6, gap: 2 }}>
                    {f.note && <Text style={{ ...small, color: c.faint }}>Watching for: {f.note}</Text>}
                    {!ownPr && (
                      <Text style={{ ...small, color: c.faint }}>
                        {f.mode === 'interrupt'
                          ? 'Interrupts with every update. Tap the bell to hold routine updates for the next turn.'
                          : 'Routine updates are held for the next turn. Tap the bell to be interrupted by every update.'}
                      </Text>
                    )}
                    {f.kind === 'explicit' && <Text style={{ ...small, color: c.faint }}>Tap × to unsubscribe.</Text>}
                  </View>
                )}
              </View>
            )
          })
        )}

        {view.followers.length > 0 && (
          <>
            <SectionLabel>Followers</SectionLabel>
            {view.followers.map((f, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 4, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ ...small, flex: 1, minWidth: 0, color: c.fg }}>
                  {f.worktree} · {f.tab}
                </Text>
                <Text style={{ ...small, color: c.faint }}>
                  {kindLabel(f.kind, f.reason)} · {f.mode}
                </Text>
              </View>
            ))}
          </>
        )}

        {heldCount > 0 && held && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 6 }}>
              <SectionLabel>Held</SectionLabel>
              <View style={{ flex: 1 }} />
              <Pressable
                disabled={busy}
                onPress={() => void client.api.deliverHeldNotices(worktreePath, focusedTabId)}
                style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6, opacity: busy ? 0.5 : 1 }}
              >
                <Text style={{ ...small, color: c.accent }}>Deliver now</Text>
              </Pressable>
              <Pressable
                onPress={() => void client.api.discardHeldNotices(worktreePath, focusedTabId)}
                accessibilityHint="Drop these without telling the agent"
                style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }}
              >
                <Text style={{ ...small, color: c.muted }}>Discard</Text>
              </Pressable>
            </View>
            {busy && (
              <Text style={{ ...small, color: c.faint, paddingHorizontal: 12, paddingBottom: 4 }}>The agent is mid-turn — these go out with its next turn</Text>
            )}
            {held.map((n) => {
              const parsed = parseAutomatedMessage(n.wire)
              const firstLine = parsed?.body.split('\n')[0] ?? ''
              const open = openNotice === n.id
              return (
                <Pressable
                  key={n.id}
                  onPress={() => setOpenNotice(open ? null : n.id)}
                  style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 4, backgroundColor: pressed ? alpha(c.app, 0.6) : 'transparent' })}
                >
                  <Text numberOfLines={1} style={{ ...small, color: c.faint }}>
                    {SOURCE_LABELS[n.source] ?? n.source}
                    {n.from ? ` · ${n.from}` : ''}
                  </Text>
                  <Text numberOfLines={open ? undefined : 1} style={{ ...small, color: c.fg }}>
                    {open ? (parsed?.body ?? '') : firstLine}
                  </Text>
                </Pressable>
              )
            })}
          </>
        )}
      </ScrollView>
    </RightPanel>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <Text style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 2, color: c.faint, textTransform: 'uppercase', letterSpacing: 0.6, fontSize: fs.xs }}>{children}</Text>
}
