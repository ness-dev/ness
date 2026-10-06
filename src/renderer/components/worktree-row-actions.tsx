import type { ComponentType, MouseEvent } from 'react'
import { RotateCw, Moon, AlarmClock, Trash2, Tag, X, Pin, PinOff } from 'lucide-react'
import { isPRMerged } from '../../shared/state/prs'
import { formatWakeAt } from '../../shared/state/snooze'
import type { WorktreeRowModel } from '../worktree-list-model'

/** One thing the user can do to a worktree row. Desktop renders these as
 *  hover-revealed icon buttons; touch renders the same list as an action
 *  sheet. Deriving them once keeps the two surfaces from offering different
 *  action sets. */
export interface WorktreeRowAction {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  tone?: 'accent' | 'warning' | 'danger'
  /** Extra text appended to the desktop tooltip only — usually a modifier
   *  hint that means nothing on touch. */
  tooltipExtra?: string
  /** The event is only supplied by surfaces that have one to give — the
   *  desktop icon buttons pass it so snooze can branch on altKey. Sheet and
   *  context-menu callers invoke bare. */
  onSelect: (e?: MouseEvent) => void
}

export interface WorktreeRowActionHandlers {
  onContinue?: () => void
  /** Receives the event so the desktop caller can branch on altKey to open
   *  the date picker instead of snoozing for the default duration. */
  onSnooze?: (e?: MouseEvent) => void
  onUnsnooze?: () => void
  onPrune?: () => void
  onDelete?: () => void
  onTogglePin?: () => void
}

export interface WorktreeAliasActionHandlers {
  onEditAlias: () => void
  onClearAlias: () => void
}

/** Continue / snooze / prune / delete, filtered to what actually applies to
 *  this row. Mirrors the conditions the desktop sidebar used inline. */
export function buildRowActions(
  row: WorktreeRowModel,
  handlers: WorktreeRowActionHandlers
): WorktreeRowAction[] {
  const actions: WorktreeRowAction[] = []
  const { worktree } = row

  if (handlers.onContinue && isPRMerged(row.prStatus)) {
    actions.push({
      key: 'continue',
      label: 'Continue on a new branch off main',
      icon: RotateCw,
      tone: 'accent',
      onSelect: () => handlers.onContinue!()
    })
  }

  actions.push(...buildPinActions(row, handlers))

  actions.push(...buildSnoozeActions(row, handlers))
  actions.push(...buildDestructiveActions(row, handlers))

  return actions
}

/** Snooze / wake. Never offered for the main worktree — it has no lifecycle
 *  of its own to pause. */
export function buildSnoozeActions(
  row: WorktreeRowModel,
  handlers: Pick<WorktreeRowActionHandlers, 'onSnooze' | 'onUnsnooze'>
): WorktreeRowAction[] {
  if (!handlers.onSnooze && !handlers.onUnsnooze) return []
  if (row.worktree.isMain) return []
  if (row.isSnoozed) {
    return [
      {
        key: 'unsnooze',
        label:
          typeof row.snoozeWakeAt === 'number'
            ? `Wakes ${formatWakeAt(row.snoozeWakeAt)} — tap to wake up`
            : 'Wake up',
        icon: AlarmClock,
        tone: 'accent',
        onSelect: () => handlers.onUnsnooze?.()
      }
    ]
  }
  return [
    {
      key: 'snooze',
      label: 'Snooze',
      icon: Moon,
      tone: 'accent',
      tooltipExtra: ' (⌥-click to pick a date)',
      onSelect: (e) => handlers.onSnooze?.(e)
    }
  ]
}

/** Prune / remove — the irreversible ones. Mutually exclusive: a prunable
 *  worktree is already gone from disk, so it gets prune instead of remove. */
export function buildDestructiveActions(
  row: WorktreeRowModel,
  handlers: Pick<WorktreeRowActionHandlers, 'onPrune' | 'onDelete'>
): WorktreeRowAction[] {
  const { worktree } = row
  if (handlers.onPrune && worktree.prunable) {
    return [
      {
        key: 'prune',
        label: 'Prune stale worktree (git worktree prune)',
        icon: Trash2,
        tone: 'warning',
        onSelect: () => handlers.onPrune!()
      }
    ]
  }
  if (handlers.onDelete && !worktree.prunable) {
    return [
      {
        key: 'delete',
        label: 'Remove worktree',
        icon: Trash2,
        tone: 'danger',
        onSelect: () => handlers.onDelete!()
      }
    ]
  }
  return []
}

/** Alias edit / clear. Desktop surfaces these through the right-click context
 *  menu; touch folds them into the same action sheet as everything else. */
export function buildAliasActions(
  row: WorktreeRowModel,
  handlers: WorktreeAliasActionHandlers
): WorktreeRowAction[] {
  const hasAlias = row.alias !== undefined
  const actions: WorktreeRowAction[] = [
    {
      key: 'alias-edit',
      label: hasAlias ? 'Rename Alias…' : 'Alias Worktree…',
      icon: Tag,
      onSelect: () => handlers.onEditAlias()
    }
  ]
  if (hasAlias) {
    actions.push({
      key: 'alias-clear',
      label: 'Clear Alias',
      icon: X,
      onSelect: () => handlers.onClearAlias()
    })
  }
  return actions
}

/** Pin / unpin. Unlike the other row actions this is also fed to the desktop
 *  right-click menu, so pinning is reachable without hunting for the hover
 *  icon. Available on every worktree including main — pinning is an
 *  organisational choice, not a lifecycle action. */
export function buildPinActions(
  row: WorktreeRowModel,
  handlers: Pick<WorktreeRowActionHandlers, 'onTogglePin'>
): WorktreeRowAction[] {
  if (!handlers.onTogglePin) return []
  return [
    row.isPinned
      ? {
          key: 'unpin',
          label: 'Unpin Worktree',
          icon: PinOff,
          tone: 'accent',
          onSelect: () => handlers.onTogglePin!()
        }
      : {
          key: 'pin',
          label: 'Pin Worktree',
          icon: Pin,
          tone: 'accent',
          onSelect: () => handlers.onTogglePin!()
        }
  ]
}

/** A divider between two runs of menu entries. */
export interface WorktreeMenuSeparator {
  separator: true
}

export type WorktreeMenuEntry = WorktreeRowAction | WorktreeMenuSeparator

/** The desktop right-click menu: pin, snooze and alias, then the
 *  irreversible actions fenced off below a divider. Deliberately narrower
 *  than `buildRowActions` — "continue on a new branch" stays a hover icon,
 *  because it opens an inline form rather than acting immediately.
 *
 *  The divider is only emitted when there is something on both sides of it,
 *  so a row with nothing destructive to offer doesn't end in a stray rule. */
export function buildRowMenuEntries(
  row: WorktreeRowModel,
  handlers: WorktreeRowActionHandlers,
  aliasHandlers: WorktreeAliasActionHandlers
): WorktreeMenuEntry[] {
  const primary = [
    ...buildPinActions(row, handlers),
    ...buildSnoozeActions(row, handlers),
    ...buildAliasActions(row, aliasHandlers)
  ]
  const destructive = buildDestructiveActions(row, handlers)
  if (primary.length === 0) return destructive
  if (destructive.length === 0) return primary
  return [...primary, { separator: true }, ...destructive]
}
