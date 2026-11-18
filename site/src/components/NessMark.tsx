// The Ness mark, mirrored from src/renderer/components/NessMark.tsx so the
// marketing mock renders the same artwork as the app. resources/icon.svg is
// the master — if the mark changes, all three move together.

const NESS_MARK_PATHS = [
  'M7.6 38C8.1 33.4 10.6 30.6 14.4 30.8C18.1 31 20.6 33.8 21.6 38Z',
  'M19.4 38C20.4 32.4 23.3 28.2 27.8 27.9C32.6 27.6 36 31.4 37.4 38Z',
  'M39.4 38C38.9 30.2 39 22.4 41 17.8C43.1 13 47.7 10.4 51.6 11.6C55 12.7 56.8 15.4 56.5 17.9C56.2 20.2 53.5 21.2 50.3 20.9C48 20.7 47 22.2 47.3 25.2C47.7 29.6 48.5 33.7 49.4 38Z'
]

// viewBox is the mark's own bounding box plus a little air (roughly 1.68:1),
// so give it a height and let the width follow.
export function NessMark({ className }: { className?: string }) {
  return (
    <svg viewBox="5.6 8.4 53.2 31.6" className={className} fill="currentColor" aria-hidden="true">
      {NESS_MARK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
