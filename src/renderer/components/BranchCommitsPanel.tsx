import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ArrowUp } from 'lucide-react'
import type { BranchCommit } from '../types'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'
import { CommitInfoModal } from './CommitInfoModal'
import { useWatchedQuery } from '../hooks/useWatchedQuery'
import { useBackend } from '../backend'

interface BranchCommitsPanelProps {
  worktreePath: string | null
  /** Opens one file's changes within a commit as a diff tab. */
  onOpenCommitFileDiff?: (commitHash: string, shortHash: string, filePath: string) => void
}

export function BranchCommitsPanel({
  worktreePath,
  onOpenCommitFileDiff
}: BranchCommitsPanelProps): JSX.Element | null {
  const backend = useBackend()
  const fetcher = useCallback((path: string) => backend.getBranchCommits(path), [backend])
  // Commit-info popover (reuses the terminal's CommitInfoModal). Tracks the
  // selected commit by index so the up/down controls can walk the list; x is
  // the sidebar's left edge (the popover flies out from there), y the row.
  const [popover, setPopover] = useState<{ index: number; x: number; y: number } | null>(null)

  const { data, loading, refresh } = useWatchedQuery<BranchCommit[]>({
    worktreePath,
    cacheKey: 'branchCommits',
    fetcher,
  })

  const commits = data ?? []
  const hasLoaded = !loading

  const [menu, setMenu] = useState<{ x: number; y: number; hash: string } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!worktreePath) return null

  const actions = (
    <>
      {commits.length > 0 && (
        <span className="text-xs text-faint">{commits.length}</span>
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
    <>
    <RightPanel id="commits" title="Commits" actions={actions} maxHeight="max-h-56">
      <div className="flex-1 overflow-y-auto min-h-0 text-xs py-1.5">
        {commits.length === 0 && hasLoaded && (
          <div className="px-4 py-2 text-faint">No commits ahead of base</div>
        )}
        {commits.map((c, i) => {
          const isFirst = i === 0
          const isLast = i === commits.length - 1
          const dotClass = c.pushed
            ? 'bg-border-strong ring-2 ring-panel group-hover:ring-panel-raised'
            : 'bg-warning ring-2 ring-panel group-hover:ring-panel-raised shadow-[0_0_6px_rgba(234,179,8,0.5)]'
          const tipSuffix = c.pushed ? 'pushed' : 'unpushed'
          return (
            <Tooltip key={c.hash} label={`${c.shortHash} · ${c.author} · ${c.relativeDate} · ${tipSuffix}`} side="left">
              <div
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, hash: c.hash })
                }}
                className="group relative flex items-center gap-2.5 pl-4 pr-3 py-1.5 hover:bg-panel-raised cursor-pointer"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', c.hash)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={(e) => {
                  const sidebar = (e.currentTarget as HTMLElement).closest(
                    '[data-right-sidebar]'
                  ) as HTMLElement | null
                  const x = sidebar ? sidebar.getBoundingClientRect().left : e.clientX
                  setPopover({ index: i, x, y: e.clientY })
                }}
              >
                {/* Tree line + dot */}
                <div className="relative shrink-0 w-3 self-stretch flex justify-center">
                  <div
                    className="absolute left-1/2 -translate-x-1/2 w-px bg-border-strong"
                    style={{ top: isFirst ? '50%' : 0, bottom: isLast ? '50%' : 0 }}
                  />
                  <div className={`relative z-10 self-center w-2 h-2 rounded-full transition-colors ${dotClass}`} />
                </div>
                <span className={`shrink-0 font-mono text-xs ${c.pushed ? 'text-faint' : 'text-warning'}`}>{c.shortHash}</span>
                <span className={`truncate min-w-0 flex-1 ${c.pushed ? 'text-dim' : 'text-fg'}`}>{c.subject}</span>
                {!c.pushed && (
                  <ArrowUp className="icon-2xs shrink-0 text-warning" />
                )}
              </div>
            </Tooltip>
          )
        })}
      </div>
      {menu && (
        <div
          className="fixed z-50 bg-panel-raised border border-border-strong rounded shadow-lg text-xs py-1 min-w-[12rem]"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full text-left px-3 py-1.5 hover:bg-panel text-fg-bright cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              void navigator.clipboard.writeText(menu.hash)
              setMenu(null)
            }}
          >
            Copy commit SHA
          </button>
        </div>
      )}
    </RightPanel>
    {popover && commits[popover.index] && (
      <CommitInfoModal
        worktreePath={worktreePath}
        sha={commits[popover.index].hash}
        anchor={{ x: popover.x, y: popover.y }}
        placement="right-edge"
        nav={{
          onPrev: () =>
            setPopover((p) => (p && p.index > 0 ? { ...p, index: p.index - 1 } : p)),
          onNext: () =>
            setPopover((p) =>
              p && p.index < commits.length - 1 ? { ...p, index: p.index + 1 } : p
            ),
          hasPrev: popover.index > 0,
          hasNext: popover.index < commits.length - 1
        }}
        onOpenFileDiff={
          onOpenCommitFileDiff
            ? (filePath) => {
                const c = commits[popover.index]
                onOpenCommitFileDiff(c.hash, c.shortHash, filePath)
                setPopover(null)
              }
            : undefined
        }
        onClose={() => setPopover(null)}
      />
    )}
    </>
  )
}
