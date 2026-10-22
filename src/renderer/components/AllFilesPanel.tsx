import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, AtSign, Code2, FolderOpen, FileText } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'
import { FileListViewToggle, TreeBranch, fileTreeIndent } from './FileTree'
import { useFileListView } from '../hooks/useFileListView'
import { useActiveBackend, useSettings } from '../store'
import { useBackend } from '../backend'
import { bindingToString, formatBindingGlyphs, resolveHotkeys } from '../hotkeys'
import type { ChangedFile } from '../types'
import { buildTree, sortChildren, type TreeNode } from '../file-tree'
import {
  CHANGED_STATUS_COLOR,
  CHANGED_STATUS_LABEL,
  useChangedFilesSet,
} from '../hooks/useChangedFilesSet'

/** List view renders every row with no virtualization, so cap it. */
const LIST_VIEW_LIMIT = 1000

interface AllFilesPanelProps {
  worktreePath: string | null
  onOpenFile: (filePath: string) => void
  onSendToAgent?: (text: string) => void
}

/** When the user has a filter typed, surface changed files above
 *  unchanged ones within the filtered list. Stable tiebreak by the
 *  original alphabetical order from sortChildren. */
function sortChildrenChangedFirst(
  node: TreeNode,
  changedByPath: Map<string, ChangedFile>,
  changedFolders: Set<string>
): TreeNode[] {
  const base = sortChildren(node)
  if (changedByPath.size === 0) return base
  const isChanged = (n: TreeNode): boolean =>
    n.isFile ? changedByPath.has(n.path) : changedFolders.has(n.path)
  return base
    .map((n, i) => ({ n, i, changed: isChanged(n) }))
    .sort((a, b) => {
      if (a.n.isFile !== b.n.isFile) return a.n.isFile ? 1 : -1
      if (a.changed !== b.changed) return a.changed ? -1 : 1
      return a.i - b.i
    })
    .map((e) => e.n)
}

export function AllFilesPanel({
  worktreePath,
  onOpenFile,
  onSendToAgent
}: AllFilesPanelProps): JSX.Element {
  const backend = useBackend()
  const activeBackend = useActiveBackend()
  const [files, setFiles] = useState<string[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const settings = useSettings()
  const quickOpenGlyphs = useMemo(() => {
    const binding = resolveHotkeys(settings.hotkeys ?? undefined).fileQuickOpen
    return formatBindingGlyphs(bindingToString(binding))
  }, [settings.hotkeys])
  const changed = useChangedFilesSet(worktreePath)

  // FileRow is memoized but the parent hands us fresh callbacks on most
  // renders; route them through refs so row props stay stable.
  const onOpenFileRef = useRef(onOpenFile)
  const onSendToAgentRef = useRef(onSendToAgent)
  useEffect(() => {
    onOpenFileRef.current = onOpenFile
    onSendToAgentRef.current = onSendToAgent
  })
  const openFile = useCallback((path: string) => onOpenFileRef.current(path), [])
  const sendToAgent = useCallback((text: string) => onSendToAgentRef.current?.(text), [])
  const rowSendToAgent = onSendToAgent ? sendToAgent : undefined
  const [view, toggleView] = useFileListView('all-files', 'tree')

  const refresh = useCallback(async () => {
    if (!worktreePath) return
    try {
      const result = await backend.listAllFiles(worktreePath)
      setFiles(result)
    } catch (err) {
      console.error('Failed to list files:', err)
      setFiles([])
    } finally {
      setHasLoaded(true)
    }
  }, [worktreePath])

  useEffect(() => {
    setHasLoaded(false)
    setFilter('')
    setExpanded(new Set(['']))
  }, [worktreePath])

  useEffect(() => {
    refresh()
  }, [refresh])

  const sortedFiles = useMemo(
    () => (view === 'list' ? [...files].sort((a, b) => a.localeCompare(b)) : files),
    [files, view]
  )

  const filtered = useMemo(() => {
    if (!filter.trim()) return sortedFiles
    const q = filter.toLowerCase()
    return sortedFiles.filter((f) => f.toLowerCase().includes(q))
  }, [sortedFiles, filter])

  const filtering = filter.trim().length > 0

  const tree = useMemo(() => (view === 'tree' ? buildTree(filtered) : null), [filtered, view])

  // Changed files refresh on nearly every edit; only depend on them while
  // filtering, when they reorder the list.
  const changedFirstBy = filtering ? changed.byPath : null
  const listed = useMemo(() => {
    if (view !== 'list') return []
    if (!changedFirstBy || changedFirstBy.size === 0) return filtered.slice(0, LIST_VIEW_LIMIT)
    const changedFiles = filtered.filter((f) => changedFirstBy.has(f))
    const rest = filtered.filter((f) => !changedFirstBy.has(f))
    return [...changedFiles, ...rest].slice(0, LIST_VIEW_LIMIT)
  }, [filtered, view, changedFirstBy])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const actions = (
    <>
      <FileListViewToggle view={view} onToggle={toggleView} />
      {worktreePath && (
        <Tooltip label="Open worktree in editor" action="openInEditor">
          <button
            onClick={(e) => {
              e.stopPropagation()
              backend.openInEditor(worktreePath)
            }}
            className="text-faint hover:text-fg transition-colors cursor-pointer"
          >
            <Code2 className="icon-xs" />
          </button>
        </Tooltip>
      )}
      {worktreePath && activeBackend.kind === 'local' && (
        <Tooltip label="Reveal in Finder">
          <button
            onClick={(e) => {
              e.stopPropagation()
              backend.openPath(worktreePath)
            }}
            className="text-faint hover:text-fg transition-colors cursor-pointer"
          >
            <FolderOpen className="icon-xs" />
          </button>
        </Tooltip>
      )}
      <Tooltip label="Refresh">
        <button
          onClick={(e) => {
            e.stopPropagation()
            refresh()
          }}
          className="text-faint hover:text-fg transition-colors cursor-pointer"
        >
          <RefreshCw className="icon-xs" />
        </button>
      </Tooltip>
    </>
  )

  return (
    <RightPanel id="all-files" title="All Files" actions={actions} grow defaultCollapsed>
      <div className="shrink-0 p-2 border-b border-border">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files..."
          className="w-full bg-panel-raised border border-border rounded px-2 py-1 text-xs text-fg placeholder:text-faint focus:outline-none focus:border-border-strong"
        />
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {!worktreePath && <div className="p-3 text-faint">No worktree selected</div>}
        {worktreePath && hasLoaded && files.length === 0 && (
          <div className="p-3 text-faint">No files found</div>
        )}
        {worktreePath && filtering && filtered.length === 0 && files.length > 0 && (
          <div className="p-3 text-faint">No matches</div>
        )}
        {worktreePath && tree && filtered.length > 0 && (
          <TreeBranch
            node={tree}
            depth={0}
            isOpen={(path) => filtering || expanded.has(path)}
            onToggle={toggle}
            sortChildren={
              filtering
                ? (node) => sortChildrenChangedFirst(node, changed.byPath, changed.folders)
                : sortChildren
            }
            hasChangedDescendant={(path) => changed.folders.has(path)}
            renderFile={(node, depth) => (
              <FileRow
                name={node.name}
                path={node.path}
                depth={depth}
                worktreePath={worktreePath}
                onOpenFile={openFile}
                onSendToAgent={rowSendToAgent}
                changedStatus={changed.byPath.get(node.path)?.status}
              />
            )}
          />
        )}
        {worktreePath && view === 'list' && (
          <>
            {listed.map((path) => (
              <FileRow
                key={path}
                name={path.slice(path.lastIndexOf('/') + 1)}
                path={path}
                depth={null}
                worktreePath={worktreePath}
                onOpenFile={openFile}
                onSendToAgent={rowSendToAgent}
                changedStatus={changed.byPath.get(path)?.status}
              />
            ))}
            {filtered.length > listed.length && (
              <div className="px-3 py-2 text-faint italic">
                Showing first {listed.length} of {filtered.length} — filter to narrow
              </div>
            )}
          </>
        )}
      </div>
      {files.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-xs text-faint shrink-0 flex items-center justify-between">
          <span>
            {filtering ? `${filtered.length} / ${files.length}` : files.length} file
            {files.length !== 1 ? 's' : ''}
          </span>
          <kbd className="font-mono">{quickOpenGlyphs} fuzzy open</kbd>
        </div>
      )}
    </RightPanel>
  )
}

const FileRow = memo(function FileRow({
  name,
  path,
  depth,
  worktreePath,
  onOpenFile,
  onSendToAgent,
  changedStatus
}: {
  name: string
  path: string
  /** Tree indent level, or null in list view to show the full path. */
  depth: number | null
  worktreePath: string
  onOpenFile: (filePath: string) => void
  onSendToAgent?: (text: string) => void
  changedStatus?: ChangedFile['status']
}): JSX.Element {
  const backend = useBackend()
  const dir = depth === null ? path.slice(0, path.length - name.length) : ''
  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5 hover:bg-panel-raised cursor-pointer group"
      style={{ paddingLeft: depth === null ? 8 : fileTreeIndent(depth) }}
      onClick={() => onOpenFile(path)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', `@${path} `)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      {changedStatus ? (
        <span
          className={`shrink-0 w-3 font-mono text-center ${CHANGED_STATUS_COLOR[changedStatus]}`}
          title={`${changedStatus} in this PR`}
        >
          {CHANGED_STATUS_LABEL[changedStatus]}
        </span>
      ) : (
        <FileText className="icon-xs shrink-0 text-faint" />
      )}
      {depth === null ? (
        <span className="truncate min-w-0 flex-1" style={{ direction: 'rtl', textAlign: 'left' }}>
          <bdi>
            {dir && <span className="text-faint">{dir}</span>}
            <span className="text-fg">{name}</span>
          </bdi>
        </span>
      ) : (
        <span className="truncate min-w-0 flex-1 text-fg">{name}</span>
      )}
      {onSendToAgent && (
        <Tooltip label="Reference in Claude" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSendToAgent(`@${path} `)
            }}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
          >
            <AtSign className="icon-xs" />
          </button>
        </Tooltip>
      )}
      <Tooltip label="Open file in editor" side="left">
        <button
          onClick={(e) => {
            e.stopPropagation()
            backend.openInEditor(worktreePath, path)
          }}
          className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
        >
          <Code2 className="icon-xs" />
        </button>
      </Tooltip>
    </div>
  )
})
