// What tapping a project row in the worktree picker does.
//
// The picker keeps its own "focus": the worktree whose project is expanded.
// It starts at the active worktree and is fed to the shared
// applyProjectAccordion in place of the real selection, so the focused
// project expands while the others collapse (unless pinned open). The first
// tap on a project moves focus there and leaves the picker open, so the
// next tap can go straight to one of its worktrees. A tap on the project
// that's already focused opens its main checkout, as one tap used to.
//
// Per-client UI state: kept in the picker's useState, never a slice.

/** The bits of a WorktreeRepoSectionModel this logic reads. `holdsActive`
 *  is relative to the picker's focus, since that's what the accordion was
 *  given. */
export interface ProjectSectionLike {
  unified: boolean
  holdsActive: boolean
}

export type ProjectTap =
  | { kind: 'focus'; path: string }
  | { kind: 'open'; path: string }

export function projectTap(section: ProjectSectionLike, homePath: string): ProjectTap {
  // The merged "All repos" list never collapses, so there's nothing to
  // expand first. Open straight away.
  if (section.unified || section.holdsActive) return { kind: 'open', path: homePath }
  return { kind: 'focus', path: homePath }
}

export interface ProjectRowA11y {
  expanded: boolean | undefined
  hint: string
}

export function projectRowA11y(section: ProjectSectionLike & { collapsed: boolean }): ProjectRowA11y {
  if (section.unified) return { expanded: undefined, hint: 'Opens main' }
  if (section.holdsActive) return { expanded: !section.collapsed, hint: 'Double-tap again to open main' }
  return { expanded: !section.collapsed, hint: 'Shows its worktrees' }
}
