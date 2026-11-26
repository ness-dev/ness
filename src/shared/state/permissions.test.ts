import { describe, it, expect } from 'vitest'
import {
  initialPermissions,
  permissionsReducer,
  type PermissionsEvent,
  type StoredPermissionRule
} from './permissions'

function apply(
  state = initialPermissions,
  ...events: PermissionsEvent[]
): typeof initialPermissions {
  return events.reduce(permissionsReducer, state)
}

function rule(
  toolName: string,
  ruleContent?: string,
  overrides: Partial<StoredPermissionRule> = {}
): StoredPermissionRule {
  return {
    id: ruleContent ? `${toolName}(${ruleContent})` : toolName,
    toolName,
    ...(ruleContent ? { ruleContent } : {}),
    grantedAt: 1000,
    ...overrides
  }
}

describe('permissionsReducer', () => {
  it('starts empty', () => {
    expect(initialPermissions.rules).toEqual([])
  })

  it('loaded replaces the whole list', () => {
    const seeded = apply(initialPermissions, {
      type: 'permissions/granted',
      payload: { rule: rule('Read') }
    })
    const next = apply(seeded, {
      type: 'permissions/loaded',
      payload: { rules: [rule('Bash', 'ls:*')] }
    })
    expect(next.rules.map((r) => r.id)).toEqual(['Bash(ls:*)'])
  })

  it('granted appends in insertion order', () => {
    const next = apply(
      initialPermissions,
      { type: 'permissions/granted', payload: { rule: rule('Read') } },
      { type: 'permissions/granted', payload: { rule: rule('Bash', 'ls:*') } }
    )
    expect(next.rules.map((r) => r.id)).toEqual(['Read', 'Bash(ls:*)'])
  })

  it('granted dedups by rule shape, not by id', () => {
    // The approval card can't know whether a grant already exists, so a
    // repeat click must not stack a second identical row.
    const next = apply(
      initialPermissions,
      { type: 'permissions/granted', payload: { rule: rule('Bash', 'ls:*') } },
      {
        type: 'permissions/granted',
        payload: {
          rule: rule('Bash', 'ls:*', { id: 'different-id', grantedAt: 9999 })
        }
      }
    )
    expect(next.rules).toHaveLength(1)
    expect(next.rules[0].grantedAt).toBe(1000)
  })

  it('granted treats a bare rule and a scoped rule as distinct', () => {
    const next = apply(
      initialPermissions,
      { type: 'permissions/granted', payload: { rule: rule('Bash') } },
      { type: 'permissions/granted', payload: { rule: rule('Bash', 'ls:*') } }
    )
    expect(next.rules.map((r) => r.id)).toEqual(['Bash', 'Bash(ls:*)'])
  })

  it('granted returns the same object on a duplicate', () => {
    // Reference identity matters: a re-grant that allocated a new array
    // would re-run every useSyncExternalStore selector reading the slice.
    const seeded = apply(initialPermissions, {
      type: 'permissions/granted',
      payload: { rule: rule('Read') }
    })
    const again = permissionsReducer(seeded, {
      type: 'permissions/granted',
      payload: { rule: rule('Read') }
    })
    expect(again).toBe(seeded)
  })

  it('revoked drops just the matching id', () => {
    const seeded = apply(
      initialPermissions,
      { type: 'permissions/granted', payload: { rule: rule('Read') } },
      { type: 'permissions/granted', payload: { rule: rule('Bash', 'ls:*') } },
      { type: 'permissions/granted', payload: { rule: rule('Write') } }
    )
    const next = apply(seeded, {
      type: 'permissions/revoked',
      payload: { id: 'Bash(ls:*)' }
    })
    expect(next.rules.map((r) => r.id)).toEqual(['Read', 'Write'])
  })

  it('revoked on an unknown id returns the same object', () => {
    const seeded = apply(initialPermissions, {
      type: 'permissions/granted',
      payload: { rule: rule('Read') }
    })
    expect(
      permissionsReducer(seeded, {
        type: 'permissions/revoked',
        payload: { id: 'nope' }
      })
    ).toBe(seeded)
  })

  it('revokedMany drops every listed id and keeps the rest in order', () => {
    const keep = rule('Write')
    const seeded = apply(
      initialPermissions,
      { type: 'permissions/granted', payload: { rule: rule('Read') } },
      { type: 'permissions/granted', payload: { rule: keep } },
      { type: 'permissions/granted', payload: { rule: rule('Bash', 'ls:*') } }
    )
    const next = apply(seeded, {
      type: 'permissions/revokedMany',
      payload: { ids: ['Read', 'Bash(ls:*)', 'nope'] }
    })
    expect(next.rules).toEqual([keep])
    expect(next.rules[0]).toBe(keep)
  })

  it('revokedMany with no matching ids returns the same object', () => {
    const seeded = apply(initialPermissions, {
      type: 'permissions/granted',
      payload: { rule: rule('Read') }
    })
    expect(
      permissionsReducer(seeded, { type: 'permissions/revokedMany', payload: { ids: ['nope'] } })
    ).toBe(seeded)
  })

  it('revoked preserves the identity of untouched entries', () => {
    const keep = rule('Read')
    const seeded = apply(
      initialPermissions,
      { type: 'permissions/granted', payload: { rule: keep } },
      { type: 'permissions/granted', payload: { rule: rule('Write') } }
    )
    const next = apply(seeded, {
      type: 'permissions/revoked',
      payload: { id: 'Write' }
    })
    expect(next.rules[0]).toBe(seeded.rules[0])
  })

  it('cleared empties the list', () => {
    const seeded = apply(initialPermissions, {
      type: 'permissions/granted',
      payload: { rule: rule('Read') }
    })
    expect(apply(seeded, { type: 'permissions/cleared' }).rules).toEqual([])
  })

  it('cleared on an already-empty list returns the same object', () => {
    expect(
      permissionsReducer(initialPermissions, { type: 'permissions/cleared' })
    ).toBe(initialPermissions)
  })

  it('setupCommandApproved records the command per repo and replaces it', () => {
    const a = apply(initialPermissions, {
      type: 'permissions/setupCommandApproved',
      payload: { repoRoot: '/r', command: 'npm install' }
    })
    expect(a.approvedSetupCommands).toEqual({ '/r': 'npm install' })
    const b = apply(a, {
      type: 'permissions/setupCommandApproved',
      payload: { repoRoot: '/r', command: 'npm ci' }
    })
    expect(b.approvedSetupCommands).toEqual({ '/r': 'npm ci' })
    expect(
      permissionsReducer(b, {
        type: 'permissions/setupCommandApproved',
        payload: { repoRoot: '/r', command: 'npm ci' }
      })
    ).toBe(b)
  })

  it('cleared removes grants but keeps approved setup commands', () => {
    const seeded = apply(
      initialPermissions,
      { type: 'permissions/granted', payload: { rule: rule('Read') } },
      {
        type: 'permissions/setupCommandApproved',
        payload: { repoRoot: '/r', command: 'npm install' }
      }
    )
    const cleared = apply(seeded, { type: 'permissions/cleared' })
    expect(cleared.rules).toEqual([])
    expect(cleared.approvedSetupCommands).toEqual({ '/r': 'npm install' })
  })

  it('setupCommandForgotten drops one repo and ignores unknown ones', () => {
    const seeded = apply(initialPermissions, {
      type: 'permissions/setupCommandApproved',
      payload: { repoRoot: '/r', command: 'npm install' }
    })
    expect(
      apply(seeded, { type: 'permissions/setupCommandForgotten', payload: { repoRoot: '/r' } })
        .approvedSetupCommands
    ).toEqual({})
    expect(
      permissionsReducer(seeded, {
        type: 'permissions/setupCommandForgotten',
        payload: { repoRoot: '/other' }
      })
    ).toBe(seeded)
  })
})
