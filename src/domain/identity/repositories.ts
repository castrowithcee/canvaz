/**
 * Repository-Ports des Identity-Moduls.
 *
 * Der Domain-Core beschreibt hier, was er von der Persistenz braucht. Die PostgreSQL-Umsetzung liegt in
 * `src/persistence` und ist die einzige Stelle, die SQL kennt.
 */

import type { AppearanceView } from '../../contracts/api.js'
import type { InvitationPurpose, LocalCredential, UserInvitation, UserInvitationId } from './local-auth.js'
import type { TotpFactor } from './second-factor.js'
import type {
  AuthenticatedSession,
  ExternalIdentity,
  ExternalIdentityId,
  ExternalIdentityKey,
  Session,
  SessionId,
  SignedInSession,
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
  /** Ohne Angabe `null`: die Sitzung hat den zweiten Faktor nicht belegt. */
  readonly secondFactorVerifiedAt?: Date | null
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
  /**
   * Alle Systemadmins, unter derselben Sperre wie `hasSystemAdmin`.
   *
   * Grundlage der Wiederherstellung: sie wirkt nur, wenn es genau einen gibt, und zwei gleichzeitige Aufrufe
   * laufen dadurch nacheinander. Nur innerhalb einer Transaktion gueltig.
   */
  listSystemAdmins(): Promise<readonly User[]>
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
  /**
   * Verlangt den Wechsel eines bestehenden Passworts, das die aktuelle Regel nicht mehr erfuellt.
   *
   * Nur, solange noch genau dieser Hash gespeichert ist: ein gleichzeitiger Wechsel wird nicht ueberschrieben.
   */
  requireChange(userId: UserId, passwordHash: string): Promise<void>
}

/**
 * Anmeldeversuche je Zielkonto.
 *
 * Der Schluessel ist bereits ein Hash der eingegebenen Adresse; die Persistenz sieht nie eine Adresse. Das
 * Fenster beginnt mit dem ersten Versuch und endet von selbst.
 */
export interface LoginThrottleRepository {
  /**
   * Zaehlt einen Versuch und liefert die Zahl der Versuche im laufenden Fenster, diesen eingeschlossen.
   *
   * Atomar: gleichzeitige Versuche erhalten verschiedene Zahlen. Ein Fenster, das vor `windowStart` begann,
   * gilt als abgelaufen; der Versuch beginnt dann ein neues mit `now`.
   */
  hit(keyHash: string, now: Date, windowStart: Date): Promise<number>
  /** Setzt die Zaehlung eines Kontos zurueck. */
  clear(keyHash: string): Promise<void>
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

export type NewInvitation = {
  readonly userId: UserId
  /** Hash des Einladungswerts. Der Wert selbst verlaesst den Server genau einmal, in der Anlageantwort. */
  readonly tokenHash: string
  readonly createdByUserId: UserId | null
  readonly expiresAt: Date
  /** Ohne Angabe eine gewoehnliche Einladung. */
  readonly purpose?: InvitationPurpose
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
   * lebende Session eines aktiven Nutzers, bei Faktorpflicht mit belegtem zweitem Faktor. Alles andere ist
   * `null`.
   */
  findAuthenticatedByTokenHash(tokenHash: string, now: Date): Promise<AuthenticatedSession | null>
  /**
   * Dasselbe nach dem ersten Faktor (`signedIn`): liefert auch eine Sitzung, deren zweiter Faktor noch
   * aussteht, und sagt das in `secondFactorPending`. Fuer die Guards, die eine solche Sitzung gezielt
   * ablehnen, und fuer die wenigen Endpunkte, die sie bedienen.
   */
  findSignedInByTokenHash(tokenHash: string, now: Date): Promise<SignedInSession | null>
  revoke(id: SessionId, revokedAt: Date): Promise<void>
  /** Widerruft alle Sessions eines Nutzers, etwa beim Deaktivieren. */
  revokeAllForUser(userId: UserId, revokedAt: Date): Promise<void>
  /**
   * Welche dieser Sessions gelten noch - nach derselben Regel wie `findAuthenticatedByTokenHash`?
   *
   * Fuer offene WebSocket-Verbindungen: ein Widerruf aus einem anderen Prozess, etwa dem Betreiberbefehl,
   * erreicht das Verbindungsregister dieses Prozesses nicht als Ereignis und wird so nachgeprueft.
   */
  findLiveIds(ids: readonly SessionId[], now: Date): Promise<ReadonlySet<SessionId>>
  /** Raeumt abgelaufene Zeilen weg. Aufruf entscheidet der Betrieb, nicht die Domain. */
  deleteExpired(before: Date): Promise<number>
}

/**
 * Zweiter Faktor: TOTP-Geheimnis und Ersatzcodes.
 *
 * Die Persistenz kennt nur versiegelte Geheimnisse und Hashes. Jede zustandsaendernde Methode ist so
 * gebaut, dass zwei gleichzeitige Vorgaenge nicht beide gewinnen: ein Zeitschritt, ein Ersatzcode und eine
 * angefangene Einrichtung werden je genau einmal angenommen.
 */
export interface SecondFactorRepository {
  findTotp(userId: UserId): Promise<TotpFactor | null>
  /** Beginnt eine Einrichtung oder ersetzt eine angefangene. Ein aktives Geheimnis bleibt unberuehrt. */
  beginTotp(userId: UserId, pendingSealed: string, now: Date): Promise<void>
  /**
   * Macht die angefangene Einrichtung zum aktiven Faktor - nur, solange noch genau `pendingSealed` offen ist.
   * `step` ist der Zeitschritt des bestaetigenden Codes und gilt danach als verbraucht.
   */
  activateTotp(userId: UserId, pendingSealed: string, step: number, now: Date): Promise<boolean>
  /** Verbraucht einen Zeitschritt des aktiven Faktors. `false`: derselbe oder ein spaeterer war schon da. */
  useTotpStep(userId: UserId, step: number): Promise<boolean>
  /** Ersetzt alle Ersatzcodes des Kontos durch diese Hashes. */
  replaceBackupCodes(userId: UserId, codeHashes: readonly string[]): Promise<void>
  /** Loest einen Ersatzcode ein. `false`: unbekannt oder bereits verbraucht - auch gleichzeitig. */
  useBackupCode(userId: UserId, codeHash: string, now: Date): Promise<boolean>
  countUnusedBackupCodes(userId: UserId): Promise<number>
  /** Entfernt Faktor und Ersatzcodes. Einziger Aufrufer ist die Einloesung einer Betreiber-Wiederherstellung. */
  removeAll(userId: UserId): Promise<void>
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
  readonly invitations: InvitationRepository
  readonly sessions: SessionRepository
  readonly loginThrottle: LoginThrottleRepository
  readonly secondFactors: SecondFactorRepository
  transaction<T>(run: (store: IdentityStore) => Promise<T>): Promise<T>
}
