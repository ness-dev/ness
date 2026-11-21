import type { ComponentType, ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Brain,
  ChevronDown,
  ChevronRight,
  FilePen,
  FileText,
  GitBranch,
  ListChecks,
  Search,
  Sparkles,
  Square,
  Terminal
} from 'lucide-react'

/** A replica of Ness's Chat mode (`JsonModeChat`) for the marketing
 * hero mock — borderless prompt bubbles, assistant markdown, the flat
 * chevron rows tool calls and finished turns fold into, and the approval
 * card, plus the composer underneath. Styling reads the same `--chat-*`
 * density tokens the real chat does. */

export interface MockDiffLine {
  kind: 'ctx' | 'add' | 'remove'
  old?: number
  next?: number
  text: string
}

/** A collapsed tool call. Bash carries the model's stated `intent`, which
 * the real chat shows in place of the bare tool name. `Worktree` is the Ness
 * MCP's create_worktree, which the real chat draws with a branch glyph. */
export interface MockToolCall {
  tool: 'Read' | 'Grep' | 'Bash' | 'Worktree'
  intent?: string
}

/** One worktree's conversation. Assistant text marks inline code with
 * backticks, the way the real chat's markdown would. */
export interface MockTranscript {
  /** An earlier, finished turn: its work folds behind a summary strip
   * above the final answer. */
  earlier: {
    prompt: string
    duration: string
    toolCount: number
    filesEdited: number
    answer: string
  }
  prompt: string
  tools: MockToolCall[]
  explanation: string
  /** Absent for a turn that didn't touch files, e.g. a project's main
   * workspace handing work out to new worktrees. */
  edit?: { path: string; lines: MockDiffLine[] }
  /** While working: todo progress plus the turn still streaming in. */
  working: { todos: { done: number; total: number }; streaming: string }
  /** When the worktree needs approval: the Bash call it's blocked on. */
  approval: { command: string; description: string }
}

export function MockChat({
  transcript,
  needsApproval
}: {
  transcript?: MockTranscript
  needsApproval: boolean
}) {
  return (
    <div className="absolute inset-0 flex flex-col bg-app text-fg" data-chat-density="compact">
      <div className="relative flex-1 min-h-0 flex flex-col">
        {transcript ? (
          <div className="flex-1 overflow-hidden flex flex-col justify-end">
            <div className="px-6 py-5 space-y-4">
              <UserBubble>{transcript.earlier.prompt}</UserBubble>
              <TurnFold {...transcript.earlier} />
              <AssistantText text={transcript.earlier.answer} />

              <UserBubble>{transcript.prompt}</UserBubble>

              <ToolGroup thoughts={1} tools={transcript.tools} />

              <AssistantText text={transcript.explanation} />

              {transcript.edit && <EditCard edit={transcript.edit} />}

              <AnimatePresence mode="wait" initial={false}>
                {needsApproval ? (
                  <motion.div
                    key="approval"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.25 }}
                  >
                    <ApprovalCard {...transcript.approval} />
                  </motion.div>
                ) : (
                  <motion.div
                    key="todos"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className="space-y-4"
                  >
                    <TodoCard todos={transcript.working.todos} />
                    <AssistantText text={transcript.working.streaming} partial />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        ) : (
          <EmptyState />
        )}
      </div>
      {/* A pending approval pauses the turn but doesn't end it, so the
          session is still "running" and still interruptible. */}
      <Composer busy={!!transcript} />
    </div>
  )
}

/** The real chat's empty state, for a worktree with no conversation yet. */
function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4 select-none">
      <div className="relative mb-6">
        <div className="absolute inset-0 rounded-full blur-2xl opacity-30 brand-gradient-bg" />
        <div className="relative w-16 h-16 rounded-full brand-gradient-bg flex items-center justify-center shadow-lg">
          <Sparkles className="w-[1.625rem] h-[1.625rem] text-white" />
        </div>
      </div>
      <h2 className="text-lg font-semibold brand-gradient-text">
        What are we going to build today?
      </h2>
      <p className="mt-2 text-xs text-muted">Send a message to get started.</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Transcript rows                                                     */
/* ------------------------------------------------------------------ */

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div
        className="bg-accent/10 px-4 py-2.5 whitespace-pre-wrap break-words"
        style={{
          maxWidth: 'var(--chat-bubble-max)',
          borderRadius: 'var(--chat-prompt-radius)',
          fontSize: 'var(--chat-body-text)'
        }}
      >
        {children}
      </div>
    </div>
  )
}

function AssistantText({ text, partial }: { text: string; partial?: boolean }) {
  return (
    <div className="markdown leading-relaxed" style={{ fontSize: 'var(--chat-body-text)' }}>
      <p>
        {text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}
        {partial && <span className="json-claude-cursor" />}
      </p>
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight
  return <Icon className="w-3 h-3 shrink-0" aria-hidden />
}

/** The flat, borderless row every transcript disclosure shares — muted,
 * no box, chevron first. */
function ChatRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="w-full flex items-center gap-2 text-left text-muted"
      style={{ paddingBlock: 'var(--chat-chrome-py)', fontSize: 'var(--chat-chrome-text)' }}
    >
      {children}
    </div>
  )
}

/** A finished turn's work, folded into one line above its final answer. */
function TurnFold({
  duration,
  toolCount,
  filesEdited
}: Pick<MockTranscript['earlier'], 'duration' | 'toolCount' | 'filesEdited'>) {
  const parts = [`Worked for ${duration}`, `${toolCount} tool${toolCount === 1 ? '' : 's'}`]
  if (filesEdited > 0) parts.push(`${filesEdited} file${filesEdited === 1 ? '' : 's'} edited`)
  return (
    <div
      className="w-full flex items-center gap-2 text-left text-muted"
      style={{ fontSize: 'var(--chat-chrome-text)' }}
    >
      <Chevron open={false} />
      <span className="shrink-0">{parts.join(' · ')}</span>
    </div>
  )
}

const TOOL_ICONS: Record<MockToolCall['tool'], ComponentType<{ className?: string }>> = {
  Read: FileText,
  Grep: Search,
  Bash: Terminal,
  Worktree: GitBranch
}

/** Consecutive tool calls fold into one collapsed row: a count label, then
 * a chip per call naming what it was for. */
function ToolGroup({ thoughts, tools }: { thoughts: number; tools: MockToolCall[] }) {
  const label = [
    thoughts > 0 ? `${thoughts} thought${thoughts === 1 ? '' : 's'}` : '',
    `${tools.length} tool call${tools.length === 1 ? '' : 's'}`
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ChatRow>
      <Chevron open={false} />
      {thoughts > 0 && <Brain className="w-3 h-3 shrink-0" />}
      <span className="shrink-0">{label}</span>
      <span
        className="opacity-70 overflow-hidden whitespace-nowrap flex-1 min-w-0 flex items-center gap-1.5"
        style={{ maskImage: 'linear-gradient(to right, black calc(100% - 2rem), transparent)' }}
      >
        {tools.map((t, i) => {
          const Icon = TOOL_ICONS[t.tool]
          return (
            <span key={i} className="flex items-center gap-1.5 shrink-0">
              {i > 0 && <span className="opacity-40">·</span>}
              <Icon className="shrink-0 w-3 h-3" />
              <span className="truncate max-w-[16rem]">{t.intent ?? t.tool}</span>
            </span>
          )
        })}
      </span>
    </ChatRow>
  )
}

/** One tool call: a flat row, and when open, its body on a soft panel
 * fill so code still stands apart from prose. */
function ToolCard({
  name,
  subtitle,
  icon: Icon,
  open = true,
  children
}: {
  name: string
  subtitle: string
  icon: ComponentType<{ className?: string }>
  open?: boolean
  children?: ReactNode
}) {
  return (
    <div>
      <ChatRow>
        <Chevron open={open} />
        <Icon className="shrink-0 w-3 h-3" />
        <span
          className="font-medium shrink-0 text-fg"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {name}
        </span>
        <span className="truncate flex-1 min-w-0">{subtitle}</span>
      </ChatRow>
      {open && (
        <div
          className="mt-0.5 mb-2 bg-panel overflow-hidden"
          style={{ borderRadius: 'var(--chat-bubble-radius)' }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

function diffSummary(lines: MockDiffLine[]): string {
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'remove').length
  return `+${added} −${removed}`
}

function EditCard({ edit }: { edit: NonNullable<MockTranscript['edit']> }) {
  return (
    <ToolCard
      name="Edit"
      subtitle={`${edit.path.split('/').pop()} (${diffSummary(edit.lines)})`}
      icon={FilePen}
    >
      <div className="px-2 py-1 text-xs text-muted truncate font-mono">{edit.path}</div>
      <div className="text-xs font-mono pb-1">
        {edit.lines.map((ln, i) => {
          const bg =
            ln.kind === 'add' ? 'bg-success/10' : ln.kind === 'remove' ? 'bg-danger/10' : ''
          const fg =
            ln.kind === 'add'
              ? 'text-success/90'
              : ln.kind === 'remove'
                ? 'text-danger/90'
                : 'opacity-80'
          const marker = ln.kind === 'add' ? '+' : ln.kind === 'remove' ? '-' : ' '
          return (
            <div key={i} className={`flex ${bg} ${fg}`}>
              <span className="w-4 shrink-0 text-center select-none opacity-70">{marker}</span>
              <span className="w-8 shrink-0 text-right pr-1 select-none text-muted tabular-nums">
                {ln.old ?? ''}
              </span>
              <span className="w-8 shrink-0 text-right pr-2 select-none text-muted tabular-nums">
                {ln.next ?? ''}
              </span>
              <span className="flex-1 whitespace-pre truncate">{ln.text}</span>
            </div>
          )
        })}
      </div>
    </ToolCard>
  )
}

/** Collapsed, like every tool call in the real chat until clicked. */
function TodoCard({ todos }: { todos: MockTranscript['working']['todos'] }) {
  return (
    <ToolCard
      name="TodoWrite"
      subtitle={`${todos.done}/${todos.total} done`}
      icon={ListChecks}
      open={false}
    />
  )
}

const BTN = 'px-2 py-1 text-xs rounded transition-colors'

function ApprovalCard({ command, description }: MockTranscript['approval']) {
  return (
    <div className="rounded-md border border-danger/40 bg-danger/5 my-2 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-danger/30 bg-danger/10">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wide text-danger shrink-0">
            Needs approval
          </span>
          <Terminal className="shrink-0 w-3.5 h-3.5" />
          <span className="text-xs font-mono text-fg-bright truncate">{command}</span>
        </div>
      </div>
      <div className="space-y-2 pb-2">
        <div className="px-3 pt-2 space-y-2">
          <pre className="text-xs font-mono bg-app/40 rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {command}
          </pre>
          <div className="text-xs text-muted italic">{description}</div>
        </div>
        <div className="px-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`${BTN} bg-success/20 text-success`}>
              Allow once<span className="opacity-60 ml-1">⌥A</span>
            </span>
            <span
              className={`${BTN} font-semibold bg-success/30 text-success border border-success/50`}
            >
              Allow Bash this session
            </span>
            <span className={`${BTN} bg-surface text-fg`}>Always allow…</span>
            <span className={`${BTN} bg-danger/20 text-danger`}>
              Deny<span className="opacity-60 ml-1">⌥D</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

function Composer({ busy }: { busy: boolean }) {
  return (
    <div className="shrink-0">
      <div className="h-px shrink-0 bg-border-strong" />
      <div className="px-4 pt-2 pb-3">
        <div className="relative rounded-md border border-border bg-panel">
          <div className="block w-full px-2.5 pt-2 pb-1 text-sm text-faint min-h-[60px]">
            Message Claude — ⌘+Enter to send
          </div>
          <div className="flex items-center gap-2 px-2 pb-1.5 pt-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <span className={`w-1.5 h-1.5 rounded-full ${busy ? 'bg-success' : 'bg-faint'}`} />
              <span>{busy ? 'running' : 'idle'}</span>
            </div>
            <span className="px-1.5 py-0.5 rounded border text-xs bg-success/15 text-success border-success/30">
              accept edits
            </span>
            <div className="flex-1" />
            {busy && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-danger">
                <Square fill="currentColor" className="w-2.5 h-2.5" />
                interrupt
              </span>
            )}
            <span className="px-2.5 py-0.5 bg-accent text-white rounded text-xs font-medium opacity-40">
              Send<span className="opacity-60 ml-1">⌘↵</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
