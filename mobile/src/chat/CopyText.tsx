// Copying chat text. The web chat gets free-form selection from the
// browser; React Native can't select across a message (iOS `selectable`
// only offers Copy for one whole Text). So long-pressing a message opens
// it in a read-only text view, where iOS gives real selection handles,
// Copy, Select All, Look Up and Share.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Modal, Pressable, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { c, fs, getThemeMode } from '../theme'
import { haptic } from '../haptics'

type OpenMenu = (text: string) => void
const CopyMenuContext = createContext<OpenMenu | null>(null)

/** Hosts the Select Text sheet for a chat. Lives above the
 *  virtualized transcript so a row scrolling away doesn't close it. */
export function CopyMenuHost({ children }: { children: ReactNode }) {
  const [selecting, setSelecting] = useState<string | null>(null)
  const open = useCallback<OpenMenu>((text) => setSelecting(text), [])
  return (
    <CopyMenuContext.Provider value={open}>
      {children}
      <SelectTextSheet text={selecting} onClose={() => setSelecting(null)} />
    </CopyMenuContext.Provider>
  )
}

/** Wraps a message so a long-press opens `text` for selection. Taps
 *  pass through to anything pressable inside (folds, images, links). */
export function CopyableMessage({ text, children }: { text: string; children: ReactNode }) {
  const open = useContext(CopyMenuContext)
  if (!open || !text) return <>{children}</>
  return (
    <Pressable
      onLongPress={() => {
        haptic.press()
        open(text)
      }} delayLongPress={350} accessibilityHint="Long-press to select and copy text">
      {children}
    </Pressable>
  )
}

function SelectTextSheet({ text, onClose }: { text: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={text !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.panel }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: c.border, paddingLeft: 16 }}>
          <Text style={{ flex: 1, color: c.fgBright, fontSize: fs.sm, fontWeight: '600' }}>Select Text</Text>
          <Pressable onPress={onClose} style={{ minHeight: 44, paddingHorizontal: 16, justifyContent: 'center' }} accessibilityLabel="Done">
            <Text style={{ color: c.accent, fontSize: fs.sm, fontWeight: '600' }}>Done</Text>
          </Pressable>
        </View>
        {/* Read-only, but still a UITextView: selection handles, the
            edit menu and Select All all work; the keyboard never shows. */}
        <TextInput
          value={text ?? ''}
          editable={false}
          multiline
          scrollEnabled
          keyboardAppearance={getThemeMode()}
          style={{
            flex: 1,
            color: c.fg,
            fontSize: fs.base,
            lineHeight: 22,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 12 + insets.bottom,
            textAlignVertical: 'top'
          }}
        />
      </View>
    </Modal>
  )
}
