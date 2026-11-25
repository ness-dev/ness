// Port of renderer/components/JsonModeChat.tsx for the phone. Read them
// side by side: lifecycle, the transcript pipeline (buildChildrenMap →
// results map → tail window → renderEntries → foldFinishedTurns →
// groupConsecutiveToolRows) and the composer rules follow that file, and
// the pure steps are imported from it rather than re-implemented.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState as RNAppState, FlatList, Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { ChevronDown, Loader2, X } from 'lucide-react-native'
import type { JsonClaudeChatEntry, JsonClaudePendingApproval, JsonClaudeSession } from '../../../src/shared/state/json-claude'
import { DEFAULT_JSON_MODE_TRANSCRIPT_WINDOW } from '../../../src/shared/state/settings'
import { buildChildrenMap, isSubAgentToolName } from '../../../src/renderer/components/json-mode-cards/grouping'
import { foldFinishedTurns, getEditedPaths, type TurnSummary } from '../../../src/renderer/components/json-mode-cards/turn-collapse'
import { getToolIntent } from '../../../src/renderer/components/json-mode-cards/tool-display'
import type { NessClient } from '../ness'
import { useNess } from '../ness'
import { alpha, c } from '../theme'
import { Markdown } from './Markdown'
import { Spin } from './Spin'
import {
  AuthCard,
  AutomatedTurnCard,
  CompactCard,
  ExitCard,
  HeldNoticesCard,
  NoticeCard,
  SimpleDangerCard,
  ThinkingCard,
  ToolCardChrome,
  ToolGroup,
  TurnGroup,
  UserBubble,
  dispatchToolCard,
  type GroupRow,
  type ToolResultView
} from '../chat/cards'
import { ApprovalSlot } from '../chat/ApprovalCard'
import { Composer } from '../chat/Composer'
import { DENSITY, DensityContext } from '../chat/density'

interface RenderedRow extends GroupRow {
  entryId?: string
  type: 'text' | 'tool'
  timestamp?: number
  isTurnStart?: boolean
  isTurnError?: boolean
  editedPaths?: string[]
  coveredEntryIds?: string[]
}

interface Ctx {
  results: Map<string, ToolResultView>
  resultEntryIds: Map<string, string>
  children: Map<string, JsonClaudeChatEntry[]>
  approvalCard: (toolUseId: string | undefined) => ReactNode
  pendingToolUseIds: Set<string>
  session: JsonClaudeSession
  onCancelQueued: (entryId: string) => void
  onRestart: () => void
  onSignIn: () => void
}

function renderEntries(entries: JsonClaudeChatEntry[], ctx: Ctx): RenderedRow[] {
  const rows: RenderedRow[] = []
  for (const entry of entries) {
    if (entry.kind === 'user' && entry.heldNotices && entry.heldNotices.length > 0) {
      rows.push({ key: `${entry.entryId}-held`, entryId: entry.entryId, type: 'text', node: <HeldNoticesCard notices={entry.heldNotices as never} /> })
    }
    if (entry.kind === 'user' && entry.automation) {
      rows.push({
        key: entry.entryId,
        entryId: entry.entryId,
        type: 'text',
        isTurnStart: !entry.isQueued,
        node: (
          <AutomatedTurnCard
            source={entry.automation}
            from={entry.automationFrom}
            text={entry.text ?? ''}
            queued={!!entry.isQueued}
            onCancel={() => ctx.onCancelQueued(entry.entryId)}
          />
        )
      })
      continue
    }
    if (entry.kind === 'user') {
      rows.push({
        key: entry.entryId,
        entryId: entry.entryId,
        type: 'text',
        isTurnStart: !entry.isQueued,
        node: <UserBubble text={entry.text ?? ''} queued={!!entry.isQueued} onCancel={() => ctx.onCancelQueued(entry.entryId)} />
      })
      continue
    }
    if (entry.kind === 'compact') {
      rows.push({ key: entry.entryId, entryId: entry.entryId, type: 'tool', node: <CompactCard trigger={entry.compactTrigger} pre={entry.compactPreTokens} post={entry.compactPostTokens} /> })
      continue
    }
    if (entry.kind === 'error' && (entry.errorKind === 'subprocess-exit' || entry.errorKind === 'spawn-failed')) {
      const msg = entry.errorMessage ?? (entry.errorKind === 'spawn-failed' ? "Couldn't launch Claude" : 'Session ended unexpectedly')
      rows.push({ key: entry.entryId, entryId: entry.entryId, type: 'text', isTurnError: true, node: <ExitCard message={msg} isExited={ctx.session.state === 'exited'} onRestart={ctx.onRestart} /> })
      continue
    }
    if (entry.kind === 'error' && entry.errorKind === 'auth-failure') {
      rows.push({ key: entry.entryId, entryId: entry.entryId, type: 'tool', isTurnError: true, node: <AuthCard message={entry.errorMessage} onSignIn={ctx.onSignIn} onRetry={ctx.onRestart} /> })
      continue
    }
    if (entry.kind === 'system' && entry.errorKind === 'rate-limit-warning') {
      rows.push({ key: entry.entryId, entryId: entry.entryId, type: 'tool', node: <NoticeCard title={entry.errorMessage ?? 'Approaching rate limit'} /> })
      continue
    }
    if (entry.kind === 'error' && entry.errorKind === 'agent-error') {
      rows.push({ key: entry.entryId, entryId: entry.entryId, type: 'tool', isTurnError: true, node: <SimpleDangerCard title="Turn failed" detail={entry.errorMessage ?? 'The agent reported an error'} /> })
      continue
    }
    if (entry.kind === 'error' && entry.errorKind === 'rate-limit-error') {
      rows.push({ key: entry.entryId, entryId: entry.entryId, type: 'tool', isTurnError: true, node: <SimpleDangerCard title="Rate limit reached" detail={entry.errorMessage ?? 'Send a new message once the limit resets.'} /> })
      continue
    }
    if (entry.kind === 'assistant' && entry.blocks) {
      for (const [i, block] of entry.blocks.entries()) {
        if (block.type === 'thinking') {
          rows.push({ key: `${entry.entryId}-th-${i}`, entryId: entry.entryId, type: 'tool', isThinking: true, node: <ThinkingCard text={block.text || ''} isPartial={!!entry.isPartial} /> })
        } else if (block.type === 'text' && (block.text || entry.isPartial)) {
          rows.push({ key: `${entry.entryId}-t`, entryId: entry.entryId, type: 'text', node: <AssistantText text={block.text || ''} streaming={!!entry.isPartial} /> })
        } else if (block.type === 'tool_use') {
          const result = block.id ? ctx.results.get(block.id) : undefined
          const placeholder = entry.isPartial && (!block.input || Object.keys(block.input).length === 0)
          let subAgentBody: ReactNode = null
          let subAgentChildCount = 0
          let descendantPending = false
          const resultEntryId = block.id ? ctx.resultEntryIds.get(block.id) : undefined
          const covered = resultEntryId ? [resultEntryId] : []
          if (isSubAgentToolName(block.name) && block.id) {
            const kids = ctx.children.get(block.id) ?? []
            subAgentChildCount = kids.length
            if (kids.length > 0) {
              const childRows = renderEntries(kids, ctx)
              descendantPending = childRows.some((r) => r.hasPendingApproval)
              for (const k of kids) covered.push(k.entryId)
              for (const r of childRows) covered.push(...(r.coveredEntryIds ?? []))
              subAgentBody = <Grouped items={groupConsecutiveToolRows(childRows)} />
            }
          }
          rows.push({
            key: `${entry.entryId}-${block.id || 'tu'}`,
            entryId: entry.entryId,
            type: 'tool',
            toolName: block.name,
            toolIntent: getToolIntent(block) ?? undefined,
            hasError: !!result?.isError,
            images: result?.images,
            editedPaths: getEditedPaths(block.name, block.input),
            ...(covered.length > 0 ? { coveredEntryIds: covered } : {}),
            hasPendingApproval: (!!block.id && ctx.pendingToolUseIds.has(block.id)) || descendantPending,
            node: (
              <>
                {placeholder ? (
                  <ToolCardChrome name={block.name || 'tool'} subtitle="preparing call…">
                    <Text style={{ color: c.muted, fontSize: 12, fontStyle: 'italic', padding: 8 }}>waiting for input</Text>
                  </ToolCardChrome>
                ) : (
                  dispatchToolCard({
                    block,
                    result,
                    autoApproved: block.id ? ctx.session.autoApprovedDecisions[block.id] : undefined,
                    sessionAllowed: block.id ? ctx.session.sessionAllowedDecisions[block.id] : undefined,
                    subAgentBody,
                    subAgentChildCount,
                    subAgentDescendantHasPendingApproval: descendantPending,
                    backgroundAgent: block.id ? ctx.session.backgroundAgents?.[block.id] : undefined
                  })
                )}
                {ctx.approvalCard(block.id)}
              </>
            )
          })
        }
      }
    }
  }
  const ts = new Map(entries.map((e) => [e.entryId, e.timestamp]))
  for (const r of rows) if (r.entryId) r.timestamp = ts.get(r.entryId)
  return rows
}

interface GroupedItem {
  kind: 'single' | 'group'
  key: string
  rows: RenderedRow[]
}
type DisplayItem = GroupedItem | { kind: 'turn'; key: string; rows: RenderedRow[]; summary: TurnSummary; items: GroupedItem[] }

function groupConsecutiveToolRows(rows: RenderedRow[]): GroupedItem[] {
  const out: GroupedItem[] = []
  let buf: RenderedRow[] = []
  const flush = () => {
    if (buf.length === 0) return
    out.push(buf.length === 1 ? { kind: 'single', key: buf[0].key, rows: buf } : { kind: 'group', key: `group-${buf[0].key}`, rows: buf })
    buf = []
  }
  for (const r of rows) {
    if (r.type === 'tool') buf.push(r)
    else {
      flush()
      out.push({ kind: 'single', key: r.key, rows: [r] })
    }
  }
  flush()
  return out
}

function Grouped({ items }: { items: GroupedItem[] }) {
  return (
    <View style={{ gap: 4 }}>
      {items.map((it) => (
        <GroupedNode key={it.key} item={it} />
      ))}
    </View>
  )
}

function GroupedNode({ item }: { item: GroupedItem }) {
  return item.kind === 'group' ? <ToolGroup rows={item.rows} /> : <>{item.rows[0].node}</>
}

function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  const d = DENSITY.compact
  return (
    <View>
      <Markdown text={text} size={d.body} />
      {streaming && <View style={{ width: 7, height: 14, backgroundColor: c.muted, marginTop: 2, opacity: 0.7 }} />}
    </View>
  )
}

// ── the view ───────────────────────────────────────────────────────────

export function ChatView({
  client,
  sessionId,
  worktreePath,
  mode
}: {
  client: NessClient
  sessionId: string
  worktreePath: string
  mode: 'awake' | 'asleep'
}) {
  const session = useNess(client, (s) => s.jsonClaude.sessions[sessionId])
  const allApprovals = useNess(client, (s) => s.jsonClaude.pendingApprovals)
  const settings = useNess(client, (s) => s.settings)
  const density = DENSITY[settings.jsonModeChatDensity === 'comfy' ? 'comfy' : 'compact']

  // Lifecycle (JsonModeChat.tsx:1864-1881): start only an awake tab with
  // no session at all (an exited one waits for Restart); fetch history
  // once per session.
  const sessionExists = !!session
  useEffect(() => {
    if (mode === 'awake' && !sessionExists) void client.req('jsonClaude:start', sessionId, worktreePath)
  }, [client, sessionId, worktreePath, mode, sessionExists])
  const fetched = useRef(new Set<string>())
  useEffect(() => {
    if (!sessionExists || fetched.current.has(sessionId)) return
    fetched.current.add(sessionId)
    void client.req('jsonClaude:getEntries', sessionId)
  }, [client, sessionId, sessionExists])

  // setComposerVisible: tells main someone is looking (gates attention
  // notifications). App backgrounding counts as hidden, like
  // document.visibilityState on the web.
  useEffect(() => {
    if (mode === 'asleep') return
    let visible = RNAppState.currentState === 'active'
    if (visible) void client.req('jsonClaude:setComposerVisible', sessionId, true)
    const sub = RNAppState.addEventListener('change', (st) => {
      const next = st === 'active'
      if (next === visible) return
      visible = next
      void client.req('jsonClaude:setComposerVisible', sessionId, next)
    })
    return () => {
      sub.remove()
      if (visible) void client.req('jsonClaude:setComposerVisible', sessionId, false)
    }
  }, [client, sessionId, mode])

  const approvals = useMemo(
    () => Object.values(allApprovals).filter((a) => a.sessionId === sessionId),
    [allApprovals, sessionId]
  )
  const approvalByToolUseId = useMemo(() => {
    const m = new Map<string, JsonClaudePendingApproval>()
    for (const a of approvals) if (a.toolUseId) m.set(a.toolUseId, a)
    return m
  }, [approvals])
  const pendingToolUseIds = useMemo(() => new Set(approvalByToolUseId.keys()), [approvalByToolUseId])

  const windowSetting = settings.jsonModeTranscriptWindow ?? DEFAULT_JSON_MODE_TRANSCRIPT_WINDOW
  const [windowSize, setWindowSize] = useState(windowSetting <= 0 ? Infinity : windowSetting)

  const restart = useCallback(() => {
    void (async () => {
      await client.req('jsonClaude:kill', sessionId)
      await client.req('jsonClaude:start', sessionId, worktreePath)
    })()
  }, [client, sessionId, worktreePath])

  const entries = session?.entries
  const { rows, hidden, renderedToolUseIds } = useMemo(() => {
    if (!session || !entries) return { rows: [] as RenderedRow[], hidden: 0, renderedToolUseIds: new Set<string>() }
    const { topLevelEntries, childrenByParentToolUseId } = buildChildrenMap(entries)
    const results = new Map<string, ToolResultView>()
    const resultEntryIds = new Map<string, string>()
    for (const e of entries) {
      if (e.kind !== 'tool_result' || !e.blocks) continue
      for (const b of e.blocks) {
        if (b.type === 'tool_result' && b.toolUseId) {
          resultEntryIds.set(b.toolUseId, e.entryId)
          results.set(b.toolUseId, { content: b.content || '', isError: !!b.isError, ...(b.images?.length ? { images: b.images } : {}) })
        }
      }
    }
    const renderable = topLevelEntries.filter((e) => e.kind !== 'tool_result')
    const start = Math.max(0, renderable.length - windowSize)
    const seen = new Set<string>()
    const out = renderEntries(start === 0 ? renderable : renderable.slice(start), {
      results,
      resultEntryIds,
      children: childrenByParentToolUseId,
      pendingToolUseIds,
      session,
      approvalCard: (id) => {
        if (!id) return null
        const a = approvalByToolUseId.get(id)
        if (!a) return null
        seen.add(id)
        return <ApprovalSlot approval={a} client={client} session={session} />
      },
      onCancelQueued: (entryId) => client.sig('jsonClaude:cancelQueued', sessionId, entryId),
      onRestart: restart,
      onSignIn: () => void client.req('jsonClaude:openAuthLoginTab', worktreePath)
    })
    return { rows: out, hidden: start, renderedToolUseIds: seen }
    // session identity changes per event; the deps below are what the
    // pipeline actually reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, windowSize, approvalByToolUseId, pendingToolUseIds, session?.state, session?.autoApprovedDecisions, session?.sessionAllowedDecisions, session?.backgroundAgents, client, sessionId, worktreePath, restart])

  const busy = !!session?.busy
  const turnStartedAt = session?.turnStartedAt
  const items = useMemo<DisplayItem[]>(() => {
    if (!settings.collapseFinishedTurns) return groupConsecutiveToolRows(rows)
    return foldFinishedTurns(rows, { busy, turnStartedAt }).flatMap((it): DisplayItem[] =>
      it.kind === 'rows'
        ? groupConsecutiveToolRows(it.rows)
        : [{ kind: 'turn', key: it.key, rows: it.rows, summary: it.summary, items: groupConsecutiveToolRows(it.rows) }]
    )
  }, [rows, settings.collapseFinishedTurns, busy, turnStartedAt])

  // Approvals whose tool_use isn't on screen yet render at the bottom.
  const orphans = approvals.filter((a) => !a.toolUseId || !renderedToolUseIds.has(a.toolUseId))

  const lastEntry = entries?.[entries.length - 1]
  const lastBlock = lastEntry?.blocks?.[lastEntry.blocks.length - 1]
  const streamingVisible = lastEntry?.kind === 'assistant' && lastEntry.isPartial && (lastBlock?.type === 'text' || lastBlock?.type === 'tool_use')
  const showWorking = busy && !streamingVisible

  // Inverted list: index 0 is the bottom. Offset 0 = stuck to bottom.
  const listRef = useRef<FlatList<DisplayItem>>(null)
  const [awayFromBottom, setAway] = useState(false)
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setAway(e.nativeEvent.contentOffset.y > 32)
  }, [])
  const reversed = useMemo(() => [...items].reverse(), [items])

  const sessionApprovals = session?.sessionToolApprovals ?? []

  return (
    <DensityContext.Provider value={density}>
      <View style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          data={reversed}
          inverted
          keyExtractor={(i) => i.key}
          renderItem={({ item }) => <DisplayRow item={item} />}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6 }}
          onScroll={onScroll}
          scrollEventThrottle={64}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          // Long transcripts: render the tail first, mount the rest lazily.
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={9}
          ListHeaderComponent={
            <View style={{ gap: 6 }}>
              {orphans.map((a) => (
                <ApprovalSlot key={a.requestId} approval={a} client={client} session={session} />
              ))}
              {showWorking && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
                  <Spin>
                    <Loader2 color={c.muted} size={12} />
                  </Spin>
                  <Text style={{ color: c.muted, fontSize: density.chrome }}>thinking…</Text>
                </View>
              )}
            </View>
          }
          ListFooterComponent={
            hidden > 0 ? (
              <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 16, paddingVertical: 8 }}>
                <Pressable hitSlop={12} onPress={() => setWindowSize((w) => w + (windowSetting > 0 ? windowSetting : 150))}>
                  <Text style={{ color: c.accent, fontSize: density.chrome }}>
                    Show {Math.min(hidden, windowSetting > 0 ? windowSetting : 150)} earlier message{hidden === 1 ? '' : 's'}
                  </Text>
                </Pressable>
                <Pressable hitSlop={12} onPress={() => setWindowSize(Infinity)}>
                  <Text style={{ color: c.muted, fontSize: density.chrome }}>Show all ({hidden + rows.length})</Text>
                </Pressable>
              </View>
            ) : undefined
          }
        />
        {awayFromBottom && (
          <Pressable
            onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
            accessibilityLabel="Jump to bottom"
            style={{ position: 'absolute', right: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 12, minHeight: 36 }}
          >
            <ChevronDown color="#fff" size={14} />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '500' }}>Jump to bottom</Text>
          </Pressable>
        )}
      </View>
      {sessionApprovals.length > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 4, borderTopWidth: 1, borderColor: c.border, backgroundColor: alpha(c.success, 0.05) }}>
          <Text style={{ color: c.muted, fontSize: 11 }}>auto-allowing:</Text>
          <Text style={{ color: c.fg, fontSize: 11, flex: 1, fontFamily: 'Menlo' }} numberOfLines={1}>
            {sessionApprovals.join(', ')}
          </Text>
          <Pressable hitSlop={14} accessibilityLabel="Stop auto-allowing" onPress={() => void client.req('jsonClaude:clearSessionToolApprovals', sessionId)}>
            <X color={c.muted} size={14} />
          </Pressable>
        </View>
      )}
      <Composer
        client={client}
        session={session}
        sessionId={sessionId}
        worktreePath={worktreePath}
        mode={mode}
        onSent={() => listRef.current?.scrollToOffset({ offset: 0, animated: false })}
      />
    </DensityContext.Provider>
  )
}

function DisplayRow({ item }: { item: DisplayItem }) {
  if (item.kind === 'turn') {
    return (
      <TurnGroup summary={item.summary} hasError={item.rows.some((r) => r.hasError)}>
        <Grouped items={item.items} />
      </TurnGroup>
    )
  }
  return <GroupedNode item={item} />
}
