import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { log } from './debug'
import {
  DEFAULT_HIDDEN_RIGHT_PANELS,
  REPO_CONFIG_FILENAME,
  LEGACY_REPO_CONFIG_FILENAME,
  type RepoConfig
} from '../shared/state/repo-configs'

export type { RepoConfig }

// Repo config was `.harness.json` before the product became Ness. Both
// names are read; only brand-new files get the new one. An existing
// `.harness.json` is usually committed and shared with teammates, so
// silently renaming it on the next write would show up as a rename in
// everyone's git status for a change they didn't make.
const cache = new Map<string, RepoConfig>()

/** The config file this repo actually uses: the new name if present or if
 *  the repo has no config yet, otherwise the legacy one it already has. */
export function repoConfigFilename(repoRoot: string): string {
  if (!repoRoot) return REPO_CONFIG_FILENAME
  if (existsSync(join(repoRoot, REPO_CONFIG_FILENAME))) return REPO_CONFIG_FILENAME
  if (existsSync(join(repoRoot, LEGACY_REPO_CONFIG_FILENAME))) return LEGACY_REPO_CONFIG_FILENAME
  return REPO_CONFIG_FILENAME
}

function configPath(repoRoot: string): string {
  return join(repoRoot, repoConfigFilename(repoRoot))
}

export function loadRepoConfig(repoRoot: string): RepoConfig {
  if (!repoRoot) return {}
  const cached = cache.get(repoRoot)
  if (cached) return cached
  const path = configPath(repoRoot)
  if (!existsSync(path)) {
    cache.set(repoRoot, {})
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RepoConfig
    const clean = parsed && typeof parsed === 'object' ? parsed : {}
    cache.set(repoRoot, clean)
    return clean
  } catch (err) {
    log('repo-config', `failed to load ${path}: ${(err as Error).message}`)
    cache.set(repoRoot, {})
    return {}
  }
}

export function saveRepoConfig(repoRoot: string, next: RepoConfig): RepoConfig {
  const cleaned: RepoConfig = { version: 1 }
  const setup = next.setupCommand?.trim()
  const teardown = next.teardownCommand?.trim()
  if (setup) cleaned.setupCommand = setup
  if (teardown) cleaned.teardownCommand = teardown
  if (next.mergeStrategy) cleaned.mergeStrategy = next.mergeStrategy
  // Migrate legacy hideMergePanel / hidePrPanel into hiddenRightPanels
  // on write. Only the new field is persisted going forward.
  const hidden: Record<string, boolean | undefined> = { ...(next.hiddenRightPanels || {}) }
  if (next.hideMergePanel && hidden.merge === undefined) hidden.merge = true
  if (next.hidePrPanel && hidden.pr === undefined) hidden.pr = true
  // Compact: drop `false` entries that match the default visibility
  // (i.e. NOT in DEFAULT_HIDDEN_RIGHT_PANELS). For keys that default to
  // hidden, `false` is a meaningful opt-in signal — keep it.
  for (const k of Object.keys(hidden)) {
    if (hidden[k] === false && !DEFAULT_HIDDEN_RIGHT_PANELS[k as keyof typeof DEFAULT_HIDDEN_RIGHT_PANELS]) {
      delete hidden[k]
    }
  }
  if (Object.keys(hidden).length > 0) cleaned.hiddenRightPanels = hidden
  if (Array.isArray(next.rightPanelOrder) && next.rightPanelOrder.length > 0) {
    cleaned.rightPanelOrder = [...next.rightPanelOrder]
  }

  const hasAny = Object.keys(cleaned).some((k) => k !== 'version')
  const path = configPath(repoRoot)
  try {
    if (!hasAny) {
      // Clear both names — unlinking only the active one would let a
      // leftover legacy file resurrect the settings on the next load.
      for (const name of [REPO_CONFIG_FILENAME, LEGACY_REPO_CONFIG_FILENAME]) {
        const p = join(repoRoot, name)
        if (existsSync(p)) unlinkSync(p)
      }
      cache.set(repoRoot, {})
      return {}
    }
    writeFileSync(path, JSON.stringify(cleaned, null, 2) + '\n')
    cache.set(repoRoot, cleaned)
    return cleaned
  } catch (err) {
    log('repo-config', `failed to save ${path}: ${(err as Error).message}`)
    return cache.get(repoRoot) || {}
  }
}

/** Opt-in rename of a repo's legacy `.harness.json` to `.ness.json`.
 *  Deliberately user-triggered rather than automatic — the file is usually
 *  committed, so the rename lands in the repo's history and teammates need
 *  a version of Ness that reads the new name. No-op when there's nothing
 *  to convert. Returns true when the file was renamed. */
export function migrateRepoConfigFilename(repoRoot: string): boolean {
  if (!repoRoot) return false
  const legacyPath = join(repoRoot, LEGACY_REPO_CONFIG_FILENAME)
  if (!existsSync(legacyPath)) return false
  const nextPath = join(repoRoot, REPO_CONFIG_FILENAME)
  try {
    // Read-then-write rather than rename() so a pre-existing .ness.json
    // (which already wins on load) isn't clobbered by the stale legacy copy.
    if (!existsSync(nextPath)) {
      writeFileSync(nextPath, readFileSync(legacyPath, 'utf-8'))
    }
    unlinkSync(legacyPath)
    cache.delete(repoRoot)
    return true
  } catch (err) {
    log('repo-config', `failed to migrate ${legacyPath}: ${(err as Error).message}`)
    return false
  }
}

export function invalidateRepoConfigCache(repoRoot?: string): void {
  if (repoRoot) cache.delete(repoRoot)
  else cache.clear()
}
