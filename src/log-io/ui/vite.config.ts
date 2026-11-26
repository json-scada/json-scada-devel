/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // Emit relative asset URLs (e.g. "./assets/...") so the app works when served
  // from the root OR mounted under a sub-path by a reverse proxy (e.g. /log-io/).
  base: './',
  plugins: [react()],
  build: {
    // Preserve the browser targets used by the Vite 7 build.
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    // Keep output in "build" so the json-scada build pipeline and the server's
    // build-ui script (which copies ui/build -> server/lib/ui) keep working.
    outDir: 'build',
  },
  server: {
    port: 3000,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  },
})
