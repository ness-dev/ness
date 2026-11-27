// Growing a small control's touch area to ~44pt without moving anything.
//
// hitSlop does widen where touches land, but it's invisible to the
// accessibility tree: VoiceOver's focus frame, Accessibility Inspector and
// the element frames UI tests see all stay at the small visual size, so the
// control still reads (and audits) as a 20pt target. Padding grows the real
// frame instead, and the equal negative margin cancels it in layout.
//
// Hit-testing checks later siblings first, so where the grown area overlaps
// a following sibling, that sibling wins unless the control has a zIndex.
// Ancestors with overflow: 'hidden' (and ScrollViews) still clip it.
export function hitArea(vertical: number, horizontal = 0) {
  return {
    paddingVertical: vertical,
    marginVertical: -vertical,
    paddingHorizontal: horizontal,
    marginHorizontal: -horizontal
  }
}
