import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { X, SquareTerminal, Sparkles, Loader2, Globe, Users, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { WorkspacePane, TerminalTab, PtyStatus, AgentKind } from '../types'
import { AGENT_REGISTRY, agentDisplayName } from '../../shared/agent-registry'
import { Tooltip } from './Tooltip'
import { AgentIcon } from './AgentIcon'
import { repoNameColor } from './RepoIcon'
import { AppTitleSegment } from './AppTitleSegment'
import {
  getClientId,
  useTerminalProgress,
  useTerminalSession,
  useTerminalStatus,
  useShellActivity,
  useAliasForPath
} from '../store'
import { useBackend } from '../backend'
import { useReviewProgress } from '../review-progress'

/** Chip shown in the tab bar when other clients are attached to the
 *  active terminal. Click-through is intentional — taking/releasing
 *  control lives on the terminal body, not here. */
function SpectatorChip({ terminalId }: { terminalId: string }): JSX.Element | null {
  const session = useTerminalSession(terminalId)
  if (!session) return null
  const myId = getClientId()
  // Other viewers: everyone who isn't me, counted across controller + spectators.
  const others = new Set<string>()
  if (session.controllerClientId && session.controllerClientId !== myId) {
    others.add(session.controllerClientId)
  }
  for (const id of session.spectatorClientIds) {
    if (id !== myId) others.add(id)
  }
  if (others.size === 0) return null
  const controllerLabel =
    session.controllerClientId === null
      ? 'No controller'
      : session.controllerClientId === myId
        ? 'You have control'
        : `Controller: ${shortId(session.controllerClientId)}`
  const spectatorLines = session.spectatorClientIds
    .filter((id) => id !== myId)
    .map((id) => `Spectator: ${shortId(id)}`)
  const tip = [controllerLabel, ...spectatorLines].join('\n')
  return (
    <Tooltip label={tip}>
      <div className="no-drag shrink-0 flex items-center gap-1 px-2 h-full text-xs text-dim">
        <Users className="icon-xs" />
        <span>{others.size}</span>
      </div>
    </Tooltip>
  )
}

function shortId(id: string): string {
  return id.slice(0, 6)
}

interface TerminalPanelProps {
  worktreePath: string
  pane: WorkspacePane
  isFocused: boolean
  paneCount: number
  repoLabel: string
  branch: string
  registerSlot: (paneId: string, el: HTMLDivElement | null) => void
  onSelectTab: (tabId: string) => void
  onAddTab: () => void
  onAddAgentTab: (agentKind?: AgentKind) => void
  onAddBrowserTab: () => void
  /** Shift-clicking the Sparkles button opens the non-default Claude
   *  interface (Terminal if Chat is the default, Chat if Terminal is). */
  onAddJsonClaudeTab?: () => void
  /** Controls which Claude interface plain-click on Sparkles spawns vs.
   *  what shift-click flips to. Values are unchanged internal identifiers
   *  — UI labels them "Terminal" and "Chat". */
  defaultClaudeTabType?: 'xterm' | 'json'
  /** Convert a Claude tab between Terminal and Chat in place. */
  onConvertTabType?: (tabId: string, newType: 'agent' | 'json-claude') => void
  defaultAgent: AgentKind
  onSleepTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  /** Leading padding on the tab bar to clear the macOS traffic lights when
   *  no sidebar sits to the left of this pane. Set per-leaf by WorkspaceView
   *  to the leftmost leaf only. */
  topBarLeadingPx?: number
  /** Negative left margin on the tab bar so it visually extends across the
   *  empty space above the left sidebar (which sits 40px down from the top).
   *  Set per-leaf by WorkspaceView to the topmost-left leaf only. */
  topBarLeadingExtendPx?: number
  /** Negative right margin on the tab bar so it visually extends across the
   *  empty space above the right column (which sits 40px down from the top).
   *  Set per-leaf by WorkspaceView to the topmost-right leaf only. */
  topBarTrailingExtendPx?: number
  /** Render the "Ness" app title at the start of the tab bar. Set true
   *  on the top-left leaf only so the title appears once per workspace. */
  showAppTitle?: boolean
}

const TAB_STATUS_DOT: Record<PtyStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger'
}

interface SortableTabProps {
  tab: TerminalTab
  isActive: boolean
  showClose: boolean
  onSelect: () => void
  onClose: () => void
  /** When provided, right-clicking the tab opens a small menu to convert
   *  between Terminal and Chat. Passed in only for Claude tabs (agent
   *  with agentKind=claude, or json-claude). */
  onConvertTabType?: (newType: 'agent' | 'json-claude') => void
  /** Optional: when provided AND the tab is an awake json-claude tab,
   *  the right-click menu shows a "Sleep" item. Sleeping tears down
   *  the subprocess but leaves the tab record intact. */
  onSleepTab?: () => void
  /** Commit a renamed label. Empty/whitespace clears the override. */
  onRename: (label: string) => void
}

// Interactive session tabs (Claude/agent terminals, raw shells, chat) and
// browser tabs carry a user-meaningful name. The remaining content tabs
// (diff/file/review) are driven by what they're showing, so renaming them
// is disallowed.
const RENAMEABLE_TAB_TYPES = new Set<TerminalTab['type']>(['agent', 'shell', 'json-claude', 'browser'])

const PROGRESS_COLOR: Record<1 | 2 | 3 | 4, string> = {
  1: 'bg-success',
  2: 'bg-danger',
  3: 'bg-fg-bright',
  4: 'bg-warning'
}

function TabProgressBar({ terminalId }: { terminalId: string }): JSX.Element | null {
  const progress = useTerminalProgress(terminalId)
  if (!progress || progress.state === 0) return null
  const color = PROGRESS_COLOR[progress.state]
  // State 3 = indeterminate: full-width bar with a pulse animation.
  if (progress.state === 3) {
    return (
      <div className="absolute left-0 right-0 bottom-0 h-[2px] pointer-events-none">
        <div className={`h-full w-full ${color} animate-pulse`} />
      </div>
    )
  }
  const pct = Math.max(0, Math.min(100, progress.value))
  return (
    <div className="absolute left-0 right-0 bottom-0 h-[2px] pointer-events-none">
      <div
        className={`h-full ${color} transition-[width] duration-150`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function SortableTab({ tab, isActive, showClose, onSelect, onClose, onConvertTabType, onSleepTab, onRename }: SortableTabProps): JSX.Element {
  // Read per-tab rather than taking the whole statuses/shellActivity maps as
  // props: a single terminal's status change used to allocate a new map and
  // re-render every mounted worktree's subtree. Same pattern as
  // TabProgressBar / SpectatorChip above.
  const status = useTerminalStatus(tab.id)
  const shellActivity = useShellActivity(tab.id) ?? undefined
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id
  })
  const localRef = useRef<HTMLDivElement | null>(null)
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      localRef.current = el
      setNodeRef(el)
    },
    [setNodeRef]
  )
  useEffect(() => {
    if (isActive && localRef.current) {
      localRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [isActive])
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1
  }
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const canRename = RENAMEABLE_TAB_TYPES.has(tab.type)
  const canSleep = !!onSleepTab && tab.type === 'json-claude' && (tab.mode ?? 'awake') === 'awake'
  const canConvert = !!onConvertTabType && (tab.type === 'agent' || tab.type === 'json-claude')
  const hasMenuItems = canRename || canSleep || canConvert
  const reviewProgress = useReviewProgress(tab.type === 'review' ? tab.id : '')
  const baseLabel = tab.customLabel ?? tab.label
  const displayLabel =
    tab.type === 'review' && reviewProgress && !tab.customLabel
      ? `${tab.label} (${reviewProgress.reviewed}/${reviewProgress.total})`
      : baseLabel
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(displayLabel)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const startEditing = useCallback(() => {
    if (!canRename) return
    setEditValue(displayLabel)
    setEditing(true)
  }, [canRename, displayLabel])
  useEffect(() => {
    if (editing) {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    }
  }, [editing])
  const commitEdit = useCallback(() => {
    if (!editing) return
    setEditing(false)
    const next = editValue.trim()
    const current = tab.customLabel ?? ''
    if (next === current) return
    // Typing the auto-label exactly is treated as clearing — otherwise we'd
    // pin a customLabel that happens to match the default and look the same
    // until the underlying label changes.
    if (next === tab.label) {
      if (current !== '') onRename('')
      return
    }
    onRename(next)
  }, [editing, editValue, tab.customLabel, tab.label, onRename])
  const cancelEdit = useCallback(() => {
    setEditing(false)
    setEditValue(displayLabel)
  }, [displayLabel])
  // Cmd+L hotkey path: App-level handler dispatches a window CustomEvent
  // naming the tabId; the matching SortableTab self-activates edit mode.
  // A custom event keeps the editing state local to this component
  // instead of threading another prop down through WorkspaceView.
  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ tabId?: string }>
      if (ce.detail?.tabId === tab.id) startEditing()
    }
    window.addEventListener('harness:rename-tab', handler)
    return () => window.removeEventListener('harness:rename-tab', handler)
  }, [tab.id, startEditing])
  return (
    <div
      ref={setRefs}
      style={style}
      {...attributes}
      {...listeners}
      className={`no-drag relative shrink-0 flex items-center gap-1.5 px-3 h-full text-xs cursor-pointer border-b-2 border-l border-l-border [&:first-child]:border-l-0 whitespace-nowrap transition-colors ${
        isActive
          ? 'border-b-muted text-fg-bright'
          : 'border-b-transparent text-dim hover:text-fg'
      }`}
      onClick={(e) => {
        // dnd-kit's pointer sensor swallows the native dblclick event, so
        // detect double-clicks via MouseEvent.detail instead.
        if (e.detail >= 2) {
          e.preventDefault()
          e.stopPropagation()
          startEditing()
          return
        }
        onSelect()
      }}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault()
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && showClose) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!hasMenuItems) return
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {tab.type === 'shell' ? (
        shellActivity?.active ? (
          <Loader2
            className="icon-2xs animate-spin text-fg-bright"
            aria-label={`Running: ${shellActivity.processName || '?'}`} />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-faint" />
        )
      ) : tab.type !== 'diff' && tab.type !== 'file' && tab.type !== 'review' ? (
        <span className={`w-1.5 h-1.5 rounded-full ${TAB_STATUS_DOT[status]}`} />
      ) : null}
      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitEdit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelEdit()
            }
            e.stopPropagation()
          }}
          onBlur={commitEdit}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="bg-transparent outline-none border-b border-muted text-fg-bright px-0 w-24 min-w-0"
          aria-label="Rename tab"
        />
      ) : (
        <span>{displayLabel}</span>
      )}
      <TabProgressBar terminalId={tab.id} />
      {showClose && (
        <Tooltip label="Close tab" action="closeTab">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className="ml-1 text-faint hover:text-fg transition-colors"
          >
            <X className="icon-2xs" />
          </button>
        </Tooltip>
      )}
      {menu && (
        <div
          className="fixed z-50 bg-panel-raised border border-border-strong rounded shadow-lg text-xs py-1 min-w-[12rem]"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {canRename && (
            <button
              className="block w-full text-left px-3 py-1.5 hover:bg-panel text-fg-bright cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                startEditing()
              }}
            >
              Rename Tab
            </button>
          )}
          {canRename && tab.customLabel !== undefined && (
            <button
              className="block w-full text-left px-3 py-1.5 hover:bg-panel text-fg-bright cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                onRename('')
              }}
            >
              Reset Name
            </button>
          )}
          {canSleep && (
            <button
              className="block w-full text-left px-3 py-1.5 hover:bg-panel text-fg-bright cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                onSleepTab()
              }}
            >
              Sleep
            </button>
          )}
          {onConvertTabType && tab.type === 'agent' && (
            <button
              className="block w-full text-left px-3 py-1.5 hover:bg-panel text-fg-bright cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                onConvertTabType('json-claude')
              }}
            >
              Switch to Chat mode
            </button>
          )}
          {onConvertTabType && tab.type === 'json-claude' && (
            <button
              className="block w-full text-left px-3 py-1.5 hover:bg-panel text-fg-bright cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                setMenu(null)
                onConvertTabType('agent')
              }}
            >
              Switch to Terminal mode
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AgentNewTabControls({
  defaultAgent,
  defaultClaudeTabType,
  onAddAgentTab,
  onAddJsonClaudeTab
}: {
  defaultAgent: AgentKind
  defaultClaudeTabType?: 'xterm' | 'json'
  onAddAgentTab: (agentKind?: AgentKind) => void
  onAddJsonClaudeTab?: () => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const chatIsDefault = !!onAddJsonClaudeTab && defaultClaudeTabType === 'json'

  const agentsInMenu = useMemo(() => {
    const rest = AGENT_REGISTRY.filter((a) => a.kind !== defaultAgent)
    const first = AGENT_REGISTRY.find((a) => a.kind === defaultAgent)
    return first ? [first, ...rest] : AGENT_REGISTRY
  }, [defaultAgent])

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const sparkleTip = (() => {
    const plain = chatIsDefault
      ? 'New Chat tab'
      : `New ${agentDisplayName(defaultAgent)} tab`
    const shiftPart = onAddJsonClaudeTab
      ? chatIsDefault
        ? ' · ⇧-click for Terminal mode'
        : ' · ⇧-click for Chat mode'
      : ''
    return plain + shiftPart
  })()

  return (
    <div className="no-drag relative flex items-center h-full shrink-0" ref={menuRef}>
      <Tooltip label={sparkleTip}>
        <button
          type="button"
          onClick={(e) => {
            if (e.shiftKey && onAddJsonClaudeTab) {
              if (chatIsDefault) onAddAgentTab('claude')
              else onAddJsonClaudeTab()
              return
            }
            if (chatIsDefault) onAddJsonClaudeTab!()
            else onAddAgentTab(defaultAgent)
          }}
          className="shrink-0 pl-2 pr-1 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
        >
          <Sparkles className="icon-xs" />
        </button>
      </Tooltip>
      <Tooltip label="Choose agent">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label="Choose agent"
          className="shrink-0 pl-0.5 pr-1.5 h-full text-faint hover:text-fg transition-colors cursor-pointer"
        >
          <ChevronDown className={'icon-2xs transition-transform ' + (menuOpen ? 'rotate-180' : '')} />
        </button>
      </Tooltip>
      {menuOpen && (
        <div
          className="absolute left-0 top-full z-50 min-w-[11rem] rounded border border-border bg-panel-raised shadow-lg py-1"
          role="menu"
        >
          {agentsInMenu.map((agent) => (
            <button
              key={agent.kind}
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-fg-bright hover:bg-panel cursor-pointer text-left"
              onClick={() => {
                onAddAgentTab(agent.kind)
                setMenuOpen(false)
              }}
            >
              <AgentIcon kind={agent.kind} className="icon-xs shrink-0" />
              <span className="flex-1">{agent.displayName}</span>
              {agent.kind === defaultAgent && !chatIsDefault && (
                <span className="text-faint shrink-0">default</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TerminalPanel({
  worktreePath,
  pane,
  paneCount,
  repoLabel,
  branch,
  registerSlot,
  onSelectTab,
  onAddTab,
  onAddAgentTab,
  onAddBrowserTab,
  onAddJsonClaudeTab,
  defaultClaudeTabType,
  onConvertTabType,
  defaultAgent,
  onSleepTab,
  onCloseTab,
  topBarLeadingPx = 0,
  topBarLeadingExtendPx = 0,
  topBarTrailingExtendPx = 0,
  showAppTitle = false
}: TerminalPanelProps): JSX.Element {
  const backend = useBackend()
  const alias = useAliasForPath(worktreePath)
  const { setNodeRef: setPaneDropRef } = useDroppable({ id: pane.id })
  const slotHostRef = useRef<HTMLDivElement | null>(null)

  // Register this pane's slot host with WorkspaceView. WorkspaceView owns a
  // stable slot DOM element per pane.id and appends it into whichever host
  // currently exists, so a split (which unmounts + remounts this panel at a
  // deeper tree position) does not destroy the xterm portal's target.
  useEffect(() => {
    registerSlot(pane.id, slotHostRef.current)
  }, [pane.id, registerSlot])

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId)
  // Spectator chip only makes sense for terminal-backed tabs. Chat tabs
  // re-render per client, so the controller/spectator concept doesn't
  // apply.
  const showSpectatorChip =
    !!activeTab && (activeTab.type === 'agent' || activeTab.type === 'shell')

  const tabScrollRef = useRef<HTMLDivElement | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const updateTabScroll = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])
  useEffect(() => {
    updateTabScroll()
  }, [pane.tabs.length, updateTabScroll])
  useEffect(() => {
    const el = tabScrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateTabScroll)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateTabScroll])
  const scrollTabsBy = useCallback((dx: number) => {
    tabScrollRef.current?.scrollBy({ left: dx, behavior: 'smooth' })
  }, [])

  return (
    <div ref={setPaneDropRef} className="flex-1 flex flex-col min-w-0 bg-app">
      {/* Tab bar — marginLeft extends the bar to the window's left edge;
          paddingLeft is the absolute distance from that edge to first
          content (set to clear the macOS traffic lights), so the title
          stays pinned regardless of sidebar collapse state. */}
      <div
        className="drag-region flex items-center border-b border-border bg-panel h-10 shrink-0 relative z-10"
        style={
          topBarLeadingPx > 0 || topBarLeadingExtendPx > 0 || topBarTrailingExtendPx > 0
            ? {
                paddingLeft: topBarLeadingPx > 0 ? topBarLeadingPx : undefined,
                marginLeft: topBarLeadingExtendPx > 0 ? -topBarLeadingExtendPx : undefined,
                marginRight: topBarTrailingExtendPx > 0 ? -topBarTrailingExtendPx : undefined
              }
            : undefined
        }
      >
        {showAppTitle && <AppTitleSegment />}
        {repoLabel && (
          <Tooltip
            label={alias ? `${repoLabel} / ${alias} · ${branch}` : `${repoLabel} / ${branch}`}
            side="bottom"
          >
            <div
              className="no-drag shrink-0 flex items-baseline gap-1.5 px-3 h-full text-xs whitespace-nowrap"
              style={{ alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}
            >
              <span className={`font-medium ${repoNameColor(repoLabel)}`}>{repoLabel}</span>
              <span className="text-faint">/</span>
              <span className="text-fg-bright font-medium">{alias ?? branch}</span>
            </div>
          </Tooltip>
        )}
        <div className="no-drag shrink-0 flex items-center h-full pl-2">
        <AgentNewTabControls
          defaultAgent={defaultAgent}
          defaultClaudeTabType={defaultClaudeTabType}
          onAddAgentTab={onAddAgentTab}
          onAddJsonClaudeTab={onAddJsonClaudeTab}
        />
          <Tooltip label="New shell tab" action="newShellTab">
            <button
              onClick={onAddTab}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <SquareTerminal className="icon-xs" />
            </button>
          </Tooltip>
          <Tooltip label="New browser tab">
            <button
              onClick={onAddBrowserTab}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <Globe className="icon-xs" />
            </button>
          </Tooltip>
        </div>
        <div className="shrink-0 w-px h-4 bg-border-strong mx-1" />
        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scrollTabsBy(-200)}
            aria-label="Scroll tabs left"
            className="no-drag shrink-0 px-1 h-full text-faint hover:text-fg transition-colors cursor-pointer"
          >
            <ChevronLeft className="icon-sm" />
          </button>
        )}
        <div
          ref={tabScrollRef}
          onScroll={updateTabScroll}
          className="flex items-center h-full overflow-x-auto scrollbar-hidden flex-1 min-w-0"
        >
          <SortableContext items={pane.tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {pane.tabs.map((tab) => {
              const isClaudeAgent = tab.type === 'agent' && tab.agentKind === 'claude'
              const isJsonClaude = tab.type === 'json-claude'
              const convertible = !!onConvertTabType && (isClaudeAgent || isJsonClaude)
              return (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === pane.activeTabId}
                  showClose={pane.tabs.length > 1 || paneCount > 1}
                  onSelect={() => onSelectTab(tab.id)}
                  onClose={() => onCloseTab(tab.id)}
                  onConvertTabType={
                    convertible
                      ? (newType) => onConvertTabType!(tab.id, newType)
                      : undefined
                  }
                  onSleepTab={
                    isJsonClaude ? () => onSleepTab(tab.id) : undefined
                  }
                  onRename={(label) => {
                    void backend.panesRenameTab(worktreePath, tab.id, label)
                  }}
                />
              )
            })}
          </SortableContext>
        </div>
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scrollTabsBy(200)}
            aria-label="Scroll tabs right"
            className="no-drag shrink-0 px-1 h-full text-faint hover:text-fg transition-colors cursor-pointer"
          >
            <ChevronRight className="icon-sm" />
          </button>
        )}
        {showSpectatorChip && activeTab && <SpectatorChip terminalId={activeTab.id} />}
      </div>

      {/* Content slot host — WorkspaceView imperatively appends a stable
          slot div (the portal target for xterm/diff content) into this host.
          The host is empty from React's perspective; see slotHostRef. */}
      <div ref={slotHostRef} className="flex-1 relative min-h-0" />
    </div>
  )
}
