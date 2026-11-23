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

/** Pushes the first top-bar item that would sit under the notch to the
 *  notch's right edge, leaving a gap (still part of the row's drag region).
 *
 *  Items are the row's direct children, except that a child marked
 *  `data-notch-flow` (the scrolling tab strip) is descended into so the gap
 *  lands between tabs. Positions are real viewport positions, re-measured on
 *  scroll, so tabs stay out of the band while the strip scrolls too. Rows
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

    const apply = (): void => {
      // Clearing can shrink a scrolled strip enough to clamp its scrollLeft;
      // restore it so re-applying the same push lands in the same place.
      const scrolls = flows().map((f) => [f, f.scrollLeft] as const)
      clear()
      if (row.getBoundingClientRect().top < inset.height) {
        const left = window.innerWidth / 2 - inset.width / 2
        const els = items()
        const push = computeNotchPush(
          els.map((el) => {
            const r = el.getBoundingClientRect()
            return { left: r.left, width: r.width }
          }),
          left,
          left + inset.width
        )
        if (push) {
          const el = els[push.index]
          el.setAttribute(NOTCH_ITEM_ATTR, el.style.marginLeft)
          const base = parseFloat(getComputedStyle(el).marginLeft) || 0
          el.style.marginLeft = `${base + push.px}px`
        }
      }
      for (const [f, x] of scrolls) if (f.scrollLeft !== x) f.scrollLeft = x
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
      for (const f of scrollers) f.removeEventListener('scroll', schedule)
      ro.observe(row!)
      for (const el of items()) ro.observe(el)
      mo.observe(row!, { childList: true })
      scrollers = flows()
      for (const f of scrollers) {
        mo.observe(f, { childList: true })
        f.addEventListener('scroll', schedule, { passive: true })
      }
    }
    observeAll()
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
      for (const f of scrollers) f.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      clear()
    }
  }, [inset, rowRef])
}
