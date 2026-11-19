import { describe, it, expect } from 'vitest'
import { applyConnectionDefaults, applyFirstLaunchDefault, LOCAL_BACKEND_ID, type Config } from './persistence'

function bareConfig(): Config {
  return {
    schemaVersion: 5,
    windowBounds: null,
    repoRoots: []
  }
}

describe('applyConnectionDefaults', () => {
  it('seeds a single Local backend when connections is missing', () => {
    const out = applyConnectionDefaults(bareConfig(), 1700000000000)
    expect(out.connections).toEqual([
      {
        id: LOCAL_BACKEND_ID,
        label: 'Local',
        url: '',
        kind: 'local',
        addedAt: 1700000000000
      }
    ])
  })

  it('seeds Local when connections is an empty array', () => {
    const out = applyConnectionDefaults({ ...bareConfig(), connections: [] })
    expect(out.connections).toHaveLength(1)
    expect(out.connections?.[0].kind).toBe('local')
  })

  it('defaults activeBackendId to LOCAL_BACKEND_ID', () => {
    const out = applyConnectionDefaults(bareConfig())
    expect(out.activeBackendId).toBe(LOCAL_BACKEND_ID)
  })

  it('preserves existing connections', () => {
    const existing: Config = {
      ...bareConfig(),
      connections: [
        { id: 'local', label: 'Local', url: '', kind: 'local', addedAt: 1 },
        { id: 'abc', label: 'Build box', url: 'build-box.local:37291/', kind: 'remote', addedAt: 2 }
      ]
    }
    const out = applyConnectionDefaults(existing)
    expect(out.connections).toBe(existing.connections)
  })

  it('preserves an existing activeBackendId', () => {
    const out = applyConnectionDefaults({
      ...bareConfig(),
      connections: [
        { id: 'local', label: 'Local', url: '', kind: 'local', addedAt: 1 },
        { id: 'abc', label: 'Build box', url: 'build-box.local:37291/', kind: 'remote', addedAt: 2 }
      ],
      activeBackendId: 'abc'
    })
    expect(out.activeBackendId).toBe('abc')
  })

  it('does not mutate the input config', () => {
    const input = bareConfig()
    const before = JSON.stringify(input)
    applyConnectionDefaults(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('applyFirstLaunchDefault', () => {
  it('stamps now on a fresh install', () => {
    expect(applyFirstLaunchDefault(bareConfig(), false, 1700000000000).firstLaunchAt).toBe(
      1700000000000
    )
  })

  it('stamps 0 on an existing install that predates the field', () => {
    expect(applyFirstLaunchDefault(bareConfig(), true, 1700000000000).firstLaunchAt).toBe(0)
  })

  it('never overwrites an existing value', () => {
    const cfg = { ...bareConfig(), firstLaunchAt: 1600000000000 }
    expect(applyFirstLaunchDefault(cfg, false, 1700000000000)).toBe(cfg)
    expect(applyFirstLaunchDefault(cfg, true, 1700000000000)).toBe(cfg)
  })
})
