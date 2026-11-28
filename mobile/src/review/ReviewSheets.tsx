// The Review tab's bottom sheets. The desktop puts these inline (Monaco
// view zones, dropdowns, the file tree); a phone has the width for none of
// them, so each becomes a sheet over the diff. Overlays rather than
// <Modal>, so the root KeyboardAvoidingView lifts them over the keyboard.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useKeyboardState } from 'react-native-keyboard-controller'
import { ArrowUp, Bot, Check, ClipboardCopy, MessageSquare, RotateCcw, SquareCode, SquareTerminal, Trash2, User, X } from 'lucide-react-native'
import type { BranchCommit, ChangedFile } from '../../../src/renderer/types'
import type { ReviewAuthor, ReviewComment } from '../../../src/shared/state/reviews'
import type { TerminalTab } from '../../../src/shared/state/terminals'
import { useNess, type NessClient } from '../ness'
import { alpha, c, fs, mono, themed, getThemeMode } from '../theme'
import { haptic } from '../haptics'
import { SelectableText } from '../components/SelectableText'
import { STATUS_COLOR, STATUS_LABEL, STATUS_WORD } from '../panels/ChangedFilesPanel'
import { commentLocation, reviewedCount, type ReviewScope } from './review-model'

export function Sheet({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const insets = useSafeAreaInsets()
  const kbVisible = useKeyboardState((k) => k.isVisible)
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 50 }]}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.4)' }]} onPress={onClose} accessible={false} importantForAccessibility="no" />
      <View style={s.card} accessibilityViewIsModal>
        <View style={s.head}>
          <View style={{ flex: 1, minWidth: 0 }}>{typeof title === 'string' ? <Text style={s.title} numberOfLines={1}>{title}</Text> : title}</View>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={({ pressed }) => [s.iconBtn, { marginRight: -10 }, pressed && { backgroundColor: c.surface }]}>
            <X color={c.dim} size={18} />
          </Pressable>
        </View>
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: footer ? 8 : kbVisible ? 8 : Math.max(16, insets.bottom) }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
        {footer && <View style={{ borderTopWidth: 1, borderColor: c.border, paddingBottom: kbVisible ? 0 : insets.bottom }}>{footer}</View>}
      </View>
    </View>
  )
}

export function authorNameFor(tabLabels: ReadonlyMap<string, string>) {
  return (a: ReviewAuthor): string => (a.kind === 'human' ? 'You' : (tabLabels.get(a.tabId) ?? a.label ?? 'Agent'))
}

function AuthorIcon({ author, reviewers }: { author: ReviewAuthor; reviewers: ReadonlySet<string> }) {
  if (author.kind === 'human') return <User color={c.fgBright} size={12} />
  return reviewers.has(author.tabId) ? <Bot color={c.accent} size={12} /> : <SquareCode color={c.info} size={12} />
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

const STATUS_TEXT: Record<ReviewComment['status'], string> = { open: 'Open', resolved: 'Resolved', outdated: 'Outdated' }

/** A comment and its replies: InlineComment's actions (edit, resolve /
 *  reopen, delete) plus a reply box. The desktop only shows replies (an
 *  agent writes them with reply_to_comment); the phone can add one too,
 *  through the same addReviewReply backend method. */
export function ThreadSheet({
  client,
  worktreePath,
  commentId,
  authorName,
  reviewers,
  onShowInDiff,
  onClose
}: {
  client: NessClient
  worktreePath: string
  commentId: string
  authorName: (a: ReviewAuthor) => string
  reviewers: ReadonlySet<string>
  /** Absent when the diff is already showing it. */
  onShowInDiff?: (comment: ReviewComment) => void
  onClose: () => void
}) {
  const comment = useNess(client, (st) => st.reviews.byPath[worktreePath]?.comments.find((x) => x.id === commentId))
  const [reply, setReply] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Deleted (here or elsewhere) while open.
  useEffect(() => {
    if (!comment) onClose()
  }, [comment, onClose])
  if (!comment) return null

  const statusColor = comment.status === 'open' ? c.info : comment.status === 'resolved' ? c.success : c.faint
  const sendReply = () => {
    const body = reply.trim()
    if (!body || busy) return
    setBusy(true)
    void client.api
      .addReviewReply(worktreePath, comment.id, body)
      .then((ok) => {
        if (ok) {
          haptic.select()
          setReply('')
        }
      })
      .finally(() => setBusy(false))
  }
  const saveEdit = () => {
    const body = editing?.trim()
    if (body && body !== comment.body) void client.api.editReviewComment(worktreePath, comment.id, body)
    setEditing(null)
  }
  const del = () =>
    Alert.alert('Delete comment?', 'It is removed for every client of this workspace.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void client.api.deleteReviewComment(worktreePath, comment.id) }
    ])

  return (
    <Sheet
      onClose={onClose}
      title={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[s.title, { fontFamily: mono, flexShrink: 1 }]} numberOfLines={1} ellipsizeMode="head">
            {commentLocation(comment)}
          </Text>
          <Text style={{ color: statusColor, fontSize: fs.xs }}>{STATUS_TEXT[comment.status]}</Text>
        </View>
      }
      footer={
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8 }}>
          <TextInput
            value={reply}
            onChangeText={setReply}
            placeholder="Reply…"
            placeholderTextColor={c.faint}
            multiline
            keyboardAppearance={getThemeMode()}
            accessibilityLabel="Reply"
            style={s.input}
          />
          <Pressable
            onPress={sendReply}
            disabled={!reply.trim() || busy}
            accessibilityRole="button"
            accessibilityLabel="Send reply"
            style={({ pressed }) => [s.sendBtn, (!reply.trim() || busy) && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}
          >
            <ArrowUp color={c.fgBright} size={18} />
          </Pressable>
        </View>
      }
    >
      <View style={{ padding: 12, gap: 12 }}>
        {!!comment.anchor.snippet && (
          <Text style={s.snippet} numberOfLines={3}>
            {comment.anchor.snippet}
          </Text>
        )}
        <View style={{ gap: 4 }}>
          <View style={s.metaRow}>
            <AuthorIcon author={comment.author} reviewers={reviewers} />
            <Text style={[s.author, comment.author.kind === 'agent' && { color: c.accent }]}>{authorName(comment.author)}</Text>
            <Text style={s.meta}>{formatTime(comment.createdAt)}</Text>
          </View>
          {editing !== null ? (
            <View style={{ gap: 8 }}>
              <TextInput value={editing} onChangeText={setEditing} multiline autoFocus keyboardAppearance={getThemeMode()} accessibilityLabel="Edit comment" style={s.input} />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                <TextButton label="Cancel" onPress={() => setEditing(null)} />
                <TextButton label="Save" primary onPress={saveEdit} disabled={!editing.trim()} />
              </View>
            </View>
          ) : (
            <SelectableText style={[s.body, comment.status === 'outdated' && { textDecorationLine: 'line-through' }]}>{comment.body}</SelectableText>
          )}
        </View>
        {comment.replies?.map((r) => (
          <View key={r.id} style={{ gap: 4, paddingLeft: 12, borderLeftWidth: 2, borderColor: c.border }}>
            <View style={s.metaRow}>
              <AuthorIcon author={r.author} reviewers={reviewers} />
              <Text style={[s.author, r.author.kind === 'agent' && { color: c.accent }]}>{authorName(r.author)}</Text>
              <Text style={s.meta}>{formatTime(r.createdAt)}</Text>
            </View>
            <SelectableText style={s.body}>{r.body}</SelectableText>
          </View>
        ))}
        {comment.status === 'resolved' && comment.resolvedBy && (
          <Text style={s.meta}>
            Resolved by {authorName(comment.resolvedBy)}
            {comment.resolvedAt ? ` · ${formatTime(comment.resolvedAt)}` : ''}
          </Text>
        )}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {comment.status === 'resolved' ? (
            <ActionButton label="Reopen" onPress={() => void client.api.setReviewCommentStatus(worktreePath, comment.id, 'open')}>
              <RotateCcw color={c.fg} size={14} />
            </ActionButton>
          ) : (
            <ActionButton
              label="Resolve"
              onPress={() => {
                haptic.select()
                void client.api.setReviewCommentStatus(worktreePath, comment.id, 'resolved')
              }}
            >
              <Check color={c.success} size={14} />
            </ActionButton>
          )}
          {editing === null && <ActionButton label="Edit" onPress={() => setEditing(comment.body)} />}
          {onShowInDiff && <ActionButton label="Show in diff" onPress={() => onShowInDiff(comment)} />}
          <ActionButton label="Delete" onPress={del}>
            <Trash2 color={c.danger} size={14} />
          </ActionButton>
        </View>
      </View>
    </Sheet>
  )
}

/** InlineCommentInput: a new comment on one line of the new side. */
export function ComposeSheet({
  line,
  snippet,
  onSubmit,
  onClose
}: {
  line: number
  snippet: string
  /** Resolves to an error message, or null on success. */
  onSubmit: (body: string) => Promise<string | null>
  onClose: () => void
}) {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    const text = body.trim()
    if (!text || submitting) return
    setSubmitting(true)
    setError(null)
    onSubmit(text)
      .then((err) => {
        if (err) setError(err)
        else {
          haptic.select()
          onClose()
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSubmitting(false))
  }
  return (
    <Sheet title={`Comment on line ${line}`} onClose={onClose}>
      <View style={{ padding: 12, gap: 10 }}>
        {!!snippet.trim() && (
          <Text style={s.snippet} numberOfLines={3}>
            {snippet.trim()}
          </Text>
        )}
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder="Leave a comment..."
          placeholderTextColor={c.faint}
          multiline
          autoFocus
          keyboardAppearance={getThemeMode()}
          accessibilityLabel={`Comment on line ${line}`}
          style={[s.input, { minHeight: 88 }]}
        />
        {error && <Text style={{ color: c.danger, fontSize: fs.xs }}>{error}</Text>}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          <TextButton label="Cancel" onPress={onClose} />
          <TextButton label={submitting ? 'Commenting…' : 'Comment'} primary onPress={submit} disabled={!body.trim() || submitting} />
        </View>
      </View>
    </Sheet>
  )
}

/** ReviewFileTree as a flat list: reviewed checkbox, status, path, +/−
 *  and open comments. */
export function FilesSheet({
  files,
  selected,
  reviewed,
  counts,
  onSelect,
  onToggleReviewed,
  onClose
}: {
  files: readonly ChangedFile[]
  selected: string | null
  reviewed: ReadonlySet<string>
  counts: ReadonlyMap<string, { open: number; total: number }>
  onSelect: (path: string) => void
  onToggleReviewed: (path: string) => void
  onClose: () => void
}) {
  return (
    <Sheet title={`${files.length} ${files.length === 1 ? 'file' : 'files'} · ${reviewedCount(files, reviewed)} reviewed`} onClose={onClose}>
      {files.map((f) => {
        const slash = f.path.lastIndexOf('/')
        const n = counts.get(f.path)
        const isReviewed = reviewed.has(f.path)
        return (
          <View key={f.path} style={[s.row, f.path === selected && { backgroundColor: c.panel }]}>
            <ReviewedBox checked={isReviewed} onPress={() => onToggleReviewed(f.path)} name={f.path} />
            <Pressable
              onPress={() => onSelect(f.path)}
              style={({ pressed }) => [{ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 12 }, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel={`${f.path}, ${STATUS_WORD[f.status]}${n?.open ? `, ${n.open} open ${n.open === 1 ? 'comment' : 'comments'}` : ''}`}
              accessibilityState={{ selected: f.path === selected }}
            >
              <Text style={{ color: STATUS_COLOR[f.status], fontFamily: mono, fontSize: fs.xs, width: 12 }}>{STATUS_LABEL[f.status]}</Text>
              <Text style={{ flex: 1, minWidth: 0, fontFamily: mono, fontSize: fs.xs }} numberOfLines={1} ellipsizeMode="head">
                {slash >= 0 && <Text style={{ color: c.faint }}>{f.path.slice(0, slash + 1)}</Text>}
                <Text style={{ color: isReviewed ? c.dim : c.fgBright }}>{f.path.slice(slash + 1)}</Text>
              </Text>
              {!!n?.open && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <MessageSquare color={c.info} size={12} />
                  <Text style={{ color: c.info, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>{n.open}</Text>
                </View>
              )}
              <Text style={{ fontFamily: mono, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>
                {!!f.additions && <Text style={{ color: c.success }}>+{f.additions} </Text>}
                {!!f.deletions && <Text style={{ color: c.danger }}>−{f.deletions}</Text>}
              </Text>
            </Pressable>
          </View>
        )
      })}
      {files.length === 0 && <Text style={[s.meta, { padding: 16 }]}>No changes in this selection</Text>}
    </Sheet>
  )
}

export function ReviewedBox({ checked, onPress, name }: { checked: boolean; onPress: () => void; name: string }) {
  return (
    <Pressable
      onPress={() => {
        haptic.select()
        onPress()
      }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={`Reviewed ${name}`}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={[s.box, checked && { backgroundColor: alpha(c.success, 0.2), borderColor: c.success }]}>{checked && <Check color={c.success} size={12} strokeWidth={3} />}</View>
    </Pressable>
  )
}

/** CommitSelector: whole branch or one commit. A range (shift-click on
 *  desktop) shows as selected when another client picked it, but the phone
 *  only picks single commits. */
export function CommitsSheet({
  commits,
  scope,
  onSelect,
  onClose
}: {
  commits: readonly BranchCommit[]
  scope: ReviewScope
  onSelect: (hash: string | null) => void
  onClose: () => void
}) {
  const range = useMemo(() => {
    if (scope.kind === 'branch') return null
    const a = commits.findIndex((x) => x.hash === (scope.kind === 'commit' ? scope.hash : scope.from))
    const b = commits.findIndex((x) => x.hash === (scope.kind === 'commit' ? scope.hash : scope.to))
    return a === -1 || b === -1 ? null : [Math.min(a, b), Math.max(a, b)]
  }, [commits, scope])
  return (
    <Sheet title="Commits" onClose={onClose}>
      <OptionRow label="All commits" selected={scope.kind === 'branch'} onPress={() => onSelect(null)} />
      {commits.length === 0 && <Text style={[s.meta, { padding: 12 }]}>No commits ahead of base</Text>}
      {commits.map((cm, i) => {
        const selected = !!range && i >= range[0] && i <= range[1]
        return (
          <Pressable
            key={cm.hash}
            onPress={() => onSelect(cm.hash)}
            style={({ pressed }) => [s.row, { paddingHorizontal: 12, gap: 8 }, selected && { backgroundColor: c.panel }, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`${cm.subject}, ${cm.shortHash}, ${cm.relativeDate}${cm.pushed ? '' : ', not pushed'}`}
          >
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: cm.pushed ? c.borderStrong : c.warning }} />
            <Text style={{ fontFamily: mono, fontSize: fs.xs, color: cm.pushed ? c.faint : c.warning }}>{cm.shortHash}</Text>
            <Text style={{ flex: 1, minWidth: 0, fontSize: fs.sm, color: selected ? c.fgBright : cm.pushed ? c.dim : c.fg }} numberOfLines={1}>
              {cm.subject}
            </Text>
            <Text style={s.meta}>{cm.relativeDate}</Text>
          </Pressable>
        )
      })}
    </Sheet>
  )
}

interface Target {
  id: string
  label: string
  kind: 'chat' | 'terminal'
  asleep: boolean
}

/** AgentTabPicker for "Send to Agent": the worktree's Chat tabs (most
 *  recent first, from listReviewTargets) then its terminal agent tabs,
 *  which get a paste. Copy is here too — the desktop's Copy button. */
export function SendSheet({
  client,
  worktreePath,
  tabs,
  excludeTabId,
  includeTerminals,
  title,
  onPick,
  onCopy,
  onClose
}: {
  client: NessClient
  worktreePath: string
  tabs: readonly TerminalTab[]
  excludeTabId?: string
  includeTerminals?: boolean
  title: string
  onPick: (target: Target) => void
  onCopy?: () => void
  onClose: () => void
}) {
  const [chats, setChats] = useState<Target[] | null>(null)
  useEffect(() => {
    let cancelled = false
    client.api.listReviewTargets(worktreePath).then(
      (list) => !cancelled && setChats(list.map((t) => ({ id: t.id, label: t.label, kind: 'chat' as const, asleep: t.asleep }))),
      () => !cancelled && setChats([])
    )
    return () => {
      cancelled = true
    }
  }, [client, worktreePath])
  const terminals = useMemo<Target[]>(
    () => (includeTerminals ? tabs.filter((t) => t.type === 'agent').map((t) => ({ id: t.id, label: t.customLabel?.trim() || t.label, kind: 'terminal' as const, asleep: false })) : []),
    [includeTerminals, tabs]
  )
  const list = chats === null ? null : [...chats, ...terminals].filter((t) => t.id !== excludeTabId)
  return (
    <Sheet title={title} onClose={onClose}>
      {list === null && <Text style={[s.meta, { padding: 12 }]}>Loading…</Text>}
      {list?.length === 0 && (
        <Text style={[s.meta, { padding: 12 }]}>{includeTerminals ? 'No agent tabs in this worktree' : 'No Chat tabs in this worktree'}</Text>
      )}
      {list?.map((t, i) => (
        <Pressable
          key={t.id}
          onPress={() => onPick(t)}
          style={({ pressed }) => [s.row, { paddingHorizontal: 12, gap: 10 }, pressed && { backgroundColor: c.panel }]}
          accessibilityRole="button"
          accessibilityLabel={`Send to ${t.label}${t.kind === 'terminal' ? ', pastes into the terminal' : ''}`}
        >
          {t.kind === 'chat' ? <MessageSquare color={c.faint} size={14} /> : <SquareTerminal color={c.faint} size={14} />}
          <Text style={{ flex: 1, fontSize: fs.sm, color: i === 0 ? c.fgBright : c.fg }} numberOfLines={1}>
            {t.label}
          </Text>
          <Text style={s.meta}>{t.kind === 'terminal' ? 'paste' : i === 0 ? 'most recent' : t.asleep ? 'asleep' : ''}</Text>
        </Pressable>
      ))}
      {onCopy && (
        <Pressable
          onPress={onCopy}
          style={({ pressed }) => [s.row, { paddingHorizontal: 12, gap: 10, borderTopWidth: 1, borderColor: c.border }, pressed && { backgroundColor: c.panel }]}
          accessibilityRole="button"
        >
          <ClipboardCopy color={c.faint} size={14} />
          <Text style={{ flex: 1, fontSize: fs.sm, color: c.fg }}>Copy to clipboard</Text>
        </Pressable>
      )}
    </Sheet>
  )
}

function OptionRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.row, { paddingHorizontal: 12 }, selected && { backgroundColor: c.panel }, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={{ flex: 1, fontSize: fs.sm, color: selected ? c.fgBright : c.fg }}>{label}</Text>
      {selected && <Check color={c.accent} size={14} />}
    </Pressable>
  )
}

export function ActionButton({ label, onPress, children, disabled }: { label: string; onPress: () => void; children?: ReactNode; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [s.action, pressed && { backgroundColor: c.surface }, disabled && { opacity: 0.4 }]}
    >
      {children}
      <Text style={{ color: c.fg, fontSize: fs.xs }}>{label}</Text>
    </Pressable>
  )
}

export function TextButton({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [s.textBtn, primary && { backgroundColor: c.accent, borderColor: c.accent }, disabled && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}
    >
      <Text style={{ color: c.fgBright, fontSize: fs.sm, fontWeight: primary ? '600' : '400' }}>{label}</Text>
    </Pressable>
  )
}

const s = themed(() =>
  StyleSheet.create({
    card: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '85%',
      backgroundColor: c.panelRaised,
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      borderTopWidth: 1,
      borderColor: c.borderStrong
    },
    head: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 12, borderBottomWidth: 1, borderColor: c.border },
    title: { color: c.fgBright, fontSize: fs.sm, fontWeight: '600' },
    iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
    row: { minHeight: 44, flexDirection: 'row', alignItems: 'center' },
    snippet: { fontFamily: mono, fontSize: fs.xs, color: c.dim, backgroundColor: c.app, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 6 },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    author: { color: c.fgBright, fontSize: fs.xs, fontWeight: '600' },
    meta: { color: c.faint, fontSize: fs.xs },
    body: { color: c.fg, fontSize: fs.sm, lineHeight: 20 },
    input: {
      flex: 1,
      minHeight: 44,
      maxHeight: 160,
      color: c.fg,
      fontSize: fs.sm,
      backgroundColor: c.surface,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 10,
      paddingTop: 11,
      paddingBottom: 11
    },
    sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent },
    box: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: c.borderStrong, alignItems: 'center', justifyContent: 'center' },
    action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, borderColor: c.border },
    textBtn: { minHeight: 44, minWidth: 64, paddingHorizontal: 14, borderRadius: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border }
  })
)

