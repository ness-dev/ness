// Phone-only preferences set from the Settings screen. Per-device, so
// AsyncStorage (like collapse.ts and navState.ts), never a server slice.
// A tiny external store so the picker picks up a change made in Settings
// without a reload.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'

const K_PICKER_TABS = 'ness.mobile.pickerTabs'

let pickerTabs = false
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())
let touched = false

void AsyncStorage.getItem(K_PICKER_TABS)
  .then((v) => {
    // A toggle flipped before the read landed wins.
    if (touched) return
    pickerTabs = v === '1'
    emit()
  })
  .catch(() => {})

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Experimental: list each worktree's tabs under it in the picker. Off by default. */
export function usePickerTabs(): boolean {
  return useSyncExternalStore(subscribe, () => pickerTabs)
}

export function setPickerTabs(on: boolean): void {
  touched = true
  if (pickerTabs === on) return
  pickerTabs = on
  emit()
  void AsyncStorage.setItem(K_PICKER_TABS, on ? '1' : '0')
}
