// Config schema migrations. Kept in its own file (no electron imports) so
// unit tests can exercise them without needing to mock `app.getPath` etc.
//
// Each entry takes a config object at version N and mutates it in place to
// version N+1. `runMigrations` runs them in order from `config.schemaVersion`
// up to `SCHEMA_VERSION`. Append new migrations to the end of the array and
// the version bumps automatically — never rewrite or reorder existing ones,
// since users in the wild may be at any earlier version.
//
// Each migration must be idempotent on an already-migrated shape so a user
// who installed a mid-release build still converges correctly. Pre-versioned
// configs (no `schemaVersion` field) are treated as v0 and run through the
// entire chain.

import { basename, dirname, join } from 'path'

import type { AgentKind } from '../shared/state/terminals'

export interface PersistedTab {
  id: string
  type: 'agent' | 'shell' | 'browser' | 'json-claude'
  label: string
  agentKind?: AgentKind
  sessionId?: string
  /** For browser tabs: last URL so we can restore the tab on reload. */
  url?: string
  /** For shell tabs: the command the tab was created with (agent-spawned).
   *  Kept for display only — restored tabs do not re-run it. */
  command?: string
  /** For shell tabs: cwd (absolute or relative to worktree root). */
  cwd?: string
  /** For agent + json-claude tabs: per-tab model pin. Wins over the
   *  global claudeModel/codexModel setting at spawn time. */
  model?: string
  /** User-defined label override. Empty/undefined falls back to `label`. */
  customLabel?: string
}

export interface PersistedPane {
  id: string
  tabs: PersistedTab[]
  activeTabId: string
}

export type PersistedPaneNode =
  | { type: 'leaf'; id: string; tabs: PersistedTab[]; activeTabId: string }
  | {
      type: 'split'
      id: string
      direction: 'horizontal' | 'vertical'
      children: [PersistedPaneNode, PersistedPaneNode]
      ratio: number
    }

export type AnyConfig = Record<string, unknown>
export type Migration = (c: AnyConfig) => void

export const migrations: Migration[] = [
  // v0 → v1: single `repoRoot` string → `repoRoots` array.
  (c) => {
    if (typeof c.repoRoot === 'string' && !Array.isArray(c.repoRoots)) {
      c.repoRoots = [c.repoRoot]
    }
    delete c.repoRoot
  },

  // v1 → v2: flat `terminalTabs` + `activeTabId` → flat `panes`
  // (worktreePath → PersistedPane[]). Each worktree's old tab list becomes a
  // single pane with the same active tab. Legacy keys are left in place so a
  // downgrade stays lossless.
  (c) => {
    const terminalTabs = c.terminalTabs as Record<string, PersistedTab[]> | undefined
    const activeTabId = c.activeTabId as Record<string, string> | undefined
    if (!terminalTabs || c.panes) return
    const migrated: Record<string, PersistedPane[]> = {}
    for (const [wtPath, tabs] of Object.entries(terminalTabs)) {
      if (!tabs || tabs.length === 0) continue
      const activeId = activeTabId?.[wtPath] || tabs[0].id
      migrated[wtPath] = [{
        id: `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tabs,
        activeTabId: activeId
      }]
    }
    c.panes = migrated
  },

  // v2 → v3: flat `panes` (wtPath → panes[]) → nested
  // `panes` (repoRoot → wtPath → panes[]). Worktrees are grouped under the
  // repoRoot that owns them by path prefix; the default harness layout puts
  // them in a `<basename>-worktrees/` sibling of the repo. Anything that
  // doesn't match lands in `__orphan__` and is re-keyed by the renderer on
  // first save.
  (c) => {
    const looksFlat = (p: unknown): p is Record<string, PersistedPane[]> => {
      if (!p || typeof p !== 'object') return false
      const values = Object.values(p as object)
      if (values.length === 0) return false
      return Array.isArray(values[0])
    }
    if (!looksFlat(c.panes)) return
    const flat = c.panes as Record<string, PersistedPane[]>
    const repoRoots: string[] = Array.isArray(c.repoRoots) ? (c.repoRoots as string[]) : []
    const ownerPrefixes = repoRoots.map((r) => ({
      repoRoot: r,
      prefixes: [r, join(dirname(r), `${basename(r)}-worktrees`) + '/']
    }))
    const nested: Record<string, Record<string, PersistedPane[]>> = {}
    const orphan: Record<string, PersistedPane[]> = {}
    for (const [wtPath, paneList] of Object.entries(flat)) {
      const owner = ownerPrefixes.find(({ prefixes }) =>
        prefixes.some((p) => wtPath === p || wtPath.startsWith(p.endsWith('/') ? p : p + '/'))
      )
      if (owner) {
        if (!nested[owner.repoRoot]) nested[owner.repoRoot] = {}
        nested[owner.repoRoot][wtPath] = paneList
      } else {
        orphan[wtPath] = paneList
      }
    }
    if (Object.keys(orphan).length > 0) nested['__orphan__'] = orphan
    // Keep the flat shape in `legacyPanes` for one release so a downgrade is
    // lossless.
    c.legacyPanes = flat
    c.panes = nested
  },

  // v3 → v4: tab type 'claude' → 'agent' with agentKind: 'claude'.
  // Walk all persisted panes (nested by repoRoot → wtPath) and migrate
  // each tab's type field.
  (c) => {
    const panes = c.panes as Record<string, Record<string, { tabs: { type: string; agentKind?: string }[] }[]>> | undefined
    if (!panes || typeof panes !== 'object') return
    for (const byWt of Object.values(panes)) {
      if (!byWt || typeof byWt !== 'object') continue
      for (const paneList of Object.values(byWt)) {
        if (!Array.isArray(paneList)) continue
        for (const pane of paneList) {
          if (!pane?.tabs || !Array.isArray(pane.tabs)) continue
          for (const tab of pane.tabs) {
            if (tab.type === 'claude') {
              tab.type = 'agent'
              tab.agentKind = 'claude'
            }
          }
        }
      }
    }
  },

  // v4 → v5: flat panes arrays → tree (PaneNode). Each PersistedPane[]
  // becomes a PaneNode tree (a chain of horizontal splits for multi-pane
  // arrays; a single leaf for single-pane). This enables mixed
  // horizontal/vertical splits.
  (c) => {
    const panes = c.panes as Record<string, Record<string, PersistedPane[]>> | undefined
    if (!panes || typeof panes !== 'object') return
    const alreadyTree = Object.values(panes).some((byWt) =>
      Object.values(byWt).some((v) => v && typeof v === 'object' && 'type' in v)
    )
    if (alreadyTree) return
    const migrated: Record<string, Record<string, PersistedPaneNode>> = {}
    for (const [repo, byWt] of Object.entries(panes)) {
      migrated[repo] = {}
      for (const [wtPath, paneList] of Object.entries(byWt)) {
        if (!Array.isArray(paneList) || paneList.length === 0) continue
        migrated[repo][wtPath] = flatPanesToTree(paneList)
      }
    }
    c.panes = migrated
    delete c.paneSplitDirections
  },

  // v5 → v6: introduce `snooze` and `snoozeDefaultDays`. No reshape needed —
  // both fields default to absent / 7 at read time. This migration just bumps
  // the version so future shape changes can rely on a stable starting point.
  (_c) => {
    // no-op
  },

  // v6 → v7: legacy `theme: string` → `themeMode` + `themeLight` / `themeDark`.
  // Sets `themeMode` to the *legacy* theme's mode (not 'system'), preserving
  // the user's explicit choice; users who want auto-switching can opt in via
  // Settings. The matching slot gets the legacy id; the other slot is left
  // unset so the runtime default applies.
  (c) => {
    const legacy = c.theme
    if (typeof legacy !== 'string') return
    const isLight = legacy === 'solarized-light'
    if (isLight) {
      c.themeMode = 'light'
      c.themeLight = legacy
    } else {
      c.themeMode = 'dark'
      c.themeDark = legacy
    }
    delete c.theme
  },

  // v7 → v8: introduce `pinned`. No reshape needed — the field defaults to
  // absent at read time. Bumps the version so future shape changes can rely
  // on a stable starting point.
  (_c) => {
    // no-op
  }
]

function flatPanesToTree(panes: PersistedPane[]): PersistedPaneNode {
  if (panes.length === 1) {
    return {
      type: 'leaf',
      id: panes[0].id,
      tabs: panes[0].tabs,
      activeTabId: panes[0].activeTabId
    }
  }
  const leaves: PersistedPaneNode[] = panes.map((p) => ({
    type: 'leaf' as const,
    id: p.id,
    tabs: p.tabs,
    activeTabId: p.activeTabId
  }))
  let result: PersistedPaneNode = leaves[leaves.length - 1]
  for (let i = leaves.length - 2; i >= 0; i--) {
    result = {
      type: 'split',
      id: `split-migrated-${i}`,
      direction: 'horizontal',
      children: [leaves[i], result],
      ratio: 1 / (leaves.length - i)
    }
  }
  return result
}

export const SCHEMA_VERSION = migrations.length

/** Run all pending migrations on the given config object, mutating it in
 *  place. Sets `schemaVersion` to the current version on return. */
export function runMigrations(parsed: AnyConfig): void {
  const from = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 0
  for (let v = from; v < SCHEMA_VERSION; v++) {
    migrations[v](parsed)
  }
  parsed.schemaVersion = SCHEMA_VERSION
}
