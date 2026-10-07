// Emulated viewport for a browser tab — the "device mode" of Ness's browser
// tabs. Shared by main (both browser backends + the control server) and the
// renderer (the size picker in BrowserPanel), so the parsing rules and the
// preset list can't drift between what an agent can ask for and what the UI
// offers.

export interface BrowserViewport {
  width: number
  height: number
  /** Device pixel ratio. 1 keeps screenshot pixels equal to CSS pixels, which
   *  is what makes screenshot-derived coordinates safe to pass to click_tab. */
  deviceScaleFactor: number
  /** Chrome's mobile emulation: honours `<meta name="viewport">`, switches the
   *  page to the mobile layout path and enables touch events. Without it a
   *  narrow viewport still renders as a narrow *desktop* window. */
  mobile: boolean
  /** Replaces navigator.userAgent and the UA request header while set. */
  userAgent?: string
}

/** Sent while mobile emulation is on unless the caller supplies its own.
 *  Without it, UA-sniffing sites (google.com is the canonical example) hand
 *  back their desktop HTML and the emulated phone shows a shrunken desktop
 *  page — which looks like the emulation silently didn't work. */
export const DEFAULT_MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'

const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36'

const IPAD_USER_AGENT =
  'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'

export const VIEWPORT_LIMITS = {
  minSize: 50,
  maxSize: 4096,
  minScale: 0.5,
  maxScale: 4,
  maxUserAgentLength: 512
}

/** Width at or below which `mobile` defaults to true. Picked so phones and
 *  small tablets emulate as touch devices while a narrow desktop window
 *  doesn't. Callers can always pass `mobile` explicitly. */
export const MOBILE_WIDTH_THRESHOLD = 600

export interface DevicePreset {
  id: string
  label: string
  viewport: BrowserViewport
}

export const DEVICE_PRESETS: DevicePreset[] = [
  {
    id: 'iphone-se',
    label: 'iPhone SE',
    viewport: {
      width: 375,
      height: 667,
      deviceScaleFactor: 1,
      mobile: true,
      userAgent: DEFAULT_MOBILE_USER_AGENT
    }
  },
  {
    id: 'iphone-15',
    label: 'iPhone 15',
    viewport: {
      width: 393,
      height: 852,
      deviceScaleFactor: 1,
      mobile: true,
      userAgent: DEFAULT_MOBILE_USER_AGENT
    }
  },
  {
    id: 'pixel-8',
    label: 'Pixel 8',
    viewport: {
      width: 412,
      height: 915,
      deviceScaleFactor: 1,
      mobile: true,
      userAgent: ANDROID_USER_AGENT
    }
  },
  {
    id: 'ipad-mini',
    label: 'iPad mini',
    viewport: {
      width: 768,
      height: 1024,
      deviceScaleFactor: 1,
      mobile: true,
      userAgent: IPAD_USER_AGENT
    }
  },
  {
    id: 'ipad-pro',
    label: 'iPad Pro',
    viewport: {
      width: 1024,
      height: 1366,
      deviceScaleFactor: 1,
      mobile: true,
      userAgent: IPAD_USER_AGENT
    }
  },
  {
    id: 'laptop',
    label: 'Laptop',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }
  },
  {
    id: 'desktop',
    label: 'Desktop',
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }
  }
]

export type ViewportParseResult =
  | { viewport: BrowserViewport; error?: undefined }
  | { error: string; viewport?: undefined }

function parseSize(raw: unknown, field: string): number | string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return `${field} must be a number`
  const rounded = Math.round(n)
  if (rounded < VIEWPORT_LIMITS.minSize || rounded > VIEWPORT_LIMITS.maxSize) {
    return `${field} must be between ${VIEWPORT_LIMITS.minSize} and ${VIEWPORT_LIMITS.maxSize} CSS pixels (got ${rounded})`
  }
  return rounded
}

/**
 * Validate an agent- or UI-supplied viewport request. Out-of-range values are
 * rejected rather than clamped: an agent that asked for a 20000px-wide page and
 * silently got 4096 would draw the wrong conclusion from the screenshot.
 */
export function normalizeViewport(raw: unknown): ViewportParseResult {
  if (raw == null || typeof raw !== 'object') {
    return { error: 'viewport must be an object with width and height' }
  }
  const input = raw as Record<string, unknown>

  const width = parseSize(input.width, 'width')
  if (typeof width === 'string') return { error: width }
  const height = parseSize(input.height, 'height')
  if (typeof height === 'string') return { error: height }

  let deviceScaleFactor = 1
  if (input.deviceScaleFactor != null) {
    const dsf = Number(input.deviceScaleFactor)
    if (
      !Number.isFinite(dsf) ||
      dsf < VIEWPORT_LIMITS.minScale ||
      dsf > VIEWPORT_LIMITS.maxScale
    ) {
      return {
        error: `deviceScaleFactor must be between ${VIEWPORT_LIMITS.minScale} and ${VIEWPORT_LIMITS.maxScale}`
      }
    }
    deviceScaleFactor = dsf
  }

  const mobile =
    input.mobile == null ? width <= MOBILE_WIDTH_THRESHOLD : Boolean(input.mobile)

  // An explicit empty string is the opt-out: emulate the size and touch
  // behaviour but keep the real desktop user agent.
  const uaExplicit = typeof input.userAgent === 'string'
  let userAgent: string | undefined
  if (input.userAgent != null) {
    if (!uaExplicit) return { error: 'userAgent must be a string' }
    const trimmed = (input.userAgent as string).trim()
    if (trimmed.length > VIEWPORT_LIMITS.maxUserAgentLength) {
      return {
        error: `userAgent must be at most ${VIEWPORT_LIMITS.maxUserAgentLength} characters`
      }
    }
    if (trimmed) userAgent = trimmed
  }
  if (!userAgent && mobile && !uaExplicit) userAgent = DEFAULT_MOBILE_USER_AGENT

  return { viewport: { width, height, deviceScaleFactor, mobile, userAgent } }
}

/** Short human label for a viewport, e.g. `390×844` or `390×844 @2x`. */
export function formatViewport(vp: BrowserViewport): string {
  const scale = vp.deviceScaleFactor !== 1 ? ` @${vp.deviceScaleFactor}x` : ''
  return `${vp.width}×${vp.height}${scale}`
}

export function viewportsEqual(
  a: BrowserViewport | null | undefined,
  b: BrowserViewport | null | undefined
): boolean {
  if (!a || !b) return a == b
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.deviceScaleFactor === b.deviceScaleFactor &&
    a.mobile === b.mobile &&
    (a.userAgent ?? '') === (b.userAgent ?? '')
  )
}
