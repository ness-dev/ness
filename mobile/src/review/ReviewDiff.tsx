// One file of the Review tab: ReviewDiffPane on the phone's unified diff
// viewer (viewer/code-html.ts), with comment cards under their lines. The
// page is built once per file revision; comment changes are pushed into it
// (setThreadsJs) so adding or resolving one doesn't reload it or lose the
// scroll position.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight, MessageSquare } from 'lucide-react-native'
import type { ChangedFile, FileDiffSides } from '../../../src/renderer/types'
import type { ReviewAuthor, ReviewComment } from '../../../src/shared/state/reviews'
import type { NessClient } from '../ness'
import { c, fs, mono } from '../theme'
import { Empty } from '../components/Empty'
import { CodeWebView, type CodeWebViewHandle } from '../viewer/CodeWebView'
import { diffHtml, markRowJs, revealThreadJs, setThreadsJs, type ReviewPageMessage } from '../viewer/code-html'
import { unifiedDiff } from '../viewer/diff-model'
import { useFileWatch } from '../viewer/ViewerTab'
import { threadBlocks } from './review-html'
import { placeCommentsInDiff, type ReviewScope } from './review-model'

type SidesState = { kind: 'loading' } | { kind: 'ready'; sides: FileDiffSides } | { kind: 'error'; message: string }

export const ReviewDiff = memo(function ReviewDiff({
  client,
  worktreePath,
  file,
  scope,
  comments,
  authorName,
  markedRow,
  focus,
  onLine,
  onThread
}: {
  client: NessClient
  worktreePath: string
  file: ChangedFile
  scope: ReviewScope
  /** This file's comments. */
  comments: readonly ReviewComment[]
  authorName: (a: ReviewAuthor) => string
  /** Row highlighted while its composer is open. */
  markedRow: number | null
  /** Scroll to this comment once it's drawn. A new nonce re-jumps. */
  focus: { id: string; nonce: number } | null
  onLine: (line: number, row: number, text: string) => void
  onThread: (id: string) => void
}) {
  const [state, setState] = useState<SidesState>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [unplacedOpen, setUnplacedOpen] = useState(true)
  // Only the branch diff follows the working copy (base...HEAD changes as
  // commits land); a commit's or range's never does.
  useFileWatch(client, worktreePath, scope.kind === 'branch' ? file.path : null, () => setReload((n) => n + 1))

  const scopeKey = scope.kind === 'branch' ? 'branch' : scope.kind === 'commit' ? scope.hash : `${scope.from}..${scope.to}`
  useEffect(() => {
    let cancelled = false
    if (reload === 0) setState({ kind: 'loading' })
    const request =
      scope.kind === 'range'
        ? client.api.getCommitRangeFileDiffSides(worktreePath, scope.from, scope.to, file.path)
        : scope.kind === 'commit'
          ? client.api.getCommitFileDiffSides(worktreePath, scope.hash, file.path)
          : client.api.getFileDiffSides(worktreePath, file.path, !!file.staged, 'branch')
    request.then(
      (sides) => !cancelled && setState({ kind: 'ready', sides }),
      (e: unknown) => !cancelled && setState({ kind: 'error', message: e instanceof Error ? e.message : 'No diff available' })
    )
    return () => {
      cancelled = true
    }
    // scopeKey stands in for scope's fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, worktreePath, file.path, file.staged, scopeKey, reload])

  const shown = state.kind === 'ready' && !state.sides.binary && !state.sides.tooLarge && !state.sides.error ? state.sides : null
  // Keyed on the text, not the object: a watch-triggered reload that finds
  // the same content mustn't rebuild the page and lose the scroll.
  const original = shown?.original
  const modified = shown?.modified
  const diff = useMemo(() => (original !== undefined && modified !== undefined ? unifiedDiff(original, modified) : null), [original, modified])
  const placement = useMemo(() => (diff && modified !== undefined ? placeCommentsInDiff(diff.rows, modified, comments) : null), [diff, modified, comments])
  const blocks = useMemo(() => (placement ? threadBlocks(placement, authorName) : []), [placement, authorName])
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  // Built from the cards current when the revision loads; later card
  // changes are injected, so this only rebuilds with the diff itself.
  const html = useMemo(
    () =>
      diff && original !== undefined && modified !== undefined && diff.rows.length > 0
        ? diffHtml(diff, { original, modified, filePath: file.path }, { review: { threads: blocksRef.current } })
        : null,
    // original/modified are what diff was built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diff, file.path]
  )

  const web = useRef<CodeWebViewHandle>(null)
  const loaded = useRef(false)
  const pendingFocus = useRef<string | null>(null)
  const markedRowRef = useRef(markedRow)
  markedRowRef.current = markedRow
  useEffect(() => {
    loaded.current = false
  }, [html])
  useEffect(() => {
    if (loaded.current) web.current?.injectJavaScript(setThreadsJs(blocks))
  }, [blocks])
  useEffect(() => {
    if (loaded.current) web.current?.injectJavaScript(markRowJs(markedRow))
  }, [markedRow])
  useEffect(() => {
    if (!focus || !placement) return
    if (placement.unplaced.some((u) => u.comment.id === focus.id)) {
      setUnplacedOpen(true)
      return
    }
    if (loaded.current) web.current?.injectJavaScript(revealThreadJs(focus.id))
    else pendingFocus.current = focus.id
  }, [focus, placement])

  const onLoadEnd = useCallback(() => {
    loaded.current = true
    // Anything that changed while the page was loading.
    web.current?.injectJavaScript(setThreadsJs(blocksRef.current) + markRowJs(markedRowRef.current))
    if (pendingFocus.current) {
      web.current?.injectJavaScript(revealThreadJs(pendingFocus.current))
      pendingFocus.current = null
    }
  }, [])

  const rowsRef = useRef(diff?.rows)
  rowsRef.current = diff?.rows
  const onMessage = useCallback(
    (data: string) => {
      let m: ReviewPageMessage
      try {
        m = JSON.parse(data) as ReviewPageMessage
      } catch {
        return
      }
      if (m.type === 'thread') onThread(m.id)
      else if (m.type === 'line') {
        const row = rowsRef.current?.[m.row]
        onLine(m.line, m.row, row?.kind === 'line' ? row.text : '')
      }
    },
    [onLine, onThread]
  )

  if (state.kind === 'loading') return <Empty message="Loading diff..." />
  if (state.kind === 'error') return <Empty message={state.message} />
  if (state.sides.error) return <Empty message={state.sides.error} />
  if (state.sides.binary || state.sides.tooLarge) {
    return <Empty message={state.sides.binary ? 'Binary file — cannot display diff' : 'File too large — cannot display diff'} />
  }

  const unplaced = placement?.unplaced ?? []
  return (
    <View style={{ flex: 1 }}>
      {unplaced.length > 0 && (
        <View style={{ borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.panel }}>
          <Pressable
            onPress={() => setUnplacedOpen((v) => !v)}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 }}
            accessibilityRole="button"
            accessibilityState={{ expanded: unplacedOpen }}
          >
            <ChevronRight color={c.faint} size={12} style={{ transform: [{ rotate: unplacedOpen ? '90deg' : '0deg' }] }} />
            <Text style={{ color: c.faint, fontSize: fs.xs }}>
              {unplaced.length} {unplaced.length === 1 ? 'comment' : 'comments'} not on a line in this diff
            </Text>
          </Pressable>
          {unplacedOpen &&
            unplaced.map(({ comment, line }) => (
              <Pressable
                key={comment.id}
                onPress={() => onThread(comment.id)}
                style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: pressed ? c.panelRaised : 'transparent' })}
                accessibilityRole="button"
                accessibilityLabel={`Comment by ${authorName(comment.author)}: ${comment.body}`}
              >
                <MessageSquare color={comment.status === 'open' ? c.info : c.faint} size={12} />
                <Text style={{ fontFamily: mono, fontSize: fs.xs, color: c.faint }}>
                  {comment.side === 'old' ? `L${comment.line} (old)` : `L${line ?? comment.line}`}
                  {line !== null ? ' · outside the changed lines' : comment.status === 'outdated' ? ' · outdated' : ''}
                </Text>
                <Text style={{ flex: 1, minWidth: 0, fontSize: fs.xs, color: comment.status === 'open' ? c.fg : c.dim }} numberOfLines={1}>
                  {comment.body}
                </Text>
              </Pressable>
            ))}
        </View>
      )}
      {html ? <CodeWebView ref={web} html={html} onMessage={onMessage} onLoadEnd={onLoadEnd} /> : <Empty message="No changes" />}
    </View>
  )
})
