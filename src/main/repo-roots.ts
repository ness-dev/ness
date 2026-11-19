import { realpathSync } from 'fs'
import type { Store } from './store'
import type { Config } from './persistence'
import { saveConfig } from './persistence'
import { loadRepoConfig, repoConfigFilename } from './repo-config'
import type { WorktreesFSM } from './worktrees-fsm'
import { resolveRepoPath } from './repo-resolve'
import {
  createNewProject,
  type CreateNewProjectOpts,
  type CreateNewProjectResult
} from './repo-create'
import type { AddRepoResult } from '../shared/repo-pick'

export interface RegisterRepoDeps {
  config: Config
  store: Store
  worktreesFSM: WorktreesFSM
}

/** Append a repo root to the app config, persist, and emit the store
 *  events sidebar / PR poller / repo-configs slice listen for.
 *  Idempotent — returns false if `repoRoot` was already registered, so
 *  callers can skip post-add work (focusing, refreshing) accordingly. */
export function registerRepoRoot(
  repoRoot: string,
  deps: RegisterRepoDeps
): boolean {
  if (deps.config.repoRoots.includes(repoRoot)) return false
  deps.config.repoRoots.push(repoRoot)
  saveConfig(deps.config)
  deps.worktreesFSM.dispatchRepos([...deps.config.repoRoots])
  deps.store.dispatch({
    type: 'repoConfigs/changed',
    payload: {
      repoRoot,
      config: loadRepoConfig(repoRoot),
      filename: repoConfigFilename(repoRoot)
    }
  })
  return true
}

/** Resolve a picked folder to its git toplevel and register it. Shared by
 *  the web client's `repo:addAtPath` and the MCP `add_repo` tool so the two
 *  can't drift. A repo that's already open still reports `added` — the
 *  caller wanted it in the sidebar and it is. */
export async function addRepoAtPath(
  picked: string,
  deps: RegisterRepoDeps
): Promise<AddRepoResult> {
  if (!picked || typeof picked !== 'string') {
    return { kind: 'not-a-repo', picked: picked || '' }
  }
  const resolution = await resolveRepoPath(picked)
  if (resolution.kind !== 'ok') return resolution
  const repoRoot = resolution.root
  if (registerRepoRoot(repoRoot, deps)) void deps.worktreesFSM.refreshList()
  return { kind: 'added', repoRoot }
}

/** `createNewProject` + register. Shared by `repo:createNewProject` (the
 *  New Project screen) and the MCP `create_project` tool. */
export async function createAndRegisterProject(
  opts: CreateNewProjectOpts,
  deps: RegisterRepoDeps
): Promise<CreateNewProjectResult> {
  const result = await createNewProject(opts)
  if ('error' in result) return result
  // Canonical form, as resolveRepoPath stores it: `git worktree list`
  // reports realpaths, and a `/tmp` → `/private/tmp` mismatch breaks the
  // isMain match in listWorktrees.
  let repoRoot = result.path
  try { repoRoot = realpathSync(repoRoot) } catch {}
  if (registerRepoRoot(repoRoot, deps)) void deps.worktreesFSM.refreshList()
  return { path: repoRoot }
}
