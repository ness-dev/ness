// Loads user-authored themes from `<userData>/themes/*.json`. Theme
// authoring is filesystem-driven on purpose — no in-app editor — so a
// user can pick their preferred text editor, version-control their
// themes alongside dotfiles, etc.
//
// Scan model: read the whole directory on boot and again whenever the
// renderer asks for a reload. Cheap (a handful of small JSON files) and
// avoids the watcher complexity of detecting external edits — the
// "Reload from disk" button in Settings is the user's intent signal.
//
// Validation is intentionally lightweight:
//   - `name` (string, non-empty) is required for the picker label.
//   - `mode` ∈ {'light','dark'} is required so we know which picker the
//     theme belongs in.
//   - `colors` is optional; missing keys inherit from the theme's `base`
//     built-in at apply time (the apply helper just sets the keys
//     present, the rest fall through to that built-in's CSS variables).
//   - `base` is optional and only checked in the renderer, which knows
//     each built-in's mode.
//
// Anything malformed is logged via debug.ts and skipped, never thrown
// — a broken theme file must never block boot. ID collisions: first
// file wins, subsequent collisions are logged and skipped. Built-in
// IDs cannot be shadowed (the loader refuses them).
//
// Filename → id derivation: drop the `.json` suffix, lowercase,
// replace anything outside `[a-z0-9-]` with `-`, collapse consecutive
// dashes, trim leading/trailing dashes. So `My Cool Theme!.json` →
// `my-cool-theme`.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { CustomTheme } from '../shared/state/settings'
import { log } from './debug'
import { userDataDir } from './paths'
import { AVAILABLE_THEMES } from './persistence'

const BUILT_IN_IDS: ReadonlySet<string> = new Set(AVAILABLE_THEMES)

/** Absolute path to the user's themes directory, ensuring it exists. */
export function themesDir(): string {
  const dir = join(userDataDir(), 'themes')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function deriveId(filename: string): string {
  return filename
    .replace(/\.json$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function parseTheme(id: string, raw: unknown): CustomTheme | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!name) return null
  const mode = obj.mode
  if (mode !== 'light' && mode !== 'dark') return null
  const colorsIn = obj.colors
  const colors: Record<string, string> = {}
  if (colorsIn && typeof colorsIn === 'object') {
    for (const [k, v] of Object.entries(colorsIn as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) colors[k] = v
    }
  }
  const base = typeof obj.base === 'string' && obj.base ? obj.base : undefined
  return base ? { id, name, mode, colors, base } : { id, name, mode, colors }
}

/** Read and validate every JSON file in `<userData>/themes/`. */
export function loadCustomThemes(): CustomTheme[] {
  const dir = themesDir()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (err) {
    log('themes', `failed to read ${dir}: ${(err as Error).message}`)
    return []
  }
  const out: CustomTheme[] = []
  const seen = new Set<string>()
  for (const filename of entries) {
    if (!filename.toLowerCase().endsWith('.json')) continue
    const id = deriveId(filename)
    if (!id) {
      log('themes', `skipping ${filename}: filename produces empty id`)
      continue
    }
    if (BUILT_IN_IDS.has(id)) {
      log('themes', `skipping ${filename}: id "${id}" collides with built-in theme`)
      continue
    }
    if (seen.has(id)) {
      log('themes', `skipping ${filename}: duplicate id "${id}" (first one wins)`)
      continue
    }
    const path = join(dir, filename)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (err) {
      log('themes', `skipping ${filename}: parse error — ${(err as Error).message}`)
      continue
    }
    const theme = parseTheme(id, parsed)
    if (!theme) {
      log('themes', `skipping ${filename}: missing required name/mode or invalid shape`)
      continue
    }
    seen.add(id)
    out.push(theme)
  }
  return out
}
