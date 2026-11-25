import { describe, it, expect } from 'vitest'
import { buildInboxModel, nextInboxItem, prEventFor, type InboxModelInput } from './inbox-model'
import type { Worktree } from '../shared/state/worktrees'
import type { TerminalTab } from '../shared/state/terminals'
import type { PRStatus } from '../shared/state/prs'

function wt(path: string, branch: string): Worktree {
  return { path, branch, head: 'x', isBare: false, isMain: false, createdAt: 0, repoRoot: '/r/app' }
}

function input(over: Partial<InboxModelInput> = {}): InboxModelInput {
  const tabs: TerminalTab[] = [
    { id: 'a', type: 'json-claude', label: 'Chat A' },
    { id: 'b', type: 'agent', label: 'Claude B' },
    { id: 'c', type: 'json-claude', label: 'Chat C' },
    { id: 'd', type: 'json-claude', label: 'Chat D' },
    { id: 'e', type: 'agent', label: 'Claude E' },
    { id: 'f', type: 'json-claude', label: 'Chat F' },
    { id: 'sh', type: 'shell', label: 'Shell' }
  ]
  return {
    worktrees: [wt('/w1', 'feat-x')],
    panes: { '/w1': { type: 'leaf', id: 'p1', tabs, activeTabId: 'a' } },
    statuses: { a: 'needs-approval', b: 'needs-approval', c: 'waiting', d: 'waiting', e: 'processing', f: 'waiting' },
    pendingTools: {
      a: { name: 'Bash', input: { command: 'rm -rf build' } },
      b: { name: 'AskUserQuestion', input: { questions: [{ question: 'Which DB?', options: [] }] } }
    },
    prStatuses: {},
    mergedPaths: {},
    aliases: { '/w1': 'Feature X' },
    inbox: {
      turns: {
        c: { worktreePath: '/w1', endedAt: 50, kind: 'question', text: 'Push it?' },
        d: { worktreePath: '/w1', endedAt: 40, kind: 'finished', text: 'Done.' },
        f: { worktreePath: '/w1', endedAt: 30, kind: 'finished', text: 'Old news' }
      },
      seenAt: { f: 31 },
      statusSince: { a: { status: 'needs-approval', since: 20 } },
      prSeen: {}
    },
    ...over
  }
}

const keysOf = (m: ReturnType<typeof buildInboxModel>, section: string): string[] =>
  m.sections.find((s) => s.key === section)!.items.map((i) => i.key)

describe('buildInboxModel', () => {
  it('buckets each agent tab by what it needs, and skips shells', () => {
    const m = buildInboxModel(input())
    expect(keysOf(m, 'approval')).toEqual(['a'])
    expect(keysOf(m, 'question')).toEqual(['b', 'c'])
    expect(keysOf(m, 'done')).toEqual(['d'])
    expect(keysOf(m, 'working')).toEqual(['e'])
    expect(keysOf(m, 'seen')).toEqual(['f'])
    expect(m.needsYou.map((i) => i.key)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('labels rows with repo, alias and tab, and says why', () => {
    const a = buildInboxModel(input()).needsYou[0]
    expect(a).toMatchObject({ repoName: 'app', worktreeLabel: 'Feature X', tabLabel: 'Chat A', paneId: 'p1' })
    expect(a.why).toBe('Bash "rm -rf build"')
    expect(buildInboxModel(input()).needsYou[1].why).toBe('Which DB?')
  })

  it('sorts needs-you sections oldest first', () => {
    const base = input()
    const m = buildInboxModel({
      ...base,
      statuses: { ...base.statuses, a: 'waiting', b: 'waiting' },
      inbox: {
        ...base.inbox,
        turns: {
          ...base.inbox.turns,
          a: { worktreePath: '/w1', endedAt: 90, kind: 'finished', text: 'new' },
          b: { worktreePath: '/w1', endedAt: 10, kind: 'finished', text: 'old' }
        }
      }
    })
    expect(keysOf(m, 'done')).toEqual(['b', 'd', 'a'])
  })

  it('surfaces a PR event until its fingerprint is seen', () => {
    const pr = {
      number: 7,
      state: 'open',
      headSha: 'abc',
      checks: [{ name: 'ci', state: 'failure', description: '' }],
      checksOverall: 'failure',
      hasConflict: false,
      reviews: [],
      reviewDecision: 'none'
    } as unknown as PRStatus
    const m = buildInboxModel(input({ prStatuses: { '/w1': pr } }))
    const item = m.sections.find((s) => s.key === 'pr')!.items[0]
    expect(item).toMatchObject({ why: 'CI failed: ci', prFingerprint: 'ci:7:abc', tabId: 'a' })
    const seen = buildInboxModel(
      input({ prStatuses: { '/w1': pr }, inbox: { ...input().inbox, prSeen: { '/w1': 'ci:7:abc' } } })
    )
    expect(keysOf(seen, 'pr')).toEqual([])
  })

  it('keeps an unread turn in its section after a restart leaves the tab asleep', () => {
    const base = input()
    const { d: _d, ...statuses } = base.statuses
    void _d
    expect(keysOf(buildInboxModel({ ...base, statuses }), 'done')).toEqual(['d'])
  })

  it('jump skips the tab already focused', () => {
    const m = buildInboxModel(input())
    expect(nextInboxItem(m, null)?.key).toBe('a')
    expect(nextInboxItem(m, 'a')?.key).toBe('b')
  })
})

describe('prEventFor', () => {
  it('prefers merged over everything and ignores closed PRs', () => {
    const base = { number: 1, state: 'merged', checks: [], checksOverall: 'failure', reviews: [] } as unknown as PRStatus
    expect(prEventFor(base, false)?.kind).toBe('merged')
    expect(prEventFor({ ...base, state: 'closed' }, false)).toBeNull()
    expect(prEventFor(null, false)).toBeNull()
  })
})
