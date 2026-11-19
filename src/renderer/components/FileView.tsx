import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightFromLine, AtSign, Code2, Eye, Save, WrapText } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { rehypeHighlightShared } from '../rehype-highlight-shared'
import remarkGfm from 'remark-gfm'
import type { FileBinaryReadResult, FileReadResult } from '../types'
import { Tooltip } from './Tooltip'
import { MonacoEditor, type MonacoBlame } from './MonacoEditor'
import { isQuietBlameFailure } from '../../shared/loch'
import { useSettings, useWorktrees } from '../store'
import { useBackend } from '../backend'
import { useFileContentChange } from '../hooks/useFileContentChange'
import { scaledEditorFontSize } from '../../shared/state/settings'

interface FileViewProps {
  worktreePath: string
  filePath?: string
  onSendToAgent?: (text: string) => void
}

type ViewerMode = 'text' | 'markdown' | 'image' | 'pdf'

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const PDF_EXTS = new Set(['pdf'])

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlightShared]

/** Repos whose "record this repo" offer was dismissed this session. Module
 *  scope so it survives switching files, but not a reload — it's a nudge,
 *  not a preference. */
const dismissedRecordingOffers = new Set<string>()

function detectViewerMode(filePath: string): ViewerMode {
  const ext = (filePath.split('.').pop() || '').toLowerCase()
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (PDF_EXTS.has(ext)) return 'pdf'
  return 'text'
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function FileView({ worktreePath, filePath, onSendToAgent }: FileViewProps): JSX.Element {
  const backend = useBackend()
  const settings = useSettings()
  const [result, setResult] = useState<FileReadResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [value, setValue] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [markdownAsCode, setMarkdownAsCode] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [binary, setBinary] = useState<{ url: string; size: number; mime: string } | null>(null)
  const [binaryError, setBinaryError] = useState<string | null>(null)
  const [staleOnDisk, setStaleOnDisk] = useState(false)
  const [blame, setBlame] = useState<MonacoBlame | null>(null)
  const [blameStatus, setBlameStatus] = useState<string | null>(null)
  const [blameSeq, setBlameSeq] = useState(0)
  /** Blame ran and found nothing attributed — the cue to offer recording. */
  const [blameEmpty, setBlameEmpty] = useState(false)
  // Bumped only to re-render after a dismissal (the set lives at module scope).
  const [, setOfferDismissed] = useState(0)
  const lochEnabled = settings.lochBlameEnabled
  const { list: worktreeList } = useWorktrees()
  const repoRoot = worktreeList.find((w) => w.path === worktreePath)?.repoRoot ?? null
  const recording = !!repoRoot && settings.lochRecordingRepos.includes(repoRoot)

  const valueRef = useRef(value)
  const savedRef = useRef(savedValue)
  valueRef.current = value
  savedRef.current = savedValue

  const dirty = value !== savedValue

  const mode: ViewerMode = useMemo(
    () => (filePath ? detectViewerMode(filePath) : 'text'),
    [filePath]
  )
  const needsBinary = mode === 'image' || mode === 'pdf'

  // Loads (or re-loads) the file. Returns a `cancel` that prevents the
  // in-flight read from updating state — caller's responsibility to
  // call it on cleanup. `dirtyAware`:
  //   - false (initial open / explicit reload): unconditionally replaces
  //     `value` and `savedValue` with the disk contents.
  //   - true (background disk-change refresh): only updates `value` when
  //     the buffer is clean (no in-flight edits). When dirty, updates
  //     `savedValue` so the dirty marker reflects "differs from disk"
  //     and sets `staleOnDisk` so the banner renders.
  const loadFromDisk = useCallback(
    (dirtyAware: boolean): (() => void) => {
      let cancelled = false
      if (!filePath) return () => {}
      if (needsBinary) {
        backend
          .readWorktreeFileBinary(worktreePath, filePath)
          .then((r: FileBinaryReadResult) => {
            if (cancelled) return
            if (!r.ok) {
              setBinaryError(r.error)
              setBinary(null)
              setLoading(false)
              return
            }
            const blob = new Blob([base64ToArrayBuffer(r.base64)], { type: r.mime })
            const url = URL.createObjectURL(blob)
            setBinaryError(null)
            setBinary({ url, size: r.size, mime: r.mime })
            setLoading(false)
          })
      } else {
        backend.readWorktreeFile(worktreePath, filePath).then((r) => {
          if (cancelled) return
          setResult(r)
          const content = r.content ?? ''
          if (!dirtyAware) {
            setValue(content)
            setSavedValue(content)
            setStaleOnDisk(false)
          } else if (valueRef.current === savedRef.current) {
            // Clean buffer — adopt disk contents silently.
            setValue(content)
            setSavedValue(content)
            setStaleOnDisk(false)
          } else {
            // Dirty buffer — keep the user's edits, but update
            // savedValue so the dirty marker compares against the
            // latest disk content. Surface the banner.
            setSavedValue(content)
            setStaleOnDisk(true)
          }
          setLoading(false)
        })
      }
      return () => {
        cancelled = true
      }
    },
    [worktreePath, filePath, needsBinary, backend]
  )

  useEffect(() => {
    setLoading(true)
    setResult(null)
    setValue('')
    setSavedValue('')
    setSaveError(null)
    setBinary(null)
    setBinaryError(null)
    setMarkdownAsCode(false)
    setWordWrap(false)
    setStaleOnDisk(false)
    if (!filePath) {
      setLoading(false)
      return
    }
    return loadFromDisk(false)
  }, [worktreePath, filePath, needsBinary, loadFromDisk])

  useFileContentChange(worktreePath, filePath, () => {
    loadFromDisk(true)
    setBlameSeq((n) => n + 1)
  })

  // loch blame runs against the file on disk, so it is re-fetched whenever
  // the disk copy changes (watcher above, or our own save) and simply not
  // drawn while the buffer has unsaved edits — its line numbers would be
  // pointing at the wrong lines.
  useEffect(() => {
    setBlame(null)
    setBlameEmpty(false)
    if (!lochEnabled || !filePath || needsBinary) return
    let cancelled = false
    backend.lochBlame(worktreePath, filePath).then((r) => {
      if (cancelled) return
      if (r.ok) {
        setBlame({ hunks: r.hunks, sessions: r.sessions })
        setBlameEmpty(!r.hunks.some((h) => h.conversation))
      } else if (r.code === 'file-unreadable') {
        setBlameEmpty(true)
      } else if (!isQuietBlameFailure(r.code) && r.code !== 'disabled') {
        console.warn('[loch] blame failed', r.code, r.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [lochEnabled, worktreePath, filePath, needsBinary, blameSeq, backend])

  const enableRecording = useCallback(() => {
    if (!repoRoot) return
    setBlameStatus('Installing loch’s hooks…')
    backend.setLochRecording(repoRoot, true).then(
      (r) => {
        setBlameStatus(
          r.ok
            ? 'Recording this repo. New agent turns will show here; earlier history is being backfilled.'
            : `Couldn’t enable recording (${r.code})`
        )
        setBlameSeq((n) => n + 1)
      },
      (err) => setBlameStatus(`Couldn’t enable recording (${String(err)})`)
    )
  }, [backend, repoRoot])

  const showRecordingOffer =
    lochEnabled &&
    blameEmpty &&
    !recording &&
    !!repoRoot &&
    !dismissedRecordingOffers.has(repoRoot)

  const askLine = useCallback(
    (line: number, opts: { atTurn: boolean }) => {
      if (!filePath) return
      setBlameStatus('Forking the conversation…')
      backend.lochAsk(worktreePath, filePath, line, opts).then(
        (r) => {
          setBlameStatus(r.ok ? null : `Couldn’t open the conversation (${r.code})`)
        },
        (err) => setBlameStatus(`Couldn’t open the conversation (${String(err)})`)
      )
    },
    [backend, worktreePath, filePath]
  )

  const reloadFromDisk = useCallback(() => {
    loadFromDisk(false)
  }, [loadFromDisk])

  const dismissStaleBanner = useCallback(() => {
    setStaleOnDisk(false)
  }, [])

  // Revoke the blob URL when the loaded binary changes or the component
  // unmounts — otherwise large image/PDF blobs leak across file switches.
  useEffect(() => {
    if (!binary) return
    return () => {
      URL.revokeObjectURL(binary.url)
    }
  }, [binary])

  const save = useCallback(async () => {
    if (!filePath) return
    const current = valueRef.current
    if (current === savedRef.current) return
    setSaveError(null)
    const r = await backend.writeWorktreeFile(worktreePath, filePath, current)
    if (r.ok) {
      setSavedValue(current)
      setBlameSeq((n) => n + 1)
    } else {
      setSaveError(r.error || 'Save failed')
    }
  }, [worktreePath, filePath])

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

  if (!filePath) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        No file selected
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        Loading file...
      </div>
    )
  }

  if (needsBinary) {
    if (binaryError || !binary) {
      return (
        <div className="flex items-center justify-center h-full text-faint text-sm">
          {binaryError || 'Failed to read file'}
        </div>
      )
    }
    return (
      <div className="h-full flex flex-col bg-app">
        <FileHeader
          filePath={filePath}
          dirty={false}
          saveError={null}
          size={binary.size}
          truncated={false}
          worktreePath={worktreePath}
          onSendToAgent={onSendToAgent}
          showSave={false}
          onSave={save}
          toggleControl={null}
        />
        <div className="flex-1 min-h-0">
          {mode === 'image' ? (
            <ImageView url={binary.url} />
          ) : (
            <PdfView url={binary.url} />
          )}
        </div>
      </div>
    )
  }

  if (!result || result.error) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        {result?.error || 'Failed to read file'}
      </div>
    )
  }

  const isMarkdown = mode === 'markdown' && !result.binary && !result.truncated
  const showMarkdownRendered = isMarkdown && !markdownAsCode
  // Monaco is mounted whenever we're not showing the binary placeholder,
  // truncated placeholder, or rendered markdown — i.e. whenever the
  // user is looking at editable text. The wrap toggle is only useful then.
  const showMonaco = !result.binary && !result.truncated && !showMarkdownRendered

  const toggleControl =
    isMarkdown && !result.binary && !result.truncated ? (
      <Tooltip label={markdownAsCode ? 'Show rendered' : 'Show source'}>
        <button
          onClick={() => setMarkdownAsCode((v) => !v)}
          className="shrink-0 text-faint hover:text-fg cursor-pointer"
        >
          {markdownAsCode ? <Eye className="icon-xs" /> : <Code2 className="icon-xs" />}
        </button>
      </Tooltip>
    ) : null

  const wrapToggleControl: JSX.Element | null = showMonaco ? (
    <Tooltip label={wordWrap ? 'No wrap' : 'Word wrap'}>
      <button
        onClick={() => setWordWrap((v) => !v)}
        className="shrink-0 text-faint hover:text-fg cursor-pointer"
      >
        {wordWrap ? <ArrowRightFromLine className="icon-xs" /> : <WrapText className="icon-xs" />}
      </button>
    </Tooltip>
  ) : null

  return (
    <div className="h-full flex flex-col bg-app">
      <FileHeader
        filePath={filePath}
        dirty={dirty}
        saveError={saveError}
        size={result.size}
        truncated={result.truncated}
        worktreePath={worktreePath}
        onSendToAgent={onSendToAgent}
        showSave={true}
        saveDisabled={!dirty || result.binary || showMarkdownRendered}
        onSave={save}
        toggleControl={toggleControl}
        wrapToggleControl={wrapToggleControl}
      />
      {showRecordingOffer && !blameStatus && (
        <div className="shrink-0 flex items-center gap-3 border-b border-border bg-panel px-4 py-1.5 text-xs text-dim">
          <span className="flex-1 min-w-0">
            No conversation blame for this file. Record which agent turn writes each line in
            this repo from now on?
          </span>
          <button
            onClick={enableRecording}
            className="shrink-0 px-2 py-0.5 rounded bg-accent/15 text-fg-bright hover:bg-accent/25 cursor-pointer"
          >
            Record this repo
          </button>
          <button
            onClick={() => {
              if (repoRoot) dismissedRecordingOffers.add(repoRoot)
              setOfferDismissed((n) => n + 1)
            }}
            className="shrink-0 text-faint hover:text-fg cursor-pointer"
          >
            Not now
          </button>
        </div>
      )}
      {blameStatus && (
        <div className="shrink-0 flex items-center gap-3 border-b border-border bg-panel px-4 py-1.5 text-xs text-dim">
          <span className="flex-1 min-w-0 truncate">{blameStatus}</span>
          <button
            onClick={() => setBlameStatus(null)}
            className="shrink-0 text-faint hover:text-fg cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
      {staleOnDisk && (
        <StaleOnDiskBanner onReload={reloadFromDisk} onDismiss={dismissStaleBanner} />
      )}
      <div className="flex-1 min-h-0">
        {result.binary ? (
          <div className="p-4 text-faint text-sm">Binary file — not shown.</div>
        ) : result.truncated ? (
          <div className="h-full flex items-center justify-center text-faint text-sm px-4 text-center">
            File is larger than 2 MB — editing disabled. Open in your external editor.
          </div>
        ) : showMarkdownRendered ? (
          <div className="h-full overflow-auto">
            <div className="markdown text-fg text-sm max-w-3xl mx-auto px-6 py-6">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
                {value}
              </ReactMarkdown>
            </div>
          </div>
        ) : (
          <MonacoEditor
            value={value}
            filePath={filePath}
            readOnly={false}
            fontFamily={settings.terminalFontFamily || undefined}
            fontSize={scaledEditorFontSize(settings.terminalFontSize, settings.uiScale)}
            wordWrap={wordWrap}
            onChange={setValue}
            onSave={save}
            blame={dirty ? null : blame}
            onAskLine={askLine}
            onReferenceLine={
              onSendToAgent
                ? (ln) => onSendToAgent(`@${filePath}:${ln} `)
                : undefined
            }
          />
        )}
      </div>
    </div>
  )
}

interface FileHeaderProps {
  filePath: string
  dirty: boolean
  saveError: string | null
  size: number
  truncated: boolean
  worktreePath: string
  onSendToAgent?: (text: string) => void
  showSave: boolean
  saveDisabled?: boolean
  onSave: () => void
  toggleControl: JSX.Element | null
  wrapToggleControl?: JSX.Element | null
}

function FileHeader({
  filePath,
  dirty,
  saveError,
  size,
  truncated,
  worktreePath,
  onSendToAgent,
  showSave,
  saveDisabled,
  onSave,
  toggleControl,
  wrapToggleControl
}: FileHeaderProps): JSX.Element {
  const backend = useBackend()
  return (
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
      <span className="text-faint shrink-0">{formatBytes(size)}</span>
      {truncated && <span className="shrink-0 text-warning">truncated</span>}
      {wrapToggleControl}
      {toggleControl}
      {showSave && (
        <Tooltip label={dirty ? 'Save' : 'Saved'} hotkey={dirty ? 'Cmd+S' : undefined}>
          <button
            onClick={onSave}
            disabled={saveDisabled}
            className="shrink-0 text-faint hover:text-fg disabled:opacity-40 disabled:hover:text-faint cursor-pointer disabled:cursor-default"
          >
            <Save className="icon-xs" />
          </button>
        </Tooltip>
      )}
      {onSendToAgent && (
        <Tooltip label="Reference file in Claude">
          <button
            onClick={() => onSendToAgent(`@${filePath} `)}
            className="shrink-0 text-faint hover:text-fg cursor-pointer"
          >
            <AtSign className="icon-xs" />
          </button>
        </Tooltip>
      )}
      <Tooltip label="Open in external editor">
        <button
          onClick={() => backend.openInEditor(worktreePath, filePath)}
          className="shrink-0 text-faint hover:text-fg cursor-pointer"
        >
          <Code2 className="icon-xs" />
        </button>
      </Tooltip>
    </div>
  )
}

function StaleOnDiskBanner({
  onReload,
  onDismiss
}: {
  onReload: () => void
  onDismiss: () => void
}): JSX.Element {
  return (
    <div className="shrink-0 flex items-center gap-3 border-b border-border bg-warning/10 px-4 py-2 text-xs">
      <span className="text-fg flex-1 min-w-0">
        File changed on disk — your edits have not been replaced.
      </span>
      <button
        onClick={onReload}
        className="shrink-0 text-fg hover:text-warning cursor-pointer underline-offset-2 hover:underline"
      >
        Reload
      </button>
      <button
        onClick={onDismiss}
        className="shrink-0 text-faint hover:text-fg cursor-pointer underline-offset-2 hover:underline"
      >
        Keep editing
      </button>
    </div>
  )
}

function ImageView({ url }: { url: string }): JSX.Element {
  return (
    <div className="h-full w-full flex items-center justify-center overflow-auto bg-app p-4">
      <img
        src={url}
        alt=""
        className="max-h-full max-w-full object-contain"
        style={{ imageRendering: 'auto' }}
      />
    </div>
  )
}

function PdfView({ url }: { url: string }): JSX.Element {
  return (
    <iframe
      src={url}
      title="PDF"
      className="h-full w-full border-0 bg-app"
    />
  )
}
