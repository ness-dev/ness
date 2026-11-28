// Node-side tests for the mobile client: the pure logic it adds on top of
// the shared modules, and (test/contract.test.ts) the whole client against
// a real headless server. Run from the repo root:
//   npm run test:mobile            unit tests
//   npm run test:mobile:contract   + contract (needs `npm run build:headless`)
// Component rendering isn't covered here; nothing that imports a React
// Native view can load in Node.
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      // theme.ts reads Platform for the monospace family.
      'react-native': fileURLToPath(new URL('./test/stubs/react-native.ts', import.meta.url))
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: process.env.MOBILE_CONTRACT ? [] : ['test/contract.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
})
