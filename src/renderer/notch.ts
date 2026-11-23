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

/** Pushes the first top-bar item that would sit under the notch to the
 *  notch's right edge, leaving a gap (still part of the row's drag region).
 *
 *  Items are the row's direct children, except that a child marked
 *  `data-notch-flow` (the scrolling tab strip) is descended into so the gap
 *  lands between tabs. Tabs inside the strip are measured at scrollLeft 0,
 *  so the gap is right when the strip is at rest and scrolls with the tabs
 *  when it overflows. Rows that aren't at the top of the window (a split
 *  pane's lower tab bar) are left alone. */
export function useNotchAvoidance(rowRef: RefObject<HTMLElement | null>): void {
  const inset = useNotchInset()
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return

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

    const items = (): { el: HTMLElement; scrollLeft: number }[] => {
      const out: { el: HTMLElement; scrollLeft: number }[] = []
      for (const child of Array.from(row.children) as HTMLElement[]) {
        if (child.hasAttribute('data-notch-flow')) {
          for (const c of Array.from(child.children) as HTMLElement[]) {
            out.push({ el: c, scrollLeft: child.scrollLeft })
          }
        } else {
          out.push({ el: child, scrollLeft: 0 })
        }
      }
      return out
    }

    const apply = (): void => {
      clear()
      if (row.getBoundingClientRect().top >= inset.height) return
      const left = window.innerWidth / 2 - inset.width / 2
      const right = left + inset.width
      for (const { el, scrollLeft } of items()) {
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        const x = r.left + scrollLeft
        if (x + r.width <= left) continue
        if (x >= right) break
        // Everything after this item reflows right with it, so one push is
        // enough.
        el.setAttribute(NOTCH_ITEM_ATTR, el.style.marginLeft)
        const base = parseFloat(getComputedStyle(el).marginLeft) || 0
        el.style.marginLeft = `${base + right - x}px`
        break
      }
    }

    apply()
    // Clearing + re-applying in one pass nets out to the same layout, so the
    // observer doesn't feed itself.
    const ro = new ResizeObserver(apply)
    const observeAll = (): void => {
      ro.disconnect()
      ro.observe(row)
      for (const { el } of items()) ro.observe(el)
    }
    observeAll()
    const mo = new MutationObserver(() => {
      observeAll()
      apply()
    })
    mo.observe(row, { childList: true })
    for (const child of row.querySelectorAll('[data-notch-flow]')) mo.observe(child, { childList: true })
    window.addEventListener('resize', apply)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', apply)
      clear()
    }
  }, [inset, rowRef])
}
