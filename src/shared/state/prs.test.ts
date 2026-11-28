import { describe, it, expect } from 'vitest'
import {
  initialPRs,
  prsReducer,
  type PRStatus,
  type PRsEvent,
  type PRsState
} from './prs'

function apply(state: PRsState, event: PRsEvent): PRsState {
  return prsReducer(state, event)
}

function stubPR(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 1,
    title: 'stub',
    state: 'open',
    url: 'https://example.com/pr/1',
    branch: 'feature/x',
    author: null,
    checks: [],
    checksOverall: 'none',
    hasConflict: null,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: [],
    ...overrides
  }
}

describe('prsReducer', () => {
  it('statusChanged sets a single path', () => {
    const pr = stubPR({ number: 42 })
    const next = apply(initialPRs, {
      type: 'prs/statusChanged',
      payload: { path: '/a', status: pr }
    })
    expect(next.byPath).toEqual({ '/a': pr })
  })

  it('statusChanged merges into existing map without disturbing other paths', () => {
    const start: PRsState = {
      ...initialPRs,
      byPath: { '/a': stubPR({ number: 1 }), '/b': stubPR({ number: 2 }) }
    }
    const next = apply(start, {
      type: 'prs/statusChanged',
      payload: { path: '/a', status: stubPR({ number: 99 }) }
    })
    expect(next.byPath['/a']?.number).toBe(99)
    expect(next.byPath['/b']?.number).toBe(2)
  })

  it('statusChanged accepts null (no PR for this branch)', () => {
    const next = apply(initialPRs, {
      type: 'prs/statusChanged',
      payload: { path: '/a', status: null }
    })
    expect(next.byPath).toEqual({ '/a': null })
  })

  it('bulkStatusChanged replaces the whole map', () => {
    const start: PRsState = {
      ...initialPRs,
      byPath: { '/a': stubPR(), '/b': stubPR(), '/c': stubPR() }
    }
    const next = apply(start, {
      type: 'prs/bulkStatusChanged',
      payload: { '/a': stubPR({ number: 42 }) }
    })
    // /b and /c are gone — a full refresh is authoritative about which
    // worktrees currently exist.
    expect(Object.keys(next.byPath)).toEqual(['/a'])
    expect(next.byPath['/a']?.number).toBe(42)
  })

  it('mergedChanged replaces the mergedByPath map', () => {
    const start: PRsState = {
      ...initialPRs,
      mergedByPath: { '/a': true, '/b': true }
    }
    const next = apply(start, {
      type: 'prs/mergedChanged',
      payload: { '/a': false, '/c': true }
    })
    expect(next.mergedByPath).toEqual({ '/a': false, '/c': true })
  })

  it('loadingChanged toggles the flag', () => {
    const on = apply(initialPRs, { type: 'prs/loadingChanged', payload: true })
    expect(on.loading).toBe(true)
    const off = apply(on, { type: 'prs/loadingChanged', payload: false })
    expect(off.loading).toBe(false)
  })

  it('returns a new object reference (no mutation)', () => {
    const next = apply(initialPRs, { type: 'prs/loadingChanged', payload: true })
    expect(next).not.toBe(initialPRs)
    expect(initialPRs.loading).toBe(false)
  })

  it('leaves unrelated fields untouched', () => {
    const start: PRsState = {
      byPath: { '/a': stubPR() },
      mergedByPath: { '/a': true },
      loading: false
    }
    const next = apply(start, { type: 'prs/loadingChanged', payload: true })
    expect(next.byPath).toBe(start.byPath)
    expect(next.mergedByPath).toBe(start.mergedByPath)
    expect(next.loading).toBe(true)
  })
})
