import { describe, it, expect } from 'vitest'
import { checkReviewerTool, isReviewTool } from './review-readonly'

const allowed = (tool: string, input: Record<string, unknown> = {}): boolean =>
  checkReviewerTool(tool, input).allowed

const bash = (command: string): boolean => allowed('Bash', { command })

describe('checkReviewerTool', () => {
  it('blocks the file-writing tools', () => {
    for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) {
      expect(allowed(tool, { file_path: '/x' })).toBe(false)
    }
    const verdict = checkReviewerTool('Edit', {})
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/add_review_comment/)
  })

  it('allows reading and searching', () => {
    expect(allowed('Read', { file_path: '/x' })).toBe(true)
    expect(allowed('Grep', { pattern: 'x' })).toBe(true)
    expect(allowed('Glob', {})).toBe(true)
    expect(bash('git diff main...HEAD')).toBe(true)
    expect(bash('git show HEAD:src/a.ts | head -50')).toBe(true)
    expect(bash('rg "addReviewComment" src')).toBe(true)
    expect(bash('cat package.json')).toBe(true)
    expect(bash('npm test')).toBe(true)
  })

  it('allows the review tools themselves, including MCP-prefixed', () => {
    expect(allowed('mcp__ness-control__add_review_comment', {})).toBe(true)
    expect(allowed('mcp__ness-control__submit_review', {})).toBe(true)
    expect(allowed('list_review_comments', {})).toBe(true)
  })

  it('blocks shell commands that change the repo or the working tree', () => {
    for (const cmd of [
      'git commit -m wip',
      'git push origin HEAD',
      'git checkout -- src/a.ts',
      'git reset --hard',
      'git stash',
      'rm -rf build',
      'mv a.ts b.ts',
      'mkdir out',
      'chmod +x run.sh',
      'sed -i "" s/a/b/ a.ts',
      'echo hi > notes.txt',
      'cat a.ts >> b.ts',
      'npm install left-pad',
      'gh pr comment 1 --body x',
      'sudo rm /etc/hosts',
      'curl -X POST https://example.com'
    ]) {
      expect(bash(cmd), cmd).toBe(false)
    }
  })

  it('catches a mutation hidden later in a chain', () => {
    expect(bash('git diff && git commit -am wip')).toBe(false)
    expect(bash('cat a.ts | tee b.ts')).toBe(false)
  })

})

describe('isReviewTool', () => {
  it('matches the review tools bare or MCP-prefixed, and nothing else', () => {
    expect(isReviewTool('submit_review')).toBe(true)
    expect(isReviewTool('mcp__ness-control__list_review_comments')).toBe(true)
    expect(isReviewTool('mcp__ness-control__request_review')).toBe(true)
    expect(isReviewTool('Bash')).toBe(false)
    expect(isReviewTool('mcp__other__create_worktree')).toBe(false)
  })
})
