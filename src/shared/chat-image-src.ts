// Markdown in a chat message can point at an image that lives on the
// machine running the agent rather than at a URL — a screenshot the agent
// just took, say. A plain <img src> can't load those: the renderer's
// origin is app:// (http://localhost in dev), so an absolute filesystem
// path resolves against the wrong root, and react-markdown's default URL
// transform strips file:// outright. So srcs that look like local files are
// routed through the readAttachmentImage IPC (which hands back base64 for a
// data URL) and everything else is left to render as an ordinary <img>.

const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

export interface LocalImageSrc {
  path: string
  mediaType: string
  /** Size parsed off a `#…` fragment on the src, e.g.
   *  `/tmp/a.png#w=200`. An alt or title spec outranks it. */
  size?: ImageSizeHint
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)
}

/** Resolve a markdown image src to an on-disk path, or null when it isn't
 *  one (http(s), data:, protocol-relative, bare relative paths, or a file
 *  extension we don't recognize as an image).
 *
 *  Relative paths are deliberately NOT resolved against the worktree root.
 *  A chat transcript is rendered by clients that may not share a
 *  filesystem with the session, so only a src the author made explicitly
 *  absolute is treated as a file reference. */
export function resolveLocalImageSrc(src: string | null | undefined): LocalImageSrc | null {
  if (!src) return null
  let path = src.trim()
  if (!path) return null

  if (/^file:\/\//i.test(path)) {
    const rest = path.replace(/^file:\/\/(localhost)?/i, '')
    try {
      path = decodeURIComponent(rest)
    } catch {
      path = rest
    }
  } else if (
    // The drive-letter check comes first: `C:/…` would otherwise read as a
    // one-letter URL scheme.
    !/^[a-z]:[\\/]/i.test(path) &&
    (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//'))
  ) {
    // http:, https:, data:, protocol-relative — someone else's to load.
    return null
  }

  if (!isAbsolutePath(path)) return null

  // A trailing `#…` is only treated as a size when stripping it leaves a
  // real image extension AND the fragment parses as a size — otherwise a
  // filename that genuinely contains `#` keeps working. Without this,
  // `/tmp/a.png#w=200` resolved to nothing and fell through to a broken
  // <img> that rendered as blank space, which is the worst of the
  // available outcomes.
  let size: ImageSizeHint | undefined
  const hash = path.lastIndexOf('#')
  if (hash > 0) {
    const head = path.slice(0, hash)
    if (imageMediaType(head)) {
      // The markdown parser percent-encodes the URL on the way through, so
      // a `#w=50%` written by an agent arrives as `#w=50%25`.
      let tail = path.slice(hash + 1)
      try {
        tail = decodeURIComponent(tail)
      } catch {
        /* malformed escape — parse what was written */
      }
      const parsed = parseImageSizeSpec(tail)
      if (parsed) {
        path = head
        size = parsed
      }
    }
  }

  const mediaType = imageMediaType(path)
  if (!mediaType) return null
  return { path, mediaType, ...(size ? { size } : {}) }
}

function imageMediaType(path: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return ext ? MEDIA_TYPE_BY_EXT[ext] : undefined
}

// Display size. CommonMark has no syntax for it and raw HTML is off in chat
// (rehype-raw would let any model-authored markup into the renderer), so the
// size rides in the two places an image already carries free text: the alt
// after a pipe (`![panel|400](…)`, Obsidian's spelling) and the title when
// it starts with `=` (`![panel](… "=400x300")`, markdown-it-imsize's). Both
// are prior art, so whichever an agent reaches for works.

/** Width is px unless `widthPercent` is set, in which case it's a
 *  percentage of the available column. Height is always px. */
export interface ImageSizeHint {
  width?: number
  height?: number
  widthPercent?: number
}

// Below ~16px there's nothing to look at; above 2000 the column clamps it
// anyway. Bounds exist so a bogus spec can't blow out the layout.
const MIN_IMAGE_PX = 16
const MAX_IMAGE_PX = 2000

function clampPx(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined
  return Math.min(MAX_IMAGE_PX, Math.max(MIN_IMAGE_PX, Math.round(n)))
}

/** Parse a size spec: `400`, `400x300`, `x300` (height only), `50%`. A
 *  leading `=` is tolerated. Returns null when it isn't one. */
export function parseImageSizeSpec(spec: string | null | undefined): ImageSizeHint | null {
  if (!spec) return null
  // `=400`, `w=400`, `width=400` all mean the same thing — agents reach for
  // each of them.
  const s = spec.trim().replace(/^(?:w|width)?=/i, '').trim()
  if (!s) return null

  const pct = /^(\d{1,3})%$/.exec(s)
  if (pct) {
    const p = Math.min(100, Math.max(5, parseInt(pct[1], 10)))
    return { widthPercent: p }
  }
  const pair = /^(\d{1,6})?\s*[x×]\s*(\d{1,6})?$/i.exec(s)
  if (pair && (pair[1] || pair[2])) {
    const width = pair[1] ? clampPx(parseInt(pair[1], 10)) : undefined
    const height = pair[2] ? clampPx(parseInt(pair[2], 10)) : undefined
    if (width === undefined && height === undefined) return null
    return { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) }
  }
  const only = /^(\d{1,6})(?:px)?$/i.exec(s)
  if (only) {
    const width = clampPx(parseInt(only[1], 10))
    return width === undefined ? null : { width }
  }
  return null
}

/** Split a size spec off the end of alt text: `panel|400` → alt `panel`,
 *  size 400px wide. Alt text that merely contains a pipe (a table row
 *  pasted into alt, say) is left whole. */
export function parseImageAlt(alt: string | null | undefined): {
  alt: string
  size: ImageSizeHint | null
} {
  const raw = alt ?? ''
  const pipe = raw.lastIndexOf('|')
  if (pipe === -1) return { alt: raw, size: null }
  const size = parseImageSizeSpec(raw.slice(pipe + 1))
  if (!size) return { alt: raw, size: null }
  return { alt: raw.slice(0, pipe).trim(), size }
}

/** A title is only read as a size when it starts with `=`, so ordinary
 *  tooltip titles — including numeric ones — keep working. Returns the
 *  size and the title that should still render as a tooltip. */
export function parseImageTitle(title: string | null | undefined): {
  title: string | undefined
  size: ImageSizeHint | null
} {
  const raw = title ?? ''
  if (!raw.trim().startsWith('=')) return { title: raw || undefined, size: null }
  const size = parseImageSizeSpec(raw)
  if (!size) return { title: raw, size: null }
  return { title: undefined, size }
}
