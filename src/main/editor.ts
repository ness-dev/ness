import { spawn } from 'child_process'
import { join, isAbsolute } from 'path'
import { log } from './debug'
import { resolveUserShell, loginShellCommandArgs } from './user-shell'

export interface EditorDef {
  id: string
  name: string
  /** Shell command used to launch the editor. Must be on the user's PATH. */
  cmd: string
}

/** Known GUI editors. Each is invoked as `<cmd> <worktreePath> [<filePath>]`,
 * which is the universal form for VS Code-family editors, Zed, Sublime Text,
 * and the JetBrains launchers. The command must be installed on the user's
 * PATH — we spawn via a login shell so homebrew/nvm/etc. are picked up. */
export const AVAILABLE_EDITORS: EditorDef[] = [
  { id: 'vscode', name: 'VS Code', cmd: 'code' },
  { id: 'cursor', name: 'Cursor', cmd: 'cursor' },
  { id: 'windsurf', name: 'Windsurf', cmd: 'windsurf' },
  { id: 'zed', name: 'Zed', cmd: 'zed' },
  { id: 'sublime', name: 'Sublime Text', cmd: 'subl' },
  { id: 'idea', name: 'IntelliJ IDEA', cmd: 'idea' },
  { id: 'webstorm', name: 'WebStorm', cmd: 'webstorm' },
  { id: 'pycharm', name: 'PyCharm', cmd: 'pycharm' },
  { id: 'goland', name: 'GoLand', cmd: 'goland' },
  { id: 'rubymine', name: 'RubyMine', cmd: 'mine' },
  { id: 'rustrover', name: 'RustRover', cmd: 'rustrover' },
  { id: 'rider', name: 'Rider', cmd: 'rider' }
]

export { DEFAULT_EDITOR_ID } from '../shared/editor-resolve'

function findEditor(id: string): EditorDef | null {
  return AVAILABLE_EDITORS.find((e) => e.id === id) || null
}

/** Shell-escape a single argument for use inside the login shell's -ilc. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Launch the configured editor, opening `worktreePath`. If `filePath` is
 * given (relative to the worktree), the file is also opened. Spawns
 * detached so the editor outlives the renderer and doesn't block. */
export function openInEditor(
  editorId: string,
  worktreePath: string,
  filePath?: string
): { ok: true } | { ok: false; error: string } {
  const editor = findEditor(editorId)
  if (!editor) return { ok: false, error: `Unknown editor: ${editorId}` }

  const args: string[] = [worktreePath]
  if (filePath) {
    args.push(isAbsolute(filePath) ? filePath : join(worktreePath, filePath))
  }

  const shellCmd = `${editor.cmd} ${args.map(shellEscape).join(' ')}`
  log('editor', `launching ${editor.id}: ${shellCmd}`)

  try {
    const child = spawn(resolveUserShell(), loginShellCommandArgs(shellCmd), {
      detached: true,
      stdio: 'ignore'
    })
    child.on('error', (err) => log('editor', `spawn error: ${err.message}`))
    child.unref()
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('editor', `failed to spawn ${editor.cmd}: ${msg}`)
    return { ok: false, error: msg }
  }
}
