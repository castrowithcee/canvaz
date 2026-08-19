/**
 * Wie ein Board in einer Antwort aussieht.
 *
 * **Eine Stelle, zwei Sichten.** Ein internes Mitglied bekommt die vollstaendige `BoardView` samt
 * Workspacebezug, Ownerkennung und Owner-Anzeigename; ein Gast bekommt `GuestBoardView` - Titel, Status,
 * Version und seine eigene Rolle, also den Inhalt, den er bearbeitet, und sonst nichts.
 *
 * Der Grund fuer die eigene Datei ist die Erfahrung aus genau diesem Paket: solange jede Route ihren
 * Boardausschnitt selbst zusammensetzt, faellt irgendwann einer davon auf die volle Sicht zurueck und gibt
 * einem Externen eine Workspacekennung und den Namen eines internen Nutzers. Wer hier vorbeigeht, sieht die
 * Regel; wer `sceneResponseFor` benutzt, kann sie gar nicht erst uebergehen.
 *
 * **Die Rolle in der Antwort kommt aus der Policy, nicht aus dieser Datei.** `effectiveBoardRole` ist
 * dieselbe Funktion, aus der `decideBoardAccess` seine Stufe bildet; hier wird sie nur gestellt und
 * uebersetzt. Eine Route, die den Wert aus Rollenfeldern nachbaute, waere die zweite Fassung, die eines
 * Tages abweicht - deshalb nimmt jede Sicht den Anfragenden und den geladenen Zugriff entgegen und rechnet
 * selbst nichts aus.
 */

import type {
  BoardSceneResponse,
  BoardView,
  GuestBoardSceneResponse,
  GuestBoardView,
  SceneResponse,
} from '../contracts/api.js'
import type { SceneSnapshot } from '../contracts/scene.js'
import type { EffectiveBoardRole } from '../domain/board/policy.js'
import { effectiveBoardRole } from '../domain/board/policy.js'
import type { BoardAccess } from '../domain/board/repositories.js'
import type { Requester } from './requester.js'
import { boardSubject } from './requester.js'

/**
 * Effektive Rolle des Anfragenden auf diesem Board.
 *
 * Eine Boardsicht entsteht ausschliesslich, nachdem `board:read` erlaubt war - eine fehlende Rolle waere
 * deshalb ein Programmierfehler und keine Lage, die eine Antwort haette. Sie wird laut gemeldet, statt in
 * einen Standardwert zu fallen: geraten wird an dieser Stelle nichts.
 */
function viewerRoleOf(requester: Requester, access: BoardAccess): EffectiveBoardRole {
  const effective = effectiveBoardRole(boardSubject(requester, access), access.workspace, access.board)
  if (effective === null) {
    throw new Error('Boardsicht ohne Leserecht')
  }
  return effective
}

function memberRoleOf(requester: Requester, access: BoardAccess): EffectiveBoardRole & { kind: 'member' } {
  const effective = viewerRoleOf(requester, access)
  if (effective.kind !== 'member') {
    // Ein Gast bekommt nie die volle Boardsicht. Faende diese Stelle je einen, waere das der Fehler, den
    // diese Datei verhindern soll.
    throw new Error('Die volle Boardsicht gibt es nur fuer ein internes Mitglied')
  }
  return effective
}

export function toBoardView(requester: Requester, access: BoardAccess): BoardView {
  const { board } = access
  return {
    id: board.id,
    workspaceId: board.workspaceId,
    title: board.title,
    status: board.status,
    ownerUserId: board.ownerId,
    ownerDisplayName: access.ownerDisplayName,
    viewerRole: memberRoleOf(requester, access).role,
    sceneVersion: board.sceneVersion,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
  }
}

/**
 * Die Gastsicht entsteht durch **Aufbau, nicht durch Weglassen**: sie zaehlt ihre Felder einzeln auf, statt
 * aus der vollen Sicht etwas zu entfernen. Ein spaeter ergaenztes Feld der `BoardView` landet damit nicht
 * von selbst beim Gast.
 */
export function toGuestBoardView(requester: Requester, access: BoardAccess): GuestBoardView {
  const effective = viewerRoleOf(requester, access)
  if (effective.kind !== 'guest') {
    throw new Error('Die Gastsicht gibt es nur fuer eine Gastsession')
  }
  const { board } = access
  return {
    id: board.id,
    title: board.title,
    status: board.status,
    viewerRole: effective.role,
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
  access: BoardAccess,
  version: number,
  scene: SceneSnapshot,
): SceneResponse {
  if (requester.kind === 'guest') {
    const guest: GuestBoardSceneResponse = {
      viewer: 'guest',
      board: toGuestBoardView(requester, access),
      version,
      scene,
    }
    return guest
  }
  const member: BoardSceneResponse = {
    viewer: 'member',
    board: toBoardView(requester, access),
    version,
    scene,
  }
  return member
}
