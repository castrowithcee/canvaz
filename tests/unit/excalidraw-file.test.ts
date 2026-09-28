/**
 * Das `.excalidraw`-Dateiformat als Aus- und Eingang.
 *
 * Der Schwerpunkt liegt auf dem Eingang: eine Importdatei kommt von aussen, und jede Ablehnung muss benannt
 * sein statt still zu glaetten. Der Roundtrip belegt dazu, dass ein Export wieder hereinkommt.
 */

import { describe, expect, it } from 'vitest'

import type { SyncElement } from '../../src/contracts/scene.js'
import { DEFAULT_APP_STATE } from '../../src/contracts/scene.js'
import { MAX_IMPORT_FILES, parseExcalidrawFile, toExcalidrawFile } from '../../src/domain/board/excalidraw-file.js'

/** Ein winziges, gueltiges PNG als Data-URL - dieselben Signaturbytes, die der Upload erwartet. */
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`

function element(id: string, extra: Record<string, unknown> = {}): SyncElement {
  return { id, version: 3, versionNonce: 7, type: 'rectangle', ...extra }
}

function datei(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'irgendwo',
    elements: [element('a')],
    appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    ...overrides,
  }
}

function problemOf(value: unknown): string {
  const result = parseExcalidrawFile(value)
  return result.ok ? 'angenommen' : result.problem
}

describe('Excalidraw-Export', () => {
  it('bettet die Bilder ein und laesst Tombstones draussen', () => {
    const exported = toExcalidrawFile(
      [element('a'), element('weg', { isDeleted: true })],
      DEFAULT_APP_STATE,
      [{ id: 'bild', mimeType: 'image/png', created: 5 }],
      new Map([['bild', PNG_DATA_URL]]),
    )

    expect(exported.type).toBe('excalidraw')
    expect(exported.elements.map((entry) => entry.id)).toEqual(['a'])
    expect(exported.files['bild']?.dataURL).toBe(PNG_DATA_URL)
  })

  it('laesst eine Datei ohne Bytes weg, statt einen leeren Verweis mitzuschicken', () => {
    const exported = toExcalidrawFile(
      [],
      DEFAULT_APP_STATE,
      [{ id: 'fehlt', mimeType: 'image/png', created: 5 }],
      new Map(),
    )

    expect(exported.files).toEqual({})
  })

  it('kommt als eigener Export wieder herein', () => {
    const exported = toExcalidrawFile(
      [element('a', { x: 12 })],
      DEFAULT_APP_STATE,
      [{ id: 'bild', mimeType: 'image/png', created: 5 }],
      new Map([['bild', PNG_DATA_URL]]),
    )

    const wieder = parseExcalidrawFile(JSON.parse(JSON.stringify(exported)))

    expect(wieder.ok).toBe(true)
    if (wieder.ok) {
      expect(wieder.file.elements[0]?.['x']).toBe(12)
      expect(wieder.file.files[0]?.mimeType).toBe('image/png')
      expect(wieder.file.viewBackgroundColor).toBe(DEFAULT_APP_STATE.viewBackgroundColor)
    }
  })
})

describe('Excalidraw-Import', () => {
  it('nimmt eine gueltige Datei ohne Bilder an', () => {
    const result = parseExcalidrawFile(datei())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.file.files).toEqual([])
      expect(result.file.gridModeEnabled).toBe(false)
    }
  })

  it('lehnt beschaedigte und schemafremde Dateien benannt ab', () => {
    expect(problemOf(null)).toBe('kein-excalidraw')
    expect(problemOf({ type: 'tldraw', version: 2 })).toBe('kein-excalidraw')
    expect(problemOf(datei({ version: 99 }))).toBe('unbekannte-formatversion')
    expect(problemOf(datei({ elements: 'keine liste' }))).toBe('ungueltige-elemente')
    // Ein Element ohne `versionNonce` erfuellt den Elementvertrag nicht und wuerde den Abgleich brechen.
    expect(problemOf(datei({ elements: [{ id: 'a', version: 1 }] }))).toBe('ungueltige-elemente')
    expect(problemOf(datei({ appState: { viewBackgroundColor: 5 } }))).toBe('ungueltiger-appstate')
  })

  it('lehnt eine externe Assetreferenz ab, statt sie zu laden', () => {
    const extern = { bild: { id: 'bild', mimeType: 'image/png', dataURL: 'https://fremd.example/x.png' } }

    expect(problemOf(datei({ files: extern }))).toBe('externe-assetreferenz')
  })

  it('lehnt einen Verweis mit ausfuehrbarem Inhalt ab, auch getarnt', () => {
    expect(problemOf(datei({ elements: [element('a', { link: 'javascript:alert(1)' })] }))).toBe('gefaehrlicher-link')
    expect(problemOf(datei({ elements: [element('a', { link: 'JaVa\nScRiPt:alert(1)' })] }))).toBe('gefaehrlicher-link')
    // Ein gewoehnlicher Verweis bleibt erlaubt: er gehoert zu einer Zeichnung.
    expect(problemOf(datei({ elements: [element('a', { link: 'https://example.org' })] }))).toBe('angenommen')
  })

  it('begrenzt die Zahl eingebetteter Bilder', () => {
    const files: Record<string, unknown> = {}
    for (let index = 0; index <= MAX_IMPORT_FILES; index += 1) {
      files[`bild-${String(index)}`] = { id: `bild-${String(index)}`, mimeType: 'image/png', dataURL: PNG_DATA_URL }
    }

    expect(problemOf(datei({ files }))).toBe('zu-viele-dateien')
  })

  it('verlangt, dass die Dateikennung mit ihrem Schluessel uebereinstimmt', () => {
    const files = { bild: { id: 'anderes', mimeType: 'image/png', dataURL: PNG_DATA_URL } }

    expect(problemOf(datei({ files }))).toBe('ungueltige-datei')
  })
})
