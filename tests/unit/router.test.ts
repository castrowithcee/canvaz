/**
 * Pfadschema der angemeldeten Anwendung.
 *
 * Geprueft wird das, worauf ein geteilter Link und ein Neuladen bauen: dieselbe Adresse muss dieselbe
 * Ansicht ergeben, und dieselbe Ansicht dieselbe Adresse. Unbekanntes endet benannt und nicht als leerer
 * Bildschirm.
 */

import { describe, expect, it } from 'vitest'

import type { AppRoute } from '../../src/web/router.js'
import { parseRoute, routeHref } from '../../src/web/router.js'

const ROUTES: readonly (readonly [string, AppRoute])[] = [
  ['/', { kind: 'einstieg' }],
  ['/arbeitsbereiche', { kind: 'arbeitsbereiche' }],
  ['/arbeitsbereiche/w-1', { kind: 'arbeitsbereich', workspaceId: 'w-1' }],
  ['/arbeitsbereiche/w-1/mitglieder', { kind: 'mitglieder', workspaceId: 'w-1' }],
  ['/arbeitsbereiche/w-1/einstellungen', { kind: 'einstellungen', workspaceId: 'w-1' }],
  ['/arbeitsbereiche/w-1/boards/b-2', { kind: 'board', workspaceId: 'w-1', boardId: 'b-2', version: null }],
  ['/arbeitsbereiche/w-1/boards/b-2?version=7', { kind: 'board', workspaceId: 'w-1', boardId: 'b-2', version: 7 }],
  ['/konto', { kind: 'konto' }],
  ['/verwaltung/konten', { kind: 'konten' }],
]

describe('Pfadschema', () => {
  it.each(ROUTES)('liest %s als seine Ansicht', (href, route) => {
    expect(parseRoute(href)).toEqual(route)
  })

  it.each(ROUTES)('schreibt die Ansicht von %s wieder als diese Adresse', (href, route) => {
    expect(routeHref(route)).toBe(href)
  })

  it('endet bei einer unbekannten Adresse benannt', () => {
    expect(parseRoute('/gibtesnicht')).toEqual({ kind: 'unbekannt' })
    expect(parseRoute('/arbeitsbereiche/w-1/boards/b-2/mehr')).toEqual({ kind: 'unbekannt' })
  })

  it('nimmt eine unbrauchbare Versionsangabe als aktuellen Stand', () => {
    expect(parseRoute('/arbeitsbereiche/w-1/boards/b-2?version=null')).toEqual({
      kind: 'board',
      workspaceId: 'w-1',
      boardId: 'b-2',
      version: null,
    })
  })

  it('traegt Kennungen mit Sonderzeichen unveraendert durch', () => {
    const href = routeHref({ kind: 'arbeitsbereich', workspaceId: 'a/b' })
    expect(href).toBe('/arbeitsbereiche/a%2Fb')
    expect(parseRoute(href)).toEqual({ kind: 'arbeitsbereich', workspaceId: 'a/b' })
  })
})
