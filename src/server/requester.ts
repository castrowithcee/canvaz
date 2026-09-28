/**
 * Wer eine Anfrage oder eine Verbindung fuehrt.
 *
 * Es gibt genau zwei Moeglichkeiten: eine **interne Sitzung** eines angemeldeten Nutzers oder eine
 * **Gastsession** aus einem Freigabelink. Beide sind serverseitig, widerrufbar und an ein eigenes Cookie
 * gebunden; alles Weitere unterscheidet sich, und genau deshalb steht die Unterscheidung an einer Stelle
 * statt als `if` in jeder Route.
 *
 * Der wichtigste Dienst dieser Datei ist `boardSubject`: sie ist die **einzige** Stelle, an der aus einem
 * Anfragenden und einem geladenen Boarddatensatz ein Subjekt fuer `decideBoardAccess` wird. Routen und
 * Boardraeume bauen es damit nachweislich gleich - eine zweite, leicht abweichende Fassung waere genau die
 * Stelle, an der ein Gast einmal zu viel duerfte.
 */

import type { AuthenticatedGuest } from '../domain/board/guest.js'
import type { GuestRole } from '../domain/board/guest.js'
import type { BoardRole } from '../domain/board/model.js'
import type { BoardState, BoardSubject } from '../domain/board/policy.js'
import { guestSubject } from '../domain/board/policy.js'
import type { BoardViewer } from '../domain/board/repositories.js'
import type { AuthenticatedSession, User } from '../domain/identity/model.js'
import type { WorkspaceRole } from '../domain/workspace/model.js'
import type { LogFields } from './log.js'

export type Requester =
  | { readonly kind: 'user'; readonly auth: AuthenticatedSession }
  | { readonly kind: 'guest'; readonly guest: AuthenticatedGuest }

export function asRequester(auth: AuthenticatedSession): Requester {
  return { kind: 'user', auth }
}

/** Wie der Boarddatensatz geladen wird. Beide Kennungsraeume sind getrennt und werden nie vertauscht. */
export function viewerOf(requester: Requester): BoardViewer {
  return requester.kind === 'user'
    ? { kind: 'user', userId: requester.auth.user.id }
    : { kind: 'guest', guestSessionId: requester.guest.session.id }
}

/** Kennung der Sitzung - der internen oder der des Gastes. Grundlage von Widerruf und Verbindungszaehlung. */
export function sessionIdOf(requester: Requester): string {
  return requester.kind === 'user' ? requester.auth.session.id : requester.guest.session.id
}

/** Was im Teilnehmerfeld erscheint. Beim Gast der selbst gewaehlte Name, sonst das Profil. */
export function displayNameOf(requester: Requester): string {
  return requester.kind === 'user' ? requester.auth.user.displayName : requester.guest.session.displayName
}

/** Nur ein interner Nutzer kann Autor einer gespeicherten Szenenversion sein; ein Gast ist kein Nutzer. */
export function userOf(requester: Requester): User | null {
  return requester.kind === 'user' ? requester.auth.user : null
}

/**
 * Protokollfelder des Handelnden.
 *
 * Ein Gast hat keine Nutzerkennung; sein Bezug ist die Gastsession. **Kein Feld traegt hier je ein Token** -
 * weder das des Links noch das der Gastsession -, sondern ausschliesslich Kennungen aus der Datenbank.
 */
export function requesterFields(requester: Requester): LogFields {
  return requester.kind === 'user'
    ? { userId: requester.auth.user.id }
    : { guestSessionId: requester.guest.session.id, boardId: requester.guest.session.boardId }
}

/** Die beiden Rollenebenen, wie sie mit dem Board geladen wurden. */
export type BoardRoles = {
  readonly role: WorkspaceRole | null
  readonly boardRole: BoardRole | null
  readonly guestRole: GuestRole | null
  /** `null` steht fuer die Anlage und die Liste - da gibt es noch kein Board, ueber das zu entscheiden waere. */
  readonly board: BoardState | null
}

/**
 * Einzige Stelle, an der aus Anfragendem und geladenem Datensatz ein Subjekt der Boardpolicy wird.
 *
 * Die Rollen kommen **immer** aus demselben Ladevorgang wie das Board; nichts davon wird zwischengespeichert
 * oder aus einer frueheren Anfrage uebernommen. Bei einem Gast entsteht ein Grant nur dann, wenn sein Link
 * zu genau diesem geladenen Board noch gueltig ist - sonst steht er ohne jede Eingabe vor der Policy und
 * bekommt dieselbe Antwort wie fuer eine erfundene Kennung.
 */
export function boardSubject(requester: Requester, roles: BoardRoles): BoardSubject {
  if (requester.kind === 'guest') {
    const grant =
      roles.guestRole === null || roles.board === null ? null : { boardId: roles.board.id, role: roles.guestRole }
    return guestSubject(requester.guest.session.id, grant)
  }
  return {
    user: requester.auth.user,
    workspaceRole: roles.role,
    boardRole: roles.boardRole,
    guestGrant: null,
  }
}
