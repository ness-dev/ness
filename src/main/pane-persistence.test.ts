import { describe, it, expect, vi } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))

import { Store } from './store'
import { initialState } from '../shared/state'
import { PanesFSM } from './panes-fsm'
import { treeToPersistedNode } from './pane-persistence'
import type { PaneLeaf, TerminalTab } from '../shared/state/terminals'

/** Every TerminalTab field, and whether it should survive a restart. A new
 *  field fails typecheck here until it's classified — the providerSessionId
 *  bug was a field quietly missing from the save path. 'persisted' fields
 *  are checked by the round trip below; anything else says why it's
 *  dropped. */
const TAB_FIELDS: Record<keyof TerminalTab, 'persisted' | string> = {
  id: 'persisted',
  type: 'persisted',
  label: 'persisted',
  customLabel: 'persisted',
  agentKind: 'persisted',
  model: 'persisted',
  sessionId: 'persisted',
  providerSessionId: 'persisted',
  url: 'persisted',
  command: 'persisted',
  cwd: 'persisted',
  mode: 'restored tabs are asleep until focused',
  initialPrompt: 'one-shot kickoff, already delivered',
  teleportSessionId: 'one-shot teleport, already consumed',
  filePath: 'diff/file tabs are not persisted',
  staged: 'diff tabs are not persisted',
  branchDiff: 'diff tabs are not persisted',
  commitHash: 'diff tabs are not persisted',
  reviewFromCommit: 'review tabs are not persisted',
  reviewToCommit: 'review tabs are not persisted'
}

const persistedKeys = (Object.keys(TAB_FIELDS) as (keyof TerminalTab)[]).filter(
  (k) => TAB_FIELDS[k] === 'persisted'
)

function fullyPopulatedTab(): TerminalTab {
  return {
    id: 'chat-1',
    type: 'json-claude',
    label: 'Chat',
    customLabel: 'My chat',
    agentKind: 'codex',
    model: 'gpt-test',
    sessionId: 'chat-1',
    providerSessionId: 'thread-1',
    url: 'https://example.com',
    command: 'npm test',
    cwd: 'sub/dir',
    mode: 'awake',
    initialPrompt: 'kick off',
    teleportSessionId: 'teleport-1',
    filePath: 'a.ts',
    staged: true,
    branchDiff: true,
    commitHash: 'abc123',
    reviewFromCommit: 'abc',
    reviewToCommit: 'def'
  }
}

async function roundTrip(tab: TerminalTab, liveUrl: string | null = null): Promise<TerminalTab | undefined> {
  const leaf: PaneLeaf = { type: 'leaf', id: 'pane-1', tabs: [tab], activeTabId: tab.id }
  const persisted = treeToPersistedNode(leaf, () => liveUrl)
  const store = new Store(initialState)
  const fsm = new PanesFSM(store, {
    persist: () => {},
    getRepoRootForWorktree: () => undefined,
    getLatestClaudeSessionId: async () => null
  })
  // Through JSON, as config.json does, so an unserializable value fails too.
  await fsm.restoreFromConfig({ repo: { '/wt': JSON.parse(JSON.stringify(persisted)) } })
  fsm.ensureInitialized('/wt')
  const restored = store.getSnapshot().state.terminals.panes['/wt'] as PaneLeaf
  return restored.tabs.find((t) => t.id === tab.id)
}

describe('tab persistence round trip', () => {
  it('restores every persisted field of a tab exactly as it was saved', async () => {
    const tab = fullyPopulatedTab()
    const restored = await roundTrip(tab)
    for (const key of persistedKeys) {
      expect(restored?.[key], key).toEqual(tab[key])
    }
  })

  it('drops the fields that are not meant to outlive the session', async () => {
    const restored = await roundTrip(fullyPopulatedTab())
    for (const key of ['initialPrompt', 'teleportSessionId'] as const) {
      expect(restored?.[key], key).toBeUndefined()
    }
    expect(restored?.mode).toBe('asleep')
  })

  it("saves a browser tab at the URL it navigated to, not the one it opened with", async () => {
    const restored = await roundTrip(
      { id: 'b-1', type: 'browser', label: 'Browser', url: 'https://opened.example' },
      'https://navigated.example'
    )
    expect(restored?.url).toBe('https://navigated.example')
  })

  it('leaves tab types that are rebuilt on demand out of the saved layout', () => {
    const leaf: PaneLeaf = {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: 'd-1', type: 'diff', label: 'Diff', filePath: 'a.ts' },
        { id: 'r-1', type: 'review', label: 'Review' },
        { id: 'f-1', type: 'file', label: 'a.ts', filePath: 'a.ts' }
      ],
      activeTabId: 'd-1'
    }
    expect(treeToPersistedNode(leaf, () => null)).toBeNull()
  })
})
