import { describe, it, expect, vi } from 'vitest'
import { Store } from './store'
import { PanesFSM } from './panes-fsm'
import type { PaneLeaf, PaneNode, TerminalTab } from '../shared/state/terminals'

vi.mock('./perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

vi.mock('./debug', () => ({
  log: vi.fn()
}))

function buildFSM(): { fsm: PanesFSM; store: Store } {
  const store = new Store()
  const fsm = new PanesFSM(store, {
    persist: () => {},
    getRepoRootForWorktree: () => undefined,
    getLatestClaudeSessionId: async () => null
  })
  return { fsm, store }
}

function seedLeaf(store: Store, wtPath: string, leaf: PaneLeaf): void {
  store.dispatch({
    type: 'terminals/panesForWorktreeChanged',
    payload: { worktreePath: wtPath, panes: leaf }
  })
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('PanesFSM.splitPane', () => {
  it('mints a UUID id for a json-claude clone so the Claude CLI accepts --session-id', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/json'
    const sourceTabId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const sourceTab: TerminalTab = {
      id: sourceTabId,
      type: 'json-claude',
      label: 'Chat',
      sessionId: sourceTabId,
      mode: 'awake',
      model: 'opus'
    }
    const sourcePane: PaneLeaf = {
      type: 'leaf',
      id: 'pane-source',
      tabs: [sourceTab],
      activeTabId: sourceTabId
    }
    seedLeaf(store, wtPath, sourcePane)

    const newPane = fsm.splitPane(wtPath, 'pane-source', 'horizontal')

    expect(newPane).not.toBeNull()
    expect(newPane!.tabs).toHaveLength(1)
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('json-claude')
    expect(cloned.id).toMatch(UUID_RE)
    expect(cloned.id).not.toBe(sourceTabId)
    // tab.id and sessionId must agree — Chat tabs treat them as one value
    expect(cloned.sessionId).toBe(cloned.id)
    expect(cloned.mode).toBe('awake')
    // Inherits the source's model + label
    expect(cloned.model).toBe('opus')
    expect(cloned.label).toBe('Chat')
  })

  it('does not carry over initialPrompt/teleportSessionId from the source chat', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/json2'
    const sourceTabId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    const sourceTab: TerminalTab = {
      id: sourceTabId,
      type: 'json-claude',
      label: 'Chat',
      sessionId: sourceTabId,
      mode: 'awake',
      initialPrompt: 'stale kickoff',
      teleportSessionId: 'stale-teleport'
    }
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-source',
      tabs: [sourceTab],
      activeTabId: sourceTabId
    })

    const newPane = fsm.splitPane(wtPath, 'pane-source', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.initialPrompt).toBeUndefined()
    expect(cloned.teleportSessionId).toBeUndefined()
  })

  it('clones an agent source into a fresh shell tab (regression check)', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/agent'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-agent',
      tabs: [
        {
          id: 'agent-1',
          type: 'agent',
          agentKind: 'claude',
          label: 'Claude',
          sessionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
        }
      ],
      activeTabId: 'agent-1'
    })

    const newPane = fsm.splitPane(wtPath, 'pane-agent', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('shell')
    expect(cloned.id).toMatch(/^shell-/)
  })

  it('clones a diff source by copying the source tab with a new diff-prefixed id', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/diff'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-diff',
      tabs: [
        {
          id: 'diff-1',
          type: 'diff',
          label: 'src/foo.ts',
          filePath: 'src/foo.ts',
          staged: false
        }
      ],
      activeTabId: 'diff-1'
    })

    const newPane = fsm.splitPane(wtPath, 'pane-diff', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('diff')
    expect(cloned.id).toMatch(/^diff-/)
    expect(cloned.id).not.toBe('diff-1')
    expect(cloned.filePath).toBe('src/foo.ts')
  })

  it('wraps the source pane in a split node containing both children', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/split'
    const sourceTabId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-source',
      tabs: [
        {
          id: sourceTabId,
          type: 'json-claude',
          label: 'Chat',
          sessionId: sourceTabId,
          mode: 'awake'
        }
      ],
      activeTabId: sourceTabId
    })

    fsm.splitPane(wtPath, 'pane-source', 'vertical')
    const tree = store.getSnapshot().state.terminals.panes[wtPath] as PaneNode
    expect(tree.type).toBe('split')
    if (tree.type === 'split') {
      expect(tree.direction).toBe('vertical')
      expect(tree.children).toHaveLength(2)
      expect(tree.children[0].id).toBe('pane-source')
    }
  })
})

describe('PanesFSM.restoreFromConfig', () => {
  it('hydrates persisted shell and json-claude tabs as asleep, agent tabs as awake', async () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/restore'
    await fsm.restoreFromConfig({
      _ignored: {
        [wtPath]: {
          type: 'leaf',
          id: 'pane-1',
          tabs: [
            { id: 'sh-1', type: 'shell', label: 'Shell' },
            { id: 'agent-1', type: 'agent', label: 'Claude', agentKind: 'claude' },
            {
              id: 'chat-1',
              type: 'json-claude',
              label: 'Chat',
              sessionId: 'chat-1'
            }
          ],
          activeTabId: 'sh-1'
        }
      }
    })
    fsm.ensureInitialized(wtPath)
    const tree = store.getSnapshot().state.terminals.panes[wtPath]
    expect(tree?.type).toBe('leaf')
    const leaf = tree as PaneLeaf
    const shellTab = leaf.tabs.find((t) => t.id === 'sh-1')
    const agentTab = leaf.tabs.find((t) => t.id === 'agent-1')
    const chatTab = leaf.tabs.find((t) => t.id === 'chat-1')
    expect(shellTab?.mode).toBe('asleep')
    expect(agentTab?.mode).toBeUndefined()
    expect(chatTab?.mode).toBe('asleep')
  })

  it('restores a codex chat tab’s providerSessionId', async () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/restore-codex'
    await fsm.restoreFromConfig({
      _ignored: {
        [wtPath]: {
          type: 'leaf',
          id: 'pane-1',
          tabs: [
            {
              id: 'chat-1',
              type: 'json-claude',
              label: 'Chat',
              agentKind: 'codex',
              sessionId: 'chat-1',
              providerSessionId: 'thread-1'
            }
          ],
          activeTabId: 'chat-1'
        }
      }
    })
    fsm.ensureInitialized(wtPath)
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs[0].providerSessionId).toBe('thread-1')
  })
})

describe('PanesFSM.ensureInitialized', () => {
  it('skips creating tabs for a prunable worktree (issue #185)', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/tmp/gone'
    // Seed the store with a prunable entry so ensureInitialized's
    // guard can find it.
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [
        {
          path: wtPath,
          branch: 'gh-pages',
          head: '',
          isBare: false,
          isMain: false,
          createdAt: 0,
          repoRoot: '/tmp/repo',
          prunable: true,
          prunableReason: 'gitdir file points to non-existent location'
        }
      ]
    })

    fsm.ensureInitialized(wtPath)

    // No pane committed to the store — no spawn ever fires for prunable
    // entries. If the caller wants to observe them they can look at the
    // worktrees slice directly.
    expect(store.getSnapshot().state.terminals.panes[wtPath]).toBeUndefined()
  })

  it('still creates tabs when the worktree is not prunable', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/tmp/live'
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [
        {
          path: wtPath,
          branch: 'main',
          head: '',
          isBare: false,
          isMain: true,
          createdAt: 0,
          repoRoot: '/tmp/live'
        }
      ]
    })

    fsm.ensureInitialized(wtPath)

    const tree = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(tree).toBeDefined()
    expect(tree.tabs.length).toBeGreaterThan(0)
  })

  it('sanitizes path separators out of the shell tab id (issue #198)', () => {
    // The shell tab id flows into $HARNESS_TERMINAL_ID which the Claude
    // Code hooks use as a filename component under /tmp/harness-status.
    // A raw wtPath left slashes in the id and bash's `>>` refused to
    // create the intermediate dirs, surfacing a "hook error" per tool
    // call. Match the agent/review sanitize pattern (see openReviewTab
    // and the agent tab id in ensureInitialized).
    const { fsm, store } = buildFSM()
    const wtPath = '/Users/me/worktrees/branch-x'
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [
        {
          path: wtPath,
          branch: 'branch-x',
          head: '',
          isBare: false,
          isMain: false,
          createdAt: 0,
          repoRoot: '/Users/me/repo'
        }
      ]
    })

    fsm.ensureInitialized(wtPath)

    const tree = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const shell = tree.tabs.find((t) => t.type === 'shell')
    expect(shell).toBeDefined()
    expect(shell!.id).not.toContain('/')
    expect(shell!.id).toMatch(/^shell-/)
  })

  it('sends the kickoff prompt to an existing chat tab instead of dropping it', () => {
    // A prompt-less ensureInitialized (main's worktrees/listChanged sweep)
    // can win the race against the creation FSM's prompt-carrying one while
    // the setup script is still running.
    const store = new Store()
    const startJsonClaudeWithPrompt = vi.fn()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultClaudeTabType: () => 'json',
      startJsonClaudeWithPrompt
    })
    const wtPath = '/tmp/raced'
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [
        {
          path: wtPath,
          branch: 'feature',
          head: '',
          isBare: false,
          isMain: false,
          createdAt: 0,
          repoRoot: '/tmp/repo'
        }
      ]
    })

    fsm.ensureInitialized(wtPath)
    expect(startJsonClaudeWithPrompt).not.toHaveBeenCalled()
    const raced = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const chat = raced.tabs.find((t) => t.type === 'json-claude')!

    fsm.ensureInitialized(wtPath, { initialPrompt: 'go build the thing' })

    expect(startJsonClaudeWithPrompt).toHaveBeenCalledWith(
      chat.id,
      wtPath,
      'go build the thing'
    )
  })
})

describe('PanesFSM.openFileTab', () => {
  it('appends a file tab with the file-<path> id and basename label', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/files'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'sh-1', type: 'shell', label: 'Shell' }],
      activeTabId: 'sh-1'
    })

    fsm.openFileTab(wtPath, 'src/main/index.ts')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const fileTab = leaf.tabs.find((t) => t.type === 'file')
    expect(fileTab?.id).toBe('file-src/main/index.ts')
    expect(fileTab?.filePath).toBe('src/main/index.ts')
    expect(fileTab?.label).toBe('index.ts')
    // newly added tab becomes active in its pane
    expect(leaf.activeTabId).toBe('file-src/main/index.ts')
  })

  it('opens the file in the pane containing nearTabId (split layout)', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/split'
    const split: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'leaf', id: 'pane-left', tabs: [{ id: 'agent-1', type: 'agent', label: 'Claude' }], activeTabId: 'agent-1' },
        { type: 'leaf', id: 'pane-right', tabs: [{ id: 'sh-1', type: 'shell', label: 'Shell' }], activeTabId: 'sh-1' }
      ]
    }
    store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: wtPath, panes: split }
    })

    // Clicked a file link in the right pane's shell.
    fsm.openFileTab(wtPath, 'src/x.ts', 'sh-1')

    const tree = store.getSnapshot().state.terminals.panes[wtPath] as PaneNode
    const right = (tree as { children: PaneLeaf[] }).children[1]
    expect(right.id).toBe('pane-right')
    expect(right.tabs.some((t) => t.id === 'file-src/x.ts')).toBe(true)
    expect(right.activeTabId).toBe('file-src/x.ts')
    // left pane untouched
    const left = (tree as { children: PaneLeaf[] }).children[0]
    expect(left.tabs.every((t) => t.type !== 'file')).toBe(true)
  })

  it('focuses an existing file tab for the same path instead of duplicating', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/files2'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: 'file-src/a.ts', type: 'file', label: 'a.ts', filePath: 'src/a.ts' },
        { id: 'sh-1', type: 'shell', label: 'Shell' }
      ],
      activeTabId: 'sh-1'
    })

    fsm.openFileTab(wtPath, 'src/a.ts')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs.filter((t) => t.type === 'file')).toHaveLength(1)
    expect(leaf.activeTabId).toBe('file-src/a.ts')
  })
})

describe('PanesFSM chat-provider gating', () => {
  it('refuses to convert an agent tab whose agent has no chat provider', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/cursor'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'agent-1', type: 'agent', label: 'Cursor Agent', agentKind: 'cursor' }],
      activeTabId: 'agent-1'
    })

    fsm.convertTabType(wtPath, 'agent-1', 'json-claude')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs[0].type).toBe('agent')
    expect(leaf.tabs[0].id).toBe('agent-1')
  })

  it('opens an agent without a chat provider as a terminal tab even when chat is the default', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultClaudeTabType: () => 'json'
    })
    const wtPath = '/tmp/cursor-default'
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [
        {
          path: wtPath,
          branch: 'feature',
          head: '',
          isBare: false,
          isMain: false,
          createdAt: 0,
          repoRoot: '/tmp/repo'
        }
      ]
    })

    fsm.ensureInitialized(wtPath, { agentKind: 'cursor' })

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs.some((t) => t.type === 'json-claude')).toBe(false)
    expect(leaf.tabs.find((t) => t.type === 'agent')?.agentKind).toBe('cursor')
  })

  it('opens a codex chat tab when chat is the default', () => {
    const store = new Store()
    const startJsonClaudeWithPrompt = vi.fn()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultClaudeTabType: () => 'json',
      startJsonClaudeWithPrompt
    })
    const wtPath = '/tmp/codex-chat'
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [
        {
          path: wtPath,
          branch: 'feature',
          head: '',
          isBare: false,
          isMain: false,
          createdAt: 0,
          repoRoot: '/tmp/repo'
        }
      ]
    })

    fsm.ensureInitialized(wtPath, { agentKind: 'codex', initialPrompt: 'hi' })

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const chat = leaf.tabs.find((t) => t.type === 'json-claude')
    expect(chat?.agentKind).toBe('codex')
    expect(startJsonClaudeWithPrompt).toHaveBeenCalledWith(chat!.id, wtPath, 'hi')
  })

  it('carries agentKind onto a split chat clone', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/split-kind'
    const sourceTabId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-source',
      tabs: [
        {
          id: sourceTabId,
          type: 'json-claude',
          label: 'Chat',
          sessionId: sourceTabId,
          mode: 'awake',
          agentKind: 'codex'
        }
      ],
      activeTabId: sourceTabId
    })

    const newPane = fsm.splitPane(wtPath, 'pane-source', 'horizontal')

    expect(newPane!.tabs[0].agentKind).toBe('codex')
  })
})

describe('PanesFSM.setTabProviderSessionId', () => {
  it('records the id on the tab in whichever worktree holds it and persists', () => {
    const store = new Store()
    const persist = vi.fn()
    const fsm = new PanesFSM(store, {
      persist,
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null
    })
    seedLeaf(store, '/wt/one', {
      type: 'leaf',
      id: 'p1',
      tabs: [{ id: 'chat-1', type: 'json-claude', label: 'Chat', sessionId: 'chat-1', agentKind: 'codex' }],
      activeTabId: 'chat-1'
    })

    fsm.setTabProviderSessionId('chat-1', 'thread-1')

    const leaf = store.getSnapshot().state.terminals.panes['/wt/one'] as PaneLeaf
    expect(leaf.tabs[0].providerSessionId).toBe('thread-1')
    expect(persist).toHaveBeenCalled()
  })

  it('does nothing for an unknown tab', () => {
    const store = new Store()
    const persist = vi.fn()
    const fsm = new PanesFSM(store, {
      persist,
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null
    })
    fsm.setTabProviderSessionId('nope', 'thread-1')
    expect(persist).not.toHaveBeenCalled()
  })
})

describe('PanesFSM forked Codex conversations', () => {
  it('opens a Codex fork in Chat even when Terminal is the default tab type', () => {
    const store = new Store()
    const startJsonClaudeWithPrompt = vi.fn()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultClaudeTabType: () => 'xterm',
      startJsonClaudeWithPrompt
    })
    const wtPath = '/tmp/codex-fork'
    store.dispatch({
      type: 'worktrees/listChanged',
      payload: [
        { path: wtPath, branch: 'spinoff', head: '', isBare: false, isMain: false, createdAt: 0, repoRoot: '/tmp/repo' }
      ]
    })

    fsm.ensureInitialized(wtPath, { agentKind: 'codex', forkedSessionId: 'fork-1', initialPrompt: 'carry on' })

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const chat = leaf.tabs.find((t) => t.type === 'json-claude')
    expect(chat).toMatchObject({ id: 'fork-1', agentKind: 'codex' })
    expect(startJsonClaudeWithPrompt).toHaveBeenCalledWith('fork-1', wtPath, 'carry on')
  })
})
