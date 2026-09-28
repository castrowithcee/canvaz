/**
 * Nachgeladener Boardeditor.
 *
 * Der Editor wird erst beim Oeffnen eines Boards geladen. Zwei Gruende, und beide sind zwingend: Excalidraw
 * bringt den mit Abstand groessten Teil des Bundles mit, und sein Schriftregister baut seine URLs beim Laden
 * auf - der eigene Assetpfad muss deshalb *vorher* stehen. Ein statischer Import koennte das nicht leisten,
 * weil der Bundler den Excalidraw-Chunk dann vor jedem Modulrumpf ausfuehrt.
 *
 * Steht in einer eigenen Datei, weil ihn zwei Einstiege brauchen: die Huelle der angemeldeten Nutzer und die
 * Gastansicht. Zweimal `lazy(...)` waeren zwei getrennte Ladezustaende fuer dasselbe Modul.
 */

import { lazy } from 'react'

export const BoardEditor = lazy(async () => {
  const { setExcalidrawAssetPath } = await import('./excalidraw-assets.js')
  setExcalidrawAssetPath()
  const editor = await import('./board-view.js')
  return { default: editor.BoardEditor }
})
