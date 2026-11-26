// Contract every ported right-column panel implements. Mirrors the props
// RightColumn.tsx hands its panels, minus desktop-only affordances (open a
// diff/file tab, open in editor), which have no phone equivalent yet.
import type { ComponentType } from 'react'
import type { Worktree } from '../../../src/shared/state/worktrees'
import type { RepoConfig } from '../../../src/shared/state/repo-configs'
import type { NessClient } from '../ness'

export interface PanelProps {
  /** Backend that owns `worktreePath`. Every request goes through it. */
  client: NessClient
  worktree: Worktree | null
  worktreePath: string | null
  /** The tab the phone has selected in this worktree (the desktop passes
   *  the focused pane's tab). Todos/Agents/Context/Subscriptions read the
   *  json-claude session with this id. */
  focusedTabId: string | null
  repoConfig: RepoConfig | null
  /** Same routing as the desktop's handleSendToAgent: selected tab if it's
   *  an agent/chat, else the pane's active one, else the first; switches
   *  the phone to that tab and closes the panel sheet. */
  onSendToAgent: (text: string) => void
  /** Opens a URL in the system browser (PR links, check runs). */
  onOpenUrl: (url: string) => void
  /** Close the panel sheet (e.g. after "remove worktree"). */
  onClose: () => void
}

export type PanelComponent = ComponentType<PanelProps>
