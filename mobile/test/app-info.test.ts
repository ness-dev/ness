import { describe, expect, it } from 'vitest'
import {
  formatAgo,
  formatStamp,
  launchSource,
  runtimeLabel,
  shortId,
  updateAction,
  updatePhase,
  updateStatusText,
  versionLabel,
  type UpdatesSnapshot
} from '../src/app-info'

// A release build at rest: expo-updates on, nothing in flight.
const idle: UpdatesSnapshot = {
  isEnabled: true,
  isChecking: false,
  isDownloading: false,
  isRestarting: false,
  isUpdateAvailable: false,
  isUpdatePending: false
}

describe('updatePhase', () => {
  it('is disabled in a dev build regardless of anything else', () => {
    expect(updatePhase({ ...idle, isEnabled: false, isUpdateAvailable: true }, true)).toEqual({ kind: 'disabled' })
  })

  it('separates never-checked from checked-and-current', () => {
    expect(updatePhase(idle, false).kind).toBe('idle')
    expect(updatePhase(idle, true).kind).toBe('upToDate')
  })

  it('reports checking', () => {
    expect(updatePhase({ ...idle, isChecking: true }, false).kind).toBe('checking')
  })

  it('reports an available update with its publish time', () => {
    const createdAt = new Date('2026-11-27T10:00:00Z')
    expect(updatePhase({ ...idle, isUpdateAvailable: true, availableUpdate: { type: 'new', createdAt } }, true)).toEqual({
      kind: 'available',
      createdAt,
      rollback: false
    })
  })

  it('flags a rollback directive', () => {
    const p = updatePhase({ ...idle, isUpdateAvailable: true, availableUpdate: { type: 'rollback' } }, true)
    expect(p).toMatchObject({ kind: 'available', rollback: true })
  })

  it('downloading outranks the availability that led to it', () => {
    expect(updatePhase({ ...idle, isUpdateAvailable: true, isDownloading: true }, true).kind).toBe('downloading')
  })

  it('a downloaded update outranks a later check error', () => {
    expect(updatePhase({ ...idle, isUpdatePending: true, checkError: new Error('offline') }, true).kind).toBe('ready')
  })

  it('restarting outranks everything once enabled', () => {
    expect(updatePhase({ ...idle, isUpdatePending: true, isRestarting: true }, true).kind).toBe('restarting')
  })

  it('reports check and download errors separately', () => {
    expect(updatePhase({ ...idle, checkError: new Error('offline') }, false)).toEqual({ kind: 'error', during: 'check', message: 'offline' })
    expect(updatePhase({ ...idle, isUpdateAvailable: true, downloadError: new Error('500') }, true)).toEqual({
      kind: 'error',
      during: 'download',
      message: '500'
    })
  })

  it('a new check in flight hides the previous check error', () => {
    expect(updatePhase({ ...idle, isChecking: true, checkError: new Error('offline') }, true).kind).toBe('checking')
  })

  it('names an error with no message', () => {
    expect(updatePhase({ ...idle, checkError: new Error('') }, false)).toMatchObject({ message: 'Error' })
  })
})

describe('updateAction', () => {
  it('offers the next step for each phase', () => {
    expect(updateAction({ kind: 'idle' })).toEqual({ label: 'Check for update', action: 'check' })
    expect(updateAction({ kind: 'upToDate' })).toEqual({ label: 'Check for update', action: 'check' })
    expect(updateAction({ kind: 'available', rollback: false })).toEqual({ label: 'Download & restart', action: 'download' })
    expect(updateAction({ kind: 'ready' })).toEqual({ label: 'Restart to update', action: 'restart' })
    expect(updateAction({ kind: 'error', during: 'check', message: 'x' })?.action).toBe('check')
    expect(updateAction({ kind: 'error', during: 'download', message: 'x' })?.action).toBe('download')
  })

  it('offers nothing while busy or disabled', () => {
    for (const kind of ['disabled', 'checking', 'downloading', 'restarting'] as const) {
      expect(updateAction({ kind })).toBeNull()
    }
  })
})

describe('updateStatusText', () => {
  const now = new Date('2026-11-27T12:00:00')
  it('describes the dev build', () => {
    expect(updateStatusText({ kind: 'disabled' })).toBe('Development build — updates disabled')
  })
  it('includes when an available update was published', () => {
    expect(updateStatusText({ kind: 'available', rollback: false, createdAt: new Date('2026-11-27T11:00:00') }, now)).toBe(
      'Update available (published 1 h ago)'
    )
    expect(updateStatusText({ kind: 'available', rollback: false }, now)).toBe('Update available')
  })
  it('prefixes errors with the step that failed', () => {
    expect(updateStatusText({ kind: 'error', during: 'download', message: 'timeout' })).toBe('Download failed: timeout')
  })
})

describe('launchSource', () => {
  const base = { isEnabled: true, isEmbeddedLaunch: false, isEmergencyLaunch: false }
  it('distinguishes embedded, OTA, emergency and dev', () => {
    expect(launchSource({ ...base, isEmbeddedLaunch: true })).toBe('Embedded bundle')
    expect(launchSource(base)).toBe('OTA update')
    expect(launchSource({ ...base, isEmbeddedLaunch: true, isEmergencyLaunch: true, emergencyLaunchReason: 'bad update' })).toBe(
      'Embedded (emergency: bad update)'
    )
    expect(launchSource({ ...base, isEnabled: false, isEmbeddedLaunch: true })).toBe('Dev server')
  })
})

describe('formatting', () => {
  it('shortId', () => {
    expect(shortId('48355910-abcd-4ef0-9876-543210fedcba')).toBe('48355910')
    expect(shortId(null)).toBe('—')
  })

  it('versionLabel', () => {
    expect(versionLabel('1.0.0', '7')).toBe('1.0.0 (7)')
    expect(versionLabel('1.0.0', null)).toBe('1.0.0')
    expect(versionLabel(undefined, '7')).toBe('build 7')
    expect(versionLabel(null, null)).toBe('—')
  })

  it('runtimeLabel shortens a fingerprint hash only', () => {
    expect(runtimeLabel('091e3af6c78ab007ca3e6b54b17bb49505f234df')).toBe('091e3af6c7')
    expect(runtimeLabel('1.0.0')).toBe('1.0.0')
    expect(runtimeLabel(null)).toBe('—')
  })

  it('formatStamp', () => {
    expect(formatStamp(new Date(2026, 10, 7, 9, 5))).toBe('2026-11-07 09:05')
    expect(formatStamp(null)).toBe('—')
    expect(formatStamp(new Date('nope'))).toBe('—')
  })

  it('formatAgo', () => {
    const now = new Date(2026, 10, 27, 12, 0, 0)
    expect(formatAgo(new Date(2026, 10, 27, 11, 59, 30), now)).toBe('just now')
    expect(formatAgo(new Date(2026, 10, 27, 11, 55), now)).toBe('5 min ago')
    expect(formatAgo(new Date(2026, 10, 27, 9, 0), now)).toBe('3 h ago')
    expect(formatAgo(new Date(2026, 10, 25, 9, 0), now)).toBe('2026-11-25 09:00')
  })
})
