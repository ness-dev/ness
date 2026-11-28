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
  customLabelSource: 'persisted',
  agentKind: 'persisted',
  model: 'persisted',
  sessionId: 'persisted',
  providerSessionId: 'persisted',
  reviewOf: 'persisted',
  url: 'persisted',
  command: 'persisted',
  cwd: 'persisted',
  mode: 'restored tabs are asleep until focused',
  initialPrompt: 'one-shot kickoff, already delivered',
  teleportSessionId: 'one-shot teleport, already consumed',
  filePath: 'persisted',
  staged: 'persisted',
  branchDiff: 'persisted',
  commitHash: 'persisted',
  reviewFromCommit: 'persisted',
  reviewToCommit: 'persisted'
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
    customLabelSource: 'agent',
    agentKind: 'codex',
    model: 'gpt-test',
    sessionId: 'chat-1',
    providerSessionId: 'thread-1',
    reviewOf: 'author-tab-1',
    url: 'https://example.com',
    command: 'npm test',
    cwd: 'sub/dir',
    mode: 'awake',
    initialPrompt: 'kick off',
    teleportSessionId: 'teleport-1',
    filePath: 'persisted',
    staged: true,
    branchDiff: true,
    commitHash: 'persisted',
    reviewFromCommit: 'persisted',
    reviewToCommit: 'persisted'
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

  it.each<[string, TerminalTab]>([
    ['review tab with a commit selection', { id: 'r-1', type: 'review', label: 'Review', reviewFromCommit: 'abc', reviewToCommit: 'def' }],
    ['file tab', { id: 'file-a.ts', type: 'file', label: 'a.ts', filePath: 'src/a.ts' }],
    ['staged diff tab', { id: 'd-1', type: 'diff', label: 'a.ts', filePath: 'src/a.ts', staged: true }],
    ['branch diff tab', { id: 'd-2', type: 'diff', label: 'a.ts', filePath: 'src/a.ts', branchDiff: true }],
    ['commit diff tab', { id: 'd-3', type: 'diff', label: 'abc123', commitHash: 'abc123' }]
  ])('restores a %s as it was saved', async (_name, tab) => {
    expect(await roundTrip(tab)).toEqual(tab)
  })

  it('loads a saved layout from before viewer tabs were persisted', async () => {
    const store = new Store(initialState)
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null
    })
    await fsm.restoreFromConfig({
      repo: {
        '/wt': {
          type: 'leaf',
          id: 'pane-1',
          tabs: [{ id: 's-1', type: 'shell', label: 'Shell' }],
          activeTabId: 's-1'
        }
      }
    })
    fsm.ensureInitialized('/wt')
    const leaf = store.getSnapshot().state.terminals.panes['/wt'] as PaneLeaf
    expect(leaf.tabs).toEqual([{ id: 's-1', type: 'shell', label: 'Shell', mode: 'asleep' }])
  })
})
