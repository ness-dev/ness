import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as monaco from 'monaco-editor'
import { ArrowRightFromLine, Check, ChevronRight, RotateCcw, WrapText, X } from 'lucide-react'
import type { FileDiffSides, ChangedFile, ReviewComment, ReviewCommentStatus } from '../types'
import { placeComment, splitLines } from '../../shared/review-anchor'
import { reviewAuthorLabel } from '../review-format'
import { MonacoDiffEditor } from './MonacoDiffEditor'
import { Tooltip } from './Tooltip'
import { useSettings } from '../store'
import { useBackend } from '../backend'
import { useFileContentChange } from '../hooks/useFileContentChange'
import { scaledEditorFontSize } from '../../shared/state/settings'

interface ReviewDiffPaneProps {
  worktreePath: string
  file: ChangedFile | null
  mode: 'working' | 'branch'
  commitHash?: string
  /** When set, diffs the file across the commit range fromHash^..toHash.
   *  Overrides commitHash and mode. */
  commitRange?: { fromHash: string; toHash: string }
  reviewed: boolean
  comments: ReviewComment[]
  onToggleReviewed: () => void
  /** Resolves to an error message, or null on success. */
  onAddComment: (lineNumber: number, body: string) => Promise<string | null>
  onDeleteComment: (id: string) => void
  onSetCommentStatus: (id: string, status: ReviewCommentStatus) => void
  wordWrap: boolean
  onWordWrapChange: (next: boolean) => void
}

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked'
}

const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-info',
  untracked: 'text-dim'
}

const STATUS_ACCENT: Record<ReviewCommentStatus, string> = {
  open: 'var(--color-info, #58a6ff)',
  resolved: 'var(--color-success, #3fb950)',
  outdated: 'var(--color-faint)'
}

const actionButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  color: 'var(--color-faint)',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  fontSize: '0.75rem',
  padding: '0 0.125rem'
}

function countLines(text: string): number {
  return text.split('\n').length
}

/** View zones need a height up front. Approximates one editor line per
 *  text line; long lines that soft-wrap will clip, as before. */
function zoneHeightInLines(comment: ReviewComment): number {
  let lines = countLines(comment.body)
  for (const r of comment.replies ?? []) lines += countLines(r.body)
  return Math.max(2, Math.min(20, lines + 1))
}

function InlineComment({
  comment,
  location,
  onDelete,
  onSetStatus
}: {
  comment: ReviewComment
  /** Shown when the comment isn't drawn on its line, e.g. "L42". */
  location?: string
  onDelete: () => void
  onSetStatus: (status: ReviewCommentStatus) => void
}): JSX.Element {
  const accent = STATUS_ACCENT[comment.status]
  const muted = comment.status !== 'open'
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.125rem',
        padding: '0.375rem 0.75rem',
        fontSize: '0.75rem',
        borderLeft: `3px solid ${accent}`,
        background: `color-mix(in srgb, ${accent} 8%, transparent)`,
        margin: '0.125rem 0.5rem',
        opacity: muted ? 0.6 : 1
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
        <span style={{ flexShrink: 0, color: 'var(--color-faint)' }}>
          {reviewAuthorLabel(comment.author)}
          {location && <span style={{ fontFamily: 'monospace' }}> · {location}</span>}
          {comment.status === 'resolved' && ' · Resolved'}
          {comment.status === 'outdated' && ' · Outdated'}
        </span>
        <span
          style={{
            flex: 1,
            color: 'var(--color-fg)',
            whiteSpace: 'pre-wrap',
            textDecoration: comment.status === 'outdated' ? 'line-through' : undefined
          }}
        >
          {comment.body}
        </span>
        {comment.status === 'resolved' ? (
          <button
            onClick={() => onSetStatus('open')}
            aria-label="Reopen comment"
            style={actionButtonStyle}
            onMouseOver={(e) => (e.currentTarget.style.color = 'var(--color-fg)')}
            onMouseOut={(e) => (e.currentTarget.style.color = 'var(--color-faint)')}
          >
            <RotateCcw className="icon-xs" />
            Reopen
          </button>
        ) : (
          <button
            onClick={() => onSetStatus('resolved')}
            aria-label="Resolve comment"
            style={actionButtonStyle}
            onMouseOver={(e) => (e.currentTarget.style.color = 'var(--color-success, #3fb950)')}
            onMouseOut={(e) => (e.currentTarget.style.color = 'var(--color-faint)')}
          >
            <Check className="icon-xs" />
            Resolve
          </button>
        )}
        <button
          onClick={onDelete}
          aria-label="Delete comment"
          style={actionButtonStyle}
          onMouseOver={(e) => (e.currentTarget.style.color = 'var(--color-danger, #f85149)')}
          onMouseOut={(e) => (e.currentTarget.style.color = 'var(--color-faint)')}
        >
          <X className="icon-xs" />
        </button>
      </div>
      {comment.replies?.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: '0.5rem', paddingLeft: '1rem' }}>
          <span style={{ flexShrink: 0, color: 'var(--color-faint)' }}>
            ↳ {reviewAuthorLabel(r.author)}
          </span>
          <span style={{ flex: 1, color: 'var(--color-fg)', whiteSpace: 'pre-wrap' }}>{r.body}</span>
        </div>
      ))}
    </div>
  )
}

function InlineCommentInput({
  lineNumber,
  onSubmit,
  onCancel
}: {
  lineNumber: number
  /** Resolves to an error message, or null on success. */
  onSubmit: (body: string) => Promise<string | null>
  onCancel: () => void
}): JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const canSubmit = !!body.trim() && !submitting
  const submit = (): void => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    onSubmit(body.trim())
      .then((err) => {
        if (err) setError(err)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSubmitting(false))
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.375rem',
        padding: '0.5rem 0.75rem',
        margin: '0.125rem 0.5rem',
        borderRadius: '0.25rem',
        border: '1px solid var(--color-border-strong)',
        background: 'var(--color-panel-raised)'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--color-faint)', fontFamily: 'monospace' }}>
          Line {lineNumber}
        </span>
        <button
          onClick={onCancel}
          aria-label="Cancel comment"
          style={actionButtonStyle}
        >
          <X className="icon-xs" />
        </button>
      </div>
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
          e.stopPropagation()
        }}
        placeholder="Leave a comment..."
        rows={2}
        style={{
          width: '100%',
          background: 'var(--color-surface)',
          color: 'var(--color-fg)',
          fontSize: '0.75rem',
          borderRadius: '0.25rem',
          border: '1px solid var(--color-border)',
          padding: '0.375rem 0.5rem',
          resize: 'none',
          outline: 'none',
          fontFamily: 'inherit'
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
        <span
          style={{
            fontSize: '0.75rem',
            color: error ? 'var(--color-danger, #f85149)' : 'var(--color-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {error ?? '⌘Enter to submit'}
        </span>
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{
            flexShrink: 0,
            fontSize: '0.75rem',
            padding: '0.125rem 0.5rem',
            borderRadius: '0.25rem',
            background: canSubmit ? 'var(--color-accent)' : 'var(--color-border)',
            color: 'var(--color-fg)',
            border: 'none',
            cursor: canSubmit ? 'pointer' : 'default',
            opacity: canSubmit ? 1 : 0.3
          }}
        >
          Add Comment
        </button>
      </div>
    </div>
  )
}

interface ViewZoneEntry {
  zoneId: string
  root: Root
  domNode: HTMLDivElement
  stickyWrapper: HTMLDivElement
}

export function ReviewDiffPane({
  worktreePath,
  file,
  mode,
  commitHash,
  commitRange,
  reviewed,
  comments,
  onToggleReviewed,
  onAddComment,
  onDeleteComment,
  onSetCommentStatus,
  wordWrap,
  onWordWrapChange
}: ReviewDiffPaneProps): JSX.Element {
  const backend = useBackend()
  const settings = useSettings()
  const [sides, setSides] = useState<FileDiffSides | null>(null)
  const [loading, setLoading] = useState(false)
  const [commentLine, setCommentLine] = useState<number | null>(null)
  const [unplacedOpen, setUnplacedOpen] = useState(true)
  // State, not a ref: the editor is recreated on every file switch, and
  // the view-zone effect has to re-run against the new instance.
  const [editor, setEditor] = useState<monaco.editor.IStandaloneDiffEditor | null>(null)
  const viewZonesRef = useRef<ViewZoneEntry[]>([])

  // Working-tree diffs reflect the live file on disk; commit-range diffs
  // are immutable. Only the working-tree case is watched for refresh.
  const isWorkingTreeDiff = !commitHash && !commitRange
  const filePathStr = file?.path
  const fileStaged = file?.staged
  const fromHash = commitRange?.fromHash
  const toHash = commitRange?.toHash

  const loadSides = useCallback(
    (showLoading: boolean): (() => void) => {
      if (!filePathStr) {
        setSides(null)
        return () => {}
      }
      let cancelled = false
      if (showLoading) {
        setLoading(true)
        setEditor(null)
      }
      const promise =
        fromHash && toHash
          ? backend.getCommitRangeFileDiffSides(worktreePath, fromHash, toHash, filePathStr)
          : commitHash
            ? backend.getCommitFileDiffSides(worktreePath, commitHash, filePathStr)
            : backend.getFileDiffSides(worktreePath, filePathStr, !!fileStaged, mode)
      promise
        .then((result) => {
          if (!cancelled) setSides(result)
        })
        .catch(() => {
          if (!cancelled) setSides(null)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
      }
    },
    [worktreePath, filePathStr, fileStaged, mode, commitHash, fromHash, toHash, backend]
  )

  useEffect(() => {
    setCommentLine(null)
    return loadSides(true)
  }, [loadSides])

  useFileContentChange(
    isWorkingTreeDiff ? worktreePath : undefined,
    isWorkingTreeDiff ? filePathStr : undefined,
    () => {
      loadSides(false)
    }
  )

  // Comments are placed by snippet rather than trusting the stored line,
  // so a commit- or range-scoped view (whose content differs from HEAD)
  // still draws each comment on the code it was written about. Anything
  // that can't be placed — outdated, old-side, or a line that doesn't
  // exist in this revision — is listed above the diff instead.
  const { placed, unplaced } = useMemo(() => {
    const placedOut: { line: number; comment: ReviewComment }[] = []
    const unplacedOut: ReviewComment[] = []
    if (!sides || sides.modifiedBinary) return { placed: placedOut, unplaced: comments }
    const lines = splitLines(sides.modified)
    for (const c of comments) {
      const line = c.side === 'new' ? placeComment(lines, c) : null
      if (line === null) unplacedOut.push(c)
      else placedOut.push({ line, comment: c })
    }
    return { placed: placedOut, unplaced: unplacedOut }
  }, [sides, comments])

  useEffect(() => {
    if (!editor) return
    const modifiedEd = editor.getModifiedEditor()

    interface ZoneItem {
      lineNumber: number
      comment?: ReviewComment
    }
    const items: ZoneItem[] = placed.map((p) => ({ lineNumber: p.line, comment: p.comment }))
    if (commentLine !== null) items.push({ lineNumber: commentLine })
    if (items.length === 0) return
    items.sort((a, b) => a.lineNumber - b.lineNumber)

    const contentWidth = modifiedEd.getLayoutInfo().contentWidth
    const entries: ViewZoneEntry[] = []

    modifiedEd.changeViewZones((accessor) => {
      for (const item of items) {
        const domNode = document.createElement('div')
        domNode.style.zIndex = '10'

        // The view zone domNode stretches to the full scrollable content
        // width (which can be very wide with long lines). Pin the actual
        // content to the visible viewport using sticky positioning.
        const stickyWrapper = document.createElement('div')
        stickyWrapper.style.position = 'sticky'
        stickyWrapper.style.left = '0'
        stickyWrapper.style.width = `${contentWidth}px`
        domNode.appendChild(stickyWrapper)

        const zoneId = accessor.addZone({
          afterLineNumber: item.lineNumber,
          heightInLines: item.comment ? zoneHeightInLines(item.comment) : 7,
          domNode,
          suppressMouseDown: false
        })

        const root = createRoot(stickyWrapper)
        const c = item.comment
        if (c) {
          root.render(
            <InlineComment
              comment={c}
              onDelete={() => onDeleteComment(c.id)}
              onSetStatus={(status) => onSetCommentStatus(c.id, status)}
            />
          )
        } else {
          root.render(
            <InlineCommentInput
              lineNumber={item.lineNumber}
              onSubmit={async (body) => {
                const err = await onAddComment(item.lineNumber, body)
                if (!err) setCommentLine(null)
                return err
              }}
              onCancel={() => setCommentLine(null)}
            />
          )
        }

        entries.push({ zoneId, root, domNode, stickyWrapper })
      }
    })
    viewZonesRef.current = entries

    return () => {
      // The editor may already be disposed (file switch unmounts it first);
      // its zones went with it, so only the React roots need tearing down.
      try {
        modifiedEd.changeViewZones((accessor) => {
          for (const z of entries) accessor.removeZone(z.zoneId)
        })
      } catch {
        // disposed
      }
      for (const z of entries) z.root.unmount()
      viewZonesRef.current = []
    }
  }, [editor, placed, commentLine, onAddComment, onDeleteComment, onSetCommentStatus])

  const handleReferenceLine = useCallback((lineNumber: number) => {
    setCommentLine(lineNumber)
  }, [])

  const handleEditorMount = useCallback(
    (mounted: monaco.editor.IStandaloneDiffEditor) => {
      setEditor(mounted)
      // Keep sticky wrappers sized to the visible viewport on resize
      mounted.getModifiedEditor().onDidLayoutChange((layout) => {
        for (const z of viewZonesRef.current) {
          z.stickyWrapper.style.width = `${layout.contentWidth}px`
        }
      })
    },
    []
  )

  if (!file) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        Select a file to review
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* File header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-panel shrink-0">
        <Tooltip label={reviewed ? 'Mark as not viewed' : 'Mark as viewed'} hotkey="r">
          <button
            onClick={onToggleReviewed}
            aria-label={reviewed ? 'Mark as not viewed' : 'Mark as viewed'}
            className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors cursor-pointer ${
              reviewed
                ? 'bg-success/20 border-success text-success'
                : 'border-border-strong text-transparent hover:border-faint'
            }`}
          >
            {reviewed && <Check strokeWidth={3} className="icon-2xs" />}
          </button>
        </Tooltip>

        <span className="text-xs font-mono truncate flex-1">{file.path}</span>

        <span className={`text-xs ${STATUS_COLOR[file.status]}`}>
          {STATUS_LABEL[file.status]}
        </span>

        {(file.additions !== undefined || file.deletions !== undefined) && (
          <span className="text-xs font-mono tabular-nums">
            {file.additions !== undefined && file.additions > 0 && (
              <span className="text-success">+{file.additions}</span>
            )}
            {file.deletions !== undefined && file.deletions > 0 && (
              <span className="text-danger ml-1">−{file.deletions}</span>
            )}
          </span>
        )}

        <Tooltip label={wordWrap ? 'No wrap' : 'Word wrap'}>
          <button
            onClick={() => onWordWrapChange(!wordWrap)}
            className="shrink-0 text-faint hover:text-fg cursor-pointer"
          >
            {wordWrap ? <ArrowRightFromLine className="icon-xs" /> : <WrapText className="icon-xs" />}
          </button>
        </Tooltip>
      </div>

      {!loading && unplaced.length > 0 && (
        <div className="shrink-0 border-b border-border bg-panel max-h-[12rem] overflow-y-auto">
          <button
            onClick={() => setUnplacedOpen((v) => !v)}
            className="w-full flex items-center gap-1 px-3 py-1 text-xs text-faint hover:text-fg cursor-pointer"
          >
            <ChevronRight
              className={`icon-2xs shrink-0 transition-transform ${unplacedOpen ? 'rotate-90' : ''}`}
            />
            {unplaced.length} {unplaced.length === 1 ? 'comment' : 'comments'} not on a line in
            this diff
          </button>
          {unplacedOpen && (
            <div className="pb-1">
              {unplaced.map((c) => (
                <InlineComment
                  key={c.id}
                  comment={c}
                  location={c.side === 'old' ? `L${c.line} (old)` : `L${c.line}`}
                  onDelete={() => onDeleteComment(c.id)}
                  onSetStatus={(status) => onSetCommentStatus(c.id, status)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Diff with inline comments via view zones */}
      <div className="flex-1 min-h-0 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-faint text-sm z-10">
            Loading diff...
          </div>
        )}
        {!loading && sides && (
          <MonacoDiffEditor
            original={sides.original}
            modified={sides.modified}
            filePath={file.path}
            readOnly
            fontFamily={settings.terminalFontFamily || undefined}
            fontSize={scaledEditorFontSize(settings.terminalFontSize, settings.uiScale)}
            wordWrap={wordWrap}
            onReferenceLine={handleReferenceLine}
            onEditorMount={handleEditorMount}
            glyphClassName="comment-line-glyph"
            glyphHoverMessage="Add a comment on this line"
          />
        )}
        {!loading && sides?.error && (
          <div className="absolute inset-0 flex items-center justify-center text-danger text-sm">
            {sides.error}
          </div>
        )}
        {!loading && sides?.modifiedBinary && (
          <div className="absolute inset-0 flex items-center justify-center text-faint text-sm">
            Binary file — cannot display diff
          </div>
        )}
      </div>
    </div>
  )
}
