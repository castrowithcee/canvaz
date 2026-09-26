/**
 * Fachliche Workspace-Modelle.
 *
 * Reiner Domain-Core: keine Datenbank, kein HTTP. Ein Workspace ist die aeussere Grenze aller fachlichen
 * Daten - jeder Datensatz spaeterer Pakete haengt an genau einem Workspace, und jede Berechtigung wird
 * gegen diese Grenze entschieden.
 */

import type { UserId } from '../identity/model.js'

export type WorkspaceId = string

/** Archiviert heisst: lesbar, aber unveraenderlich. Nur das Entarchivieren selbst bleibt moeglich. */
export type WorkspaceStatus = 'active' | 'archived'

/**
 * Bestaetigte Workspace-Rollen. Boardrollen und Gastrollen sind eine eigene Ebene und kommen in einem
 * spaeteren Paket; sie gehoeren bewusst nicht in diese Aufzaehlung.
 */
export type WorkspaceRole = 'owner' | 'admin' | 'member'

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member']

export type Workspace = {
  readonly id: WorkspaceId
  readonly name: string
  readonly status: WorkspaceStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type WorkspaceMembership = {
  readonly workspaceId: WorkspaceId
  readonly userId: UserId
  readonly role: WorkspaceRole
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** Workspace samt Rolle des fragenden Nutzers. `role === null` heisst Nichtmitglied. */
export type WorkspaceAccess = {
  readonly workspace: Workspace
  readonly role: WorkspaceRole | null
}

export const MAX_WORKSPACE_NAME_LENGTH = 80

/** `null` bedeutet: leer oder zu lang. Die gleiche Regel gilt fuer Anlage und Umbenennung. */
export function normalizeWorkspaceName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const name = raw.trim().replace(/\s+/g, ' ')
  return name.length === 0 || name.length > MAX_WORKSPACE_NAME_LENGTH ? null : name
}

export function parseWorkspaceRole(raw: unknown): WorkspaceRole | null {
  return WORKSPACE_ROLES.find((candidate) => candidate === raw) ?? null
}

/**
 * Invariante: ein Workspace hat immer mindestens einen Owner.
 *
 * `nextRole === null` steht fuer das Entfernen der Mitgliedschaft. Die Zahl der Owner muss aus derselben
 * Transaktion stammen, in der die Aenderung geschrieben wird - sonst entscheidet die Funktion auf einem
 * veralteten Stand.
 */
export function leavesWorkspaceWithoutOwner(
  ownerCount: number,
  currentRole: WorkspaceRole,
  nextRole: WorkspaceRole | null,
): boolean {
  return currentRole === 'owner' && nextRole !== 'owner' && ownerCount <= 1
}
