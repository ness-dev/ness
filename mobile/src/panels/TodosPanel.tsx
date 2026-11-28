// Port of renderer/components/JsonClaudeTodosPanel.tsx. Same derivations
// (collectTasks / getLatestTodos keyed on useSessionRevision), same badge
// and labels. The desktop's hover titles (owner, blocked-by, description)
// are shown in the row's tap-to-expand detail instead.
import { useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Ban, User } from 'lucide-react-native'
import { getLatestTodos } from '../../../src/shared/state/json-claude-todos'
import { collectTasks, countOpenTasks, isTaskBlocked, type TaskRecord } from '../../../src/shared/state/json-claude-tasks'
import { useSessionRevision } from '../../../src/renderer/session-revision'
import { useNess } from '../ness'
import { c, fs } from '../theme'
import { RightPanel } from './RightPanel'
import type { PanelProps } from './types'

const STATUS_GLYPH: Record<TaskRecord['status'], string> = {
  pending: '☐',
  in_progress: '◐',
  completed: '☑'
}

function statusColor(status: TaskRecord['status']): string {
  return status === 'completed' ? c.success : status === 'in_progress' ? c.warning : c.faint
}

/** max-h-64 on the desktop's RightPanel. */
const MAX_H = 256

function TaskRow({ task, blocked, expanded, onToggle }: { task: TaskRecord; blocked: boolean; expanded: boolean; onToggle: () => void }) {
  const label = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject
  const hasDetail = task.description.length > 0
  // Owner / blocked-by are hover titles on desktop; tapping reveals them.
  const tappable = hasDetail || !!task.owner || blocked
  const blockedList = task.blockedBy.map((id) => `#${id}`)
  return (
    <View>
      <Pressable
        onPress={onToggle}
        disabled={!tappable}
        style={({ pressed }) => ({
          minHeight: 44,
          paddingHorizontal: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          backgroundColor: pressed && tappable ? c.app : 'transparent'
        })}
      >
        <Text style={{ color: statusColor(task.status), fontSize: fs.xs }}>{STATUS_GLYPH[task.status]}</Text>
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: fs.xs,
            color: task.status === 'in_progress' ? c.fgBright : c.fg,
            opacity: task.status === 'completed' || blocked ? 0.6 : 1,
            textDecorationLine: task.status === 'completed' ? 'line-through' : 'none'
          }}
        >
          {label}
        </Text>
        {task.owner && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, maxWidth: 96 }}>
            <User color={c.faint} size={10} />
            <Text numberOfLines={1} style={{ color: c.faint, fontSize: fs.xs }}>
              {task.owner}
            </Text>
          </View>
        )}
        {blocked && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Ban color={c.faint} size={10} />
            <Text style={{ color: c.faint, fontSize: fs.xs, fontVariant: ['tabular-nums'] }}>{blockedList.join(' ')}</Text>
          </View>
        )}
      </Pressable>
      {expanded && tappable && (
        <View style={{ paddingLeft: 32, paddingRight: 12, paddingBottom: 6, gap: 2 }}>
          {hasDetail && <Text style={{ color: c.faint, fontSize: fs.xs }}>{task.description}</Text>}
          {task.owner && <Text style={{ color: c.faint, fontSize: fs.xs }}>owned by {task.owner}</Text>}
          {blocked && <Text style={{ color: c.faint, fontSize: fs.xs }}>blocked by {blockedList.join(', ')}</Text>}
        </View>
      )}
    </View>
  )
}

/** The session's work list: structured Tasks when the session uses them,
 *  else the flat TodoWrite array. Same `todos` panel id for both. */
export function TodosPanel({ client, focusedTabId }: PanelProps) {
  const session = useNess(client, (s) => s.jsonClaude.sessions[focusedTabId ?? ''] ?? null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Keyed on the revision, not the session (identity churns per token).
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
        actions={
          <Text accessibilityLabel={`${open} of ${tasks.length} remaining`} style={{ fontSize: fs.xs, color: c.faint, fontVariant: ['tabular-nums'] }}>
            {open}/{tasks.length}
          </Text>
        }
      >
        <ScrollView style={{ maxHeight: MAX_H }} nestedScrollEnabled contentContainerStyle={{ paddingVertical: 4 }}>
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              blocked={blockedIds.has(t.id)}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId((cur) => (cur === t.id ? null : t.id))}
            />
          ))}
        </ScrollView>
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
        <Text style={{ fontSize: fs.xs, color: c.faint, fontVariant: ['tabular-nums'] }}>
          {remaining}/{todos.length}
        </Text>
      }
    >
      {/* The desktop's TodoWrite list has no max-height; capped here so a
          long list can't take over the sheet. */}
      <ScrollView style={{ maxHeight: MAX_H }} nestedScrollEnabled contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 4 }}>
        {todos.map((t, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
            <Text style={{ fontSize: fs.xs, color: t.status === 'completed' ? c.success : t.status === 'in_progress' ? c.warning : c.faint }}>
              {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}
            </Text>
            <Text
              style={{
                flex: 1,
                fontSize: fs.xs,
                color: t.status === 'in_progress' ? c.fgBright : c.fg,
                opacity: t.status === 'completed' ? 0.6 : 1,
                textDecorationLine: t.status === 'completed' ? 'line-through' : 'none'
              }}
            >
              {t.content}
            </Text>
          </View>
        ))}
      </ScrollView>
    </RightPanel>
  )
}
