import { describe, expect, it } from 'vitest'
import { hostOf, waitingView, type ConnState } from '../src/ness'

describe('hostOf', () => {
  it.each([
    ['ws://192.168.1.234:37292/', '192.168.1.234'],
    ['ws://[::1]:3000/', '[::1]'],
    ['ws://mac.local/', 'mac.local'],
    ['wss://ness.example.com/some/path?x=1', 'ness.example.com'],
    ['wss://ness.example.com:8443/ws', 'ness.example.com']
  ])('%s → %s', (url, host) => {
    expect(hostOf(url)).toBe(host)
  })
})

const connecting: ConnState = { connected: false, hasSnapshot: false }
const failed: ConnState = { connected: false, hasSnapshot: false, error: 'connection timed out' }
const handshaking: ConnState = { connected: true, hasSnapshot: false }
const ready: ConnState = { connected: true, hasSnapshot: true }
const droppedAfterSnapshot: ConnState = { connected: false, hasSnapshot: true, error: 'close code 1006' }

describe('waitingView', () => {
  it('no enabled backends', () => {
    expect(waitingView([])).toEqual({ kind: 'none-enabled' })
  })
  it('still on a first attempt → connecting', () => {
    expect(waitingView([connecting])).toEqual({ kind: 'connecting', pending: [0] })
    expect(waitingView([handshaking])).toEqual({ kind: 'connecting', pending: [0] })
  })
  it('connecting while any waiting backend is still trying', () => {
    expect(waitingView([failed, connecting])).toEqual({ kind: 'connecting', pending: [1] })
  })
  it('unreachable once every waiting backend has failed', () => {
    expect(waitingView([failed])).toEqual({ kind: 'unreachable', failed: [0] })
    expect(waitingView([failed, failed])).toEqual({ kind: 'unreachable', failed: [0, 1] })
  })
  it('backends with a snapshot do not count, even if since dropped', () => {
    expect(waitingView([ready, failed])).toEqual({ kind: 'unreachable', failed: [1] })
    expect(waitingView([droppedAfterSnapshot, failed])).toEqual({ kind: 'unreachable', failed: [1] })
  })
  it('all snapshotted → all-connected', () => {
    expect(waitingView([ready, droppedAfterSnapshot])).toEqual({ kind: 'all-connected' })
  })
})
