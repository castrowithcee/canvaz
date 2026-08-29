/**
 * Verdichteter Boardzustand.
 *
 * Geprueft wird die Reihenfolge: von den gleichzeitig moeglichen Zustaenden muss der auftauchen, an dem
 * Arbeit haengt. Und es muss stimmen, was angekuendigt wird - ein gelungener Checkpoint darf eine
 * Sprachausgabe nicht im Sekundentakt unterbrechen.
 */

import { describe, expect, it } from 'vitest'

import { boardStatus, readOnlyReason } from '../../src/web/board/board-status.js'

const BASIS = {
  save: 'idle',
  savedAt: null,
  failure: null,
  connection: 'verbunden',
  attempt: 0,
  resyncedAt: null,
  viewOnly: false,
  preview: false,
} as const

describe('Verdichteter Boardzustand', () => {
  it('nennt live verbunden, solange nichts aussteht', () => {
    expect(boardStatus(BASIS)).toMatchObject({ text: 'Live', critical: false })
  })

  it('meldet den Konflikt vor allem anderen', () => {
    const status = boardStatus({ ...BASIS, save: 'conflict', connection: 'getrennt' })
    expect(status.text).toBe('Konflikt')
    expect(status.critical).toBe(true)
  })

  it('stellt den Verbindungsverlust vor den gewoehnlichen Speicherstand', () => {
    const status = boardStatus({ ...BASIS, save: 'dirty', connection: 'wiederverbinden', attempt: 2 })
    expect(status.text).toContain('Versuch 2')
    expect(status.critical).toBe(true)
  })

  it('kuendigt einen gelungenen Checkpoint nicht an', () => {
    const status = boardStatus({ ...BASIS, save: 'saved', savedAt: new Date(0) })
    expect(status.text).toMatch(/^Gespeichert /)
    expect(status.critical).toBe(false)
  })

  it('zeigt einer Vorschau ihren festen Stand statt eines Speicherzustands', () => {
    expect(boardStatus({ ...BASIS, preview: true, viewOnly: true, connection: 'getrennt' })).toMatchObject({
      text: 'Fester Stand',
      critical: false,
    })
  })

  it('zeigt einer nur lesenden Ansicht ihre Verbindung und keinen Speicherzustand', () => {
    expect(boardStatus({ ...BASIS, viewOnly: true, save: 'dirty' }).text).toBe('Live')
  })
})

describe('Grund fuer den Nur-Lesen-Modus', () => {
  const basis = {
    workspaceArchived: false,
    boardArchived: false,
    canWrite: true,
    guestViewer: false,
    previewOf: null,
  }

  it('ist ohne Grund null', () => {
    expect(readOnlyReason(basis)).toBeNull()
  })

  it('nennt die Vorschau vor jedem anderen Grund', () => {
    expect(readOnlyReason({ ...basis, previewOf: 7, workspaceArchived: true, canWrite: false })).toContain(
      'Version 7',
    )
  })

  it('nennt den archivierten Arbeitsbereich vor dem archivierten Board', () => {
    expect(readOnlyReason({ ...basis, workspaceArchived: true, boardArchived: true })).toContain(
      'Arbeitsbereich',
    )
  })
})
