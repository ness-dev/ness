import { Fragment, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderOpen, List, ListTree } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { sortChildren as sortByName, type FileListView, type TreeNode } from '../file-tree'

export function FileListViewToggle({
  view,
  onToggle
}: {
  view: FileListView
  onToggle: () => void
}): JSX.Element {
  const label = view === 'list' ? 'View as tree' : 'View as list'
  return (
    <Tooltip label={label}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        className="text-faint hover:text-fg transition-colors cursor-pointer"
        aria-label={label}
      >
        {view === 'list' ? <ListTree className="icon-xs" /> : <List className="icon-xs" />}
      </button>
    </Tooltip>
  )
}

/** Left padding for a file row at `depth`, aligned past the dir chevron. */
export function fileTreeIndent(depth: number): number {
  return 8 + depth * 12 + 10
}

interface TreeBranchProps {
  node: TreeNode
  depth: number
  isOpen: (path: string) => boolean
  onToggle: (path: string) => void
  renderFile: (node: TreeNode, depth: number) => ReactNode
  sortChildren?: (node: TreeNode) => TreeNode[]
  hasChangedDescendant?: (path: string) => boolean
}

export function TreeBranch({
  node,
  depth,
  isOpen,
  onToggle,
  renderFile,
  sortChildren = sortByName,
  hasChangedDescendant
}: TreeBranchProps): JSX.Element {
  return (
    <>
      {sortChildren(node).map((child) => {
        if (child.isFile) {
          return <Fragment key={child.path}>{renderFile(child, depth)}</Fragment>
        }
        const open = isOpen(child.path)
        return (
          <div key={`${child.path}/`}>
            <DirRow
              name={child.name}
              depth={depth}
              open={open}
              onToggle={() => onToggle(child.path)}
              hasChangedDescendant={hasChangedDescendant?.(child.path) ?? false}
            />
            {open && (
              <TreeBranch
                node={child}
                depth={depth + 1}
                isOpen={isOpen}
                onToggle={onToggle}
                renderFile={renderFile}
                sortChildren={sortChildren}
                hasChangedDescendant={hasChangedDescendant}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

function DirRow({
  name,
  depth,
  open,
  onToggle,
  hasChangedDescendant
}: {
  name: string
  depth: number
  open: boolean
  onToggle: () => void
  hasChangedDescendant: boolean
}): JSX.Element {
  return (
    <div
      onClick={onToggle}
      className="flex items-center gap-1 px-2 py-0.5 hover:bg-panel-raised cursor-pointer select-none"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <ChevronRight
        className={`icon-2xs shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      {open ? (
        <FolderOpen className="icon-xs shrink-0 text-info" />
      ) : (
        <Folder className="icon-xs shrink-0 text-info" />
      )}
      <span className="truncate text-fg">{name}</span>
      {hasChangedDescendant && (
        <span
          className="w-1 h-1 rounded-full bg-accent/50 shrink-0 ml-1"
          title="Contains changes in this PR"
          aria-hidden="true"
        />
      )}
    </div>
  )
}
