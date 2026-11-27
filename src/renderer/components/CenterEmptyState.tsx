import type { JSX } from 'react'
import { Plus } from 'lucide-react'
import { bindingToString, formatBindingGlyphs, type HotkeyBinding } from '../hotkeys'

const secondaryButton =
  'inline-flex items-center justify-center gap-2 text-sm font-medium text-fg-bright px-4 py-2 rounded-lg border border-border-strong hover:bg-surface-hover transition-colors cursor-pointer'
const kbdChip = 'text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono'

/** What the center pane shows when no workspace is open. App selects a
 *  worktree whenever one exists (the tour's project first), so this is
 *  mostly the brief gap before a backend's rows land. */
export function CenterEmptyState({
  newWorktreeBinding,
  onNewWorktree
}: {
  newWorktreeBinding: HotkeyBinding | undefined
  onNewWorktree: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 text-center max-w-sm px-6">
      <div className="text-sm text-dim">Pick a project on the left, or start a new task</div>
      <button className={secondaryButton} onClick={onNewWorktree}>
        <Plus className="icon-sm" />
        New task
        {newWorktreeBinding && (
          <kbd className={kbdChip}>{formatBindingGlyphs(bindingToString(newWorktreeBinding), '')}</kbd>
        )}
      </button>
    </div>
  )
}
