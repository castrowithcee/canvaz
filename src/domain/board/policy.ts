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
 * ## Gastfreigaben
 *
 * Gastlinks setzen **hier** an und nicht in der Workspace-Policy: `BoardSubject` traegt dafuer das dritte,
 * unabhaengige Feld `guestGrant`. Ein Gast steht ohne Mitgliedschaft und ohne Boardrolle vor derselben
 * Funktion, und sein Grant ist **die einzige** Eingabe, die fuer ihn zaehlt:
 *
 * - Er gilt fuer **genau ein Board**. Jedes andere Board ist fuer ihn nicht vorhanden - auch eines im
 *   selben Arbeitsbereich, auch eines, dessen Kennung er kennt.
 * - `guest-viewer` liest, `guest-editor` liest und speichert. Umbenennen, Archivieren, Freigabeverwaltung
 *   und Ownerschaft sind fuer einen Gast **in keinem Zustand** erreichbar.
 * - Archiviert heisst auch fuer ihn: lesbar, aber unveraenderlich - und das Entarchivieren selbst bleibt
 *   ihm ebenfalls verwehrt.
 *
 * Der Gastweg und der Weg des internen Nutzers schliessen sich aus: `guestSubject` ist die einzige Stelle,
 * die ein Gastsubjekt baut, und sie setzt weder Mitgliedschaft noch Boardrolle. Vorbedingung,
 * Ablehnungsgruende und Aufrufform in den Routen bleiben unveraendert.
 */

import type { WorkspaceRole, WorkspaceStatus } from '../workspace/model.js'
import type { DenialReason, PolicySubject } from '../workspace/policy.js'
import { decideWorkspaceAccess } from '../workspace/policy.js'
import type { GuestRole, GuestSessionId } from './guest.js'
import { guestMayWrite } from './guest.js'
import type { BoardId, BoardRole, BoardStatus } from './model.js'

/**
 * Der Zustand des betroffenen Boards. Die Kennung gehoert dazu, weil ein Gastgrant genau ein Board meint -
 * ohne sie koennte die Policy nicht selbst pruefen, ob es dasselbe ist, und muesste sich darauf verlassen,
 * dass die Route das Richtige geladen hat.
 */
export type BoardState = {
  readonly id: BoardId
  readonly status: BoardStatus
}

/**
 * Berechtigung eines Gastes aus einem Freigabelink: eine Rolle fuer genau ein Board.
 *
 * Sie steht **neben** Mitgliedschaft und Boardrolle und nie an ihrer Stelle - beide sind bei einem Gast
 * leer, und keine Rolle der internen Ebene laesst sich daraus ableiten.
 */
export type BoardGuestGrant = {
  readonly boardId: BoardId
  readonly role: GuestRole
}

/**
 * Das Subjekt einer Boardentscheidung: der handelnde Nutzer mit seiner Workspacerolle **und** seiner
 * eigenen Rolle auf diesem Board. Beide Felder sind unabhaengig; `boardRole === null` heisst: keine
 * ausdrueckliche Boardrolle, es gilt die Mitgliedschaft.
 */
export type BoardSubject = PolicySubject & {
  readonly boardRole: BoardRole | null
  /** `null` heisst: kein Gast. Ist das Feld gesetzt, entscheidet ausschliesslich der Gastweg. */
  readonly guestGrant: BoardGuestGrant | null
}

/**
 * Einzige Stelle, die ein Gastsubjekt baut.
 *
 * Ein Gast hat kein Nutzerprofil. Das Pflichtfeld `user` traegt deshalb allein die Kennung seiner
 * Gastsession, damit ein Aufrufer nichts erfinden muss; **gelesen wird es auf dem Gastweg nie** - weder
 * Status noch Systemrolle spielen dort eine Rolle, weil ein Gast beides nicht haben kann. Mitgliedschaft
 * und Boardrolle bleiben leer: ein Gast bekommt niemals eine interne Stufe.
 *
 * `grant === null` steht fuer einen Gast ohne gueltigen Link. Er ergibt ein Subjekt ohne jede Eingabe und
 * damit die Ablehnung `not-visible` - dieselbe Antwort wie fuer eine erfundene Boardkennung.
 */
export function guestSubject(guestSessionId: GuestSessionId, grant: BoardGuestGrant | null): BoardSubject {
  return {
    user: { id: guestSessionId, status: 'active', isSystemAdmin: false },
    workspaceRole: null,
    boardRole: null,
    guestGrant: grant,
  }
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
  /** Einen frueheren Stand als neuen aktuellen Stand wiederherstellen. */
  | 'scene:restore'
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
 * Die effektive Rolle des Anfragenden auf einem Board - genau die, mit der `decideBoardAccess` entscheidet.
 *
 * Sie traegt ihre Herkunft mit: intern eine Boardrolle, als Gast eine Gastrolle. Beide Ebenen mischen sich
 * auch hier nicht, und niemand kann eine Gastrolle versehentlich als interne Stufe lesen.
 */
export type EffectiveBoardRole =
  | { readonly kind: 'member'; readonly role: BoardRole }
  | { readonly kind: 'guest'; readonly role: GuestRole }

/**
 * Traegt diese Rolle Aenderungen am Board?
 *
 * Genau die Frage, die `decideBoardAccess` fuer `scene:write`, `board:rename` und die beiden Archivaktionen
 * stellt - deshalb steht sie hier einmal und wird von der Entscheidung selbst benutzt. Der Zustand von
 * Board und Arbeitsbereich geht **nicht** ein: archiviert heisst unveraenderlich, und das entscheidet
 * `decideBoardAccess` davor.
 */
export function mayChangeBoard(effective: EffectiveBoardRole): boolean {
  return effective.kind === 'guest' ? guestMayWrite(effective.role) : effective.role !== 'viewer'
}

/**
 * Traegt diese Rolle die Verantwortung fuer das Board - Freigaben, Gastlinks und Ownerschaft?
 *
 * Nur der Owner. Ein `editor` gibt sein Recht nicht weiter, und einem Gast ist die Verwaltung in jedem
 * Zustand verwehrt.
 */
export function mayManageBoard(effective: EffectiveBoardRole): boolean {
  return effective.kind === 'member' && effective.role === 'owner'
}

/**
 * Traegt diese Rolle die Wiederherstellung eines frueheren Standes?
 *
 * Wer das Board verantwortet - **und zusaetzlich die Verwaltung des Arbeitsbereichs**. Eine
 * Wiederherstellung setzt den Inhalt eines Boards auf einen frueheren Stand zurueck; das ist keine laufende
 * Bearbeitung, sondern eine Korrektur, und sie gehoert denen, die fuer den Bestand einstehen. Ein `editor`
 * darf sie deshalb nicht, obwohl er jede einzelne Zeichnung aendern koennte.
 *
 * Der Workspace-`admin` bekommt sie als einziger Fall zusaetzlich zur Boardstufe: er verwaltet den
 * Arbeitsbereich, damit dessen Bestand nicht an einer einzelnen Person haengt - dieselbe Ueberlegung, aus
 * der ein Workspace-Owner auf jedem Board Ownerstufe traegt. Freigaben, Gastlinks und Ownerschaft bleiben
 * ihm weiterhin verwehrt; sie sind Verantwortung fuer das einzelne Board, nicht fuer seinen Bestand.
 *
 * Einem Gast ist sie in jedem Zustand verwehrt: `mayManageBoard` schliesst ihn aus, und eine
 * Workspacerolle hat er nicht.
 */
export function mayRestoreBoard(effective: EffectiveBoardRole, workspaceRole: WorkspaceRole | null): boolean {
  return mayManageBoard(effective) || (effective.kind === 'member' && workspaceRole === 'admin')
}

/**
 * Entscheidet die Aktion eines Gastes.
 *
 * Dieselbe Reihenfolge wie im internen Weg - erst Sichtbarkeit, dann die beiden Archivzustaende, zuletzt
 * die Rolle -, aber mit einer anderen ersten Frage: nicht "ist er Mitglied?", sondern "gilt sein Link
 * ueberhaupt fuer dieses Board?". Alles andere ist fuer ihn nicht vorhanden.
 */
function decideGuestAccess(
  grant: BoardGuestGrant,
  workspace: { readonly status: WorkspaceStatus },
  board: BoardState | null,
  action: BoardAction,
): BoardDecision {
  // Ohne Board gibt es keinen Bezug, den ein Gastgrant treffen koennte - `board:create` ist fuer ihn
  // schlicht keine Aktion. Und ein anderes Board als das seine sieht fuer ihn aus wie eine erfundene
  // Kennung; dass es existiert, erfaehrt er nicht.
  if (board === null || board.id !== grant.boardId) {
    return denied('not-visible')
  }

  if (action === 'board:read') {
    return ALLOWED
  }

  if (workspace.status === 'archived') {
    return denied('workspace-archived')
  }

  // Anders als intern gibt es hier keine Ausnahme fuer `board:unarchive`: ein Gast entarchiviert nichts,
  // und die Ablehnung nennt trotzdem den Zustand, der zuerst dagegen steht.
  if (board.status === 'archived') {
    return denied('board-archived')
  }

  // Nur die Szene, und die auch nur mit ausdruecklichem Schreibrecht. Stammdaten, Freigaben und
  // Ownerschaft eines Boards gehoeren dem Arbeitsbereich - ein Gast gehoert ihm nicht an.
  if (action === 'scene:write') {
    return mayChangeBoard({ kind: 'guest', role: grant.role }) ? ALLOWED : denied('insufficient-role')
  }
  return denied('insufficient-role')
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
  // Ein Gast steht vor derselben Funktion, aber auf einem eigenen Weg: er hat keine Mitgliedschaft, und
  // `decideWorkspaceAccess` wuerde ihn deshalb sofort als Nichtmitglied abweisen. Seine Grenze ist der
  // Link, nicht der Arbeitsbereich.
  if (subject.guestGrant !== null) {
    return decideGuestAccess(subject.guestGrant, workspace, board, action)
  }

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

  const level: EffectiveBoardRole = { kind: 'member', role: boardLevel(subject) }
  switch (action) {
    case 'scene:restore':
      // Eigene Frage, eigene Antwort: die Wiederherstellung ist eine Korrektur am Bestand und nicht die
      // naechste Zeichnung. Sie traegt deshalb mehr als `scene:write` und weniger als `grant:manage`.
      return mayRestoreBoard(level, subject.workspaceRole) ? ALLOWED : denied('insufficient-role')
    case 'grant:manage':
    case 'board:transfer-ownership':
      // Wer das Board verantwortet, entscheidet, wer daran arbeitet. Ein `editor` gibt sein Recht nicht
      // weiter, sonst waere die Abstufung mit einem Schritt wieder aufgehoben.
      return mayManageBoard(level) ? ALLOWED : denied('insufficient-role')
    case 'board:create':
    case 'board:rename':
    case 'board:archive':
    case 'board:unarchive':
    case 'scene:write':
      // Inhalt und Stammdaten des Boards gehoeren zusammen: wer die Szene speichern darf, darf das Board
      // auch benennen und archivieren. Ein `viewer` darf beides nicht.
      return mayChangeBoard(level) ? ALLOWED : denied('insufficient-role')
  }
}

/**
 * Die effektive Rolle des Anfragenden, hergeleitet aus **derselben** Entscheidung, die auch die Aktionen
 * traegt: erst `board:read` - wer nicht lesen darf, hat auf diesem Board keine Rolle (`null`) -, dann die
 * Stufe, mit der `decideBoardAccess` weiterrechnet.
 *
 * Sie wird nirgends sonst gebildet. Eine Route, die sie aus Rollenfeldern nachbaut, waere genau die zweite
 * Fassung, die eines Tages von der Entscheidung abweicht; eine Anzeige, die daraus Faehigkeiten ableitet,
 * benutzt `mayChangeBoard` und `mayManageBoard` und damit wieder dieselben Regeln.
 *
 * Der **Archivzustand geht nicht ein**. Er ist eine eigene, ohnehin sichtbare Eigenschaft des Boards und
 * seines Arbeitsbereichs; ihn in die Rolle zu falten wuerde aus einem Owner scheinbar einen Viewer machen,
 * der dann nicht einmal mehr entarchivieren duerfte.
 */
export function effectiveBoardRole(
  subject: BoardSubject,
  workspace: { readonly status: WorkspaceStatus },
  board: BoardState,
): EffectiveBoardRole | null {
  if (!decideBoardAccess(subject, workspace, board, 'board:read').allowed) {
    return null
  }
  return subject.guestGrant === null
    ? { kind: 'member', role: boardLevel(subject) }
    : { kind: 'guest', role: subject.guestGrant.role }
}
