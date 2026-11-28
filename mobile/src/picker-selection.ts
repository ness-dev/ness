// What tapping a project row in the worktree picker does.
//
// The picker keeps its own "focus": the worktree whose project is expanded.
// It starts at the active worktree and is fed to the shared
// applyProjectAccordion in place of the real selection, so the focused
// project expands while the others collapse (unless pinned open).
//
// The rule follows what's on screen, not the hidden focus: tapping a
// collapsed project expands it (moves focus there) and leaves the picker
// open, so the next tap can go straight to one of its worktrees; tapping
// an expanded one opens its main checkout, as one tap used to. So a
// pinned-open project, or every project when nothing is active yet (the
// accordion collapses nothing then), opens on the first tap.
//
// Per-client UI state: kept in the picker's useState, never a slice.

/** The bits of a WorktreeRepoSectionModel this logic reads. */
export interface ProjectSectionLike {
  unified: boolean
  collapsed: boolean
}

export type ProjectTap =
  | { kind: 'focus'; path: string }
  | { kind: 'open'; path: string }

export function projectTap(section: ProjectSectionLike, homePath: string): ProjectTap {
  // The merged "All repos" list never collapses (collapsed is always false).
  if (!section.collapsed) return { kind: 'open', path: homePath }
  return { kind: 'focus', path: homePath }
}

export interface ProjectRowA11y {
  expanded: boolean | undefined
  hint: string
}

// Hints describe the result, not the gesture (VoiceOver users may be on
// Switch Control or Voice Control).
export function projectRowA11y(section: ProjectSectionLike): ProjectRowA11y {
  if (section.unified) return { expanded: undefined, hint: 'Opens main' }
  if (section.collapsed) return { expanded: false, hint: 'Shows its worktrees' }
  return { expanded: true, hint: 'Opens main' }
}
