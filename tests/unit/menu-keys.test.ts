/**
 * Tastaturweg durch ein Aktionsmenue.
 *
 * Geprueft wird die reine Rechnung hinter der Fokusfuehrung: die Liste ist ein Ring, `Home` und `End` sind
 * die Enden, und alles andere gehoert nicht dem Menue - es muss beim Ausloeser oder der Seite ankommen.
 */

import { describe, expect, it } from 'vitest'

import { nextMenuIndex } from '../../src/web/overlays.js'

describe('nextMenuIndex', () => {
  it('laeuft im Ring vorwaerts und rueckwaerts', () => {
    expect(nextMenuIndex(0, 3, 'ArrowDown')).toBe(1)
    expect(nextMenuIndex(2, 3, 'ArrowDown')).toBe(0)
    expect(nextMenuIndex(0, 3, 'ArrowUp')).toBe(2)
  })

  it('springt an die Enden', () => {
    expect(nextMenuIndex(1, 3, 'Home')).toBe(0)
    expect(nextMenuIndex(1, 3, 'End')).toBe(2)
  })

  it('beginnt ohne Fokus im Menue beim ersten Eintrag', () => {
    // -1 heisst: der Fokus steht noch auf dem Ausloeser.
    expect(nextMenuIndex(-1, 3, 'ArrowDown')).toBe(0)
    expect(nextMenuIndex(-1, 3, 'ArrowUp')).toBe(2)
  })

  it('laesst fremde Tasten und ein leeres Menue durch', () => {
    expect(nextMenuIndex(0, 3, 'Tab')).toBeNull()
    expect(nextMenuIndex(0, 3, 'a')).toBeNull()
    expect(nextMenuIndex(0, 0, 'ArrowDown')).toBeNull()
  })
})
