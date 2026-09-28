/**
 * Die Ableitungen des Explorers ueber dem einen geladenen Stand.
 *
 * Sie ersetzen die frueheren Einzelabfragen je Ordner und muessen deshalb **dieselben drei Werte** tragen
 * wie der Endpunkt: keine Wahl alle Boards, `root` die ohne Ordner, eine Kennung genau diesen Ordner ohne
 * seine Unterordner. Die Erwartungen sind ausgeschrieben und nicht aus derselben Regel abgeleitet.
 */

import { describe, expect, it } from 'vitest'

import type { BoardView, FolderView } from '../../src/contracts/api.js'
import { BOARD_FOLDER_ROOT } from '../../src/contracts/api.js'
import { boardsOfSelection, childFolders, folderPath, matchesTitle } from '../../src/web/explorer.js'

const ZEIT = '2026-01-01T00:00:00.000Z'

function ordner(id: string, parentId: string | null, name: string): FolderView {
  return { id, workspaceId: 'w-1', parentId, name, createdAt: ZEIT, updatedAt: ZEIT }
}

function board(id: string, folderId: string | null, title: string): BoardView {
  return {
    id,
    workspaceId: 'w-1',
    title,
    status: 'active',
    ownerUserId: 'u-1',
    ownerDisplayName: 'Ada',
    folderId,
    viewerRole: 'owner',
    sceneVersion: 0,
    createdAt: ZEIT,
    updatedAt: ZEIT,
  }
}

const ORDNER = [ordner('f1', null, 'Kunden'), ordner('f2', 'f1', 'Nord'), ordner('f3', null, 'Intern')]
const BOARDS = [board('b1', null, 'Frei'), board('b2', 'f1', 'Angebot'), board('b3', 'f2', 'Nordplan')]

describe('Ableitungen des Explorers', () => {
  it('nennt ohne Ordnerwahl alle Boards des Arbeitsbereichs', () => {
    expect(boardsOfSelection(BOARDS, null).map((entry) => entry.id)).toEqual(['b1', 'b2', 'b3'])
  })

  it('nennt zu "root" genau die Boards ohne Ordner', () => {
    expect(boardsOfSelection(BOARDS, BOARD_FOLDER_ROOT).map((entry) => entry.id)).toEqual(['b1'])
  })

  it('nennt zu einem Ordner nur seinen eigenen Inhalt, nicht den seiner Unterordner', () => {
    expect(boardsOfSelection(BOARDS, 'f1').map((entry) => entry.id)).toEqual(['b2'])
    expect(boardsOfSelection(BOARDS, 'f2').map((entry) => entry.id)).toEqual(['b3'])
  })

  it('nennt nur die unmittelbaren Unterordner eines Knotens', () => {
    expect(childFolders(ORDNER, null).map((entry) => entry.id)).toEqual(['f1', 'f3'])
    expect(childFolders(ORDNER, 'f1').map((entry) => entry.id)).toEqual(['f2'])
    expect(childFolders(ORDNER, 'f2')).toEqual([])
  })

  it('legt den Weg zu einem Ordner von aussen nach innen', () => {
    expect(folderPath(ORDNER, 'f2').map((entry) => entry.name)).toEqual(['Kunden', 'Nord'])
    expect(folderPath(ORDNER, null)).toEqual([])
    // Eine Kennung, die der Baum nicht (mehr) kennt, ergibt keinen Weg statt einer Endlosschleife.
    expect(folderPath(ORDNER, 'weg')).toEqual([])
  })

  it('filtert Titel wie der Endpunkt: Teilzeichenkette ohne Ruecksicht auf Gross- und Kleinschreibung', () => {
    expect(matchesTitle('Nordplan', '')).toBe(true)
    expect(matchesTitle('Nordplan', 'ordp')).toBe(true)
    expect(matchesTitle('Nordplan', 'NORD')).toBe(true)
    expect(matchesTitle('Nordplan', 'sued')).toBe(false)
  })
})
