import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { getBackend } from '../backend'

// Module-level cache so the same image isn't re-read once per render. The
// values are data URLs ready to drop into <img src=""/>; null marks a
// confirmed-missing path so we don't keep retrying.
const CACHE = new Map<string, string | null>()
const INFLIGHT = new Map<string, Promise<string | null>>()

function fetchImage(path: string, mediaType: string): Promise<string | null> {
  if (CACHE.has(path)) return Promise.resolve(CACHE.get(path)!)
  const inflight = INFLIGHT.get(path)
  if (inflight) return inflight
  const p = getBackend()
    .readJsonClaudeAttachmentImage(path)
    .then((b64) => {
      const result = b64 ? `data:${mediaType};base64,${b64}` : null
      CACHE.set(path, result)
      INFLIGHT.delete(path)
      return result
    })
    .catch(() => {
      CACHE.set(path, null)
      INFLIGHT.delete(path)
      return null
    })
  INFLIGHT.set(path, p)
  return p
}

interface Props {
  path: string
  mediaType: string
  /** 'square' crops to a 64px tile — right for pasted attachments, where
   *  the thumbnail is an affordance rather than something to read.
   *  'wide' keeps the aspect ratio at 128px tall, for browser
   *  screenshots where a centre-crop would throw away the page.
   *  'inline' is for a screenshot the agent embedded in its prose: as
   *  large as the column allows, because the point is to look at it. */
  shape?: 'square' | 'wide' | 'inline'
  /** 'sm' is half the linear size of 'base' — used for the strip that
   *  rides along in a collapsed tool card / tool group header, where the
   *  thumbnail is a "there's a screenshot here" marker rather than
   *  something to read. Ignored for shape 'inline'. */
  size?: 'base' | 'sm'
  /** Alt text, when the embedder has one (markdown `![alt](path)`). */
  alt?: string
}

export function JsonModeChatImageThumb({
  path,
  mediaType,
  shape = 'square',
  size = 'base',
  alt
}: Props): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(
    CACHE.has(path) ? CACHE.get(path)! : null
  )
  const [pending, setPending] = useState(!CACHE.has(path))
  const [showFull, setShowFull] = useState(false)

  useEffect(() => {
    if (CACHE.has(path)) {
      setDataUrl(CACHE.get(path)!)
      setPending(false)
      return
    }
    let cancelled = false
    setPending(true)
    void fetchImage(path, mediaType).then((url) => {
      if (cancelled) return
      setDataUrl(url)
      setPending(false)
    })
    return () => {
      cancelled = true
    }
  }, [path, mediaType])

  useEffect(() => {
    if (!showFull) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShowFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showFull])

  const name = alt || path.split('/').pop() || path
  const sm = size === 'sm'
  const boxClass =
    shape === 'inline'
      ? 'h-48 w-full max-w-lg'
      : shape === 'wide'
        ? sm
          ? 'h-16 w-24'
          : 'h-32 w-48'
        : sm
          ? 'h-8 w-8'
          : 'h-16 w-16'
  const imgClass =
    shape === 'inline'
      ? 'max-h-96 w-auto max-w-full object-contain bg-app'
      : shape === 'wide'
        ? `${sm ? 'h-16' : 'h-32'} w-auto max-w-full object-contain bg-app`
        : sm
          ? 'h-8 w-8 object-cover'
          : 'h-16 w-16 object-cover'

  if (pending) {
    return (
      <div
        className={`${boxClass} rounded bg-panel border border-border animate-pulse`}
        title={path}
      />
    )
  }
  if (!dataUrl) {
    return (
      <div
        className={`${boxClass} rounded bg-panel border border-border flex items-center justify-center gap-2 text-faint`}
        title={`${path} (no longer on disk)`}
      >
        <ImageOff className={sm ? 'icon-xs' : 'icon-base'} />
        {shape === 'inline' && (
          <span className="text-xs font-mono truncate px-2">{path}</span>
        )}
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setShowFull(true)}
        className="block cursor-zoom-in"
        title={path}
      >
        <img
          src={dataUrl}
          alt={name}
          className={`${imgClass} rounded border border-border hover:border-accent transition-colors`}
        />
      </button>
      {showFull && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 cursor-zoom-out"
          onClick={() => setShowFull(false)}
        >
          <img
            src={dataUrl}
            alt={name}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      )}
    </>
  )
}
