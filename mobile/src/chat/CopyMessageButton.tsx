// Copies a whole message. In-place selection (SelectableText) is per
// block: each paragraph, list item and code block is its own native text
// view and a selection can't cross them, so copying a ten-paragraph reply
// would take ten copies. This puts the full message source on the
// clipboard in one tap, as the old Select Text sheet's Select All did.
import { useEffect, useRef, useState } from 'react'
import { Pressable } from 'react-native'
import { Check, Copy } from 'lucide-react-native'
import { copyText } from '../clipboard'
import { hitArea } from '../hit'
import { c } from '../theme'

export function CopyMessageButton({ text, align = 'flex-start' }: { text: string; align?: 'flex-start' | 'flex-end' }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  if (!text) return null
  const Icon = copied ? Check : Copy
  return (
    <Pressable
      onPress={() => {
        void copyText(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1200)
        })
      }}
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Copied' : 'Copy message'}
      // A 14pt icon grown to a 44pt frame (hit.ts), so VoiceOver and touch
      // both get a full-size target. The margins leave 4pt/2pt of the
      // padding in layout, the spacing the icon had before.
      style={[{ alignSelf: align, zIndex: 1 }, hitArea(15, 15), { marginVertical: -11, marginHorizontal: -13 }]}
    >
      <Icon color={copied ? c.accent : c.muted} size={14} />
    </Pressable>
  )
}
