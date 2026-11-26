import type { JSX } from 'react'
import { Plus, Sparkles } from 'lucide-react'
import { bindingToString, formatBindingGlyphs, type HotkeyBinding } from '../hotkeys'
import { TourStartButton } from './FirstRunTour'

const secondaryButton =
  'inline-flex items-center justify-center gap-2 text-sm font-medium text-fg-bright px-4 py-2 rounded-lg border border-border-strong hover:bg-surface-hover transition-colors cursor-pointer'
const kbdChip = 'text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono'

export type CenterEmptyMode = 'tour-home' | 'no-selection'

/** No zero-repo mode: with no repos the welcome wizard owns the screen, and
 *  repos whose worktree rows haven't landed yet (boot, a remote still
 *  connecting, a missing repo dir) still have a project to pick. */
export function centerEmptyMode({
  onboardingVisible,
  tourHomePath
}: {
  onboardingVisible: boolean
  tourHomePath: string | null
}): CenterEmptyMode {
  return !onboardingVisible && tourHomePath ? 'tour-home' : 'no-selection'
}

/** What the center pane shows when no workspace is open. While the
 *  first-run tour is on its `home` step the copy agrees with the popout and
 *  offers the same action, so the two never contradict each other. */
export function CenterEmptyState({
  mode,
  newWorktreeBinding,
  onTourStart,
  onNewWorktree
}: {
  mode: CenterEmptyMode
  newWorktreeBinding: HotkeyBinding | undefined
  onTourStart: () => Promise<void>
  onNewWorktree: () => void
}): JSX.Element {
  if (mode === 'tour-home') {
    return (
      <div className="flex flex-col items-center gap-4 text-center max-w-sm px-6">
        <Sparkles className="icon-xl text-accent" />
        <div className="text-base text-fg-bright font-medium">Your project is ready</div>
        <div className="text-sm text-dim">
          Start something new and an agent will set up a workspace for it.
        </div>
        <TourStartButton onStart={onTourStart} />
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
