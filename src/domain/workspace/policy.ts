/**
 * Zentrale effektive Berechtigungspruefung.
 *
 * Reine Funktion ohne IO und **standardmaessig verweigernd**: jede geschuetzte Serverstrecke entscheidet hier
 * und nirgends sonst. In den Routen steht deshalb kein `if (role === ...)`, sondern nur der Aufruf und die
 * Uebersetzung der Ablehnung in eine HTTP-Antwort. Was die Oberflaeche ausblendet, ist keine Grenze.
 *
 * Drei Eingaben bestimmen das Ergebnis: die Systemrolle, der Status des Nutzers und die Mitgliedschaft im
 * betroffenen Workspace. Der Zustand des Workspace kommt als vierte Eingabe dazu, weil ein archivierter
 * Workspace lesbar, aber unveraenderlich ist.
 *
 * ## Andockpunkt fuer Board- und Gastrechte
 *
 * Board- und Gastrechte sind eine eigene Ebene *unterhalb* des Workspace und aendern diese Funktion nicht:
 * `PolicySubject` bekommt spaeter weitere, unabhaengige Felder (etwa `boardRole`, `guestGrant`), und eine
 * eigene Funktion `decideBoardAccess` entscheidet Boardaktionen. Sie ruft `decideWorkspaceAccess` mit
 * `workspace:read` als Vorbedingung auf - wer den Workspace nicht sehen darf, sieht auch kein Board darin.
 * Diese Datei bleibt dabei unveraendert; sie kennt keine Boards und soll keine kennen.
 */

import type { UserId, UserStatus } from '../identity/model.js'
import type { WorkspaceRole, WorkspaceStatus } from './model.js'

/**
 * Der handelnde Nutzer mit seiner Rolle im betroffenen Workspace. `workspaceRole === null` heisst
 * Nichtmitglied - auch fuer einen Systemadmin, der ausdruecklich nicht automatisch Mitglied ist.
 */
export type PolicySubject = {
  readonly user: {
    readonly id: UserId
    readonly status: UserStatus
    readonly isSystemAdmin: boolean
  }
  readonly workspaceRole: WorkspaceRole | null
}

export type WorkspaceState = {
  readonly status: WorkspaceStatus
}

/**
 * Klar benannte Aktionen statt Rollenvergleichen. Mitgliedschaftsaktionen tragen die betroffenen Rollen mit,
 * weil eine Rollenaenderung ohne ihr Ziel nicht entscheidbar ist: ein Admin darf Mitglieder und Admins
 * verwalten, aber keinen Owner anfassen und keine Ownerrolle vergeben - sonst koennte er sich selbst
 * hochstufen und die Rangfolge waere wirkungslos.
 */
export type WorkspaceAction =
  /** Stammdaten und Mitgliederliste des Workspace lesen. */
  | { readonly kind: 'workspace:read' }
  | { readonly kind: 'workspace:rename' }
  | { readonly kind: 'workspace:archive' }
  | { readonly kind: 'workspace:unarchive' }
  /**
   * Ordner anlegen, umbenennen, verschieben und entfernen.
   *
   * Ordner sind **Struktur des Arbeitsbereichs** und folgen deshalb der Workspacerolle und nie einer
   * Boardrolle: sie ordnen, sie berechtigen nicht. Gelesen wird der Baum mit `workspace:read` - wer den
   * Arbeitsbereich sieht, sieht auch seine Gliederung -, geformt wird er von seiner Verwaltung. Ein
   * einzelnes Board legt weiterhin jedes Mitglied an; wo die Gliederung liegt, entscheidet die Leitung.
   */
  | { readonly kind: 'folder:manage' }
  | { readonly kind: 'member:add'; readonly role: WorkspaceRole }
  | { readonly kind: 'member:change-role'; readonly currentRole: WorkspaceRole; readonly nextRole: WorkspaceRole }
  | { readonly kind: 'member:remove'; readonly currentRole: WorkspaceRole }

export type DenialReason =
  /** Der Nutzer ist deaktiviert. Gilt unabhaengig von jeder Mitgliedschaft und von der Systemrolle. */
  | 'user-deactivated'
  /** Der Workspace darf fuer diesen Nutzer nicht einmal existieren. Die Antwort verraet ihn nicht. */
  | 'not-visible'
  /** Sichtbar, aber die Rolle traegt die Aktion nicht. */
  | 'insufficient-role'
  /** Erlaubt und sichtbar, aber der Workspace ist archiviert und damit unveraenderlich. */
  | 'workspace-archived'

export type PolicyDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: DenialReason }

const ALLOWED: PolicyDecision = { allowed: true }

function denied(reason: DenialReason): PolicyDecision {
  return { allowed: false, reason }
}

/** Ein Admin darf keine Mitgliedschaft anfassen, an der die Ownerrolle beteiligt ist. */
function mayManage(level: WorkspaceRole, ...involvedRoles: readonly WorkspaceRole[]): boolean {
  if (level === 'owner') {
    return true
  }
  return level === 'admin' && involvedRoles.every((role) => role !== 'owner')
}

export function decideWorkspaceAccess(
  subject: PolicySubject,
  workspace: WorkspaceState,
  action: WorkspaceAction,
): PolicyDecision {
  // Erste und staerkste Regel: ein deaktivierter Nutzer verliert jeden Zugriff, egal welche Mitgliedschaften
  // oder Systemrollen noch in der Datenbank stehen.
  if (subject.user.status !== 'active') {
    return denied('user-deactivated')
  }

  // Systemadministration ist Verwaltung, nicht Mitgliedschaft. Sie hebt die Verwaltungsstufe auf
  // Ownerniveau, damit ein Workspace nie unadministrierbar wird, macht den Systemadmin aber nirgends zum
  // Mitglied: seine eigene Workspaceliste bleibt leer, und der spaetere Inhaltszugriff auf Boards haengt an
  // der Mitgliedschaft, nicht an dieser Stufe.
  const level: WorkspaceRole | null = subject.user.isSystemAdmin ? 'owner' : subject.workspaceRole
  if (level === null) {
    return denied('not-visible')
  }

  if (action.kind === 'workspace:read') {
    return ALLOWED
  }

  // Archiviert heisst lesbar, aber unveraenderlich. Einzige Ausnahme ist das Entarchivieren selbst.
  if (workspace.status === 'archived' && action.kind !== 'workspace:unarchive') {
    return denied('workspace-archived')
  }

  switch (action.kind) {
    case 'workspace:rename':
    case 'folder:manage':
      return level === 'owner' || level === 'admin' ? ALLOWED : denied('insufficient-role')
    case 'workspace:archive':
    case 'workspace:unarchive':
      // Der Lebenszyklus des Workspace gehoert dem Owner; ein Admin verwaltet Inhalt und Mitglieder.
      return level === 'owner' ? ALLOWED : denied('insufficient-role')
    case 'member:add':
      return mayManage(level, action.role) ? ALLOWED : denied('insufficient-role')
    case 'member:change-role':
      return mayManage(level, action.currentRole, action.nextRole) ? ALLOWED : denied('insufficient-role')
    case 'member:remove':
      return mayManage(level, action.currentRole) ? ALLOWED : denied('insufficient-role')
  }
}
