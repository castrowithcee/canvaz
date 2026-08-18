/**
 * Herkunft der Editor-Schriften.
 *
 * Ohne diese Angabe laedt Excalidraw seine Schriften von einem oeffentlichen CDN nach. Eine selbst
 * gehostete Instanz darf im Betrieb nichts Fremdes laden - die Content-Security-Policy (`default-src 'self'`)
 * verbietet es, und die Instanz soll auch ohne Internetzugang vollstaendig arbeiten. Die Dateien liegen
 * deshalb im eigenen Build; `vite.config.ts` kopiert sie beim Bauen hierher.
 *
 * **Die Zuweisung muss vor der Auswertung des Excalidraw-Moduls geschehen**, denn dessen Schriftregister
 * baut seine URLs beim Laden auf. Ein gewoehnlicher `import` genuegt dafuer nicht: der Bundler legt
 * Excalidraw in einen eigenen Chunk, und ein statisch importierter Chunk wird immer vor dem Rumpf des
 * importierenden Moduls ausgefuehrt. Deshalb wird der Editor in `app.tsx` nachgeladen und diese Funktion
 * davor aufgerufen. Der E2E-Test `laedt den Board-Editor ohne Verstoss gegen die Content-Security-Policy`
 * haelt die Reihenfolge fest: bricht sie, meldet der Browser einen Verstoss gegen `font-src`.
 */

export const EXCALIDRAW_ASSET_BASE = '/excalidraw-assets/'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | readonly string[]
  }
}

export function setExcalidrawAssetPath(): void {
  window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_BASE
}
