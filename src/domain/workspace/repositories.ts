/**
 * Repository-Ports des Workspace-Moduls.
 *
 * Der Domain-Core beschreibt, was er von der Persistenz braucht; die PostgreSQL-Umsetzung liegt in
 * `src/persistence/workspace-store.ts` und ist die einzige Stelle mit SQL.
 *
 * Durchgehendes Muster: **es gibt keine Objektabfrage ohne Workspace- und Berechtigungsbezug.** Ein
 * Workspace wird nie allein ueber seine Kennung geladen, sondern immer zusammen mit der Rolle des fragenden
 * Nutzers (`findForUser`), und Mitgliedschaften werden ausschliesslich innerhalb eines Workspace gesucht.
 * Damit ist es gar nicht erst moeglich, einen geratenen Datensatz ohne Berechtigungsfilter zu erreichen.
 */

import type { UserId } from '../identity/model.js'
import type { Workspace, WorkspaceAccess, WorkspaceId, WorkspaceMembership, WorkspaceRole } from './model.js'

/** Mitglied samt Profilangaben fuer die Mitgliederliste. */
export type WorkspaceMember = WorkspaceMembership & {
  readonly displayName: string
  readonly email: string | null
}

/** Workspace samt eigener Rolle. In der Liste eines Nutzers ist die Rolle nie `null`. */
export type WorkspaceWithRole = {
  readonly workspace: Workspace
  readonly role: WorkspaceRole
}

export interface WorkspaceRepository {
  /** Ausschliesslich Workspaces, in denen der Nutzer Mitglied ist. Ein Systemadmin erbt hier nichts. */
  listForUser(userId: UserId): Promise<readonly WorkspaceWithRole[]>
  /** Workspace samt Rolle des fragenden Nutzers. `null` heisst: existiert nicht. */
  findForUser(id: WorkspaceId, userId: UserId): Promise<WorkspaceAccess | null>
  /**
   * Wie `findForUser`, sperrt die Workspacezeile aber bis zum Ende der Transaktion. Jede Aenderung an
   * Workspace oder Mitgliedschaften laeuft darueber, damit gleichzeitige Aenderungen serialisiert werden und
   * die Ownerinvariante nicht auf einem veralteten Stand entscheidet. Nur in einer Transaktion gueltig.
   */
  findForUpdate(id: WorkspaceId, userId: UserId): Promise<WorkspaceAccess | null>
  /** Legt Workspace und die Ownermitgliedschaft des Erstellers gemeinsam an. */
  create(name: string, ownerId: UserId): Promise<Workspace>
  rename(id: WorkspaceId, name: string): Promise<Workspace>
  setStatus(id: WorkspaceId, status: Workspace['status']): Promise<Workspace>
  listMembers(workspaceId: WorkspaceId): Promise<readonly WorkspaceMember[]>
  findMembership(workspaceId: WorkspaceId, userId: UserId): Promise<WorkspaceMembership | null>
  countOwners(workspaceId: WorkspaceId): Promise<number>
  /** Aktive interne Nutzer, die noch nicht Mitglied sind. Grundlage der Mitgliederauswahl. */
  listCandidates(workspaceId: WorkspaceId): Promise<readonly { readonly id: UserId; readonly displayName: string; readonly email: string | null }[]>
  addMember(workspaceId: WorkspaceId, userId: UserId, role: WorkspaceRole): Promise<WorkspaceMembership>
  setRole(workspaceId: WorkspaceId, userId: UserId, role: WorkspaceRole): Promise<WorkspaceMembership>
  removeMember(workspaceId: WorkspaceId, userId: UserId): Promise<void>
}

/**
 * Ein Auditereignis haelt fest, wer wann was an welchem Ziel getan hat. `details` traegt ausschliesslich
 * fachliche Metadaten der Aenderung - nie Tokenmaterial, nie Boardinhalte.
 */
export type NewAuditEvent = {
  readonly actorId: UserId
  readonly action: string
  readonly targetType: 'workspace' | 'membership'
  readonly targetId: string
  readonly workspaceId: WorkspaceId
  readonly details: Readonly<Record<string, string | number | boolean | null>>
}

export type AuditEvent = NewAuditEvent & {
  readonly id: string
  readonly occurredAt: Date
}

export interface AuditRepository {
  record(event: NewAuditEvent): Promise<AuditEvent>
  /** Abfragbarkeit ist gefordert, eine Leseansicht nicht: der Zugang laeuft ueber Tests und Betrieb. */
  listForWorkspace(workspaceId: WorkspaceId): Promise<readonly AuditEvent[]>
}

/** Die Mitgliedschaft besteht bereits (gleichzeitiges Hinzufuegen desselben Nutzers). */
export class MembershipConflictError extends Error {
  constructor(cause: unknown) {
    super('Die Mitgliedschaft besteht bereits', { cause })
    this.name = 'MembershipConflictError'
  }
}

/**
 * Aenderung und zugehoeriges Auditereignis entstehen gemeinsam oder gar nicht; die Ownerinvariante wird in
 * derselben Transaktion geprueft, in der sie geschrieben wird.
 */
export interface WorkspaceStore {
  readonly workspaces: WorkspaceRepository
  readonly audit: AuditRepository
  transaction<T>(run: (store: WorkspaceStore) => Promise<T>): Promise<T>
}
