// The demo's agent review: hourly-forecast's checks went green, Ness opened
// a reviewer, and it left three comments and a "changes requested" verdict
// that waits as a draft for the user to send (agentReviewDelivery 'draft',
// the default). Built from the same events main's review service
// dispatches, anchored the way review-comments.ts anchors.
import { snippetAt, splitLines } from '../../../src/shared/review-anchor'
import type { StateEvent } from '../../../src/shared/state'
import type { ReviewAuthor, ReviewComment } from '../../../src/shared/state/reviews'
import type { DemoGit } from './git'
import { TAB } from './conversations'
import { WT } from './project'

export const REVIEWER: ReviewAuthor = { kind: 'agent', tabId: TAB.hourlyReviewer, label: 'Reviewer' }
const AUTHOR: ReviewAuthor = { kind: 'agent', tabId: TAB.hourlyChat, label: 'Chat' }

const SUMMARY = `Two fixes before merge: the strip isn't usable with VoiceOver yet, and the 20% rain cutoff is a magic number that docs/hourly.md repeats. Both are inline.`

const BRIEFING = `**What it does.** Adds a 12-hour strip under current conditions. \`fetchForecast\` now loads \`/forecast\` and \`/hourly\` side by side, so the page waits no longer than before.

**How it works.** \`HourlyForecast\` maps each hour to a column: time, icon, temperature, and a rain chance once it reaches 20%. \`App\` passes it the first 12 hours.

**Critique.**
- With VoiceOver each column reads as a bare time ("3 PM"); the temperature and rain chance aren't tied to it.
- \`20\` is written in the component and again in the docs; they will drift.
- It requests 24 hours and draws 12. Fine if "show more" is coming, wasteful if not.

**Recommendation: request changes.** The data flow is right and the tests cover it; the accessibility gap is the one users would hit.`

/** Line `needle` sits on in the file as committed at HEAD. */
function lineOf(content: string, needle: string): number {
  const i = splitLines(content).findIndex((l) => l.includes(needle))
  if (i === -1) throw new Error(`demo review: "${needle}" not found`)
  return i + 1
}

export function reviewEvents(now: number, git: DemoGit): StateEvent[] {
  const min = (m: number) => now - m * 60_000
  const head = git.headSha(WT.hourly)
  const comment = (id: string, filePath: string, needle: string, body: string, at: number, extra: Partial<ReviewComment> = {}): ReviewComment => {
    const content = git.headFile(WT.hourly, filePath) ?? ''
    const line = lineOf(content, needle)
    return {
      id,
      filePath,
      side: 'new',
      line,
      anchoredSha: head,
      anchor: { commitSha: head, line, snippet: snippetAt(splitLines(content), line) ?? '' },
      author: REVIEWER,
      status: 'open',
      body,
      createdAt: at,
      ...extra
    }
  }
  const comments: ReviewComment[] = [
    comment(
      'demo-rc-voiceover',
      'src/components/HourlyForecast.tsx',
      '<time>',
      'VoiceOver reads each column as just “3 PM”: the temperature and rain chance aren’t tied to it. Give each `.hour` an aria-label like “3 PM, 18°, 40% chance of rain”.',
      min(41)
    ),
    comment(
      'demo-rc-threshold',
      'src/components/HourlyForecast.tsx',
      'precipChance >= 20',
      'Magic number. Pull 20 into a named RAIN_THRESHOLD and reference it from docs/hourly.md, so the two can’t drift apart.',
      min(40)
    ),
    comment(
      'demo-rc-hours',
      'src/api/forecast.ts',
      "hours: '24'",
      'This asks for 24 hours but App only draws `slice(0, 12)`. Request 12, or say why the rest is needed.',
      min(39.5),
      {
        status: 'resolved',
        resolvedBy: { kind: 'human' },
        resolvedAt: min(12),
        replies: [{ id: 'demo-rr-hours', author: { kind: 'human' }, body: 'Keeping 24: the “show more” toggle in the next PR needs the rest.', createdAt: min(12.5) }]
      }
    )
  ]
  const ev: StateEvent[] = [
    {
      type: 'reviews/requestRecorded',
      payload: {
        worktreePath: WT.hourly,
        request: {
          id: 'demo-rq-hourly',
          requester: AUTHOR,
          reviewer: REVIEWER,
          context: 'PR #42 checks are green.',
          source: 'ci-green',
          reused: false,
          createdAt: min(44)
        }
      }
    }
  ]
  for (const c of comments) ev.push({ type: 'reviews/commentAdded', payload: { worktreePath: WT.hourly, comment: c } })
  ev.push({
    type: 'reviews/submissionAdded',
    payload: {
      worktreePath: WT.hourly,
      submission: {
        id: 'demo-rs-hourly',
        author: REVIEWER,
        verdict: 'changes-requested',
        summary: SUMMARY,
        briefing: BRIEFING,
        commentIds: comments.map((c) => c.id),
        createdAt: min(38),
        state: 'draft',
        targetTabId: TAB.hourlyChat,
        headSha: head
      }
    }
  })
  return ev
}

