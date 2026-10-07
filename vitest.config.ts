import {defineConfig, defaultExclude} from 'vitest/config'

export default defineConfig({
  test: {
    // `tsc -b` emits compiled copies of every *.test.ts into out/, so without
    // this vitest runs each test twice — once from source, once from stale build output.
    exclude: [...defaultExclude, 'out/**', 'dist-headless/**', 'release/**']
  }
})
