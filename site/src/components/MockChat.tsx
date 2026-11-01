import type { ComponentType, ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Brain, FilePen, FileText, ListChecks, Search, Sparkles, Square, Terminal } from 'lucide-react'

/** A replica of Ness's Chat mode (`JsonModeChat`) for the marketing
 * diorama — the transcript of user bubbles, assistant markdown, collapsible
 * tool cards and the approval card, plus the composer underneath. Styling
 * reads the same `--chat-*` density tokens the real chat does. */

export interface MockDiffLine {
  kind: 'ctx' | 'add' | 'remove'
  old?: number
  next?: number
  text: string
}

export interface MockTodo {
  status: 'completed' | 'in_progress' | 'pending'
  text: string
}

/** One worktree's conversation. Assistant text marks inline code with
 * backticks, the way the real chat's markdown would. */
export interface MockTranscript {
  prompt: string
  explanation: string
  edit: { path: string; summary: string; lines: MockDiffLine[] }
  /** While working: the todo list plus the turn still streaming in. */
  working: { todos: MockTodo[]; streaming: string }
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
            <div className="px-4 py-3 space-y-3">
              <UserBubble>{transcript.prompt}</UserBubble>

              <ToolGroup
                label="1 thought · 3 tool calls"
                chips={[
                  { icon: FileText, label: 'Read' },
                  { icon: Search, label: 'Grep' },
                  { icon: FileText, label: 'Read' }
                ]}
              />

              <AssistantText text={transcript.explanation} />

              <EditCard edit={transcript.edit} />

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
                    className="space-y-3"
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
        className="bg-accent/15 border border-accent/30 px-3 py-2 whitespace-pre-wrap break-words"
        style={{
          maxWidth: 'var(--chat-bubble-max)',
          borderRadius: 'var(--chat-bubble-radius)',
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

/** Consecutive tool calls fold into one collapsed row with a count label
 * and a strip of per-tool chips. */
function ToolGroup({
  label,
  chips
}: {
  label: string
  chips: { icon: ComponentType<{ className?: string }>; label: string }[]
}) {
  return (
    <div
      className="my-2 border border-border/60 bg-app/30 overflow-hidden"
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <div
        className="w-full flex items-center gap-2 text-left"
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <span className="text-muted text-xs w-2 shrink-0 select-none">▸</span>
        <Brain size={12} className="text-muted shrink-0" />
        <span className="shrink-0 text-muted font-mono">{label}</span>
        <span className="opacity-60 truncate flex-1 min-w-0 flex items-center gap-1.5 font-mono">
          {chips.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="opacity-40">·</span>}
              <c.icon className="shrink-0 w-3 h-3" />
              <span>{c.label}</span>
            </span>
          ))}
        </span>
      </div>
    </div>
  )
}

function ToolCard({
  name,
  subtitle,
  icon: Icon,
  variant = 'info',
  open = true,
  children
}: {
  name: string
  subtitle: string
  icon: ComponentType<{ className?: string }>
  variant?: 'info' | 'warn'
  open?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={`my-2 border bg-panel overflow-hidden ${
        variant === 'warn' ? 'border-warning/30' : 'border-border'
      }`}
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <div
        className={`w-full flex items-center gap-2 bg-app/40 text-left ${
          open ? 'border-b border-border' : ''
        }`}
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <span className="text-muted text-xs w-2 shrink-0 select-none">{open ? '▾' : '▸'}</span>
        <Icon className="shrink-0 w-3.5 h-3.5" />
        <span className="font-semibold shrink-0 text-accent font-mono">{name}</span>
        <span className="opacity-70 truncate flex-1 min-w-0">{subtitle}</span>
      </div>
      {open && children}
    </div>
  )
}

function EditCard({ edit }: { edit: MockTranscript['edit'] }) {
  return (
    <ToolCard
      name="Edit"
      subtitle={`${edit.path.split('/').pop()} (${edit.summary})`}
      icon={FilePen}
      variant="warn"
    >
      <div className="px-2 py-1 text-xs text-muted truncate font-mono">{edit.path}</div>
      <div className="text-xs font-mono bg-app/40">
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

function TodoCard({ todos }: { todos: MockTodo[] }) {
  return (
    <ToolCard name="TodoWrite" subtitle={`${todos.length} items`} icon={ListChecks}>
      <ul className="px-3 py-2 text-xs space-y-1">
        {todos.map((t) => (
          <li key={t.text} className="flex items-baseline gap-2">
            <span
              className={
                t.status === 'completed'
                  ? 'text-success'
                  : t.status === 'in_progress'
                    ? 'text-warning'
                    : 'text-faint'
              }
            >
              {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}
            </span>
            <span className={t.status === 'completed' ? 'line-through opacity-60' : ''}>
              {t.text}
            </span>
          </li>
        ))}
      </ul>
    </ToolCard>
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
      <div className="p-2">
        <div className="relative rounded-md border border-border bg-panel">
          <div className="block w-full px-2.5 pt-2 pb-1 text-sm text-faint min-h-[60px]">
            Message Claude — ⌘+Enter to send
          </div>
          <div className="flex items-center gap-2 px-2 pb-1.5 pt-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-success" />
              <span>running</span>
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
            <span className="px-2.5 py-0.5 bg-accent text-white rounded text-xs font-medium">
              Send<span className="opacity-60 ml-1">⌘↵</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
