/** Matches the textarea's `min-h-[60px]` so a drag can't shrink the
 *  composer below what the CSS floor would render anyway. */
export const MIN_COMPOSER_HEIGHT = 60

/** The transcript has to keep enough room to show something. Growing the
 *  composer stops here rather than letting the prompt eat the whole pane. */
export const MIN_TRANSCRIPT_HEIGHT = 120

/** localStorage key for one chat session's composer height. Mirrors the
 *  `harness:` namespace App.tsx uses for sidebar / right-panel widths. */
export function composerHeightKey(sessionId: string): string {
  return `harness:chatComposerHeight:${sessionId}`
}

/** Previously-dragged height for a session, or null if it was never
 *  resized (or the stored value is unusable). */
export function readComposerHeight(sessionId: string): number | null {
  const saved = Number(localStorage.getItem(composerHeightKey(sessionId)))
  return Number.isFinite(saved) && saved > 0 ? saved : null
}

/**
 * Resolve a drag delta into a new composer height.
 *
 * `deltaY` is in screen coordinates (down-positive), so dragging the
 * divider *up* yields a negative delta and grows the composer — hence the
 * subtraction.
 *
 * When the two floors conflict (a pane so short that honoring
 * MIN_TRANSCRIPT_HEIGHT would leave the composer under
 * MIN_COMPOSER_HEIGHT), the composer floor wins: an unusably short prompt
 * is worse than a cramped transcript.
 */
export function clampComposerHeight(
  current: number,
  deltaY: number,
  transcriptPx: number
): number {
  const desired = Math.round(current - deltaY)
  const headroom = Math.max(0, transcriptPx - MIN_TRANSCRIPT_HEIGHT)
  const ceiling = current + headroom
  return Math.max(MIN_COMPOSER_HEIGHT, Math.min(ceiling, desired))
}
