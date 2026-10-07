import { useEffect, useRef, useState } from 'react'
import {
  GitCommitHorizontal,
  Copy,
  Check,
  X,
  Loader2,
  ChevronUp,
  ChevronDown,
  FileDiff
} from 'lucide-react'
import { getBackend } from '../backend'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import type { ChangedFile, CommitMeta } from '../types'

/** Optional prev/next navigation through a surrounding list of commits.
 *  Only the Commits panel supplies this; the terminal popups omit it. */
export interface CommitNav {
  onPrev: () => void
  onNext: () => void
  hasPrev: boolean
  hasNext: boolean
}

interface CommitInfoModalProps {
  worktreePath: string
  /** Full or abbreviated SHA to render. */
  sha: string
  /** Viewport coordinates used to anchor the popover. */
  anchor: { x: number; y: number }
  /** 'cursor' (default): popover's top-left sits at the anchor (terminal use).
   *  'right-edge': popover's RIGHT edge sits at anchor.x so it flies out from
   *  the left side of the right sidebar (Commits panel use). */
  placement?: 'cursor' | 'right-edge'
  /** When present, renders up/down controls (and binds ↑/↓) to walk the list. */
  nav?: CommitNav
  /** When present, each file row gains an open-diff button and a right-click
   *  "Open diff" item that opens this commit's changes to that file in a tab.
   *  Omitted by the terminal popovers, which have no tab context. */
  onOpenFileDiff?: (filePath: string) => void
  onClose: () => void
}

// Popover dimensions used to clamp it inside the viewport.
const POPOVER_WIDTH = 540
const POPOVER_MAX_HEIGHT_FRAC = 0.6

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U'
}
const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-info',
  untracked: 'text-dim'
}

function FileRow({
  file,
  copied,
  onCopyPath,
  onOpenDiff,
  onContextMenu
}: {
  file: ChangedFile
  copied: boolean
  onCopyPath: () => void
  onOpenDiff?: () => void
  onContextMenu: (e: React.MouseEvent) => void
}): JSX.Element {
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : ''
  const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path

  return (
    // A div rather than a button: the open-diff affordance is itself a
    // button, and nesting those is invalid.
    <div
      onClick={onCopyPath}
      onContextMenu={onContextMenu}
      title="Copy path"
      className="group flex w-full items-center gap-2 py-0.5 text-xs text-left rounded hover:bg-surface-hover cursor-pointer"
    >
      <span className={`shrink-0 w-3 font-mono ${STATUS_COLOR[file.status]}`}>
        {STATUS_LABEL[file.status]}
      </span>
      <span className="truncate min-w-0 flex-1 font-mono">
        {dir && <span className="text-faint">{dir}</span>}
        <span className="text-fg">{name}</span>
      </span>
      {onOpenDiff && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenDiff()
          }}
          title="Open diff for this file in a tab"
          className="shrink-0 opacity-0 group-hover:opacity-70 hover:!opacity-100 text-faint hover:text-fg-bright cursor-pointer"
        >
          <FileDiff className="icon-2xs" />
        </button>
      )}
      {copied ? (
        <Check className="icon-2xs shrink-0 text-success" />
      ) : (
        <Copy className="icon-2xs shrink-0 opacity-0 group-hover:opacity-60" />
      )}
      {(file.additions || file.deletions) && (
        <span className="shrink-0 font-mono tabular-nums">
          {file.additions ? <span className="text-success">+{file.additions}</span> : null}
          {file.deletions ? <span className="text-danger ml-1">−{file.deletions}</span> : null}
        </span>
      )}
    </div>
  )
}

export function CommitInfoModal({
  worktreePath,
  sha,
  anchor,
  placement = 'cursor',
  nav,
  onOpenFileDiff,
  onClose
}: CommitInfoModalProps): JSX.Element {
  const [meta, setMeta] = useState<CommitMeta | null>(null)
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [copied, setCopied] = useState(false)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const pathTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (pathTimer.current !== null) window.clearTimeout(pathTimer.current)
    }
  }, [])

  const copyPath = (path: string): void => {
    void navigator.clipboard?.writeText(path).then(() => {
      setCopiedPath(path)
      if (pathTimer.current !== null) window.clearTimeout(pathTimer.current)
      pathTimer.current = window.setTimeout(() => setCopiedPath(null), 1200)
    })
  }

  useEffect(() => {
    let cancelled = false
    setState('loading')
    const backend = getBackend()
    void Promise.all([
      backend.getCommitMeta(worktreePath, sha),
      backend.getCommitChangedFiles(worktreePath, sha)
    ])
      .then(([m, f]) => {
        if (cancelled) return
        if (m) {
          setMeta(m)
          setFiles(f)
          setState('ready')
        } else {
          setState('error')
        }
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, sha])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // Consume it: the terminal still has focus, so without stopping
        // propagation the Escape would also be sent to the agent/PTY.
        e.stopPropagation()
        // An open file menu is the innermost layer — dismiss that first.
        if (fileMenu) setFileMenu(null)
        else onClose()
      } else if (nav && e.key === 'ArrowUp' && nav.hasPrev) {
        e.preventDefault()
        e.stopPropagation()
        nav.onPrev()
      } else if (nav && e.key === 'ArrowDown' && nav.hasNext) {
        e.preventDefault()
        e.stopPropagation()
        nav.onNext()
      }
    }
    // Capture phase: xterm's textarea handler calls stopPropagation() on keys
    // it handles (Escape → \x1b), so a bubble-phase listener never fires while
    // the terminal is focused. Capturing runs us first.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, nav, fileMenu])

  const copySha = (): void => {
    const full = meta?.hash ?? sha
    void navigator.clipboard?.writeText(full).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  const fileMenuItems = (path: string): ContextMenuItem[] => {
    const items: ContextMenuItem[] = []
    if (onOpenFileDiff) {
      items.push({ label: 'Open diff in tab', onClick: () => onOpenFileDiff(path) })
    }
    items.push({ label: 'Copy path', onClick: () => copyPath(path) })
    return items
  }

  const shortSha = meta?.shortHash ?? sha.slice(0, 10)

  // Clamp the popover into the viewport. 'right-edge' butts its right side
  // against anchor.x (the sidebar's left edge) so it reads as flying out of
  // the sidebar; 'cursor' drops it below-right of the click.
  const maxHeight = Math.round(window.innerHeight * POPOVER_MAX_HEIGHT_FRAC)
  const left =
    placement === 'right-edge'
      ? Math.max(8, anchor.x - POPOVER_WIDTH - 6)
      : Math.max(8, Math.min(anchor.x, window.innerWidth - POPOVER_WIDTH - 8))
  const topRaw = placement === 'right-edge' ? anchor.y - 8 : anchor.y + 10
  const top = Math.max(8, Math.min(topRaw, window.innerHeight - maxHeight - 8))

  return (
    // Transparent full-screen catcher: any click outside the popover closes it.
    <div className="fixed inset-0 z-[70]" onClick={onClose}>
      <div
        className="fixed bg-panel-raised border border-border-strong rounded-lg shadow-xl overflow-hidden flex flex-col"
        style={{ left, top, width: POPOVER_WIDTH, maxHeight }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
          <GitCommitHorizontal className="icon-sm text-accent shrink-0" />
          <button
            onClick={copySha}
            title="Copy full SHA"
            className="flex items-center gap-1 text-xs font-mono text-fg hover:text-fg-bright cursor-pointer shrink-0"
          >
            {shortSha}
            {copied ? (
              <Check className="icon-2xs text-success" />
            ) : (
              <Copy className="icon-2xs opacity-60" />
            )}
          </button>
          {state === 'ready' && meta && (
            <span className="text-xs font-medium text-fg-bright truncate min-w-0">
              {meta.subject}
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5 shrink-0">
            {nav && (
              <>
                <button
                  onClick={nav.onPrev}
                  disabled={!nav.hasPrev}
                  title="Previous commit (↑)"
                  className="p-0.5 rounded hover:bg-surface-hover text-faint hover:text-fg-bright cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-faint"
                >
                  <ChevronUp className="icon-xs" />
                </button>
                <button
                  onClick={nav.onNext}
                  disabled={!nav.hasNext}
                  title="Next commit (↓)"
                  className="p-0.5 rounded hover:bg-surface-hover text-faint hover:text-fg-bright cursor-pointer disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-faint"
                >
                  <ChevronDown className="icon-xs" />
                </button>
              </>
            )}
            <button
              onClick={onClose}
              title="Close"
              className="p-0.5 rounded hover:bg-surface-hover text-faint hover:text-fg-bright cursor-pointer"
            >
              <X className="icon-xs" />
            </button>
          </div>
        </div>

        {state === 'loading' && (
          <div className="px-3 py-6 flex items-center justify-center gap-2 text-xs text-faint">
            <Loader2 className="icon-xs animate-spin" />
            Loading…
          </div>
        )}

        {state === 'error' && (
          <div className="px-3 py-6 text-xs text-faint text-center">
            Couldn't load commit <span className="font-mono text-fg">{sha}</span>.
          </div>
        )}

        {state === 'ready' && meta && (
          <div className="overflow-y-auto flex flex-col min-h-0">
            <div className="px-3 py-1.5 border-b border-border text-xs text-faint shrink-0 truncate">
              <span className="text-fg">{meta.author}</span>
              {meta.date && <span> · {new Date(meta.date).toLocaleString()}</span>}
            </div>
            {meta.body.trim() !== '' && (
              <div className="px-3 py-1.5 border-b border-border text-xs text-fg whitespace-pre-wrap shrink-0">
                {meta.body.trim()}
              </div>
            )}
            <div className="px-3 py-2">
              <div className="text-xs text-faint mb-1">
                {files.length} {files.length === 1 ? 'file' : 'files'} changed
              </div>
              {files.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  copied={copiedPath === file.path}
                  onCopyPath={() => copyPath(file.path)}
                  onOpenDiff={onOpenFileDiff ? () => onOpenFileDiff(file.path) : undefined}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setFileMenu({ x: e.clientX, y: e.clientY, path: file.path })
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      {/* Sibling of the popover, not a child: the popover clips its own
          overflow, and the menu needs to escape those bounds. */}
      {fileMenu && (
        <ContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          items={fileMenuItems(fileMenu.path)}
          onClose={() => setFileMenu(null)}
        />
      )}
    </div>
  )
}
