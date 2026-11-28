// The demo's starting state, built the way main builds its own: initial
// slices plus real typed events through the shared rootReducer. A slice
// whose shape changes then fails typecheck:mobile (or the fixture tests)
// instead of silently breaking the demo.
import { initialState, rootReducer, type AppState, type StateEvent } from '../../../src/shared/state'
import type { PaneLeaf, TerminalTab } from '../../../src/shared/state/terminals'
import type { PRStatus } from '../../../src/shared/state/prs'
import type { ContextSnapshot } from '../../../src/shared/state/context-window'
import type { SessionUsage } from '../../../src/shared/state/costs'
import type { Worktree } from '../../../src/shared/state/worktrees'
import {
  airTranscript,
  darkTranscript,
  hourlyTranscript,
  MODEL,
  TAB,
  unitsApproval,
  unitsEditInput,
  unitsTranscript
} from './conversations'
import type { DemoGit } from './git'
import { REPO, WORKTREES, WT } from './project'

export const VIEWER = 'riley-chen'
const avatar = ''
const ORIGIN = 'github.com/acme-weather/acme-weather'
const prUrl = (n: number) => `https://${ORIGIN}/pull/${n}`

const chatTab = (id: string): TerminalTab => ({ id, type: 'json-claude', label: 'Chat', sessionId: id })
const shellTab = (id: string): TerminalTab => ({ id, type: 'shell', label: 'Shell' })
const leaf = (id: string, tabs: TerminalTab[]): PaneLeaf => ({ type: 'leaf', id, tabs, activeTabId: tabs[0].id })

function pr(p: Partial<PRStatus> & Pick<PRStatus, 'number' | 'title' | 'state' | 'branch'>): PRStatus {
  return {
    url: prUrl(p.number),
    author: { login: VIEWER, avatarUrl: avatar },
    checks: [],
    checksOverall: 'none',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: [],
    hasMilestones: false,
    ...p
  }
}

function prs(now: number, git: DemoGit): Record<string, PRStatus | null> {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  return {
    [WT.main]: null,
    [WT.dark]: null,
    [WT.hourly]: pr({
      number: 42,
      title: 'Hourly forecast strip',
      state: 'open',
      branch: 'feat/hourly-forecast',
      headSha: git.headSha(WT.hourly),
      checksOverall: 'success',
      checks: [
        { name: 'test', state: 'success', description: '7 tests passed', startedAt: ago(70) },
        { name: 'lint', state: 'success', description: 'No problems', startedAt: ago(70) },
        { name: 'preview-deploy', state: 'success', description: 'Deployed to preview', startedAt: ago(68) }
      ],
      reviews: [
        {
          user: 'sam-okafor',
          avatarUrl: avatar,
          state: 'APPROVED',
          body: 'Looks great on mobile. Nice touch hiding the low rain chances.',
          submittedAt: ago(30),
          htmlUrl: `${prUrl(42)}#pullrequestreview-1`
        }
      ],
      reviewDecision: 'approved',
      additions: 96,
      deletions: 7,
      labels: [{ name: 'feature', color: '1f883d' }],
      linkedIssues: [{ number: 17, title: 'Show the forecast by hour', state: 'open', url: `https://${ORIGIN}/issues/17` }]
    }),
    [WT.units]: pr({
      number: 44,
      title: 'Remember the °C/°F choice between visits',
      state: 'open',
      branch: 'fix/unit-toggle',
      headSha: git.headSha(WT.units),
      checksOverall: 'failure',
      checks: [
        {
          name: 'test',
          state: 'failure',
          description: '3 failed, 2 passed',
          summary: '× toFahrenheit > converts 100°C to 212°F\n  → expected 87.55555555555556 to be 212',
          startedAt: ago(12)
        },
        { name: 'lint', state: 'success', description: 'No problems', startedAt: ago(12) }
      ],
      reviewDecision: 'review_required',
      additions: 21,
      deletions: 4,
      labels: [{ name: 'bug', color: 'd73a4a' }]
    }),
    [WT.air]: pr({
      number: 39,
      title: 'Air quality badge',
      state: 'merged',
      branch: 'feat/air-quality',
      checksOverall: 'success',
      checks: [{ name: 'test', state: 'success', description: '5 tests passed' }],
      reviewDecision: 'approved',
      additions: 48,
      deletions: 2,
      firstReleaseTag: 'v0.4.0'
    })
  }
}

function context(sessionId: string, used: number, now: number): ContextSnapshot {
  const tool = Math.round(used * 0.34)
  return {
    sessionId,
    transcriptPath: '',
    model: MODEL,
    limit: 200_000,
    usedTokens: used,
    categories: {
      systemAndTools: 14_200,
      memoryFiles: 2_100,
      carriedSummary: 0,
      attachments: 0,
      userPrompts: Math.round(used * 0.04),
      assistantText: Math.round(used * 0.12),
      thinking: Math.round(used * 0.06),
      toolCalls: Math.round(used * 0.08),
      toolResults: { Read: Math.round(tool * 0.6), Bash: Math.round(tool * 0.3), Grep: Math.round(tool * 0.1) }
    },
    autocompactAt: 167_000,
    compactions: 0,
    discoverableTools: [],
    measured: true,
    updatedAt: now
  }
}

function usage(sessionId: string, messages: number, scale: number, now: number): SessionUsage {
  return {
    sessionId,
    transcriptPath: '',
    byModel: {
      [MODEL]: {
        messages,
        input: 4_800 * scale,
        output: 9_300 * scale,
        cacheRead: 182_000 * scale,
        cacheWrite: 31_000 * scale,
        cost: 0.42 * scale
      }
    },
    breakdown: { text: 3_100 * scale, thinking: 1_200 * scale, toolUse: 2_900 * scale, userPrompt: 400 * scale, assistantEcho: 0, toolResults: { Read: 8_000 * scale, Bash: 2_400 * scale } },
    currentModel: MODEL,
    updatedAt: now
  }
}

const SCRATCHPAD = `Release checklist for v0.5
- [x] hourly strip (#42)
- [ ] unit toggle fix (#44)
- [ ] dark mode
Ask Sam about the preview deploy URL`

/** Every event that builds the demo's starting state, in order. */
export function fixtureEvents(now: number, git: DemoGit): StateEvent[] {
  const ev: StateEvent[] = []
  const min = (m: number) => now - m * 60_000

  ev.push({ type: 'settings/hasGithubTokenChanged', payload: true })
  ev.push({ type: 'settings/githubAuthSourceChanged', payload: 'pat' })
  ev.push({ type: 'settings/viewerLoginChanged', payload: VIEWER })
  ev.push({ type: 'settings/claudeModelChanged', payload: MODEL })

  const list: Worktree[] = WORKTREES.map((w) => ({
    path: w.path,
    branch: w.branch,
    head: git.headSha(w.path),
    isBare: false,
    isMain: w.isMain,
    createdAt: min(w.createdAgoMin),
    repoRoot: REPO
  }))
  ev.push({ type: 'worktrees/reposChanged', payload: [REPO] })
  ev.push({ type: 'worktrees/repoRemotesChanged', payload: { [REPO]: ORIGIN } })
  ev.push({ type: 'worktrees/listChanged', payload: list })
  ev.push({
    type: 'repoConfigs/loaded',
    payload: { byRepo: { [REPO]: { version: 1, mergeStrategy: 'squash', hiddenRightPanels: { scratchpad: false } } }, filenameByRepo: { [REPO]: '.ness.json' } }
  })

  ev.push({
    type: 'terminals/panesReplaced',
    payload: {
      [WT.main]: leaf('demo-pane-main', [shellTab(TAB.mainShell)]),
      [WT.hourly]: leaf('demo-pane-hourly', [chatTab(TAB.hourlyChat), shellTab(TAB.hourlyShell)]),
      [WT.units]: leaf('demo-pane-units', [chatTab(TAB.unitsChat), shellTab(TAB.unitsShell)]),
      [WT.dark]: leaf('demo-pane-dark', [chatTab(TAB.darkChat)]),
      [WT.air]: leaf('demo-pane-air', [chatTab(TAB.airChat)])
    }
  })

  const chats: Array<[string, string, ReturnType<typeof hourlyTranscript>]> = [
    [TAB.hourlyChat, WT.hourly, hourlyTranscript(min(80))],
    [TAB.unitsChat, WT.units, unitsTranscript(min(3))],
    [TAB.darkChat, WT.dark, darkTranscript(min(2))],
    [TAB.airChat, WT.air, airTranscript(min(60 * 24 * 5))]
  ]
  for (const [sessionId, worktreePath, entries] of chats) {
    ev.push({ type: 'jsonClaude/sessionStarted', payload: { sessionId, worktreePath } })
    ev.push({ type: 'jsonClaude/sessionStateChanged', payload: { sessionId, state: 'running' } })
    ev.push({ type: 'jsonClaude/currentModelChanged', payload: { sessionId, model: MODEL } })
    ev.push({ type: 'jsonClaude/entriesSeeded', payload: { sessionId, entries } })
  }
  ev.push({ type: 'jsonClaude/busyChanged', payload: { sessionId: TAB.unitsChat, busy: true, turnStartedAt: min(3) } })
  ev.push({ type: 'jsonClaude/busyChanged', payload: { sessionId: TAB.darkChat, busy: true, turnStartedAt: min(2) } })
  ev.push({ type: 'jsonClaude/approvalRequested', payload: unitsApproval(now) })
  ev.push({
    type: 'jsonClaude/promptSuggestionChanged',
    payload: { sessionId: TAB.hourlyChat, suggestion: 'Label each hour for screen readers' }
  })

  ev.push({ type: 'terminals/statusChanged', payload: { id: TAB.hourlyChat, status: 'waiting', pendingTool: null } })
  ev.push({ type: 'terminals/statusChanged', payload: { id: TAB.unitsChat, status: 'needs-approval', pendingTool: { name: 'Edit', input: unitsEditInput() } } })
  ev.push({ type: 'terminals/statusChanged', payload: { id: TAB.darkChat, status: 'processing', pendingTool: null } })
  ev.push({ type: 'terminals/statusChanged', payload: { id: TAB.airChat, status: 'idle', pendingTool: null } })
  for (const id of [TAB.mainShell, TAB.hourlyShell, TAB.unitsShell]) {
    ev.push({ type: 'terminals/statusChanged', payload: { id, status: 'idle', pendingTool: null } })
  }

  ev.push({ type: 'prs/bulkStatusChanged', payload: prs(now, git) })

  ev.push({ type: 'contextWindow/snapshotUpdated', payload: { terminalId: TAB.hourlyChat, snapshot: context(TAB.hourlyChat, 61_400, now) } })
  ev.push({ type: 'contextWindow/snapshotUpdated', payload: { terminalId: TAB.unitsChat, snapshot: context(TAB.unitsChat, 28_900, now) } })
  ev.push({ type: 'contextWindow/snapshotUpdated', payload: { terminalId: TAB.darkChat, snapshot: context(TAB.darkChat, 21_300, now) } })
  ev.push({ type: 'costs/usageUpdated', payload: { terminalId: TAB.hourlyChat, usage: usage(TAB.hourlyChat, 14, 3, now) } })
  ev.push({ type: 'costs/usageUpdated', payload: { terminalId: TAB.unitsChat, usage: usage(TAB.unitsChat, 4, 1, now) } })
  ev.push({ type: 'costs/usageUpdated', payload: { terminalId: TAB.darkChat, usage: usage(TAB.darkChat, 3, 1, now) } })

  ev.push({ type: 'scratchpad/loaded', payload: { [WT.hourly]: SCRATCHPAD } })
  ev.push({ type: 'pinned/set', payload: WT.hourly })
  ev.push({ type: 'aliases/set', payload: { path: WT.hourly, alias: 'Hourly Forecast' } })

  ev.push({ type: 'terminals/lastActiveChanged', payload: { worktreePath: WT.units, ts: min(1) } })
  ev.push({ type: 'terminals/lastActiveChanged', payload: { worktreePath: WT.dark, ts: min(0.5) } })
  ev.push({ type: 'terminals/lastActiveChanged', payload: { worktreePath: WT.hourly, ts: min(25) } })
  ev.push({ type: 'terminals/lastActiveChanged', payload: { worktreePath: WT.air, ts: min(60 * 24 * 5) } })
  ev.push({ type: 'terminals/lastActiveChanged', payload: { worktreePath: WT.main, ts: min(60 * 3) } })
  return ev
}

export function buildDemoState(now: number, git: DemoGit): AppState {
  return fixtureEvents(now, git).reduce(rootReducer, initialState)
}
