import { useEffect, useRef, useState, type ReactElement } from 'react'
import { GitPullRequest, Loader2, TriangleAlert, Ghost, MoreHorizontal, Pin } from 'lucide-react'
import type { SidebarDetailPrefs } from '../types'
import { Tooltip } from './Tooltip'
import { repoNameColor } from './RepoIcon'
import { SubtitleDetail } from './WorktreeSubtitleDetail'
import { formatPendingTool } from '../pending-tool'
import { HotkeyBadge } from './HotkeyBadge'
import type { Action } from '../hotkeys'
import { ContextMenu } from './ContextMenu'
import { useBackend } from '../backend'
import { displayLabel } from '../worktree-display'
import { ALIAS_MAX_LEN } from '../../shared/state/aliases'
import { STATUS_COLORS, STATUS_LABELS, detachedLikeTooltip, prIconStyle, prIconTitle } from '../worktree-row-style'
import type { WorktreeRowModel } from '../worktree-list-model'
import {
  buildRowActions,
  buildAliasActions,
  buildRowMenuEntries,
  type WorktreeRowAction,
  type WorktreeRowActionHandlers
} from './worktree-row-actions'
import { WorktreeActionSheet } from './WorktreeActionSheet'

export type WorktreeListVariant = 'desktop' | 'touch'

interface WorktreeTabProps {
  row: WorktreeRowModel
  variant: WorktreeListVariant
  isActive: boolean
  /** Hoisted to the list so we don't run N keyboard listeners. Always false
   *  on touch. */
  metaHeld: boolean
  density: 'comfy' | 'compact'
  detailPrefs: SidebarDetailPrefs
  isEditingAlias: boolean
  actions: WorktreeRowActionHandlers
  onClick: () => void
  onStartAliasEdit: () => void
  onEndAliasEdit: () => void
}

export function WorktreeTab({
  row,
  variant,
  isActive,
  metaHeld,
  density,
  detailPrefs,
  isEditingAlias,
  actions,
  onClick,
  onStartAliasEdit,
  onEndAliasEdit
}: WorktreeTabProps): JSX.Element {
  const backend = useBackend()
  const touch = variant === 'touch'
  const { worktree, prStatus, displayStatus, pendingTool, shellActive, deleting, alias, isPinned } = row
  const label = displayLabel(worktree, alias, metaHeld)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const showPendingTool = displayStatus === 'needs-approval' && pendingTool
  const { iconColor } = prIconStyle(prStatus)
  // Touch rows keep 44px tap targets and the roomier two-line layout even
  // when the user picked a compact desktop sidebar.
  const effectiveDensity = touch ? 'comfy' : density

  const aliasActions = buildAliasActions(row, {
    onEditAlias: onStartAliasEdit,
    onClearAlias: () => void backend.clearAlias(worktree.path)
  })
  const rowActions = buildRowActions(row, deleting ? {} : actions)
  const menuEntries = buildRowMenuEntries(row, deleting ? {} : actions, {
    onEditAlias: onStartAliasEdit,
    onClearAlias: () => void backend.clearAlias(worktree.path)
  })

  return (
    <div
      onClick={onClick}
      onContextMenu={
        touch
          ? undefined
          : (e) => {
              if (deleting) return
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY })
            }
      }
      className={`group w-full text-left px-3 flex items-center gap-2 transition-colors cursor-pointer ${
        touch ? 'min-h-11 py-3' : 'py-2'
      } ${deleting ? 'opacity-60 italic' : ''} ${
        isActive ? 'bg-surface text-fg-bright' : 'text-muted hover:bg-panel-raised hover:text-fg'
      }`}
    >
      {deleting ? (
        <Loader2 className="icon-xs animate-spin text-danger shrink-0" aria-label="Deleting worktree" />
      ) : (
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[displayStatus]}`}
          title={STATUS_LABELS[displayStatus]}
        />
      )}
      {shellActive && (
        <Loader2 className="icon-xs animate-spin text-fg-bright shrink-0" aria-label="Shell activity" />
      )}
      {isPinned && (
        <span className="shrink-0 inline-flex group-hover:hidden" title="Pinned" aria-label="Pinned">
          <Pin className="icon-xs text-accent" />
        </span>
      )}
      {prStatus && (
        <span className="relative shrink-0" title={prIconTitle(prStatus)}>
          <GitPullRequest className={`icon-sm ${iconColor}`} />
          {prStatus.reviewDecision === 'approved' && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-success ring-1 ring-panel" />
          )}
          {prStatus.reviewDecision === 'changes_requested' && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warning ring-1 ring-panel" />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {isEditingAlias ? (
          <AliasEditor
            initialValue={alias ?? ''}
            onCommit={(value) => {
              void backend.setAlias(worktree.path, value)
              onEndAliasEdit()
            }}
            onCancel={onEndAliasEdit}
          />
        ) : (
          <RowTooltip
            enabled={!touch}
            label={alias ? `${alias} · ${worktree.branch}` : worktree.branch}
          >
            <div className="text-sm font-medium truncate flex items-center gap-1">
              <DetachedBadge branch={worktree.branch} />
              <span className={`truncate ${worktree.prunable ? 'line-through text-dim' : ''}`}>
                {label}
              </span>
              {worktree.prunable && (
                <span
                  className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning text-xs uppercase tracking-wide"
                  title={worktree.prunableReason || 'On-disk directory missing — click the ghost icon to run `git worktree prune`.'}
                >
                  <Ghost className="icon-2xs" />
                  stale
                </span>
              )}
            </div>
          </RowTooltip>
        )}
        {showPendingTool ? (
          <div className="text-xs text-danger truncate font-mono" title={formatPendingTool(pendingTool!)}>
            {formatPendingTool(pendingTool!)}
          </div>
        ) : worktree.prunable ? (
          <div className="text-xs text-faint truncate">
            {row.repoLabel ? (
              <span className="inline-flex items-center gap-1">
                <span className={repoNameColor(row.repoLabel)}>{row.repoLabel}</span>
                <span className="text-dim">·</span>
                {worktree.path.split('/').pop()}
              </span>
            ) : (
              worktree.path.split('/').slice(-2).join('/')
            )}
          </div>
        ) : effectiveDensity === 'comfy' ? (
          <SubtitleDetail
            worktree={worktree}
            repoLabel={row.repoLabel}
            aliased={alias !== undefined}
            prStatus={prStatus}
            prefs={detailPrefs}
          />
        ) : null}
      </div>
      {effectiveDensity === 'compact' && !showPendingTool && !worktree.prunable && (
        <SubtitleDetail
          worktree={worktree}
          repoLabel={row.repoLabel}
          aliased={alias !== undefined}
          prStatus={prStatus}
          prefs={detailPrefs}
          inline
        />
      )}
      {touch ? (
        <TouchRowActions
          disabled={deleting || (rowActions.length === 0 && aliasActions.length === 0)}
          onOpen={() => setSheetOpen(true)}
        />
      ) : (
        <DesktopRowActions actions={rowActions} />
      )}
      {metaHeld && row.cmdOrdinal !== undefined && (
        <HotkeyBadge action={`worktree${row.cmdOrdinal}` as Action} variant="strong" className="shrink-0" />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuEntries.map((e) =>
            'separator' in e
              ? { separator: true as const }
              : { label: e.label, onClick: () => e.onSelect(), danger: e.tone === 'danger' }
          )}
          onClose={() => setMenu(null)}
        />
      )}
      {sheetOpen && (
        <WorktreeActionSheet
          title={alias ?? worktree.branch}
          subtitle={alias ? worktree.branch : undefined}
          actions={[...aliasActions, ...rowActions]}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  )
}

/** Hover-revealed icon buttons. Desktop only — there is no hover on touch. */
function DesktopRowActions({ actions }: { actions: WorktreeRowAction[] }): JSX.Element | null {
  if (actions.length === 0) return null
  return (
    <>
      {actions.map((action) => {
        const Icon = action.icon
        const hoverClass =
          action.tone === 'warning'
            ? 'text-warning hover:text-fg-bright'
            : action.tone === 'danger'
              ? 'text-faint hover:text-danger'
              : 'text-faint hover:text-accent'
        return (
          <Tooltip key={action.key} label={`${action.label}${action.tooltipExtra ?? ''}`} side="left">
            <button
              onClick={(e) => {
                e.stopPropagation()
                action.onSelect(e)
              }}
              className={`hidden group-hover:flex transition-colors shrink-0 cursor-pointer ${hoverClass}`}
            >
              <Icon className="icon-xs" />
            </button>
          </Tooltip>
        )
      })}
    </>
  )
}

/** Persistent overflow affordance. Opens the action sheet holding everything
 *  the desktop row hides behind hover + right-click. */
function TouchRowActions({
  disabled,
  onOpen
}: {
  disabled: boolean
  onOpen: () => void
}): JSX.Element | null {
  if (disabled) return null
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      aria-label="Worktree actions"
      className="shrink-0 inline-flex items-center justify-center w-11 h-11 -mr-2 rounded text-dim active:bg-surface"
    >
      <MoreHorizontal className="icon-base" />
    </button>
  )
}

function DetachedBadge({ branch }: { branch: string }): JSX.Element | null {
  const tip = detachedLikeTooltip(branch)
  if (!tip) return null
  return (
    <span className="shrink-0 inline-flex" title={tip} aria-label={tip}>
      <TriangleAlert className="icon-xs text-warning" />
    </span>
  )
}

/** Tooltips are a pointer affordance — tap-and-hold tooltips on touch are
 *  worse than no tooltip, so the touch variant renders the child bare. */
function RowTooltip({
  enabled,
  label,
  children
}: {
  enabled: boolean
  label: string
  children: ReactElement
}): ReactElement {
  if (!enabled) return children
  return (
    <Tooltip label={label} side="right">
      {children}
    </Tooltip>
  )
}

interface AliasEditorProps {
  initialValue: string
  onCommit: (value: string) => void
  onCancel: () => void
}

function AliasEditor({ initialValue, onCommit, onCancel }: AliasEditorProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <input
      ref={inputRef}
      value={value}
      maxLength={ALIAS_MAX_LEN}
      data-hotkeys="ignore"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(value)
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onCommit(value)}
      className="text-sm font-medium bg-surface border border-border-strong rounded px-1 py-0 w-full outline-none focus:border-accent"
    />
  )
}
