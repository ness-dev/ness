import { describe, expect, it } from 'vitest'
import { closeTabConfirmReason } from './close-tab-guard'

describe('closeTabConfirmReason', () => {
  it('closes an idle tab without confirmation', () => {
    expect(closeTabConfirmReason('idle', undefined)).toBeNull()
    expect(closeTabConfirmReason(undefined, { active: false, processName: '' })).toBeNull()
  })

  it('confirms each busy agent status', () => {
    expect(closeTabConfirmReason('processing', undefined)).toBe('still working')
    expect(closeTabConfirmReason('waiting', undefined)).toBe('waiting for your input')
    expect(closeTabConfirmReason('needs-approval', undefined)).toBe('waiting for your approval')
  })

  it('confirms a shell with a live process, ahead of any agent status', () => {
    expect(closeTabConfirmReason('idle', { active: true, processName: 'npm' })).toBe(
      'running a process'
    )
  })
})
