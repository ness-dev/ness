export type BuiltinRightPanelKey =
  | 'merge'
  | 'pr'
  | 'todos'
  | 'commits'
  | 'changedFiles'
  | 'allFiles'
  | 'cost'
  | 'context'
  | 'scratchpad'

/** Custom tools discovered from `.harness/tools/<id>/` are namespaced so
 * they can never collide with a builtin key. */
export type CustomToolPanelKey = `tool:${string}`

export type RightPanelKey = BuiltinRightPanelKey | CustomToolPanelKey

export function isCustomToolPanelKey(key: string): key is CustomToolPanelKey {
  return key.startsWith('tool:')
}

export function toolPanelKey(toolId: string): CustomToolPanelKey {
  return `tool:${toolId}`
}

export const DEFAULT_RIGHT_PANEL_ORDER: BuiltinRightPanelKey[] = [
  'merge',
  'pr',
  'commits',
  'changedFiles',
  'allFiles',
  'todos',
  'cost',
  'context',
  'scratchpad'
]

export type HiddenRightPanels = Partial<Record<RightPanelKey, boolean>>

/** Panels hidden by default unless the user explicitly enables them.
 *  Merged UNDER the saved config in `effectiveHiddenRightPanels` — once a
 *  user toggles a panel here, their choice wins. */
export const DEFAULT_HIDDEN_RIGHT_PANELS: HiddenRightPanels = {
  scratchpad: true
}

export interface RepoConfig {
  version?: number
  setupCommand?: string
  teardownCommand?: string
  mergeStrategy?: 'squash' | 'merge-commit' | 'fast-forward'
  /** @deprecated use hiddenRightPanels.merge. Migrated on load. */
  hideMergePanel?: boolean
  /** @deprecated use hiddenRightPanels.pr. Migrated on load. */
  hidePrPanel?: boolean
  /** Per-panel visibility. A key set to true hides that panel. */
  hiddenRightPanels?: HiddenRightPanels
  /** Order of right-column panels. Unknown / missing keys fall back to
   * DEFAULT_RIGHT_PANEL_ORDER (any key absent from the saved order is
   * appended to the end in canonical order). */
  rightPanelOrder?: RightPanelKey[]
}

/** Read an effective panel order, filling in any keys missing from the
 * saved order with the canonical default order (appended at the end)
 * and dropping any unknown keys. Always returns every builtin key plus
 * every currently-discovered custom tool key exactly once.
 *
 * `customKeys` comes from tool discovery, so a saved order referencing a
 * tool that has since been deleted drops out naturally, and a newly
 * added tool appears at the end without needing a config write. */
export function effectiveRightPanelOrder(
  config: RepoConfig | null | undefined,
  customKeys: readonly RightPanelKey[] = []
): RightPanelKey[] {
  const canonical: RightPanelKey[] = [...DEFAULT_RIGHT_PANEL_ORDER, ...customKeys]
  const saved = config?.rightPanelOrder
  if (!saved || saved.length === 0) return canonical
  const known = new Set<RightPanelKey>(canonical)
  const seen = new Set<RightPanelKey>()
  const out: RightPanelKey[] = []
  for (const k of saved) {
    if (known.has(k) && !seen.has(k)) {
      out.push(k)
      seen.add(k)
    }
  }
  for (const k of canonical) {
    if (!seen.has(k)) out.push(k)
  }
  return out
}

/** Read an effective hidden map, migrating legacy hideMergePanel /
 * hidePrPanel fields. Returns a fresh object — safe to mutate.
 *
 * DEFAULT_HIDDEN_RIGHT_PANELS is merged UNDER the saved values, so once
 * the user explicitly toggles a default-hidden panel on, their choice wins. */
export function effectiveHiddenRightPanels(config: RepoConfig | null | undefined): HiddenRightPanels {
  const out: HiddenRightPanels = {
    ...DEFAULT_HIDDEN_RIGHT_PANELS,
    ...(config?.hiddenRightPanels || {})
  }
  if (config?.hideMergePanel && out.merge === undefined) out.merge = true
  if (config?.hidePrPanel && out.pr === undefined) out.pr = true
  return out
}

/** Per-repo config filename. `.harness.json` predates the Ness rename and
 *  is still read; only brand-new files get `.ness.json`. */
export const REPO_CONFIG_FILENAME = '.ness.json'
export const LEGACY_REPO_CONFIG_FILENAME = '.harness.json'

export interface RepoConfigsState {
  /** Per-repo config keyed by repoRoot. Hydrated at boot from each repo's
   * config file and updated whenever a setRepoConfig call commits. */
  byRepo: Record<string, RepoConfig>
  /** Which filename each repo actually uses — `.ness.json` for anything
   * new, `.harness.json` for repos that already had one. Keyed by
   * repoRoot; absent means the repo hasn't been seeded yet. */
  filenameByRepo: Record<string, string>
}

export type RepoConfigsEvent =
  | {
      type: 'repoConfigs/loaded'
      payload: { byRepo: Record<string, RepoConfig>; filenameByRepo: Record<string, string> }
    }
  | {
      type: 'repoConfigs/changed'
      payload: { repoRoot: string; config: RepoConfig; filename: string }
    }
  | { type: 'repoConfigs/removed'; payload: string }

export const initialRepoConfigs: RepoConfigsState = {
  byRepo: {},
  filenameByRepo: {}
}

export function repoConfigsReducer(
  state: RepoConfigsState,
  event: RepoConfigsEvent
): RepoConfigsState {
  switch (event.type) {
    case 'repoConfigs/loaded':
      return {
        ...state,
        byRepo: event.payload.byRepo,
        filenameByRepo: event.payload.filenameByRepo
      }
    case 'repoConfigs/changed':
      return {
        ...state,
        byRepo: { ...state.byRepo, [event.payload.repoRoot]: event.payload.config },
        filenameByRepo: {
          ...state.filenameByRepo,
          [event.payload.repoRoot]: event.payload.filename
        }
      }
    case 'repoConfigs/removed': {
      if (!(event.payload in state.byRepo) && !(event.payload in state.filenameByRepo)) {
        return state
      }
      const { [event.payload]: _dropped, ...rest } = state.byRepo
      const { [event.payload]: _droppedName, ...restNames } = state.filenameByRepo
      void _dropped
      void _droppedName
      return { ...state, byRepo: rest, filenameByRepo: restNames }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
