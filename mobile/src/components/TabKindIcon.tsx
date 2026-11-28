// A tab's kind icon, shared by the tab strip and the picker's nested tab
// rows so a new tab type gets its icon in both. Status (dots, spinners) is
// each caller's own: the strip mirrors the desktop tab strip, the picker
// the desktop sidebar's WorktreeTabRows.
import { FileDiff, FileText, Globe, ListChecks, SquareTerminal } from 'lucide-react-native'
import type { TerminalTab } from '../../../src/shared/state/terminals'
import { c } from '../theme'
import { AgentIcon } from './AgentIcon'

export function TabKindIcon({ tab, size = 12 }: { tab: Pick<TerminalTab, 'type' | 'agentKind'>; size?: number }) {
  switch (tab.type) {
    case 'agent':
    case 'json-claude':
      return <AgentIcon kind={tab.agentKind ?? 'claude'} size={size} />
    case 'shell':
      return <SquareTerminal color={c.dim} size={size} />
    case 'diff':
      return <FileDiff color={c.dim} size={size} />
    case 'file':
      return <FileText color={c.dim} size={size} />
    case 'browser':
      return <Globe color={c.dim} size={size} />
    case 'review':
      return <ListChecks color={c.dim} size={size} />
    default:
      return null
  }
}
