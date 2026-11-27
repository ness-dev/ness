import * as ExpoClipboard from 'expo-clipboard'
import { Alert } from 'react-native'

/** navigator.clipboard.writeText stand-in (expo-clipboard; ships in Expo
 *  Go). Resolves to whether the write landed, so a "Copied" confirmation
 *  only shows on success; a failure shows the text in an Alert instead. */
export function copyText(text: string): Promise<boolean> {
  return ExpoClipboard.setStringAsync(text).then(
    () => true,
    () => {
      Alert.alert('Copy failed', text)
      return false
    }
  )
}
