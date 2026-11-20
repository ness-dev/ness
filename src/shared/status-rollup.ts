import type { PtyStatus } from './state/terminals'

/** Rank for rolling a worktree's tab statuses up to one display dot (sidebar,
 *  CommandCenter, palette, subscription graph). Needs-approval wins because
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
