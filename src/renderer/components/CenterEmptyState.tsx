import { useState, type JSX } from 'react'
import { FolderOpen, Loader2, Plus, Sparkles } from 'lucide-react'
import { bindingToString, formatBindingGlyphs, type HotkeyBinding } from '../hotkeys'

const primaryButton =
  'inline-flex items-center justify-center gap-2 brand-gradient-bg text-white font-semibold text-sm px-4 py-2 rounded-lg hover:brightness-110 transition-all cursor-pointer disabled:opacity-70 disabled:cursor-default'
const secondaryButton =
  'inline-flex items-center justify-center gap-2 text-sm font-medium text-fg-bright px-4 py-2 rounded-lg border border-border-strong hover:bg-surface-hover transition-colors cursor-pointer'
const kbdChip = 'text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono'

/** What the center pane shows when no workspace is open. While the
 *  first-run tour is on its `home` step the copy agrees with the popout and
 *  offers the same action, so the two never contradict each other. */
export function CenterEmptyState({
  mode,
  newWorktreeBinding,
  onTourStart,
  onNewWorktree,
  onAddRepo
}: {
  mode: 'tour-home' | 'no-selection' | 'no-repos'
  newWorktreeBinding: HotkeyBinding | undefined
  onTourStart: () => Promise<void>
  onNewWorktree: () => void
  onAddRepo: () => void
}): JSX.Element {
  const [starting, setStarting] = useState(false)

  if (mode === 'tour-home') {
    return (
      <div className="flex flex-col items-center gap-4 text-center max-w-sm px-6">
        <Sparkles className="icon-xl text-accent" />
        <div className="text-base text-fg-bright font-medium">Your project is ready</div>
        <div className="text-sm text-dim">
          Start something new and an agent will set up a workspace for it.
        </div>
        <button
          className={primaryButton}
          disabled={starting}
          onClick={() => {
            setStarting(true)
            void onTourStart().finally(() => setStarting(false))
          }}
        >
          {starting && <Loader2 className="icon-sm animate-spin" />}
          Start something new
        </button>
      </div>
    )
  }

  if (mode === 'no-repos') {
    return (
      <div className="flex flex-col items-center gap-4 text-center max-w-sm px-6">
        <div className="text-sm text-dim">Add a project to get started</div>
        <button className={secondaryButton} onClick={onAddRepo}>
          <FolderOpen className="icon-sm" />
          Open Repository
        </button>
      </div>
    )
  }

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
