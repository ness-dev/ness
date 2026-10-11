import type { JsonClaudeChatEntry } from '../../../shared/state/json-claude'

// Re-exported from the shared agents module so the chat's nesting pre-pass
// and the Agents panel can never disagree about what counts as a sub-agent.
export {
  SUBAGENT_TOOL_NAMES,
  isSubAgentToolName
} from '../../../shared/state/json-claude-agents'
import { isSubAgentToolName } from '../../../shared/state/json-claude-agents'

export interface BuildChildrenMapResult {
  topLevelEntries: JsonClaudeChatEntry[]
  childrenByParentToolUseId: Map<string, JsonClaudeChatEntry[]>
}

/** Pre-pass for sub-agent nesting. Splits the entries array into a
 *  top-level transcript (rendered chronologically) and a map of
 *  child entries keyed by their parent Task tool_use id (rendered
 *  inside the matching parent TaskCard). Nesting is recursive — a
 *  sub-agent can itself spawn Task calls, producing grandchildren.
 *
 *  Orphan fallback: an entry whose parentToolUseId references no
 *  visible Task tool_use block (the parent block was truncated, or
 *  hasn't streamed in yet) is still recorded in the children map so
 *  callers can inspect it, AND surfaced at the top level so it isn't
 *  lost from the rendered transcript. */
export function buildChildrenMap(
  entries: JsonClaudeChatEntry[]
): BuildChildrenMapResult {
  const taskToolUseIds = new Set<string>()
  for (const entry of entries) {
    if (!entry.blocks) continue
    for (const b of entry.blocks) {
      if (b.type === 'tool_use' && isSubAgentToolName(b.name) && b.id) {
        taskToolUseIds.add(b.id)
      }
    }
  }
  const topLevelEntries: JsonClaudeChatEntry[] = []
  const childrenByParentToolUseId = new Map<string, JsonClaudeChatEntry[]>()
  for (const entry of entries) {
    const pid = entry.parentToolUseId
    if (pid) {
      const list = childrenByParentToolUseId.get(pid) ?? []
      list.push(entry)
      childrenByParentToolUseId.set(pid, list)
    }
    if (!pid || !taskToolUseIds.has(pid)) {
      topLevelEntries.push(entry)
    }
  }
  return { topLevelEntries, childrenByParentToolUseId }
}
