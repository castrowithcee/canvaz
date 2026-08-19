/**
 * Wie ein Board in einer Antwort aussieht.
 *
 * **Eine Stelle, zwei Sichten.** Ein internes Mitglied bekommt die vollstaendige `BoardView` samt
 * Workspacebezug, Ownerkennung und Owner-Anzeigename; ein Gast bekommt `GuestBoardView` - Titel, Status und
 * Version, also den Inhalt, den er bearbeitet, und sonst nichts.
 *
 * Der Grund fuer die eigene Datei ist die Erfahrung aus genau diesem Paket: solange jede Route ihren
 * Boardausschnitt selbst zusammensetzt, faellt irgendwann einer davon auf die volle Sicht zurueck und gibt
 * einem Externen eine Workspacekennung und den Namen eines internen Nutzers. Wer hier vorbeigeht, sieht die
 * Regel; wer `sceneResponseFor` benutzt, kann sie gar nicht erst uebergehen.
 */

import type {
  BoardSceneResponse,
  BoardView,
  GuestBoardSceneResponse,
  GuestBoardView,
  SceneResponse,
} from '../contracts/api.js'
import type { SceneSnapshot } from '../contracts/scene.js'
import type { Board } from '../domain/board/model.js'
import type { Requester } from './requester.js'

export function toBoardView(board: Board, ownerDisplayName: string): BoardView {
  return {
    id: board.id,
    workspaceId: board.workspaceId,
    title: board.title,
    status: board.status,
    ownerUserId: board.ownerId,
    ownerDisplayName,
    sceneVersion: board.sceneVersion,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
  }
}

/**
 * Die Gastsicht entsteht durch **Aufbau, nicht durch Weglassen**: sie zaehlt ihre vier Felder einzeln auf,
 * statt aus der vollen Sicht etwas zu entfernen. Ein spaeter ergaenztes Feld der `BoardView` landet damit
 * nicht von selbst beim Gast.
 */
export function toGuestBoardView(board: Board): GuestBoardView {
  return {
    id: board.id,
    title: board.title,
    status: board.status,
    sceneVersion: board.sceneVersion,
  }
}

/**
 * Antwort des Szenenendpunkts, passend zur Art der Sitzung.
 *
 * Die Fallunterscheidung steht genau hier und nicht in der Route: sie waehlt keine Berechtigung aus - das
 * hat die Policy laengst getan -, sondern entscheidet, wie viel vom Board ueberhaupt in eine Antwort geraet.
 */
export function sceneResponseFor(
  requester: Requester,
  board: Board,
  ownerDisplayName: string,
  version: number,
  scene: SceneSnapshot,
): SceneResponse {
  if (requester.kind === 'guest') {
    const guest: GuestBoardSceneResponse = { viewer: 'guest', board: toGuestBoardView(board), version, scene }
    return guest
  }
  const member: BoardSceneResponse = {
    viewer: 'member',
    board: toBoardView(board, ownerDisplayName),
    version,
    scene,
  }
  return member
}
