import { QUESTION_TOOL_NAME } from '../../shared/state/json-claude'
import { useJsonClaudeApprovals } from '../hooks/useJsonClaudeApprovals'
import { JsonClaudeApprovalCard } from './JsonClaudeApprovalCard'

/** The approval prompts one sub-agent is blocked on, for the Subagents
 *  column and the agent peek. The same prompt also renders inside the
 *  agent's Task card in the transcript, but for a background agent that
 *  card is usually far up the scrollback — so without this the only sign
 *  was a ⚠ on a card that couldn't do anything about it. Resolving either
 *  copy resolves the request; the other unmounts with it.
 *
 *  Reads the approvals itself rather than taking them as props so an
 *  auto-review update repaints the card without breaking the agent
 *  card's memo, which only fingerprints the ids. */
export function AgentApprovalCards({
  sessionId,
  toolUseIds
}: {
  sessionId: string
  toolUseIds: readonly string[]
}): JSX.Element | null {
  const { pending, resolve } = useJsonClaudeApprovals(sessionId)
  if (toolUseIds.length === 0) return null
  const mine = pending.filter((a) => a.toolUseId && toolUseIds.includes(a.toolUseId))
  if (mine.length === 0) return null
  return (
    <div className="space-y-1">
      {mine.map((approval) =>
        // The question card autofocuses and keeps a local draft, so a
        // second copy would steal focus from the transcript's and split
        // the answer across two inputs. Point at the one that exists.
        approval.toolName === QUESTION_TOOL_NAME ? (
          <div
            key={approval.requestId}
            className="px-2 py-1 text-xs text-warning border border-warning/40 rounded"
          >
            Asking you a question. Answer it in the chat.
          </div>
        ) : (
          <JsonClaudeApprovalCard
            key={approval.requestId}
            approval={approval}
            onResolve={(result) => resolve(approval.requestId, result)}
          />
        )
      )}
    </div>
  )
}
