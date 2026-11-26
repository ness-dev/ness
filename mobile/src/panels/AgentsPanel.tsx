// Port of renderer/components/JsonClaudeAgentsPanel.tsx, with its helpers
// (useSessionAgents, AgentStatusDot, AgentStepLine, AgentPeek) ported
// alongside. Tree/elapsed/status logic is the shared
// json-claude-agents module; the peek is an RN Modal instead of a portal.
// The row's hover title (kind, status, tool count) is in the peek's header,
// which tapping the row opens — same as the desktop's click target.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View, type ScrollViewInstance } from 'react-native'
import { Brain, CornerDownRight, Loader2, MessageSquare, Sparkles, Wrench, X } from 'lucide-react-native'
import {
  agentElapsedMs,
  buildAgentTree,
  collectAgents,
  countRunningAgents,
  formatElapsed,
  isSubAgentToolName,
  type AgentStep,
  type AgentSummary,
  type AgentTree
} from '../../../src/shared/state/json-claude-agents'
import type { JsonClaudePendingApproval } from '../../../src/shared/state/json-claude'
import { extractArgs, getToolDisplay } from '../../../src/renderer/components/json-mode-cards/tool-display'
import { useSessionRevision } from '../../../src/renderer/session-revision'
import { useNess, type NessClient } from '../ness'
import { alpha, c, fs } from '../theme'
import { Spin } from '../components/Spin'
import { Markdown } from '../components/Markdown'
import { ToolIcon } from '../chat/cards'
import { RightPanel } from './RightPanel'
import type { PanelProps } from './types'

/** Top-level agents shown before collapsing the rest behind a toggle. */
const SETTLED_PREVIEW = 5
/** max-h-72 on the desktop's RightPanel. */
const MAX_H = 288
/** AgentPeek's TEXT_PREVIEW. */
const TEXT_PREVIEW = 600

// ── copied from renderer/hooks/useSessionAgents.ts ─────────────────────

function pendingToolUseIdsKey(approvals: Record<string, JsonClaudePendingApproval>, sessionId: string | undefined): string {
  if (!sessionId) return ''
  const ids: string[] = []
  for (const p of Object.values(approvals)) {
    if (p.sessionId === sessionId && p.toolUseId) ids.push(p.toolUseId)
  }
  return ids.sort().join('\n')
}

function useSessionAgents(client: NessClient, tabSessionId: string): { agents: AgentSummary[]; running: number } {
  const session = useNess(client, (s) => s.jsonClaude.sessions[tabSessionId] ?? null)
  const sessionId = session?.sessionId
  const pendingKey = useNess(client, (s) => pendingToolUseIdsKey(s.jsonClaude.pendingApprovals, sessionId))
  const pendingToolUseIds = useMemo(() => new Set(pendingKey ? pendingKey.split('\n') : []), [pendingKey])

  const sessionRef = useRef(session)
  sessionRef.current = session
  const runningRef = useRef(0)
  const revision = useSessionRevision(session, runningRef.current > 0)
  const prevAgentsRef = useRef<readonly AgentSummary[]>([])
  const agents = useMemo(() => {
    const next = collectAgents(sessionRef.current, pendingToolUseIds, prevAgentsRef.current)
    prevAgentsRef.current = next
    return next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, pendingToolUseIds])

  const running = countRunningAgents(agents)
  runningRef.current = running
  return { agents, running }
}

// ── from JsonClaudeAgentsPanel.tsx ─────────────────────────────────────

/** One shared 1s clock, only while something is running. */
function useLiveClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

// ── copied from renderer/components/AgentStatusDot.tsx ─────────────────

function agentStatusLabel(agent: AgentSummary): string {
  if (agent.hasPendingApproval) return 'needs approval'
  switch (agent.status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
  }
}

function Spinner() {
  return (
    <Spin>
      <Loader2 color={c.muted} size={12} />
    </Spin>
  )
}

function AgentStatusDot({ agent }: { agent: AgentSummary }) {
  if (agent.hasPendingApproval) {
    return (
      <Text accessibilityLabel="needs approval" style={{ color: c.warning, fontSize: fs.xs }}>
        ⚠
      </Text>
    )
  }
  if (agent.status === 'running') return <Spinner />
  const color = agent.status === 'completed' ? c.success : agent.status === 'failed' ? c.danger : c.faint
  const glyph = agent.status === 'completed' ? '✓' : agent.status === 'failed' ? '✕' : '⊘'
  return (
    <Text accessibilityLabel={agentStatusLabel(agent)} style={{ color, fontSize: fs.xs }}>
      {glyph}
    </Text>
  )
}

// ── copied from renderer/components/AgentStepLine.tsx ──────────────────

const SUBJECT_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description', 'subject']

function summarizeStepArgs(step: AgentStep): string {
  if (step.kind !== 'tool') return ''
  const args = extractArgs(step.input)
  if (args.length === 0) return ''
  const preferred = SUBJECT_KEYS.map((k) => args.find((a) => a.key === k)).find(Boolean) ?? args[0]
  return preferred.value.replace(/\s+/g, ' ').trim()
}

function AgentStepLine({ step, dim = false }: { step: AgentStep; dim?: boolean }) {
  const row = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, minWidth: 0, flex: 1 }
  if (step.kind === 'thinking') {
    return (
      <View style={row}>
        <Brain color={c.muted} size={10} />
        <Text numberOfLines={1} style={{ color: c.muted, fontStyle: 'italic', fontSize: fs.xs }}>
          thinking
        </Text>
      </View>
    )
  }
  if (step.kind === 'text') {
    return (
      <View style={row}>
        <MessageSquare color={c.muted} size={10} />
        <Text numberOfLines={1} style={{ flex: 1, color: dim ? c.muted : c.fg, fontSize: fs.xs }}>
          {step.text}
        </Text>
      </View>
    )
  }
  const nested = isSubAgentToolName(step.toolName)
  const display = getToolDisplay(step.toolName)
  const detail = summarizeStepArgs(step)
  const iconColor = step.isError ? c.danger : c.muted
  return (
    <View style={row}>
      {nested ? (
        <Sparkles color={iconColor} size={10} />
      ) : display.icon ? (
        <ToolIcon icon={display.icon as never} className={`icon-2xs ${step.isError ? 'text-danger' : 'text-muted'}`} />
      ) : (
        <Wrench color={iconColor} size={10} />
      )}
      <Text style={{ color: c.muted, fontSize: fs.xs }}>{display.compactLabel}</Text>
      {!!detail && (
        <Text numberOfLines={1} style={{ flex: 1, fontSize: fs.xs, color: dim ? alpha(c.muted, 0.7) : c.fg, opacity: dim ? 1 : 0.7 }}>
          {detail}
        </Text>
      )}
    </View>
  )
}

// ── AgentRow ───────────────────────────────────────────────────────────

function AgentRow({
  agent,
  tree,
  now,
  depth,
  isExpanded,
  onToggle,
  onPeek
}: {
  agent: AgentSummary
  tree: AgentTree
  now: number
  depth: number
  isExpanded: (id: string) => boolean
  onToggle: (id: string) => void
  onPeek: (id: string) => void
}) {
  const children = tree.childrenByParent.get(agent.toolUseId) ?? []
  const expanded = children.length > 0 && isExpanded(agent.toolUseId)
  const lastStep = agent.steps.length ? agent.steps[agent.steps.length - 1] : null
  const running = agent.status === 'running'
  const elapsed = formatElapsed(agentElapsedMs(agent, now))
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'stretch', paddingLeft: 12 + Math.min(depth, 4) * 12, paddingRight: 12 }}>
        {children.length > 0 ? (
          <Pressable
            onPress={() => onToggle(agent.toolUseId)}
            accessibilityState={{ expanded }}
            accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${children.length} nested`}
            hitSlop={{ left: 12, right: 4 }}
            style={{ width: 28, minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ color: c.muted, fontSize: fs.xs }}>{expanded ? '▾' : '▸'}</Text>
          </Pressable>
        ) : (
          <View style={{ width: 28 }} />
        )}
        <Pressable
          onPress={() => onPeek(agent.toolUseId)}
          style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', paddingVertical: 4, backgroundColor: pressed ? c.app : 'transparent' })}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <AgentStatusDot agent={agent} />
            <Text
              numberOfLines={1}
              style={{ flex: 1, minWidth: 0, fontSize: fs.xs, color: running ? c.fgBright : c.fg, opacity: agent.status === 'interrupted' ? 0.6 : 1 }}
            >
              {agent.description}
            </Text>
            {children.length > 0 && !expanded && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                <CornerDownRight color={c.faint} size={10} />
                <Text style={{ color: c.faint, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>{children.length}</Text>
              </View>
            )}
            {agent.isBackground && (
              <Text accessibilityLabel="detached — runs past the end of the turn" style={{ color: c.faint, fontSize: fs.xs, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                bg
              </Text>
            )}
            <Text style={{ color: c.faint, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>{elapsed}</Text>
          </View>
          {running && lastStep && (
            <View style={{ flexDirection: 'row', opacity: 0.8, minWidth: 0 }}>
              <AgentStepLine step={lastStep} dim />
            </View>
          )}
        </Pressable>
      </View>
      {expanded &&
        children.map((child) => (
          <AgentRow key={child.toolUseId} agent={child} tree={tree} now={now} depth={depth + 1} isExpanded={isExpanded} onToggle={onToggle} onPeek={onPeek} />
        ))}
    </View>
  )
}

// ── port of renderer/components/AgentPeek.tsx ──────────────────────────

function AgentPeek({ agent, now, onClose, onPeekAgent }: { agent: AgentSummary; now: number; onClose: () => void; onPeekAgent: (id: string) => void }) {
  const feedRef = useRef<ScrollViewInstance>(null)
  // Follow the tail only while the user hasn't scrolled away.
  const pinnedToBottomRef = useRef(true)

  const elapsed = formatElapsed(agentElapsedMs(agent, now))
  const usage = agent.usage
  const meta = [
    agent.subagentType,
    agent.model,
    `${agent.toolCount} ${agent.toolCount === 1 ? 'tool' : 'tools'}`,
    usage?.totalTokens !== undefined ? `${Math.round(usage.totalTokens / 1000)}k tokens` : null,
    elapsed
  ].filter(Boolean) as string[]

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
        <Pressable
          onPress={() => {}}
          style={{ width: '100%', maxWidth: 704, height: '82%', backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, borderRadius: 12, overflow: 'hidden' }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingVertical: 4, borderBottomWidth: 1, borderColor: alpha(c.border, 0.6) }}>
            <Sparkles color={c.muted} size={14} />
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: fs.sm, color: c.fgBright }}>
              {agent.description}
            </Text>
            {agent.isBackground && (
              <Text style={{ fontSize: fs.xs, color: c.muted, textTransform: 'uppercase', letterSpacing: 0.6, backgroundColor: alpha(c.app, 0.6), borderWidth: 1, borderColor: alpha(c.border, 0.5), borderRadius: 4, paddingHorizontal: 4, paddingVertical: 2 }}>
                background
              </Text>
            )}
            <AgentStatusDot agent={agent} />
            <Text style={{ fontSize: fs.xs, color: c.muted }}>{agentStatusLabel(agent)}</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close agent peek" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <X color={c.muted} size={14} />
            </Pressable>
          </View>

          <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: alpha(c.border, 0.4), flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            {meta.map((m) => (
              <Text key={m} style={{ fontSize: fs.xs, color: c.faint, fontVariant: ['tabular-nums'] }}>
                {m}
              </Text>
            ))}
            {agent.parentDescription && (
              <Text numberOfLines={1} style={{ fontSize: fs.xs, color: c.faint }}>
                via {agent.parentDescription}
              </Text>
            )}
          </View>

          <ScrollView
            ref={feedRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 4 }}
            scrollEventThrottle={64}
            onScroll={(e) => {
              const { contentSize, contentOffset, layoutMeasurement } = e.nativeEvent
              pinnedToBottomRef.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 32
            }}
            onContentSizeChange={() => {
              if (pinnedToBottomRef.current) feedRef.current?.scrollToEnd({ animated: false })
            }}
          >
            {agent.steps.length === 0 && (
              <Text style={{ color: c.muted, fontStyle: 'italic', fontSize: fs.xs, paddingVertical: 8 }}>
                {agent.status === 'running' ? 'agent is starting…' : 'no activity recorded'}
              </Text>
            )}
            {agent.steps.map((step) =>
              step.kind === 'text' ? (
                <View key={step.key} style={{ paddingVertical: 4, paddingLeft: 16, borderLeftWidth: 2, borderColor: alpha(c.border, 0.5) }}>
                  <Markdown size={fs.xs} text={step.text && step.text.length > TEXT_PREVIEW ? `${step.text.slice(0, TEXT_PREVIEW)}…` : (step.text ?? '')} />
                </View>
              ) : step.childAgentToolUseId ? (
                <Pressable
                  key={step.key}
                  onPress={() => onPeekAgent(step.childAgentToolUseId!)}
                  style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4, borderRadius: 4, backgroundColor: pressed ? alpha(c.app, 0.6) : 'transparent', flexDirection: 'row' })}
                >
                  <AgentStepLine step={step} />
                </Pressable>
              ) : (
                <View key={step.key} style={{ paddingHorizontal: 4, paddingVertical: 2, flexDirection: 'row' }}>
                  <AgentStepLine step={step} />
                </View>
              )
            )}
            {agent.status === 'running' && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 4 }}>
                <Spinner />
                <Text style={{ color: c.muted, fontStyle: 'italic', fontSize: fs.xs }}>working…</Text>
              </View>
            )}
          </ScrollView>

          {agent.result && (
            <ScrollView style={{ maxHeight: 192, borderTopWidth: 1, borderColor: alpha(c.border, 0.6) }} nestedScrollEnabled>
              <Text style={{ paddingHorizontal: 12, paddingTop: 8, fontSize: fs.xs, color: c.faint, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                {agent.resultIsError ? 'error' : 'report'}
              </Text>
              <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
                <Markdown size={fs.xs} color={agent.resultIsError ? c.danger : c.fg} text={agent.result} />
              </View>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ── panel ──────────────────────────────────────────────────────────────

export function AgentsPanel({ client, focusedTabId }: PanelProps) {
  const { agents, running } = useSessionAgents(client, focusedTabId ?? '')
  const [peekId, setPeekId] = useState<string | null>(null)
  const [showAllSettled, setShowAllSettled] = useState(false)
  // Explicit user choices only; rows with a running descendant default open.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map())

  const tree = useMemo(() => buildAgentTree(agents), [agents])
  const now = useLiveClock(running > 0)

  const expandedFor = useCallback((id: string): boolean => overrides.get(id) ?? tree.hasRunningDescendant.has(id), [overrides, tree])
  const toggleExpanded = useCallback(
    (id: string): void =>
      setOverrides((cur) => {
        const next = new Map(cur)
        next.set(id, !(cur.get(id) ?? tree.hasRunningDescendant.has(id)))
        return next
      }),
    [tree]
  )

  // A peek whose agent vanished would trap the overlay — drop it.
  const peeked = peekId ? agents.find((a) => a.toolUseId === peekId) : undefined
  useEffect(() => {
    if (peekId && !peeked) setPeekId(null)
  }, [peekId, peeked])

  if (agents.length === 0) return null

  // Only top-level agents are capped; `roots` is running-first.
  const runningRoots = tree.roots.filter((a) => a.status === 'running').length
  const settledRoots = tree.roots.length - runningRoots
  const hiddenCount = showAllSettled ? 0 : Math.max(0, settledRoots - SETTLED_PREVIEW)
  const shown = hiddenCount > 0 ? tree.roots.slice(0, runningRoots + SETTLED_PREVIEW) : tree.roots

  return (
    <>
      <RightPanel
        id="agents"
        title="Agents"
        actions={
          <Text style={{ fontSize: fs.xs, color: c.faint, fontVariant: ['tabular-nums'] }}>{running > 0 ? `${running} running` : `${agents.length} done`}</Text>
        }
      >
        <ScrollView style={{ maxHeight: MAX_H }} nestedScrollEnabled contentContainerStyle={{ paddingVertical: 4 }}>
          {shown.map((a) => (
            <AgentRow key={a.toolUseId} agent={a} tree={tree} now={now} depth={0} isExpanded={expandedFor} onToggle={toggleExpanded} onPeek={setPeekId} />
          ))}
          {settledRoots > SETTLED_PREVIEW && (
            <Pressable
              onPress={() => setShowAllSettled((v) => !v)}
              style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, backgroundColor: pressed ? alpha(c.app, 0.6) : 'transparent' })}
            >
              <Text style={{ color: c.faint, fontSize: fs.xs }}>{hiddenCount > 0 ? `show ${hiddenCount} more finished` : 'show fewer'}</Text>
            </Pressable>
          )}
        </ScrollView>
      </RightPanel>
      {peeked && <AgentPeek agent={peeked} now={now} onClose={() => setPeekId(null)} onPeekAgent={setPeekId} />}
    </>
  )
}
