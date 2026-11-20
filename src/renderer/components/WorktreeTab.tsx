import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { GitPullRequest, Loader2, TriangleAlert, Ghost, MoreHorizontal, Pin } from 'lucide-react'
import type { PtyStatus, SidebarDetailPrefs } from '../types'
import { Tooltip } from './Tooltip'
import { RepoIcon, repoNameColor } from './RepoIcon'
import { SubtitleDetail } from './WorktreeSubtitleDetail'
import { formatPendingTool } from '../pending-tool'
import { HotkeyBadge } from './HotkeyBadge'
import type { Action } from '../hotkeys'
import { ContextMenu, type ContextMenuEntry, type ContextMenuSubItem } from './ContextMenu'
import { useBackend } from '../backend'
import { useAvailableEditors } from '../hooks/useAvailableEditors'
import { useEditorOverrideScope, useResolvedEditorId } from '../store'
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
  /** Backend label when this worktree is hosted elsewhere. */
  originLabel?: string
  actions: WorktreeRowActionHandlers
  onSelect: (path: string) => void
  onStartAliasEdit: (path: string) => void
  onEndAliasEdit: () => void
  /** Render this (main) worktree as its project's row: clicking the project
   *  opens its main workspace. Not reference-stable, but only one row per
   *  project carries it. */
  project?: ProjectRowProps
}

export interface ProjectRowProps {
  name: string
  collapsed?: boolean
  /** Worktree count, shown beside the name while collapsed. */
  count?: number
  /** Kept expanded even when you're working elsewhere. */
  pinnedOpen?: boolean
  /** Set only while collapsed: the project's most urgent status, shown on
   *  the icon dot in place of main's own. */
  collapsedStatus?: PtyStatus
  /** Absent in unified mode, where projects don't collapse individually. */
  onTogglePinnedOpen?: () => void
  /** Project-level actions (graph, remove, new worktree). Desktop shows
   *  them as hover icons, or in the right-click menu when `menuOnly`;
   *  touch lists them all in the action sheet. */
  actions?: WorktreeRowAction[]
}

/** Memoized: switching worktrees re-renders the list, and every prop here is
 *  kept reference-stable so only the two rows whose `isActive` flipped
 *  re-render. */
export const WorktreeTab = memo(function WorktreeTab({
  row,
  variant,
  isActive,
  metaHeld,
  density,
  detailPrefs,
  isEditingAlias,
  originLabel,
  actions,
  onSelect,
  onStartAliasEdit: onStartAliasEditForPath,
  onEndAliasEdit,
  project
}: WorktreeTabProps): JSX.Element {
  const onStartAliasEdit = (): void => onStartAliasEditForPath(row.path)
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

  // Editor submenu. Every sidebar row mounts this component, so all three
  // hooks are gated on the menu actually being open — a closed row passes
  // null and the selectors short-circuit instead of re-resolving on every
  // store event. repoRoot is handed over directly so neither selector has
  // to scan worktrees.list.
  const menuOpen = menu !== null
  const editors = useAvailableEditors(menuOpen)
  const editorPath = menuOpen ? worktree.path : null
  const activeEditorId = useResolvedEditorId(editorPath, worktree.repoRoot)
  const editorScope = useEditorOverrideScope(editorPath, worktree.repoRoot)
  const editorSubmenu: ContextMenuSubItem[] = menuOpen
    ? [
        ...editors.map((ed) => ({
          label: ed.name,
          checked: ed.id === activeEditorId,
          onClick: () => {
            // Await the override before launching: openInEditor resolves the
            // chain main-side, so firing both at once can race and open the
            // editor this worktree was pinned to a moment ago.
            void backend
              .setWorktreeEditor(worktree.path, ed.id)
              .then(() => backend.openInEditor(worktree.path))
          }
        })),
        {
          label:
            editorScope === 'worktree'
              ? 'Clear override'
              : editorScope === 'repo'
                ? 'Using repo default'
                : 'Using global default',
          disabled: editorScope !== 'worktree',
          onClick: () => void backend.setWorktreeEditor(worktree.path, null)
        }
      ]
    : []

  // `buildRowMenuEntries` owns the ordering, so "Open in" is spliced into the
  // everyday run ahead of the divider rather than appended — appending would
  // strand it below "Remove worktree" on the destructive side of the rule.
  const mappedEntries: ContextMenuEntry[] = menuEntries.map((e) =>
    'separator' in e
      ? { separator: true as const }
      : { label: e.label, onClick: () => e.onSelect(), danger: e.tone === 'danger' }
  )
  const dividerAt = mappedEntries.findIndex((e) => 'separator' in e)
  const openIn = { label: 'Open in', submenu: editorSubmenu }
  const worktreeMenu: ContextMenuEntry[] =
    dividerAt === -1
      ? [...mappedEntries, openIn]
      : [...mappedEntries.slice(0, dividerAt), openIn, ...mappedEntries.slice(dividerAt)]
  // Project-level menu actions follow the worktree's own; destructive ones
  // go below a rule, like "Remove worktree" does.
  const projectMenu = project?.actions?.filter((a) => a.menuOnly) ?? []
  const toEntry = (a: WorktreeRowAction): ContextMenuEntry => ({
    label: a.label,
    onClick: () => a.onSelect(),
    danger: a.tone === 'danger'
  })
  const projectSafe = projectMenu.filter((a) => a.tone !== 'danger').map(toEntry)
  const projectDanger = projectMenu.filter((a) => a.tone === 'danger').map(toEntry)
  const menuItems: ContextMenuEntry[] = [
    ...worktreeMenu,
    ...projectSafe,
    ...(projectDanger.length > 0 ? [{ separator: true as const }, ...projectDanger] : [])
  ]

  const onContextMenu = touch
    ? undefined
    : (e: ReactMouseEvent) => {
        if (deleting) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }
  const overlays = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {sheetOpen && (
        <WorktreeActionSheet
          title={alias ?? (project ? project.name : worktree.branch)}
          subtitle={alias || project ? worktree.branch : undefined}
          actions={[...(project?.actions ?? []), ...aliasActions, ...rowActions]}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </>
  )

  if (row.home && project) {
    const home = row.home
    const title = metaHeld ? displayLabel(worktree, alias, metaHeld) : (alias ?? project.name)
    // Collapsed, the dot speaks for the whole project so an agent waiting on
    // you there isn't hidden; open, its worktrees show their own dots.
    const dotStatus = project.collapsedStatus ?? displayStatus
    return (
      <div
        onClick={() => onSelect(row.path)}
        onContextMenu={onContextMenu}
        className={`group flex items-center gap-2.5 px-2 transition-colors cursor-pointer ${
          // Fixed height whether or not the pending-tool line shows, so the
          // title sits centred and rows don't jump when main asks for approval.
          touch ? 'min-h-14 py-2.5' : 'min-h-14 py-2'
        } ${isActive ? 'bg-surface text-fg-bright' : 'text-fg hover:bg-panel-raised'}`}
      >
        <span className="relative shrink-0 inline-flex">
          <RepoIcon repoName={project.name} className="text-2xl" />
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-panel ${STATUS_COLORS[dotStatus]}`}
            title={project.collapsedStatus ? `Most urgent in ${project.name}: ${STATUS_LABELS[dotStatus]}` : STATUS_LABELS[dotStatus]}
          />
        </span>
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
            <RowTooltip enabled={!touch} label={`${PROJECT_HOME_HINT} · ${worktree.branch}`}>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-base font-semibold truncate text-fg-bright">{title}</span>
                {project.collapsed && project.count !== undefined && project.count > 0 && (
                  <span className="shrink-0 text-xs text-faint">{project.count}</span>
                )}
                {home.showBranch && (
                  <span className="shrink-0 max-w-[50%] truncate rounded bg-surface px-1 text-xs text-dim font-mono">
                    {worktree.branch}
                  </span>
                )}
                {prStatus && (
                  <span className="shrink-0 inline-flex" title={prIconTitle(prStatus)}>
                    <GitPullRequest className={`icon-xs ${iconColor}`} />
                  </span>
                )}
                {shellActive && (
                  <Loader2 className="icon-xs animate-spin text-fg-bright shrink-0" aria-label="Shell activity" />
                )}
              </div>
            </RowTooltip>
          )}
          {showPendingTool && (
            <div className="text-xs text-danger truncate font-mono" title={formatPendingTool(pendingTool!)}>
              {formatPendingTool(pendingTool!)}
            </div>
          )}
        </div>
        {/* Desktop: "+" appears on hover, out of layout until then so the
            status line keeps the full width; graph and remove live in the
            right-click menu. Touch: everything goes in the action sheet. */}
        {touch ? (
          <TouchRowActions
            disabled={
              deleting ||
              ((project.actions?.length ?? 0) === 0 && rowActions.length === 0 && aliasActions.length === 0)
            }
            onOpen={() => setSheetOpen(true)}
          />
        ) : (
          <DesktopRowActions actions={[...rowActions, ...(project.actions ?? []).filter((a) => !a.menuOnly)]} />
        )}
        {metaHeld && row.cmdOrdinal !== undefined && (
          <HotkeyBadge action={`worktree${row.cmdOrdinal}` as Action} variant="strong" className="shrink-0" />
        )}
        {/* Opening a project is just clicking it; this keeps it open while
            you work elsewhere. Shown on hover, or always once pinned so the
            state is visible at rest. */}
        {project.onTogglePinnedOpen && (
          <Tooltip label={project.pinnedOpen ? 'Stop keeping open' : 'Keep open'} side="left">
            <button
              onClick={(e) => {
                e.stopPropagation()
                project.onTogglePinnedOpen!()
              }}
              aria-label={project.pinnedOpen ? `Stop keeping ${project.name} open` : `Keep ${project.name} open`}
              aria-pressed={project.pinnedOpen ?? false}
              className={`shrink-0 items-center justify-center cursor-pointer ${
                project.pinnedOpen ? 'text-accent hover:text-fg' : 'text-faint hover:text-fg'
              } ${
                touch
                  ? 'inline-flex w-11 h-11 -mr-2'
                  : `p-0.5 ${project.pinnedOpen ? 'inline-flex' : 'hidden group-hover:inline-flex'}`
              }`}
            >
              {project.pinnedOpen ? <Pin className="icon-xs fill-current" /> : <Pin className="icon-xs" />}
            </button>
          </Tooltip>
        )}
        {overlays}
      </div>
    )
  }

  return (
    <div
      onClick={() => onSelect(row.path)}
      onContextMenu={onContextMenu}
      className={`group w-full px-2 text-left flex items-center gap-2 transition-colors cursor-pointer ${
        touch ? 'min-h-11 py-3' : 'py-2'
      } ${deleting ? 'opacity-60 italic' : ''} ${
        isActive ? 'text-fg-bright' : 'text-muted hover:bg-panel-raised hover:text-fg'
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
          <div className={`text-xs truncate ${isActive ? 'text-muted' : 'text-faint'}`}>
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
            originLabel={originLabel}
            aliased={alias !== undefined}
            prStatus={prStatus}
            prefs={detailPrefs}
            active={isActive}
          />
        ) : null}
      </div>
      {effectiveDensity === 'compact' && !showPendingTool && !worktree.prunable && (
        <SubtitleDetail
          worktree={worktree}
          repoLabel={row.repoLabel}
          originLabel={originLabel}
          aliased={alias !== undefined}
          prStatus={prStatus}
          prefs={detailPrefs}
          active={isActive}
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
      {overlays}
    </div>
  )
})

/** Tooltip for a project row — the main checkout is where work gets
 *  planned before it's spun off into worktrees. */
export const PROJECT_HOME_HINT = 'Main workspace'

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
          <Tooltip
            key={action.key}
            label={`${action.label}${action.tooltipExtra ?? ''}`}
            action={action.hotkey}
            side="left"
          >
            <button
              aria-label={action.label}
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
