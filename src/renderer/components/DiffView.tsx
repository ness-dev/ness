import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRightFromLine, AtSign, Save, WrapText } from 'lucide-react'
import type { CommitDiff, FileDiffSides } from '../types'
import { Tooltip } from './Tooltip'
import { detectLanguage, highlightLine } from '../syntax'
import { MonacoDiffEditor } from './MonacoDiffEditor'
import { useSettings } from '../store'
import { useBackend } from '../backend'
import { scaledEditorFontSize } from '../../shared/state/settings'

interface DiffViewProps {
  worktreePath: string
  filePath?: string
  staged?: boolean
  branchDiff?: boolean
  commitHash?: string
  onSendToAgent?: (text: string) => void
}

export function DiffView(props: DiffViewProps): JSX.Element {
  // commitHash + filePath = one file's changes within that commit (Monaco,
  // side-by-side). commitHash alone = the whole commit as raw diff text.
  if (props.commitHash && props.filePath) return <FileDiffView {...props} />
  if (props.commitHash) return <CommitDiffView {...props} />
  if (props.filePath) return <FileDiffView {...props} />
  return (
    <div className="flex items-center justify-center h-full text-faint text-sm">
      No diff available
    </div>
  )
}

function FileDiffView({
  worktreePath,
  filePath,
  staged,
  branchDiff,
  commitHash,
  onSendToAgent
}: DiffViewProps): JSX.Element {
  const backend = useBackend()
  const settings = useSettings()
  const [sides, setSides] = useState<FileDiffSides | null>(null)
  const [loading, setLoading] = useState(true)
  const [modifiedValue, setModifiedValue] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [wordWrap, setWordWrap] = useState(false)

  const valueRef = useRef(modifiedValue)
  const savedRef = useRef(savedValue)
  valueRef.current = modifiedValue
  savedRef.current = savedValue

  // Only unstaged working diffs have a modified side that IS the working
  // tree — the only place edits can meaningfully land. Everything else
  // (staged / branch / a historical commit) is read-only.
  const editable = !staged && !branchDiff && !commitHash
  const dirty = editable && modifiedValue !== savedValue

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setSides(null)
    setModifiedValue('')
    setSavedValue('')
    setSaveError(null)
    setWordWrap(false)
    if (!filePath) return
    const request = commitHash
      ? backend.getCommitFileDiffSides(worktreePath, commitHash, filePath)
      : backend.getFileDiffSides(
          worktreePath,
          filePath,
          staged ?? false,
          branchDiff ? 'branch' : 'working'
        )
    request
      .then((r) => {
        if (cancelled) return
        setSides(r)
        setModifiedValue(r.modified)
        setSavedValue(r.modified)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, filePath, staged, branchDiff, commitHash])

  const save = useCallback(async () => {
    if (!filePath || !editable) return
    const current = valueRef.current
    if (current === savedRef.current) return
    setSaveError(null)
    const r = await backend.writeWorktreeFile(worktreePath, filePath, current)
    if (r.ok) {
      setSavedValue(current)
    } else {
      setSaveError(r.error || 'Save failed')
    }
  }, [worktreePath, filePath, editable])

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      if (valueRef.current !== savedRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        Loading diff...
      </div>
    )
  }

  if (!sides) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        No diff available
      </div>
    )
  }

  if (sides.modifiedBinary) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        Binary file — diff not shown.
      </div>
    )
  }

  // Both sides missing means the path isn't in the commit at all — most
  // likely a rename we resolved to the wrong side. Say so rather than
  // falling through to the generic "No changes".
  if (commitHash && !sides.originalExists && !sides.modifiedExists) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        Not found in commit {commitHash.slice(0, 10)}.
      </div>
    )
  }

  if (!dirty && sides.original === sides.modified) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        No changes
      </div>
    )
  }

  const readOnlyBanner = commitHash
    ? `Viewing this file as changed by commit ${commitHash.slice(0, 10)} — read-only.`
    : branchDiff
      ? 'Viewing branch diff (base…HEAD) — read-only.'
      : staged
        ? 'Viewing staged diff — read-only. Unstage the file to edit here.'
        : null

  return (
    <div className="h-full flex flex-col bg-app">
      <div className="shrink-0 flex items-center gap-3 border-b border-border bg-panel px-4 py-2 text-xs">
        <span
          className="font-mono text-fg truncate flex-1 min-w-0"
          style={{ direction: 'rtl', textAlign: 'left' }}
          title={filePath}
        >
          <bdi>{filePath}</bdi>
          {dirty && <span className="text-warning ml-1">●</span>}
        </span>
        {saveError && (
          <span className="shrink-0 text-danger truncate max-w-[40%]" title={saveError}>
            {saveError}
          </span>
        )}
        {commitHash && (
          <span className="shrink-0 font-mono text-info">{commitHash.slice(0, 10)}</span>
        )}
        {!commitHash && staged && !branchDiff && <span className="shrink-0 text-info">staged</span>}
        {!commitHash && branchDiff && <span className="shrink-0 text-info">branch</span>}
        {!sides.originalExists && <span className="shrink-0 text-success">new file</span>}
        {!sides.modifiedExists && <span className="shrink-0 text-danger">deleted</span>}
        <Tooltip label={wordWrap ? 'No wrap' : 'Word wrap'}>
          <button
            onClick={() => setWordWrap((v) => !v)}
            className="shrink-0 text-faint hover:text-fg cursor-pointer"
          >
            {wordWrap ? <ArrowRightFromLine className="icon-xs" /> : <WrapText className="icon-xs" />}
          </button>
        </Tooltip>
        {editable && (
          <Tooltip label={dirty ? 'Save' : 'Saved'} hotkey={dirty ? 'Cmd+S' : undefined}>
            <button
              onClick={save}
              disabled={!dirty}
              className="shrink-0 text-faint hover:text-fg disabled:opacity-40 disabled:hover:text-faint cursor-pointer disabled:cursor-default"
            >
              <Save className="icon-xs" />
            </button>
          </Tooltip>
        )}
        {onSendToAgent && filePath && (
          <Tooltip label="Reference file in Claude">
            <button
              onClick={() => onSendToAgent(`@${filePath} `)}
              className="shrink-0 text-faint hover:text-fg cursor-pointer"
            >
              <AtSign className="icon-xs" />
            </button>
          </Tooltip>
        )}
      </div>
      {readOnlyBanner && (
        <div className="shrink-0 border-b border-border bg-info/10 px-4 py-1.5 text-xs text-info">
          {readOnlyBanner}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <MonacoDiffEditor
          original={sides.original}
          modified={editable ? modifiedValue : sides.modified}
          filePath={filePath}
          readOnly={!editable}
          fontFamily={settings.terminalFontFamily || undefined}
          fontSize={scaledEditorFontSize(settings.terminalFontSize, settings.uiScale)}
          wordWrap={wordWrap}
          onModifiedChange={editable ? setModifiedValue : undefined}
          onSave={editable ? save : undefined}
          onReferenceLine={
            onSendToAgent && filePath
              ? (ln) => onSendToAgent(`@${filePath}:${ln} `)
              : undefined
          }
        />
      </div>
    </div>
  )
}

// Commit diffs are whole-commit, multi-file text. Monaco's inline diff is
// per-file, so commit view keeps the legacy parsed rendering for now.
// Fold into Monaco by rendering one editor per changed file in a follow-up.
function CommitDiffView({
  worktreePath,
  commitHash,
  onSendToAgent
}: DiffViewProps): JSX.Element {
  const backend = useBackend()
  const [commit, setCommit] = useState<CommitDiff | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setCommit(null)
    if (!commitHash) return
    backend.getCommitDiff(worktreePath, commitHash).then((r) => {
      if (cancelled) return
      setCommit(r)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [worktreePath, commitHash])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        Loading diff...
      </div>
    )
  }
  if (!commit) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        No diff available
      </div>
    )
  }

  const lines = parseDiff(commit.diff)

  return (
    <div className="h-full overflow-auto bg-app">
      <CommitHeader commit={commit} />
      <div className="font-mono text-xs leading-5 min-w-fit">
        {lines.map((line, i) => (
          <div key={i} className={`flex group/line ${LINE_STYLES[line.type]}`}>
            <span className={`shrink-0 w-10 text-right pr-2 select-none ${GUTTER_STYLES[line.type]}`}>
              {line.type === 'add' || line.type === 'context' ? line.newLine : ''}
            </span>
            <span
              className={`shrink-0 w-10 text-right pr-2 select-none border-r border-border/50 ${GUTTER_STYLES[line.type]}`}
            >
              {line.type === 'remove' || line.type === 'context' ? line.oldLine : ''}
            </span>
            <span className="shrink-0 w-5 flex items-center justify-center">
              {onSendToAgent &&
                (line.type === 'add' || line.type === 'remove' || line.type === 'context') &&
                line.file && (
                  <Tooltip label="Reference this line in Claude" side="right">
                    <button
                      onClick={() => {
                        const ln =
                          line.type === 'add' || line.type === 'context'
                            ? line.newLine
                            : line.oldLine
                        onSendToAgent(ln ? `@${line.file}:${ln} ` : `@${line.file} `)
                      }}
                      className="opacity-0 group-hover/line:opacity-100 text-faint hover:text-fg transition-opacity cursor-pointer"
                    >
                      <AtSign className="icon-2xs" />
                    </button>
                  </Tooltip>
                )}
            </span>
            <span className="shrink-0 w-5 text-center select-none">
              {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ''}
            </span>
            <span
              className="whitespace-pre pr-4 hljs"
              dangerouslySetInnerHTML={{
                __html:
                  line.type === 'add' || line.type === 'remove' || line.type === 'context'
                    ? highlightLine(line.content, detectLanguage(line.file))
                    : escapeHtml(line.content)
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  content: string
  oldLine?: number
  newLine?: number
  file?: string
}

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let currentFile: string | undefined

  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6)
      lines.push({ type: 'header', content: line })
    } else if (line.startsWith('diff --git ')) {
      const match = line.match(/diff --git a\/(.+?) b\//)
      if (match) currentFile = match[1]
      lines.push({ type: 'header', content: line })
    } else if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      lines.push({ type: 'header', content: line })
    } else if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
      }
      lines.push({ type: 'hunk', content: line, file: currentFile })
    } else if (line.startsWith('+')) {
      lines.push({ type: 'add', content: line.slice(1), newLine, file: currentFile })
      newLine++
    } else if (line.startsWith('-')) {
      lines.push({ type: 'remove', content: line.slice(1), oldLine, file: currentFile })
      oldLine++
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'context', content: line.slice(1), oldLine, newLine, file: currentFile })
      oldLine++
      newLine++
    }
  }

  return lines
}

const LINE_STYLES: Record<DiffLine['type'], string> = {
  add: 'bg-success/15 text-success',
  remove: 'bg-danger/15 text-danger',
  context: 'text-muted',
  header: 'text-dim italic',
  hunk: 'text-info bg-info/10'
}

const GUTTER_STYLES: Record<DiffLine['type'], string> = {
  add: 'text-success/70',
  remove: 'text-danger/70',
  context: 'text-faint',
  header: '',
  hunk: 'text-info/70'
}

function CommitHeader({ commit }: { commit: CommitDiff }): JSX.Element {
  const date = new Date(commit.date)
  const formatted = isNaN(date.getTime()) ? commit.date : date.toLocaleString()
  return (
    <div className="border-b border-border bg-panel px-5 py-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-xs text-info bg-info/10 px-2 py-0.5 rounded">
          {commit.shortHash}
        </span>
        <span className="text-xs text-faint">{formatted}</span>
      </div>
      <div className="text-sm font-medium text-fg mb-1">{commit.subject}</div>
      <div className="text-xs text-muted mb-2">
        {commit.author}{' '}
        {commit.authorEmail && <span className="text-faint">&lt;{commit.authorEmail}&gt;</span>}
      </div>
      {commit.body && (
        <pre className="text-xs text-muted whitespace-pre-wrap font-sans mt-2 leading-relaxed">
          {commit.body.trim()}
        </pre>
      )}
    </div>
  )
}
