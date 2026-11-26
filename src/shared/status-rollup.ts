import type { PtyStatus } from './state/terminals'

/** Rank for rolling a worktree's tab statuses up to one display dot (sidebar,
 *  palette, subscription graph). Needs-approval wins because
 *  the user must act. Otherwise any working tab makes the worktree read as
 *  working, which deliberately masks a waiting tab beside it: a chat waiting
 *  on its reviewer isn't waiting on the user. `main/activity-deriver.ts`
 *  ranks differently on purpose; see the comment there. */
export const ROLLUP_STATUS_RANK: Record<PtyStatus, number> = {
  idle: 0,
  waiting: 1,
  processing: 2,
  'needs-approval': 3
}

/** Rank for rolling ALREADY-rolled-up worktree statuses up to a project
 *  (a collapsed project's icon dot). Here waiting beats processing: the
 *  masking above is about one task's tabs, but across worktrees a working
 *  agent in A says nothing about B waiting on the user, and surfacing B is
 *  the whole point of the dot. Each worktree still arrives pre-rolled by
 *  ROLLUP_STATUS_RANK, so a chat waiting on its own reviewer reads as
 *  processing before it gets here. */
export const ATTENTION_STATUS_RANK: Record<PtyStatus, number> = {
  idle: 0,
  processing: 1,
  waiting: 2,
  'needs-approval': 3
}
