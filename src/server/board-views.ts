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
  BoardAccessOriginView,
  BoardSceneResponse,
  BoardView,
  DashboardBoardView,
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
    // Reine Ablage: sie steht in der Mitgliedssicht und **nicht** in der Gastsicht - ein Gast kennt genau
    // ein Board und erfaehrt ueber die Gliederung des Arbeitsbereichs nichts.
    folderId: board.folderId,
    viewerRole: memberRoleOf(requester, access).role,
    sceneVersion: board.sceneVersion,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
  }
}

/**
 * Zeile des Dashboards: die volle Boardsicht plus das, was erst die uebergreifende Liste braucht.
 *
 * Die **Herkunft des Zugriffs** wird hier aus demselben geladenen Zugriff abgeleitet, aus dem auch die
 * Rolle kommt, und nicht in der Route nachgebaut: Ownerschaft am Board, sonst die eigene Freigabezeile,
 * sonst allein die Mitgliedschaft im Arbeitsbereich. Sie ist eine **Auskunft ueber den eigenen Zugang** und
 * keine Berechtigung - entschieden wird weiterhin in der Policy.
 *
 * Von einem Gastlink steht hier ausschliesslich, **dass** es einen gibt. Weder Token noch Adresse noch die
 * Zahl der Gaeste gehen in eine Dashboardzeile ein.
 */
export function toDashboardBoardView(
  requester: Requester,
  access: BoardAccess,
  extras: {
    readonly workspaceName: string
    readonly sharedInternally: boolean
    readonly sharedExternally: boolean
  },
): DashboardBoardView {
  const board = toBoardView(requester, access)
  // `access.boardRole` ist die bereits aufgeloeste eigene Boardrolle: `owner` steht ausschliesslich fuer die
  // Ownerschaft am Board selbst, `null` fuer keinen eigenen Boardbezug. Die Stufe, die ein Workspace-Owner
  // zusaetzlich traegt, steht in `viewerRole` und faelscht die Herkunft deshalb nicht.
  const origin: BoardAccessOriginView =
    access.boardRole === 'owner' ? 'owner' : access.boardRole === null ? 'workspace' : 'grant'
  return {
    ...board,
    workspaceName: extras.workspaceName,
    accessOrigin: origin,
    sharedInternally: extras.sharedInternally,
    sharedExternally: extras.sharedExternally,
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
