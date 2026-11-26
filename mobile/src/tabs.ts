// Tab choices the phone makes on its own, kept out of App.tsx so the
// contract test (test/contract.test.ts) runs the same code against a real
// server.
import { randomUUID } from '../../src/renderer/uuid'
import type { PaneNode, TerminalTab } from '../../src/shared/state/terminals'

export { pickInitialTab } from '../../src/renderer/pick-initial-tab'

/** A new Chat tab: one UUID as both tab id and session id, same as
 *  useTabHandlers. */
export function newChatTab(): TerminalTab {
  const sessionId = randomUUID()
  return { id: sessionId, type: 'json-claude', label: 'Chat', sessionId }
}

export function firstLeafId(tree: PaneNode): string {
  return tree.type === 'leaf' ? tree.id : firstLeafId(tree.children[0])
}
