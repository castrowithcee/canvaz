import { cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const SERVER_PORT = 3000

/**
 * Kopiert die Schriften des Editors in den Build.
 *
 * Ohne sie laedt Excalidraw sie zur Laufzeit von einem oeffentlichen CDN nach. Eine selbst gehostete Instanz
 * darf nichts Fremdes laden - die Content-Security-Policy verbietet es, und die Instanz soll auch ohne
 * Internetzugang vollstaendig arbeiten. Das Ziel entspricht `EXCALIDRAW_ASSET_BASE` in
 * `src/web/board/excalidraw-assets.ts`. Ein eigenes Kopier-Plugin statt einer weiteren Abhaengigkeit: es
 * sind drei Zeilen aus der Standardbibliothek.
 */
function copyExcalidrawFonts(outDir: string): Plugin {
  return {
    name: 'canvaz-excalidraw-fonts',
    apply: 'build',
    async closeBundle() {
      // Aufgeloest ueber den Paketeinstieg statt ueber einen geratenen Pfad: die Schriften liegen neben dem
      // Bundle, das der Browser spaeter laedt.
      const bundleDir = dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw'))
      await cp(join(bundleDir, 'fonts'), resolve(outDir, 'excalidraw-assets', 'fonts'), { recursive: true })
    },
  }
}

const OUT_DIR = 'dist/web'

// Excalidraw liest zur Laufzeit `process.env.IS_PREACT`; ohne dieses Define bricht der Browser-Build.
export default defineConfig({
  plugins: [react(), copyExcalidrawFonts(OUT_DIR)],
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
    outDir: OUT_DIR,
    sourcemap: true,
    emptyOutDir: true,
  },
})
