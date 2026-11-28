// The WebView that shows code-html.ts's pages. Read-only: any navigation
// away from the page itself (a link inside a file) is refused. The Review
// tab also listens to the page's taps (onMessage) and drives it through
// the ref's injectJavaScript.
import { forwardRef, memo, type ComponentRef } from 'react'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { c } from '../theme'

/** What the ref holds: the WebView's handle (injectJavaScript etc.). */
export type CodeWebViewHandle = ComponentRef<typeof WebView>

export const CodeWebView = memo(forwardRef<CodeWebViewHandle, { html: string; onMessage?: (data: string) => void; onLoadEnd?: () => void }>(function CodeWebView({ html, onMessage, onLoadEnd }, ref) {
  return (
    <WebView
      ref={ref}
      source={{ html }}
      onMessage={onMessage ? (e: WebViewMessageEvent) => onMessage(e.nativeEvent.data) : undefined}
      onLoadEnd={onLoadEnd}
      originWhitelist={['*']}
      // Only the page's own load; a link inside a file must not navigate
      // the viewer away. navigationType is iOS-only (the initial html load
      // there isn't about:blank), so Android falls back to the URL.
      onShouldStartLoadWithRequest={(req) =>
        req.navigationType !== undefined ? req.navigationType !== 'click' : req.url === 'about:blank' || req.url.startsWith('data:')
      }
      // Without these the page flashes white before its own background paints.
      style={{ flex: 1, backgroundColor: c.app }}
      containerStyle={{ backgroundColor: c.app }}
      // Sideways scroll is the page's own; the WebView's bounce would drag
      // the sticky line-number gutter off the edge.
      bounces={false}
      overScrollMode="never"
      textInteractionEnabled
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
    />
  )
}))
