// Text the user can select part of, in place — the browser's free-form
// selection on desktop and web. RN's iOS `selectable` only offers Copy for
// a whole Text, so on iOS this is a UITextView (react-native-uitextview):
// handles, partial ranges, the edit menu, nested styling and tappable
// spans. Elsewhere the library falls back to RN Text, which on Android is
// already range-selectable.
//
// Nesting rule: inside a SelectableText, raw strings are only turned into
// native spans when they're DIRECT children of a SelectableText. A string
// rendered by an intermediate component, or a nested RN <Text>, becomes a
// stray child of the native view and doesn't render. So every inline piece
// of a selectable block has to be a SelectableText itself.
import type { TextProps } from 'react-native'
import { UITextView } from 'react-native-uitextview'

export function SelectableText(props: TextProps) {
  return <UITextView selectable uiTextView {...props} />
}
