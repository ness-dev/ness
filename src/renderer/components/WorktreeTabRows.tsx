import { memo, useMemo } from 'react'
import { FileText, GitCompare, Globe, ListChecks, Loader2, SquareTerminal } from 'lucide-react'
import { getLeaves, type TerminalTab } from '../../shared/state/terminals'
import { useShellActivity, useTerminalStatus, useWorktreePanes } from '../store'
import { STATUS_LABELS } from '../worktree-row-style'
import { AgentIcon } from './AgentIcon'

interface WorktreeTabRowsProps {
  worktreePath: string
  activeTabId: string | null
  onSelectTab: (worktreePath: string, paneId: string, tabId: string) => void
}

/** The active worktree's tabs as indented child rows inside its selection
 *  pill. Reads its own pane tree so other worktrees' tab churn doesn't
 *  re-render it. */
export const WorktreeTabRows = memo(function WorktreeTabRows({
  worktreePath,
  activeTabId,
  onSelectTab
}: WorktreeTabRowsProps): JSX.Element | null {
  const tree = useWorktreePanes(worktreePath)
  const entries = useMemo(
    () =>
      tree ? getLeaves(tree).flatMap((leaf) => leaf.tabs.map((tab) => ({ paneId: leaf.id, tab }))) : [],
    [tree]
  )
  if (entries.length === 0) return null
  return (
    <div className="pb-2">
      {entries.map(({ paneId, tab }) => (
        <TabRow
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          onClick={() => onSelectTab(worktreePath, paneId, tab.id)}
        />
      ))}
    </div>
  )
})

function TabRow({
  tab,
  isActive,
  onClick
}: {
  tab: TerminalTab
  isActive: boolean
  onClick: () => void
}): JSX.Element {
  const asleep = tab.mode === 'asleep'
  return (
    <div
      onClick={onClick}
      className={`ml-[1.125rem] mr-2 px-1.5 py-0.5 rounded flex items-center gap-1.5 text-xs cursor-pointer transition-colors ${
        isActive ? 'bg-surface-hover/60 text-fg-bright' : 'text-muted hover:bg-surface-hover/40 hover:text-fg'
      }`}
    >
      <TabKindIcon tab={tab} />
      <TabStatus tab={tab} />
      <span className={`truncate ${asleep ? 'italic text-dim' : ''}`}>{tab.customLabel ?? tab.label}</span>
    </div>
  )
}

function TabKindIcon({ tab }: { tab: TerminalTab }): JSX.Element {
  const cls = 'icon-xs shrink-0'
  switch (tab.type) {
    case 'agent':
      return <AgentIcon kind={tab.agentKind ?? 'claude'} className={cls} />
    case 'json-claude':
      return <AgentIcon kind="claude" className={cls} />
    case 'shell':
      return <SquareTerminal className={cls} />
    case 'browser':
      return <Globe className={cls} />
    case 'diff':
      return <GitCompare className={cls} />
    case 'file':
      return <FileText className={cls} />
    case 'review':
      return <ListChecks className={cls} />
  }
}

function TabStatus({ tab }: { tab: TerminalTab }): JSX.Element | null {
  const status = useTerminalStatus(tab.id)
  const shellActivity = useShellActivity(tab.id)
  if (tab.type === 'shell') {
    if (!shellActivity?.active) return null
    return (
      <Loader2
        className="icon-2xs shrink-0 animate-spin text-fg-bright"
        aria-label={`Running: ${shellActivity.processName || '?'}`}
      />
    )
  }
  switch (status) {
    case 'processing':
      return <Loader2 className="icon-2xs shrink-0 animate-spin text-success" aria-label={STATUS_LABELS.processing} />
    case 'waiting':
      return <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-warning" title={STATUS_LABELS.waiting} />
    case 'needs-approval':
      return (
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0 bg-danger animate-pulse"
          title={STATUS_LABELS['needs-approval']}
        />
      )
    default:
      return null
  }
}
