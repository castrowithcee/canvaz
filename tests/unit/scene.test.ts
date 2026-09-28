import { describe, expect, it } from 'vitest'

import type { SceneSnapshot } from '../../src/contracts/scene.js'
import {
  SCENE_SCHEMA_VERSION,
  deserializeSceneSnapshot,
  parseSceneSnapshot,
  serializeSceneSnapshot,
} from '../../src/contracts/scene.js'

/** Elementform mit den Feldern, die Excalidraw tatsaechlich liefert, inklusive Bindings und Asset-Bezug. */
const snapshot: SceneSnapshot = {
  schemaVersion: SCENE_SCHEMA_VERSION,
  boardId: 'board-roundtrip',
  elements: [
    {
      id: 'rect-1',
      type: 'rectangle',
      version: 12,
      versionNonce: 884_211,
      isDeleted: false,
      x: 12.5,
      y: -40.25,
      width: 200,
      height: 100,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
      groupIds: ['group-a'],
      frameId: null,
      roundness: { type: 3 },
      seed: 1_337,
      updated: 1_700_000_000_000,
      link: null,
      locked: false,
      boundElements: [{ id: 'arrow-1', type: 'arrow' }],
    },
    {
      id: 'arrow-1',
      type: 'arrow',
      version: 3,
      versionNonce: 12,
      x: 0,
      y: 0,
      points: [
        [0, 0],
        [55.5, 12.25],
      ],
      startBinding: { elementId: 'rect-1', focus: 0.15, gap: 4 },
      endBinding: null,
    },
    {
      id: 'image-1',
      type: 'image',
      version: 2,
      versionNonce: 99,
      fileId: 'file-1',
      status: 'saved',
      scale: [1, 1],
    },
  ],
  appState: {
    viewBackgroundColor: '#f8f9fa',
    gridSize: 20,
    gridModeEnabled: true,
    name: 'Roundtrip-Board',
  },
  files: {
    'file-1': {
      id: 'file-1',
      mimeType: 'image/png',
      created: 1_700_000_000_001,
      byteSize: 4_096,
      storageKey: 'boards/board-roundtrip/file-1.png',
    },
  },
  updatedAt: 1_700_000_000_002,
}

describe('Snapshot-Roundtrip', () => {
  it('erhaelt Elemente, AppState und Asset-Referenzen unveraendert', () => {
    const restored = deserializeSceneSnapshot(serializeSceneSnapshot(snapshot))

    expect(restored).toEqual(snapshot)
  })

  it('reicht unbekannte Elementfelder eines neueren Excalidraw durch', () => {
    const withUnknownField: SceneSnapshot = {
      ...snapshot,
      elements: [{ id: 'x', version: 1, versionNonce: 1, kuenftigesFeld: { tief: ['a', 1, null] } }],
    }

    const restored = deserializeSceneSnapshot(serializeSceneSnapshot(withUnknownField))

    expect(restored?.elements[0]).toEqual(withUnknownField.elements[0])
  })

  it('meldet einen beschaedigten Datensatz statt eines leeren Boards', () => {
    expect(deserializeSceneSnapshot('{')).toBeNull()
    expect(parseSceneSnapshot({ ...snapshot, schemaVersion: 99 })).toBeNull()
    expect(parseSceneSnapshot({ ...snapshot, elements: [{ id: 'a' }] })).toBeNull()
    expect(parseSceneSnapshot({ ...snapshot, files: { 'file-1': { id: 'abweichend' } } })).toBeNull()
  })
})
