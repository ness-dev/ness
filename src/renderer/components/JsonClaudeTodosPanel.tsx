import { useMemo, useRef, useState } from 'react'
import { Ban, User } from 'lucide-react'
import { useJsonClaudeSession } from '../store'
import { getLatestTodos } from '../../shared/state/json-claude-todos'
import {
  collectTasks,
  countOpenTasks,
  isTaskBlocked,
  type TaskRecord
} from '../../shared/state/json-claude-tasks'
import { RightPanel } from './RightPanel'
import { useSessionRevision } from '../session-revision'

interface JsonClaudeTodosPanelProps {
  focusedTabId: string | null
}

const STATUS_GLYPH: Record<TaskRecord['status'], string> = {
  pending: '☐',
  in_progress: '◐',
  completed: '☑'
}

function statusColor(status: TaskRecord['status']): string {
  return status === 'completed'
    ? 'text-success'
    : status === 'in_progress'
      ? 'text-warning'
      : 'text-faint'
}

function TaskRow({
  task,
  blocked,
  expanded,
  onToggle
}: {
  task: TaskRecord
  blocked: boolean
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  // activeForm is the field's entire reason to exist — while a task runs,
  // "Building the catalogue client" beats "Catalogue client".
  const label =
    task.status === 'in_progress' && task.activeForm
      ? task.activeForm
      : task.subject
  const hasDetail = task.description.length > 0
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        disabled={!hasDetail}
        title={hasDetail ? task.description : undefined}
        className={`w-full text-left px-3 py-0.5 flex items-baseline gap-2 ${
          hasDetail ? 'hover:bg-app/60 cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className={`${statusColor(task.status)} shrink-0`}>
          {STATUS_GLYPH[task.status]}
        </span>
        <span
          className={`flex-1 min-w-0 truncate ${
            task.status === 'completed'
              ? 'line-through opacity-60'
              : task.status === 'in_progress'
                ? 'text-fg-bright'
                : blocked
                  ? 'text-fg opacity-60'
                  : 'text-fg'
          }`}
        >
          {label}
        </span>
        {task.owner && (
          <span
            title={`owned by ${task.owner}`}
            className="flex items-center gap-0.5 text-faint shrink-0 max-w-24"
          >
            <User className="icon-2xs shrink-0" />
            <span className="truncate">{task.owner}</span>
          </span>
        )}
        {blocked && (
          <span
            title={`blocked by ${task.blockedBy.map((id) => `#${id}`).join(', ')}`}
            className="flex items-center gap-0.5 text-faint shrink-0"
          >
            <Ban className="icon-2xs shrink-0" />
            <span className="tabular-nums">
              {task.blockedBy.map((id) => `#${id}`).join(' ')}
            </span>
          </span>
        )}
      </button>
      {expanded && hasDetail && (
        <div className="px-3 pb-1 pl-8 text-faint whitespace-pre-wrap">
          {task.description}
        </div>
      )}
    </li>
  )
}

/** The session's work list. Renders the structured Tasks tool
 *  (TaskCreate/TaskUpdate — subjects, owners, a blocked-by graph) when
 *  the session uses it, and falls back to the older flat TodoWrite array
 *  otherwise. One panel rather than two: they're the same concept, a
 *  session only ever drives one of them, and keeping the `todos` panel
 *  key means existing per-repo panel order/visibility config still
 *  applies. */
export function JsonClaudeTodosPanel({
  focusedTabId
}: JsonClaudeTodosPanelProps): JSX.Element | null {
  const session = useJsonClaudeSession(focusedTabId ?? '')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Keyed on the revision rather than the session object, whose identity
  // churns on every streamed token — both derivations walk the whole
  // entries array, and a per-token walk is CLAUDE.md anti-pattern #4.
  // NOT on entries.length: a TodoWrite / TaskCreate tool_use block is
  // appended to the assistant entry already in flight, so the count
  // doesn't move and the panel would stay empty for the entire turn.
  const sessionRef = useRef(session)
  sessionRef.current = session
  const revision = useSessionRevision(session)
  const tasks = useMemo(
    () => collectTasks(sessionRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision]
  )
  const todos = useMemo(
    () => getLatestTodos(sessionRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision]
  )
  const blockedIds = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const out = new Set<string>()
    for (const t of tasks) if (isTaskBlocked(t, byId)) out.add(t.id)
    return out
  }, [tasks])

  if (tasks.length > 0) {
    const open = countOpenTasks(tasks)
    return (
      <RightPanel
        id="todos"
        title="Tasks"
        maxHeight="max-h-64"
        actions={
          // Remaining/total, matching the TodoWrite fallback below — the
          // badge looks identical in both modes, so it must not mean two
          // different things.
          <span
            title={`${open} of ${tasks.length} remaining`}
            className="text-xs text-faint tabular-nums"
          >
            {open}/{tasks.length}
          </span>
        }
      >
        <ul className="py-1 text-xs space-y-0.5 overflow-y-auto">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              blocked={blockedIds.has(t.id)}
              expanded={expandedId === t.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === t.id ? null : t.id))
              }
            />
          ))}
        </ul>
      </RightPanel>
    )
  }

  if (!todos || todos.length === 0) return null

  const remaining = todos.filter((t) => t.status !== 'completed').length

  return (
    <RightPanel
      id="todos"
      title="Todos"
      actions={
        <span className="text-xs text-faint tabular-nums">
          {remaining}/{todos.length}
        </span>
      }
    >
      <ul className="px-3 py-2 text-xs space-y-1 overflow-y-auto">
        {todos.map((t, i) => (
          <li key={i} className="flex items-baseline gap-2">
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
            <span
              className={
                t.status === 'completed'
                  ? 'line-through opacity-60'
                  : t.status === 'in_progress'
                    ? 'text-fg-bright'
                    : 'text-fg'
              }
            >
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </RightPanel>
  )
}
