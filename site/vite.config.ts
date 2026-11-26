import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname),
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    // Announcement posts normally live as plain HTML in public/. One that
    // mounts site components is a build entry instead; it still lands at
    // /announcements/<slug>.html, the path the in-app banner links to.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'conversation-blame': resolve(__dirname, 'announcements/conversation-blame.html')
      }
    }
  }
})
