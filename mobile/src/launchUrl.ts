// The app's launch URL, at most once. iOS / Expo Go hand back the SAME
// initial URL on every cold start and full reload of an app that was
// opened from a link — so a pairing QR (…/pair?url=…) kept re-adding and
// re-enabling its backend after the user had switched it off, and an
// open link (…/open?wt=…) kept yanking them back to that chat. A link is
// acted on the first time it's seen; replays of the same URL are ignored.
// Links that arrive while running (Linking 'url' events) are always fresh
// and don't go through here.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Linking } from 'react-native'

const KEY = 'ness.mobile.consumedLaunchUrl'
let pending: Promise<string | null> | null = null

export function consumeLaunchUrl(): Promise<string | null> {
  if (!pending) {
    pending = (async () => {
      const url = await Linking.getInitialURL()
      if (!url) return null
      const last = await AsyncStorage.getItem(KEY)
      if (last === url) return null
      await AsyncStorage.setItem(KEY, url)
      return url
    })()
  }
  return pending
}
