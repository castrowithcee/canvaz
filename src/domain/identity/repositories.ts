/**
 * Repository-Ports des Identity-Moduls.
 *
 * Der Domain-Core beschreibt hier, was er von der Persistenz braucht. Die PostgreSQL-Umsetzung liegt in
 * `src/persistence` und ist die einzige Stelle, die SQL kennt.
 */

import type { AppearanceView } from '../../contracts/api.js'
import type { InvitationPurpose, LocalCredential, UserInvitation, UserInvitationId } from './local-auth.js'
import type { TotpFactor } from './second-factor.js'
import type { RecoveryEmailToken, RecoveryEmailTokenPurpose, SelfRecovery } from './self-recovery.js'
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
 * Fehlschlagszaehler eines Absenders innerhalb eines 24-Stunden-Fensters (#35, Meilenstein 1).
 *
 * Der Schluessel ist bereits ein HMAC ueber die Adresse (IPv4) bzw. das /64-Praefix (IPv6) mit einem
 * taeglich rotierenden, ausschliesslich im Prozessspeicher gehaltenen Schluessel - die Persistenz sieht nie
 * eine Adresse. Dasselbe Prinzip wie bei `LoginThrottleRepository`, nur mit einem fluechtigen statt einem
 * dauerhaften Schluessel.
 */
export interface SenderFailureCounterRepository {
  /** Zaehlt einen Fehlschlag und liefert die Zahl im laufenden Fenster, diesen eingeschlossen. */
  hit(keyHash: string, now: Date, windowStart: Date): Promise<number>
}

export type SenderBlockAddressKind = 'ipv4' | 'ipv6-64'

export type SenderBlockRecord = {
  readonly address: string
  readonly kind: SenderBlockAddressKind
  readonly reason: string
  readonly failureCount: number
  readonly createdAt: Date
  readonly expiresAt: Date
}

export type NewSenderBlock = {
  readonly address: string
  readonly kind: SenderBlockAddressKind
  readonly reason: string
  readonly failureCount: number
}

export type SenderBlockUpsertResult = {
  readonly record: SenderBlockRecord
  /** Eine fruehere Sperre derselben Adresse innerhalb des Vorschlagsfensters - Grundlage des Vorschlags. */
  readonly priorBlockWithinProposalWindow: { readonly createdAt: Date } | null
}

/**
 * Vorlaeufige Sperre eines Absenders.
 *
 * Anders als beim Fehlschlagszaehler steht die Adresse hier im Klartext: eine ausgeloeste Sperre ist selbst
 * ein sicherheitsrelevanter Vorgang, den der Betrieb nachvollziehen koennen muss.
 */
export interface SenderBlockRepository {
  findActive(address: string, now: Date): Promise<SenderBlockRecord | null>
  /**
   * Legt eine neue Sperre an oder ersetzt eine bestehende. Liefert zugleich, ob es eine fruehere Sperre
   * derselben Adresse innerhalb von `proposalWindowDays` gab - Grundlage des Vorschlags einer dauerhaften
   * Sperre.
   */
  upsert(
    entry: NewSenderBlock,
    now: Date,
    durationHours: number,
    proposalWindowDays: number,
  ): Promise<SenderBlockUpsertResult>
}

export type NewSenderBlockProposal = {
  readonly address: string
  readonly kind: SenderBlockAddressKind
  readonly reason: string
  readonly firstBlockedAt: Date
  readonly secondBlockedAt: Date
}

/**
 * Vorschlag einer dauerhaften Sperre.
 *
 * Status und Entscheidungszeitpunkt bedienen die Betreiberentscheidung aus Meilenstein 2; dieser Store legt
 * hier nur die Zeile an.
 */
export interface SenderBlockProposalRepository {
  create(entry: NewSenderBlockProposal): Promise<void>
}

export type SenderDefenseRetention = {
  /** Zaehlerzeilen mit einem aelteren Fensterbeginn sind abgelaufen. */
  readonly counterWindowStart: Date
  readonly blockRetentionCutoff: Date
  readonly proposalRetentionCutoff: Date
}

export interface SenderDefenseRepository {
  readonly counters: SenderFailureCounterRepository
  readonly blocks: SenderBlockRepository
  readonly proposals: SenderBlockProposalRepository
  /**
   * Entfernt abgelaufene Zaehlwerte, abgelaufene Sperren und ueberalte Vorschlaege.
   *
   * `counters.hit` raeumt zusaetzlich bei jedem Fehlschlag opportunistisch auf; ohne weitere Fehlschlaege
   * braucht es trotzdem einen eigenstaendigen Aufruf (`startSenderDefenseRetention` in `sender-defense.ts`),
   * sonst blieben Zaehler, Sperren und Vorschlaege einer sonst untaetigen Instanz ueber ihre Frist liegen.
   */
  purgeExpired(retention: SenderDefenseRetention): Promise<void>
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

export type NewRecoveryEmailToken = {
  readonly userId: UserId
  readonly purpose: RecoveryEmailTokenPurpose
  readonly email: string
  /** Hash des Werts. Der Wert selbst verlaesst den Server genau einmal, im Link der Nachricht. */
  readonly tokenHash: string
  readonly expiresAt: Date
}

/**
 * Selbstwiederherstellung: Freischaltung, bestaetigte Adresse und die Links dazu.
 *
 * Die Links sind getrennt von `InvitationRepository`: sie melden nie an und erscheinen nie als offener
 * Zugang in der Systemadministration.
 */
export interface SelfRecoveryRepository {
  find(userId: UserId): Promise<SelfRecovery | null>
  /**
   * Dasselbe und sperrt die Zeile bis zum Ende der Transaktion. Serialisiert Anfragen desselben Kontos, damit
   * gleichzeitig nie zwei offene Ruecksetzungslinks entstehen. Nur innerhalb einer Transaktion sinnvoll.
   */
  findForUpdate(userId: UserId): Promise<SelfRecovery | null>
  /** Alle Zeilen; Grundlage der Anzeige in der Systemadministration. */
  list(): Promise<readonly SelfRecovery[]>
  /** Schaltet frei oder ab. Eine bestaetigte Adresse bleibt dabei stehen. */
  setAllowed(userId: UserId, allowed: boolean): Promise<void>
  setVerifiedEmail(userId: UserId, email: string, verifiedAt: Date): Promise<void>
  createToken(token: NewRecoveryEmailToken): Promise<RecoveryEmailToken>
  /** Loest einen Wert auf und sperrt die Zeile bis zum Ende der Transaktion - wie bei der Einladung. */
  findTokenByHash(tokenHash: string): Promise<RecoveryEmailToken | null>
  /** Einmalverwendung. `false` heisst: ein gleichzeitiger Vorgang war zuerst da oder der Link ist widerrufen. */
  markTokenRedeemed(id: string, redeemedAt: Date): Promise<boolean>
  /** Der juengste noch einloesbare Link dieses Zwecks, sonst `null`. */
  findOpenToken(userId: UserId, purpose: RecoveryEmailTokenPurpose, now: Date): Promise<RecoveryEmailToken | null>
  /** Widerruft offene Links des Kontos - eines Zwecks oder ohne Angabe aller. Liefert deren Zahl. */
  revokeOpenTokens(userId: UserId, revokedAt: Date, purpose?: RecoveryEmailTokenPurpose): Promise<number>
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
  readonly senderDefense: SenderDefenseRepository
  readonly secondFactors: SecondFactorRepository
  readonly selfRecovery: SelfRecoveryRepository
  transaction<T>(run: (store: IdentityStore) => Promise<T>): Promise<T>
}
