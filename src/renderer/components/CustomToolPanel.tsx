import { useCallback } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import type { ToolRunResult, ToolSpec } from '../types'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'
import { SidebarMarkdown, type NessLinkAction } from './SidebarMarkdown'
import { useWatchedQuery } from '../hooks/useWatchedQuery'
import { toolPanelKey } from '../../shared/state/repo-configs'
import { useBackend } from '../backend'

interface CustomToolPanelProps {
  spec: ToolSpec
  worktreePath: string | null
  onSendToAgent?: (text: string) => void
  onOpenFile?: (filePath: string) => void
}

export function CustomToolPanel({
  spec,
  worktreePath,
  onSendToAgent,
  onOpenFile
}: CustomToolPanelProps): JSX.Element | null {
  const backend = useBackend()
  const fetcher = useCallback(
    (path: string) => backend.runTool(path, spec.id),
    [backend, spec.id]
  )

  const { data, loading, refresh } = useWatchedQuery<ToolRunResult>({
    worktreePath,
    cacheKey: `tool:${spec.id}`,
    fetcher,
    // A `manual` tool still runs on mount and on the refresh button, but
    // never on a timer or a git change — tool scripts routinely hit the
    // network, and the built-in panels' cadence would hammer an API.
    fallbackPollMs: spec.refresh === 'auto' ? 30000 : 0,
    revalidateOnFileChange: spec.refresh === 'auto'
  })

  const handleAction = useCallback(
    (action: NessLinkAction) => {
      if (action.verb === 'send') {
        const text = action.params.get('text')
        if (text) onSendToAgent?.(text)
        return
      }
      if (action.verb === 'file') {
        const path = action.params.get('path')
        if (path) onOpenFile?.(path)
        return
      }
      if (action.verb === 'refresh') refresh()
    },
    [onSendToAgent, onOpenFile, refresh]
  )

  if (!worktreePath) return null

  const actions = (
    <>
      {data && !data.ok && (
        <Tooltip label={data.error || 'Tool failed'}>
          <TriangleAlert className="icon-xs text-warning" />
        </Tooltip>
      )}
      <Tooltip label="Refresh">
        <button
          onClick={(e) => {
            e.stopPropagation()
            refresh()
          }}
          className="text-faint hover:text-fg transition-colors cursor-pointer"
        >
          <RefreshCw className={`icon-xs ${loading ? 'animate-spin' : ''}`} />
        </button>
      </Tooltip>
    </>
  )

  const body = data?.markdown?.trim()

  return (
    <RightPanel id={toolPanelKey(spec.id)} title={spec.title} actions={actions} maxHeight="max-h-56">
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {!data && loading && <div className="px-3 py-2 text-xs text-faint">Running…</div>}
        {body ? (
          <SidebarMarkdown markdown={body} onAction={handleAction} />
        ) : (
          data && (
            <div className="px-3 py-2 text-xs text-faint italic">
              {data.ok ? 'No output' : data.error || 'Tool failed'}
            </div>
          )
        )}
      </div>
    </RightPanel>
  )
}
