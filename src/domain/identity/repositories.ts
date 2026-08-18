/**
 * Repository-Ports des Identity-Moduls.
 *
 * Der Domain-Core beschreibt hier, was er von der Persistenz braucht. Die PostgreSQL-Umsetzung liegt in
 * `src/persistence` und ist die einzige Stelle, die SQL kennt.
 */

import type {
  AuthenticatedSession,
  ExternalIdentity,
  ExternalIdentityId,
  ExternalIdentityKey,
  Session,
  SessionId,
  User,
  UserId,
  UserStatus,
} from './model.js'
import type { UserProfileDraft } from './provisioning.js'

export type LinkedIdentity = {
  readonly identity: ExternalIdentity
  readonly user: User
}

export type NewSession = {
  readonly userId: UserId
  /** Hash des Session-Geheimnisses. Das Geheimnis selbst verlaesst den Server nur im Cookie. */
  readonly tokenHash: string
  readonly expiresAt: Date
}

export interface UserRepository {
  findById(id: UserId): Promise<User | null>
  /** Bootstrap-Entscheidung der Provisionierung: die erste Anmeldung einer leeren Instanz wird Systemadmin. */
  count(): Promise<number>
  create(profile: UserProfileDraft, options: { readonly isSystemAdmin: boolean }): Promise<User>
  updateProfile(id: UserId, profile: UserProfileDraft): Promise<User>
  setStatus(id: UserId, status: UserStatus): Promise<User>
}

export interface ExternalIdentityRepository {
  /** Laedt Identitaet und zugehoerigen Nutzer in einem Schritt; beides wird immer gemeinsam gebraucht. */
  findByKey(key: ExternalIdentityKey): Promise<LinkedIdentity | null>
  link(userId: UserId, key: ExternalIdentityKey): Promise<ExternalIdentity>
  markSeen(id: ExternalIdentityId, seenAt: Date): Promise<void>
}

export interface SessionRepository {
  create(session: NewSession): Promise<Session>
  /**
   * Loest ein Session-Geheimnis auf. Liefert nur, was der Domain-Invariante `authenticate` genuegt:
   * lebende Session eines aktiven Nutzers. Alles andere ist `null`.
   */
  findAuthenticatedByTokenHash(tokenHash: string, now: Date): Promise<AuthenticatedSession | null>
  revoke(id: SessionId, revokedAt: Date): Promise<void>
  /** Widerruft alle Sessions eines Nutzers, etwa beim Deaktivieren. */
  revokeAllForUser(userId: UserId, revokedAt: Date): Promise<void>
  /** Raeumt abgelaufene Zeilen weg. Aufruf entscheidet der Betrieb, nicht die Domain. */
  deleteExpired(before: Date): Promise<number>
}

/**
 * Gebuendelter Zugang zur Identitaetspersistenz. `transaction` gibt dem Aufrufer Atomaritaet ueber mehrere
 * Repositories, ohne dass der Domain-Core die Datenbank kennt: die Provisionierung legt Nutzer, Verknuepfung
 * und Session entweder gemeinsam an oder gar nicht.
 */
export interface IdentityStore {
  readonly users: UserRepository
  readonly externalIdentities: ExternalIdentityRepository
  readonly sessions: SessionRepository
  transaction<T>(run: (store: IdentityStore) => Promise<T>): Promise<T>
}
