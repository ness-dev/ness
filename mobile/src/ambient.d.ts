// theme.ts imports renderer/theme-apply, whose type-only import of
// hooks/useActiveTheme pulls renderer/store.ts into the typecheck (not the
// bundle). That module reads this desktop global, declared in the
// renderer's own ambient.d.ts, which isn't part of this project.
export {}
declare global {
  interface Window {
    __HARNESS_WEB__?: boolean
  }
}

// The renderer's remark plugins set `data.hName` / `data.hProperties` on
// mdast nodes (remarkInsight, remarkMermaid). On desktop those fields are
// typed by mdast-util-to-hast's augmentation, which react-markdown pulls
// in; the app renders mdast itself, so it declares them here.
declare module 'mdast' {
  interface Data {
    hName?: string
    hProperties?: Record<string, unknown>
  }
}
