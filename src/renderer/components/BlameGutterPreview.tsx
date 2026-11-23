import { useMemo } from 'react'
import { LochBlameCard } from './LochBlameCard'
import type { LochConversation } from '../../shared/loch'

// A static picture of the blame gutter for the history-tracking explainer.
// Built from the real card and the real bar colours rather than shipped as a
// screenshot, so it follows the theme, stays sharp at every UI scale, keeps
// up as the card changes, and carries no real session's text.

const CODE: { text: string; slot: number | null; backfilled?: boolean }[] = [
  { text: 'export async function uploadAsset(file: Asset): Promise<string> {', slot: 0 },
  { text: '  const key = assetKey(file)', slot: 0 },
  { text: '  for (let attempt = 0; ; attempt++) {', slot: 1 },
  { text: '    try {', slot: 1 },
  { text: '      return await bucket.put(key, file.body)', slot: 1 },
  { text: '    } catch (err) {', slot: 1 },
  { text: '      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err', slot: 1 },
  { text: '      // Don’t let every worker retry at the same moment', slot: null },
  { text: '      const jitter = Math.random() * BASE_DELAY_MS', slot: 2 },
  { text: '      await sleep(BASE_DELAY_MS * 2 ** attempt + jitter)', slot: 2 },
  { text: '    }', slot: 1 },
  { text: '  }', slot: 0 },
  { text: '}', slot: 0 },
  { text: '', slot: null },
  { text: 'function isRetryable(err: unknown): boolean {', slot: 3, backfilled: true },
  { text: '  return err instanceof HttpError && err.status >= 500', slot: 3, backfilled: true },
  { text: '}', slot: 3, backfilled: true }
]

/** The hunk the card is "hovering" — lines 9–10, turn C. */
const HOVER_START = 9
const HOVER_END = 10

export function BlameGutterPreview({
  frameClassName = 'mt-4 rounded-lg border border-border'
}: {
  /** The box around the editor. The marketing site draws its own window
   *  chrome around the preview, so it passes an empty frame. */
  frameClassName?: string
} = {}): JSX.Element {
  // Relative to now so "ended 2h ago" never goes stale.
  const conversation = useMemo<LochConversation>(
    () => ({
      mark: 'C',
      session: 'example',
      agent: 'claude-code',
      index: 3,
      ended: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      available: true,
      turn: 'example-turn-3',
      conversation: 'example',
      title: 'Retry flaky asset uploads',
      prompt: 'add jitter so retries from all the upload workers don’t line up',
      backfilled: false
    }),
    []
  )

  return (
    <div
      className={`relative ${frameClassName} bg-app overflow-hidden select-none pointer-events-none`}
      // Tall enough for the card, which hangs below the hovered lines the
      // way the real one does and runs past the end of the snippet.
      style={{ minHeight: '33.5rem' }}
      aria-hidden
    >
      <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-xs">
        <span className="font-mono text-fg">src/upload.ts</span>
      </div>
      <div className="py-2 font-mono text-xs leading-5">
        {CODE.map((line, i) => {
          const n = i + 1
          const hovered = n >= HOVER_START && n <= HOVER_END
          return (
            <div key={n} className={`flex items-stretch ${hovered ? 'bg-panel' : ''}`}>
              <span className="w-8 shrink-0 pr-2 text-right text-faint">{n}</span>
              <span className="w-3 shrink-0 relative">
                {line.slot != null && (
                  <span
                    className={`loch-c${line.slot} absolute top-0 bottom-0 left-0.5 rounded-sm`}
                    style={{
                      width: hovered ? 4 : 3,
                      opacity: hovered ? 1 : line.backfilled ? 0.6 : 0.75,
                      background: line.backfilled
                        ? 'repeating-linear-gradient(to bottom, var(--loch-c) 0 3px, transparent 3px 5px)'
                        : 'var(--loch-c)'
                    }}
                  />
                )}
              </span>
              <span className={`pl-2 whitespace-pre ${line.slot == null ? 'text-dim' : 'text-fg'}`}>
                {line.text || ' '}
              </span>
            </div>
          )
        })}
      </div>
      <div className="absolute left-12 right-2" style={{ top: `calc(2rem + 0.5rem + ${HOVER_END} * 1.25rem)` }}>
        <LochBlameCard
          conversation={conversation}
          start={HOVER_START}
          end={HOVER_END}
          colorSlot={2}
          session={{
            firstPrompt:
              'Asset uploads fail a few times a day with 503s from the bucket and the whole publish job dies. Wrap the upload in retries with exponential backoff, but only for errors that are actually retryable, and make sure we don’t hammer the bucket when it’s down for everyone.'
          }}
          pinned
          onAsk={() => {}}
          // Capped by the preview box (via the wrapper's left/right), not the
          // window: the box clips anything wider.
          widthClass="w-[28rem] max-w-full"
        />
      </div>
    </div>
  )
}
