// The web chat's `--chat-*` density tokens (renderer/styles.css,
// [data-chat-density]). Picked from settings.jsonModeChatDensity.
import { createContext, useContext, useState } from 'react'
import { mono } from '../theme'

export interface Density {
  body: number
  chrome: number
  meta: number
  chromePx: number
  chromePy: number
  bubbleMax: `${number}%`
  bubbleRadius: number
  promptRadius: number
  toolFamily: string | undefined
}

export const DENSITY: Record<'compact' | 'comfy', Density> = {
  compact: { body: 14, chrome: 12, meta: 10, chromePx: 8, chromePy: 6, bubbleMax: '80%', bubbleRadius: 6, promptRadius: 12, toolFamily: mono },
  comfy: { body: 16, chrome: 14, meta: 12, chromePx: 12, chromePy: 10, bubbleMax: '90%', bubbleRadius: 8, promptRadius: 16, toolFamily: undefined }
}

export const DensityContext = createContext<Density>(DENSITY.compact)
export const useDensity = (): Density => useContext(DensityContext)

/** Which cards the user opened/closed, per chat, keyed by a stable id
 *  (tool_use id, group/turn key). The transcript is a virtualized list
 *  that unmounts off-screen rows, so a card's own useState would forget
 *  an expansion as soon as it scrolled away; the web keeps every row
 *  mounted, so it never loses it. */
export const ExpandStoreContext = createContext<Map<string, boolean> | null>(null)

/** useState<boolean | null> whose explicit choices outlive unmounting.
 *  null = "no choice yet, follow the default". */
export function usePersistedChoice(id: string | undefined): [boolean | null, (v: boolean | null) => void] {
  const store = useContext(ExpandStoreContext)
  const [v, setV] = useState<boolean | null>(() => (id && store?.has(id) ? store.get(id)! : null))
  const set = (next: boolean | null) => {
    if (id && store) {
      if (next === null) store.delete(id)
      else store.set(id, next)
    }
    setV(next)
  }
  return [v, set]
}

/** Chat rows are visually ~28px tall (that's the web's density); extend
 *  the touch area to ~44pt without changing the layout. */
export const ROW_HIT_SLOP = { top: 8, bottom: 8, left: 0, right: 0 }
