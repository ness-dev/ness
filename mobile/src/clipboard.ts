import * as ExpoClipboard from 'expo-clipboard'
import { Alert } from 'react-native'

/** navigator.clipboard.writeText stand-in (expo-clipboard; ships in Expo
 *  Go). Fire-and-forget like the desktop's copy. */
export function copyText(text: string): boolean {
  ExpoClipboard.setStringAsync(text).catch(() => Alert.alert('Copy failed', text))
  return true
}
