// The question this file answers: can a view read EVERY registered
// backend without allocating on every store event?
//
// That's the gate on showing local and remote worktrees in one sidebar.
// `useSyncExternalStore` requires `getSnapshot` to be reference-stable
// for unchanged data, and the renderer sees 30+ store events per second
// while an agent streams. If a cross-backend snapshot can't be made
// stable, the merged sidebar collapses into a full renderer union — a far
// bigger change.
//
// Two halves:
//   1. The memo semantics in isolation (reference reuse, per-backend
//      isolation, eviction).
//   2. The same selector driven by the REAL `rootReducer` with the REAL
//      dep tuple the worktree list model reads — which is where the
//      claim could actually fail, since it depends on the reducers
//      preserving reference identity for slices they didn't touch
//      (CLAUDE.md anti-pattern #3). That property is asserted here
//      rather than assumed.

import { describe, it, expect, vi } from 'vitest'
import { SegmentedSelector, type SegmentSource } from './backend-segments'
import { initialState, rootReducer, type AppState, type StateEvent } from '../shared/state'
import { getLeaves } from '../shared/state/terminals'
import { emptyCategories, type ContextSnapshot } from '../shared/state/context-window'
import type { TerminalTab } from './types'

describe('SegmentedSelector', () => {
  interface Fake {
    n: number
    other: string
  }

  function selectorOverN(): {
    selector: SegmentedSelector<Fake, number>
    project: ReturnType<typeof vi.fn>
  } {
    const project = vi.fn((state: Fake) => state.n * 2)
    const selector = new SegmentedSelector<Fake, number>((state) => [state.n], project)
    return { selector, project }
  }

  it('returns the same array reference when no deps changed', () => {
    const { selector, project } = selectorOverN()
    const sources: SegmentSource<Fake>[] = [
      { id: 'local', state: { n: 1, other: 'a' } },
      { id: 'remote', state: { n: 2, other: 'b' } }
    ]
    const first = selector.select(sources)
    const second = selector.select(sources)
    expect(second).toBe(first)
    expect(project).toHaveBeenCalledTimes(2)
  })

  it('ignores state changes outside the dep tuple', () => {
    // The whole point: a backend's AppState object is replaced on every
    // event, so the selector must key on what the view reads, not on the
    // state container.
    const { selector, project } = selectorOverN()
    const first = selector.select([{ id: 'local', state: { n: 1, other: 'a' } }])
    const second = selector.select([{ id: 'local', state: { n: 1, other: 'CHANGED' } }])
    expect(second).toBe(first)
    expect(project).toHaveBeenCalledTimes(1)
  })

  it('recomputes only the backend whose deps changed', () => {
    const { selector, project } = selectorOverN()
    const first = selector.select([
      { id: 'local', state: { n: 1, other: 'a' } },
      { id: 'remote', state: { n: 2, other: 'b' } }
    ])
    project.mockClear()

    const second = selector.select([
      { id: 'local', state: { n: 1, other: 'a' } },
      { id: 'remote', state: { n: 99, other: 'b' } }
    ])

    expect(second).not.toBe(first)
    expect(project).toHaveBeenCalledTimes(1)
    // The untouched backend keeps its segment object, so a consumer
    // rendering one row per backend re-renders only the changed row.
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1].value).toBe(198)
  })

  it('preserves surviving segments when a backend is added', () => {
    const { selector } = selectorOverN()
    const first = selector.select([{ id: 'local', state: { n: 1, other: 'a' } }])
    const second = selector.select([
      { id: 'local', state: { n: 1, other: 'a' } },
      { id: 'remote', state: { n: 5, other: 'b' } }
    ])
    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second).toHaveLength(2)
  })

  it('evicts a removed backend so re-adding it reprojects', () => {
    const { selector, project } = selectorOverN()
    selector.select([
      { id: 'local', state: { n: 1, other: 'a' } },
      { id: 'remote', state: { n: 2, other: 'b' } }
    ])
    expect(selector.cachedCount()).toBe(2)

    selector.select([{ id: 'local', state: { n: 1, other: 'a' } }])
    expect(selector.cachedCount()).toBe(1)

    project.mockClear()
    // Same state the remote had before removal. A stale cache entry would
    // hand back the old segment without reprojecting.
    selector.select([
      { id: 'local', state: { n: 1, other: 'a' } },
      { id: 'remote', state: { n: 2, other: 'b' } }
    ])
    expect(project).toHaveBeenCalledTimes(1)
  })

  it('treats reordering as a change without reprojecting', () => {
    const { selector, project } = selectorOverN()
    const a = { id: 'local', state: { n: 1, other: 'a' } }
    const b = { id: 'remote', state: { n: 2, other: 'b' } }
    const first = selector.select([a, b])
    project.mockClear()

    const second = selector.select([b, a])
    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[1])
    expect(second[1]).toBe(first[0])
    expect(project).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------
// The half that could actually fail: real reducer, real dep tuple.
// ---------------------------------------------------------------------

/** The inputs `useWorktreeListModel` feeds into `buildWorktreeListModel`,
 *  as a flat dep tuple. Mirrors that hook's `useMemo` deps — if a new
 *  input is added there, it belongs here too. */
function listModelDeps(s: AppState): readonly unknown[] {
  return [
    s.worktrees.list,
    s.worktrees.repoRoots,
    s.worktrees.pending,
    s.worktrees.pendingDeletions,
    s.terminals.panes,
    s.terminals.statuses,
    s.terminals.pendingTools,
    s.terminals.shellActivity,
    s.prs.byPath,
    s.prs.mergedByPath,
    s.snooze.byPath,
    s.pinned.byPath,
    s.aliases.byPath,
    s.settings.viewerLogin,
    s.assignedPRs.byRepo
  ]
}

function apply(state: AppState, ...events: StateEvent[]): AppState {
  return events.reduce((acc, e) => rootReducer(acc, e), state)
}

function contextSnapshot(usedTokens: number): ContextSnapshot {
  return {
    sessionId: 'sess-1',
    transcriptPath: '/tmp/sess-1.jsonl',
    model: 'claude-opus-5',
    limit: 200_000,
    usedTokens,
    categories: { ...emptyCategories, userPrompts: usedTokens },
    autocompactAt: 168_000,
    compactions: 0,
    discoverableTools: [],
    measured: true,
    updatedAt: usedTokens
  }
}

describe('SegmentedSelector over real AppState', () => {
  /** Stand-in for the real projection: walks the pane trees the way
   *  `useTabsByWorktree` does, so the test exercises a dep the list model
   *  genuinely reads rather than a trivial one. */
  function tabCountProjection(s: AppState): number {
    let n = 0
    for (const tree of Object.values(s.terminals.panes)) {
      n += getLeaves(tree).flatMap((l: { tabs: TerminalTab[] }) => l.tabs).length
    }
    return n
  }

  function realSelector(): {
    selector: SegmentedSelector<AppState, number>
    project: ReturnType<typeof vi.fn>
  } {
    const project = vi.fn(tabCountProjection)
    const selector = new SegmentedSelector<AppState, number>(listModelDeps, project)
    return { selector, project }
  }

  it('survives an event that touches no list-model input', () => {
    // A theme change replaces the AppState object and the settings slice.
    // If the selector keyed on either, the merged sidebar would rebuild
    // here — and this is the cheap case; the expensive one is below.
    const { selector, project } = realSelector()
    const before = initialState
    const first = selector.select([{ id: 'local', state: before }])
    project.mockClear()

    const after = apply(before, { type: 'settings/themeDarkChanged', payload: 'dracula' })
    expect(after).not.toBe(before)
    expect(after.settings).not.toBe(before.settings)

    const second = selector.select([{ id: 'local', state: after }])
    expect(second).toBe(first)
    expect(project).not.toHaveBeenCalled()
  })

  it('survives terminal status traffic for an unrelated terminal', () => {
    // This is the hot path — status events fire per streamed token. The
    // `statuses` map legitimately changes, so the segment MUST recompute
    // for the backend that owns the terminal. What matters is that a
    // second backend sitting idle is untouched.
    const { selector, project } = realSelector()
    const idle = initialState
    const busyBefore = initialState

    const first = selector.select([
      { id: 'local', state: idle },
      { id: 'remote', state: busyBefore }
    ])
    project.mockClear()

    const busyAfter = apply(busyBefore, {
      type: 'terminals/statusChanged',
      payload: { id: 'term-1', status: 'processing', pendingTool: null }
    })

    const second = selector.select([
      { id: 'local', state: idle },
      { id: 'remote', state: busyAfter }
    ])

    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(project).toHaveBeenCalledTimes(1)
  })

  it('is stable across a burst of events none of which the view reads', () => {
    // Closest thing to the real streaming profile: many events in a row,
    // none of them list-model inputs. One allocation anywhere in here
    // would mean a sidebar rebuild per token.
    const { selector, project } = realSelector()
    let state = initialState
    const first = selector.select([{ id: 'local', state }])
    project.mockClear()

    for (let i = 0; i < 50; i++) {
      const before = state
      state = apply(
        state,
        { type: 'terminals/progressChanged', payload: { id: 'term-1', state: 1, value: i } },
        {
          type: 'contextWindow/snapshotUpdated',
          payload: { terminalId: 'term-1', snapshot: contextSnapshot(1_000 + i) }
        }
      )
      // Guard against a vacuous pass. An event name that doesn't match the
      // union falls through `rootReducer`'s default and returns the same
      // object — which would make the reference-stability assertion below
      // prove nothing at all. (This test caught exactly that: it was
      // originally written against a `contextWindow/snapshot` that does
      // not exist.)
      expect(state).not.toBe(before)
      expect(selector.select([{ id: 'local', state }])).toBe(first)
    }
    expect(project).not.toHaveBeenCalled()
  })
})
