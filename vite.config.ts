import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Excalidraw liest zur Laufzeit `process.env.IS_PREACT`; ohne dieses Define bricht der Browser-Build.
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
