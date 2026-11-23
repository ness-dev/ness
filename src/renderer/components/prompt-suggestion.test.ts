import { describe, it, expect } from 'vitest'
import { isPromptSuggestionAcceptKey, offeredPromptSuggestion } from './prompt-suggestion'

const base = {
  suggestion: 'show me the code',
  enabled: true,
  asleep: false,
  busy: false,
  draft: '',
  attachmentCount: 0,
  pendingApprovalCount: 0,
  mentionPopoverOpen: false
}

describe('offeredPromptSuggestion', () => {
  it('offers the suggestion in an empty composer on an idle session', () => {
    expect(offeredPromptSuggestion(base)).toBe('show me the code')
  })

  it.each([
    ['no suggestion', { suggestion: undefined }],
    ['setting off', { enabled: false }],
    ['asleep', { asleep: true }],
    ['busy', { busy: true }],
    ['a draft', { draft: 'h' }],
    ['a whitespace draft', { draft: ' ' }],
    ['an attachment', { attachmentCount: 1 }],
    ['a pending approval', { pendingApprovalCount: 1 }],
    ['the mention popover open', { mentionPopoverOpen: true }]
  ])('withholds it with %s', (_label, patch) => {
    expect(offeredPromptSuggestion({ ...base, ...patch })).toBeUndefined()
  })
})

describe('isPromptSuggestionAcceptKey', () => {
  const plain = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }

  it('accepts on plain Tab and Right Arrow', () => {
    expect(isPromptSuggestionAcceptKey({ ...plain, key: 'Tab' })).toBe(true)
    expect(isPromptSuggestionAcceptKey({ ...plain, key: 'ArrowRight' })).toBe(true)
  })

  it('ignores other keys', () => {
    expect(isPromptSuggestionAcceptKey({ ...plain, key: 'Enter' })).toBe(false)
    expect(isPromptSuggestionAcceptKey({ ...plain, key: 'a' })).toBe(false)
  })

  it.each(['shiftKey', 'metaKey', 'ctrlKey', 'altKey'] as const)(
    'leaves %s-modified keys alone',
    (mod) => {
      expect(isPromptSuggestionAcceptKey({ ...plain, [mod]: true, key: 'Tab' })).toBe(false)
    }
  )
})
