import { describe, it, expect } from 'vitest'
import { normalizeRemoteUrl } from './git-remote'

describe('normalizeRemoteUrl', () => {
  it('treats the common spellings of one repo as the same identity', () => {
    const forms = [
      'git@github.com:Org/Repo.git',
      'ssh://git@github.com/org/repo',
      'https://github.com/org/repo.git',
      'https://github.com/org/repo/',
      'https://token@github.com/org/repo.git',
      'ssh://git@github.com:22/org/repo.git'
    ]
    for (const f of forms) expect(normalizeRemoteUrl(f)).toBe('github.com/org/repo')
  })

  it('keeps forks distinct from upstream', () => {
    expect(normalizeRemoteUrl('git@github.com:you/ness.git')).not.toBe(
      normalizeRemoteUrl('git@github.com:ness-dev/ness.git')
    )
  })

  it('keeps nested group paths (GitLab-style) intact', () => {
    expect(normalizeRemoteUrl('git@gitlab.com:group/sub/repo.git')).toBe('gitlab.com/group/sub/repo')
  })

  it('returns null for inputs with no cross-machine identity', () => {
    expect(normalizeRemoteUrl(null)).toBeNull()
    expect(normalizeRemoteUrl('')).toBeNull()
    expect(normalizeRemoteUrl('   ')).toBeNull()
    expect(normalizeRemoteUrl('/Users/mike/local-only')).toBeNull()
  })
})
