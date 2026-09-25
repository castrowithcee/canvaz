/**
 * Merkliste unbestaetigter eigener Aenderungen.
 *
 * Ein Durchlauf ueber zwei Verbindungen: was der Raum schon traegt, faellt weg; was verschickt, aber nie
 * bestaetigt wurde, geht beim naechsten Beitritt erneut hinaus; erst ein ausreichend hohes `saved` leert sie.
 */

import { describe, expect, it } from 'vitest'

import { UnconfirmedChanges } from '../../src/web/board/unconfirmed-changes.js'
import { element } from '../support/realtime-socket.js'

describe('Unbestaetigte eigene Aenderungen', () => {
  it('schickt nach einem Beitritt nur, was der Raum nicht traegt, und leert sich erst mit der Bestaetigung', () => {
    const merkliste = new UnconfirmedChanges()
    // Vor dem ersten Beitritt gezeichnet, dazu ein fertiger Upload; eine Aenderung ging auf der alten
    // Verbindung unter Kennung 3 hinaus und wurde nie bestaetigt.
    merkliste.note(['offline', 'angekommen'], true, ['bild'], 0)
    merkliste.note(['verloren'], false, [], 3)

    merkliste.rejoin(
      [element('angekommen', 2, 7), element('verloren', 1, 1)],
      new Set(['bild']),
      false,
      [element('offline', 1, 5), element('angekommen', 2, 7), element('verloren', 2, 9)],
    )

    const offen = merkliste.unsent()
    expect([...offen.elementIds].sort()).toEqual(['offline', 'verloren'])
    expect(offen.appState).toBe(true)
    expect(offen.fileIds).toEqual([])

    merkliste.markSent(5)
    expect(merkliste.unsent().elementIds.size).toBe(0)
    merkliste.confirm(4)
    expect(merkliste.empty).toBe(false)
    merkliste.confirm(5)
    expect(merkliste.empty).toBe(true)
  })
})
