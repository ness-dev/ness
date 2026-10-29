import type { PRStatus } from '../shared/state/prs'
import { wrapAutomatedMessage } from '../shared/state/json-claude'

/** Compose the message injected into the agent chat for a conflicted PR —
 *  either because the user asked, or (`automatic`) because they opted into
 *  automatic conflict notifications. Off by default: a branch that conflicts
 *  with its base usually conflicts with every other in-flight branch too, so
 *  auto-firing can put the whole workspace to work over one bad merge base.
 *
 *  Deliberately doesn't enumerate the conflicted files. The local base ref
 *  is often stale, so a `git merge-tree` preview from here would name files
 *  the agent then finds clean — it has git and can see the real answer.
 *
 *  Names no strategy for the same reason: rebase-vs-merge is a per-repo
 *  convention the agent can read off `git log` and CLAUDE.md, and Ness has
 *  no setting that records it (`mergeStrategy` is how a PR lands on main,
 *  which says nothing about how a branch syncs with its base). */
export function buildMergeConflictMessage(pr: PRStatus, automatic = false): string {
  const body = [
    `PR #${pr.number} (${pr.branch}) has merge conflicts with ${pr.baseBranch}. Please resolve them.`,
    '',
    `Bring the branch up to date with the latest ${pr.baseBranch} — rebase or merge, whichever matches this repo's convention — and resolve each conflict. Verify the build still passes, then push so the PR updates (force-with-lease if you rebased).`,
    '',
    pr.url
  ].join('\n')
  return wrapAutomatedMessage(automatic ? 'merge-conflict-detected' : 'merge-conflict', body)
}
