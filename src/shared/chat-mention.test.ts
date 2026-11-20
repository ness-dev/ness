import { describe, it, expect } from 'vitest'
import {
  listChatMentionTargets,
  matchChatMentions,
  parseChatMention,
  slugifyTabLabel
} from './chat-mention'
import type { PaneNode, TerminalTab } from './state/terminals'
import type { Worktree } from './state/worktrees'

function wt(path: string, branch: string, extra: Partial<Worktree> = {}): Worktree {
  return { path, branch, head: 'h', isBare: false, isMain: false, createdAt: 0, repoRoot: '/r/ness', ...extra }
}

function leaf(tabs: Partial<TerminalTab>[]): PaneNode {
  return {
    type: 'leaf',
    id: 'p',
    tabs: tabs.map((t, i) => ({ id: `t${i}`, type: 'json-claude', label: 'Chat', ...t }) as TerminalTab),
    activeTabId: 't0'
  }
}

describe('slugifyTabLabel', () => {
  it('lowercases and dashes everything but letters and digits', () => {
    expect(slugifyTabLabel('  Fix Login Bug! ')).toBe('fix-login-bug')
    expect(slugifyTabLabel('PR #214 — review')).toBe('pr-214-review')
    expect(slugifyTabLabel('🚀')).toBe('')
  })
})

describe('parseChatMention', () => {
  it('splits on the last # and tolerates a leading @', () => {
    expect(parseChatMention('@chat:ness/feat#x#fix-bug')).toEqual({ worktree: 'ness/feat#x', tab: 'fix-bug' })
    expect(parseChatMention('chat:Site#abc')).toEqual({ worktree: 'Site', tab: 'abc' })
  })
  it('rejects anything that is not a full chat token', () => {
    expect(parseChatMention('worktree:ness/feat')).toBeNull()
    expect(parseChatMention('chat:ness/feat')).toBeNull()
    expect(parseChatMention('chat:#abc')).toBeNull()
    expect(parseChatMention('chat:ness/feat#')).toBeNull()
    expect(parseChatMention('chat:ness/feat#.')).toBeNull()
    expect(parseChatMention('chat:ness/feat#fix-bug!')).toEqual({ worktree: 'ness/feat', tab: 'fix-bug' })
  })
})

describe('listChatMentionTargets', () => {
  const worktrees = [wt('/a', 'feat-a'), wt('/b', 'feat-b'), wt('/gone', 'x', { prunable: true })]

  it('uses the slug when unique, else the id, and skips self, terminals and prunable worktrees', () => {
    const panes = {
      '/a': leaf([{ customLabel: 'Fix Bug' }, { id: 'dup1' }, { id: 'dup2' }, { id: 'self' }]),
      '/b': leaf([{ type: 'agent', label: 'Claude' }, { id: 'emoji', customLabel: '🚀' }]),
      '/gone': leaf([{}])
    }
    const targets = listChatMentionTargets(worktrees, panes, { '/a': 'Site' }, 'self')
    expect(targets.map((t) => t.token)).toEqual([
      'chat:ness/feat-a#fix-bug',
      'chat:ness/feat-a#dup1',
      'chat:ness/feat-a#dup2',
      'chat:ness/feat-b#emoji'
    ])
    expect(targets[0]).toMatchObject({ label: 'Fix Bug', worktreeName: 'Site', alias: 'Site' })
    expect(targets[3].worktreeName).toBe('ness/feat-b')
  })

  it('uses the tab id when the worktree handle is shared with another worktree', () => {
    const clones = [wt('/x/app', 'main', { repoRoot: '/x/app' }), wt('/y/app', 'main', { repoRoot: '/y/app' })]
    const panes = { '/x/app': leaf([{ id: 'xa' }]), '/y/app': leaf([{ id: 'ya' }]) }
    expect(listChatMentionTargets(clones, panes, {}, '').map((t) => t.token)).toEqual([
      'chat:app/main#xa',
      'chat:app/main#ya'
    ])
    // A handle that equals another worktree's alias is just as ambiguous.
    const aliased = listChatMentionTargets(
      [wt('/a', 'feat-a'), wt('/b', 'feat-b')],
      { '/a': leaf([{ id: 'ta' }]) },
      { '/b': 'ness/feat-a' },
      ''
    )
    expect(aliased.map((t) => t.token)).toEqual(['chat:ness/feat-a#ta'])
  })

  it('round-trips through parseChatMention', () => {
    const [t] = listChatMentionTargets(worktrees, { '/a': leaf([{ customLabel: 'Fix Bug' }]) }, {}, '')
    expect(parseChatMention(`@${t.token}`)).toEqual({ worktree: 'ness/feat-a', tab: 'fix-bug' })
  })
})

describe('matchChatMentions', () => {
  const targets = listChatMentionTargets(
    [wt('/a', 'feat-a'), wt('/b', 'feat-b')],
    { '/a': leaf([{ customLabel: 'Deploy' }, { customLabel: 'Copy' }]), '/b': leaf([{ customLabel: 'Site copy' }]) },
    { '/a': 'Site' },
    ''
  )

  it('matches tab names, worktree aliases and tokens; tab-name hits first', () => {
    expect(matchChatMentions('site', targets).map((m) => m.target.label)).toEqual(['Site copy', 'Deploy', 'Copy'])
    expect(matchChatMentions('copy', targets).map((m) => [m.target.label, m.labelAt])).toEqual([
      ['Copy', 0],
      ['Site copy', 5]
    ])
    expect(matchChatMentions('feat-b', targets).map((m) => m.target.label)).toEqual(['Site copy'])
  })

  it('ignores the repo name unless the query is a chat: token', () => {
    expect(matchChatMentions('ness', targets)).toEqual([])
    expect(matchChatMentions('chat:ness/feat-a', targets).map((m) => m.target.label)).toEqual(['Deploy', 'Copy'])
  })

  it('returns nothing for an empty query and respects the limit', () => {
    expect(matchChatMentions('  ', targets)).toEqual([])
    expect(matchChatMentions('chat:', targets, 2)).toHaveLength(2)
  })
})
