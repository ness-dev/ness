// The Review tab's "Reviews" view on the phone: what the reviewer agent is
// doing, each submitted review (ReviewSubmissions.tsx's SubmissionCard:
// verdict, briefing, summary, send / re-target / edit / delete), and every
// comment thread. The desktop's round-by-round timeline (ReviewTimeline)
// is condensed to these two lists.
import { memo, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { BookOpen, Bot, ChevronRight, Loader2, Pencil, Send } from 'lucide-react-native'
import { REVIEW_VERDICT_LABELS } from '../../../src/shared/review-format'
import type { ReviewAuthor, ReviewComment, ReviewSubmission, ReviewVerdict } from '../../../src/shared/state/reviews'
import type { PtyStatus } from '../../../src/shared/state/terminals'
import type { NessClient } from '../ness'
import { alpha, c, fs, mono, themed, getThemeMode } from '../theme'
import { Spin } from '../components/Spin'
import { Markdown } from '../components/Markdown'
import { ActionButton, TextButton } from './ReviewSheets'
import { toneColor } from './ReviewStatusIcon'
import { commentLocation, reviewerActivity, sortThreads, submissionStatus } from './review-model'

const VERDICTS: ReviewVerdict[] = ['approve', 'changes-requested', 'comment']
const verdictTone = (v: ReviewVerdict) => (v === 'approve' ? c.success : v === 'changes-requested' ? c.warning : c.info)

export function VerdictPill({ verdict }: { verdict: ReviewVerdict }) {
  const color = verdictTone(verdict)
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, backgroundColor: alpha(color, 0.15) }}>
      <Text style={{ color, fontSize: fs.xs, fontWeight: '600' }}>{REVIEW_VERDICT_LABELS[verdict]}</Text>
    </View>
  )
}

export const ReviewsView = memo(function ReviewsView({
  client,
  worktreePath,
  submissions,
  comments,
  reviewing,
  authorName,
  labelOf,
  onOpenTab,
  onOpenThread,
  onSendTo
}: {
  client: NessClient
  worktreePath: string
  submissions: readonly ReviewSubmission[]
  comments: readonly ReviewComment[]
  /** Set while a requested review is in progress. */
  reviewing: { tabId: string | null; status: PtyStatus | undefined } | null
  authorName: (a: ReviewAuthor) => string
  /** A tab's label, null when it isn't open. */
  labelOf: (tabId: string) => string | null
  onOpenTab: (tabId: string) => void
  onOpenThread: (id: string) => void
  /** "To…": pick another target for a submission. */
  onSendTo: (submission: ReviewSubmission) => void
}) {
  const ordered = [...submissions].reverse()
  const threads = sortThreads(comments)
  const open = comments.filter((x) => x.status === 'open').length
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: 48 }}>
      {reviewing && <ReviewerCard reviewing={reviewing} labelOf={labelOf} onOpenTab={onOpenTab} />}
      {ordered.map((sub, i) => (
        <SubmissionCard
          key={sub.id}
          client={client}
          worktreePath={worktreePath}
          submission={sub}
          latest={i === 0}
          authorName={authorName}
          labelOf={labelOf}
          onOpenTab={onOpenTab}
          onSendTo={() => onSendTo(sub)}
        />
      ))}
      {threads.length > 0 && (
        <View style={st.section}>
          <Text style={st.sectionTitle}>
            Comments · {open} open of {threads.length}
          </Text>
          {threads.map((t) => (
            <Pressable
              key={t.id}
              onPress={() => onOpenThread(t.id)}
              style={({ pressed }) => [st.thread, pressed && { backgroundColor: c.panelRaised }]}
              accessibilityRole="button"
              accessibilityLabel={`${commentLocation(t)}, ${t.status}, ${authorName(t.author)}: ${t.body}`}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={[st.dot, { backgroundColor: t.status === 'open' ? c.info : t.status === 'resolved' ? c.success : c.faint }]} />
                <Text style={{ flex: 1, minWidth: 0, fontFamily: mono, fontSize: fs.xs, color: c.dim }} numberOfLines={1} ellipsizeMode="head">
                  {commentLocation(t)}
                </Text>
                {!!t.replies?.length && (
                  <Text style={{ color: c.faint, fontSize: fs.xs }}>
                    {t.replies.length} {t.replies.length === 1 ? 'reply' : 'replies'}
                  </Text>
                )}
                <ChevronRight color={c.faint} size={12} />
              </View>
              <Text style={{ fontSize: fs.sm, color: t.status === 'open' ? c.fg : c.dim, textDecorationLine: t.status === 'outdated' ? 'line-through' : 'none' }} numberOfLines={3}>
                <Text style={{ color: t.author.kind === 'agent' ? c.accent : c.fgBright, fontWeight: '600' }}>{authorName(t.author)} </Text>
                {t.body}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {!reviewing && submissions.length === 0 && comments.length === 0 && (
        <Text style={{ color: c.dim, fontSize: fs.sm, textAlign: 'center', paddingVertical: 32, paddingHorizontal: 16 }}>
          No reviews yet. Request an AI review from the Pull Request panel, or tap a line in the diff to leave a comment.
        </Text>
      )}
    </ScrollView>
  )
})

function ReviewerCard({
  reviewing,
  labelOf,
  onOpenTab
}: {
  reviewing: { tabId: string | null; status: PtyStatus | undefined }
  labelOf: (tabId: string) => string | null
  onOpenTab: (tabId: string) => void
}) {
  const a = reviewerActivity(reviewing.status)
  const name = reviewing.tabId ? labelOf(reviewing.tabId) : null
  const color = toneColor(a.tone)
  return (
    <View style={[st.section, { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 }]}>
      {a.busy ? (
        <Spin>
          <Loader2 color={color} size={16} />
        </Spin>
      ) : (
        <Bot color={color} size={16} />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color, fontSize: fs.sm, fontWeight: '500' }}>{a.text}</Text>
        {name && <Text style={{ color: c.faint, fontSize: fs.xs }}>{name}</Text>}
      </View>
      {reviewing.tabId && name && <ActionButton label="Open chat" onPress={() => onOpenTab(reviewing.tabId!)} />}
    </View>
  )
}

function SubmissionCard({
  client,
  worktreePath,
  submission,
  latest,
  authorName,
  labelOf,
  onOpenTab,
  onSendTo
}: {
  client: NessClient
  worktreePath: string
  submission: ReviewSubmission
  latest: boolean
  authorName: (a: ReviewAuthor) => string
  labelOf: (tabId: string) => string | null
  onOpenTab: (tabId: string) => void
  onSendTo: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [summary, setSummary] = useState(submission.summary)
  const [verdict, setVerdict] = useState<ReviewVerdict>(submission.verdict)
  const [sending, setSending] = useState(false)
  const [briefingOpen, setBriefingOpen] = useState(latest)
  const [authorSummaryOpen, setAuthorSummaryOpen] = useState(false)
  const reviewerTabId = submission.author.kind === 'agent' ? submission.author.tabId : null
  const reviewerOpen = !!reviewerTabId && labelOf(reviewerTabId) !== null
  const status = submissionStatus(submission, labelOf)
  const count = submission.commentIds.length

  const send = () => {
    setSending(true)
    void client.api.sendReviewSubmission(worktreePath, submission.id).finally(() => setSending(false))
  }
  const save = () => {
    void client.api.editReviewSubmission(worktreePath, submission.id, summary, verdict)
    setEditing(false)
  }
  const remove = () => {
    const sent = submission.state === 'sent'
    Alert.alert(sent ? 'Dismiss this review?' : 'Delete this review?', sent ? 'Its comments stay.' : 'It was never sent. Its comments stay.', [
      { text: 'Cancel', style: 'cancel' },
      { text: sent ? 'Dismiss' : 'Delete', style: 'destructive', onPress: () => void client.api.deleteReviewSubmission(worktreePath, submission.id) }
    ])
  }

  return (
    <View style={[st.section, { padding: 12, gap: 10 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <VerdictPill verdict={submission.verdict} />
        <Pressable
          onPress={reviewerOpen ? () => onOpenTab(reviewerTabId!) : undefined}
          disabled={!reviewerOpen}
          accessibilityRole={reviewerOpen ? 'button' : 'text'}
          accessibilityLabel={reviewerOpen ? `Open ${authorName(submission.author)}'s chat` : undefined}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 }}
        >
          {submission.author.kind === 'agent' && <Bot color={c.accent} size={12} />}
          <Text style={{ color: c.accent, fontSize: fs.xs, textDecorationLine: reviewerOpen ? 'underline' : 'none' }}>{authorName(submission.author)}</Text>
        </Pressable>
        <Text style={{ color: c.faint, fontSize: fs.xs }}>
          {count} {count === 1 ? 'comment' : 'comments'}
        </Text>
      </View>
      <Text style={{ color: toneColor(status.tone), fontSize: fs.xs }}>{status.text}</Text>
      {submission.state === 'failed' && submission.error && <Text style={{ color: c.danger, fontSize: fs.xs }}>{submission.error}</Text>}

      {submission.briefing && (
        <View style={st.briefing}>
          <Pressable
            onPress={() => setBriefingOpen((v) => !v)}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}
            accessibilityRole="button"
            accessibilityState={{ expanded: briefingOpen }}
          >
            <BookOpen color={c.accent} size={12} />
            <Text style={{ flex: 1, color: c.accent, fontSize: fs.xs, fontWeight: '600' }}>Briefing for you</Text>
            <ChevronRight color={c.accent} size={12} style={{ transform: [{ rotate: briefingOpen ? '90deg' : '0deg' }] }} />
          </Pressable>
          {briefingOpen && <Markdown text={submission.briefing} size={fs.sm} />}
        </View>
      )}

      {editing ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {VERDICTS.map((v) => (
              <Pressable
                key={v}
                onPress={() => setVerdict(v)}
                accessibilityRole="radio"
                accessibilityState={{ selected: verdict === v }}
                style={[st.chip, verdict === v && { backgroundColor: alpha(verdictTone(v), 0.15), borderColor: verdictTone(v) }]}
              >
                <Text style={{ color: verdict === v ? verdictTone(v) : c.dim, fontSize: fs.xs }}>{REVIEW_VERDICT_LABELS[v]}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput value={summary} onChangeText={setSummary} multiline keyboardAppearance={getThemeMode()} accessibilityLabel="Review summary" style={st.input} />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <TextButton label="Cancel" onPress={() => setEditing(false)} />
            <TextButton label="Save" primary onPress={save} />
          </View>
        </View>
      ) : submission.summary ? (
        submission.briefing ? (
          <View>
            <Pressable
              onPress={() => setAuthorSummaryOpen((v) => !v)}
              style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}
              accessibilityRole="button"
              accessibilityState={{ expanded: authorSummaryOpen }}
            >
              <ChevronRight color={c.faint} size={12} style={{ transform: [{ rotate: authorSummaryOpen ? '90deg' : '0deg' }] }} />
              <Text style={{ color: c.faint, fontSize: fs.xs }}>What the author agent receives</Text>
            </Pressable>
            {authorSummaryOpen && <Markdown text={submission.summary} size={fs.sm} />}
          </View>
        ) : (
          <Markdown text={submission.summary} size={fs.sm} />
        )
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {submission.state !== 'sent' && !editing && (
          <>
            <Pressable
              onPress={send}
              disabled={sending || !submission.targetTabId}
              accessibilityRole="button"
              accessibilityLabel={submission.state === 'failed' ? 'Retry sending the review' : 'Send the review'}
              style={({ pressed }) => [st.primary, (sending || !submission.targetTabId) && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}
            >
              <Send color={c.fgBright} size={14} />
              <Text style={{ color: c.fgBright, fontSize: fs.xs, fontWeight: '600' }}>{submission.state === 'failed' ? 'Retry' : 'Send'}</Text>
            </Pressable>
            <ActionButton label="Send to…" onPress={onSendTo} disabled={sending} />
            <ActionButton
              label="Edit"
              onPress={() => {
                setSummary(submission.summary)
                setVerdict(submission.verdict)
                setEditing(true)
              }}
            >
              <Pencil color={c.fg} size={12} />
            </ActionButton>
          </>
        )}
        {!editing && <ActionButton label={submission.state === 'sent' ? 'Dismiss' : 'Delete'} onPress={remove} />}
      </View>
    </View>
  )
}

/** The latest review over the diff: tap to read it in Reviews. */
export function LatestReviewBanner({
  submission,
  authorName,
  labelOf,
  onPress
}: {
  submission: ReviewSubmission
  authorName: (a: ReviewAuthor) => string
  labelOf: (tabId: string) => string | null
  onPress: () => void
}) {
  const status = submissionStatus(submission, labelOf)
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [st.banner, pressed && { backgroundColor: c.panelRaised }]}
      accessibilityRole="button"
      accessibilityLabel={`${REVIEW_VERDICT_LABELS[submission.verdict]} by ${authorName(submission.author)}, ${status.text}. Open reviews`}
    >
      <VerdictPill verdict={submission.verdict} />
      <Text style={{ color: c.accent, fontSize: fs.xs }} numberOfLines={1}>
        {authorName(submission.author)}
      </Text>
      <Text style={{ flex: 1, minWidth: 0, color: toneColor(status.tone), fontSize: fs.xs }} numberOfLines={1}>
        {status.text}
      </Text>
      <ChevronRight color={c.faint} size={12} />
    </Pressable>
  )
}

/** The reviewer at work, over the diff. */
export function ReviewerBanner({ status, onPress }: { status: PtyStatus | undefined; onPress?: () => void }) {
  const a = reviewerActivity(status)
  const color = toneColor(a.tone)
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [st.banner, pressed && { backgroundColor: c.panelRaised }]}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={onPress ? `${a.text}. Open the reviewer's chat` : a.text}
    >
      {a.busy ? (
        <Spin>
          <Loader2 color={color} size={14} />
        </Spin>
      ) : (
        <Bot color={color} size={14} />
      )}
      <Text style={{ flex: 1, color, fontSize: fs.xs }}>{a.text}</Text>
      {onPress && <Text style={{ color: c.faint, fontSize: fs.xs }}>Open chat</Text>}
      {onPress && <ChevronRight color={c.faint} size={12} />}
    </Pressable>
  )
}


const st = themed(() =>
  StyleSheet.create({
    section: { borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.panel, overflow: 'hidden' },
    sectionTitle: { color: c.muted, fontSize: fs.xs, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.6, padding: 12, paddingBottom: 4 },
    thread: { paddingHorizontal: 12, paddingVertical: 10, gap: 4, borderTopWidth: 1, borderColor: c.border, minHeight: 44 },
    dot: { width: 6, height: 6, borderRadius: 3 },
    briefing: { borderWidth: 1, borderColor: alpha(c.accent, 0.3), backgroundColor: alpha(c.accent, 0.05), borderRadius: 6, paddingHorizontal: 10, paddingBottom: 10 },
    chip: { minHeight: 44, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, justifyContent: 'center' },
    input: { minHeight: 88, maxHeight: 200, color: c.fg, fontSize: fs.sm, backgroundColor: c.surface, borderRadius: 8, borderWidth: 1, borderColor: c.border, padding: 10 },
    primary: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, borderRadius: 6, backgroundColor: c.accent },
    banner: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel }
  })
)
