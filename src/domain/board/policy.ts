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
 * Zwei unabhaengige Eingaben, in dieser Reihenfolge:
 *
 * 1. Die **Workspace-Mitgliedschaft**. Sie ist die Eintrittskarte: ohne Rolle im Arbeitsbereich gibt es
 *    keinen Boardzugriff, und **keine Boardrolle kann das umgehen**. Ein **Systemadmin ohne Mitgliedschaft**
 *    darf ebenfalls nicht: er verwaltet Arbeitsbereiche, damit keiner unadministrierbar wird; der
 *    Inhaltszugriff auf Boards haengt an der Mitgliedschaft und nicht an dieser Stufe. Fuer ihn sieht ein
 *    Board aus wie eine erfundene Kennung.
 * 2. Die **Boardrolle** (`BoardSubject.boardRole`). Sie verfeinert die Mitgliedschaft je Board: `viewer`
 *    liest, `editor` liest und speichert, `owner` verwaltet zusaetzlich die Freigaben und uebertraegt die
 *    Ownerschaft. Ohne ausdrueckliche Boardrolle gilt `editor` - ein Arbeitsbereich ist ein gemeinsamer
 *    Arbeitsraum, und eine Freigabe schraenkt darin gezielt ein oder benennt ausdruecklich, statt jedem
 *    Mitglied den Zugang erst einzeln zu eroeffnen.
 *
 * Der **Workspace-Owner** traegt auf jedem Board seines Arbeitsbereichs Ownerstufe. Ohne das waere ein
 * Board, dessen Owner den Arbeitsbereich verlassen hat oder deaktiviert wurde, dauerhaft unverwaltbar -
 * dieselbe Ueberlegung, aus der ein Systemadmin jeden Arbeitsbereich verwaltet.
 *
 * ## Andockpunkt fuer Gastfreigaben
 *
 * Gastlinks setzen **hier** an, nicht in der Workspace-Policy: `BoardSubject` bekommt ein weiteres,
 * unabhaengiges Feld (etwa `guestGrant`), und ein Gast steht dann ohne Mitgliedschaft und ohne Boardrolle
 * vor derselben Funktion. Vorbedingung, Ablehnungsgruende und Aufrufform in den Routen bleiben dabei
 * unveraendert.
 */

import type { WorkspaceStatus } from '../workspace/model.js'
import type { DenialReason, PolicySubject } from '../workspace/policy.js'
import { decideWorkspaceAccess } from '../workspace/policy.js'
import type { BoardRole, BoardStatus } from './model.js'

export type BoardState = {
  readonly status: BoardStatus
}

/**
 * Das Subjekt einer Boardentscheidung: der handelnde Nutzer mit seiner Workspacerolle **und** seiner
 * eigenen Rolle auf diesem Board. Beide Felder sind unabhaengig; `boardRole === null` heisst: keine
 * ausdrueckliche Boardrolle, es gilt die Mitgliedschaft.
 */
export type BoardSubject = PolicySubject & {
  readonly boardRole: BoardRole | null
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
  /** Freigaben anlegen, aendern und entziehen. */
  | 'grant:manage'
  /** Die Ownerschaft des Boards an ein anderes Mitglied uebergeben. */
  | 'board:transfer-ownership'

/** Die Gruende der Workspaceebene plus den einen, den erst ein Board haben kann. */
export type BoardDenialReason = DenialReason | 'board-archived'

export type BoardDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: BoardDenialReason }

const ALLOWED: BoardDecision = { allowed: true }

function denied(reason: BoardDenialReason): BoardDecision {
  return { allowed: false, reason }
}

/**
 * Effektive Stufe des Subjekts auf diesem Board.
 *
 * Der Workspace-Owner steht immer auf Ownerstufe (siehe oben). Sonst gilt die ausdrueckliche Boardrolle und
 * ohne sie `editor`. Die Mitgliedschaft selbst ist zu diesem Zeitpunkt bereits geprueft.
 */
function boardLevel(subject: BoardSubject): BoardRole {
  if (subject.workspaceRole === 'owner') {
    return 'owner'
  }
  return subject.boardRole ?? 'editor'
}

/**
 * Entscheidet eine Boardaktion. `board === null` steht fuer `board:create` - da gibt es noch kein Board.
 *
 * Die Reihenfolge ist bewusst: erst die Sichtbarkeit des Workspace (sie bestimmt, ob ueberhaupt eine
 * Existenz preisgegeben werden darf), dann die Mitgliedschaft, dann die beiden Archivzustaende, zuletzt die
 * Boardrolle. Ein archivierter Stand ist damit auch fuer einen Board-Owner unveraenderlich.
 */
export function decideBoardAccess(
  subject: BoardSubject,
  workspace: { readonly status: WorkspaceStatus },
  board: BoardState | null,
  action: BoardAction,
): BoardDecision {
  const visible = decideWorkspaceAccess(subject, workspace, { kind: 'workspace:read' })
  if (!visible.allowed) {
    return denied(visible.reason)
  }

  // Verwaltungsrechte sind keine Mitgliedschaft. Ein Systemadmin ohne Rolle im Workspace erfaehrt ueber die
  // Boards darin nichts - auch nicht, dass es sie gibt. Eine Boardrolle hilft ihm dabei nicht: sie wirkt
  // zusaetzlich zur Mitgliedschaft und nie an ihrer Stelle.
  if (subject.workspaceRole === null) {
    return denied('not-visible')
  }

  // Lesen darf jede Boardrolle, auch `viewer`.
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

  const level = boardLevel(subject)
  switch (action) {
    case 'grant:manage':
    case 'board:transfer-ownership':
      // Wer das Board verantwortet, entscheidet, wer daran arbeitet. Ein `editor` gibt sein Recht nicht
      // weiter, sonst waere die Abstufung mit einem Schritt wieder aufgehoben.
      return level === 'owner' ? ALLOWED : denied('insufficient-role')
    case 'board:create':
    case 'board:rename':
    case 'board:archive':
    case 'board:unarchive':
    case 'scene:write':
      // Inhalt und Stammdaten des Boards gehoeren zusammen: wer die Szene speichern darf, darf das Board
      // auch benennen und archivieren. Ein `viewer` darf beides nicht.
      return level === 'viewer' ? denied('insufficient-role') : ALLOWED
  }
}
