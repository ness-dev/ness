// Pasted-image attachments for JSON-mode chat. The renderer reads
// clipboard image bytes via FileReader (base64) but has no fs access to
// turn them into a real file Claude can reference. We do that here:
// write the bytes to a stable on-disk location so the model receives
// both the inline image content block AND a path it can pass to Read /
// Bash / Write tools.
//
// Storage location: under os.tmpdir() so we don't pollute any worktree
// or userData dir. macOS clears /tmp opportunistically; that's fine for
// transient chat attachments. Filename embeds a uuid so concurrent
// pastes don't collide.

import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'

const ATTACHMENT_DIR = join(tmpdir(), 'harness-attachments')

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
}

/** Read an image attachment back from disk as base64, for the renderer
 *  to render thumbnails in chat history. Returns null if the file is
 *  missing (e.g. /tmp was cleared) or oversized (we cap at ~10MB to
 *  keep IPC payloads reasonable; chat thumbnails don't need more). */
const MAX_IMAGE_READ_BYTES = 10 * 1024 * 1024

export function readAttachmentImage(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const stat = statSync(path)
    if (stat.size > MAX_IMAGE_READ_BYTES) return null
    return readFileSync(path).toString('base64')
  } catch {
    return null
  }
}

/** Write a base64-encoded image to a fresh path under
 *  $TMPDIR/harness-attachments/. Returns the absolute path. Accepts the
 *  raw base64 string (no data URL prefix). */
export function writeAttachmentImage(
  base64Data: string,
  mediaType: string
): string {
  if (!existsSync(ATTACHMENT_DIR)) {
    mkdirSync(ATTACHMENT_DIR, { recursive: true, mode: 0o700 })
  }
  const ext = EXT_BY_MEDIA_TYPE[mediaType.toLowerCase()] || 'bin'
  const path = join(ATTACHMENT_DIR, `${randomUUID()}.${ext}`)
  writeFileSync(path, Buffer.from(base64Data, 'base64'), { mode: 0o600 })
  return path
}

/** Same as writeAttachmentImage but keyed by content hash, so extracting
 *  the same image twice yields the same path and writes once. Tool-result
 *  images (browser screenshots) need this: resuming a session replays the
 *  whole transcript through the extractor, and uuid names would leak a
 *  fresh copy of every screenshot on every resume. */
export function writeResultImage(base64Data: string, mediaType: string): string {
  if (!existsSync(ATTACHMENT_DIR)) {
    mkdirSync(ATTACHMENT_DIR, { recursive: true, mode: 0o700 })
  }
  const ext = EXT_BY_MEDIA_TYPE[mediaType.toLowerCase()] || 'bin'
  const hash = createHash('sha256').update(base64Data).digest('hex').slice(0, 32)
  const path = join(ATTACHMENT_DIR, `result-${hash}.${ext}`)
  if (!existsSync(path)) {
    writeFileSync(path, Buffer.from(base64Data, 'base64'), { mode: 0o600 })
  }
  return path
}
