// Per-review-tab progress registry. ReviewPane writes its current
// (reviewed, total) on every change; SortableTab reads it to render
// "Review (N/M)" in the tab label.
//
// Per-component state in ReviewPane is the source of truth — this
// store is a side-channel so TerminalPanel can observe a value that
// lives inside the review pane's own React tree. Both go away when
// the tab unmounts (review pane clears its entry).
import { useSyncExternalStore } from 'react'

export interface ReviewProgress {
  reviewed: number
  total: number
}

const progressByTabId = new Map<string, ReviewProgress>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** Ticked files still in the diff. The ticked set only resets on a
 *  selection change, but the whole-branch file list can change under the
 *  same selection, so a bare `reviewed.size` counts files that are gone. */
export function reviewedCount(files: readonly { path: string }[], reviewed: ReadonlySet<string>): number {
  let n = 0
  for (const f of files) if (reviewed.has(f.path)) n++
  return n
}

export function setReviewProgress(tabId: string, value: ReviewProgress): void {
  const prev = progressByTabId.get(tabId)
  if (prev && prev.reviewed === value.reviewed && prev.total === value.total) return
  progressByTabId.set(tabId, value)
  emit()
}

export function clearReviewProgress(tabId: string): void {
  if (!progressByTabId.has(tabId)) return
  progressByTabId.delete(tabId)
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(tabId: string): ReviewProgress | undefined {
  return progressByTabId.get(tabId)
}

export function useReviewProgress(tabId: string): ReviewProgress | undefined {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(tabId),
    () => undefined
  )
}
