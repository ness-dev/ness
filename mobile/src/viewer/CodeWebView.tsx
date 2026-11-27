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
      // Only the page's own load; a link inside a file must not navigate
      // the viewer away.
      onShouldStartLoadWithRequest={(req) => req.navigationType !== 'click'}
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
