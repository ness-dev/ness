// Builtin right-column panels by key (BuiltinRightPanelKey). Custom tools
// (`tool:<id>`) are rendered by CustomToolPanel with their spec.
import type { BuiltinRightPanelKey } from '../../../src/shared/state/repo-configs'
import type { PanelComponent } from './types'
import { PRPanel } from './PRPanels'
import { CommitsPanel } from './CommitsPanel'
import { ChangedFilesPanel } from './ChangedFilesPanel'
import { AllFilesPanel } from './AllFilesPanel'
import { TodosPanel } from './TodosPanel'
import { AgentsPanel } from './AgentsPanel'
import { SubscriptionsPanel } from './SubscriptionsPanel'
import { CostPanel } from './CostPanel'
import { ContextPanel } from './ContextPanel'
import { ScratchpadPanel } from './ScratchpadPanel'

export const PANELS: Record<BuiltinRightPanelKey, PanelComponent> = {
  pr: PRPanel,
  commits: CommitsPanel,
  changedFiles: ChangedFilesPanel,
  allFiles: AllFilesPanel,
  todos: TodosPanel,
  agents: AgentsPanel,
  subscriptions: SubscriptionsPanel,
  cost: CostPanel,
  context: ContextPanel,
  scratchpad: ScratchpadPanel
}

// Same labels as RightColumnToolbar.tsx's LABELS.
export const PANEL_LABELS: Record<BuiltinRightPanelKey, string> = {
  pr: 'PR Status',
  commits: 'Branch Commits',
  changedFiles: 'Changed Files',
  allFiles: 'All Files',
  todos: 'Todos',
  agents: 'Agents',
  subscriptions: 'Subscriptions',
  cost: 'Cost',
  context: 'Context',
  scratchpad: 'Scratchpad'
}
