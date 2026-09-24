/**
 * Repository-Ports des Identity-Moduls.
 *
 * Der Domain-Core beschreibt hier, was er von der Persistenz braucht. Die PostgreSQL-Umsetzung liegt in
 * `src/persistence` und ist die einzige Stelle, die SQL kennt.
 */

import type { AppearanceView, LibraryView } from '../../contracts/api.js'
import type { LibraryItem } from '../../contracts/library.js'
import type { LocalCredential, UserInvitation, UserInvitationId } from './local-auth.js'
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

/**
 * Ein gleichzeitiger Vorgang hat dieselbe Eindeutigkeit zuerst belegt - dieselbe Adresse oder dieselbe
 * externe Identitaet. Fachlich ein erwarteter Konflikt, kein Fehler: der Aufrufer loest ihn auf, indem er
 * den Vorgang noch einmal beginnt und den inzwischen vorhandenen Stand vorfindet.
 */
export class IdentityConflictError extends Error {
  constructor(cause: unknown) {
    super('Ein gleichzeitiger Vorgang hat dieselbe Eindeutigkeit belegt', { cause })
    this.name = 'IdentityConflictError'
  }
}

export interface UserRepository {
  findById(id: UserId): Promise<User | null>
  /** Aufloesung des Anmeldenamens und der Zuordnung einer externen Identitaet. Die Adresse ist normalisiert. */
  findByEmail(email: string): Promise<User | null>
  count(): Promise<number>
  /**
   * Bootstrap-Frage der Erstinbetriebnahme: gibt es bereits einen Systemadmin?
   *
   * Die Antwort gilt serialisiert bis zum Ende der Transaktion, damit zwei gleichzeitige Bootstraps nicht
   * beide eine unadministrierte Instanz sehen und zwei Administratoren anlegen. Nur innerhalb einer
   * Transaktion gueltig.
   */
  hasSystemAdmin(): Promise<boolean>
  /** Nutzerliste der Systemadministration, aelteste zuerst. */
  list(): Promise<readonly User[]>
  create(profile: UserProfileDraft, options: { readonly isSystemAdmin: boolean }): Promise<User>
  updateProfile(id: UserId, profile: UserProfileDraft): Promise<User>
  setStatus(id: UserId, status: UserStatus): Promise<User>
}

/**
 * Lokale Anmeldedaten.
 *
 * Das Repository kennt ausschliesslich Hashes. Es gibt bewusst keine Methode, die ein Passwort prueft: das
 * Verfahren steht im Server (`src/server/password.ts`), die Regel in der Domain, und die Persistenz haelt
 * nur, was beide brauchen.
 */
export interface LocalCredentialRepository {
  findByUserId(userId: UserId): Promise<LocalCredential | null>
  /** Legt die Anmeldedaten an oder ersetzt sie. Ein Nutzer hat hoechstens einen Passworthash. */
  set(userId: UserId, passwordHash: string, options: { readonly mustChangePassword: boolean }): Promise<void>
  /** Kennungen aller Nutzer mit lokalem Passwort. Die Systemadministration zeigt daran den Anmeldeweg. */
  listUserIds(): Promise<readonly UserId[]>
}

/**
 * Persoenliches Erscheinungsbild.
 *
 * Genau eine Zeile je Nutzer oder keine; ohne Zeile gilt die Standardwahl des Vertrags. Das Repository
 * kennt keinen anderen Nutzer als den uebergebenen - wer seine Wahl aendern darf, entscheidet die Route.
 */
export interface AppearanceRepository {
  findByUserId(userId: UserId): Promise<AppearanceView | null>
  /** Legt die Wahl an oder ersetzt sie. */
  set(userId: UserId, appearance: AppearanceView): Promise<void>
}

/**
 * Persoenliche Bibliothek.
 *
 * Genau eine Zeile je Nutzer oder keine; ohne Zeile ist die Bibliothek leer (Revision `0`). Wie beim
 * Erscheinungsbild kennt das Repository keinen anderen Nutzer als den uebergebenen. Die Bibliothek haengt an
 * keinem Board und beruehrt weder Snapshot noch Versionen.
 */
export interface LibraryRepository {
  findByUserId(userId: UserId): Promise<LibraryView | null>
  /**
   * Ersetzt die Bibliothek, wenn sie noch auf `expectedRevision` steht. Liefert die neue Revision oder
   * `null`, wenn inzwischen eine andere Speicherung dazwischenkam - dann wurde nichts geschrieben.
   */
  replace(userId: UserId, items: readonly LibraryItem[], expectedRevision: number): Promise<number | null>
}

export type NewInvitation = {
  readonly userId: UserId
  /** Hash des Einladungswerts. Der Wert selbst verlaesst den Server genau einmal, in der Anlageantwort. */
  readonly tokenHash: string
  readonly createdByUserId: UserId | null
  readonly expiresAt: Date
}

export interface InvitationRepository {
  create(invitation: NewInvitation): Promise<UserInvitation>
  /**
   * Loest einen Einladungswert auf und sperrt die Zeile bis zum Ende der Transaktion.
   *
   * Geliefert wird die Zeile unabhaengig von ihrem Zustand; ob sie noch eingeloest werden darf, entscheidet
   * die Domain (`isInvitationRedeemable`). Nur innerhalb einer Transaktion sinnvoll: die Sperre ist es, die
   * aus "genau einmal einloesbar" mehr macht als eine Absicht.
   */
  findByTokenHash(tokenHash: string): Promise<UserInvitation | null>
  /** Einmalverwendung. `false` heisst: ein gleichzeitiger Vorgang war zuerst da. */
  markRedeemed(id: UserInvitationId, redeemedAt: Date): Promise<boolean>
  /** Widerruft alle offenen Einladungen eines Nutzers und liefert deren Zahl. */
  revokeOpenForUser(userId: UserId, revokedAt: Date): Promise<number>
  /** Offene, noch einloesbare Einladungen aller Nutzer. Grundlage der Anzeige in der Systemadministration. */
  listOpen(now: Date): Promise<readonly UserInvitation[]>
}

export interface ExternalIdentityRepository {
  /** Laedt Identitaet und zugehoerigen Nutzer in einem Schritt; beides wird immer gemeinsam gebraucht. */
  findByKey(key: ExternalIdentityKey): Promise<LinkedIdentity | null>
  /**
   * Traegt dieser Nutzer bereits eine externe Identitaet?
   *
   * Bewusst nur die Existenz und nicht die Zeilen: die Provisionierung entscheidet daran, ob eine
   * Verknuepfung ueber die Adresse noch offen ist - welche Identitaet dahintersteht, geht sie nichts an.
   */
  existsForUser(userId: UserId): Promise<boolean>
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
  readonly localCredentials: LocalCredentialRepository
  readonly appearances: AppearanceRepository
  readonly libraries: LibraryRepository
  readonly invitations: InvitationRepository
  readonly sessions: SessionRepository
  transaction<T>(run: (store: IdentityStore) => Promise<T>): Promise<T>
}
