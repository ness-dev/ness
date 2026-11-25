// Port of the web client's json-mode chat (JsonModeChat.tsx) at the level
// a phone needs: user bubbles, finished turns folded into "Worked for …",
// the live turn shown in full, approval cards, and the composer with its
// state dot + permission-mode pill.
import { useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ChevronRight, RotateCcw, Square } from 'lucide-react-native'
import type {
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock,
  JsonClaudePendingApproval,
  JsonClaudeSession
} from '../../../src/shared/state/json-claude'
import { NessClient, useNess } from '../ness'
import { alpha, c, fs, mono } from '../theme'
import { Markdown } from './Markdown'

type Item =
  | { kind: 'user'; key: string; entry: JsonClaudeChatEntry }
  | { kind: 'fold'; key: string; label: string; work: JsonClaudeChatEntry[]; hasError: boolean }
  | { kind: 'assistant'; key: string; entry: JsonClaudeChatEntry; blocks: JsonClaudeMessageBlock[] }
  | { kind: 'error'; key: string; entry: JsonClaudeChatEntry }
  | { kind: 'approval'; key: string; approval: JsonClaudePendingApproval }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function ChatView({
  client,
  sessionId,
  worktreePath
}: {
  client: NessClient
  sessionId: string
  worktreePath: string
}) {
  const session = useNess(client, (s) => s.jsonClaude.sessions[sessionId])
  const approvals = useNess(client, (s) => s.jsonClaude.pendingApprovals)

  // Wire snapshots strip entries; fetch once per session.
  const fetched = useRef(new Set<string>())
  useEffect(() => {
    if (!session || session.entriesHydrated || fetched.current.has(sessionId)) return
    fetched.current.add(sessionId)
    void client.fetchEntries(sessionId)
  }, [client, sessionId, session])

  const mine = useMemo(
    () => Object.values(approvals).filter((a) => a.sessionId === sessionId),
    [approvals, sessionId]
  )
  const items = useMemo(() => buildItems(session, mine), [session, mine])

  return (
    <View style={{ flex: 1 }}>
      {!session ? (
        <View style={s.empty}>
          <Text style={s.muted}>This chat is asleep.</Text>
          <SmallButton label="Wake session" onPress={() => void client.startSession(sessionId, worktreePath)} />
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, gap: 14 }}
          data={[...items].reverse()}
          inverted
          keyExtractor={(i) => i.key}
          renderItem={({ item }) => <Row item={item} client={client} sessionId={sessionId} worktreePath={worktreePath} />}
          ListHeaderComponent={session.busy ? <Working since={session.turnStartedAt} /> : undefined}
        />
      )}
      <Composer client={client} session={session} sessionId={sessionId} />
    </View>
  )
}

// ── Turn folding ────────────────────────────────────────────────────────
// Simplified foldFinishedTurns (json-mode-cards/turn-collapse.ts): a turn
// is everything after a user message. Finished turns collapse their work
// into one line above the final answer; the live turn stays expanded.

function buildItems(session: JsonClaudeSession | undefined, approvals: JsonClaudePendingApproval[]): Item[] {
  if (!session) return []
  const entries = session.entries.filter((e) => !e.parentToolUseId && !e.isPartial)
  const out: Item[] = []
  let turn: JsonClaudeChatEntry[] = []
  let turnStart: JsonClaudeChatEntry | null = null

  const flush = (live: boolean) => {
    if (turn.length === 0) return
    const assistants = turn.filter((e) => e.kind === 'assistant')
    const last = assistants[assistants.length - 1]
    const finalText = last?.blocks?.filter((b) => b.type === 'text' && b.text?.trim()) ?? []
    const toolUses = turn.flatMap((e) => (e.blocks ?? []).filter((b) => b.type === 'tool_use'))
    if (!live && toolUses.length > 0 && finalText.length > 0) {
      const work = turn.filter((e) => e !== last)
      const edited = new Set(
        toolUses.filter((b) => EDIT_TOOLS.has(b.name ?? '')).map((b) => String(b.input?.file_path ?? ''))
      )
      const end = turn[turn.length - 1].timestamp
      const parts = [
        turnStart ? `Worked for ${formatTurnDuration(end - turnStart.timestamp)}` : 'Worked',
        `${toolUses.length} tool${toolUses.length === 1 ? '' : 's'}`
      ]
      if (edited.size > 0) parts.push(`${edited.size} file${edited.size === 1 ? '' : 's'} edited`)
      out.push({
        kind: 'fold',
        key: `fold-${turn[0].entryId}`,
        label: parts.join(' · '),
        work,
        hasError: turn.some((e) => e.kind === 'error' || e.blocks?.some((b) => b.isError))
      })
      out.push({ kind: 'assistant', key: last.entryId, entry: last, blocks: finalText })
    } else {
      for (const e of turn) pushEntry(out, e)
    }
    turn = []
  }

  for (const e of entries) {
    if (e.kind === 'user') {
      flush(false)
      turnStart = e
      out.push({ kind: 'user', key: e.entryId, entry: e })
    } else {
      turn.push(e)
    }
  }
  flush(session.busy)
  for (const a of approvals) out.push({ kind: 'approval', key: a.requestId, approval: a })
  return out
}

function pushEntry(out: Item[], e: JsonClaudeChatEntry): void {
  if (e.kind === 'error') out.push({ kind: 'error', key: e.entryId, entry: e })
  else if (e.kind === 'assistant') out.push({ kind: 'assistant', key: e.entryId, entry: e, blocks: e.blocks ?? [] })
}

// Copy of turn-collapse.ts's formatTurnDuration — that file lives under
// src/renderer, which Metro doesn't watch.
function formatTurnDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rem = s % 60
    return rem === 0 ? `${m}m` : `${m}m ${rem}s`
  }
  const h = Math.floor(m / 60)
  const remM = m % 60
  return remM === 0 ? `${h}h` : `${h}h ${remM}m`
}

// ── Rows ────────────────────────────────────────────────────────────────

function Row({
  item,
  client,
  sessionId,
  worktreePath
}: {
  item: Item
  client: NessClient
  sessionId: string
  worktreePath: string
}) {
  switch (item.kind) {
    case 'user':
      return (
        <View style={s.userBubble}>
          <Text style={s.body}>{item.entry.text}</Text>
        </View>
      )
    case 'fold':
      return <Fold label={item.label} work={item.work} hasError={item.hasError} />
    case 'assistant':
      return <AssistantBlocks blocks={item.blocks} />
    case 'error':
      return <ErrorCard entry={item.entry} onRestart={() => void client.startSession(sessionId, worktreePath)} />
    case 'approval':
      return <ApprovalCard approval={item.approval} client={client} />
  }
}

function AssistantBlocks({ blocks }: { blocks: JsonClaudeMessageBlock[] }) {
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((b, i) => {
        if (b.type === 'text' && b.text?.trim()) return <Markdown key={i} text={b.text} />
        if (b.type === 'tool_use') return <ToolLine key={i} block={b} />
        return null
      })}
    </View>
  )
}

function ToolLine({ block }: { block: JsonClaudeMessageBlock }) {
  return (
    <View style={s.toolLine}>
      <Text style={s.toolName}>{block.name}</Text>
      <Text style={s.toolArg} numberOfLines={1}>
        {summarizeInput(block.input)}
      </Text>
    </View>
  )
}

function Fold({ label, work, hasError }: { label: string; work: JsonClaudeChatEntry[]; hasError: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} style={s.foldRow} hitSlop={6}>
        <ChevronRight color={c.muted} size={14} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
        <Text style={s.foldLabel}>{label}</Text>
        {hasError && <Text style={s.foldError}>ERROR</Text>}
      </Pressable>
      {open && (
        <View style={s.foldBody}>
          {work.map((e) =>
            e.kind === 'assistant' ? <AssistantBlocks key={e.entryId} blocks={e.blocks ?? []} /> : null
          )}
        </View>
      )}
    </View>
  )
}

function ErrorCard({ entry, onRestart }: { entry: JsonClaudeChatEntry; onRestart: () => void }) {
  const ended = entry.errorKind === 'subprocess-exit'
  return (
    <View style={s.dangerCard}>
      <View style={s.dangerHead}>
        <RotateCcw color={c.danger} size={14} />
        <Text style={[s.monoLabel, { color: c.danger, fontWeight: '700' }]}>{ended ? 'Session ended' : 'Error'}</Text>
        <Text style={s.muted}>{entry.errorMessage}</Text>
      </View>
      {ended && (
        <View style={{ padding: 12, paddingTop: 0 }}>
          <Pressable onPress={onRestart} style={s.restartBtn}>
            <RotateCcw color={c.danger} size={12} />
            <Text style={{ color: c.danger, fontSize: fs.xs }}>Restart session</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

function ApprovalCard({ approval, client }: { approval: JsonClaudePendingApproval; client: NessClient }) {
  const [busy, setBusy] = useState(false)
  const act = (allow: boolean) => {
    setBusy(true)
    client.resolveApproval(approval.requestId, allow, approval.input).finally(() => setBusy(false))
  }
  return (
    <View style={s.approvalCard}>
      <View style={s.approvalHead}>
        <Text style={s.approvalTitle}>NEEDS APPROVAL</Text>
        <Text style={[s.monoLabel, { color: c.fgBright, flex: 1 }]} numberOfLines={1}>
          {approval.toolName}
        </Text>
      </View>
      {approval.autoReview?.state === 'pending' && (
        <Text style={[s.muted, s.approvalStrip]}>Asking auto-approver…</Text>
      )}
      {approval.autoReview?.state === 'finished' && approval.autoReview.decision === 'ask' && (
        <Text style={[s.muted, s.approvalStrip]}>
          <Text style={{ fontWeight: '600' }}>Auto-approver: </Text>
          {approval.autoReview.reason || 'deferred'}
        </Text>
      )}
      <View style={{ padding: 12, gap: 10 }}>
        <View style={s.cmdBox}>
          <Text style={s.cmdText}>{summarizeInput(approval.input, 600)}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <SmallButton label="Allow" onPress={() => act(true)} disabled={busy} primary />
          <SmallButton label="Deny" onPress={() => act(false)} disabled={busy} />
        </View>
      </View>
    </View>
  )
}

function Working({ since }: { since?: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const secs = since ? Math.max(0, Math.round((Date.now() - since) / 1000)) : null
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={[s.dot, { backgroundColor: c.accent }]} />
      <Text style={s.muted}>Working{secs !== null ? ` · ${formatTurnDuration(secs * 1000)}` : '…'}</Text>
    </View>
  )
}

// ── Composer ────────────────────────────────────────────────────────────

const MODE_STYLE: Record<string, { label: string; color: string }> = {
  acceptEdits: { label: 'accept edits', color: c.success },
  plan: { label: 'plan', color: c.accent },
  auto: { label: 'auto', color: c.warning },
  default: { label: 'ask every time', color: c.muted }
}

function Composer({
  client,
  session,
  sessionId
}: {
  client: NessClient
  session: JsonClaudeSession | undefined
  sessionId: string
}) {
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const state = session?.state ?? 'asleep'
  const stateDot =
    state === 'running' ? c.success : state === 'connecting' ? c.warning : state === 'exited' ? c.danger : c.faint
  const mode = MODE_STYLE[session?.permissionMode ?? 'default'] ?? MODE_STYLE.default
  const canSend = !!session && state !== 'exited' && draft.trim().length > 0

  const send = () => {
    if (!canSend) return
    client.sendMessage(sessionId, draft.trim())
    setDraft('')
  }

  return (
    <View style={s.composerWrap}>
      <View style={[s.composer, focused && { borderColor: c.accent }]}>
        <TextInput
          style={s.composerInput}
          multiline
          placeholder="Message Claude"
          placeholderTextColor={c.dim}
          value={draft}
          onChangeText={setDraft}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <View style={s.composerBar}>
          <View style={[s.dot, { backgroundColor: stateDot }]} />
          <Text style={s.muted}>{state}</Text>
          <View style={[s.pill, { backgroundColor: alpha(mode.color === c.muted ? c.surface : mode.color, mode.color === c.muted ? 1 : 0.15), borderColor: mode.color === c.muted ? c.border : alpha(mode.color, 0.3) }]}>
            <Text style={{ color: mode.color, fontSize: fs.xs }}>{mode.label}</Text>
          </View>
          <View style={{ flex: 1 }} />
          {session?.busy ? (
            <Pressable onPress={() => void client.interrupt(sessionId)} style={[s.sendBtn, { backgroundColor: c.surface }]}>
              <Square color={c.fg} size={10} fill={c.fg} />
              <Text style={[s.sendText, { color: c.fg }]}>Stop</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={send} disabled={!canSend} style={[s.sendBtn, !canSend && { opacity: 0.4 }]}>
            <Text style={s.sendText}>Send</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

function SmallButton(props: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={[
        s.smallBtn,
        props.primary ? { backgroundColor: c.accent, borderColor: c.accent } : null,
        props.disabled && { opacity: 0.4 }
      ]}
    >
      <Text style={{ color: props.primary ? '#fff' : c.fg, fontSize: fs.xs, fontWeight: '500' }}>{props.label}</Text>
    </Pressable>
  )
}

function summarizeInput(input: Record<string, unknown> | undefined, max = 160): string {
  if (!input) return ''
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description
  return (typeof v === 'string' ? v : JSON.stringify(input)).slice(0, max)
}

const s = StyleSheet.create({
  body: { color: c.fg, fontSize: fs.sm, lineHeight: 21 },
  muted: { color: c.muted, fontSize: fs.xs },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '80%',
    backgroundColor: alpha(c.accent, 0.1),
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  foldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  foldLabel: { color: c.muted, fontSize: fs.xs },
  foldError: { color: alpha(c.danger, 0.8), fontSize: 10, letterSpacing: 0.5 },
  foldBody: { marginTop: 10, marginLeft: 6, paddingLeft: 12, borderLeftWidth: 1, borderColor: c.border, gap: 10 },
  toolLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toolName: { color: c.fgBright, fontSize: fs.xs, fontWeight: '600' },
  toolArg: { color: c.muted, fontSize: fs.xs, fontFamily: mono, flex: 1 },
  monoLabel: { fontFamily: mono, fontSize: fs.xs },
  dangerCard: { borderWidth: 1, borderColor: alpha(c.danger, 0.4), backgroundColor: alpha(c.danger, 0.05), borderRadius: 6 },
  dangerHead: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  restartBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: alpha(c.danger, 0.4),
    backgroundColor: alpha(c.danger, 0.1),
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  approvalCard: { borderWidth: 1, borderColor: alpha(c.danger, 0.4), backgroundColor: alpha(c.danger, 0.05), borderRadius: 6, overflow: 'hidden' },
  approvalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: alpha(c.danger, 0.1),
    borderBottomWidth: 1,
    borderColor: alpha(c.danger, 0.3)
  },
  approvalTitle: { color: c.danger, fontSize: fs.xs, fontWeight: '600', letterSpacing: 0.6 },
  approvalStrip: { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: alpha(c.danger, 0.2) },
  cmdBox: { backgroundColor: c.app, borderRadius: 4, borderWidth: 1, borderColor: c.border, padding: 8 },
  cmdText: { fontFamily: mono, fontSize: fs.xs, color: c.fgBright },
  smallBtn: { borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 6 },
  composerWrap: { borderTopWidth: 1, borderColor: c.border, padding: 12, backgroundColor: c.app },
  composer: { borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, borderRadius: 6 },
  composerInput: { color: c.fg, fontSize: fs.sm, minHeight: 44, maxHeight: 140, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  composerBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingBottom: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  pill: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  sendBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.accent, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 3 },
  sendText: { color: '#fff', fontSize: fs.xs, fontWeight: '500' }
})
