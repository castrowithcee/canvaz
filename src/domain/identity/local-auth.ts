/**
 * Lokale Anmeldedaten und Einladungen.
 *
 * Reiner Domain-Core: keine Datenbank, kein HTTP, keine Kryptografie. Hier stehen die Regeln, die beide
 * Anmeldewege gleich behandeln - was ein taugliches Passwort ist, wie eine Adresse normalisiert wird und
 * wann eine Einladung noch eingeloest werden kann.
 *
 * Die Trennung zum uebrigen Identity-Modul ist dieselbe wie bei der externen Identitaet: eine lokale
 * Anmeldung ist ein **Weg zu einem Profil** und kein Profil. Sie traegt weder Rolle noch Status; beides
 * steht am `User` und entscheidet unveraendert ueber `authenticate`.
 */

import type { UserId } from './model.js'
import { COMMON_PASSWORDS } from './password-blocklist.js'

export type UserInvitationId = string

/**
 * Wozu ein Einladungswert dient.
 *
 * `invitation` uebergibt ein Konto, `recovery` stellt den Zugang des Systemadmins per Betreiberbefehl wieder
 * her. Beide loesen sich auf demselben Weg ein und setzen dasselbe Passwort; der Zweck unterscheidet Frist,
 * Nachweis und alles, was eine Wiederherstellung kuenftig zusaetzlich zuruecksetzen muss.
 */
export type InvitationPurpose = 'invitation' | 'recovery'

/**
 * Lokale Anmeldedaten eines Nutzers.
 *
 * `passwordHash` ist das Ergebnis des Hashverfahrens aus `src/server/password.ts`; ein Klartextpasswort
 * kommt in diesem Modell nicht vor und kann deshalb auch nicht versehentlich in eine Antwort geraten.
 */
export type LocalCredential = {
  readonly userId: UserId
  readonly passwordHash: string
  /** Wahr nach einem Initialpasswort und nach jeder Ruecksetzung: der Wechsel geht der Sitzung voraus. */
  readonly mustChangePassword: boolean
  readonly updatedAt: Date
}

/**
 * Einladung eines administrativ angelegten Kontos.
 *
 * `tokenHash` steht bewusst **nicht** im Modell: der Hash ist Sache der Persistenz und der Aufloesung, und
 * der Einladungswert selbst existiert nur, waehrend die Anlageantwort entsteht.
 */
export type UserInvitation = {
  readonly id: UserInvitationId
  readonly userId: UserId
  readonly purpose: InvitationPurpose
  readonly createdByUserId: UserId | null
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly redeemedAt: Date | null
  readonly revokedAt: Date | null
}

/**
 * Invariante des Pakets: eine Einladung traegt nur dann eine Einloesung, wenn sie weder eingeloest noch
 * widerrufen noch abgelaufen ist.
 *
 * Wie `isSessionLive` eine reine Funktion, damit es genau eine Definition gibt und die Datenbankabfrage sie
 * nicht ein zweites Mal formuliert.
 */
export function isInvitationRedeemable(
  invitation: Pick<UserInvitation, 'expiresAt' | 'redeemedAt' | 'revokedAt'>,
  now: Date,
): boolean {
  return (
    invitation.redeemedAt === null &&
    invitation.revokedAt === null &&
    invitation.expiresAt.getTime() > now.getTime()
  )
}

/**
 * Frist einer Einladung.
 *
 * 72 Stunden: lang genug, damit eine Uebergabe ueber einen anderen Kanal ein Wochenende ueberlebt, kurz
 * genug, dass ein liegen gebliebener Link kein dauerhafter Zugang wird. Wer laenger braucht, bekommt eine
 * neue - das Erzeugen kostet nichts und widerruft die vorherige.
 */
export const INVITATION_TTL_HOURS = 72

export function invitationExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_HOURS * 3600 * 1000)
}

/**
 * Frist eines Wiederherstellungswerts.
 *
 * 30 Minuten statt 72 Stunden: der Betreiber erzeugt ihn in dem Moment, in dem er ihn uebergibt, und ein
 * liegen gebliebener Link auf das einzige Adminkonto soll kein Wochenende ueberleben. Wer ihn verpasst,
 * ruft den Befehl erneut auf; das entwertet den vorherigen.
 */
export const RECOVERY_TTL_MINUTES = 30

export function recoveryExpiry(now: Date): Date {
  return new Date(now.getTime() + RECOVERY_TTL_MINUTES * 60 * 1000)
}

/**
 * Mindestlaenge eines Passworts.
 *
 * Fuenfzehn Zeichen ohne Zusammensetzungsregeln (NIST SP 800-63B, 3.1.1.2): Laenge traegt die Staerke,
 * waehrend erzwungene Sonderzeichen vor allem vorhersagbare Muster erzeugen. Einfuegen und lange Passphrasen
 * bleiben ausdruecklich moeglich. Die Obergrenze begrenzt schlicht die Eingabe; das Verfahren selbst rechnet
 * unabhaengig von der Laenge.
 */
export const MIN_PASSWORD_LENGTH = 15
export const MAX_PASSWORD_LENGTH = 200

/** Ergebnis der Passwortpruefung. `problem` ist ein Satz, den die Oberflaeche unveraendert anzeigen darf. */
export type PasswordCheck =
  | { readonly ok: true; readonly password: string }
  | { readonly ok: false; readonly problem: string }

/**
 * Was ueber das Konto bekannt ist, dem das Passwort gelten soll. Beides fehlt, wo es noch nicht feststeht.
 */
export type PasswordContext = {
  readonly email?: string | null
  readonly displayName?: string | null
}

const BLOCKED_PASSWORDS: ReadonlySet<string> = new Set(COMMON_PASSWORDS)

/**
 * Woerter, aus denen ein Passwort dieser Instanz nicht allein bestehen darf, sobald es den Produktnamen
 * enthaelt: `Canvaz-Passwort-2026!` ist lang, aber das Erste, was jemand hier probiert.
 */
const CONTEXT_WORDS = /^(?:canvaz|passwort|password|admin|login|welcome|willkommen)+$/

/** Vergleichsform der Sperrliste: dieselbe Normalisierung wie das Hashverfahren, dazu ohne Gross-/Kleinschreibung. */
function comparable(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

/** Nur die Buchstaben: `Ada.Lovelace-2026!` und `adalovelace` sind fuer einen Rater dasselbe. */
function lettersOf(value: string): string {
  return comparable(value).replace(/\P{L}/gu, '')
}

/**
 * Sperrlistenpruefung (NIST SP 800-63B, 3.1.1.2): verbreitete Passwoerter, der Produktname und das eigene
 * Konto als ganzes Passwort. Verglichen wird das ganze Passwort, nie ein Teil davon - eine Passphrase, die
 * ein gesperrtes Wort enthaelt, bleibt erlaubt.
 */
function isBlocked(password: string, context: PasswordContext): boolean {
  if (BLOCKED_PASSWORDS.has(comparable(password))) {
    return true
  }
  const letters = lettersOf(password)
  if (letters.includes('canvaz') && CONTEXT_WORDS.test(letters)) {
    return true
  }
  const email = context.email ?? ''
  const own = [email, email.split('@')[0] ?? '', context.displayName ?? '']
    .map(lettersOf)
    // Ohne Buchstaben gibt es nichts zu vergleichen; sonst traefe jedes Passwort aus Ziffern.
    .filter((value) => value.length >= 3)
  return own.includes(letters)
}

/**
 * Die eine Passwortregel fuer jeden Weg, der ein Passwort setzt: Anlage, Wechsel, Einloesung und
 * Ruecksetzung - auch fuer den Systemadmin. Die Anmeldung prueft mit derselben Funktion, ob ein bestehendes
 * Passwort den Wechsel erzwingt.
 */
export function parsePassword(raw: unknown, context: PasswordContext = {}): PasswordCheck {
  if (typeof raw !== 'string') {
    return { ok: false, problem: 'Ein Passwort wird erwartet' }
  }
  // Keine Trimmung: fuehrender und abschliessender Leerraum gehoert zum Passwort und wird nie stillschweigend
  // entfernt - sonst passt der naechste Anmeldeversuch nicht mehr zum gespeicherten Hash.
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, problem: `Das Passwort braucht mindestens ${String(MIN_PASSWORD_LENGTH)} Zeichen` }
  }
  if (raw.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, problem: `Das Passwort darf hoechstens ${String(MAX_PASSWORD_LENGTH)} Zeichen haben` }
  }
  if (isBlocked(raw, context)) {
    return {
      ok: false,
      problem: 'Dieses Passwort ist zu verbreitet oder zu leicht zu erraten. Bitte ein anderes waehlen.',
    }
  }
  return { ok: true, password: raw }
}

export const MAX_EMAIL_LENGTH = 254
export const MAX_DISPLAY_NAME_LENGTH = 80

/**
 * Adresse eines lokalen Kontos. `null` bedeutet: keine brauchbare Adresse.
 *
 * Sie ist zugleich der Anmeldename, deshalb wird sie normalisiert gespeichert und normalisiert gesucht -
 * genau wie die aus einem Token uebernommene Adresse. Ohne das waere `Ada@example.com` ein zweites Konto.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) {
    return null
  }
  // Dieselbe schmale Pruefung wie im Datenbank-Constraint: genau ein `@` mit etwas davor und dahinter, kein
  // Leerraum. Mehr zu pruefen hiesse, Adressen zu erfinden, die es gibt.
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmed)) {
    return null
  }
  return trimmed
}

/** Anzeigename eines administrativ angelegten Kontos. `null` bedeutet: leer oder zu lang. */
export function normalizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0 || collapsed.length > MAX_DISPLAY_NAME_LENGTH) {
    return null
  }
  return collapsed
}
