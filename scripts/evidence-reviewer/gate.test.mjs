import { describe, expect, it } from 'vitest'
import { MARKER, RERUN_LABEL, canWrite, isSameRepo, rerunRejection, rerunTicked, touchesUi } from './gate.mjs'

const body = (mark) => `${MARKER}\n## Evidence\n\nstuff\n\n- [${mark}] ${RERUN_LABEL}\n\n<sub>footer</sub>`

const event = (over = {}) => ({
  issue: { number: 7, pull_request: { url: 'x' } },
  comment: { user: { login: 'github-actions[bot]' }, body: body('x') },
  changes: { body: { from: body(' ') } },
  sender: { login: 'mike', type: 'User' },
  ...over
})
const writer = { permission: 'write', role_name: 'write' }

describe('rerunTicked', () => {
  it('fires on unchecked → checked', () => {
    expect(rerunTicked(body(' '), body('x'))).toBe(true)
    expect(rerunTicked(body(' '), body('X'))).toBe(true)
  })
  it('ignores unticking, no-op edits, and missing boxes', () => {
    expect(rerunTicked(body('x'), body(' '))).toBe(false)
    expect(rerunTicked(body('x'), body('x'))).toBe(false)
    expect(rerunTicked(body(' '), body(' '))).toBe(false)
    expect(rerunTicked(undefined, body('x'))).toBe(false)
    expect(rerunTicked(body(' '), `${MARKER}\nno box`)).toBe(false)
  })
  it('only matches the re-run line, not other task items', () => {
    const other = (m) => `${MARKER}\n- [${m}] something else\n- [ ] ${RERUN_LABEL}`
    expect(rerunTicked(other(' '), other('x'))).toBe(false)
  })
})

describe('rerunRejection', () => {
  it('accepts a writer ticking the box on the bot comment', () => {
    expect(rerunRejection(event(), writer)).toBeNull()
  })
  it('rejects non-PR issues', () => {
    expect(rerunRejection(event({ issue: { number: 7 } }), writer)).toMatch(/pull request/)
  })
  it('rejects comments not authored by the bot or missing the marker', () => {
    expect(rerunRejection(event({ comment: { user: { login: 'mallory' }, body: body('x') } }), writer)).toMatch(/evidence/)
    expect(
      rerunRejection(event({ comment: { user: { login: 'github-actions[bot]' }, body: `hi\n- [x] ${RERUN_LABEL}` } }), writer)
    ).toMatch(/evidence/)
  })
  it('rejects bot senders', () => {
    expect(rerunRejection(event({ sender: { login: 'github-actions[bot]', type: 'Bot' } }), writer)).toMatch(/bot/)
  })
  it('rejects edits that did not tick the box', () => {
    expect(rerunRejection(event({ changes: { body: { from: body('x') } } }), writer)).toMatch(/ticked/)
    expect(rerunRejection(event({ changes: {} }), writer)).toMatch(/ticked/)
  })
  it('rejects senders without write access', () => {
    expect(rerunRejection(event(), { permission: 'read', role_name: 'triage' })).toMatch(/permission/)
    expect(rerunRejection(event(), null)).toMatch(/permission/)
  })
})

describe('canWrite', () => {
  it('accepts admin, maintain and write', () => {
    expect(canWrite({ permission: 'admin', role_name: 'admin' })).toBe(true)
    expect(canWrite({ permission: 'write', role_name: 'maintain' })).toBe(true)
    expect(canWrite(writer)).toBe(true)
    expect(canWrite({ permission: 'read', role_name: 'read' })).toBe(false)
  })
})

describe('touchesUi', () => {
  it('needs a file under a UI path', () => {
    expect(touchesUi(['src/renderer/App.tsx', 'README.md'])).toBe(true)
    expect(touchesUi(['src/web-client/main.ts'])).toBe(true)
    expect(touchesUi(['.github/workflows/ci.yml', 'scripts/release.sh', 'src/main/index.ts'])).toBe(false)
    expect(touchesUi(['src/rendererish.ts'])).toBe(false)
    expect(touchesUi([])).toBe(false)
  })
})

describe('isSameRepo', () => {
  it('is true only when the head lives in this repo', () => {
    expect(isSameRepo({ head: { repo: { full_name: 'ness-dev/ness' } } }, 'ness-dev/ness')).toBe(true)
    expect(isSameRepo({ head: { repo: { full_name: 'someone/ness' } } }, 'ness-dev/ness')).toBe(false)
  })
  it('treats a deleted fork (null head repo) as a fork', () => {
    expect(isSameRepo({ head: { repo: null } }, 'ness-dev/ness')).toBe(false)
  })
})
