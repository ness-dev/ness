// Pure formatting + state logic behind the Settings screen (About and
// Updates). Takes plain values rather than importing expo-updates /
// expo-constants, so it runs under the Node unit tests; the screen reads
// the native modules and passes their values in.

/** The subset of expo-updates' useUpdates() result the screen acts on. */
export interface UpdatesSnapshot {
  isEnabled: boolean
  isChecking: boolean
  isDownloading: boolean
  isRestarting: boolean
  isUpdateAvailable: boolean
  isUpdatePending: boolean
  availableUpdate?: { type: string; createdAt?: Date; updateId?: string }
  checkError?: Error
  downloadError?: Error
}

export type UpdatePhase =
  | { kind: 'disabled' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available'; createdAt?: Date; rollback: boolean }
  | { kind: 'downloading' }
  | { kind: 'ready' }
  | { kind: 'restarting' }
  | { kind: 'error'; during: 'check' | 'download'; message: string }

/** One phase for the screen, most-advanced first: a download in flight
 *  outranks the (stale) availability flag that led to it, and a pending
 *  download outranks a later check's error. `checked` is whether a check
 *  has finished since launch, which is the only thing that separates
 *  "up to date" from "never asked". */
export function updatePhase(u: UpdatesSnapshot, checked: boolean): UpdatePhase {
  if (!u.isEnabled) return { kind: 'disabled' }
  if (u.isRestarting) return { kind: 'restarting' }
  if (u.isDownloading) return { kind: 'downloading' }
  if (u.isUpdatePending) return { kind: 'ready' }
  if (u.downloadError) return { kind: 'error', during: 'download', message: errorText(u.downloadError) }
  if (u.isChecking) return { kind: 'checking' }
  if (u.checkError) return { kind: 'error', during: 'check', message: errorText(u.checkError) }
  if (u.isUpdateAvailable) {
    return { kind: 'available', createdAt: u.availableUpdate?.createdAt, rollback: u.availableUpdate?.type === 'rollback' }
  }
  return checked ? { kind: 'upToDate' } : { kind: 'idle' }
}

/** The primary button for a phase: what it says and what it does, or null
 *  when there's nothing to press (busy, or updates are off). */
export function updateAction(p: UpdatePhase): { label: string; action: 'check' | 'download' | 'restart' } | null {
  switch (p.kind) {
    case 'idle':
    case 'upToDate':
      return { label: 'Check for update', action: 'check' }
    case 'available':
      return { label: 'Download & restart', action: 'download' }
    case 'ready':
      return { label: 'Restart to update', action: 'restart' }
    case 'error':
      return p.during === 'download' ? { label: 'Retry download', action: 'download' } : { label: 'Check again', action: 'check' }
    default:
      return null
  }
}

export function updateStatusText(p: UpdatePhase, now: Date = new Date()): string {
  switch (p.kind) {
    case 'disabled':
      return 'Development build — updates disabled'
    case 'idle':
      return 'Not checked yet'
    case 'checking':
      return 'Checking…'
    case 'upToDate':
      return 'Up to date'
    case 'available':
      if (p.rollback) return 'Rollback to the embedded bundle available'
      return p.createdAt ? `Update available (published ${formatAgo(p.createdAt, now)})` : 'Update available'
    case 'downloading':
      return 'Downloading…'
    case 'ready':
      return 'Downloaded — restart to apply'
    case 'restarting':
      return 'Restarting…'
    case 'error':
      return `${p.during === 'check' ? 'Check' : 'Download'} failed: ${p.message}`
  }
}

function errorText(e: Error): string {
  return (e.message || String(e)).trim() || 'unknown error'
}

/** Which bundle this launch is running. */
export function launchSource(info: { isEnabled: boolean; isEmbeddedLaunch: boolean; isEmergencyLaunch: boolean; emergencyLaunchReason?: string | null }): string {
  if (!info.isEnabled) return 'Dev server'
  if (info.isEmergencyLaunch) return `Embedded (emergency${info.emergencyLaunchReason ? `: ${info.emergencyLaunchReason}` : ''})`
  return info.isEmbeddedLaunch ? 'Embedded bundle' : 'OTA update'
}

/** Update ids and git commits are long hex/UUIDs; the first 8 is enough to
 *  tell two apart on screen (the full value is what gets copied). */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—'
}

/** "1.0.0 (42)", or whichever half is known. */
export function versionLabel(version: string | null | undefined, build: string | null | undefined): string {
  if (version && build) return `${version} (${build})`
  return version || (build ? `build ${build}` : '—')
}

/** The fingerprint policy's runtime version is a 40-char hash; show the
 *  head of it like a commit. Other policies ("1.0.0") pass through. */
export function runtimeLabel(rv: string | null | undefined): string {
  if (!rv) return '—'
  return /^[0-9a-f]{40}$/.test(rv) ? rv.slice(0, 10) : rv
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local "2026-11-27 14:03" — unambiguous, and short enough for one row. */
export function formatStamp(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "just now" / "5 min ago" / "3 h ago", falling back to the stamp past a day. */
export function formatAgo(d: Date, now: Date = new Date()): string {
  const s = Math.round((now.getTime() - d.getTime()) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return formatStamp(d)
}
