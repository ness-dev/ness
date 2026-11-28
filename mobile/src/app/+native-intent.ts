// Incoming links, before they reach navigation.
//
// /open?wt=<worktree path>&tab=<tab id> — jump straight to a chat (what a
// push notification for an approval will link to) — is rewritten to the
// worktree route itself. Handled here rather than as an /open screen that
// redirects: that screen would stay in the stack under the worktree, so
// swipe-back would land on it.
//
// Replays: iOS / Expo Go hand back the SAME launch URL on every cold start
// and full reload of an app that was opened from a link — so a pairing
// link kept re-adding a backend the user had since switched off, and an
// /open link kept yanking them back to that chat. A launch link is acted
// on the first time it's seen; a replay goes home instead. Links that
// arrive while the app is running (initial: false) are always fresh.
import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'ness.mobile.consumedLaunchUrl'

export async function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): Promise<string> {
  try {
    const isAction = /\/(pair|open)\b/.test(path)
    if (initial && isAction) {
      if ((await AsyncStorage.getItem(KEY)) === path) return '/'
      await AsyncStorage.setItem(KEY, path)
    }
    return rewriteOpen(path)
  } catch {
    return '/'
  }
}

function rewriteOpen(path: string): string {
  const m = /\/open\?(.*)$/.exec(path)
  if (!m) return path
  const q = new URLSearchParams(m[1])
  const wt = q.get('wt')
  if (!wt) return '/'
  const tab = q.get('tab')
  return `/w/${encodeURIComponent(wt)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`
}
