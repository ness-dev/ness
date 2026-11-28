// The demo as a backend: a NessClient over DemoTransport, plus whether the
// user has it switched on. Kept apart from the saved backends list, so the
// demo can never be written into (or overwrite) a real backend's entry.
import { NessClient } from '../ness'
import { read, write } from '../storage'
import { DemoTransport } from './DemoTransport'
import type { DemoTheme } from './world'
import { DEMO_BACKEND_ID, DEMO_LABEL } from './constants'

const KEY = 'ness.demo'

export function createDemoClient(theme?: DemoTheme): NessClient {
  return new NessClient(DEMO_BACKEND_ID, DEMO_LABEL, 'demo://acme-weather', '', (callbacks) => new DemoTransport(callbacks, { theme }), true)
}

/** The demo's current theme, to carry across a reset. */
export function demoThemeOf(client: NessClient | undefined): DemoTheme | undefined {
  if (!client?.getConn().hasSnapshot) return undefined
  const { themeMode, themeLight, themeDark } = client.getState().settings
  return { mode: themeMode, light: themeLight, dark: themeDark }
}

export async function loadDemoEnabled(): Promise<boolean> {
  return (await read(KEY).catch(() => null)) === '1'
}

export async function saveDemoEnabled(on: boolean): Promise<void> {
  await write(KEY, on ? '1' : null)
}
