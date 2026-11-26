// Port of JsonModeChatImageThumb: chat images are files on the backend's
// machine (tool screenshots, pasted attachments, markdown image paths), so
// they're fetched through `jsonClaude:readAttachmentImage` (base64) and
// shown as a data URI. Remote http(s) URLs load directly. Tap opens a
// full-screen view; tap again to close (same as the web thumb).
import { createContext, useContext, useEffect, useState } from 'react'
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { ImageOff, X } from 'lucide-react-native'
import type { NessClient } from '../ness'
import { c } from '../theme'

/** The chat's backend, so deep components (Markdown) can fetch images. */
export const ChatClientContext = createContext<NessClient | null>(null)

// Data URIs are big; keep a bounded cache per backend so scrolling back
// through a screenshot-heavy transcript doesn't refetch everything.
const LIMIT = 60
const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function mediaTypeFor(path: string, given?: string): string {
  if (given) return given
  const ext = path.split('.').pop()?.toLowerCase()
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
}

function load(client: NessClient, path: string, mediaType?: string): Promise<string | null> {
  if (/^https?:\/\//.test(path) || path.startsWith('data:')) return Promise.resolve(path)
  const key = `${client.id}:${path}`
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null)
  let p = inflight.get(key)
  if (!p) {
    p = client
      .req<string | null>('jsonClaude:readAttachmentImage', path)
      .then((b64) => (b64 ? `data:${mediaTypeFor(path, mediaType)};base64,${b64}` : null))
      .catch(() => null)
      .then((uri) => {
        inflight.delete(key)
        cache.set(key, uri)
        while (cache.size > LIMIT) cache.delete(cache.keys().next().value as string)
        return uri
      })
    inflight.set(key, p)
  }
  return p
}

export function ChatImage({
  path,
  mediaType,
  height = 96,
  maxWidth = 160,
  alt
}: {
  path: string
  mediaType?: string
  height?: number
  maxWidth?: number
  alt?: string
}) {
  const client = useContext(ChatClientContext)
  const [uri, setUri] = useState<string | null | undefined>(undefined)
  const [aspect, setAspect] = useState(4 / 3)
  const [open, setOpen] = useState(false)
  const win = useWindowDimensions()

  useEffect(() => {
    if (!client) {
      // Outside a chat there's no backend to read local files from.
      setUri(/^(https?:|data:)/.test(path) ? path : null)
      return
    }
    let alive = true
    void load(client, path, mediaType).then((u) => alive && setUri(u))
    return () => {
      alive = false
    }
  }, [client, path, mediaType])

  useEffect(() => {
    if (uri) Image.getSize(uri, (w, h) => h > 0 && setAspect(w / h), () => {})
  }, [uri])

  const width = Math.min(maxWidth, Math.round(height * aspect))
  if (uri === undefined) {
    return (
      <View style={{ width, height, borderRadius: 6, backgroundColor: c.panelRaised, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={c.dim} size="small" />
      </View>
    )
  }
  if (uri === null) {
    return (
      <View
        accessibilityLabel={`Image unavailable: ${alt ?? path}`}
        style={{ width, height, borderRadius: 6, backgroundColor: c.panelRaised, alignItems: 'center', justifyContent: 'center', gap: 4, padding: 6 }}
      >
        <ImageOff color={c.dim} size={16} />
        <Text style={{ color: c.dim, fontSize: 10 }} numberOfLines={2}>
          {path.split('/').pop()}
        </Text>
      </View>
    )
  }
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="imagebutton" accessibilityLabel={alt ? `Open image: ${alt}` : 'Open image'}>
        <Image source={{ uri }} style={{ width, height, borderRadius: 6, backgroundColor: c.panelRaised }} resizeMode="cover" />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} supportedOrientations={['portrait', 'landscape']}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' }} onPress={() => setOpen(false)} accessibilityLabel="Close image">
          <ScrollView
            maximumZoomScale={4}
            minimumZoomScale={1}
            centerContent
            contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}
          >
            <Image
              source={{ uri }}
              style={{ width: win.width, height: Math.min(win.height * 0.85, win.width / aspect) }}
              resizeMode="contain"
            />
          </ScrollView>
          <View style={{ position: 'absolute', top: 54, right: 12, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <X color="#fff" size={22} />
          </View>
        </Pressable>
      </Modal>
    </>
  )
}

/** A row of thumbnails (the web's CollapsedImageStrip / attachment row). */
export function ImageStrip({ images, height = 72, max = 8 }: { images: { path: string; mediaType?: string }[]; height?: number; max?: number }) {
  if (!images.length) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
      {images.slice(0, max).map((img) => (
        <ChatImage key={img.path} path={img.path} mediaType={img.mediaType} height={height} />
      ))}
    </ScrollView>
  )
}
