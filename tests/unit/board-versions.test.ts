/**
 * Zeilenhandlungen des Versionsverlaufs.
 *
 * Reine Rechnung: "Ansehen" gibt es immer, "Wiederherstellen" nur mit dem Recht dazu und nie auf den
 * aktuellen Stand selbst.
 */

import { describe, expect, it } from 'vitest'

import { versionRowActions } from '../../src/web/board-versions.js'

describe('versionRowActions', () => {
  it('bietet Wiederherstellen bei einer aelteren Version mit dem Recht dazu', () => {
    expect(versionRowActions(false, true)).toEqual({ view: true, restore: true })
  })

  it('bietet kein Wiederherstellen ohne das Recht dazu', () => {
    expect(versionRowActions(false, false)).toEqual({ view: true, restore: false })
  })

  it('bietet kein Wiederherstellen auf den aktuellen Stand, selbst mit dem Recht dazu', () => {
    expect(versionRowActions(true, true)).toEqual({ view: true, restore: false })
  })

  it('bietet kein Wiederherstellen auf den aktuellen Stand ohne das Recht dazu', () => {
    expect(versionRowActions(true, false)).toEqual({ view: true, restore: false })
  })
})
