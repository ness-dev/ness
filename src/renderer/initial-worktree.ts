import type { TourStep } from '../shared/state/onboarding'

/** Which worktree to open when nothing is selected yet (a fresh install
 *  mounts with an empty list). Prefers the tour's project, which is the row
 *  popout 1 points at, else the first row.
 *
 *  `null` means wait. Only while the tour is still `eligible` and its own
 *  backend already has rows: main starts the tour from that backend's
 *  `reposChanged`, so this is the brief gap before `home` lands. The tour
 *  is per backend while the list is merged, so rows that only come from
 *  other backends (a remote connected before any local repo) never wait. */
export function pickInitialWorktree({
  tourStep,
  tourHomePath,
  worktreePaths,
  tourBackendHasRows
}: {
  tourStep: TourStep
  tourHomePath: string | null
  worktreePaths: string[]
  tourBackendHasRows: boolean
}): string | null {
  if (tourStep === 'eligible' && tourBackendHasRows) return null
  return tourHomePath ?? worktreePaths[0] ?? null
}
