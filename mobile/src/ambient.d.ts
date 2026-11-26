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
