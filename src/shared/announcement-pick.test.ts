import { describe, it, expect } from 'vitest'
import { pickActiveAnnouncement, type AnnouncementFilter } from './announcement-pick'
import type { Announcement } from './state/announcements'

const NOW = Date.parse('2026-06-01T00:00:00Z')

function ann(id: string, publishedAt: string, extra: Partial<Announcement> = {}): Announcement {
  return { id, title: id, href: `https://example.com/${id}`, publishedAt, ...extra }
}

function filter(over: Partial<AnnouncementFilter> = {}): AnnouncementFilter {
  return { muted: false, dismissedIds: [], firstLaunchAt: 0, now: NOW, ...over }
}

describe('pickActiveAnnouncement', () => {
  it('returns the most recently published eligible entry', () => {
    const items = [ann('a', '2026-01-01T00:00:00Z'), ann('b', '2026-03-01T00:00:00Z')]
    expect(pickActiveAnnouncement(items, filter())?.id).toBe('b')
  })

  it('returns null when muted', () => {
    expect(pickActiveAnnouncement([ann('a', '2026-01-01T00:00:00Z')], filter({ muted: true }))).toBeNull()
  })

  it('skips dismissed and expired entries', () => {
    const items = [
      ann('old', '2026-01-01T00:00:00Z'),
      ann('dismissed', '2026-02-01T00:00:00Z'),
      ann('expired', '2026-03-01T00:00:00Z', { expiresAt: '2026-05-01T00:00:00Z' })
    ]
    expect(pickActiveAnnouncement(items, filter({ dismissedIds: ['dismissed'] }))?.id).toBe('old')
  })

  it('hides announcements published at or before first launch', () => {
    const launch = Date.parse('2026-02-01T00:00:00Z')
    const items = [ann('before', '2026-01-01T00:00:00Z'), ann('at', '2026-02-01T00:00:00Z')]
    expect(pickActiveAnnouncement(items, filter({ firstLaunchAt: launch }))).toBeNull()
    const withNew = [...items, ann('after', '2026-02-02T00:00:00Z')]
    expect(pickActiveAnnouncement(withNew, filter({ firstLaunchAt: launch }))?.id).toBe('after')
  })

  it('firstLaunchAt 0 (pre-existing install) hides nothing', () => {
    const items = [ann('ancient', '2020-01-01T00:00:00Z')]
    expect(pickActiveAnnouncement(items, filter({ firstLaunchAt: 0 }))?.id).toBe('ancient')
  })

  it('does not drop an entry whose publishedAt fails to parse', () => {
    const items = [ann('weird', 'not a date')]
    expect(pickActiveAnnouncement(items, filter({ firstLaunchAt: NOW }))?.id).toBe('weird')
  })
})
