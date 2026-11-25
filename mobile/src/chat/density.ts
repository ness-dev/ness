// The web chat's `--chat-*` density tokens (renderer/styles.css,
// [data-chat-density]). Picked from settings.jsonModeChatDensity.
import { createContext, useContext } from 'react'
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

/** Chat rows are visually ~28px tall (that's the web's density); extend
 *  the touch area to ~44pt without changing the layout. */
export const ROW_HIT_SLOP = { top: 8, bottom: 8, left: 0, right: 0 }
