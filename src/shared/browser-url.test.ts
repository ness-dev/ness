import { describe, it, expect } from 'vitest'
import { normalizeBrowserUrl } from './browser-url'

describe('normalizeBrowserUrl', () => {
  it('prepends https:// to a bare host', () => {
    expect(normalizeBrowserUrl('github.com')).toBe('https://github.com')
    expect(normalizeBrowserUrl('github.com/ness-dev/ness')).toBe(
      'https://github.com/ness-dev/ness'
    )
  })

  it('leaves an explicit scheme alone', () => {
    expect(normalizeBrowserUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeBrowserUrl('https://example.com:8080/x')).toBe('https://example.com:8080/x')
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank')
    expect(normalizeBrowserUrl('file:///tmp/x.html')).toBe('file:///tmp/x.html')
    expect(normalizeBrowserUrl('data:text/html,<h1>hi</h1>')).toBe('data:text/html,<h1>hi</h1>')
  })

  it('treats host:port as a host, not a scheme', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeBrowserUrl('localhost:3000/app?x=1')).toBe('http://localhost:3000/app?x=1')
    expect(normalizeBrowserUrl('example.com:8080')).toBe('https://example.com:8080')
  })

  it('uses http for loopback hosts, which rarely speak TLS', () => {
    expect(normalizeBrowserUrl('localhost')).toBe('http://localhost')
    expect(normalizeBrowserUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(normalizeBrowserUrl('[::1]:8080')).toBe('http://[::1]:8080')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeBrowserUrl('  example.com  ')).toBe('https://example.com')
  })

  it('returns null for empty input so callers pick their own fallback', () => {
    expect(normalizeBrowserUrl('')).toBeNull()
    expect(normalizeBrowserUrl('   ')).toBeNull()
  })
})
