import { useMemo } from 'react'
import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'
import { EditIcon } from './tool-icons'
import { DiffLines } from './UnifiedDiff'
import { parsePatchLines } from './diff-util'
import { HighlightedText } from '../JsonModeChatFind'

interface PatchChange {
  path: string
  kind: 'add' | 'delete' | 'update'
  diff: string
}

function readChanges(input: Record<string, unknown> | undefined): PatchChange[] {
  const raw = input?.changes
  if (!Array.isArray(raw)) return []
  return raw.flatMap((c): PatchChange[] => {
    if (!c || typeof c !== 'object') return []
    const { path, kind, diff } = c as Record<string, unknown>
    if (typeof path !== 'string') return []
    const k = kind === 'add' || kind === 'delete' ? kind : 'update'
    return [{ path, kind: k, diff: typeof diff === 'string' ? diff : '' }]
  })
}

const KIND_LABEL: Record<PatchChange['kind'], string> = {
  add: 'new',
  delete: 'deleted',
  update: 'edited'
}

function FilePatch({ change }: { change: PatchChange }): JSX.Element {
  const lines = useMemo(() => parsePatchLines(change.diff, change.kind), [change.diff, change.kind])
  return (
    <div>
      <div className="flex items-center gap-2 px-2 py-1 text-xs font-mono text-muted">
        <span className="truncate">
          <HighlightedText text={change.path} />
        </span>
        <span className="shrink-0 text-faint">{KIND_LABEL[change.kind]}</span>
      </div>
      {lines.length > 0 && <DiffLines lines={lines} filePath={change.path} />}
    </div>
  )
}

/** Codex's file edits: one patch spanning any number of files, each with
 *  its own diff (see the Codex chat provider's fileChange mapping). */
export function ApplyPatchCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const changes = readChanges(block.input)
  const subtitle =
    changes.length === 1 ? basename(changes[0].path) : `${changes.length} files`
  return (
    <ToolCardChrome
      id={block.id}
      name="Edit"
      subtitle={subtitle}
      variant="warn"
      icon={EditIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {changes.map((c) => (
        <FilePatch key={c.path} change={c} />
      ))}
      {result && result.isError && (
        <pre className="px-2 py-1 text-xs font-mono text-danger whitespace-pre-wrap">
          <HighlightedText text={trunc(result.content, 1000)} />
        </pre>
      )}
    </ToolCardChrome>
  )
}
