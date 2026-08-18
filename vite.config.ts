import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const SERVER_PORT = 3000

// Excalidraw liest zur Laufzeit `process.env.IS_PREACT`; ohne dieses Define bricht der Browser-Build.
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  server: {
    port: 5173,
    strictPort: true,
    // Im Entwicklungsbetrieb liefert Vite die SPA, die API bleibt beim Anwendungsserver.
    proxy: {
      '/api': `http://127.0.0.1:${String(SERVER_PORT)}`,
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    // Der Anwendungsserver liefert genau dieses Verzeichnis aus (CANVAZ_WEB_ROOT).
    outDir: 'dist/web',
    sourcemap: true,
    emptyOutDir: true,
  },
})
