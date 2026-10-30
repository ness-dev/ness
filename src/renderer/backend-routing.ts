// Backend access that can't be pointed at the wrong machine.
//
// App.tsx renders ABOVE every `BackendScope`, so `useBackend()` there
// resolves to the ACTIVE backend — whichever chip is selected — not the
// backend hosting the worktree being operated on. With one backend those
// are the same thing, so the mistake is invisible until a remote worktree
// exists, and then it fails in ways that look like unrelated UI bugs:
// a tab that appears in the sidebar but not the workspace, tab switching
// that silently does nothing, panes that never initialize.
//
// That trap was hit four separate times in this worktree's history
// (panesEnsureInitialized, the stale-focus guard, the panes map, and the
// whole tab-handler family). Each was found by a human using the app, not
// by a test — so rather than fix a fifth instance later, the ambient
// handle App gets simply no longer HAS the worktree-scoped methods on it.
// Reaching for one is a compile error that names the method.
//
// The scoped list is derived from ElectronAPI: every method whose first
// parameter is a worktree path/cwd, plus the whole `panes*` family. A new
// method matching that shape must be added here — if it isn't, the
// guardrail silently stops covering it, which is the one failure mode
// this file has.

import { useCallback, useRef } from 'react'
import type { ElectronAPI } from './types'
import { getBackendFor, useBackend } from './backend'

/** Methods that act on one worktree and therefore must be routed to the
 *  backend hosting it.
 *
 *  Deliberately NOT included, though they also take a repo path:
 *  `addRepo` / `addRepoAtPath` / `removeRepo` attach or detach a repo to
 *  whichever backend the user currently has selected — the active backend
 *  is the correct target, not a lookup.
 *
 *  Several entries take an object or an id rather than a path, so the
 *  first-parameter heuristic can't see them and they're listed by hand:
 *  creation (`runPending*`) targets a repo that lives on one machine, the
 *  pending entry it produces lives there too (`retryPending` /
 *  `dismissPendingWorktree`), and `pruneWorktrees` acts on an existing
 *  repo. All route via the repo or pending owner maps. */
export type WorktreeScopedMethod =
  | 'addReviewComment'
  | 'addReviewReply'
  | 'agentSessionFileExists'
  | 'approvePR'
  | 'clearActivityLog'
  | 'clearAlias'
  | 'continueWorktree'
  | 'dismissPendingWorktree'
  | 'deleteReviewComment'
  | 'dismissPendingDeletion'
  | 'getBranchCommits'
  | 'getChangedFiles'
  | 'getCommitChangedFiles'
  | 'getCommitDiff'
  | 'getCommitFileDiffSides'
  | 'getCommitMeta'
  | 'getCommitRangeChangedFiles'
  | 'getCommitRangeFileDiffSides'
  | 'getFileDiff'
  | 'getFileDiffSides'
  | 'getLatestAgentSessionId'
  | 'isWorktreeDirty'
  | 'listAllFiles'
  | 'listDir'
  | 'listRecentCommitShas'
  | 'listTools'
  | 'mergePR'
  | 'openInEditor'
  | 'openJsonClaudeAuthLoginTab'
  | 'openPath'
  | 'panesAddTab'
  | 'panesClearForWorktree'
  | 'panesCloseTab'
  | 'panesConvertTabType'
  | 'panesEnsureInitialized'
  | 'panesMoveTabToPane'
  | 'panesOpenFile'
  | 'panesOpenReview'
  | 'panesRenameTab'
  | 'panesReorderTabs'
  | 'panesRestartAgentTab'
  | 'panesSelectTab'
  | 'panesSetRatio'
  | 'panesSetReviewSelection'
  | 'panesSleepTab'
  | 'panesSplitPane'
  | 'panesWakeTab'
  | 'pinWorktree'
  | 'pruneWorktrees'
  | 'readJsonClaudeAttachmentImage'
  | 'readWorktreeFile'
  | 'readWorktreeFileBinary'
  | 'refreshPRsOne'
  | 'refreshPRsOneIfStale'
  | 'refreshReviewAnchors'
  | 'removeWorktree'
  | 'requestMergeConflictFix'
  | 'retryPendingWorktree'
  | 'runPendingPRWorktree'
  | 'runPendingWorktree'
  | 'runTool'
  | 'setAlias'
  | 'setCiNotifyOverride'
  | 'setReviewCommentStatus'
  | 'setScratchpadText'
  | 'setWorktreeEditor'
  | 'snooze'
  | 'touchWorktreeLastActive'
  | 'unpinWorktree'
  | 'unsnooze'
  | 'unwatchChangedFiles'
  | 'unwatchFile'
  | 'watchChangedFiles'
  | 'watchFile'
  | 'writeWorktreeFile'

/** The API minus everything worktree-scoped. What App-level chrome gets:
 *  settings, menu signals, announcements, connections — things that
 *  genuinely belong to the active backend or the client itself. */
export type GlobalBackend = Omit<ElectronAPI, WorktreeScopedMethod>

/** Non-worktree backend access for components above every BackendScope.
 *  Same object `useBackend()` returns, narrowed so a worktree-scoped call
 *  won't compile. */
export function useGlobalBackend(): GlobalBackend {
  return useBackend()
}

/** Resolves the full API for the backend that owns `worktreePath`.
 *
 *  The owner map is read through a ref so the returned function's identity
 *  never changes: callers pass it to `useCallback` dependency arrays, and
 *  a memoized-on-the-map version would require every one of those arrays
 *  to list it — miss one and that handler routes by a stale map, which
 *  only shows up when a backend is added or removed mid-session. */
export function useBackendForWorktree(
  pathBackendId: Record<string, string>
): (worktreePath: string) => ElectronAPI {
  return useBackendResolver(pathBackendId)
}

/** Resolves the backend owning a repo root. A repo lives on exactly one
 *  machine, so for operations that take a repo rather than a worktree —
 *  creating a worktree, most obviously — the repo IS the routing key. */
export function useBackendForRepo(
  repoBackendId: Record<string, string>
): (repoRoot: string) => ElectronAPI {
  return useBackendResolver(repoBackendId)
}

/** Shared implementation. See the identity-stability note above. */
function useBackendResolver(
  ownerById: Record<string, string>
): (key: string) => ElectronAPI {
  const ref = useRef(ownerById)
  ref.current = ownerById
  return useCallback((key: string) => getBackendFor(ref.current[key] ?? null), [])
}
