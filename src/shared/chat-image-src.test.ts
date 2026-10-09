import { describe, it, expect } from 'vitest'
import {
  parseImageAlt,
  parseImageSizeSpec,
  parseImageTitle,
  resolveLocalImageSrc
} from './chat-image-src'

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

describe('parseImageSizeSpec', () => {
  it('reads a bare width as pixels', () => {
    expect(parseImageSizeSpec('400')).toEqual({ width: 400 })
    expect(parseImageSizeSpec('400px')).toEqual({ width: 400 })
    expect(parseImageSizeSpec(' =400 ')).toEqual({ width: 400 })
  })

  it('reads a width x height pair, either half optional', () => {
    expect(parseImageSizeSpec('400x300')).toEqual({ width: 400, height: 300 })
    expect(parseImageSizeSpec('400X300')).toEqual({ width: 400, height: 300 })
    expect(parseImageSizeSpec('400×300')).toEqual({ width: 400, height: 300 })
    expect(parseImageSizeSpec('400x')).toEqual({ width: 400 })
    expect(parseImageSizeSpec('x300')).toEqual({ height: 300 })
  })

  it('reads a percentage as a column fraction', () => {
    expect(parseImageSizeSpec('50%')).toEqual({ widthPercent: 50 })
  })

  it('clamps out-of-range values instead of rejecting them', () => {
    expect(parseImageSizeSpec('99999')).toEqual({ width: 2000 })
    expect(parseImageSizeSpec('2')).toEqual({ width: 16 })
    expect(parseImageSizeSpec('999%')).toEqual({ widthPercent: 100 })
    expect(parseImageSizeSpec('1%')).toEqual({ widthPercent: 5 })
  })

  it('declines anything that is not a size', () => {
    expect(parseImageSizeSpec('x')).toBeNull()
    expect(parseImageSizeSpec('wide')).toBeNull()
    expect(parseImageSizeSpec('400em')).toBeNull()
    expect(parseImageSizeSpec('')).toBeNull()
    expect(parseImageSizeSpec(null)).toBeNull()
  })
})

describe('parseImageAlt', () => {
  it('splits a size spec off the end', () => {
    expect(parseImageAlt('the new panel|400')).toEqual({
      alt: 'the new panel',
      size: { width: 400 }
    })
    expect(parseImageAlt('panel | 50%')).toEqual({
      alt: 'panel',
      size: { widthPercent: 50 }
    })
    expect(parseImageAlt('|400')).toEqual({ alt: '', size: { width: 400 } })
  })

  it('leaves alt text whole when the tail is not a size', () => {
    expect(parseImageAlt('a | b | c')).toEqual({ alt: 'a | b | c', size: null })
    expect(parseImageAlt('no pipe here')).toEqual({ alt: 'no pipe here', size: null })
    expect(parseImageAlt(undefined)).toEqual({ alt: '', size: null })
  })
})

describe('parseImageTitle', () => {
  it('reads a leading-= title as a size and drops the tooltip', () => {
    expect(parseImageTitle('=400x300')).toEqual({
      title: undefined,
      size: { width: 400, height: 300 }
    })
  })

  it('keeps an ordinary title as a tooltip, numbers included', () => {
    expect(parseImageTitle('Settings pane')).toEqual({
      title: 'Settings pane',
      size: null
    })
    expect(parseImageTitle('400')).toEqual({ title: '400', size: null })
    expect(parseImageTitle(undefined)).toEqual({ title: undefined, size: null })
  })

  it('keeps a leading-= title that is not a valid size, rather than eating it', () => {
    expect(parseImageTitle('=wide')).toEqual({ title: '=wide', size: null })
  })
})

describe('resolveLocalImageSrc — size fragment', () => {
  it('reads a size off a trailing fragment', () => {
    expect(resolveLocalImageSrc('/tmp/a.png#w=200')).toEqual({
      path: '/tmp/a.png',
      mediaType: 'image/png',
      size: { width: 200 }
    })
    expect(resolveLocalImageSrc('/tmp/a.png#200')?.size).toEqual({ width: 200 })
    expect(resolveLocalImageSrc('/tmp/a.png#width=400x300')?.size).toEqual({
      width: 400,
      height: 300
    })
  })

  it('leaves a # that is not a size alone', () => {
    // No size to parse, so the fragment stays part of the name — and that
    // name has no image extension, so it is not a local image.
    expect(resolveLocalImageSrc('/tmp/a.png#section')).toBeNull()
    expect(resolveLocalImageSrc('/tmp/weird#name.png')).toEqual({
      path: '/tmp/weird#name.png',
      mediaType: 'image/png'
    })
  })

  it('omits size when there is no fragment', () => {
    expect(resolveLocalImageSrc('/tmp/a.png')).toEqual({
      path: '/tmp/a.png',
      mediaType: 'image/png'
    })
  })
})
