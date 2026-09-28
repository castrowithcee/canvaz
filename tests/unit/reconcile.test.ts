import { describe, expect, it } from 'vitest'

import type { SyncElement } from '../../src/contracts/scene.js'
import { reconcileElements, shouldReplace, visibleElements } from '../../src/domain/board/reconcile.js'

function element(id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}): SyncElement {
  return { id, version, versionNonce, ...extra }
}

function byId(elements: readonly SyncElement[]): Record<string, SyncElement> {
  return Object.fromEntries(elements.map((entry) => [entry.id, entry]))
}

describe('Element-Reconciliation', () => {
  it('uebernimmt die hoehere Version', () => {
    const result = reconcileElements([element('a', 1, 500)], [element('a', 2, 900, { x: 10 })])

    expect(result.appliedIds).toEqual(new Set(['a']))
    expect(result.elements[0]?.['x']).toBe(10)
  })

  it('bricht Gleichstand deterministisch ueber den Nonce', () => {
    expect(shouldReplace(element('a', 5, 900), element('a', 5, 100))).toBe(true)
    expect(shouldReplace(element('a', 5, 100), element('a', 5, 900))).toBe(false)
  })

  it('konvergiert unabhaengig von der Reihenfolge der beiden Clients', () => {
    const clientA = [element('a', 3, 10, { x: 1 }), element('b', 1, 50)]
    const clientB = [element('a', 2, 5, { x: 99 }), element('c', 4, 7)]

    const merged = reconcileElements(clientA, clientB)
    const mergedReversed = reconcileElements(clientB, clientA)

    expect(byId(merged.elements)).toEqual(byId(mergedReversed.elements))
    expect(merged.elements).toHaveLength(3)
    expect(byId(merged.elements)['a']?.['x']).toBe(1)
  })

  it('haelt eine Loeschung als Tombstone fest, statt sie wiederzubeleben', () => {
    const local = [element('a', 7, 10, { isDeleted: true })]
    const staleRemote = [element('a', 6, 10, { isDeleted: false })]

    const result = reconcileElements(local, staleRemote)

    expect(result.appliedIds.size).toBe(0)
    expect(result.elements[0]?.isDeleted).toBe(true)
    expect(visibleElements(result.elements)).toHaveLength(0)
  })

  it('behaelt die lokale z-Reihenfolge und haengt neue Elemente an', () => {
    const local = [element('a', 1, 1), element('b', 1, 1)]
    const incoming = [element('b', 2, 1), element('z', 1, 1)]

    const result = reconcileElements(local, incoming)

    expect(result.elements.map((entry) => entry.id)).toEqual(['a', 'b', 'z'])
  })
})
