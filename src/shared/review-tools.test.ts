import { describe, it, expect } from 'vitest'
import { isReviewTool } from './review-tools'

describe('isReviewTool', () => {
  it('matches the review tools bare or MCP-prefixed', () => {
    for (const name of [
      'list_review_comments',
      'add_review_comment',
      'reply_to_comment',
      'resolve_comment',
      'submit_review',
      'request_review',
      'list_tabs'
    ]) {
      expect(isReviewTool(name), name).toBe(true)
      expect(isReviewTool(`mcp__ness-control__${name}`), name).toBe(true)
    }
  })

  it('matches nothing else', () => {
    expect(isReviewTool('Bash')).toBe(false)
    expect(isReviewTool('Edit')).toBe(false)
    expect(isReviewTool('mcp__ness-control__create_worktree')).toBe(false)
    expect(isReviewTool('review')).toBe(false)
  })
})
