import { memo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection
} from '@dnd-kit/core'
import type { PaneNode, PaneLeaf, PaneSplit, AgentKind } from '../types'
import { getLeaves, findLeafByTabId } from '../../shared/state/terminals'
import { TerminalPanel } from './TerminalPanel'
import { XTerminal } from './XTerminal'
import { DiffView } from './DiffView'
import { FileView } from './FileView'
import { BrowserPanel } from './BrowserPanel'
import { JsonModeChat } from './JsonModeChat'
import { ReviewPane } from './ReviewPane'
import { ErrorBoundary } from './ErrorBoundary'
import { useBackend } from '../backend'

interface WorkspaceViewProps {
  worktreePath: string
  paneTree: PaneNode
  focusedPaneId: string
  visible: boolean
  nameAgentSessions: boolean
  repoLabel: string
  branch: string
  onSelectTab: (worktreePath: string, paneId: string, tabId: string) => void
  onFocusPane?: (worktreePath: string, paneId: string) => void
  onAddTab: (worktreePath: string, paneId?: string) => void
  defaultAgent: AgentKind
  onAddAgentTab: (worktreePath: string, agentKind?: AgentKind, paneId?: string) => void
  onAddBrowserTab: (worktreePath: string, paneId?: string) => void
  onAddJsonClaudeTab?: (worktreePath: string, paneId?: string) => void
  /** Convert a Claude tab between Terminal and Chat in place. */
  onConvertTabType?: (worktreePath: string, tabId: string, newType: 'agent' | 'json-claude') => void
  /** Drives whether the Sparkles button's plain click spawns Terminal
   *  ('xterm') or Chat ('json'), and which one the shift modifier flips
   *  to. */
  defaultClaudeTabType?: 'xterm' | 'json'
  onSleepTab: (worktreePath: string, tabId: string) => void
  onCloseTab: (worktreePath: string, tabId: string) => void
  onRestartAgentTab: (worktreePath: string, tabId: string) => void
  onReorderTabs: (worktreePath: string, paneId: string, fromId: string, toId: string) => void
  onMoveTabToPane: (worktreePath: string, tabId: string, toPaneId: string, toIndex?: number) => void
  onSendToAgent?: (worktreePath: string, text: string) => void
  /** Leading padding for the leftmost leaf's tab bar so it clears the macOS
   *  traffic lights when no sidebar sits to the left of the workspace. */
  topBarLeadingPx?: number
  /** Negative-margin extension on the top-left leaf's tab bar so the tab
   *  strip visually continues across the gap above the left sidebar (which
   *  is offset 40px from the top so the tab bar can claim that row). */
  topBarLeadingExtendPx?: number
  /** Negative-margin extension on the top-right leaf's tab bar so the tab
   *  strip visually continues across the gap above the right column (which
   *  is offset 40px from the top so the tab bar can claim that row). */
  topBarTrailingExtendPx?: number
  /** Hide the "Ness" title block — used when the sidebar above it is
   *  already showing the title, or in single-screen mode. The repo/branch
   *  label still clears the traffic lights via the leading padding. */
  hideAppTitle?: boolean
  crashedTabIds?: ReadonlySet<string>
}

function DebugCrashTrigger({ tabId }: { tabId: string }): JSX.Element {
  throw new Error(`debug: forced crash for tab ${tabId}`)
}

const collisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args)
  if (pointer.length > 0) return pointer
  return closestCenter(args)
}

function PaneDivider({
  direction,
  onResizeEnd
}: {
  direction: 'horizontal' | 'vertical'
  onResizeEnd: (delta: number) => void
}): JSX.Element {
  const lastPos = useRef(0)
  const accum = useRef(0)
  const isHorizontal = direction === 'horizontal'

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    lastPos.current = isHorizontal ? e.clientX : e.clientY
    accum.current = 0

    const onMove = (ev: MouseEvent) => {
      const pos = isHorizontal ? ev.clientX : ev.clientY
      accum.current += pos - lastPos.current
      lastPos.current = pos
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (accum.current !== 0) onResizeEnd(accum.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }

  if (isHorizontal) {
    return (
      <div className="w-px shrink-0 bg-border relative z-10">
        <div
          onMouseDown={handleMouseDown}
          className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
        />
      </div>
    )
  }
  return (
    <div className="h-px shrink-0 bg-border relative z-10">
      <div
        onMouseDown={handleMouseDown}
        className="absolute inset-x-0 -top-1 -bottom-1 cursor-row-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </div>
  )
}

function SplitRenderer({
  node,
  worktreePath,
  focusedPaneId,
  repoLabel,
  branch,
  nameAgentSessions,
  leafCount,
  isFirstLeaf,
  topLeftLeafId,
  topRightLeafId,
  topBarLeadingPx,
  topBarLeadingExtendPx,
  topBarTrailingExtendPx,
  hideAppTitle,
  registerSlot,
  onSelectTab,
  onFocusPane,
  onAddTab,
  defaultAgent,
  onAddAgentTab,
  onAddBrowserTab,
  onAddJsonClaudeTab,
  defaultClaudeTabType,
  onConvertTabType,
  onSleepTab,
  onCloseTab,
  onResizeEnd
}: {
  node: PaneNode
  worktreePath: string
  focusedPaneId: string
  repoLabel: string
  branch: string
  nameAgentSessions: boolean
  leafCount: number
  isFirstLeaf: { value: boolean }
  topLeftLeafId: string
  topRightLeafId: string
  topBarLeadingPx: number
  topBarLeadingExtendPx: number
  topBarTrailingExtendPx: number
  hideAppTitle?: boolean
  registerSlot: (paneId: string, el: HTMLDivElement | null) => void
  onSelectTab: (tabId: string, paneId: string) => void
  onFocusPane?: (paneId: string) => void
  onAddTab: (paneId: string) => void
  defaultAgent: AgentKind
  onAddAgentTab: (kind: AgentKind | undefined, paneId: string) => void
  onAddBrowserTab: (paneId: string) => void
  onAddJsonClaudeTab?: (paneId: string) => void
  defaultClaudeTabType?: 'xterm' | 'json'
  onConvertTabType?: (tabId: string, newType: 'agent' | 'json-claude') => void
  onSleepTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onResizeEnd: (splitId: string, delta: number, containerSize: number) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  if (node.type === 'leaf') {
    const showLabel = isFirstLeaf.value
    if (isFirstLeaf.value) isFirstLeaf.value = false
    return (
      <div
        className="flex-1 flex min-w-0 min-h-0"
        onMouseDownCapture={() => onFocusPane?.(node.id)}
      >
        <TerminalPanel
          worktreePath={worktreePath}
          pane={node}
          isFocused={node.id === focusedPaneId}
          paneCount={leafCount}
          repoLabel={showLabel ? repoLabel : ''}
          branch={showLabel ? branch : ''}
          registerSlot={registerSlot}
          onSelectTab={(tabId) => onSelectTab(tabId, node.id)}
          onAddTab={() => onAddTab(node.id)}
          defaultAgent={defaultAgent}
          onAddAgentTab={(kind) => onAddAgentTab(kind, node.id)}
          onAddBrowserTab={() => onAddBrowserTab(node.id)}
          onAddJsonClaudeTab={
            onAddJsonClaudeTab ? () => onAddJsonClaudeTab(node.id) : undefined
          }
          defaultClaudeTabType={defaultClaudeTabType}
          onConvertTabType={onConvertTabType}
          onSleepTab={onSleepTab}
          onCloseTab={onCloseTab}
          topBarLeadingPx={node.id === topLeftLeafId ? topBarLeadingPx : 0}
          topBarLeadingExtendPx={node.id === topLeftLeafId ? topBarLeadingExtendPx : 0}
          topBarTrailingExtendPx={node.id === topRightLeafId ? topBarTrailingExtendPx : 0}
          showAppTitle={node.id === topLeftLeafId && !hideAppTitle}
        />
      </div>
    )
  }

  const split = node as PaneSplit
  const isHorizontal = split.direction === 'horizontal'
  const firstPercent = `${split.ratio * 100}%`
  const secondPercent = `${(1 - split.ratio) * 100}%`

  return (
    <div
      ref={containerRef}
      className={`flex-1 flex ${isHorizontal ? 'flex-row' : 'flex-col'} min-w-0 min-h-0`}
    >
      <div
        className="flex min-w-0 min-h-0"
        style={{ flexBasis: firstPercent, flexGrow: 0, flexShrink: 0 }}
      >
        <SplitRenderer
          node={split.children[0]}
          worktreePath={worktreePath}
          focusedPaneId={focusedPaneId}
          repoLabel={repoLabel}
          branch={branch}
          nameAgentSessions={nameAgentSessions}
          leafCount={leafCount}
          isFirstLeaf={isFirstLeaf}
          topLeftLeafId={topLeftLeafId}
          topRightLeafId={topRightLeafId}
          topBarLeadingPx={topBarLeadingPx}
          topBarLeadingExtendPx={topBarLeadingExtendPx}
          topBarTrailingExtendPx={topBarTrailingExtendPx}
          hideAppTitle={hideAppTitle}
          registerSlot={registerSlot}
          onSelectTab={onSelectTab}
          onFocusPane={onFocusPane}
          onAddTab={onAddTab}
          defaultAgent={defaultAgent}
          onAddAgentTab={onAddAgentTab}
          onAddBrowserTab={onAddBrowserTab}
          onAddJsonClaudeTab={onAddJsonClaudeTab}
          defaultClaudeTabType={defaultClaudeTabType}
          onConvertTabType={onConvertTabType}
          onSleepTab={onSleepTab}
          onCloseTab={onCloseTab}
          onResizeEnd={onResizeEnd}
        />
      </div>
      <PaneDivider
        direction={split.direction}
        onResizeEnd={(delta) => {
          const el = containerRef.current
          if (!el) return
          const size = isHorizontal ? el.offsetWidth : el.offsetHeight
          onResizeEnd(split.id, delta, size)
        }}
      />
      <div className="flex flex-1 min-w-0 min-h-0">
        <SplitRenderer
          node={split.children[1]}
          worktreePath={worktreePath}
          focusedPaneId={focusedPaneId}
          repoLabel={repoLabel}
          branch={branch}
          nameAgentSessions={nameAgentSessions}
          leafCount={leafCount}
          isFirstLeaf={isFirstLeaf}
          topLeftLeafId={topLeftLeafId}
          topRightLeafId={topRightLeafId}
          topBarLeadingPx={topBarLeadingPx}
          topBarLeadingExtendPx={topBarLeadingExtendPx}
          topBarTrailingExtendPx={topBarTrailingExtendPx}
          hideAppTitle={hideAppTitle}
          registerSlot={registerSlot}
          onSelectTab={onSelectTab}
          onFocusPane={onFocusPane}
          onAddTab={onAddTab}
          defaultAgent={defaultAgent}
          onAddAgentTab={onAddAgentTab}
          onAddBrowserTab={onAddBrowserTab}
          onAddJsonClaudeTab={onAddJsonClaudeTab}
          defaultClaudeTabType={defaultClaudeTabType}
          onConvertTabType={onConvertTabType}
          onSleepTab={onSleepTab}
          onCloseTab={onCloseTab}
          onResizeEnd={onResizeEnd}
        />
      </div>
    </div>
  )
}

function WorkspaceViewInner({
  worktreePath,
  paneTree,
  focusedPaneId,
  visible,
  nameAgentSessions,
  onSelectTab,
  onFocusPane,
  onAddTab,
  defaultAgent,
  onAddAgentTab,
  onAddBrowserTab,
  onAddJsonClaudeTab,
  onConvertTabType,
  defaultClaudeTabType,
  onSleepTab,
  onCloseTab,
  onRestartAgentTab,
  onReorderTabs,
  onMoveTabToPane,
  onSendToAgent,
  repoLabel,
  branch,
  topBarLeadingPx = 0,
  topBarLeadingExtendPx = 0,
  topBarTrailingExtendPx = 0,
  hideAppTitle,
  crashedTabIds
}: WorkspaceViewProps): JSX.Element {
  const backend = useBackend()
  // Stable slot DOM elements keyed by pane.id. Created imperatively and
  // reparented as the pane tree changes, so a split (which causes the
  // source pane's TerminalPanel to unmount + remount at a deeper position)
  // does not destroy the portal target. If the slot were a React-owned
  // child of TerminalPanel, the unmount would detach it and the XTerminal
  // portal would briefly render to null — tripping the cleanup that kills
  // the PTY.
  const slotElsRef = useRef<Map<string, HTMLDivElement>>(new Map())

  const ensureSlot = useCallback((paneId: string): HTMLDivElement => {
    let slot = slotElsRef.current.get(paneId)
    if (!slot) {
      slot = document.createElement('div')
      slot.className = 'absolute inset-0'
      slotElsRef.current.set(paneId, slot)
    }
    return slot
  }, [])

  const attachSlot = useCallback(
    (paneId: string, host: HTMLDivElement | null) => {
      if (!host) return
      const slot = ensureSlot(paneId)
      if (slot.parentElement !== host) host.appendChild(slot)
    },
    [ensureSlot]
  )

  // Rising-edge wake: only fire panesWakeTab when a tab *just became*
  // the active tab in its leaf, never on a steady-state asleep tab.
  // That means right-click → Sleep stays slept (the tab's still active
  // in its leaf, but it didn't just become active), while a worktree
  // switch (visible flips false → true → empty prev set → every
  // current activeTab counts as just-activated) and an in-worktree
  // tab click (activeTabId changes) both wake.
  const prevActiveTabsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!visible) {
      prevActiveTabsRef.current = new Set()
      return
    }
    const next = new Set<string>()
    for (const leaf of getLeaves(paneTree)) {
      if (!leaf.activeTabId) continue
      next.add(leaf.activeTabId)
      if (prevActiveTabsRef.current.has(leaf.activeTabId)) continue
      const active = leaf.tabs.find((t) => t.id === leaf.activeTabId)
      if (
        active &&
        (active.type === 'json-claude' || active.type === 'shell') &&
        (active.mode ?? 'awake') === 'asleep'
      ) {
        void backend.panesWakeTab(worktreePath, active.id)
      }
    }
    prevActiveTabsRef.current = next
  }, [visible, paneTree, worktreePath])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  const leaves = getLeaves(paneTree)

  // Drop slots for leaves that no longer exist so the element can be GC'd
  // and, if a pane with the same id is ever re-created, it starts fresh.
  useEffect(() => {
    const current = new Set(leaves.map((l) => l.id))
    for (const [id, slot] of slotElsRef.current) {
      if (!current.has(id)) {
        slot.remove()
        slotElsRef.current.delete(id)
      }
    }
  }, [leaves])

  const findPaneOfTab = useCallback(
    (tabId: string): PaneLeaf | undefined => {
      return findLeafByTabId(paneTree, tabId) || undefined
    },
    [paneTree]
  )

  const resolveOverPane = useCallback(
    (overId: string): { pane: PaneLeaf; index: number } | null => {
      const leafDirect = leaves.find((l) => l.id === overId)
      if (leafDirect) {
        return { pane: leafDirect, index: leafDirect.tabs.length }
      }
      const pane = findPaneOfTab(overId)
      if (!pane) return null
      const idx = pane.tabs.findIndex((t) => t.id === overId)
      return { pane, index: idx === -1 ? pane.tabs.length : idx }
    },
    [leaves, findPaneOfTab]
  )

  const handleDragOver = useCallback(
    (event: DragOverEvent): void => {
      const { active, over } = event
      if (!over) return
      const activeId = String(active.id)
      const overId = String(over.id)
      if (activeId === overId) return
      const fromPane = findPaneOfTab(activeId)
      const to = resolveOverPane(overId)
      if (!fromPane || !to) return
      if (fromPane.id === to.pane.id) return
      onMoveTabToPane(worktreePath, activeId, to.pane.id, to.index)
    },
    [worktreePath, findPaneOfTab, resolveOverPane, onMoveTabToPane]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event
      if (!over) return
      const activeId = String(active.id)
      const overId = String(over.id)
      if (activeId === overId) return
      const fromPane = findPaneOfTab(activeId)
      const to = resolveOverPane(overId)
      if (!fromPane || !to) return
      if (fromPane.id === to.pane.id) {
        onReorderTabs(worktreePath, fromPane.id, activeId, overId)
      }
    },
    [worktreePath, findPaneOfTab, resolveOverPane, onReorderTabs]
  )

  const handleResizeEnd = useCallback(
    (splitId: string, delta: number, containerSize: number) => {
      if (containerSize === 0) return
      const ratioDelta = delta / containerSize
      void backend.panesSetRatio(worktreePath, splitId, Math.max(0.1, Math.min(0.9, findSplitRatio(paneTree, splitId) + ratioDelta)))
    },
    [worktreePath, paneTree]
  )

  const isFirstLeaf = { value: true }
  const topLeftLeafId = findTopLeftLeaf(paneTree).id
  const topRightLeafId = findTopRightLeaf(paneTree).id

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex-1 flex min-w-0 bg-app">
        <SplitRenderer
          node={paneTree}
          worktreePath={worktreePath}
          focusedPaneId={focusedPaneId}
          repoLabel={repoLabel}
          branch={branch}
          nameAgentSessions={nameAgentSessions}
          leafCount={leaves.length}
          isFirstLeaf={isFirstLeaf}
          topLeftLeafId={topLeftLeafId}
          topRightLeafId={topRightLeafId}
          topBarLeadingPx={topBarLeadingPx}
          topBarLeadingExtendPx={topBarLeadingExtendPx}
          topBarTrailingExtendPx={topBarTrailingExtendPx}
          hideAppTitle={hideAppTitle}
          registerSlot={attachSlot}
          onSelectTab={(tabId, paneId) => onSelectTab(worktreePath, paneId, tabId)}
          onFocusPane={onFocusPane ? (paneId) => onFocusPane(worktreePath, paneId) : undefined}
          onAddTab={(paneId) => onAddTab(worktreePath, paneId)}
          defaultAgent={defaultAgent}
          onAddAgentTab={(kind, paneId) => onAddAgentTab(worktreePath, kind, paneId)}
          onAddBrowserTab={(paneId) => onAddBrowserTab(worktreePath, paneId)}
          onAddJsonClaudeTab={
            onAddJsonClaudeTab
              ? (paneId) => onAddJsonClaudeTab(worktreePath, paneId)
              : undefined
          }
          onConvertTabType={
            onConvertTabType
              ? (tabId, newType) => onConvertTabType(worktreePath, tabId, newType)
              : undefined
          }
          defaultClaudeTabType={defaultClaudeTabType}
          onSleepTab={(tabId) => onSleepTab(worktreePath, tabId)}
          onCloseTab={(tabId) => onCloseTab(worktreePath, tabId)}
          onResizeEnd={handleResizeEnd}
        />
      </div>

      {leaves.flatMap((leaf) =>
        leaf.tabs.map((tab) => {
          const slot = ensureSlot(leaf.id)
          const isActiveInPane = leaf.activeTabId === tab.id
          return createPortal(
            <div
              className="absolute inset-0"
              data-tab-content
              style={{ display: isActiveInPane ? 'block' : 'none' }}
              onMouseDownCapture={() => onFocusPane?.(worktreePath, leaf.id)}
            >
              <ErrorBoundary label={`pane:${tab.type}:${tab.id}`}>
                {crashedTabIds?.has(tab.id) ? (
                  <DebugCrashTrigger tabId={tab.id} />
                ) : tab.type === 'diff' ? (
                  <DiffView
                    worktreePath={worktreePath}
                    filePath={tab.filePath}
                    staged={tab.staged ?? false}
                    branchDiff={tab.branchDiff ?? false}
                    commitHash={tab.commitHash}
                    onSendToAgent={
                      onSendToAgent
                        ? (text) => onSendToAgent(worktreePath, text)
                        : undefined
                    }
                  />
                ) : tab.type === 'file' ? (
                  <FileView
                    worktreePath={worktreePath}
                    filePath={tab.filePath}
                    onSendToAgent={
                      onSendToAgent
                        ? (text) => onSendToAgent(worktreePath, text)
                        : undefined
                    }
                  />
                ) : tab.type === 'browser' ? (
                  <BrowserPanel
                    tabId={tab.id}
                    visible={visible && isActiveInPane}
                    initialUrl={tab.url || 'about:blank'}
                  />
                ) : tab.type === 'json-claude' ? (
                  <JsonModeChat
                    sessionId={tab.id}
                    worktreePath={worktreePath}
                    mode={tab.mode ?? 'awake'}
                  />
                ) : tab.type === 'shell' && (tab.mode ?? 'awake') === 'asleep' ? (
                  // Skip XTerminal entirely while asleep — its mount
                  // path constructs an xterm.js Terminal, loads a stack
                  // of addons, calls getTerminalHistory, etc., even when
                  // hidden. The rising-edge wake effect above fires
                  // panesWakeTab when the worktree becomes visible AND
                  // this is the active tab in its leaf, so the user
                  // doesn't see the placeholder in practice.
                  <div className="absolute inset-0 bg-app" />
                ) : tab.type === 'review' ? (
                  <ReviewPane
                    tabId={tab.id}
                    worktreePath={worktreePath}
                    fromCommit={tab.reviewFromCommit}
                    toCommit={tab.reviewToCommit}
                    onSendToAgent={
                      onSendToAgent
                        ? (text) => onSendToAgent(worktreePath, text)
                        : undefined
                    }
                  />
                ) : (
                  <XTerminal
                    terminalId={tab.id}
                    cwd={worktreePath}
                    type={tab.type as 'agent' | 'shell'}
                    agentKind={tab.agentKind}
                    visible={visible && isActiveInPane}
                    sessionName={tab.type === 'agent' && nameAgentSessions ? `${repoLabel}/${branch}` : undefined}
                    sessionId={tab.sessionId}
                    initialPrompt={tab.initialPrompt}
                    teleportSessionId={tab.teleportSessionId}
                    modelOverride={tab.type === 'agent' ? tab.model : undefined}
                    shellCwd={tab.type === 'shell' ? tab.cwd : undefined}
                    onRestartAgent={
                      tab.type === 'agent'
                        ? (): void => onRestartAgentTab(worktreePath, tab.id)
                        : undefined
                    }
                    onSwitchToChat={
                      tab.type === 'agent' && tab.agentKind === 'claude' && onConvertTabType
                        ? (): void => onConvertTabType(worktreePath, tab.id, 'json-claude')
                        : undefined
                    }
                  />
                )}
              </ErrorBoundary>
            </div>,
            slot,
            tab.id
          )
        })
      )}
    </DndContext>
  )
}

// App keeps every worktree mounted, so this component exists ~N times over and
// every App render re-rendered all of them. Memo is only sound now that the
// whole `statuses` / `shellActivity` maps are no longer props — they changed
// identity on every streamed token, which would have made this a no-op.
export const WorkspaceView = memo(WorkspaceViewInner)

function findTopLeftLeaf(node: PaneNode): PaneLeaf {
  if (node.type === 'leaf') return node
  return findTopLeftLeaf(node.children[0])
}

function findTopRightLeaf(node: PaneNode): PaneLeaf {
  if (node.type === 'leaf') return node
  const next = node.direction === 'horizontal' ? node.children[1] : node.children[0]
  return findTopRightLeaf(next)
}

function findSplitRatio(node: PaneNode, splitId: string): number {
  if (node.type === 'leaf') return 0.5
  if (node.id === splitId) return node.ratio
  const found = findSplitRatioInner(node.children[0], splitId)
  if (found !== null) return found
  return findSplitRatioInner(node.children[1], splitId) ?? 0.5
}

function findSplitRatioInner(node: PaneNode, splitId: string): number | null {
  if (node.type === 'leaf') return null
  if (node.id === splitId) return node.ratio
  return (
    findSplitRatioInner(node.children[0], splitId) ??
    findSplitRatioInner(node.children[1], splitId)
  )
}
