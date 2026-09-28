/**
 * Die vier Invarianten des Ordnerbaums.
 *
 * Sie stehen im Fachkern ohne IO und werden hier gegen einen ausgeschriebenen Bestand geprueft: kein
 * Zyklus, kein Ordner ueber Arbeitsbereichsgrenzen, eindeutiger Name je Elternknoten, begrenzte Tiefe. Die
 * Erwartungen sind ausgeschrieben und werden **nicht** aus derselben Regel abgeleitet, die die Funktion
 * verwendet - sonst pruefte der Test sich selbst.
 */

import { describe, expect, it } from 'vitest'

import type { Folder } from '../../src/domain/folder/model.js'
import { MAX_FOLDER_DEPTH, checkFolderPlacement, normalizeFolderName } from '../../src/domain/folder/model.js'

const ZEIT = new Date('2026-01-01T00:00:00.000Z')

function ordner(id: string, parentId: string | null, name: string, workspaceId = 'w-1'): Folder {
  return { id, workspaceId, parentId, name, createdAt: ZEIT, updatedAt: ZEIT }
}

/** Kette der Laenge `tiefe`: f1 im Arbeitsbereich, f2 darunter, und so fort. */
function kette(tiefe: number): readonly Folder[] {
  return Array.from({ length: tiefe }, (_, index) =>
    ordner(`f${String(index + 1)}`, index === 0 ? null : `f${String(index)}`, `Ebene ${String(index + 1)}`),
  )
}

describe('Ordnerinvarianten', () => {
  it('erlaubt einen neuen Ordner unter einem vorhandenen', () => {
    const bestand = [ordner('f1', null, 'Kunden')]
    expect(
      checkFolderPlacement(bestand, { id: null, workspaceId: 'w-1', parentId: 'f1', name: 'Angebote' }),
    ).toBeNull()
  })

  it('erkennt einen Zyklus, auch ueber mehrere Ebenen', () => {
    const bestand = [ordner('f1', null, 'Kunden'), ordner('f2', 'f1', 'Nord'), ordner('f3', 'f2', 'Sued')]
    // f1 unter seinen eigenen Enkel: der Baum haette danach keinen Weg mehr zum Arbeitsbereich.
    expect(checkFolderPlacement(bestand, { id: 'f1', workspaceId: 'w-1', parentId: 'f3', name: 'Kunden' })).toBe(
      'zyklus',
    )
    expect(checkFolderPlacement(bestand, { id: 'f1', workspaceId: 'w-1', parentId: 'f1', name: 'Kunden' })).toBe(
      'zyklus',
    )
  })

  it('weist einen Elternordner aus einem fremden Arbeitsbereich ab', () => {
    const bestand = [ordner('f1', null, 'Kunden'), ordner('fremd', null, 'Fremd', 'w-2')]
    expect(
      checkFolderPlacement(bestand, { id: 'f1', workspaceId: 'w-1', parentId: 'fremd', name: 'Kunden' }),
    ).toBe('fremder-arbeitsbereich')
    // Eine erfundene Kennung ist derselbe Fall: sie gehoert zu keinem sichtbaren Arbeitsbereich.
    expect(
      checkFolderPlacement(bestand, { id: null, workspaceId: 'w-1', parentId: 'gibtesnicht', name: 'Neu' }),
    ).toBe('fremder-arbeitsbereich')
  })

  it('weist einen doppelten Namen je Elternknoten ab und erlaubt ihn unter einem anderen', () => {
    const bestand = [ordner('f1', null, 'Kunden'), ordner('f2', 'f1', 'Angebote')]
    expect(
      checkFolderPlacement(bestand, { id: null, workspaceId: 'w-1', parentId: 'f1', name: 'angebote' }),
    ).toBe('name-doppelt')
    expect(
      checkFolderPlacement(bestand, { id: null, workspaceId: 'w-1', parentId: null, name: 'Angebote' }),
    ).toBeNull()
  })

  it('weist eine ueberschrittene Tiefe ab - auch, wenn erst der Unterbaum sie sprengt', () => {
    const voll = kette(MAX_FOLDER_DEPTH)
    const tiefste = `f${String(MAX_FOLDER_DEPTH)}`
    expect(
      checkFolderPlacement(voll, { id: null, workspaceId: 'w-1', parentId: tiefste, name: 'Zuviel' }),
    ).toBe('zu-tief')

    // Ein zweistufiger Unterbaum passt nicht mehr unter die vorletzte Ebene: er selbst waere dort noch
    // erlaubt, sein Kind nicht.
    const bestand = [
      ...kette(MAX_FOLDER_DEPTH - 1),
      ordner('a', null, 'Ast'),
      ordner('b', 'a', 'Zweig'),
    ]
    const vorletzte = `f${String(MAX_FOLDER_DEPTH - 1)}`
    expect(checkFolderPlacement(bestand, { id: 'a', workspaceId: 'w-1', parentId: vorletzte, name: 'Ast' })).toBe(
      'zu-tief',
    )
  })
})

describe('Ordnername', () => {
  it('nimmt einen getrimmten Namen und weist Leeres und Ueberlanges ab', () => {
    expect(normalizeFolderName('  Kunden   Nord ')).toBe('Kunden Nord')
    expect(normalizeFolderName('   ')).toBeNull()
    expect(normalizeFolderName('x'.repeat(81))).toBeNull()
    expect(normalizeFolderName(42)).toBeNull()
  })
})
