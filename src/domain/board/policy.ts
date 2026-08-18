/**
 * Effektive Berechtigungspruefung fuer Boards und Szenen.
 *
 * Reine Funktion ohne IO und **standardmaessig verweigernd**, genau wie `decideWorkspaceAccess`. Sie baut
 * darauf auf, statt sie umzubauen: `decideWorkspaceAccess(subject, workspace, { kind: 'workspace:read' })`
 * ist die Vorbedingung jeder Boardaktion - wer den Workspace nicht sehen darf, sieht auch kein Board darin.
 * `src/domain/workspace/policy.ts` kennt deshalb weiterhin keine Boards.
 *
 * ## Was in diesem Paket entscheidet
 *
 * Die **Workspace-Mitgliedschaft**. Owner, Admin und Member duerfen im aktiven Workspace jedes Board lesen,
 * anlegen, umbenennen, archivieren und seine Szene speichern.
 *
 * Ein **Systemadmin ohne Mitgliedschaft** darf das nicht. Er verwaltet Arbeitsbereiche, damit keiner
 * unadministrierbar wird; der Inhaltszugriff auf Boards haengt an der Mitgliedschaft und nicht an dieser
 * Stufe. Fuer ihn sieht ein Board deshalb aus wie eine erfundene Kennung.
 *
 * ## Andockpunkt fuer Issue 6 (Boardrollen und Gastlinks)
 *
 * Die feingranularen Boardrollen (`owner`, `editor`, `viewer`) und Gastlinks setzen **hier** an, nicht in
 * der Workspace-Policy: `BoardSubject` bekommt weitere, unabhaengige Felder (etwa `boardRole`, `guestGrant`),
 * und die Zeilen unter "Mitgliedschaft entscheidet" werden durch die feinere Abstufung ersetzt. Vorbedingung,
 * Ablehnungsgruende und Aufrufform in den Routen bleiben dabei unveraendert.
 */

import type { WorkspaceStatus } from '../workspace/model.js'
import type { DenialReason, PolicySubject } from '../workspace/policy.js'
import { decideWorkspaceAccess } from '../workspace/policy.js'
import type { BoardStatus } from './model.js'

export type BoardState = {
  readonly status: BoardStatus
}

export type BoardAction =
  /** Board in der Liste sehen, oeffnen und seine Szene laden. */
  | 'board:read'
  | 'board:create'
  | 'board:rename'
  | 'board:archive'
  | 'board:unarchive'
  /** Eine neue Szenenversion anlegen. */
  | 'scene:write'

/** Die Gruende der Workspaceebene plus den einen, den erst ein Board haben kann. */
export type BoardDenialReason = DenialReason | 'board-archived'

export type BoardDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: BoardDenialReason }

const ALLOWED: BoardDecision = { allowed: true }

function denied(reason: BoardDenialReason): BoardDecision {
  return { allowed: false, reason }
}

/**
 * Entscheidet eine Boardaktion. `board === null` steht fuer `board:create` - da gibt es noch kein Board.
 *
 * Die Reihenfolge ist bewusst: erst die Sichtbarkeit des Workspace (sie bestimmt, ob ueberhaupt eine
 * Existenz preisgegeben werden darf), dann die Mitgliedschaft, dann die beiden Archivzustaende.
 */
export function decideBoardAccess(
  subject: PolicySubject,
  workspace: { readonly status: WorkspaceStatus },
  board: BoardState | null,
  action: BoardAction,
): BoardDecision {
  const visible = decideWorkspaceAccess(subject, workspace, { kind: 'workspace:read' })
  if (!visible.allowed) {
    return denied(visible.reason)
  }

  // Verwaltungsrechte sind keine Mitgliedschaft. Ein Systemadmin ohne Rolle im Workspace erfaehrt ueber die
  // Boards darin nichts - auch nicht, dass es sie gibt.
  if (subject.workspaceRole === null) {
    return denied('not-visible')
  }

  if (action === 'board:read') {
    return ALLOWED
  }

  // Ein archivierter Workspace ist vollstaendig unveraenderlich; auch seine Boards.
  if (workspace.status === 'archived') {
    return denied('workspace-archived')
  }

  // Ein archiviertes Board bleibt lesbar. Aenderbar ist nur noch die Archivierung selbst.
  if (board !== null && board.status === 'archived' && action !== 'board:unarchive') {
    return denied('board-archived')
  }

  // Ab hier entscheidet in diesem Paket die Mitgliedschaft, und die steht bereits fest. Issue 6 ersetzt
  // genau diese Zeile durch die Abstufung nach Boardrolle und Gastrecht.
  return ALLOWED
}
