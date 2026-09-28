/**
 * Verdichteter Boardzustand.
 *
 * Geprueft wird die Reihenfolge: von den gleichzeitig moeglichen Zustaenden muss der auftauchen, an dem
 * Arbeit haengt. Und es muss stimmen, was angekuendigt wird - ein gelungener Checkpoint darf eine
 * Sprachausgabe nicht im Sekundentakt unterbrechen.
 */

import { describe, expect, it } from 'vitest'

import { boardActions, boardStatus, readOnlyReason, sessionDetails } from '../../src/web/board/board-status.js'

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

  it('zeigt einen gelungenen Checkpoint nur als Symbol und kuendigt ihn nicht an', () => {
    const status = boardStatus({ ...BASIS, save: 'saved', savedAt: new Date(0) })
    expect(status).toMatchObject({ text: 'Gespeichert', symbol: 'saved', critical: false })
    expect(status.detail).toMatch(/^Gespeichert um /)
  })

  it('schreibt ungesicherte Aenderungen aus, live ausstehende nicht', () => {
    expect(boardStatus({ ...BASIS, save: 'dirty' })).toMatchObject({ symbol: 'saving', critical: false })
    expect(boardStatus({ ...BASIS, save: 'dirty', connection: 'verbindet' })).toMatchObject({
      text: 'Nicht gespeichert',
      symbol: null,
      critical: true,
    })
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

describe('Speicher- und Verbindungsdetails', () => {
  it('behaelt den letzten gespeicherten Stand und nennt einer Vorschau keine Verbindung', () => {
    const details = sessionDetails({
      lastSavedAt: new Date(0),
      connection: 'verbunden',
      attempt: 0,
      resyncedAt: null,
      preview: false,
    })
    expect(details.saved).toMatch(/^Zuletzt gespeichert um /)
    expect(details.connection).toBe('Live verbunden.')
    const vorschau = sessionDetails({
      lastSavedAt: null,
      connection: 'getrennt',
      attempt: 0,
      resyncedAt: null,
      preview: true,
    })
    expect(vorschau).toEqual({
      saved: 'In dieser Sitzung noch nicht gespeichert.',
      connection: 'Vorschau: nicht live verbunden.',
    })
  })
})

describe('Hervorgehobene Aktion der schwebenden Gruppe', () => {
  const basis = {
    save: 'idle',
    connection: 'verbunden',
    viewOnly: false,
    preview: false,
    shareable: true,
  } as const

  it('hebt hoechstens eine Aktion hervor und zeigt "Jetzt speichern" nur, wo gehandelt werden muss', () => {
    expect(boardActions(basis)).toEqual({ saveNow: false, primary: 'share' })
    expect(boardActions({ ...basis, save: 'dirty', connection: 'getrennt' })).toEqual({
      saveNow: true,
      primary: 'save',
    })
    expect(boardActions({ ...basis, save: 'failed' })).toEqual({ saveNow: true, primary: 'save' })
    expect(boardActions({ ...basis, save: 'conflict', connection: 'getrennt' })).toEqual({
      saveNow: false,
      primary: 'reload',
    })
    expect(boardActions({ ...basis, preview: true, viewOnly: true, shareable: false })).toEqual({
      saveNow: false,
      primary: 'current',
    })
    expect(boardActions({ ...basis, save: 'dirty', connection: 'verbindet' })).toEqual({
      saveNow: false,
      primary: 'share',
    })
    expect(boardActions({ ...basis, save: 'dirty', connection: 'wiederverbinden' })).toEqual({
      saveNow: false,
      primary: 'share',
    })
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
