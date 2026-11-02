// The behaviour every ChatProvider owes the rest of Ness, as one suite each
// provider's test file runs against its own fake agent process. Adding a
// provider means writing a harness (how the fake agent receives a message,
// replies and dies) and calling describeChatProviderContract with it — the
// shared slice, status deriver and renderer then rely on what's below
// holding for that provider too.

import { describe, it, expect } from 'vitest'
import type { Store } from '../store'
import type { ChatProvider } from '../chat-provider'
import type { AgentKind } from '../../shared/state/terminals'
import type { JsonClaudeSession } from '../../shared/state/json-claude'
import { getChatCapabilities, supportsChat, supportsConversationFork } from '../../shared/agent-registry'

export interface ChatProviderContractHarness {
  agentKind: AgentKind
  store: Store
  provider: ChatProvider
  worktreePath: string
  /** Let the fake agent finish whatever the provider is waiting on
   *  (handshakes, request round trips). */
  settle(): Promise<void>
  /** The user turns the fake agent has received, as plain text. */
  receivedUserText(sessionId: string): string[]
  /** Make the fake agent reply with `text` and end the turn. */
  replyAndFinish(sessionId: string, text: string): Promise<void>
  /** Make the fake agent's process exit unexpectedly. */
  crash(sessionId: string): Promise<void>
}

const SID = 'contract-session'

export function describeChatProviderContract(
  name: string,
  makeHarness: () => ChatProviderContractHarness
): void {
  describe(`ChatProvider contract: ${name}`, () => {
    function session(h: ChatProviderContractHarness): JsonClaudeSession {
      return h.store.getSnapshot().state.jsonClaude.sessions[SID]
    }

    async function started(): Promise<ChatProviderContractHarness> {
      const h = makeHarness()
      h.store.dispatch({
        type: 'jsonClaude/sessionStarted',
        payload: {
          sessionId: SID,
          worktreePath: h.worktreePath,
          ...(h.agentKind !== 'claude' ? { agentKind: h.agentKind } : {})
        }
      })
      h.provider.create(SID, h.worktreePath, 'default')
      await h.settle()
      return h
    }

    it('is declared as a chat agent in the registry', () => {
      const h = makeHarness()
      expect(supportsChat(h.agentKind)).toBe(true)
    })

    it('reaches running and owns the session once created', async () => {
      const h = await started()
      expect(session(h).state).toBe('running')
      expect(h.provider.hasSession(SID)).toBe(true)
    })

    it('records the user turn, marks the session busy and hands the text to the agent', async () => {
      const h = await started()
      h.provider.send(SID, 'hello agent')
      await h.settle()
      const last = session(h).entries.at(-1)
      expect(last).toMatchObject({ kind: 'user', text: 'hello agent' })
      expect(session(h).busy).toBe(true)
      expect(h.receivedUserText(SID)).toContain('hello agent')
    })

    it("turns the agent's reply into a finished assistant entry and goes idle", async () => {
      const h = await started()
      h.provider.send(SID, 'hello agent')
      await h.settle()
      await h.replyAndFinish(SID, 'hello human')
      const assistant = session(h).entries.filter((e) => e.kind === 'assistant')
      expect(assistant.at(-1)?.blocks?.some((b) => b.type === 'text' && b.text === 'hello human')).toBe(true)
      expect(assistant.some((e) => e.isPartial)).toBe(false)
      expect(session(h).busy).toBe(false)
    })

    it('goes idle immediately on interrupt', async () => {
      const h = await started()
      h.provider.send(SID, 'long task')
      await h.settle()
      h.provider.interrupt(SID)
      expect(session(h).busy).toBe(false)
    })

    it('exits cleanly on kill and lets go of the session', async () => {
      const h = await started()
      h.provider.kill(SID)
      expect(session(h).state).toBe('exited')
      expect(h.provider.hasSession(SID)).toBe(false)
    })

    it('surfaces an unexpected process exit as an exited session with an error card', async () => {
      const h = await started()
      await h.crash(SID)
      expect(session(h).state).toBe('exited')
      expect(session(h).busy).toBe(false)
      expect(session(h).entries.at(-1)).toMatchObject({ kind: 'error', errorKind: 'subprocess-exit' })
      expect(h.provider.hasSession(SID)).toBe(false)
    })

    it('answers transcriptPath without throwing', async () => {
      const h = await started()
      const path = h.provider.transcriptPath(SID, h.worktreePath)
      expect(path === null || typeof path === 'string').toBe(true)
    })

    it('never offers a worktree fork the registry says this agent cannot do', async () => {
      const h = await started()
      if (!supportsConversationFork(h.agentKind)) {
        expect(h.provider.canForkIntoWorktree(SID, h.worktreePath)).toBe(false)
      }
    })

    it('declares only capabilities its provider implements', () => {
      const h = makeHarness()
      const caps = getChatCapabilities(h.agentKind)
      if (caps.rewind) expect(typeof h.provider.rewindTo).toBe('function')
      if (caps.fork) expect(typeof h.provider.forkAt).toBe('function')
      if (caps.permissionModes) expect(typeof h.provider.setPermissionMode).toBe('function')
    })
  })
}
