import { describe, it, expect } from 'vitest'
import { resolveLocalImageSrc } from './chat-image-src'

describe('resolveLocalImageSrc', () => {
  it('resolves an absolute posix path by extension', () => {
    expect(resolveLocalImageSrc('/tmp/harness-attachments/result-abc.jpg')).toEqual({
      path: '/tmp/harness-attachments/result-abc.jpg',
      mediaType: 'image/jpeg'
    })
    expect(resolveLocalImageSrc('/tmp/a.PNG')).toEqual({
      path: '/tmp/a.PNG',
      mediaType: 'image/png'
    })
    expect(resolveLocalImageSrc('/tmp/a.svg')?.mediaType).toBe('image/svg+xml')
  })

  it('trims surrounding whitespace', () => {
    expect(resolveLocalImageSrc('  /tmp/a.png  ')?.path).toBe('/tmp/a.png')
  })

  it('strips a file:// prefix and percent-decodes', () => {
    expect(resolveLocalImageSrc('file:///tmp/my%20shot.png')).toEqual({
      path: '/tmp/my shot.png',
      mediaType: 'image/png'
    })
    expect(resolveLocalImageSrc('file://localhost/tmp/a.webp')).toEqual({
      path: '/tmp/a.webp',
      mediaType: 'image/webp'
    })
  })

  it('leaves a malformed percent-escape alone rather than throwing', () => {
    expect(resolveLocalImageSrc('file:///tmp/100%.png')?.path).toBe('/tmp/100%.png')
  })

  it('resolves windows drive paths', () => {
    expect(resolveLocalImageSrc('C:/Users/x/shot.png')?.path).toBe('C:/Users/x/shot.png')
    expect(resolveLocalImageSrc('C:\\Users\\x\\shot.png')?.mediaType).toBe('image/png')
  })

  it('declines remote and inline srcs', () => {
    expect(resolveLocalImageSrc('https://example.com/a.png')).toBeNull()
    expect(resolveLocalImageSrc('http://example.com/a.png')).toBeNull()
    expect(resolveLocalImageSrc('data:image/png;base64,AAAA')).toBeNull()
    expect(resolveLocalImageSrc('//example.com/a.png')).toBeNull()
  })

  it('declines relative paths — a transcript may be read off-machine', () => {
    expect(resolveLocalImageSrc('shot.png')).toBeNull()
    expect(resolveLocalImageSrc('./docs/shot.png')).toBeNull()
    expect(resolveLocalImageSrc('../shot.png')).toBeNull()
  })

  it('declines paths without a recognized image extension', () => {
    expect(resolveLocalImageSrc('/tmp/notes.txt')).toBeNull()
    expect(resolveLocalImageSrc('/tmp/noext')).toBeNull()
    expect(resolveLocalImageSrc('/tmp/')).toBeNull()
  })

  it('declines empty input', () => {
    expect(resolveLocalImageSrc('')).toBeNull()
    expect(resolveLocalImageSrc('   ')).toBeNull()
    expect(resolveLocalImageSrc(null)).toBeNull()
    expect(resolveLocalImageSrc(undefined)).toBeNull()
  })
})
