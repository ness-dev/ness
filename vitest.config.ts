import {defineConfig, defaultExclude} from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // `tsc -b` emits compiled copies of every *.test.ts into out/, so without
    // this vitest runs each test twice — once from source, once from stale build output.
    // mobile/ is the Expo spike: its own package, its own toolchain.
    exclude: [...defaultExclude, 'out/**', 'dist-headless/**', 'release/**', 'mobile/**']
  }
})
