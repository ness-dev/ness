import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { log } from './debug'
import {
  DEFAULT_TOOL_SCRIPT,
  TOOL_MANIFEST_FILENAME,
  TOOLS_DIRNAME,
  type ToolRunResult,
  type ToolSpec
} from '../shared/tools'

const RUN_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 256 * 1024


/** Tools live in the worktree, not the repo root, so a branch can iterate
 * on its own tooling and a PR that edits a tool exercises the new version.
 * (Note this differs from `.ness.json`, which resolves against repoRoot.) */
function toolsDir(worktreePath: string): string {
  return join(worktreePath, TOOLS_DIRNAME)
}

function parseManifest(dir: string, id: string): ToolSpec | null {
  const manifestPath = join(dir, TOOL_MANIFEST_FILENAME)
  if (!existsSync(manifestPath)) return null
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id
    const script =
      typeof raw.script === 'string' && raw.script.trim() ? raw.script.trim() : DEFAULT_TOOL_SCRIPT
    // Keep the script inside its own tool directory — a manifest shouldn't
    // be able to point at an arbitrary path elsewhere on disk.
    if (script.startsWith('/') || script.split('/').includes('..')) {
      log('tools', `tool ${id}: rejecting script path outside tool dir: ${script}`)
      return null
    }
    return {
      id,
      title,
      script,
      dir,
      refresh: raw.refresh === 'auto' ? 'auto' : 'manual'
    }
  } catch (err) {
    log('tools', `tool ${id}: failed to parse manifest: ${(err as Error).message}`)
    return null
  }
}

export function discoverTools(worktreePath: string): ToolSpec[] {
  if (!worktreePath) return []
  const root = toolsDir(worktreePath)
  if (!existsSync(root)) return []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (err) {
    log('tools', `failed to read ${root}: ${(err as Error).message}`)
    return []
  }
  const specs: ToolSpec[] = []
  for (const id of entries.sort()) {
    if (id.startsWith('.')) continue
    const dir = join(root, id)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const spec = parseManifest(dir, id)
    if (spec) specs.push(spec)
  }
  return specs
}

export async function runTool(
  worktreePath: string,
  toolId: string,
  ctx: { branch: string; repoRoot: string }
): Promise<ToolRunResult> {
  const spec = discoverTools(worktreePath).find((t) => t.id === toolId)
  if (!spec) return { ok: false, markdown: '', error: `Unknown tool: ${toolId}` }
  const scriptPath = join(spec.dir, spec.script)
  if (!existsSync(scriptPath)) {
    return { ok: false, markdown: '', error: `Script not found: ${spec.script}` }
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: ToolRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn> | null = null
    const timer = setTimeout(() => {
      child?.kill('SIGKILL')
      finish({ ok: false, markdown: stdout, error: `Timed out after ${RUN_TIMEOUT_MS / 1000}s` })
    }, RUN_TIMEOUT_MS)

    try {
      // Spawned directly rather than through a login shell: the script's
      // own shebang decides the interpreter, and rc-file chatter (nvm
      // banners, starship init) can't leak into stdout — which here IS
      // the panel body. PATH is already the login-shell PATH thanks to
      // path-fix.ts at boot, so there's nothing to gain from `-ilc`.
      child = spawn(scriptPath, [], {
        cwd: worktreePath,
        env: {
          ...process.env,
          NESS_WORKTREE_PATH: worktreePath,
          NESS_BRANCH: ctx.branch,
          NESS_REPO_ROOT: ctx.repoRoot,
          NESS_TOOL_DIR: spec.dir,
          NESS_TOOL_ID: spec.id
        }
      })
    } catch (err) {
      finish({ ok: false, markdown: '', error: (err as Error).message })
      return
    }

    child.stdout?.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString()
    })
    child.stderr?.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString()
    })
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      finish({
        ok: false,
        markdown: '',
        error:
          code === 'EACCES'
            ? `${spec.script} is not executable — run chmod +x`
            : err.message
      })
    })
    child.on('close', (code) => {
      const truncated = stdout.length >= MAX_OUTPUT_BYTES
      const markdown = truncated ? stdout.slice(0, MAX_OUTPUT_BYTES) : stdout
      if (code === 0) {
        finish({ ok: true, markdown })
        return
      }
      // A failing script that still printed something gets to render its
      // own output — it may be formatting the error better than we can.
      finish({
        ok: false,
        markdown,
        error: stderr.trim().slice(0, 500) || `Exited with code ${code}`
      })
    })
  })
}
