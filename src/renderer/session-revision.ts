import { useEffect, useState } from 'react'
import type { JsonClaudeSession } from '../shared/state/json-claude'

/** How often a derived panel re-checks while its session is live. */
const REVISION_POLL_MS = 500

/** Constant-time stand-in for "has this session changed in a way a
 *  derived panel cares about".
 *
 *  Entry COUNT alone is not that signal, which is the bug this exists to
 *  fix. `assistantBlockAppended` adds a tool_use block to the assistant
 *  entry already in flight, so a TodoWrite / TaskCreate / Agent call
 *  lands *without* the array growing — a panel keyed on length alone
 *  never re-derives and sits empty for the whole turn. The last entry's
 *  id and block count catch that, and stay O(1): walking the entries to
 *  hash them properly would cost exactly what the memo exists to avoid.
 *
 *  Session id is folded in because two sessions can agree on every other
 *  field, and switching tabs between them must re-derive. */
export function sessionSignature(
  session: JsonClaudeSession | null | undefined
): string {
  const entries = session?.entries
  if (!session || !entries || entries.length === 0) {
    return `${session?.sessionId ?? ''}:0`
  }
  const last = entries[entries.length - 1]
  return `${session.sessionId}:${entries.length}:${last.entryId}:${
    last.blocks?.length ?? 0
  }`
}

/** Memo key for a panel derived from a session's entries.
 *
 *  Using the session object itself would re-derive on every streamed
 *  token (CLAUDE.md anti-pattern #4 — its identity churns per delta).
 *  This changes on structural edits, plus a slow poll while the session
 *  is live so in-place mutations the signature can't see — a tool_result
 *  patched into an existing block, a block appended to an entry that
 *  isn't last because a sub-agent is interleaving — still land within
 *  half a second instead of never.
 *
 *  `alsoLive` keeps the poll running for work that outlives the turn:
 *  a background agent is still going after `busy` goes false. */
export function useSessionRevision(
  session: JsonClaudeSession | null | undefined,
  alsoLive = false
): string {
  const [tick, setTick] = useState(0)
  const live = !!session?.busy || alsoLive
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setTick((t) => t + 1), REVISION_POLL_MS)
    return () => clearInterval(id)
  }, [live])
  return `${sessionSignature(session)}:${live ? tick : 'idle'}`
}
