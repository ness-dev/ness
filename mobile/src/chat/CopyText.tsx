// Copying chat text. The web chat gets free-form selection from the
// browser; React Native can't select across a message (iOS `selectable`
// only offers Copy for one whole Text). So, like the native chat apps:
// long-press a message for Copy / Select Text, and Select Text opens the
// message in a read-only text view, where iOS gives real selection handles,
// Select All, Look Up and Share.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { ActionSheetIOS, Alert, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as ExpoClipboard from 'expo-clipboard'
import { c, fs, getThemeMode } from '../theme'

type OpenMenu = (text: string) => void
const CopyMenuContext = createContext<OpenMenu | null>(null)

/** Hosts the menu and the Select Text sheet for a chat. Lives above the
 *  virtualized transcript so a row scrolling away doesn't close it. */
export function CopyMenuHost({ children }: { children: ReactNode }) {
  const [selecting, setSelecting] = useState<string | null>(null)
  const open = useCallback<OpenMenu>((text) => {
    const copy = () => void ExpoClipboard.setStringAsync(text)
    const select = () => setSelecting(text)
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Copy', 'Select Text', 'Cancel'], cancelButtonIndex: 2, userInterfaceStyle: getThemeMode() },
        (i) => (i === 0 ? copy() : i === 1 ? select() : undefined)
      )
    } else {
      Alert.alert('Message', undefined, [
        { text: 'Copy', onPress: copy },
        { text: 'Select Text', onPress: select },
        { text: 'Cancel', style: 'cancel' }
      ])
    }
  }, [])
  return (
    <CopyMenuContext.Provider value={open}>
      {children}
      <SelectTextSheet text={selecting} onClose={() => setSelecting(null)} />
    </CopyMenuContext.Provider>
  )
}

/** Wraps a message so a long-press opens the copy menu for `text`. Taps
 *  pass through to anything pressable inside (folds, images, links). */
export function CopyableMessage({ text, children }: { text: string; children: ReactNode }) {
  const open = useContext(CopyMenuContext)
  if (!open || !text) return <>{children}</>
  return (
    <Pressable onLongPress={() => open(text)} delayLongPress={350} accessibilityHint="Long-press to copy or select text">
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
          <Pressable
            onPress={() => {
              if (text) void ExpoClipboard.setStringAsync(text)
              onClose()
            }}
            style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' }}
            accessibilityLabel="Copy all and close"
          >
            <Text style={{ color: c.accent, fontSize: fs.sm }}>Copy All</Text>
          </Pressable>
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
