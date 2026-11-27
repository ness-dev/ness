// The WebView that shows code-html.ts's pages. Read-only: any navigation
// away from the page itself (a link inside a file) is refused.
import { memo } from 'react'
import { WebView } from 'react-native-webview'
import { c } from '../theme'

export const CodeWebView = memo(function CodeWebView({ html }: { html: string }) {
  return (
    <WebView
      source={{ html }}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={(req) => req.url === 'about:blank' || req.url.startsWith('data:')}
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
})
