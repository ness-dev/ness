import type { ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowUp,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Code2,
  FilePlus,
  FolderOpen,
  GitMerge,
  GitPullRequest,
  Globe,
  Keyboard,
  Layers,
  LayoutGrid,
  ListTodo,
  ListTree,
  Loader2,
  Menu,
  PanelLeftClose,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wand2,
  X,
  BookOpen,
  ListChecks,
  Map as MapIcon
} from 'lucide-react'
import { MockChat, type MockTranscript } from './MockChat'
import { NessMark } from './NessMark'

export type MockStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval' | 'merged'

export interface MockWorktree {
  id: string
  branch: string
  path: string
  status: MockStatus
  /** Rendered in the row's detail cluster, same as the app's worktree age. */
  age: string
  /** The worktree's Chat tab. Absent renders the chat's empty state. */
  chat?: MockTranscript
  /** What the right column's Commits and Changed Files panels list. Absent
   * renders their empty states. */
  changes?: MockChanges
  pr?: {
    number: number
    title: string
    checks: 'success' | 'failure' | 'pending' | 'none'
    additions: number
    deletions: number
    milestone?: string
  }
}

export interface MockCommit {
  sha: string
  msg: string
  pushed: boolean
}

export interface MockChangedFile {
  path: string
  kind: 'A' | 'M'
  add: number
  del: number
}

export interface MockChanges {
  commits: MockCommit[]
  uncommitted: MockChangedFile[]
  committed: MockChangedFile[]
}

export type HighlightedElement =
  | 'sidebar'
  | 'worktree-row'
  | 'new-worktree-button'
  | 'terminal'
  | 'right-column-button'
  | null

export type PanelMode = 'terminal' | 'new-worktree-flow'

export interface MockHarnessState {
  activeWorktreeId: string
  /** Must be non-empty: an unknown `activeWorktreeId` (e.g. 'new' while the
   * New worktree screen is up) falls back to the first entry. */
  worktrees: MockWorktree[]
  highlightedElement: HighlightedElement
  highlightedWorktreeId?: string
  panelMode: PanelMode
  /** Optional count shown on the (always-collapsed) Merged / Closed header. */
  mergedClosedCount?: number
  /** When true the right column is expanded; otherwise it renders as the
   * 48px icon rail the real app collapses to. */
  rightPanelOpen?: boolean
}

/** Widths lifted from the renderer's defaults so the proportions match. */
const SIDEBAR_WIDTH = 224
const RIGHT_COLUMN_WIDTH = 256
const RIGHT_RAIL_WIDTH = 48
/** Leading clearance for the macOS traffic lights (renderer: `titlebar-lead`). */
const TITLEBAR_LEAD = 72

const REPO_NAME = 'ness'
/** `repoNameColor('ness')` in the renderer resolves to this. */
const REPO_NAME_COLOR = 'text-cyan-400'

const STATUS_COLORS: Record<MockStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent'
}

const TAB_STATUS_COLORS: Record<MockStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger',
  merged: 'bg-accent'
}

const PR_ICON_COLOR: Record<'success' | 'failure' | 'pending' | 'none', string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim'
}

export function MockHarness({ state }: { state: MockHarnessState }) {
  const newWorktreeScreen = state.panelMode === 'new-worktree-flow'
  return (
    <div
      className="relative w-full h-full rounded-xl overflow-hidden border border-border-strong shadow-2xl shadow-black/70 bg-app flex flex-col font-sans select-none"
      style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}
    >
      <TrafficLights />

      {/* Title row — the Ness wordmark sits above the sidebar, the pane tab
          bar runs across the rest of the window (and over the right column,
          exactly as the real top bar extends). */}
      <div className="h-10 shrink-0 flex items-stretch relative z-10">
        <div
          className="shrink-0 flex items-stretch border-b border-border-strong bg-panel"
          style={{ width: SIDEBAR_WIDTH, paddingLeft: TITLEBAR_LEAD }}
        >
          <AppTitleSegment />
        </div>
        <div className="w-px shrink-0 bg-border-strong" />
        {newWorktreeScreen ? (
          <div className="flex-1 flex items-center justify-end pr-2">
            <span className="text-dim p-1.5 rounded">
              <X size={16} />
            </span>
          </div>
        ) : (
          <MockTabBar state={state} />
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        <MockSidebar state={state} />
        <div className="w-px shrink-0 bg-border-strong" />
        <AnimatePresence mode="wait" initial={false}>
          {newWorktreeScreen ? (
            <motion.div
              key="new-worktree"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.55, ease: 'easeOut' }}
              className="flex-1 flex flex-col min-w-0"
            >
              <MockNewWorktreeScreen />
            </motion.div>
          ) : (
            <motion.div
              key="terminal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.55, ease: 'easeOut' }}
              className="flex-1 flex min-w-0"
            >
              <MockTerminalPanel state={state} />
            </motion.div>
          )}
        </AnimatePresence>
        {!newWorktreeScreen && <MockRightColumn state={state} />}
      </div>
    </div>
  )
}

function activeWorktree(state: MockHarnessState): MockWorktree {
  return state.worktrees.find((w) => w.id === state.activeWorktreeId) ?? state.worktrees[0]
}

function TrafficLights() {
  return (
    <div className="absolute top-0 left-0 h-10 flex items-center gap-2 px-4 z-20 pointer-events-none">
      <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
      <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
      <span className="w-3 h-3 rounded-full bg-[#28c840]" />
    </div>
  )
}

function AppTitleSegment() {
  return (
    <div className="flex-1 min-w-0 flex items-center h-full px-3 text-sm font-semibold whitespace-nowrap bg-app/40">
      <NessMark className="h-3 w-auto shrink-0 mr-1.5 text-brand" />
      <span className="gradient-text">Ness</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function MockSidebar({ state }: { state: MockHarnessState }) {
  const sidebarGlow = state.highlightedElement === 'sidebar'

  const needsAttention = state.worktrees.filter((w) => w.pr?.checks === 'failure')
  const openPRs = state.worktrees.filter((w) => w.pr && w.pr.checks !== 'failure')
  const activeNoPR = state.worktrees.filter((w) => !w.pr)
  const mergedCount = state.mergedClosedCount ?? 3

  const renderGroup = (label: string, rows: MockWorktree[]) =>
    rows.length > 0 && (
      <>
        <GroupHeader label={label} count={rows.length} expanded />
        {rows.map((wt) => (
          <MockWorktreeRow
            key={wt.id}
            worktree={wt}
            isActive={wt.id === state.activeWorktreeId}
            highlighted={
              state.highlightedElement === 'worktree-row' && wt.id === state.highlightedWorktreeId
            }
          />
        ))}
      </>
    )

  return (
    <motion.div
      animate={{
        boxShadow: sidebarGlow
          ? 'inset 0 0 0 1px rgba(74, 222, 128, 0.55), inset 0 0 48px rgba(74, 222, 128, 0.10)'
          : 'inset 0 0 0 0px rgba(74, 222, 128, 0)'
      }}
      transition={{ type: 'spring', stiffness: 200, damping: 30 }}
      className="shrink-0 bg-panel flex flex-col h-full relative"
      style={{ width: SIDEBAR_WIDTH }}
    >
      <div className="px-3 py-3 flex items-center gap-2 shrink-0">
        <PanelLeftClose size={12} className="text-dim" />
        <span className="text-xs font-medium text-dim">WORKTREES</span>
        <div className="ml-auto flex items-center gap-1 text-dim">
          <ListTodo size={12} />
          <Trash2 size={12} />
          <Layers size={12} />
          <RefreshCw size={12} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        <AddWorktreeRow highlighted={state.highlightedElement === 'new-worktree-button'} />
        {renderGroup('Needs Attention', needsAttention)}
        {renderGroup('Open PRs', openPRs)}
        {renderGroup('Active', activeNoPR)}
        <GroupHeader label="Merged / Closed" count={mergedCount} expanded={false} />
      </div>

      <BottomIconStrip />
    </motion.div>
  )
}

function GroupHeader({
  label,
  count,
  expanded
}: {
  label: string
  count: number
  expanded: boolean
}) {
  return (
    <div className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-dim">
      {expanded ? (
        <ChevronDown size={12} className="shrink-0" />
      ) : (
        <ChevronRight size={12} className="shrink-0" />
      )}
      <span className="font-medium">{label}</span>
      <span className="text-faint ml-auto">{count}</span>
    </div>
  )
}

/** The app puts "Add worktree" at the top of each repo section, with the
 * hotkey badge trailing. */
function AddWorktreeRow({ highlighted }: { highlighted: boolean }) {
  return (
    <motion.div
      animate={{
        boxShadow: highlighted
          ? '0 0 24px rgba(74, 222, 128, 0.30)'
          : '0 0 0px rgba(74, 222, 128, 0)'
      }}
      transition={{ type: 'spring', stiffness: 220, damping: 24 }}
      className={`group relative w-full flex items-center gap-2 px-3 py-1.5 text-dim hover:bg-panel-raised overflow-hidden cursor-pointer transition-colors ${
        highlighted ? 'brand-gradient-flow-text-active bg-panel-raised' : ''
      }`}
    >
      <span
        className={`absolute left-0 top-0 bottom-0 w-0.5 brand-gradient-flow-bar transition-opacity ${
          highlighted ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      />
      <Plus
        size={14}
        className="shrink-0 transition-colors"
        style={highlighted ? { stroke: 'var(--color-brand)' } : undefined}
      />
      <span className="text-sm font-medium brand-gradient-flow-text-hover">Add worktree</span>
      <HotkeyBadge binding="⌘T" className="ml-auto" />
    </motion.div>
  )
}

function HotkeyBadge({ binding, className = '' }: { binding: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center text-xs leading-none rounded px-1 py-0.5 select-none whitespace-nowrap shrink-0 bg-app/60 border border-border text-faint ${className}`}
    >
      {binding}
    </span>
  )
}

function MockWorktreeRow({
  worktree,
  isActive,
  highlighted
}: {
  worktree: MockWorktree
  isActive: boolean
  highlighted: boolean
}) {
  const glowColor = worktree.status === 'needs-approval' ? '239, 68, 68' : '74, 222, 128'
  return (
    <div className={isActive ? 'bg-surface' : ''}>
      <motion.div
        animate={{
          boxShadow: highlighted
            ? `inset 0 0 0 1px rgba(${glowColor}, 0.55), 0 0 18px rgba(${glowColor}, 0.18)`
            : 'inset 0 0 0 0px rgba(0,0,0,0)'
        }}
        transition={{ type: 'spring', stiffness: 220, damping: 26 }}
        className={`group w-full px-3 py-2 text-left flex items-center gap-2 transition-colors ${
          isActive ? 'text-fg-bright' : 'text-muted hover:bg-panel-raised hover:text-fg'
        }`}
      >
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[worktree.status]}`}
          title={worktree.status}
        />
        {worktree.pr && (
          <GitPullRequest size={14} className={`shrink-0 ${PR_ICON_COLOR[worktree.pr.checks]}`} />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{worktree.branch}</div>
          <SubtitleDetail worktree={worktree} active={isActive} />
        </div>
      </motion.div>
      {isActive && <MockTabRows status={worktree.status} />}
    </div>
  )
}

/** The line-2 detail cluster: age, diff stats, milestone, PR number. Mirrors
 * the renderer's comfy-density defaults for a single-repo workspace. */
function SubtitleDetail({ worktree, active }: { worktree: MockWorktree; active: boolean }) {
  const tone = active ? 'text-muted' : 'text-faint'
  return (
    <div className={`text-xs ${tone} flex items-center gap-1.5 min-w-0`}>
      <span className="font-mono shrink-0">{worktree.age}</span>
      {worktree.pr && (
        <span className="font-mono shrink-0">
          <span className="text-success">+{worktree.pr.additions}</span>
          <span className="text-danger ml-0.5">−{worktree.pr.deletions}</span>
        </span>
      )}
      {worktree.pr?.milestone && (
        <span className="truncate min-w-0 max-w-[6rem]">{worktree.pr.milestone}</span>
      )}
      {worktree.pr && (
        <span className="font-mono shrink-0 px-1.5 py-0.5 rounded-full bg-panel border border-border-strong text-fg-bright leading-none">
          #{worktree.pr.number}
        </span>
      )}
    </div>
  )
}

/** Tabs of the selected worktree, listed as indented child rows. */
function MockTabRows({ status }: { status: MockStatus }) {
  return (
    <div className="pb-1">
      <div className="pl-9 pr-3 py-1 flex items-center gap-1.5 text-xs bg-surface-hover/60 text-fg-bright">
        <ClaudeGlyph />
        {status === 'processing' ? (
          <Loader2 size={10} className="shrink-0 animate-spin text-success" />
        ) : status === 'needs-approval' ? (
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-danger animate-pulse" />
        ) : status === 'waiting' ? (
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-warning" />
        ) : null}
        <span className="truncate">Chat</span>
      </div>
      <div className="pl-9 pr-3 py-1 flex items-center gap-1.5 text-xs text-muted">
        <CodexGlyph />
        <Loader2 size={10} className="shrink-0 animate-spin text-success" />
        <span className="truncate">Reviewer</span>
      </div>
      <div className="pl-9 pr-3 py-1 flex items-center gap-1.5 text-xs text-muted">
        <SquareTerminal size={12} className="shrink-0" />
        <span className="truncate">Shell</span>
      </div>
    </div>
  )
}

/** Claude's mark, matching the renderer's AgentIcon. */
function ClaudeGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className="shrink-0">
      <path
        fill="#ee8334"
        d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"
      />
    </svg>
  )
}

/** Codex's mark, matching the renderer's AgentIcon. */
function CodexGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className="shrink-0">
      <path
        fill="currentColor"
        d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934 4.1 4.1 0 0 0-1.778-.113 4.15 4.15 0 0 0-2.118.114 4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679 4 4 0 0 0-1.14 1.252 3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z"
      />
    </svg>
  )
}

/** Overlay launchers along the bottom of the sidebar. The real strip hides
 * trailing icons when the sidebar is too narrow and keeps the hamburger. */
function BottomIconStrip() {
  return (
    <div className="border-t border-border p-2 flex items-center justify-center gap-1 shrink-0 text-dim">
      {[LayoutGrid, FilePlus, FolderOpen, BarChart3, CalendarDays, Keyboard, Menu].map(
        (Icon, i) => (
          <span key={i} className="rounded p-1.5">
            <Icon size={14} />
          </span>
        )
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tab bar + terminal                                                  */
/* ------------------------------------------------------------------ */

function MockTabBar({ state }: { state: MockHarnessState }) {
  const active = activeWorktree(state)
  return (
    <div className="flex-1 min-w-0 flex items-center border-b border-border bg-panel h-full">
      <div className="shrink-0 flex items-center gap-1.5 px-3 h-full text-xs whitespace-nowrap">
        <span className={`font-medium ${REPO_NAME_COLOR}`}>{REPO_NAME}</span>
        <span className="text-faint">/</span>
        <span className="text-fg-bright font-medium">{active.branch}</span>
      </div>

      <div className="shrink-0 flex items-center h-full pl-2 text-faint">
        <span className="shrink-0 pl-2 pr-1 h-full flex items-center">
          <Sparkles size={12} />
        </span>
        <span className="shrink-0 pl-0.5 pr-1.5 h-full flex items-center">
          <ChevronDown size={10} />
        </span>
        <span className="shrink-0 px-2 h-full flex items-center">
          <SquareTerminal size={12} />
        </span>
        <span className="shrink-0 px-2 h-full flex items-center">
          <Globe size={12} />
        </span>
      </div>

      <div className="shrink-0 w-px h-4 bg-border-strong mx-1" />

      <div className="flex items-center h-full overflow-hidden flex-1 min-w-0">
        <div className="shrink-0 flex items-center gap-1.5 px-3 h-full text-xs border-b-2 border-muted text-fg-bright">
          <span className={`w-1.5 h-1.5 rounded-full ${TAB_STATUS_COLORS[active.status]}`} />
          <span>Chat</span>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 px-3 h-full text-xs border-b-2 border-transparent border-l border-l-border text-dim">
          <span className="w-1.5 h-1.5 rounded-full bg-success" />
          <span>Reviewer</span>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 px-3 h-full text-xs border-b-2 border-transparent border-l border-l-border text-dim">
          <span className="w-1.5 h-1.5 rounded-full bg-faint" />
          <span>Shell</span>
        </div>
      </div>
    </div>
  )
}

function MockTerminalPanel({ state }: { state: MockHarnessState }) {
  const active = activeWorktree(state)
  const terminalGlow = state.highlightedElement === 'terminal'

  return (
    <motion.div
      animate={{
        boxShadow: terminalGlow
          ? 'inset 0 0 0 1px rgba(74, 222, 128, 0.4)'
          : 'inset 0 0 0 0px rgba(74, 222, 128, 0)'
      }}
      transition={{ type: 'spring', stiffness: 200, damping: 30 }}
      className="flex-1 min-w-0 flex flex-col bg-app relative"
    >
      <MockChat key={active.id} transcript={active.chat} needsApproval={active.status === 'needs-approval'} />
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* Right column                                                        */
/* ------------------------------------------------------------------ */

function MockRightColumn({ state }: { state: MockHarnessState }) {
  const open = !!state.rightPanelOpen
  const railGlow = state.highlightedElement === 'right-column-button'
  const active = activeWorktree(state)

  return (
    <motion.div
      animate={{ width: open ? RIGHT_COLUMN_WIDTH : RIGHT_RAIL_WIDTH }}
      initial={false}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className={`shrink-0 h-full overflow-hidden bg-panel border-l ${
        open ? 'border-border-strong' : 'border-border'
      }`}
    >
      <AnimatePresence mode="wait" initial={false}>
        {open ? (
          <motion.div
            key="expanded"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="h-full flex flex-col"
            style={{ width: RIGHT_COLUMN_WIDTH }}
          >
            <RightColumnToolbar />
            <PullRequestPanel pr={active.pr} />
            <CommitsPanel commits={active.changes?.commits ?? []} />
            <ChangedFilesPanel
              uncommitted={active.changes?.uncommitted ?? []}
              committed={active.changes?.committed ?? []}
            />
            <RightPanelSection title="All Files" collapsed actions={<ListTree size={12} />} />
            <RightPanelSection title="Cost" collapsed />
          </motion.div>
        ) : (
          <motion.div
            key="rail"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="h-full"
            style={{ width: RIGHT_RAIL_WIDTH }}
          >
            <CollapsedRightRail highlighted={railGlow} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function CollapsedRightRail({ highlighted }: { highlighted: boolean }) {
  return (
    <div className="h-full flex flex-col items-center gap-1 py-3 text-dim">
      <motion.span
        animate={{
          boxShadow: highlighted
            ? '0 0 0 2px rgba(74, 222, 128, 0.6), 0 0 18px rgba(74, 222, 128, 0.35)'
            : '0 0 0 0px rgba(74, 222, 128, 0)',
          scale: highlighted ? 1.08 : 1
        }}
        transition={{ type: 'spring', stiffness: 220, damping: 22 }}
        className={`rounded p-1.5 ${highlighted ? 'text-fg bg-surface' : ''}`}
      >
        <PanelRightOpen size={14} />
      </motion.span>
      <div className="h-px w-6 bg-border my-1" />
      <span className="rounded p-1.5 text-success">
        <GitPullRequest size={14} />
      </span>
      <span className="rounded p-1.5 text-success">
        <GitMerge size={14} />
      </span>
      <span className="rounded p-1.5">
        <ClipboardCheck size={14} />
      </span>
      <span className="rounded p-1.5">
        <Code2 size={14} />
      </span>
      <span className="rounded p-1.5">
        <FolderOpen size={14} />
      </span>
    </div>
  )
}

function RightColumnToolbar() {
  return (
    <div className="px-3 py-3 flex items-center gap-2 shrink-0">
      <span className="text-xs font-medium text-dim">TOOLS</span>
      <div className="ml-auto flex items-center gap-1 text-dim">
        <SlidersHorizontal size={12} />
        <PanelRightClose size={12} />
      </div>
    </div>
  )
}

function RightPanelSection({
  title,
  children,
  actions,
  collapsed = false,
  grow = false,
  maxHeight
}: {
  title: string
  children?: ReactNode
  actions?: ReactNode
  collapsed?: boolean
  grow?: boolean
  maxHeight?: string
}) {
  return (
    <div
      className={`flex flex-col border-b border-border bg-panel ${
        grow && !collapsed ? 'flex-1 min-h-0' : 'shrink-0'
      }`}
    >
      <div
        className={`flex items-stretch h-9 shrink-0 ${collapsed ? '' : 'border-b border-border'}`}
      >
        <div className="flex-1 flex items-center gap-1.5 px-3 min-w-0">
          <ChevronRight
            size={12}
            className={`shrink-0 text-faint transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          <span className="text-xs font-medium text-muted uppercase tracking-wide truncate">
            {title}
          </span>
        </div>
        {actions && <div className="flex items-center gap-2 pr-3 text-faint">{actions}</div>}
      </div>
      {!collapsed && (
        <div className={grow ? 'flex-1 min-h-0 flex flex-col' : `${maxHeight ?? ''} flex flex-col`}>
          {children}
        </div>
      )}
    </div>
  )
}

function PullRequestPanel({ pr }: { pr?: MockWorktree['pr'] }) {
  if (!pr) {
    return (
      <RightPanelSection title="Pull Request" actions={<RefreshCw size={12} />}>
        <div className="px-3 py-2 text-xs text-faint">No PR for this branch</div>
      </RightPanelSection>
    )
  }
  return (
    <RightPanelSection
      title="Pull Request"
      actions={
        <>
          <span className="px-2 py-1 text-xs rounded flex items-center gap-1.5 bg-success/20 text-success">
            <GitMerge size={12} />
            Squash
          </span>
          <RefreshCw size={12} />
        </>
      }
    >
      <div className="px-3 py-2 space-y-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="px-1.5 py-0.5 rounded border text-xs font-medium shrink-0 border-success/40 text-success">
            #{pr.number}
          </span>
          <span className="flex-1 text-xs text-fg truncate">{pr.title}</span>
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <span className="w-4 h-4 rounded-full bg-indigo-400/60 border border-panel shrink-0" />
          {pr.milestone && (
            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium bg-accent/20 text-accent">
              {pr.milestone}
            </span>
          )}
          <span className="font-mono truncate shrink-0 text-dim">main</span>
          <span className="font-mono ml-auto shrink-0">
            <span className="text-success">+{pr.additions}</span>
            <span className="text-danger ml-1">−{pr.deletions}</span>
          </span>
        </div>

        <div className="flex items-center flex-wrap gap-1">
          <span
            className="px-1.5 py-0.5 rounded-full text-xs font-medium leading-tight"
            style={{ backgroundColor: '#1d76db', color: '#fff' }}
          >
            enhancement
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-success">Checks passing</span>
          <span className="text-xs text-faint">(7/7)▾</span>
        </div>
      </div>
    </RightPanelSection>
  )
}

function CommitsPanel({ commits }: { commits: MockCommit[] }) {
  return (
    <RightPanelSection
      title="Commits"
      maxHeight="max-h-56"
      actions={
        <>
          {commits.length > 0 && <span className="text-xs text-faint">{commits.length}</span>}
          <RefreshCw size={12} />
        </>
      }
    >
      <div className="flex-1 overflow-y-auto min-h-0 text-xs py-1.5">
        {commits.length === 0 && <div className="px-4 py-2 text-faint">No commits ahead of base</div>}
        {commits.map((c, i) => (
          <div
            key={c.sha}
            className="group relative flex items-center gap-2.5 pl-4 pr-3 py-1.5 hover:bg-panel-raised"
          >
            <div className="relative shrink-0 w-3 self-stretch flex justify-center">
              <div
                className="absolute left-1/2 -translate-x-1/2 w-px bg-border-strong"
                style={{ top: i === 0 ? '50%' : 0, bottom: i === commits.length - 1 ? '50%' : 0 }}
              />
              <div
                className={`relative z-10 self-center w-2 h-2 rounded-full ring-2 ring-panel ${
                  c.pushed ? 'bg-border-strong' : 'bg-warning'
                }`}
              />
            </div>
            <span className={`shrink-0 font-mono text-xs ${c.pushed ? 'text-faint' : 'text-warning'}`}>
              {c.sha}
            </span>
            <span className={`truncate min-w-0 flex-1 ${c.pushed ? 'text-dim' : 'text-fg'}`}>
              {c.msg}
            </span>
            {!c.pushed && <ArrowUp size={10} className="shrink-0 text-warning" />}
          </div>
        ))}
      </div>
    </RightPanelSection>
  )
}

function ChangedFilesPanel({
  uncommitted,
  committed
}: {
  uncommitted: MockChangedFile[]
  committed: MockChangedFile[]
}) {
  return (
    <RightPanelSection
      title="Changed Files"
      grow
      actions={
        <>
          {committed.length > 0 && (
            <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-accent text-app text-xs">
              <ClipboardCheck size={12} />
              Review
            </span>
          )}
          <RefreshCw size={12} />
        </>
      }
    >
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        <SectionBar label="Uncommitted" />
        {uncommitted.length === 0 && <div className="px-3 py-2 text-faint italic">No changes</div>}
        {uncommitted.map((f) => (
          <ChangedFileRow key={`u-${f.path}`} file={f} />
        ))}
        <SectionBar label="Committed" className="mt-1" />
        {committed.length === 0 && (
          <div className="px-3 py-2 text-faint italic">No commits on this branch yet</div>
        )}
        {committed.map((f) => (
          <ChangedFileRow key={`c-${f.path}`} file={f} />
        ))}
      </div>
      {uncommitted.length + committed.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-xs text-faint shrink-0">
          {[
            uncommitted.length > 0 && `${uncommitted.length} uncommitted`,
            committed.length > 0 && `${committed.length} committed`
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
    </RightPanelSection>
  )
}

function SectionBar({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div
      className={`px-3 py-1.5 flex items-center justify-between text-xs font-medium text-dim uppercase tracking-wider bg-panel-raised/50 ${className}`}
    >
      <span>{label}</span>
      <ListTree size={12} className="text-faint" />
    </div>
  )
}

function ChangedFileRow({ file }: { file: MockChangedFile }) {
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : ''
  const name = file.path.slice(lastSlash + 1)
  return (
    <div className="flex items-center gap-2 px-3 py-1 hover:bg-panel-raised">
      <span
        className={`shrink-0 w-3 font-mono ${file.kind === 'A' ? 'text-success' : 'text-warning'}`}
      >
        {file.kind}
      </span>
      <span className="truncate min-w-0 flex-1">
        {dir && <span className="text-faint">{dir}</span>}
        <span className="text-fg">{name}</span>
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums">
        {file.add > 0 && <span className="text-success">+{file.add}</span>}
        {file.del > 0 && <span className="text-danger ml-1">−{file.del}</span>}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* New worktree screen                                                 */
/* ------------------------------------------------------------------ */

const STARTER_TASKS = [
  { icon: MapIcon, label: 'Map the repo', hint: 'A one-paragraph architecture summary' },
  { icon: ListChecks, label: 'Find the TODOs', hint: 'Collect every TODO/FIXME in one file' },
  { icon: BookOpen, label: 'Sharpen the README', hint: 'Get 3 concrete improvement ideas' }
]

function MockNewWorktreeScreen() {
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-app brand-grid-bg relative overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-5">
          <div className="text-center mb-5">
            <NessMark className="h-10 w-auto mx-auto mb-3 text-brand" />
            <h1 className="text-3xl font-extrabold tracking-tight mb-1">
              New <span className="brand-gradient-text">worktree</span>
            </h1>
            <p className="text-muted text-base">
              Say what you want done. Ness makes the branch and sends the agent in.
            </p>
          </div>

          <div className="bg-panel/80 backdrop-blur border border-border rounded-2xl p-5 shadow-xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-dim">
                Kickoff prompt
              </span>
              <span className="text-xs text-faint">names the branch too</span>
            </div>
            <div className="w-full bg-app border-2 border-accent rounded-lg px-4 py-3 text-sm text-fg-bright leading-relaxed min-h-[84px]">
              Add a presence indicator to the sidebar showing which teammates are currently viewing
              the same doc.
              <span className="inline-block w-[1px] h-3.5 bg-fg-bright caret-blink ml-0.5 align-middle" />
            </div>
            <div className="mt-2 flex items-start gap-1.5 text-xs text-dim">
              <Wand2 size={12} className="text-accent shrink-0 mt-0.5" />
              <span>
                Ness names the branch from this prompt, and the agent renames it once it has read
                the task. Set a name yourself under Advanced.
              </span>
            </div>

            <div className="mt-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-dim">
              <ChevronRight size={12} />
              Advanced
              <span className="ml-1 normal-case font-normal tracking-normal text-faint">
                start mode, branch, agent, model
              </span>
            </div>

            <div className="flex items-center justify-end mt-5 gap-2">
              <div className="flex items-center gap-1.5 px-4 py-2 text-sm text-dim">
                Cancel
                <kbd className="text-xs text-faint bg-app px-1.5 py-0.5 rounded border border-border font-mono">
                  Esc
                </kbd>
              </div>
              <div className="brand-gradient-bg text-white font-semibold text-sm px-5 py-2.5 rounded-lg flex items-center gap-2 shadow-lg">
                <Sparkles size={14} />
                Create worktree
                <kbd className="text-xs text-white bg-white/20 px-1.5 py-0.5 rounded border border-white/30 font-mono">
                  ⌘↵
                </kbd>
              </div>
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-2.5 px-1 flex items-center gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-dim">
                Or try a starter task
              </span>
              <X size={12} className="text-faint" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {STARTER_TASKS.map(({ icon: Icon, label, hint }) => (
                <div
                  key={label}
                  className="text-left bg-panel/60 border border-border/60 rounded-xl p-3.5"
                >
                  <Icon size={18} className="text-accent mb-2" />
                  <div className="text-sm text-fg font-medium">{label}</div>
                  <div className="text-xs text-dim mt-0.5">{hint}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
