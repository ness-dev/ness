// Body of a `review` tab on the phone: port of renderer/components/
// ReviewPane.tsx. Same requests, same slice, same per-client state
// (reviewed files, which file is open); laid out for one column:
//
//   [Diff | Reviews]            [open comments] [Send ▾]
//   [commit selection ▾] +a −d             n/m reviewed
//   latest review / reviewer at work (tap → Reviews)
//   [✓] path/to/file ▾                            ‹  ›
//   diff, comments under their lines; tap a line to comment
//
// Not ported: commit ranges (the desktop's shift-click; a range picked
// there still shows and diffs here), the file tree's folders, word wrap,
// the "r" hotkey, and the tab strip's "(n/m)" progress.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronLeft, ChevronRight, GitCommitHorizontal, MessageSquare, Send } from 'lucide-react-native'
import type { BranchCommit, ChangedFile } from '../../../src/renderer/types'
import { formatReviewComments } from '../../../src/shared/review-format'
import { tabLabel } from '../../../src/shared/agent-tabs'
import {
  EMPTY_REVIEW_COMMENTS,
  EMPTY_REVIEW_REQUESTS,
  EMPTY_REVIEW_SUBMISSIONS,
  type ReviewComment,
  type ReviewSubmission
} from '../../../src/shared/state/reviews'
import type { TerminalTab } from '../../../src/shared/state/terminals'
import { useNess, tabsOf, type NessClient } from '../ness'
import { rememberTab } from '../navState'
import { copyText } from '../clipboard'
import { haptic } from '../haptics'
import { c, fs, mono, themed } from '../theme'
import { Empty } from '../components/Empty'
import { ReviewDiff } from './ReviewDiff'
import { LatestReviewBanner, ReviewerBanner, ReviewsView } from './ReviewsView'
import { CommitsSheet, ComposeSheet, FilesSheet, ReviewedBox, SendSheet, ThreadSheet, authorNameFor } from './ReviewSheets'
import { commentCounts, perFileCounts, reviewScope, worktreeReviewStatus } from './review-model'

type SheetState =
  | { kind: 'files' }
  | { kind: 'commits' }
  | { kind: 'compose'; line: number; row: number; snippet: string }
  | { kind: 'thread'; id: string; fromDiff: boolean }
  | { kind: 'send' }
  | { kind: 'sendSubmission'; submission: ReviewSubmission }

export function ReviewTab({ client, worktreePath, tab }: { client: NessClient; worktreePath: string; tab: TerminalTab }) {
  const scope = reviewScope(tab)
  const scopeKey = scope.kind === 'branch' ? 'branch' : scope.kind === 'commit' ? scope.hash : `${scope.from}..${scope.to}`
  // Per-worktree selectors: the reducer keeps these arrays' identity until
  // this worktree's reviews change.
  const comments = useNess(client, (s) => s.reviews.byPath[worktreePath]?.comments ?? EMPTY_REVIEW_COMMENTS)
  const submissions = useNess(client, (s) => s.reviews.byPath[worktreePath]?.submissions ?? EMPTY_REVIEW_SUBMISSIONS)
  const requests = useNess(client, (s) => s.reviews.byPath[worktreePath]?.requests ?? EMPTY_REVIEW_REQUESTS)
  const tree = useNess(client, (s) => s.terminals.panes[worktreePath])
  const reviewKind = useNess(client, (s) => worktreeReviewStatus(s, worktreePath).kind)
  const reviewerTabId = useNess(client, (s) => worktreeReviewStatus(s, worktreePath).reviewerTabId)
  const reviewerStatus = useNess(client, (s) => worktreeReviewStatus(s, worktreePath).reviewerStatus)

  const [view, setView] = useState<'diff' | 'reviews'>('diff')
  const [commits, setCommits] = useState<BranchCommit[]>([])
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set())
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null)
  const [jumpMiss, setJumpMiss] = useState<string | null>(null)
  const [pendingJump, setPendingJump] = useState<string | null>(null)

  const tabs = useMemo(() => tabsOf(tree), [tree])
  const tabLabels = useMemo(() => new Map(tabs.map((t) => [t.id, tabLabel(t)])), [tabs])
  const labelOf = useCallback((id: string) => tabLabels.get(id) ?? null, [tabLabels])
  const authorName = useMemo(() => authorNameFor(tabLabels), [tabLabels])
  const reviewers = useMemo(() => {
    const out = new Set<string>()
    for (const r of requests) if (r.reviewer.kind === 'agent') out.add(r.reviewer.tabId)
    for (const s of submissions) if (s.author.kind === 'agent') out.add(s.author.tabId)
    for (const t of tabs) if (t.reviewOf) out.add(t.id)
    return out
  }, [requests, submissions, tabs])

  const loadCommits = useCallback(() => {
    let cancelled = false
    client.api.getBranchCommits(worktreePath).then(
      (r) => !cancelled && setCommits(r),
      () => !cancelled && setCommits([])
    )
    return () => {
      cancelled = true
    }
  }, [client, worktreePath])
  useEffect(() => loadCommits(), [loadCommits])
  // As on desktop: commits that landed while the tab was open show once
  // you look at the reviews or the commit list.
  useEffect(() => (view === 'reviews' || sheet?.kind === 'commits' ? loadCommits() : undefined), [view, sheet?.kind, loadCommits])

  useEffect(() => {
    let cancelled = false
    setFiles(null)
    const request =
      scope.kind === 'branch'
        ? client.api.getChangedFiles(worktreePath, 'branch')
        : scope.kind === 'commit'
          ? client.api.getCommitChangedFiles(worktreePath, scope.hash)
          : client.api.getCommitRangeChangedFiles(worktreePath, scope.from, scope.to)
    request.then(
      (result) => {
        if (cancelled) return
        setFiles(result)
        setSelectedFile((prev) => (prev && result.some((f) => f.path === prev) ? prev : (result[0]?.path ?? null)))
        // The reviewed set belongs to the previous file set.
        setReviewed(new Set())
      },
      () => !cancelled && setFiles([])
    )
    return () => {
      cancelled = true
    }
    // scopeKey stands in for scope's fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, worktreePath, scopeKey])

  // A jump that had to widen the selection to the whole branch, checked
  // once that file list arrives.
  useEffect(() => {
    if (!pendingJump || !files || scope.kind !== 'branch') return
    setPendingJump(null)
    if (!files.some((f) => f.path === pendingJump)) setJumpMiss(pendingJump)
  }, [pendingJump, files, scope.kind])

  // Re-anchor against HEAD on open and whenever a file is opened.
  useEffect(() => {
    void client.api.refreshReviewAnchors(worktreePath, selectedFile ?? undefined)
  }, [client, worktreePath, selectedFile])

  const file = files?.find((f) => f.path === selectedFile) ?? null
  const fileIndex = files && file ? files.indexOf(file) : -1
  const fileComments = useMemo(() => (selectedFile ? comments.filter((x) => x.filePath === selectedFile) : EMPTY_REVIEW_COMMENTS), [comments, selectedFile])
  const filesInView = useMemo(() => new Set((files ?? []).map((f) => f.path)), [files])
  const counts = useMemo(() => commentCounts(comments, filesInView), [comments, filesInView])
  const byFile = useMemo(() => perFileCounts(comments), [comments])
  const totals = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const f of files ?? []) {
      additions += f.additions ?? 0
      deletions += f.deletions ?? 0
    }
    return { additions, deletions }
  }, [files])

  const toggleReviewed = useCallback((path: string) => {
    setReviewed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const openTab = useCallback((tabId: string) => rememberTab(worktreePath, tabId), [worktreePath])

  const onLine = useCallback((line: number, row: number, snippet: string) => {
    haptic.select()
    setSheet({ kind: 'compose', line, row, snippet })
  }, [])
  const onThread = useCallback((id: string) => setSheet({ kind: 'thread', id, fromDiff: true }), [])
  const closeSheet = useCallback(() => setSheet(null), [])

  const addComment = useCallback(
    async (line: number, body: string): Promise<string | null> => {
      if (!selectedFile) return 'No file selected'
      const res = await client.api.addReviewComment(worktreePath, {
        filePath: selectedFile,
        line,
        side: 'new',
        body,
        view: scope.kind === 'branch' ? undefined : scope.kind === 'commit' ? { fromCommit: scope.hash, toCommit: scope.hash } : { fromCommit: scope.from, toCommit: scope.to }
      })
      return 'error' in res ? res.error : null
    },
    // scopeKey stands in for scope's fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, worktreePath, selectedFile, scopeKey]
  )

  const jumpToComment = useCallback(
    (cm: ReviewComment) => {
      setJumpMiss(null)
      setSheet(null)
      if (!filesInView.has(cm.filePath)) {
        if (scope.kind === 'branch') {
          setJumpMiss(cm.filePath)
          return
        }
        setPendingJump(cm.filePath)
        void client.api.panesSetReviewSelection(worktreePath, tab.id, undefined, undefined)
      }
      setSelectedFile(cm.filePath)
      setFocus((prev) => ({ id: cm.id, nonce: (prev?.nonce ?? 0) + 1 }))
      setView('diff')
    },
    [filesInView, scope.kind, client, worktreePath, tab.id]
  )

  // useTabHandlers.handleSendToAgent with a picked target: show the tab,
  // then a chat gets a message and a terminal agent a paste.
  const sendText = useCallback(
    (target: { id: string; kind: 'chat' | 'terminal' }, text: string) => {
      const t = tabs.find((x) => x.id === target.id)
      if (!t) return
      openTab(t.id)
      if (t.type === 'json-claude') client.api.sendJsonClaudeMessage(t.id, text)
      else client.api.writeTerminal(t.id, '\x1b[200~' + text + '\x1b[201~')
    },
    [tabs, client, openTab]
  )

  const latest = submissions.at(-1)
  const reviewing = reviewKind === 'reviewing' ? { tabId: reviewerTabId, status: reviewerStatus } : null
  const allReviewed = !!files && files.length > 0 && reviewed.size === files.length
  const progress = files && files.length > 0 ? reviewed.size / files.length : 0
  const scopeLabel =
    scope.kind === 'branch' ? 'All commits' : scope.kind === 'commit' ? shortOf(commits, scope.hash) : `${shortOf(commits, scope.from)}…${shortOf(commits, scope.to)}`

  return (
    <View style={{ flex: 1, backgroundColor: c.app }}>
      <View style={s.bar}>
        <View style={{ flexDirection: 'row', alignSelf: 'stretch' }} accessibilityRole="tablist">
          {(['diff', 'reviews'] as const).map((v) => (
            <Pressable
              key={v}
              onPress={() => setView(v)}
              accessibilityRole="tab"
              accessibilityState={{ selected: view === v }}
              style={[s.segBtn, view === v && { borderColor: c.muted }]}
            >
              <Text style={{ color: view === v ? c.fgBright : c.faint, fontSize: fs.xs }}>
                {v === 'diff' ? 'Diff' : `Reviews${submissions.length ? ` (${submissions.length})` : ''}`}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flex: 1 }} />
        {comments.length > 0 && (
          <View
            accessible
            accessibilityLabel={`${counts.open} open of ${comments.length} comments${counts.openElsewhere ? `, ${counts.openElsewhere} on files outside this selection` : ''}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 }}
          >
            <MessageSquare color={counts.open > 0 ? c.info : c.faint} size={12} />
            <Text style={{ color: counts.open > 0 ? c.info : c.faint, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>{counts.open}</Text>
          </View>
        )}
        <Pressable
          onPress={() => setSheet({ kind: 'send' })}
          disabled={counts.open === 0}
          accessibilityRole="button"
          accessibilityLabel="Send open comments to an agent"
          style={({ pressed }) => [{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }, counts.open === 0 && { opacity: 0.35 }, pressed && { opacity: 0.7 }]}
        >
          <View style={s.sendBtn}>
            <Send color={c.fgBright} size={12} />
            <Text style={{ color: c.fgBright, fontSize: fs.xs, fontWeight: '500' }}>Send</Text>
            <ChevronDown color={c.fgBright} size={10} />
          </View>
        </Pressable>
      </View>

      {view === 'reviews' ? (
        <ReviewsView
          client={client}
          worktreePath={worktreePath}
          submissions={submissions}
          comments={comments}
          reviewing={reviewing}
          authorName={authorName}
          labelOf={labelOf}
          onOpenTab={openTab}
          onOpenThread={(id) => setSheet({ kind: 'thread', id, fromDiff: false })}
          onSendTo={(submission) => setSheet({ kind: 'sendSubmission', submission })}
        />
      ) : (
        <>
          <View style={s.bar}>
            <Pressable
              onPress={() => setSheet({ kind: 'commits' })}
              accessibilityRole="button"
              accessibilityLabel={`Commits: ${scopeLabel}`}
              style={({ pressed }) => [s.scopeBtn, pressed && { backgroundColor: c.surface }]}
            >
              <GitCommitHorizontal color={c.faint} size={12} />
              <Text style={{ color: c.fg, fontSize: fs.xs, fontFamily: scope.kind === 'branch' ? undefined : mono }} numberOfLines={1}>
                {scopeLabel}
              </Text>
              <ChevronDown color={c.faint} size={10} />
            </Pressable>
            <Text style={{ fontFamily: mono, fontSize: fs.xs, fontVariant: ['tabular-nums'], paddingLeft: 8 }}>
              {totals.additions > 0 && <Text style={{ color: c.success }}>+{totals.additions} </Text>}
              {totals.deletions > 0 && <Text style={{ color: c.danger }}>−{totals.deletions}</Text>}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={{ color: allReviewed ? c.success : c.faint, fontSize: fs.xs, fontVariant: ['tabular-nums'], paddingRight: 12 }}>
              {allReviewed ? 'All reviewed' : `${reviewed.size}/${files?.length ?? 0} reviewed`}
            </Text>
          </View>
          <View style={{ height: 2, backgroundColor: c.border }}>
            <View style={{ height: 2, width: `${progress * 100}%`, backgroundColor: allReviewed ? c.success : c.accent }} />
          </View>

          {reviewing ? (
            <ReviewerBanner status={reviewing.status} onPress={reviewing.tabId && labelOf(reviewing.tabId) ? () => openTab(reviewing.tabId!) : undefined} />
          ) : latest ? (
            <LatestReviewBanner submission={latest} authorName={authorName} labelOf={labelOf} onPress={() => setView('reviews')} />
          ) : null}

          {jumpMiss && (
            <Pressable onPress={() => setJumpMiss(null)} style={s.notice} accessibilityRole="button" accessibilityHint="Dismisses this notice">
              <Text style={{ color: c.warning, fontSize: fs.xs, flex: 1 }}>
                <Text style={{ fontFamily: mono }}>{jumpMiss}</Text> is no longer in this branch&apos;s diff, so the comment can&apos;t be shown there.
              </Text>
            </Pressable>
          )}

          {files && file && (
            <View style={s.fileBar}>
              <ReviewedBox checked={reviewed.has(file.path)} onPress={() => toggleReviewed(file.path)} name={file.path} />
              <Pressable
                onPress={() => setSheet({ kind: 'files' })}
                accessibilityRole="button"
                accessibilityLabel={`${file.path}, file ${fileIndex + 1} of ${files.length}. Choose a file`}
                style={({ pressed }) => [{ flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }, pressed && { opacity: 0.6 }]}
              >
                <FilePath path={file.path} />
                <ChevronDown color={c.faint} size={10} />
                <Text style={{ color: c.faint, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>
                  {fileIndex + 1}/{files.length}
                </Text>
              </Pressable>
              <NavButton label="Previous file" disabled={fileIndex <= 0} onPress={() => setSelectedFile(files[fileIndex - 1].path)}>
                <ChevronLeft color={c.dim} size={16} />
              </NavButton>
              <NavButton label="Next file" disabled={fileIndex >= files.length - 1} onPress={() => setSelectedFile(files[fileIndex + 1].path)}>
                <ChevronRight color={c.dim} size={16} />
              </NavButton>
            </View>
          )}

          {files === null ? (
            <Empty message="Loading changes..." />
          ) : !file ? (
            <Empty message={files.length === 0 ? 'No changes in this selection' : 'Select a file to review'} />
          ) : (
            <ReviewDiff
              key={`${file.path}:${scopeKey}`}
              client={client}
              worktreePath={worktreePath}
              file={file}
              scope={scope}
              comments={fileComments}
              authorName={authorName}
              markedRow={sheet?.kind === 'compose' ? sheet.row : null}
              focus={focus}
              onLine={onLine}
              onThread={onThread}
            />
          )}
        </>
      )}

      {sheet?.kind === 'files' && files && (
        <FilesSheet
          files={files}
          selected={selectedFile}
          reviewed={reviewed}
          counts={byFile}
          onSelect={(p) => {
            setSelectedFile(p)
            setSheet(null)
          }}
          onToggleReviewed={toggleReviewed}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'commits' && (
        <CommitsSheet
          commits={commits}
          scope={scope}
          onSelect={(hash) => {
            setSheet(null)
            void client.api.panesSetReviewSelection(worktreePath, tab.id, hash ?? undefined, hash ?? undefined)
          }}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'compose' && <ComposeSheet line={sheet.line} snippet={sheet.snippet} onSubmit={(body) => addComment(sheet.line, body)} onClose={closeSheet} />}
      {sheet?.kind === 'thread' && (
        <ThreadSheet
          client={client}
          worktreePath={worktreePath}
          commentId={sheet.id}
          authorName={authorName}
          reviewers={reviewers}
          onShowInDiff={sheet.fromDiff ? undefined : jumpToComment}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'send' && (
        <SendSheet
          client={client}
          worktreePath={worktreePath}
          tabs={tabs}
          includeTerminals
          title={`Send ${counts.open} open ${counts.open === 1 ? 'comment' : 'comments'} to`}
          onPick={(target) => {
            setSheet(null)
            const text = formatReviewComments(comments)
            if (text) sendText(target, text + '\n')
          }}
          onCopy={() => {
            setSheet(null)
            const text = formatReviewComments(comments)
            if (text) void copyText(text).then((ok) => ok && haptic.success())
          }}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'sendSubmission' && (
        <SendSheet
          client={client}
          worktreePath={worktreePath}
          tabs={tabs}
          excludeTabId={sheet.submission.author.kind === 'agent' ? sheet.submission.author.tabId : undefined}
          title="Send the review to"
          onPick={(target) => {
            const id = sheet.submission.id
            setSheet(null)
            void client.api.sendReviewSubmission(worktreePath, id, target.id)
          }}
          onClose={closeSheet}
        />
      )}
    </View>
  )
}

function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')
  return (
    <Text style={{ flexShrink: 1, minWidth: 0, fontFamily: mono, fontSize: fs.xs }} numberOfLines={1} ellipsizeMode="head">
      {slash >= 0 && <Text style={{ color: c.faint }}>{path.slice(0, slash + 1)}</Text>}
      <Text style={{ color: c.fgBright }}>{path.slice(slash + 1)}</Text>
    </Text>
  )
}

function NavButton({ label, disabled, onPress, children }: { label: string; disabled: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable
      onPress={() => {
        haptic.select()
        onPress()
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, disabled && { opacity: 0.3 }, pressed && { backgroundColor: c.surface }]}
    >
      {children}
    </Pressable>
  )
}

function shortOf(commits: readonly BranchCommit[], hash: string): string {
  return commits.find((x) => x.hash === hash)?.shortHash ?? hash.slice(0, 7)
}

const s = themed(() =>
  StyleSheet.create({
    bar: { minHeight: 44, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel, paddingLeft: 8 },
    segBtn: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderBottomWidth: 2, borderColor: 'transparent' },
    sendBtn: { height: 30, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, backgroundColor: c.accent, borderRadius: 6 },
    scopeBtn: { minHeight: 44, maxWidth: '55%', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, borderRadius: 4 },
    fileBar: { minHeight: 44, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel },
    notice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel }
  })
)
