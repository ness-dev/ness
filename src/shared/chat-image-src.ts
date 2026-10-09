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
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  const mediaType = ext ? MEDIA_TYPE_BY_EXT[ext] : undefined
  if (!mediaType) return null
  return { path, mediaType }
}
