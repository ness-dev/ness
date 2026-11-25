// Persisted pairing. expo-secure-store is iOS/Android only, so Expo web
// (used to drive the spike from a desktop browser) falls back to
// localStorage — fine for a demo, not for a real token.
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

const KEY = 'ness.connection'

export interface SavedConnection {
  wsUrl: string
  token: string
}

export async function loadConnection(): Promise<SavedConnection | null> {
  const raw =
    Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) ?? null : await SecureStore.getItemAsync(KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SavedConnection
  } catch {
    return null
  }
}

export async function saveConnection(c: SavedConnection): Promise<void> {
  const raw = JSON.stringify(c)
  if (Platform.OS === 'web') globalThis.localStorage?.setItem(KEY, raw)
  else await SecureStore.setItemAsync(KEY, raw)
}

export async function clearConnection(): Promise<void> {
  if (Platform.OS === 'web') globalThis.localStorage?.removeItem(KEY)
  else await SecureStore.deleteItemAsync(KEY)
}
