// EXPERIMENT (see src/main/simple-fullscreen.ts): while Ness is in simple full
// screen on a notched MacBook, the top bar runs either side of the camera
// notch. This keeps that band clear of top-bar content. Per-window UI — each
// window gets its own inset over a local signal — so a module store, not a
// slice.
import { useLayoutEffect, useSyncExternalStore, type RefObject } from 'react'
import type { NotchInset } from './types'

let current: NotchInset | null = null
const listeners = new Set<() => void>()

export function setNotchInset(next: NotchInset | null): void {
  if (current?.height === next?.height && current?.width === next?.width) return
  current = next
  const root = document.documentElement
  if (next) {
    root.dataset.notch = 'true'
    root.style.setProperty('--notch-height', `${next.height}px`)
    root.style.setProperty('--notch-width', `${next.width}px`)
  } else {
    delete root.dataset.notch
    root.style.removeProperty('--notch-height')
    root.style.removeProperty('--notch-width')
  }
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useNotchInset(): NotchInset | null {
  return useSyncExternalStore(subscribe, () => current)
}

const NOTCH_ITEM_ATTR = 'data-notch-pushed'

/** Which item to push, and by how many px, so nothing sits in
 *  [bandLeft, bandRight). `items` are natural (unpushed) viewport rects in
 *  flow order. Pushing one item reflows everything after it, so one push is
 *  enough. */
export function computeNotchPush(
  items: readonly { left: number; width: number }[],
  bandLeft: number,
  bandRight: number
): { index: number; px: number } | null {
  for (let i = 0; i < items.length; i++) {
    const { left, width } = items[i]
    if (width === 0 || left + width <= bandLeft) continue
    if (left >= bandRight) return null
    return { index: i, px: bandRight - left }
  }
  return null
}

/** The push for a row whose tab strip should stay at `scroll`. Items
 *  flagged `scrolls` live in the strip and their `left` is content-relative
 *  (viewport left at scroll 0); the rest are plain viewport rects.
 *
 *  Pushing a strip tab widens the strip's scroll range by the push. Near the
 *  end of the range the push the band needs can be smaller than the one that
 *  let the strip scroll this far, so the offset would no longer fit; the
 *  strip would clamp, the tabs would move, and the last tab would end up
 *  partly out of reach. Instead the gap grows to keep the offset valid (never
 *  past the previous push, which allowed it). Pushing further right never
 *  puts anything under the band. */
export function planNotchPush(
  items: readonly { left: number; width: number; scrolls: boolean }[],
  bandLeft: number,
  bandRight: number,
  strip: { scroll: number; naturalMaxScroll: number }
): { index: number; px: number } | null {
  const push = computeNotchPush(
    items.map((it) => (it.scrolls ? { left: it.left - strip.scroll, width: it.width } : it)),
    bandLeft,
    bandRight
  )
  if (!push || !items[push.index].scrolls) return push
  return { index: push.index, px: Math.max(push.px, strip.scroll - strip.naturalMaxScroll) }
}

/** Pushes the first top-bar item that would sit under the notch to the
 *  notch's right edge, leaving a gap (still part of the row's drag region).
 *
 *  Items are the row's direct children, except that a child marked
 *  `data-notch-flow` (the scrolling tab strip) is descended into so the gap
 *  lands between tabs. Positions are real viewport positions, re-measured on
 *  scroll, so tabs stay out of the band while the strip scrolls too. While
 *  scrolling, the tab nearest the notch stays pinned at the band's right
 *  edge, then jumps across once it fits entirely left of the band. That's
 *  intended: a tab is only ever wholly on one side. Rows
 *  that aren't at the top of the window (a split pane's lower tab bar) are
 *  left alone. */
export function useNotchAvoidance(rowRef: RefObject<HTMLElement | null>): void {
  const inset = useNotchInset()
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return

    const flows = (): HTMLElement[] =>
      (Array.from(row.children) as HTMLElement[]).filter((c) => c.hasAttribute('data-notch-flow'))

    const clear = (): void => {
      for (const el of row.querySelectorAll<HTMLElement>(`[${NOTCH_ITEM_ATTR}]`)) {
        el.style.marginLeft = el.getAttribute(NOTCH_ITEM_ATTR) ?? ''
        el.removeAttribute(NOTCH_ITEM_ATTR)
      }
    }
    if (!inset) {
      clear()
      return
    }

    const items = (): HTMLElement[] =>
      (Array.from(row.children) as HTMLElement[]).flatMap((child) =>
        child.hasAttribute('data-notch-flow') ? (Array.from(child.children) as HTMLElement[]) : [child]
      )

    // Last scrollLeft apply() left the strip at, so the scroll event our
    // own write fires doesn't schedule another pass.
    const settled = new WeakMap<HTMLElement, number>()

    const apply = (): void => {
      // Assumes at most one scrolling strip per row (the tab strip).
      const strip = flows()[0] as HTMLElement | undefined
      const desiredScroll = strip?.scrollLeft ?? 0
      clear()
      if (row.getBoundingClientRect().top < inset.height) {
        const left = window.innerWidth / 2 - inset.width / 2
        // Clearing may have clamped the strip; content-relative positions
        // don't care which offset it ended up at.
        const measuredScroll = strip?.scrollLeft ?? 0
        const els = items()
        const push = planNotchPush(
          els.map((el) => {
            const r = el.getBoundingClientRect()
            const scrolls = el.parentElement === strip
            return { left: scrolls ? r.left + measuredScroll : r.left, width: r.width, scrolls }
          }),
          left,
          left + inset.width,
          {
            scroll: desiredScroll,
            naturalMaxScroll: strip ? strip.scrollWidth - strip.clientWidth : 0
          }
        )
        if (push) {
          const el = els[push.index]
          el.setAttribute(NOTCH_ITEM_ATTR, el.style.marginLeft)
          const base = parseFloat(getComputedStyle(el).marginLeft) || 0
          el.style.marginLeft = `${base + push.px}px`
        }
      }
      // Clearing may have clamped the strip; the push now fits the offset.
      if (strip && strip.scrollLeft !== desiredScroll) strip.scrollLeft = desiredScroll
      if (strip) settled.set(strip, strip.scrollLeft)
    }

    const onScroll = (e: Event): void => {
      const f = e.currentTarget as HTMLElement
      if (settled.get(f) === f.scrollLeft) return
      schedule()
    }

    let frame = 0
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        apply()
      })
    }

    apply()
    // Clearing + re-applying in one pass nets out to the same layout, so the
    // observer doesn't feed itself.
    const ro = new ResizeObserver(schedule)
    const mo = new MutationObserver(() => {
      observeAll()
      schedule()
    })
    // Re-walked on every row mutation so a remounted strip (and its tabs)
    // is picked up, not just the one present at setup.
    let scrollers: HTMLElement[] = []
    function observeAll(): void {
      ro.disconnect()
      mo.disconnect()
      for (const f of scrollers) f.removeEventListener('scroll', onScroll)
      ro.observe(row!)
      for (const el of items()) ro.observe(el)
      mo.observe(row!, { childList: true })
      scrollers = flows()
      for (const f of scrollers) {
        // Chromium's scroll anchoring would nudge scrollLeft to compensate
        // for our margin changes, fighting the planned offset.
        f.style.overflowAnchor = 'none'
        mo.observe(f, { childList: true })
        f.addEventListener('scroll', onScroll, { passive: true })
      }
    }
    observeAll()
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
      for (const f of scrollers) f.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', schedule)
      clear()
    }
  }, [inset, rowRef])
}
