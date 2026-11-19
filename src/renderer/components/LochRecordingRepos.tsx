import { useState } from 'react'
import { useSettings, useWorktrees } from '../store'
import { useBackend } from '../backend'
import type { LochRecordingResult } from '../../shared/loch'

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

function describe(r: LochRecordingResult, enabled: boolean): string {
  if (!r.ok) {
    if (r.code === 'download-failed') return `Couldn’t download loch${r.error ? ` (${r.error})` : ''}.`
    if (r.code === 'checksum-mismatch') return 'The loch download didn’t match its checksum; nothing was installed.'
    if (r.code === 'not-installed' || r.code === 'unsupported-platform') return 'loch isn’t available for this machine.'
    return `Failed (${r.code})${r.error ? `: ${r.error}` : ''}`
  }
  if (!enabled) return 'Hooks removed.'
  const parts: string[] = []
  if (r.installed) parts.push(`hooks added to ${r.installed} worktree${r.installed === 1 ? '' : 's'}`)
  if (r.viaProject) parts.push(`${r.viaProject} already record via the repo’s own settings`)
  if (r.failed) parts.push(`${r.failed} failed`)
  return `${parts.join(', ')}. Backfilling history in the background.`
}

/** The explicit opt-in for loch recording, one checkbox per repo. Nothing
 *  is installed until a box is ticked. */
export function LochRecordingRepos(): JSX.Element {
  const backend = useBackend()
  const { repoRoots } = useWorktrees()
  const { lochRecordingRepos } = useSettings()
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, string>>({})

  const toggle = (repoRoot: string, enabled: boolean): void => {
    setBusy(repoRoot)
    backend.setLochRecording(repoRoot, enabled).then(
      (r) => {
        setStatus((s) => ({ ...s, [repoRoot]: describe(r, enabled) }))
        setBusy(null)
      },
      (err) => {
        setStatus((s) => ({ ...s, [repoRoot]: `Failed: ${String(err)}` }))
        setBusy(null)
      }
    )
  }

  if (repoRoots.length === 0) {
    return <div className="text-xs text-faint">No repos added yet.</div>
  }
  return (
    <div className="flex flex-col gap-2">
      {repoRoots.map((repoRoot) => {
        const on = lochRecordingRepos.includes(repoRoot)
        return (
          <label key={repoRoot} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={on}
              disabled={busy === repoRoot}
              onChange={(e) => toggle(repoRoot, e.target.checked)}
              className="mt-0.5 cursor-pointer icon-base"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-fg-bright">{basename(repoRoot)}</div>
              <div className="text-xs text-faint truncate" title={repoRoot}>
                {repoRoot}
              </div>
              {(busy === repoRoot || status[repoRoot]) && (
                <div className="text-xs text-dim mt-0.5">
                  {busy === repoRoot ? 'Working…' : status[repoRoot]}
                </div>
              )}
            </div>
          </label>
        )
      })}
    </div>
  )
}
