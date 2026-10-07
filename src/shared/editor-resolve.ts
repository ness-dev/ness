/** Editor id used when nothing at any scope is configured. Lives in shared
 *  (rather than main/editor.ts, which owns the launcher) so the renderer can
 *  resolve the same chain without importing main. */
export const DEFAULT_EDITOR_ID = 'vscode'

export interface EditorScopes {
  /** `settings.editor` — the app-wide default. */
  globalEditor?: string
  /** repoRoot → editor id. Personal, per-machine (userData/config.json), not
   *  `.ness.json`: an editor preference isn't a project fact and shouldn't
   *  be committed onto teammates. */
  repoEditors?: Record<string, string>
  /** worktree path → editor id. Same store, same reasoning. */
  worktreeEditors?: Record<string, string>
  repoRoot?: string
  worktreePath?: string
}

export type EditorScope = 'worktree' | 'repo' | 'global'

/** The single resolution chain, called by both main (to spawn) and the
 *  renderer (to render which editor is active). Narrowest scope wins:
 *  worktree → repo → global → built-in default. */
export function resolveEditorId(scopes: EditorScopes): string {
  const { globalEditor, repoEditors, worktreeEditors, repoRoot, worktreePath } = scopes
  const fromWorktree = worktreePath ? worktreeEditors?.[worktreePath] : undefined
  if (fromWorktree) return fromWorktree
  const fromRepo = repoRoot ? repoEditors?.[repoRoot] : undefined
  if (fromRepo) return fromRepo
  return globalEditor || DEFAULT_EDITOR_ID
}

/** Which scope the resolved editor actually came from — drives the "Use repo
 *  default" affordance and the override badges in Settings. */
export function editorOverrideScope(scopes: EditorScopes): EditorScope {
  const { repoEditors, worktreeEditors, repoRoot, worktreePath } = scopes
  if (worktreePath && worktreeEditors?.[worktreePath]) return 'worktree'
  if (repoRoot && repoEditors?.[repoRoot]) return 'repo'
  return 'global'
}
