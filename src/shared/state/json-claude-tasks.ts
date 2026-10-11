import type { JsonClaudeSession } from './json-claude'

/** The Tasks tool family (Claude Code 2.1.x) — the structured successor
 *  to TodoWrite. Unlike TodoWrite, which rewrites the whole array on
 *  every call, these mutate one task at a time, so the list has to be
 *  replayed rather than read off the last call. */
export const TASK_TOOL_NAMES = new Set<string>([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet'
])

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskRecord {
  id: string
  subject: string
  description: string
  /** Present-continuous label, shown instead of `subject` while the task
   *  is in_progress — that's the field's whole purpose. */
  activeForm?: string
  status: TaskStatus
  /** Agent that claimed the task. Populated when a team or a named
   *  background agent is working the list, which is where this view
   *  earns its keep over a flat todo list. */
  owner?: string
  /** Tasks that cannot start until this one completes. */
  blocks: string[]
  /** Tasks that must complete before this one can start. */
  blockedBy: string[]
}

/** `Task #3 created successfully: Build the thing` — the id is minted
 *  server-side and only comes back in the tool_result, so this is the
 *  authoritative source for a created task's id. */
const CREATE_RESULT_ID = /^Task #(\d+) created/

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asStatus(v: unknown): TaskStatus | 'deleted' | undefined {
  return v === 'pending' ||
    v === 'in_progress' ||
    v === 'completed' ||
    v === 'deleted'
    ? v
    : undefined
}

function asIds(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

function link(
  tasks: Map<string, TaskRecord>,
  blockerId: string,
  blockedId: string
): void {
  // Mirror both directions: `addBlocks` on one task and `addBlockedBy` on
  // the other describe the same edge, and only one of them gets called.
  const blocker = tasks.get(blockerId)
  if (blocker && !blocker.blocks.includes(blockedId)) {
    blocker.blocks.push(blockedId)
  }
  const blocked = tasks.get(blockedId)
  if (blocked && !blocked.blockedBy.includes(blockerId)) {
    blocked.blockedBy.push(blockerId)
  }
}

/** Replays a session's TaskCreate / TaskUpdate calls into the current
 *  task list, in id order.
 *
 *  Caveat worth knowing: this can only see what's still in `entries`. A
 *  task created before a compaction boundary that got truncated out of
 *  the buffer won't appear — the same limitation `getLatestTodos` has
 *  always had with TodoWrite. The on-disk truth lives in
 *  `~/.claude/tasks/<sessionId>/`, which the renderer has no reader for;
 *  if the gap ever bites, that directory is the fix, not more replay. */
export function collectTasks(
  session: JsonClaudeSession | null | undefined
): TaskRecord[] {
  if (!session?.entries?.length) return []

  // tool_use id → the created task's server id, recovered from the result.
  const resultsByToolUseId = new Map<string, string>()
  for (const entry of session.entries) {
    if (!entry.blocks) continue
    for (const b of entry.blocks) {
      if (b.type !== 'tool_result' || !b.toolUseId || !b.content) continue
      const m = CREATE_RESULT_ID.exec(b.content)
      if (m) resultsByToolUseId.set(b.toolUseId, m[1])
    }
  }

  const tasks = new Map<string, TaskRecord>()
  const deleted = new Set<string>()
  // Deferred because an `addBlockedBy` can name a task that hasn't been
  // created yet at that point in the replay.
  const edges: Array<[blocker: string, blocked: string]> = []
  let createOrdinal = 0
  let sawTaskTool = false

  for (const entry of session.entries) {
    if (!entry.blocks) continue
    for (const b of entry.blocks) {
      if (b.type !== 'tool_use') continue
      if (b.name === 'TaskCreate') {
        sawTaskTool = true
        createOrdinal += 1
        // Ids are assigned sequentially from 1 in create order, so the
        // ordinal is a sound fallback while a just-issued create is still
        // waiting on its result.
        const id =
          (b.id ? resultsByToolUseId.get(b.id) : undefined) ??
          String(createOrdinal)
        if (deleted.has(id)) continue
        const existing = tasks.get(id)
        const record: TaskRecord = {
          id,
          subject: str(b.input?.subject) ?? `Task ${id}`,
          description: str(b.input?.description) ?? '',
          ...(str(b.input?.activeForm)
            ? { activeForm: str(b.input?.activeForm) }
            : {}),
          status: 'pending',
          blocks: existing?.blocks ?? [],
          blockedBy: existing?.blockedBy ?? []
        }
        tasks.set(id, record)
        continue
      }
      if (b.name !== 'TaskUpdate') continue
      sawTaskTool = true
      const id = str(b.input?.taskId)
      if (!id) continue
      const status = asStatus(b.input?.status)
      if (status === 'deleted') {
        tasks.delete(id)
        deleted.add(id)
        continue
      }
      // An update can land for a task whose create was truncated out of
      // the buffer. Materialize a stub rather than dropping the row —
      // "task 3 is in progress" is still worth showing.
      const record =
        tasks.get(id) ??
        ({
          id,
          subject: `Task ${id}`,
          description: '',
          status: 'pending',
          blocks: [],
          blockedBy: []
        } satisfies TaskRecord)
      if (status) record.status = status
      const subject = str(b.input?.subject)
      if (subject) record.subject = subject
      const description = str(b.input?.description)
      if (description) record.description = description
      const activeForm = str(b.input?.activeForm)
      if (activeForm) record.activeForm = activeForm
      const owner = str(b.input?.owner)
      if (owner) record.owner = owner
      for (const other of asIds(b.input?.addBlocks)) edges.push([id, other])
      for (const other of asIds(b.input?.addBlockedBy)) edges.push([other, id])
      tasks.set(id, record)
    }
  }

  if (!sawTaskTool) return []
  for (const [blocker, blocked] of edges) link(tasks, blocker, blocked)

  return [...tasks.values()].sort(
    (a, b) => (Number(a.id) || 0) - (Number(b.id) || 0)
  )
}

/** True when a task can't be started yet because something it depends on
 *  is still open. A completed blocker doesn't block. */
export function isTaskBlocked(
  task: TaskRecord,
  byId: Map<string, TaskRecord>
): boolean {
  if (task.status !== 'pending') return false
  return task.blockedBy.some((id) => {
    const blocker = byId.get(id)
    // An unknown blocker is treated as still open — safer than claiming
    // the task is ready when we can't see what it's waiting on.
    return !blocker || blocker.status !== 'completed'
  })
}

export function countOpenTasks(tasks: TaskRecord[]): number {
  let n = 0
  for (const t of tasks) if (t.status !== 'completed') n += 1
  return n
}
