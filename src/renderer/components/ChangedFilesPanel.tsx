import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Code2, AtSign, ClipboardCheck } from 'lucide-react'
import type { ChangedFile } from '../types'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'
import { FileListViewToggle, TreeBranch, fileTreeIndent } from './FileTree'
import { useWatchedQuery } from '../hooks/useWatchedQuery'
import { requestChangedFiles } from '../hooks/changed-files-request'
import { useFileListView } from '../hooks/useFileListView'
import { useBackend } from '../backend'
import { buildTree, type FileListView } from '../file-tree'
import { destOf } from '../../shared/git-paths'

type Mode = 'working' | 'branch'

interface ChangedFilesPanelProps {
  worktreePath: string | null
  onOpenDiff: (filePath: string, staged: boolean, mode: Mode) => void
  onSendToAgent?: (text: string) => void
  onOpenReview?: () => void
}

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

const EMPTY_FILES: ChangedFile[] = []

interface ChangedFilesData {
  working: ChangedFile[]
  branch: ChangedFile[]
}

export function ChangedFilesPanel({ worktreePath, onOpenDiff, onSendToAgent, onOpenReview }: ChangedFilesPanelProps): JSX.Element {
  const backend = useBackend()
  const fetcher = useCallback(async (path: string, opts: { force: boolean }): Promise<ChangedFilesData> => {
    const [working, branch] = await Promise.all([
      requestChangedFiles(backend, path, 'working', opts),
      requestChangedFiles(backend, path, 'branch', opts),
    ])
    return { working, branch }
  }, [backend])

  const { data, loading, refresh } = useWatchedQuery<ChangedFilesData>({
    worktreePath,
    cacheKey: 'changedFiles',
    fetcher,
  })

  const workingFiles = data?.working ?? EMPTY_FILES
  const branchFiles = data?.branch ?? EMPTY_FILES
  const hasLoaded = !loading

  const stagedFiles = useMemo(() => workingFiles.filter((f) => f.staged), [workingFiles])
  const unstagedFiles = useMemo(() => workingFiles.filter((f) => !f.staged), [workingFiles])
  const totalCount = workingFiles.length + branchFiles.length
  const [uncommittedView, toggleUncommittedView] = useFileListView('changed-files:uncommitted', 'list')
  const [committedView, toggleCommittedView] = useFileListView('changed-files:committed', 'list')

  const actions = (
    <>
      {onOpenReview && branchFiles.length > 0 && (
        <Tooltip label="Review changes" action="openReview">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onOpenReview()
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded bg-accent text-app text-xs hover:bg-accent/80 transition-colors cursor-pointer"
          >
            <ClipboardCheck className="icon-xs" />
            Review
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
    <RightPanel id="changed-files" title="Changed Files" actions={actions} grow>
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {!worktreePath && (
          <div className="p-3 text-faint">No worktree selected</div>
        )}

        {worktreePath && hasLoaded && (
          <>
            {/* Uncommitted section */}
            <div className="px-3 py-1.5 flex items-center justify-between text-xs font-medium text-dim uppercase tracking-wider bg-panel-raised/50">
              <span>Uncommitted</span>
              <FileListViewToggle view={uncommittedView} onToggle={toggleUncommittedView} />
            </div>
            {workingFiles.length === 0 ? (
              <div className="px-3 py-2 text-faint italic">No changes</div>
            ) : (
              <>
                {stagedFiles.length > 0 && (
                  <div className="px-3 py-1 text-xs font-medium text-dim uppercase tracking-wider">
                    Staged
                  </div>
                )}
                <ChangedFileList
                  files={stagedFiles}
                  view={uncommittedView}
                  worktreePath={worktreePath}
                  onOpen={(file) => onOpenDiff(file.path, true, 'working')}
                  onSendToAgent={onSendToAgent}
                />
                {unstagedFiles.length > 0 && (
                  <div className="px-3 py-1 text-xs font-medium text-dim uppercase tracking-wider">
                    Unstaged
                  </div>
                )}
                <ChangedFileList
                  files={unstagedFiles}
                  view={uncommittedView}
                  worktreePath={worktreePath}
                  onOpen={(file) => onOpenDiff(file.path, false, 'working')}
                  onSendToAgent={onSendToAgent}
                />
              </>
            )}

            {/* Branch diff section */}
            <div className="px-3 py-1.5 flex items-center justify-between text-xs font-medium text-dim uppercase tracking-wider bg-panel-raised/50 mt-1">
              <span>Committed</span>
              <FileListViewToggle view={committedView} onToggle={toggleCommittedView} />
            </div>
            {branchFiles.length === 0 ? (
              <div className="px-3 py-2 text-faint italic">No commits on this branch yet</div>
            ) : (
              <ChangedFileList
                files={branchFiles}
                view={committedView}
                worktreePath={worktreePath}
                onOpen={(file) => onOpenDiff(file.path, false, 'branch')}
                onSendToAgent={onSendToAgent}
              />
            )}
          </>
        )}
      </div>

      {totalCount > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-xs text-faint shrink-0">
          {workingFiles.length > 0 && <span>{workingFiles.length} uncommitted</span>}
          {workingFiles.length > 0 && branchFiles.length > 0 && <span> · </span>}
          {branchFiles.length > 0 && <span>{branchFiles.length} committed</span>}
        </div>
      )}
    </RightPanel>
  )
}

function ChangedFileList({
  files,
  view,
  worktreePath,
  onOpen,
  onSendToAgent
}: {
  files: ChangedFile[]
  view: FileListView
  worktreePath: string
  onOpen: (file: ChangedFile) => void
  onSendToAgent?: (text: string) => void
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  // Renames are "old -> new"; place them by destination so the arrow
  // doesn't split into fake folders.
  const tree = useMemo(() => {
    if (view !== 'tree') return null
    const byPath = new Map(files.map((f) => [destOf(f.path), f]))
    return { root: buildTree([...byPath.keys()]), byPath }
  }, [files, view])

  useEffect(() => {
    setCollapsed(new Set())
  }, [worktreePath])

  const toggleDir = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  if (!tree) {
    return (
      <>
        {files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            worktreePath={worktreePath}
            onClick={() => onOpen(file)}
            onSendToAgent={onSendToAgent}
          />
        ))}
      </>
    )
  }
  return (
    <TreeBranch
      node={tree.root}
      depth={0}
      isOpen={(path) => !collapsed.has(path)}
      onToggle={toggleDir}
      renderFile={(node, depth) => {
        const file = tree.byPath.get(node.path)!
        return (
          <FileRow
            file={file}
            depth={depth}
            worktreePath={worktreePath}
            onClick={() => onOpen(file)}
            onSendToAgent={onSendToAgent}
          />
        )
      }}
    />
  )
}

function FileRow({
  file,
  depth,
  worktreePath,
  onClick,
  onSendToAgent
}: {
  file: ChangedFile
  /** Set in tree view: indent to this depth and show only the file name. */
  depth?: number
  worktreePath: string | null
  onClick: () => void
  onSendToAgent?: (text: string) => void
}): JSX.Element {
  const backend = useBackend()
  const inTree = depth !== undefined
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 && !inTree ? file.path.slice(0, lastSlash + 1) : ''
  // The tree places renames by destination, so name them by it too.
  const shown = inTree ? destOf(file.path) : file.path
  const name = shown.slice(shown.lastIndexOf('/') + 1)

  return (
    <div
      className={`flex items-center hover:bg-panel-raised cursor-pointer group ${
        inTree ? 'gap-1 px-2 py-0.5' : 'gap-2 px-3 py-1'
      }`}
      style={inTree ? { paddingLeft: fileTreeIndent(depth) } : undefined}
      onClick={onClick}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', `@${file.path} `)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <span className={`shrink-0 w-3 font-mono ${inTree ? 'text-center ' : ''}${STATUS_COLOR[file.status]}`}>
        {STATUS_LABEL[file.status]}
      </span>
      <Tooltip label={<span className="font-mono">{file.path}</span>} side="top">
        {inTree ? (
          <span className="truncate min-w-0 flex-1 text-fg">{name}</span>
        ) : (
          <span className="truncate min-w-0 flex-1" style={{ direction: 'rtl', textAlign: 'left' }}>
            <bdi>
              {dir && <span className="text-faint">{dir}</span>}
              <span className="text-fg">{name}</span>
            </bdi>
          </span>
        )}
      </Tooltip>
      {(file.additions !== undefined || file.deletions !== undefined) && (
        <span className="shrink-0 font-mono text-xs tabular-nums">
          {file.additions !== undefined && file.additions > 0 && (
            <span className="text-success">+{file.additions}</span>
          )}
          {file.deletions !== undefined && file.deletions > 0 && (
            <span className="text-danger ml-1">−{file.deletions}</span>
          )}
        </span>
      )}
      {onSendToAgent && (
        <Tooltip label="Reference in Claude" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSendToAgent(`@${file.path} `)
            }}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
          >
            <AtSign className="icon-xs" />
          </button>
        </Tooltip>
      )}
      {worktreePath && (
        <Tooltip label="Open file in editor" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              backend.openInEditor(worktreePath, file.path)
            }}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
          >
            <Code2 className="icon-xs" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
