// The demo's agent review: its fixture lines up with the demo's git, and
// every Review tab action works in memory.
import { describe, expect, it } from 'vitest'
import type { StateEvent } from '../../src/shared/state'
import { placeComment, splitLines } from '../../src/shared/review-anchor'
import { latestAgentReviewStatus } from '../../src/shared/review-status'
import { DemoWorld } from '../src/demo/world'
import { TAB } from '../src/demo/conversations'
import { WT } from '../src/demo/project'
import { tabsOf } from '../src/ness'

const NOW = Date.UTC(2026, 5, 1, 9, 30)

function makeWorld() {
  const events: StateEvent[] = []
  let timers: Array<() => void> = []
  const world = new DemoWorld({
    now: () => NOW,
    schedule: (fn) => {
      timers.push(fn)
      return () => {
        timers = timers.filter((t) => t !== fn)
      }
    },
    emitEvent: (e) => events.push(e),
    emitSignal: () => {}
  })
  const flush = () => {
    for (let guard = 0; timers.length && guard < 100_000; guard++) timers.shift()!()
  }
  const req = (name: string, ...args: unknown[]) => world.request(name, args)
  return { world, events, flush, req }
}

describe('demo review', () => {
  it('opens with a reviewer, a Review tab and a draft verdict on hourly-forecast', () => {
    const { world } = makeWorld()
    const tabs = tabsOf(world.state.terminals.panes[WT.hourly])
    expect(tabs.find((t) => t.id === TAB.hourlyReviewer)).toMatchObject({ type: 'json-claude', reviewOf: TAB.hourlyChat })
    expect(tabs.find((t) => t.id === TAB.hourlyReview)).toMatchObject({ type: 'review' })
    const review = world.state.reviews.byPath[WT.hourly]
    expect(latestAgentReviewStatus(review)).toEqual({ kind: 'changes-requested', unsent: true, reviewerTabId: null })
    expect(review?.comments.filter((c) => c.status === 'open')).toHaveLength(2)
    expect(world.state.jsonClaude.sessions[TAB.hourlyReviewer]?.entries.length).toBeGreaterThan(3)
  })

  it('anchors every comment on a line of the branch diff', async () => {
    const { world, req } = makeWorld()
    for (const c of world.state.reviews.byPath[WT.hourly]!.comments) {
      const sides = (await req('worktree:fileDiffSides', WT.hourly, c.filePath, false, 'branch')) as { modified: string }
      expect(placeComment(splitLines(sides.modified), c), c.id).toBe(c.line)
    }
  })

  it('adds, replies to, resolves, edits and deletes comments', () => {
    const { world, req } = makeWorld()
    const before = world.state.reviews.byPath[WT.hourly]!.comments.length
    const added = req('reviews:addComment', WT.hourly, { filePath: 'src/App.tsx', line: 1, side: 'new', body: '  Nice  ' }) as { id: string; body: string; anchor: { snippet: string } }
    expect(added.body).toBe('Nice')
    expect(added.anchor.snippet.length).toBeGreaterThan(0)
    expect(req('reviews:addComment', WT.hourly, { filePath: 'src/App.tsx', line: 9999, side: 'new', body: 'x' })).toHaveProperty('error')
    expect(req('reviews:addReply', WT.hourly, added.id, 'thanks')).toBe(true)
    expect(req('reviews:setCommentStatus', WT.hourly, added.id, 'resolved')).toBe(true)
    expect(req('reviews:editComment', WT.hourly, added.id, 'Very nice')).toBe(true)
    const c = world.state.reviews.byPath[WT.hourly]!.comments.find((x) => x.id === added.id)!
    expect(c).toMatchObject({ status: 'resolved', body: 'Very nice', resolvedBy: { kind: 'human' } })
    expect(c.replies?.map((r) => r.body)).toEqual(['thanks'])
    req('reviews:deleteComment', WT.hourly, added.id)
    expect(world.state.reviews.byPath[WT.hourly]!.comments).toHaveLength(before)
  })

  it('sends the draft to the author chat, which answers', () => {
    const { world, req, flush } = makeWorld()
    const chats = req('reviews:listChatTabs', WT.hourly) as Array<{ id: string; reviewOf?: string }>
    expect(chats.map((t) => t.id).sort()).toEqual([TAB.hourlyChat, TAB.hourlyReviewer].sort())
    const before = world.state.jsonClaude.sessions[TAB.hourlyChat]!.entries.length
    expect(req('reviews:sendSubmission', WT.hourly, 'demo-rs-hourly')).toEqual({ ok: true, tabId: TAB.hourlyChat, woke: false })
    flush()
    expect(world.state.reviews.byPath[WT.hourly]!.submissions![0]).toMatchObject({ state: 'sent', targetTabId: TAB.hourlyChat })
    const entries = world.state.jsonClaude.sessions[TAB.hourlyChat]!.entries.slice(before)
    expect(entries[0]).toMatchObject({ kind: 'user' })
    expect(entries[0].text).toContain('Verdict: Changes requested')
    expect(entries.some((e) => e.kind === 'assistant')).toBe(true)
    expect(latestAgentReviewStatus(world.state.reviews.byPath[WT.hourly]).unsent).toBe(false)
  })

  it('won’t send a review to the reviewer that wrote it', () => {
    const { world, req } = makeWorld()
    expect(req('reviews:sendSubmission', WT.hourly, 'demo-rs-hourly', TAB.hourlyReviewer)).toMatchObject({ ok: false })
    expect(world.state.reviews.byPath[WT.hourly]!.submissions![0].state).toBe('failed')
  })

  it('edits and deletes a submission', () => {
    const { world, req } = makeWorld()
    expect(req('reviews:editSubmission', WT.hourly, 'demo-rs-hourly', 'Ship it', 'approve')).toBe(true)
    expect(world.state.reviews.byPath[WT.hourly]!.submissions![0]).toMatchObject({ summary: 'Ship it', verdict: 'approve' })
    req('reviews:deleteSubmission', WT.hourly, 'demo-rs-hourly')
    expect(world.state.reviews.byPath[WT.hourly]!.submissions).toBeUndefined()
  })

  it('opens one Review tab per worktree and picks commits for it', async () => {
    const { world, req } = makeWorld()
    req('panes:openReview', WT.units)
    req('panes:openReview', WT.units)
    const reviews = tabsOf(world.state.terminals.panes[WT.units]).filter((t) => t.type === 'review')
    expect(reviews).toHaveLength(1)
    const [commit] = (await req('worktree:branchCommits', WT.hourly)) as Array<{ hash: string }>
    req('panes:setReviewSelection', WT.hourly, TAB.hourlyReview, commit.hash, commit.hash)
    expect(tabsOf(world.state.terminals.panes[WT.hourly]).find((t) => t.id === TAB.hourlyReview)).toMatchObject({ reviewFromCommit: commit.hash, reviewToCommit: commit.hash })
    const all = (await req('worktree:branchCommits', WT.hourly)) as Array<{ hash: string }>
    const range = (await req('worktree:commitRangeChangedFiles', WT.hourly, all.at(-1)!.hash, all[0].hash)) as Array<{ path: string }>
    expect(range.map((f) => f.path).sort()).toEqual(((await req('worktree:changedFiles', WT.hourly, 'branch')) as Array<{ path: string }>).map((f) => f.path).sort())
  })
})
