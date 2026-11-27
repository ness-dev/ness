// Persisted backend list. expo-secure-store is iOS/Android only, so Expo
// web (used to drive the spike from a desktop browser) falls back to
// localStorage — fine for a demo, not for a real token. The whole list
// is one entry; at ~150 bytes per backend that stays well under the
// ~2KB value size some older iOS keychains reject.
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

const KEY = 'ness.backends'
const LEGACY_KEY = 'ness.connection'

export interface SavedBackend {
  id: string
  label: string
  wsUrl: string
  token: string
  enabled: boolean
}

async function read(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return globalThis.localStorage?.getItem(key) ?? null
  return SecureStore.getItemAsync(key)
}

async function write(key: string, value: string | null): Promise<void> {
  if (Platform.OS === 'web') {
    if (value === null) globalThis.localStorage?.removeItem(key)
    else globalThis.localStorage?.setItem(key, value)
    return
  }
  if (value === null) await SecureStore.deleteItemAsync(key)
  else await SecureStore.setItemAsync(key, value)
}

export async function loadBackends(): Promise<SavedBackend[]> {
  const raw = await read(KEY)
  if (raw) {
    try {
      return JSON.parse(raw) as SavedBackend[]
    } catch {
      return []
    }
  }
  // First spike build stored a single connection.
  const legacy = await read(LEGACY_KEY)
  if (!legacy) return []
  try {
    const { wsUrl, token } = JSON.parse(legacy) as { wsUrl: string; token: string }
    const migrated = [{ id: newId(), label: labelFor(wsUrl), wsUrl, token, enabled: true }]
    await saveBackends(migrated)
    await write(LEGACY_KEY, null)
    return migrated
  } catch {
    return []
  }
}

export async function saveBackends(list: SavedBackend[]): Promise<void> {
  await write(KEY, JSON.stringify(list))
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function labelFor(wsUrl: string): string {
  const host = wsUrl.replace(/^wss?:\/\//, '').split('/')[0]
  return host || 'Backend'
}
