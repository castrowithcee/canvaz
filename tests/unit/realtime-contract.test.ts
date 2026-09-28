/**
 * Der Nachrichtenvertrag ohne IO.
 *
 * `parseClientMessage` ist die einzige Stelle, an der aus einem Rahmen eine Nachricht wird. Was hier
 * durchkommt, erreicht den Raum - deshalb steht jede Ablehnung hier und nicht im Serverzweig.
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_CHANGE_ELEMENTS,
  MAX_CHANGE_FILE_IDS,
  MAX_PRESENCE_SELECTION,
  REALTIME_PROTOCOL_VERSION,
  parseClientMessage,
} from '../../src/contracts/realtime.js'

function parse(value: unknown) {
  return parseClientMessage(JSON.stringify(value))
}

describe('parseClientMessage', () => {
  it('nimmt einen Beitritt mit Protokollversion und Boardkennung an', () => {
    const result = parse({ type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId: 'b1' })

    expect(result).toEqual({
      ok: true,
      message: { type: 'join', protocolVersion: REALTIME_PROTOCOL_VERSION, boardId: 'b1' },
    })
  })

  it('benennt einen unbekannten Typ getrennt von einer fehlerhaften Struktur', () => {
    expect(parse({ type: 'board:drop', boardId: 'b1' })).toEqual({ ok: false, code: 'unbekannter-typ' })
    expect(parse({ type: 'join', boardId: 'b1' })).toEqual({ ok: false, code: 'ungueltige-nachricht' })
  })

  it('weist ab, was gar keine Nachricht ist', () => {
    expect(parseClientMessage('{kein json')).toEqual({ ok: false, code: 'ungueltige-nachricht' })
    expect(parseClientMessage('[]')).toEqual({ ok: false, code: 'ungueltige-nachricht' })
    expect(parseClientMessage('"join"')).toEqual({ ok: false, code: 'ungueltige-nachricht' })
    expect(parse({ boardId: 'b1' })).toEqual({ ok: false, code: 'ungueltige-nachricht' })
    expect(parse({ type: 'leave' })).toEqual({ ok: false, code: 'ungueltige-nachricht' })
    expect(parse({ type: 'leave', boardId: '' })).toEqual({ ok: false, code: 'ungueltige-nachricht' })
  })

  it('verlangt fuer eine Aenderung gueltige Elemente', () => {
    const gueltig = { id: 'a', version: 2, versionNonce: 7, type: 'rectangle' }

    expect(parse({ type: 'scene-change', boardId: 'b1', elements: [gueltig], appState: null, fileIds: [] })).toEqual({
      ok: true,
      message: { type: 'scene-change', boardId: 'b1', elements: [gueltig], appState: null, fileIds: [] },
    })
    // Ohne Version und Nonce kann die Reconciliation nicht entscheiden.
    expect(parse({ type: 'scene-change', boardId: 'b1', elements: [{ id: 'a' }], appState: null, fileIds: [] })).toEqual(
      { ok: false, code: 'ungueltige-nachricht' },
    )
    expect(parse({ type: 'scene-change', boardId: 'b1', elements: {}, appState: null, fileIds: [] })).toEqual({
      ok: false,
      code: 'ungueltige-nachricht',
    })
  })

  it('nimmt einen AppState nur vollstaendig an', () => {
    const appState = { viewBackgroundColor: '#fff', gridSize: null, gridModeEnabled: false, name: 'Board' }

    expect(
      parse({ type: 'scene-change', boardId: 'b1', elements: [], appState, fileIds: [] }),
    ).toEqual({ ok: true, message: { type: 'scene-change', boardId: 'b1', elements: [], appState, fileIds: [] } })
    expect(
      parse({ type: 'scene-change', boardId: 'b1', elements: [], appState: { name: 'Board' }, fileIds: [] }),
    ).toEqual({ ok: false, code: 'ungueltige-nachricht' })
  })

  it('verlangt fuer Presence einen endlichen Zeiger oder gar keinen', () => {
    expect(parse({ type: 'presence', boardId: 'b1', pointer: null, selectedElementIds: [] })).toEqual({
      ok: true,
      message: { type: 'presence', boardId: 'b1', pointer: null, selectedElementIds: [] },
    })
    expect(parse({ type: 'presence', boardId: 'b1', pointer: { x: 1, y: 2 }, selectedElementIds: ['a'] })).toEqual({
      ok: true,
      message: { type: 'presence', boardId: 'b1', pointer: { x: 1, y: 2 }, selectedElementIds: ['a'] },
    })
    expect(parse({ type: 'presence', boardId: 'b1', pointer: { x: 1 }, selectedElementIds: [] })).toEqual({
      ok: false,
      code: 'ungueltige-nachricht',
    })
    // `1e400` ist gueltiges JSON und wird beim Parsen zu Infinity.
    expect(parseClientMessage('{"type":"presence","boardId":"b1","pointer":{"x":1e400,"y":0},"selectedElementIds":[]}'))
      .toEqual({ ok: false, code: 'ungueltige-nachricht' })
    expect(parse({ type: 'presence', boardId: 'b1', pointer: null, selectedElementIds: [1] })).toEqual({
      ok: false,
      code: 'ungueltige-nachricht',
    })
  })

  it('lehnt zu viele Elemente benannt ab, statt die Liste zu kappen', () => {
    const element = (index: number) => ({ id: `e${String(index)}`, version: 1, versionNonce: index + 1 })
    const gerade = Array.from({ length: MAX_CHANGE_ELEMENTS }, (_, index) => element(index))
    const einesZuViel = [...gerade, element(MAX_CHANGE_ELEMENTS)]

    const angenommen = parse({ type: 'scene-change', boardId: 'b1', elements: gerade, appState: null, fileIds: [] })
    expect(angenommen.ok && angenommen.message.type === 'scene-change' && angenommen.message.elements).toHaveLength(
      MAX_CHANGE_ELEMENTS,
    )
    // Gekappt waere hier stiller Datenverlust: der Absender haelt seinen Stand fuer uebertragen.
    expect(parse({ type: 'scene-change', boardId: 'b1', elements: einesZuViel, appState: null, fileIds: [] })).toEqual({
      ok: false,
      code: 'zu-viele-elemente',
    })
  })

  it('kappt uebergrosse Listen von Anzeigehilfen, statt die Nachricht zu verwerfen', () => {
    const viele = Array.from({ length: MAX_PRESENCE_SELECTION + 50 }, (_, index) => `e${String(index)}`)
    const dateien = Array.from({ length: MAX_CHANGE_FILE_IDS + 10 }, (_, index) => `f${String(index)}`)

    const presence = parse({ type: 'presence', boardId: 'b1', pointer: null, selectedElementIds: viele })
    const change = parse({ type: 'scene-change', boardId: 'b1', elements: [], appState: null, fileIds: dateien })

    expect(presence.ok && presence.message.type === 'presence' && presence.message.selectedElementIds).toHaveLength(
      MAX_PRESENCE_SELECTION,
    )
    expect(change.ok && change.message.type === 'scene-change' && change.message.fileIds).toHaveLength(
      MAX_CHANGE_FILE_IDS,
    )
  })
})
