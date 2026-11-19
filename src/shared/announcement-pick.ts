import type { Announcement } from './state/announcements'

export interface AnnouncementFilter {
  muted: boolean
  dismissedIds: readonly string[]
  /** Epoch ms; announcements published at or before it are hidden. */
  firstLaunchAt: number
  now: number
}

/** The banner to show: the most recently published announcement that isn't
 *  muted, dismissed, expired, or older than this install's first launch.
 *  Unparseable `expiresAt` / `publishedAt` values don't filter anything out. */
export function pickActiveAnnouncement(
  items: readonly Announcement[],
  { muted, dismissedIds, firstLaunchAt, now }: AnnouncementFilter
): Announcement | null {
  if (muted) return null
  const dismissed = new Set(dismissedIds)
  const eligible = items.filter((a) => {
    if (dismissed.has(a.id)) return false
    if (a.expiresAt) {
      const exp = Date.parse(a.expiresAt)
      if (Number.isFinite(exp) && exp < now) return false
    }
    const published = Date.parse(a.publishedAt)
    if (Number.isFinite(published) && published <= firstLaunchAt) return false
    return true
  })
  if (eligible.length === 0) return null
  return eligible.reduce((best, cur) =>
    Date.parse(cur.publishedAt) > Date.parse(best.publishedAt) ? cur : best
  )
}
