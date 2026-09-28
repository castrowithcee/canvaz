/**
 * Der Kern von Wiederherstellung und Import: ein Stand ersetzt einen anderen.
 *
 * Geprueft wird die eine Zusage, an der beides haengt - der ersetzende Stand muss sich gegen den bisherigen
 * **durchsetzen koennen**. Dieselbe Reconciliation, die im Boardraum und im Browser laeuft, entscheidet
 * darueber; deshalb steht sie in diesen Faellen mit im Test.
 */

import { describe, expect, it } from 'vitest'

import type { SceneSnapshot, SyncElement } from '../../src/contracts/scene.js'
import { SCENE_SCHEMA_VERSION } from '../../src/contracts/scene.js'
import { reconcileElements, visibleElements } from '../../src/domain/board/reconcile.js'
import { supersedeSnapshot } from '../../src/domain/board/versioning.js'

function element(id: string, version: number, extra: Record<string, unknown> = {}): SyncElement {
  return { id, version, versionNonce: 42, ...extra }
}

function snapshot(elements: readonly SyncElement[], files: Record<string, unknown> = {}): SceneSnapshot {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    boardId: 'board-1',
    elements,
    appState: { viewBackgroundColor: '#ffffff', gridSize: null, gridModeEnabled: false, name: 'Board' },
    files: files as SceneSnapshot['files'],
    updatedAt: 1,
  }
}

function versionOf(scene: SceneSnapshot, id: string): number | undefined {
  return scene.elements.find((entry) => entry.id === id)?.version
}

describe('Ersetzender Snapshot', () => {
  it('hebt jedes Element ueber die Version, die es im aktuellen Stand hatte', () => {
    const aktuell = snapshot([element('a', 20), element('b', 9)])
    const alt = snapshot([element('a', 3), element('b', 12)])

    const ersetzt = supersedeSnapshot(aktuell, alt, 'board-1', 99)

    expect(versionOf(ersetzt, 'a')).toBe(21)
    // Was ohnehin hoeher stand, bleibt unangetastet - angehoben wird nur, wo es noetig ist.
    expect(versionOf(ersetzt, 'b')).toBe(12)
    expect(ersetzt.updatedAt).toBe(99)
  })

  it('setzt sich in der Reconciliation gegen den bisherigen Stand durch', () => {
    const aktuell = snapshot([element('a', 20, { text: 'neu' })])
    const alt = snapshot([element('a', 3, { text: 'alt' })])

    const ersetzt = supersedeSnapshot(aktuell, alt, 'board-1', 99)
    // Genau die Lage nach einem Restore: ein Client haelt den bisherigen Stand noch und schickt ihn erneut.
    const zusammengefuehrt = reconcileElements(ersetzt.elements, aktuell.elements)

    expect(zusammengefuehrt.appliedIds.size).toBe(0)
    expect(zusammengefuehrt.elements[0]?.['text']).toBe('alt')
  })

  it('beerdigt ein Element, das nur der aktuelle Stand kennt', () => {
    const aktuell = snapshot([element('a', 5), element('spaeter', 7)])
    const alt = snapshot([element('a', 5)])

    const ersetzt = supersedeSnapshot(aktuell, alt, 'board-1', 99)

    expect(versionOf(ersetzt, 'spaeter')).toBe(8)
    expect(ersetzt.elements.find((entry) => entry.id === 'spaeter')?.isDeleted).toBe(true)
    expect(visibleElements(ersetzt.elements).map((entry) => entry.id)).toEqual(['a'])
  })

  it('behaelt die Dateiverweise beider Staende, damit kein Bildelement ins Leere zeigt', () => {
    const datei = { id: 'x', mimeType: 'image/png', created: 1, byteSize: 8, storageKey: 'k' }
    const aktuell = snapshot([], { x: datei })
    const alt = snapshot([])

    expect(Object.keys(supersedeSnapshot(aktuell, alt, 'board-1', 99).files)).toEqual(['x'])
  })

  it('uebernimmt einen Stand unveraendert, wenn das Board noch nie gespeichert wurde', () => {
    const neu = snapshot([element('a', 1)])

    const ersetzt = supersedeSnapshot(null, neu, 'board-1', 99)

    expect(ersetzt.elements).toEqual(neu.elements)
  })
})
